import { pinnedIndex } from '../helpers/folio-file-identity'
/**
 * The Plan's own whole-order changes (src/main/plan-running-order.ts) and the one line move behind every
 * reorder (plan.ts `moveEntryBlocks`, used by `movePart` and `reorderParts`), against real files in a temp dir:
 * Sort by chapter number, Add all from this folder, and their Undo, for an Index-Note-only Plan, a Folio with
 * both documents, a manifest with no Index Note, and a Plan with parts that have no file yet.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { movePart, readPlan } from '../../src/main/plan'
import { addPlanParts, planPartKeys, removeAddedPlanParts, reorderPlanParts } from '../../src/main/plan-running-order'
import { Workspace } from '../../src/main/workspace'
import { chapterSortOrder, inverseOrder } from '../../src/shared/folio-chapter-order'
import { planMessageFor, STALE_ADD_MESSAGE, STALE_ORDER_MESSAGE, STALE_PLAN_MESSAGE, STALE_UNDO_MESSAGE, type PlanPartKey } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'kn'
const INDEX = `${DIR}/_kn_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-plan-order-')); ws = new Workspace(root); invalidateFolioPlaces(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const pinSort = (source: string) => pinnedIndex(source, Object.fromEntries(['a-1','b-2','c-3','kapitola-2','kapitola-10','doslov'].map(name => [name, `./${name}.md|${name}`])))
const read = (path: string) => readFile(join(root, path), 'utf8')
const exists = (path: string) => Bun.file(join(root, path)).exists()
const p = (name: string) => `${DIR}/${name}.md`

async function folio(files: string[], index: string | null, manifest: string[] | null): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  for (const name of files) await writeFile(join(root, DIR, `${name}.md`), `# ${name}\n`)
  if (index !== null) await writeFile(join(root, INDEX), index)
  if (manifest !== null) {
    await writeFile(join(root, MANIFEST), ['{', '  "schema_version": 1,', '  "content_root": "",', '  "files": [', manifest.map((n) => `    { "path": "${n}.md", "role": "chapter" }`).join(',\n'), '  ]', '}', ''].join('\n'))
  }
  invalidateFolioPlaces(root)
}

async function keys(): Promise<PlanPartKey[]> {
  const plan = await readPlan(ws, DIR)
  if (!plan) throw new Error('no plan')
  return planPartKeys(plan)
}

/** Sort as the Plan does it, then its Undo; answers the bytes after the sort. */
async function sortAndUndo(): Promise<{ sorted: string; index: string; manifest: string | null }> {
  const indexBefore = await read(INDEX)
  const manifestBefore = (await exists(MANIFEST)) ? await read(MANIFEST) : null
  const expected = await keys()
  const order = chapterSortOrder(expected.map((part) => part.path))
  const sorted = await reorderPlanParts(ws, DIR, { order, expected })
  if (!sorted.result.ok) throw new Error(sorted.result.message)
  const after = await read(INDEX)
  const undone = await reorderPlanParts(ws, DIR, { order: inverseOrder(order), expected: sorted.result.parts })
  expect(undone.result.ok).toBe(true)
  return { sorted: after, index: indexBefore, manifest: manifestBefore }
}

test('Sort on an Index-Note-only Folio outline writes the Index Note, creates no manifest, and undoes byte for byte', async () => {
  await folio(['kapitola-10', 'kapitola-2', 'doslov'], '# Kn\n\n## Running order\n\n- [[doslov]]\n- [[kapitola-10]]\n- [[kapitola-2]]\n', null)
  const { sorted, index } = await sortAndUndo()
  expect(sorted).toBe(pinSort(pinnedIndex('# Kn\n\n## Running order\n\n- [[kapitola-2]]\n- [[kapitola-10]]\n- [[doslov]]\n', {"doslov":"./doslov.md|doslov","kapitola-10":"./kapitola-10.md|kapitola-10","kapitola-2":"./kapitola-2.md|kapitola-2"})))
  expect(await exists(MANIFEST)).toBe(false)
  expect(await read(INDEX)).toBe(pinSort(pinnedIndex(index, {"doslov":"./doslov.md|doslov","kapitola-10":"./kapitola-10.md|kapitola-10","kapitola-2":"./kapitola-2.md|kapitola-2"})))
})

