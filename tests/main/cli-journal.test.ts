import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { JournalEntry } from '../../src/main/cli/journal'
import { MANIFEST_NAME } from '../../src/main/folio'
import { inspectOwnerLock } from '../../src/main/owner-lock'
import { INTRO, MANIFEST, NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Ticket 04: the command line's own undo journal (record, list, undo, prune).
let fx: WriteFixture
beforeEach(async () => { fx = await writeFixture() })
afterEach(() => fx.dispose())

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
// The journal is in the fixture's stand-in for application data, outside the Collection (collection-records.ts).
const journalFiles = (): Promise<string[]> => fx.journalNames()
const entries = async (): Promise<JournalEntry[]> =>
  Promise.all((await journalFiles()).map(async (name) => JSON.parse(await readFile(join(fx.journalDir, name), 'utf8')) as JournalEntry))
/** An entry written by a program that can write this user's application data: still data, never instructions. */
const plant = async (id: string, entry: Partial<JournalEntry>): Promise<void> => {
  await mkdir(fx.journalDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.journalDir, `${id}.json`), JSON.stringify({ version: 1, id, at: new Date().toISOString(), operation: 'move', summary: 'planted', moves: [], files: [], ...entry }))
}

test('rename with link repair, then undo, restores every touched file and path byte for byte', async () => {
  const before = await fx.snapshot()
  const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
  expect(moved.json.result).toMatchObject({ from: 'talks/york.md', to: 'talks/york-2026.md' })
  expect((moved.json.result!.repaired as string[]).sort()).toEqual(['notes.md', 'talks/intro.md', `talks/${MANIFEST_NAME}`].sort())
  expect(await fx.read('notes.md')).toBe(NOTES.replaceAll('[[york', '[[york-2026'))
  expect(await fx.read(`talks/${MANIFEST_NAME}`)).toBe(MANIFEST.replace('york.md', 'york-2026.md'))

  // The entry holds, per file, the content before, a fingerprint of the content after, and the path move.
  const [entry] = await entries()
  expect(moved.json.result!.undo).toBe(entry.id)
  expect(entry.moves).toEqual([{ from: 'talks/york.md', to: 'talks/york-2026.md', kind: 'file' }])
  const byPath = Object.fromEntries(entry.files.map((file) => [file.path, file]))
  expect(Object.keys(byPath).sort()).toEqual(['notes.md', 'talks/intro.md', 'talks/york-2026.md', `talks/${MANIFEST_NAME}`].sort())
  for (const [path, original] of [['notes.md', NOTES], ['talks/intro.md', INTRO], ['talks/york-2026.md', YORK], [`talks/${MANIFEST_NAME}`, MANIFEST]]) {
    expect(Buffer.from(byPath[path].before, 'base64').toString('utf8')).toBe(original)
    expect(byPath[path].after).toBe(sha(await fx.bytes(path)))
  }

  const undone = await fx.cli(['undo'])
  expect(undone.json.result).toMatchObject({ undone: entry.id })
  expect((undone.json.result!.restored as string[]).sort()).toEqual(['notes.md', 'talks/intro.md', `talks/${MANIFEST_NAME}`].sort())
  expect(await fx.snapshot()).toEqual(before)
  expect((await inspectOwnerLock(fx.root)).state).toBe('free')
  // Undone once: there is nothing left to undo, and the entry cannot be undone twice.
  expect((await fx.cli(['undo'])).json.error!.message).toContain('nothing to undo')
  expect((await fx.cli(['undo', entry.id])).json.error!.message).toContain('already undone')
})

