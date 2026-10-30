import { test, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireOwnerLock, inspectOwnerLock, ownerLockPath, releaseOwnerLock } from '../../src/main/owner-lock'
import { MANIFEST_NAME } from '../../src/main/folio'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'
import { parseFrontmatter } from '../../src/main/frontmatter'
import { createdBy, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Ticket 04: direct writes with the app closed. Journal and undo are in cli-journal.test.ts; the
// security conditions carried from ticket 09 are in cli-write-guards.test.ts.
let fx: WriteFixture
let outside: string

beforeEach(async () => {
  fx = await writeFixture()
  outside = await mkdtemp(join(tmpdir(), 'wf-cli-export-'))
})
afterEach(async () => {
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const lockFree = async (): Promise<boolean> => !existsSync(ownerLockPath(fx.root)) && (await inspectOwnerLock(fx.root)).state === 'free'
/** The app's own stores: everything under .writeflex (journal and lock aside) and .bridle. */
const stores = async (): Promise<Record<string, string>> =>
  Object.fromEntries(Object.entries(await fx.snapshot()).filter(([path]) => path.startsWith('.writeflex/') || path.startsWith('.bridle/')))

test('every direct write works against a fixture Collection, reports applied, and leaves the lock free', async () => {
  const run = async (...argv: string[]) => {
    const result = await fx.cli(argv)
    expect(result.json.error?.message ?? '', argv.join(' ')).toBe('')
    expect(result.code).toBe(0)
    expect(result.json).toMatchObject({ outcome: 'done' })
    expect(result.json.result).not.toHaveProperty('outcome')
    expect(await lockFree(), `lock after ${argv[0]}`).toBe(true)
    return result.json.result!
  }
  await run('create', 'drafts/new-piece', '--content', '# New piece\n')
  expect(await fx.read('drafts/new-piece.md')).toBe(createdBy('# New piece\n'))

  await run('create-folder', 'archive/2026')
  expect((await readdir(join(fx.root, 'archive'))).sort()).toEqual(['2026'])
  expect((await run('create-folder', 'archive/2026')).created).toBe(false)

  expect((await run('duplicate', 'talks/york.md')).path).toBe('talks/york (copy).md')
  expect(await fx.read('talks/york (copy).md')).toBe(await fx.read('talks/york.md'))
  expect((await run('duplicate', 'talks/york.md')).path).toBe('talks/york (copy)-2.md')

  const note = await run('note', 'talks/york.md', '--body', 'The intro is thin.', '--kind', 'Review')
  expect(note.path).toBe('talks/agent-notes/york.review.md')
  expect(parseFrontmatter(await fx.read('talks/agent-notes/york.review.md'))).toMatchObject({ author: 'agent', extra: { agent_note_kind: 'review', source_document: 'talks/york.md' } })

  const scrap = await run('scrap', 'notes.md', '--text', 'a spare cutting')
  expect(await new ScrapStore(new Workspace(fx.root)).list({ origin: 'notes.md' })).toEqual([scrap.scrap as never])

  await run('move', 'talks/york.md', 'talks/york-2026.md')
  expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(false)
  expect(await fx.read('notes.md')).toContain('[[york-2026]]')

  await run('move-folder', 'talks', 'events')
  expect(existsSync(join(fx.root, 'events/york-2026.md'))).toBe(true)

  await writeFile(join(fx.root, 'drafts', MANIFEST_NAME.replace('.json', '.txt')), 'not a manifest')
  const manifest = await run('create-manifest', 'drafts')
  expect(JSON.parse(await fx.read(`drafts/${MANIFEST_NAME}`))).toEqual(manifest.manifest as never)
  expect((manifest.manifest as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['new-piece.md'])

  const exported = await run('export', 'drafts/new-piece.md', '--to', join(outside, 'piece.html'), '--confirm')
  expect(await readFile(exported.target as string, 'utf8')).toContain('New piece')
})

// While the app owns the Collection a write is not refused: it becomes a request for the app
// (ticket 05; tests/main/cli-request-route.test.ts).

test('the lock is released on success, on a refusal and on a thrown error', async () => {
  expect((await fx.cli(['create', 'a.md'])).code).toBe(0)
  expect(await lockFree()).toBe(true)
  const refused = await fx.cli(['create', 'a.md'])
  expect(refused.json.error).toMatchObject({ code: 'refused' })
  expect(refused.json.error!.message).toContain('already exists')
  expect(await lockFree()).toBe(true)
  const thrown = await fx.cli(['create', 'b.md'], { write: { seams: { betweenCheckAndWrite: async () => { throw new Error('disk on fire') } } } })
  expect(thrown.json.error).toMatchObject({ code: 'failed', message: 'disk on fire' })
  expect(existsSync(join(fx.root, 'b.md'))).toBe(false)
  expect(await lockFree()).toBe(true)
})

test('no direct write touches the review ledger, the versions file or .bridle, except create, which saves the version that records the creation', async () => {
  const start = await stores()
  expect(Object.keys(start).sort()).toEqual(['.bridle/journal.jsonl', '.writeflex/changes.jsonl', '.writeflex/versions.jsonl'])
  const run = async (argv: string[]): Promise<void> => {
    const result = await fx.cli(argv)
    expect(result.json.error?.message ?? '', argv.join(' ')).toBe('')
  }
  // The creates first: each adds one version record and nothing to the review ledger.
  for (const argv of [['create', 'new.md', '--content', 'x'], ['create-folder', 'f'], ['create', 'f/part.md']]) await run(argv)
  const before = await stores()
  expect(before['.writeflex/changes.jsonl']).toBe(start['.writeflex/changes.jsonl'])
  const added = Buffer.from(before['.writeflex/versions.jsonl'], 'base64').toString('utf8').slice(Buffer.from(start['.writeflex/versions.jsonl'], 'base64').toString('utf8').length)
  expect(added.trim().split('\n').map((line) => { const { path, name } = JSON.parse(line) as { path: string; name: string }; return { path, name } }))
    .toEqual([{ path: 'new.md', name: 'Created by Outside agent' }, { path: 'f/part.md', name: 'Created by Outside agent' }])
  for (const argv of [
    ['duplicate', 'notes.md'], ['note', 'notes.md', '--body', 'n'],
    ['scrap', 'notes.md', '--text', 'one'], ['scrap', 'notes.md', '--text', 'two'], ['move', 'talks/york.md', 'york-moved.md'],
    ['move-folder', 'talks', 'events'], ['undo'], ['trash', 'new.md'], ['create-manifest', 'f'],
    ['export', 'notes.md', '--to', join(outside, 'n.docx'), '--confirm'],
  ]) await run(argv)
  expect(await stores()).toEqual(before)
  // The only thing the command line adds under .writeflex is its own journal.
  expect((await readdir(join(fx.root, '.writeflex'))).sort()).toEqual(['changes.jsonl', 'versions.jsonl'])
})

test('creating a document that exists is refused and the document is untouched', async () => {
  const before = await fx.snapshot({ journal: true })
  for (const path of ['notes.md', 'notes', 'talks/york.md']) {
    const result = await fx.cli(['create', path, '--content', 'replaced'])
    expect(result.code).toBe(1)
    expect(result.json.error!.message).toContain('already exists')
  }
  expect(await fx.snapshot({ journal: true })).toEqual(before)
})

test('trash hands the real path to the system Trash mover and reports what it moved; nothing is deleted', async () => {
  const york = await fx.read('talks/york.md')
  const file = await fx.cli(['trash', 'talks/york.md'])
  expect(file.json.result).toMatchObject({ trashed: 'talks/york.md', kind: 'file', undo: null })
  expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(false)
  expect(await readFile(join(fx.trashed, 'york.md'), 'utf8')).toBe(york)
  const folder = await fx.cli(['trash', 'talks'])
  expect(folder.json.result).toMatchObject({ trashed: 'talks', kind: 'folder' })
  expect((await readdir(join(fx.trashed, 'talks'))).sort()).toEqual([MANIFEST_NAME, 'intro.md'].sort())
  // Refused: the app's own folders, the Collection itself, something that is not there.
  for (const path of ['.writeflex', '.writeflex/versions.jsonl', '.bridle', '.', '..', 'missing.md']) {
    const refused = await fx.cli(['trash', path])
    expect(refused.code, path).not.toBe(0)
  }
  expect(existsSync(join(fx.root, '.writeflex/versions.jsonl'))).toBe(true)
  // A mover that does not move is reported as a failure, never as applied.
  const stuck = await fx.cli(['trash', 'notes.md'], { write: { trash: async () => {} } })
  expect(stuck.json.error).toMatchObject({ code: 'failed' })
  expect(stuck.json.error!.message).toContain('still there')
})

test('export without --confirm refuses and says why; with it, it writes only the given target', async () => {
  const before = await fx.snapshot({ journal: true })
  const target = join(outside, 'york.html')
  const refused = await fx.cli(['export', 'talks/york.md', '--to', target])
  expect(refused.code).toBe(1)
  expect(refused.json).toMatchObject({ outcome: 'refused', error: { code: 'confirmation-needed' } })
  expect(refused.json.error!.message).toMatch(/writes a file outside the Collection.*--confirm/)
  expect(await readdir(outside)).toEqual([])
  expect(existsSync(join(fx.root, '.writeflex/owner.lock'))).toBe(false)

  const done = await fx.cli(['export', 'talks/york.md', '--to', target, '--confirm'])
  expect(done.json.result).toMatchObject({ format: 'html', pieces: 1 })
  expect(await readdir(outside)).toEqual(['york.html'])
  expect(await readFile(target, 'utf8')).toContain('Intro about assessment.')
  expect(await fx.snapshot({ journal: true })).toEqual(before)

  // A whole folder as one file, and an existing target is never replaced.
  const folio = await fx.cli(['export', 'talks', '--to', join(outside, 'talks.html'), '--confirm'])
  expect(folio.json.result).toMatchObject({ pieces: 2 })
  const again = await fx.cli(['export', 'talks/york.md', '--to', target, '--confirm'])
  expect(again.json.error!.message).toContain('already exists')
  // Into the app's own folder inside the Collection: refused.
  const hidden = await fx.cli(['export', 'talks/york.md', '--to', join(fx.root, '.writeflex', 'x.html'), '--confirm'])
  expect(hidden.code).toBe(1)
  expect(existsSync(join(fx.root, '.writeflex/x.html'))).toBe(false)
  expect((await readdir(outside)).sort()).toEqual(['talks.html', 'york.html'])
})

test('a file being rewritten keeps its line endings and its byte-order mark', async () => {
  const crlf = '﻿# Notes\r\n\r\nSee [[york]] here.\r\nAnd a last line without an ending'
  await fx.write('notes.md', crlf)
  await fx.write('notes/scraps/keep-SCRAPS.md', '﻿foreign text\r\nkept as it is\r\n')
  await fx.write('notes/keep.md', '# Keep\n')
  expect((await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])).code).toBe(0)
  expect((await fx.bytes('notes.md')).equals(Buffer.from(crlf.replace('[[york]]', '[[york-2026]]'), 'utf8'))).toBe(true)
  expect((await fx.cli(['scrap', 'notes/keep.md', '--text', 'added'])).code).toBe(0)
  const scraps = await fx.bytes('notes/scraps/keep-SCRAPS.md')
  expect(scraps.subarray(0, Buffer.byteLength('﻿foreign text\r\nkept as it is\r\n')).toString('utf8')).toBe('﻿foreign text\r\nkept as it is\r\n')
  expect(scraps.toString('utf8')).toContain('added')
  // Whole-file writes leave no temporary file behind.
  expect(Object.keys(await fx.snapshot()).filter((path) => path.endsWith('.tmp'))).toEqual([])
})

test('text can be piped in with --stdin, and --content with --stdin is a usage error', async () => {
  expect((await fx.cli(['create', 'piped.md', '--stdin'], { stdin: '# Piped\n\nLong text.\n' })).code).toBe(0)
  expect(await fx.read('piped.md')).toBe(createdBy('# Piped\n\nLong text.\n'))
  expect((await fx.cli(['create', 'both.md', '--stdin', '--content', 'x'], { stdin: 'y' })).code).toBe(2)
  expect(existsSync(join(fx.root, 'both.md'))).toBe(false)
})

test('a sandbox that forbids writing in the Collection is reported, naming the folder to allow', async () => {
  const sealed = await mkdtemp(join(tmpdir(), 'wf-cli-sealed-'))
  await mkdir(join(sealed, 'col'))
  await writeFile(join(sealed, 'col', 'a.md'), '# A\n')
  await chmod(join(sealed, 'col'), 0o555)
  try {
    const { runCli } = await import('../../src/main/cli/run')
    let out = ''
    const code = await runCli(['--root', join(sealed, 'col'), '--json', 'create', 'b.md'], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {} })
    const result = JSON.parse(out) as { root: string; error: { code: string; message: string } }
    expect(code).toBe(1)
    expect(result.error.code).toBe('write-not-permitted')
    expect(result.error.message).toContain('allow writing to this folder')
    expect(result.error.message).toContain(result.root)
  } finally {
    await chmod(join(sealed, 'col'), 0o755)
    await rm(sealed, { recursive: true, force: true })
  }
})


for (const target of ['paper/chapter', '.']) {
  test(`create-manifest refuses a related existing Folio from ${target}`, async () => {
    await mkdir(join(fx.root, 'paper/chapter'), { recursive: true })
    await writeFile(join(fx.root, 'paper/_paper_INDEX.md'), '# Paper\n\n## Running order\n- Part\n')
    await writeFile(join(fx.root, 'paper/chapter/01-Part.md'), '# Part')
    await writeFile(join(fx.root, '01-Part.md'), '# Root part')
    const result = await fx.cli(['create-manifest', target])
    expect(result.code).not.toBe(0)
    expect(result.json.error?.message).toContain('paper')
    expect(existsSync(join(fx.root, target === '.' ? '' : target, MANIFEST_NAME))).toBe(false)
  })
}

test('create-manifest returns an unreadable-folder check notice in its text and JSON result', async () => {
  await mkdir(join(fx.root, 'paper/locked'), { recursive: true })
  await writeFile(join(fx.root, 'paper/01-Part.md'), '# Part\n')
  const locked = join(fx.root, 'paper/locked/_locked_INDEX.md')
  await writeFile(locked, '## Running order\n')
  await chmod(locked, 0)
  try {
    const result = await fx.cli(['create-manifest', 'paper'])
    expect(result.code).toBe(0)
    expect(result.json.result?.notices).toEqual(expect.arrayContaining([expect.stringContaining('Skipped paper/locked')]))
    expect(existsSync(join(fx.root, 'paper/_report-structure.json'))).toBe(true)
  } finally { await chmod(locked, 0o600) }
})

test('trash retains a set-aside declaring note entry for Put Back', async () => {
  const ws = new Workspace(fx.root)
  const path = 'book/ch/_ch_INDEX.md'
  await fx.write(path, '# Cover\n')
  await fx.write('book/_book_INDEX.md', '## Running order\n')
  await ws.saveEditorText(path, '## Running order\n', { kind: 'disk', text: '# Cover\n' })
  const store = '.writeflex/folio-declarations-set-aside.json'
  const before = await fx.read(store)
  const failed = await fx.cli(['trash', path], { write: { trash: async () => { throw new Error('Trash refused') } } })
  expect(failed.code).not.toBe(0)
  expect(await fx.read(store)).toBe(before)
  const result = await fx.cli(['trash', path])
  expect(result.code).toBe(0)
  expect(await fx.read(store)).toBe(before)
})
