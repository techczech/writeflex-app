import { test, expect, beforeEach, afterEach } from 'bun:test'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { versionTextReader } from '../../src/main/cli/history-store'
import type { Version } from '../../src/main/versions'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Ticket 07, review round: in the history stores, what is checked is what is used. The journal is
// data (its hash is checked before it is joined to a path), an object is opened without following a
// link and must hash to its name, and every check is made immediately before the open it guards.
let fx: WriteFixture
let aside: string
const SECRET = 'outside the Collection: never shown\n'
const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex')
const gitEnv = { global: process.env.GIT_CONFIG_GLOBAL, system: process.env.GIT_CONFIG_NOSYSTEM }

beforeEach(async () => {
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  fx = await writeFixture()
  aside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-history-aside-')))
  await writeFile(join(aside, 'secret.txt'), SECRET)
})
afterEach(async () => {
  if (gitEnv.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = gitEnv.global
  if (gitEnv.system === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = gitEnv.system
  await rm(join(dirname(fx.root), `${basename(fx.root)}-x`), { force: true })
  await fx.dispose()
  await rm(aside, { recursive: true, force: true })
})

const objects = (): string => join(fx.root, '.bridle', 'objects')
const asideNames = async (): Promise<string[]> => (await readdir(aside)).sort()
/** A version of notes.md whose journal entry names `hash`; the stores hold nothing else. */
async function plantVersion(hash: unknown): Promise<void> {
  await mkdir(objects(), { recursive: true })
  await writeFile(join(fx.root, '.bridle', 'journal.jsonl'), `${JSON.stringify({ kind: 'snapshot', id: 's1', ts: 1, sessionId: 'x', file: join(fx.root, 'notes.md'), hash })}\n`)
  await writeFile(join(fx.root, '.writeflex', 'versions.jsonl'), `${JSON.stringify({ id: 'v_planted', path: 'notes.md', name: 'Planted', author: { name: 'x' }, ts: 1, snapshotId: 's1', versionId: 'bv1' })}\n`)
}
/** Compare the planted version with the text on disk; nothing of SECRET may be in anything printed. */
async function compareRefused(phrase: string): Promise<void> {
  const before = await fx.snapshot({ journal: true })
  const compared = await fx.cli(['compare-versions', 'notes.md', 'v_planted'])
  expect(compared.code, phrase).toBe(1)
  expect(compared.json.error!.message, phrase).toContain(phrase)
  expect(compared.out + compared.err, phrase).not.toContain('never shown')
  expect(await fx.snapshot({ journal: true }), phrase).toEqual(before)
}
const save = (seams?: { betweenCheckAndWrite?: (path: string) => Promise<void> }) =>
  fx.cli(['save-version', 'notes.md', '--name', 'Guarded'], seams ? { write: { seams } } : {})
const versionNames = async (): Promise<unknown[]> => (await fx.read('.writeflex/versions.jsonl')).split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { name?: unknown }).name)

test('compare: a hash from the journal is used only if it is a hash; a path in its place reads nothing', async () => {
  // `objects/../../../<root>-x` is a real file beside the Collection: joined as it came, it would be read.
  await writeFile(join(dirname(fx.root), `${basename(fx.root)}-x`), SECRET)
  for (const hash of [`../../../${basename(fx.root)}-x`, join(aside, 'secret.txt'), sha(SECRET).toUpperCase(), sha(SECRET).slice(1), `${sha(SECRET)}/../${sha(SECRET)}`, '', 7, null, { toString: 'x' }]) {
    await plantVersion(hash)
    await compareRefused('names something that is not one of the history store\'s own objects')
  }
})

test('compare: an object that is a link is not read, even when the file behind it would hash to the object\'s name', async () => {
  await plantVersion(sha(SECRET))
  await symlink(join(aside, 'secret.txt'), join(objects(), sha(SECRET)))
  await compareRefused('is not an ordinary file')
  // Nor a folder standing at the name.
  await rm(join(objects(), sha(SECRET)))
  await mkdir(join(objects(), sha(SECRET)))
  await compareRefused('is not an ordinary file')
})

test('compare: an object whose content does not hash to its name is a damaged entry, never the version\'s text', async () => {
  const name = sha('what the version held\n')
  await plantVersion(name)
  await writeFile(join(objects(), name), SECRET)
  await compareRefused('does not hold the text it is named for')
  // The same store with the right bytes is read.
  await writeFile(join(objects(), name), 'what the version held\n')
  const compared = await fx.cli(['compare-versions', 'notes.md', 'v_planted'])
  expect(compared.json.result).toMatchObject({ fromContent: 'what the version held\n', toContent: await fx.read('notes.md') })
})