test('moving a folder repairs links to the documents in it, and undo restores every file and path', async () => {
  // This journey moves ordinary parts inside the root Folio; it does not move a second Folio.
  await rm(join(fx.root, 'talks', MANIFEST_NAME))
  await fx.write(MANIFEST_NAME, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'talks/york.md', role: 'section' }, { path: 'notes.md', role: 'section' }] }, null, 2)}\n`)
  await fx.write('talks/picture.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]))
  const before = await fx.snapshot()
  const moved = await fx.cli(['move-folder', 'talks', 'events/2026'])
  expect(moved.json.error?.message ?? '').toBe('')
  expect(moved.json.result).toMatchObject({ from: 'talks', to: 'events/2026', documents: 2, repaired: [MANIFEST_NAME] })
  expect(JSON.parse(await fx.read(MANIFEST_NAME)).files.map((file: { path: string }) => file.path)).toEqual(['events/2026/york.md', 'notes.md'])
  expect(existsSync(join(fx.root, 'talks'))).toBe(false)
  expect((await fx.bytes('events/2026/picture.png')).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 255]))).toBe(true)
  // The manifest that travelled with the folder still means what it meant: no notice about it.
  expect((moved.json.result!.notices as string[]).filter((notice) => notice.startsWith('events/2026/'))).toEqual([])

  expect((await fx.cli(['undo'])).json.result).toMatchObject({ moved: [{ from: 'events/2026', to: 'talks', kind: 'folder' }] })
  expect(await fx.snapshot()).toEqual(before)
  expect(existsSync(join(fx.root, 'events'))).toBe(true) // an empty folder is left; undo never deletes
})

test('undo refuses, naming the file, when a file no longer holds what the command line wrote', async () => {
  expect((await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])).code).toBe(0)
  await fx.write('talks/intro.md', `${await fx.read('talks/intro.md')}\nA line the writer added since.\n`)
  const after = await fx.snapshot({ journal: true })
  const refused = await fx.cli(['undo'])
  expect(refused.code).toBe(1)
  expect(refused.json.error).toMatchObject({ code: 'refused' })
  expect(refused.json.error!.message).toContain('talks/intro.md has changed')
  expect(await fx.snapshot({ journal: true })).toEqual(after)
  // The same for a moved file that has gone, and for the old name being taken again.
  await rm(join(fx.root, 'talks/intro.md'))
  expect((await fx.cli(['undo'])).json.error!.message).toContain('talks/intro.md is no longer there')
})

test('a rename whose repair fails partway restores content and path and reports refused', async () => {
  const before = await fx.snapshot({ journal: true })
  let writes = 0
  const failed = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'], {
    write: { seams: { betweenCheckAndWrite: async (path) => { if (path !== 'talks/york.md' && ++writes === 2) throw new Error('the disk refused the second repair') } } },
  })
  expect(writes).toBeGreaterThanOrEqual(2) // the app's repair also rewrites the first file while backing out
  expect(failed.code).toBe(1)
  expect(failed.json.error).toMatchObject({ code: 'refused' })
  expect(failed.json.error!.message).toContain('the disk refused the second repair')
  expect(failed.json.error!.message).toContain('every file and path the command had touched was put back')
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect((await inspectOwnerLock(fx.root)).state).toBe('free')
})

test('journal entries older than 30 days are pruned on the next write; other files in the folder are left', async () => {
  const day = 24 * 60 * 60 * 1000
  const start = Date.parse('2026-10-07T10:00:00.000Z')
  const at = (offset: number) => ({ write: { now: () => new Date(start + offset) } })
  expect((await fx.cli(['scrap', 'notes.md', '--text', 'first'], at(0))).json.result!.undo).toBeNull() // a new scraps file: not journalled
  const old = (await fx.cli(['scrap', 'notes.md', '--text', 'second'], at(0))).json.result!.undo as string
  expect(old).toStartWith('20261007T100000000Z-')
  const recent = (await fx.cli(['scrap', 'notes.md', '--text', 'third'], at(29 * day))).json.result!.undo as string
  await writeFile(join(fx.journalDir, `${old} (conflicted copy).json`), 'not ours to remove')
  expect(await journalFiles()).toContain(`${old}.json`)
  const next = (await fx.cli(['scrap', 'notes.md', '--text', 'fourth'], at(31 * day))).json.result!.undo as string
  expect(await journalFiles()).toEqual([`${old} (conflicted copy).json`, `${recent}.json`, `${next}.json`].sort())
  const listed = await fx.cli(['undo', '--list'])
  expect((listed.json.result!.changes as Array<{ id: string }>).map((change) => change.id)).toEqual([next, recent])
})

test('adding a scrap to an existing scraps file is undone to the byte; the journal lives only in its own folder', async () => {
  expect((await fx.cli(['scrap', 'notes.md', '--text', 'first'])).code).toBe(0)
  const withOne = await fx.snapshot()
  const second = await fx.cli(['scrap', 'notes.md', '--text', 'second'])
  expect((await fx.read('scraps/notes-SCRAPS.md')).startsWith(await Buffer.from(withOne['scraps/notes-SCRAPS.md'], 'base64').toString('utf8'))).toBe(true)
  expect(await journalFiles()).toEqual([`${second.json.result!.undo as string}.json`])
  expect((await fx.cli(['undo', second.json.result!.undo as string])).code).toBe(0)
  expect(await fx.snapshot()).toEqual(withOne)
  // Document content is copied nowhere in the Collection: the journal is outside it, and nothing else was added.
  expect(await fx.snapshot()).toEqual(withOne)
  expect(await readdir(join(fx.root, '.writeflex'))).not.toContain('cli-journal')
  expect(await journalFiles()).toHaveLength(1)
})

test('a tampered journal entry cannot write, move or restore outside document paths', async () => {
  const outsideFile = join(dirname(fx.root), `${basename(fx.root)}-outside.md`)
  await writeFile(outsideFile, 'outside\n')
  await symlink(join(fx.root, '.writeflex'), join(fx.root, 'link'))
  await fx.write('talks/picture.png', 'png')
  const pwned = Buffer.from('pwned').toString('base64')
  const file = (path: string, current: string) => ({ files: [{ path, before: pwned, after: sha(current) }] })
  const planted: Array<[string, Partial<JournalEntry>]> = [
    ['20261001T000000000Z-00000001', file('.writeflex/versions.jsonl', '{"version":"fixture"}\n')],
    ['20261001T000000000Z-00000002', file(`../${basename(outsideFile)}`, 'outside\n')],
    ['20261001T000000000Z-00000003', file(outsideFile, 'outside\n')],
    ['20261001T000000000Z-00000004', file('link/versions.jsonl', '{"version":"fixture"}\n')],
    ['20261001T000000000Z-00000005', file('.bridle/journal.jsonl', '{"bridle":"fixture"}\n')],
    ['20261001T000000000Z-00000006', file('talks/../notes.md', NOTES)],
    ['20261001T000000000Z-00000007', file('talks/picture.png', 'png')],
    // Undo moves `to` back to `from`: these would carry a document into the app's own folder, or out.
    ['20261001T000000000Z-00000008', { moves: [{ from: '.writeflex/notes.md', to: 'notes.md', kind: 'file' }] }],
    ['20261001T000000000Z-00000009', { moves: [{ from: `../${basename(fx.root)}-stolen`, to: 'talks', kind: 'folder' }] }],
    ['20261001T000000000Z-0000000a', { moves: [{ from: 'talks/.hidden/york.md', to: 'talks/york.md', kind: 'file' }] }],
    ['20261001T000000000Z-0000000b', { moves: [{ from: '.writeflex/cli-journal/x.md', to: '.writeflex/versions.jsonl', kind: 'file' }] }],
  ]
  for (const [id, entry] of planted) await plant(id, entry)
  const before = await fx.snapshot({ journal: true })
  try {
    for (const [id] of planted) {
      const result = await fx.cli(['undo', id])
      expect(result.code, id).toBe(1)
      expect(result.json.error, id).toMatchObject({ code: 'refused' })
      expect(result.json.error!.message, id).toContain('Nothing was changed')
    }
    expect(await fx.snapshot({ journal: true })).toEqual(before)
    expect(await readFile(outsideFile, 'utf8')).toBe('outside\n')
    expect(existsSync(join(dirname(fx.root), `${basename(fx.root)}-stolen`))).toBe(false)
    // A file that is not a well-formed entry is listed as unreadable and never acted on.
    await writeFile(join(fx.journalDir, '20261001T000000000Z-0000000c.json'), '{"version":1,"id":"other","files":"all of them"}')
    const listed = await fx.cli(['undo', '--list'])
    expect(listed.json.result!.unreadable).toEqual(['20261001T000000000Z-0000000c.json'])
    expect((await fx.cli(['undo', '20261001T000000000Z-0000000c'])).json.error!.message).toContain('No journal entry')
  } finally {
    await rm(outsideFile, { force: true })
  }
})

test('a journal folder that is a link is not used: the change is refused before anything is touched', async () => {
  const before = await fx.snapshot()
  const elsewhere = join(fx.appData, 'elsewhere')
  await mkdir(elsewhere, { mode: 0o700 })
  await mkdir(dirname(fx.journalDir), { recursive: true, mode: 0o700 })
  await symlink(elsewhere, fx.journalDir)
  const result = await fx.cli(['move', 'talks/york.md', 'deep/new/york-2026.md'])
  expect(result.code).toBe(1)
  expect(result.json.error!.message).toContain('undo journal cannot be used')
  expect(await readdir(elsewhere)).toEqual([])
  expect(await fx.snapshot()).toEqual(before)
  expect(existsSync(join(fx.root, 'deep'))).toBe(false) // not even the folder above the new name was made
  expect((await fx.cli(['undo', '--list'])).json.error!.message).toContain('undo journal cannot be used')
})
