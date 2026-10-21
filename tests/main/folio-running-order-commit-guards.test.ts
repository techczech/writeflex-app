/**
 * The guards of a running-order write that only show under a race or a late failure. Each test fails when
 * the guard it names is taken out.
 *
 * The races are injected at the write itself: `saveFileWithoutReadBack` is wrapped so that "another writer"
 * changes the file after the write's first byte comparison has passed and before its temporary file is
 * renamed over the document. Only a comparison made in the tick of the rename can catch that.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { canonicalFolioDir } from '../../src/main/folio-dir'
import { cachedFolioOrderFacts, invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { folioOutline } from '../../src/main/folio-outline'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from '../../src/main/folio-running-order'
import { rewriteJsonArrayByKey } from '../../src/main/json-array-layout'
import { movePart, PlanWrittenButNotReRead, removePart, writePreparedManifest } from '../../src/main/plan'
import { collectionDir } from '../../src/main/plan-ipc'
import { withPlanLock } from '../../src/main/plan-lock'
import { Workspace } from '../../src/main/workspace'
import { OUTLINE_UNSAFE_MESSAGE } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'guide'
const INDEX = `${DIR}/_guide_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const piece = (name: string) => `${DIR}/${name}.md`
const ABCD = ['a', 'b', 'c', 'd'].map(piece)
const read = (path: string) => readFile(join(root, path), 'utf8')
const MANIFEST_TEXT = '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md" },\n    { "path": "b.md" },\n    { "path": "c.md" },\n    { "path": "d.md" }\n  ]\n}\n'
const INDEX_TEXT = '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n'
const THEIRS_INDEX = '# Guide\n\nSomeone else wrote this.\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n'
const THEIRS_MANIFEST = '{\n  "schema_version": 1,\n  "content_root": "",\n  "title": "theirs",\n  "files": [\n    { "path": "a.md" },\n    { "path": "b.md" },\n    { "path": "c.md" },\n    { "path": "d.md" }\n  ]\n}\n'

async function makeFolio(options: { index?: string | null; manifest?: string } = {}): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  for (const [name, text] of Object.entries({ 'a.md': '# Alpha\n', 'b.md': '# Beta\n', 'c.md': '# Gamma\n', 'd.md': '# Delta\n', 'glossary.md': '# Glossary\n', 'snippets.md': '# Snippets\n' })) {
    await writeFile(join(root, DIR, name), text)
  }
  await writeFile(join(root, MANIFEST), options.manifest ?? MANIFEST_TEXT)
  if (options.index !== null) await writeFile(join(root, INDEX), options.index ?? INDEX_TEXT)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writeflex-commit-guards-'))
  ws = new Workspace(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const strays = async (): Promise<string[]> => (await readdir(join(root, DIR))).filter((name) => name.endsWith('.tmp'))

type Save = typeof ws.saveFileWithoutReadBack
/** Wrap the document write. `before` runs when the write of `path` is asked for, after the caller's own comparison. */
function atWrite(before: (path: string, content: string, nth: number) => Promise<void> | void, after?: (path: string) => void): () => void {
  const original = ws.saveFileWithoutReadBack.bind(ws)
  const counts = new Map<string, number>()
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<Save>[2]) => {
    const nth = (counts.get(path) ?? 0) + 1
    counts.set(path, nth)
    await before(path, content, nth)
    await original(path, content, options)
    after?.(path)
  }) as Save
  return () => { ws.saveFileWithoutReadBack = original }
}

// 1. The same-tick comparisons of the two-document commit and of its rollback.

test('1: an Index Note edited after the comparison and before the rename is not overwritten', async () => {
  await makeFolio()
  const restore = atWrite(async (path) => { if (path === INDEX) await writeFile(join(root, INDEX), THEIRS_INDEX) })
  await expect(movePart(ws, DIR, 0, 3)).rejects.toThrow('The Index Note changed while the Folio outline was being updated.')
  restore()
  expect(await read(INDEX)).toBe(THEIRS_INDEX)
  expect(await read(MANIFEST)).toBe(MANIFEST_TEXT)
  expect(await strays()).toEqual([])
})