test('Sort with CRLF endings and gloss, role and tag text keeps every line as written, in both documents', async () => {
  const index = '# Kn\r\n\r\n## Running order\r\n\r\n- [[c-3]] — gloss C #appendix #draft\r\n- [[b-2]] - plain gloss\r\n- [[a-1]] #vignette\r\n\r\n## After\r\nTail\r\n'
  await folio(['c-3', 'b-2', 'a-1'], index, ['c-3', 'b-2', 'a-1'])
  const { sorted, manifest } = await sortAndUndo()
  expect(sorted).toBe(pinSort(pinnedIndex('# Kn\r\n\r\n## Running order\r\n\r\n- [[a-1]] #vignette\r\n- [[b-2]] - plain gloss\r\n- [[c-3]] — gloss C #appendix #draft\r\n\r\n## After\r\nTail\r\n', {"c-3":"./c-3.md|c-3","b-2":"./b-2.md|b-2","a-1":"./a-1.md|a-1"})))
  expect(await read(INDEX)).toBe(pinSort(index))
  expect(await read(MANIFEST)).toBe(manifest!)
})

test('a running order that ends the file with no final newline sorts, moves and undoes exactly', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[c-3]]\n- [[b-2]]\n- [[a-1]]'
  await folio(['c-3', 'b-2', 'a-1'], index, ['c-3', 'b-2', 'a-1'])
  const { sorted, manifest } = await sortAndUndo()
  expect(sorted).toBe(pinSort('# Kn\n\n## Running order\n\n- [[a-1]]\n- [[b-2]]\n- [[c-3]]'))
  expect(await read(INDEX)).toBe(pinSort(index))
  expect(await read(MANIFEST)).toBe(manifest!)
  // movePart goes through the same line move: the last entry moved first is not joined to the next line.
  await movePart(ws, DIR, 2, 0)
  expect(await read(INDEX)).toBe(pinSort('# Kn\n\n## Running order\n\n- [[a-1]]\n- [[c-3]]\n- [[b-2]]'))
  await movePart(ws, DIR, 0, 2)
  expect(await read(INDEX)).toBe(pinSort(index))
})

test('nested notes travel with their entry; unindented lines between entries keep their place', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[c-3]] — about C\n  - note on C\n    deeper note\n<!-- c comment -->\n- [[b-2]]\n\nText para about B\n- [[a-1]]\n  - note on A\n\n## After\n'
  await folio(['c-3', 'b-2', 'a-1'], index, null)
  const { sorted } = await sortAndUndo()
  expect(sorted).toBe(pinSort('# Kn\n\n## Running order\n\n- [[a-1]]\n  - note on A\n<!-- c comment -->\n- [[b-2]]\n\nText para about B\n- [[c-3]] — about C\n  - note on C\n    deeper note\n\n## After\n'))
  expect(await read(INDEX)).toBe(pinSort(index))
  await movePart(ws, DIR, 0, 1)
  expect(await read(INDEX)).toBe(pinSort('# Kn\n\n## Running order\n\n- [[b-2]]\n<!-- c comment -->\n- [[c-3]] — about C\n  - note on C\n    deeper note\n\nText para about B\n- [[a-1]]\n  - note on A\n\n## After\n'))
})

test('a fence indented under an entry moves with it, blank lines and entry-like lines inside it included', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[a-1]]\n  ```\n  quote\n\n  - [[not an entry]]\n  ```\n- [[b-2]]\n'
  await folio(['a-1', 'b-2'], index, null)
  await movePart(ws, DIR, 1, 0)
  expect(await read(INDEX)).toBe(pinSort('# Kn\n\n## Running order\n\n- [[b-2]]\n- [[a-1]]\n  ```\n  quote\n\n  - [[not an entry]]\n  ```\n'))
  await movePart(ws, DIR, 0, 1)
  expect(await read(INDEX)).toBe(pinSort(index))
})

test('a fence indented less than the entry\'s text ends its block and keeps its place', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[a-1]]\n ```\ncode\n```\n- [[b-2]]\n'
  await folio(['a-1', 'b-2'], index, null)
  await movePart(ws, DIR, 1, 0)
  expect(await read(INDEX)).toBe(pinSort('# Kn\n\n## Running order\n\n- [[b-2]]\n ```\ncode\n```\n- [[a-1]]\n'))
})

test('a Sort moves an indented fence with its entry, to the close of the same character and at least the same length', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[c-3]]\n  ~~~~\n  ~~~\n  ```\n  still code\n  ~~~~~\n- [[b-2]]\n1. [[a-1]]\n'
  await folio(['c-3', 'b-2', 'a-1'], index, null)
  const { sorted } = await sortAndUndo()
  expect(sorted).toBe(pinSort('# Kn\n\n## Running order\n\n1. [[a-1]]\n- [[b-2]]\n- [[c-3]]\n  ~~~~\n  ~~~\n  ```\n  still code\n  ~~~~~\n'))
  expect(await read(INDEX)).toBe(pinSort(index))
})