test('compare: a link swapped in for the objects folder, or the history folder, between the check and the open is never read through', async () => {
  const name = sha('what the version held\n')
  await plantVersion(name)
  await writeFile(join(objects(), name), 'what the version held\n')
  // Outside, under the same name: other content in one folder, the very same content in another.
  await mkdir(join(aside, 'other'))
  await writeFile(join(aside, 'other', name), SECRET)
  await mkdir(join(aside, 'same'))
  await writeFile(join(aside, 'same', name), 'what the version held\n')
  await mkdir(join(aside, 'history', 'objects'), { recursive: true })
  await writeFile(join(aside, 'history', 'journal.jsonl'), `${JSON.stringify({ kind: 'snapshot', id: 's1', ts: 1, sessionId: 'x', file: 'x', hash: sha(SECRET) })}\n`)
  await writeFile(join(aside, 'history', 'objects', sha(SECRET)), SECRET)

  const swapAt = (rel: string, real: string, to: string) => async (checked: string): Promise<void> => {
    if (checked !== rel || existsSync(`${real}-kept`)) return // once
    await rename(real, `${real}-kept`)
    await symlink(to, real)
  }
  const restore = async (real: string): Promise<void> => {
    await rm(real)
    await rename(`${real}-kept`, real)
  }
  const read = async (seam: (checked: string) => Promise<void>): Promise<string> =>
    versionTextReader(fx.root, { afterCheck: seam }).readSnapshotContent('s1').then((text) => `returned: ${String(text)}`, (error: unknown) => `refused: ${(error as Error).message}`)

  for (const to of ['other', 'same']) {
    const outcome = await read(swapAt(`.bridle/objects/${name}`, objects(), join(aside, to)))
    expect(outcome, to).toStartWith('refused: ')
    expect(outcome, to).not.toContain('never shown')
    await restore(objects())
  }
  const outcome = await read(swapAt('.bridle/journal.jsonl', join(fx.root, '.bridle'), join(aside, 'history')))
  expect(outcome).toStartWith('refused: ')
  expect(outcome).not.toContain('never shown')
  await restore(join(fx.root, '.bridle'))
  // Untouched, it reads.
  expect(await versionTextReader(fx.root).readSnapshotContent('s1')).toBe('what the version held\n')
})

test('compare and save: a version or review journal that is a link is not read', async () => {
  await plantVersion(sha('x'))
  await rm(join(fx.root, '.writeflex', 'changes.jsonl'))
  await symlink(join(aside, 'secret.txt'), join(fx.root, '.writeflex', 'changes.jsonl'))
  await compareRefused('.writeflex/changes.jsonl is not an ordinary file')
  expect((await save()).json.error!.message).toContain('.writeflex/changes.jsonl is not an ordinary file')
  await rm(join(fx.root, '.writeflex', 'changes.jsonl'))
  await rm(join(fx.root, '.writeflex', 'versions.jsonl'))
  await symlink(join(aside, 'secret.txt'), join(fx.root, '.writeflex', 'versions.jsonl'))
  await compareRefused('.writeflex/versions.jsonl is not an ordinary file')
  expect(await readFile(join(aside, 'secret.txt'), 'utf8')).toBe(SECRET)
})

test('save: the object is written only if absent; an identical one is left alone; anything else at its name refuses the save', async () => {
  const text = await fx.read('notes.md')
  const name = sha(text)
  await mkdir(objects())
  // Identical: kept as it is (the same file, not rewritten), and the save goes through.
  await writeFile(join(objects(), name), text)
  const kept = await lstat(join(objects(), name))
  const saved = await save()
  expect(saved.json.error?.message ?? '').toBe('')
  expect((await lstat(join(objects(), name))).ino).toBe(kept.ino)
  expect((await readdir(objects())).sort()).toEqual([name])
  expect(await versionNames()).toContain('Guarded')

  const refusedWith = async (phrase: string): Promise<void> => {
    const before = await fx.snapshot({ journal: true })
    const result = await save()
    expect(result.code, phrase).toBe(1)
    expect(result.json.error!.message, phrase).toContain(phrase)
    expect(await fx.snapshot({ journal: true }), phrase).toEqual(before)
    expect(await asideNames(), phrase).toEqual(['secret.txt'])
    expect(await readFile(join(aside, 'secret.txt'), 'utf8'), phrase).toBe(SECRET)
  }
  // Different content under the name.
  await writeFile(join(objects(), name), 'not the document\n')
  await refusedWith('does not hold the text it is named for')
  // A link to a file outside that is not there yet (it would be created), and to one that is.
  await rm(join(objects(), name))
  await symlink(join(aside, 'made-through.txt'), join(objects(), name))
  await refusedWith('is not an ordinary file')
  await rm(join(objects(), name))
  await symlink(join(aside, 'secret.txt'), join(objects(), name))
  await refusedWith('is not an ordinary file')
  // A folder.
  await rm(join(objects(), name))
  await mkdir(join(objects(), name))
  await refusedWith('is not an ordinary file')
})