test('1: a manifest edited after the comparison and before the rename is not overwritten, and the Index Note is put back', async () => {
  await makeFolio()
  const restore = atWrite(async (path) => { if (path === MANIFEST) await writeFile(join(root, MANIFEST), THEIRS_MANIFEST) })
  await expect(movePart(ws, DIR, 0, 3)).rejects.toThrow('Nothing was changed.')
  restore()
  expect(await read(MANIFEST)).toBe(THEIRS_MANIFEST)
  expect(await read(INDEX)).toBe(INDEX_TEXT)
  expect(await strays()).toEqual([])
})

test('1: a rollback does not put the old Index Note over an edit that landed after its comparison, and says the Index Note was changed', async () => {
  await makeFolio()
  const restore = atWrite(async (path, content, nth) => {
    if (path === MANIFEST) throw new Error('EACCES: permission denied')
    // The second write of the Index Note is the rollback: someone edits the file just before its rename.
    if (path === INDEX && nth === 2) {
      expect(content).toBe(INDEX_TEXT)
      await writeFile(join(root, INDEX), THEIRS_INDEX)
    }
  })
  let message = ''
  await movePart(ws, DIR, 0, 3).catch((error: Error) => { message = error.message })
  restore()
  expect(message).toContain('The Index Note was updated but the Folio manifest could not be')
  expect(message).toContain('Check both in the Folio outline.')
  expect(message).not.toContain('Nothing was changed')
  expect(await read(INDEX)).toBe(THEIRS_INDEX)
  expect(await read(MANIFEST)).toBe(MANIFEST_TEXT)
  expect(await strays()).toEqual([])
})

test('1: manifest-only, a manifest edited after the comparison and before the rename is not overwritten', async () => {
  await makeFolio({ index: null })
  const restore = atWrite(async (path) => { if (path === MANIFEST) await writeFile(join(root, MANIFEST), THEIRS_MANIFEST) })
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD })
  restore()
  expect(result).toMatchObject({ ok: false, stale: false })
  expect(await read(MANIFEST)).toBe(THEIRS_MANIFEST)
  expect(await strays()).toEqual([])
})

test('1: manifest-only, an Index Note that appears after the check and before the rename stops the write', async () => {
  await makeFolio({ index: null })
  const restore = atWrite(async (path) => { if (path === MANIFEST) await writeFile(join(root, INDEX), '# Guide\n') })
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD })
  restore()
  expect(result).toEqual({ ok: false, stale: false, message: 'This Folio gained an Index Note meanwhile, so nothing was changed.' })
  expect(await read(MANIFEST)).toBe(MANIFEST_TEXT)
  expect(await strays()).toEqual([])
})

// Run as root, a file with no permissions is still read: the case cannot be made, and is reported as skipped.
test.skipIf(process.getuid?.() === 0)('1: a first manifest is not written over one that appeared meanwhile and cannot be read', async () => {
  await mkdir(join(root, DIR), { recursive: true })
  // The other writer's manifest lands in the tick of the rename, ahead of the comparison made there.
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = ((path: string, content: string, options?: Parameters<Save>[2]) => original(path, content, {
    ...options,
    beforeCommit: () => {
      writeFileSync(join(root, MANIFEST), THEIRS_MANIFEST)
      chmodSync(join(root, MANIFEST), 0o000)
      options?.beforeCommit?.()
    },
  })) as Save
  const write = writePreparedManifest(ws, { path: MANIFEST, current: null, next: MANIFEST_TEXT })
  await expect(write).rejects.toThrow('could not be read, so nothing was written over it')
  ws.saveFileWithoutReadBack = original
  chmodSync(join(root, MANIFEST), 0o644)
  expect(await read(MANIFEST)).toBe(THEIRS_MANIFEST)
  expect(await strays()).toEqual([])
})

// 2. Elements of `files` that are not entries.