test('unwritten parts keep their slots in a Sort; only the parts with files are sorted, and none is lost', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[c-3]]\n- [[Not yet written]] — an idea\n- [[b-2]]\n- [[a-1]]\n- [[Also unwritten]]\n'
  await folio(['c-3', 'b-2', 'a-1'], index, ['c-3', 'b-2', 'a-1'])
  const expected = await keys()
  expect(expected.map((part) => part.path)).toEqual([p('c-3'), null, p('b-2'), p('a-1'), null])
  const order = chapterSortOrder(expected.map((part) => part.path))
  expect(order).toEqual([3, 1, 2, 0, 4])
  const { sorted, manifest } = await sortAndUndo()
  expect(sorted).toBe(pinSort('# Kn\n\n## Running order\n\n- [[a-1]]\n- [[Not yet written]] — an idea\n- [[b-2]]\n- [[c-3]]\n- [[Also unwritten]]\n'))
  expect(await read(INDEX)).toBe(pinSort(index))
  expect(await read(MANIFEST)).toBe(manifest!)
})

test('the manifest follows a Folio outline Sort when the Folio outline has unwritten parts', async () => {
  await folio(['c-3', 'b-2', 'a-1'], '# Kn\n\n## Running order\n\n- [[c-3]]\n- [[Idea]]\n- [[b-2]]\n- [[a-1]]\n', ['c-3', 'b-2', 'a-1'])
  const expected = await keys()
  const outcome = await reorderPlanParts(ws, DIR, { order: chapterSortOrder(expected.map((part) => part.path)), expected })
  expect(outcome.result).toMatchObject({ ok: true, changed: true })
  expect(JSON.parse(await read(MANIFEST)).files.map((file: { path: string }) => file.path)).toEqual(['a-1.md', 'b-2.md', 'c-3.md'])
  expect((await keys()).map((part) => part.title)).toEqual(['a-1', 'Idea', 'b-2', 'c-3'])
})

test('a lazily numbered list (1. 1. 1.) is renumbered by the write, so its Undo restores the order, not the bytes', async () => {
  await folio(['c-3', 'b-2', 'a-1'], '# Kn\n\n## Running order\n\n1. [[c-3]]\n1. [[b-2]]\n1. [[a-1]]\n', null)
  const { sorted } = await sortAndUndo()
  expect(sorted).toBe(pinSort(pinnedIndex('# Kn\n\n## Running order\n\n1. [[a-1]]\n2. [[b-2]]\n3. [[c-3]]\n', {"c-3":"./c-3.md|c-3","b-2":"./b-2.md|b-2","a-1":"./a-1.md|a-1"})))
  // Known: every Plan write renumbers a numbered list 1, 2, 3, so the Undo gives the old order with new numbers.
  expect(await read(INDEX)).toBe(pinSort(pinnedIndex('# Kn\n\n## Running order\n\n1. [[c-3]]\n2. [[b-2]]\n3. [[a-1]]\n', {"c-3":"./c-3.md|c-3","b-2":"./b-2.md|b-2","a-1":"./a-1.md|a-1"})))
})

test('a stale or malformed reorder is refused and writes nothing', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[c-3]]\n- [[b-2]]\n'
  await folio(['c-3', 'b-2'], index, null)
  const expected = await keys()
  const stale = await reorderPlanParts(ws, DIR, { order: [1, 0], expected: [...expected].reverse() })
  expect(stale.result).toMatchObject({ ok: false, stale: true })
  const bad = await reorderPlanParts(ws, DIR, { order: [0, 0], expected })
  expect(bad.result).toMatchObject({ ok: false, stale: false })
  expect(await read(INDEX)).toBe(index)
})