test('save: a link swapped in for the objects folder while the object is being written puts nothing outside and records no version', async () => {
  const name = sha(await fx.read('notes.md'))
  await mkdir(objects())
  const before = await fx.snapshot({ journal: true })
  let swapped = false
  const result = await save({ betweenCheckAndWrite: async (checked) => {
    if (checked !== '.bridle/objects' || swapped) return
    swapped = true
    await rename(objects(), `${objects()}-kept`)
    await symlink(aside, objects())
  } })
  expect(swapped).toBe(true)
  expect(result.code).toBe(1)
  expect(result.json.error!.message).toContain('changed while')
  expect(await asideNames()).toEqual(['secret.txt'])
  await rm(objects())
  await rename(`${objects()}-kept`, objects())
  // The object was never given its name; the journals are as they were.
  expect(existsSync(join(objects(), name))).toBe(false)
  const after = await fx.snapshot({ journal: true })
  expect(Object.fromEntries(Object.entries(after).filter(([path]) => !path.startsWith('.bridle/objects/')))).toEqual(before)
})

test('save: a journal swapped for a link just before Bridle appends to it is seen, and no version is recorded', async () => {
  const versionsBefore = await fx.read('.writeflex/versions.jsonl')
  await writeFile(join(aside, 'elsewhere.jsonl'), '')
  let calls = 0
  const result = await save({ betweenCheckAndWrite: async (checked) => {
    if (checked !== '.bridle/journal.jsonl') return
    calls += 1
    if (calls !== 2) return // the restore point is in; the snapshot line is next
    await rename(join(fx.root, '.bridle', 'journal.jsonl'), join(fx.root, '.bridle', 'journal-kept.jsonl'))
    await symlink(join(aside, 'elsewhere.jsonl'), join(fx.root, '.bridle', 'journal.jsonl'))
  } })
  expect(calls).toBe(2)
  expect(result.code).toBe(1)
  // Refused, whichever layer sees the link first: the snapshot store itself (it refuses a linked or
  // hard-linked journal) or the command line's own check after it. The behaviour is asserted, not the sentence.
  expect(result.json).toMatchObject({ ok: false })
  expect(result.json).not.toHaveProperty('result')
  expect(result.json.error!.message).not.toBe('')
  expect(result.out).not.toContain(SECRET)
  // No version is recorded.
  expect(await fx.read('.writeflex/versions.jsonl')).toBe(versionsBefore)
  // Through the link: at most the one line the store appended by name before the swap could be seen, and nothing more.
  expect((await readFile(join(aside, 'elsewhere.jsonl'), 'utf8')).split('\n').filter(Boolean).length).toBeLessThanOrEqual(1)
  expect(await asideNames()).toEqual(['elsewhere.jsonl', 'secret.txt'])
})

test('save: a document that changes between the command line\'s read and Bridle\'s is not recorded as a version', async () => {
  const versionsBefore = await fx.read('.writeflex/versions.jsonl')
  let calls = 0
  const result = await save({ betweenCheckAndWrite: async (checked) => {
    if (checked === '.bridle/journal.jsonl' && ++calls === 2) await fx.write('notes.md', 'rewritten by another program\n')
  } })
  expect(result.code).toBe(1)
  expect(result.json.error).toMatchObject({ code: 'refused' })
  expect(result.json.error!.message).toContain('notes.md changed while its version was being saved')
  expect(await fx.read('.writeflex/versions.jsonl')).toBe(versionsBefore)
  // Run again, it saves what is there now.
  const again = await save()
  expect(again.code).toBe(0)
  const version = again.json.result!.version as Version
  expect(await versionTextReader(fx.root).readSnapshotContent(version.snapshotId!)).toBe('rewritten by another program\n')
})