const WITH_OTHERS = '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md" },\n    "b.md",\n    { "id": "no-path" },\n    { "path": "c.md" }\n  ]\n}\n'
const AC_INDEX = '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Gamma]]\n'

test('2: a manifest with an element that is not an entry is refused by the Outline routes and shows no controls', async () => {
  await makeFolio({ manifest: WITH_OTHERS, index: AC_INDEX })
  const expected = [piece('a'), piece('c')]
  const move = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected })
  expect(move.result).toEqual({ ok: false, stale: false, message: OUTLINE_UNSAFE_MESSAGE })
  const add = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected })
  expect(add.result).toEqual({ ok: false, stale: false, message: OUTLINE_UNSAFE_MESSAGE })
  expect(await read(MANIFEST)).toBe(WITH_OTHERS)
  expect(await read(INDEX)).toBe(AC_INDEX)
  expect((await folioOutline(ws, piece('a')))?.orderInPlanOnly).toBe(true)
})

test('2: a Folio outline write keeps such elements, byte for byte, after the entry they followed', async () => {
  await makeFolio({ manifest: WITH_OTHERS, index: AC_INDEX })
  await movePart(ws, DIR, 1, 0)
  const text = await read(MANIFEST)
  expect(JSON.parse(text).files).toEqual([{ path: 'c.md' }, { path: 'a.md' }, 'b.md', { id: 'no-path' }])
  expect(text).toContain('    "b.md",\n    { "id": "no-path" }')
  await removePart(ws, DIR, 1)
  expect(JSON.parse(await read(MANIFEST)).files).toEqual([{ path: 'c.md' }, 'b.md', { id: 'no-path' }])
})

// 4. A change that was made, and could not be read again.

/** After the manifest has been written, the workspace listing fails: every later read of the Plan throws. */
function failReadsAfterManifestWrite(): () => void {
  let failing = false
  const restoreSave = atWrite(() => undefined, (path) => { if (path === MANIFEST) failing = true })
  const listFiles = ws.listFiles.bind(ws)
  ws.listFiles = (async () => {
    if (failing) throw new Error(`EIO: i/o error, scandir '${root}'`)
    return listFiles()
  }) as typeof ws.listFiles
  return () => { restoreSave(); ws.listFiles = listFiles }
}

test('4: a move that was written is reported as made when the Folio outline cannot be read again', async () => {
  await makeFolio()
  const restore = failReadsAfterManifestWrite()
  const outcome = await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath: null, expected: ABCD })
  restore()
  const moved = ['b', 'c', 'd', 'a'].map(piece)
  expect(outcome.result).toEqual({ ok: true, changed: true, order: moved })
  expect(outcome.plan).toBeNull()
  expect(outcome.writtenIndex).toBe(INDEX)
  expect(JSON.parse(await read(MANIFEST)).files.map((file: { path: string }) => `${DIR}/${file.path}`)).toEqual(moved)
  expect(await read(INDEX)).toContain('- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n- [[Alpha]]')
})

test('4: an Add that was written is reported as made, and a Folio outline write says so in its own error', async () => {
  await makeFolio()
  let restore = failReadsAfterManifestWrite()
  const outcome = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })
  restore()
  expect(outcome.result).toMatchObject({ ok: true, changed: true, order: [...ABCD, piece('glossary')] })
  // Its Undo is kept all the same: the documents are read straight from disk, not through the listing.
  expect(outcome.result.ok && typeof outcome.result.undoToken).toBe('string')
  expect(outcome.writtenIndex).toBe(INDEX)
  restore = failReadsAfterManifestWrite()
  const error = await movePart(ws, DIR, 0, 1).catch((caught: unknown) => caught)
  restore()
  expect(error).toBeInstanceOf(PlanWrittenButNotReRead)
  expect((error as Error).message).toContain('The change was made')
})