test('Add all on an Index-Note-only Folio outline goes through the Folio outline path, in the order given, and its Undo is exact', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[kapitola-1]]\n- [[Idea]]'
  await folio(['kapitola-1', 'kapitola-10', 'kapitola-2', 'doslov'], index, null)
  const plan = await readPlan(ws, DIR)
  expect(plan!.unlisted.map((part) => part.path)).toEqual([p('kapitola-2'), p('kapitola-10'), p('doslov')])
  const expected = await keys()
  const paths = [p('kapitola-10'), p('kapitola-2'), p('doslov')]
  const added = await addPlanParts(ws, DIR, { paths, expected })
  if (!added.result.ok) throw new Error(added.result.message)
  expect(added.result.parts.map((part) => part.path)).toEqual([p('kapitola-1'), null, ...paths])
  expect(await read(INDEX)).toBe(pinnedIndex('# Kn\n\n## Running order\n\n- [[kapitola-1]]\n- [[Idea]]\n- [[kapitola-10]]\n- [[kapitola-2]]\n- [[doslov]]\n', {"kapitola-1":"./kapitola-1.md|kapitola-1","kapitola-10":"./kapitola-10.md|kapitola-10","kapitola-2":"./kapitola-2.md|kapitola-2","doslov":"./doslov.md|doslov"}))
  expect(await exists(MANIFEST)).toBe(false)
  const undone = await removeAddedPlanParts(ws, DIR, { token: added.result.undoToken! })
  expect(undone.result).toMatchObject({ ok: true, changed: true })
  // Byte for byte: even the old last line goes back to having no line ending.
  expect(await read(INDEX)).toBe(index)
  expect((await keys())).toEqual(expected)
})

test('Add all refuses a file the manifest already carries, and a stale view, writing nothing', async () => {
  const index = '# Kn\n\n## Running order\n\n- [[a-1]]\n'
  await folio(['a-1', 'b-2', 'c-3'], index, ['a-1', 'b-2'])
  const expected = await keys()
  const carried = await addPlanParts(ws, DIR, { paths: [p('b-2')], expected })
  expect(carried.result).toMatchObject({ ok: false, stale: false })
  const stale = await addPlanParts(ws, DIR, { paths: [p('c-3')], expected: [] })
  expect(stale.result).toMatchObject({ ok: false, stale: true })
  expect(await read(INDEX)).toBe(index)
})

test('the unlisted list keeps manifest-backed entries in manifest order; only files in neither go by chapter order', async () => {
  await folio(['a-1', 'z-2', 'm-9', 'kapitola-10', 'kapitola-3'], '# Kn\n\n## Running order\n\n- [[a-1]]\n', ['a-1', 'm-9', 'z-2'])
  const plan = await readPlan(ws, DIR)
  expect(plan!.unlisted.map((part) => [part.path, part.manifestBacked])).toEqual([
    [p('m-9'), true], [p('z-2'), true], [p('kapitola-3'), false], [p('kapitola-10'), false],
  ])
})

test('a manifest with no Index Note: Sort and Add all write the manifest only, and undo', async () => {
  await folio(['c-3', 'b-2', 'a-1', 'd-4'], null, ['c-3', 'b-2', 'a-1'])
  const manifestBefore = await read(MANIFEST)
  const expected: PlanPartKey[] = ['c-3', 'b-2', 'a-1'].map((name) => ({ title: name, path: p(name) }))
  const order = chapterSortOrder(expected.map((part) => part.path))
  const sorted = await reorderPlanParts(ws, DIR, { order, expected })
  if (!sorted.result.ok) throw new Error(sorted.result.message)
  expect(sorted.manifestOnly).toBe(true)
  expect(sorted.result.parts.map((part) => part.path)).toEqual([p('a-1'), p('b-2'), p('c-3')])
  expect(await exists(INDEX)).toBe(false)
  const back = await reorderPlanParts(ws, DIR, { order: inverseOrder(order), expected: sorted.result.parts })
  expect(back.result.ok).toBe(true)
  expect(await read(MANIFEST)).toBe(manifestBefore)

  const added = await addPlanParts(ws, DIR, { paths: [p('d-4')], expected })
  if (!added.result.ok) throw new Error(added.result.message)
  expect(added.result.parts.map((part) => part.path)).toEqual([...expected.map((part) => part.path), p('d-4')])
  const undone = await removeAddedPlanParts(ws, DIR, { token: added.result.undoToken! })
  expect(undone.result.ok).toBe(true)
  expect(await read(MANIFEST)).toBe(manifestBefore)
  expect(await exists(INDEX)).toBe(false)
})

test('an Outline refusal answered to the Folio outline is said the Folio outline\'s way by constant, not by rewriting text', () => {
  expect(planMessageFor(STALE_ORDER_MESSAGE)).toBe(STALE_PLAN_MESSAGE)
  expect(planMessageFor(STALE_ADD_MESSAGE)).toBe(STALE_PLAN_MESSAGE)
  expect(planMessageFor(STALE_UNDO_MESSAGE)).toBe(STALE_UNDO_MESSAGE)
  expect(planMessageFor('Could not add x. The Outline has been refreshed. Extra.')).toBe('Could not add x. The Outline has been refreshed. Extra.')
})