test('4: Undo of an Add that was written and whose Folio outline could not be read again is reported as made, both documents put back', async () => {
  await makeFolio()
  const added = [piece('glossary'), piece('snippets')]
  const outcome = await addFolioPieces(ws, DIR, { paths: added, expected: ABCD })
  if (!outcome.result.ok) throw new Error(outcome.result.message)

  // The listing fails once the manifest is written back, so the Plan cannot be read again after the Undo.
  const restore = failReadsAfterManifestWrite()
  const undone = await removeAddedFolioPieces(ws, DIR, { token: outcome.result.undoToken! })
  restore()
  expect(undone.result).toMatchObject({ ok: true, changed: true })
  expect(undone.plan).toBeNull()
  expect(undone.writtenIndex).toBe(INDEX)
  expect(await read(INDEX)).toBe(INDEX_TEXT)
  expect(await read(MANIFEST)).toBe(MANIFEST_TEXT)
})

// 5. One Folio, one lock and one cache entry, however its folder is spelled.

// A volume that ignores case holds one folder under both names. Asked of the temporary folder the tests
// run in; where it does not hold, the case test below is reported as skipped, not as passed.
const caseProbe = mkdtempSync(join(tmpdir(), 'writeflex-case-probe-'))
const volumeIgnoresCase = existsSync(caseProbe.toUpperCase())
rmSync(caseProbe, { recursive: true, force: true })

test.skipIf(!volumeIgnoresCase)('5: on a volume that ignores case, the folder spelled in another case takes the same lock', async () => {
  await makeFolio()
  expect(existsSync(join(root, 'GUIDE'))).toBe(true)
  const spellings = ['guide', 'GUIDE', 'Guide/']
  let holders = 0
  let most = 0
  const order: string[] = []
  await Promise.all(spellings.map((dir) => withPlanLock(ws, dir, async () => {
    holders += 1
    most = Math.max(most, holders)
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(dir)
    holders -= 1
  })))
  expect(most).toBe(1)
  expect(order).toEqual(spellings)
})

test('5: every spelling of one Folio folder takes the same lock', async () => {
  await makeFolio()
  const spellings = ['guide', 'guide/', 'guide/.', './guide', 'x/../guide', 'guide//']
  let holders = 0
  let most = 0
  const order: string[] = []
  await Promise.all(spellings.map((dir) => withPlanLock(ws, dir, async () => {
    holders += 1
    most = Math.max(most, holders)
    await new Promise((resolve) => setTimeout(resolve, 5))
    order.push(dir)
    holders -= 1
  })))
  expect(most).toBe(1)
  expect(order).toEqual(spellings)
  // The workspace root spelled another way is the same workspace.
  let inside = 0
  let both = 0
  await Promise.all([{ root }, { root: `${root}/` }, { root: join(root, DIR, '..') }].map((workspace) => withPlanLock(workspace, DIR, async () => {
    inside += 1
    both = Math.max(both, inside)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inside -= 1
  })))
  expect(both).toBe(1)
  // Another folder is another lock.
  await mkdir(join(root, 'other'))
  let together = 0
  let peak = 0
  await Promise.all(['guide', 'other'].map((dir) => withPlanLock(ws, dir, async () => {
    together += 1
    peak = Math.max(peak, together)
    await new Promise((resolve) => setTimeout(resolve, 5))
    together -= 1
  })))
  expect(peak).toBe(2)
})

test('5: the cache holds one answer per Folio, and the IPC boundary passes one spelling on', async () => {
  await makeFolio()
  let loads = 0
  const load = async (): Promise<number> => { loads += 1; return loads }
  expect(await cachedFolioOrderFacts(root, 'guide', load)).toBe(1)
  expect(await cachedFolioOrderFacts(root, 'guide/', load)).toBe(1)
  expect(await cachedFolioOrderFacts(`${root}/`, 'x/../guide/.', load)).toBe(1)
  invalidateFolioOrderFacts(root, 'guide/.')
  expect(await cachedFolioOrderFacts(root, 'guide', load)).toBe(2)
  // A hold of the lock under one spelling drops the answer kept under another.
  await withPlanLock(ws, 'x/../guide/', async () => undefined)
  expect(await cachedFolioOrderFacts(root, 'guide', load)).toBe(3)
  invalidateFolioOrderFacts(root)

  for (const dir of ['guide', 'guide/', 'guide/.', './guide', 'x/../guide']) expect(collectionDir(ws, { dir })).toBe('guide')
  expect(collectionDir(ws, {})).toBe('')
  expect(collectionDir(ws, { dir: '.' })).toBe('')
  expect(() => collectionDir(ws, { dir: '../elsewhere' })).toThrow()
  if (existsSync(join(root, 'GUIDE'))) expect(canonicalFolioDir(root, 'GUIDE/')).toBe('guide')
  // A folder that is not there keeps the name it was given, normalised.
  expect(canonicalFolioDir(root, 'Not-There/sub/')).toBe('Not-There/sub')
})

// 6. Separators stay in their slots.

test('6: a reorder moves the elements and leaves each separator where it was', () => {
  const source = '{"files":[{"path":"a.md"},  {"path":"b.md"},\n\t{"path":"c.md"}], "x": 1}'
  const stand = [{ path: 'c.md' }, { path: 'a.md' }, { path: 'b.md' }]
  const moved = rewriteJsonArrayByKey(source, 'files', 'path', stand, new Map([[stand[0], 2], [stand[1], 0], [stand[2], 1]]))
  expect(moved).toBe('{"files":[{"path":"c.md"},  {"path":"a.md"},\n\t{"path":"b.md"}], "x": 1}')
  // By key as well (the Plan's own route), and a removal keeps the separators of the slots that remain.
  expect(rewriteJsonArrayByKey(source, 'files', 'path', [{ path: 'b.md' }, { path: 'a.md' }, { path: 'c.md' }])).toBe('{"files":[{"path":"b.md"},  {"path":"a.md"},\n\t{"path":"c.md"}], "x": 1}')
  expect(rewriteJsonArrayByKey(source, 'files', 'path', [{ path: 'a.md' }, { path: 'c.md' }])).toBe('{"files":[{"path":"a.md"},  {"path":"c.md"}], "x": 1}')
})

test('6: an append repeats the last separator, and a CRLF manifest gains CRLF lines', () => {
  const mixed = '{"files":[{"path":"a.md"},  {"path":"b.md"},\n\t{"path":"c.md"}]}'
  const appended = rewriteJsonArrayByKey(mixed, 'files', 'path', [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md' }, { path: 'd.md' }])
  expect(appended.startsWith('{"files":[{"path":"a.md"},  {"path":"b.md"},\n\t{"path":"c.md"},\n\t{')).toBe(true)
  expect(JSON.parse(appended).files).toHaveLength(4)

  const crlf = '{\r\n  "files": [\r\n    { "path": "a.md" },\r\n    { "path": "b.md" }\r\n  ]\r\n}\r\n'
  const grown = rewriteJsonArrayByKey(crlf, 'files', 'path', [{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md', role: 'appendix' }])
  expect(grown.replaceAll('\r\n', '')).not.toContain('\n')
  expect(grown.startsWith('{\r\n  "files": [\r\n    { "path": "a.md" },\r\n    { "path": "b.md" },\r\n    {\r\n      "path": "c.md",')).toBe(true)
  expect(JSON.parse(grown).files).toEqual([{ path: 'a.md' }, { path: 'b.md' }, { path: 'c.md', role: 'appendix' }])

  const oneEntry = '{\r\n  "files": [\r\n    { "path": "a.md" }\r\n  ]\r\n}\r\n'
  expect(rewriteJsonArrayByKey(oneEntry, 'files', 'path', [{ path: 'a.md' }, { path: 'b.md' }]).replaceAll('\r\n', '')).not.toContain('\n')
  const empty = '{\r\n  "files": []\r\n}\r\n'
  expect(rewriteJsonArrayByKey(empty, 'files', 'path', [{ path: 'a.md' }]).replaceAll('\r\n', '')).not.toContain('\n')
})
