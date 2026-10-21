/**
 * The one chapter order for part files, the Add-all sheet's order and keyboard moves, and the
 * one-write reorder behind "Sort by chapter number" and its Undo (the on-disk formats do not change).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fallbackFolioParts, MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { reorderFolioPieces } from '../../src/main/folio-running-order'
import { readPlan } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { chapterNumber, chapterSortOrder, compareChapterOrder, inverseOrder, isIdentityOrder, sortByChapterOrder } from '../../src/shared/folio-chapter-order'
import { addAllCandidates, moveRowTo, nudgeRow, sheetKeyAction, trappedFocus } from '../../src/shared/folio-add-all'
import { groupAlsoInFolder } from '../../src/shared/folio-outline'
import { partChildHeadings } from '../../src/shared/folio-part-title'

const CZECH = [
  'kapitola-1-význam-kategorizace.md', 'kapitola-2-x.md', 'kapitola-10-y.md', 'kapitola-21-shrnutí.md', // gitleaks:allow (Czech chapter file names, not a key)
  'berlin-a-kay.md', 'doslov.md', 'předmluva.md', 'případová-studie-1-angerhněv.md',
]

test('chapter number is the first digit run in the base name that stands between separators or the name\'s edges', () => {
  expect(chapterNumber('a/b/kapitola-10-y.md')).toBe(10)
  expect(chapterNumber('kapitola-2-x.md')).toBe(2)
  expect(chapterNumber('01-intro.md')).toBe(1)
  expect(chapterNumber('02_body.md')).toBe(2)
  expect(chapterNumber('part 3.md')).toBe(3)
  expect(chapterNumber('README-v2.md')).toBeNull()
  expect(chapterNumber('ch2.md')).toBeNull()
  expect(chapterNumber('2x-notes.md')).toBeNull()
  expect(chapterNumber('2024/doslov.md')).toBeNull() // digits in a folder do not count
  expect(chapterNumber('případová-studie-1-angerhněv.md')).toBe(1)
})

test('chapter order groups numbered files by series (stem) before their number', () => {
  const series = [ // gitleaks:allow (Czech chapter file names, not a key)
    'případová-studie-3-c.md', 'kapitola-2-x.md', 'případová-studie-1-angerhněv.md', 'kapitola-21-shrnutí.md', 'kapitola-1-význam.md', 'případová-studie-2-b.md', 'kapitola-10-y.md', // gitleaks:allow (Czech chapter file names, not a key)
    'doslov.md', 'předmluva.md', 'berlin-a-kay.md', // gitleaks:allow (Czech chapter file names, not a key)
  ]
  expect(sortByChapterOrder(series, (name) => name)).toEqual([
    'kapitola-1-význam.md', 'kapitola-2-x.md', 'kapitola-10-y.md', 'kapitola-21-shrnutí.md', // gitleaks:allow (Czech chapter file names, not a key)
    'případová-studie-1-angerhněv.md', 'případová-studie-2-b.md', 'případová-studie-3-c.md', // gitleaks:allow (Czech chapter file names, not a key)
    'berlin-a-kay.md', 'doslov.md', 'předmluva.md', // gitleaks:allow (Czech chapter file names, not a key)
  ])
  // An empty stem (`01-a`) sorts before any named series; the series is compared by its stem, not the whole name.
  expect(sortByChapterOrder(['kapitola-1.md', '02-b.md', '01-a.md'], (name) => name)).toEqual(['01-a.md', '02-b.md', 'kapitola-1.md'])
  // Stems are lower-cased and their trailing separators trimmed: `Kapitola_-2` and `kapitola-10` are one series.
  expect(compareChapterOrder('Kapitola_-2.md', 'kapitola-10.md')).toBeLessThan(0) // gitleaks:allow
  expect(compareChapterOrder('kapitola-10.md', 'Kapitola_-2.md')).toBeGreaterThan(0) // gitleaks:allow
})

test('chapter order: kapitola-2 before kapitola-10, numbered first, 01-x before 02-y, unnumbered by name', () => {
  const sorted = sortByChapterOrder([...CZECH].reverse(), (name) => name)
  expect(sorted).toEqual([
    'kapitola-1-význam-kategorizace.md', 'kapitola-2-x.md', 'kapitola-10-y.md', 'kapitola-21-shrnutí.md', 'případová-studie-1-angerhněv.md', // gitleaks:allow (Czech chapter file names, not a key)
    'berlin-a-kay.md', 'doslov.md', 'předmluva.md',
  ])
  expect(compareChapterOrder('02-y.md', '01-x.md')).toBeGreaterThan(0)
  expect(compareChapterOrder('01-x.md', '02-y.md')).toBeLessThan(0)
  // Equal to a numeric-aware compare: a final plain-name tie-break gives one order every time, either way round.
  expect(compareChapterOrder('ch-02.md', 'ch-2.md')).toBeLessThan(0)
  expect(compareChapterOrder('ch-2.md', 'ch-02.md')).toBeGreaterThan(0)
  expect(sortByChapterOrder(['ch-2.md', 'ch-02.md'], (n) => n)).toEqual(sortByChapterOrder(['ch-02.md', 'ch-2.md'], (n) => n))
  expect(compareChapterOrder('a/ch-2.md', 'b/ch-2.md')).toBeLessThan(0) // same base name: the whole path decides
  expect(compareChapterOrder('x/kapitola-2.md', 'a/kapitola-10.md')).toBeLessThan(0) // base names only
})

test('Also in this folder lists the direct files in chapter order', () => {
  const files = CZECH.map((name) => ({ path: `f/${name}`, name, directory: 'f' }))
  const names = groupAlsoInFolder(files, [], 'f', new Set(files.map((f) => f.path))).map((f) => f.path.slice(2))
  expect(names.slice(0, 5)).toEqual(['kapitola-1-význam-kategorizace.md', 'kapitola-2-x.md', 'kapitola-10-y.md', 'kapitola-21-shrnutí.md', 'případová-studie-1-angerhněv.md']) // gitleaks:allow (Czech chapter file names, not a key)
})

test('child headings: one title per part, whatever the level', () => {
  const h = (level: number, text: string) => ({ level, text })
  const texts = (list: Array<{ text?: string }>) => list.map((x) => x.text)
  // `# T` then `## T`: both hidden.
  expect(texts(partChildHeadings([h(1, 'Kapitola 1. Význam'), h(2, 'Kapitola 1. Význam'), h(2, 'Úvod')], 'own', 'Kapitola 1. Význam'))).toEqual(['Úvod'])
  // `## T` at the top with frontmatter title T is the part's own title (mode own): hidden.
  expect(texts(partChildHeadings([h(2, 'Kapitola 2. Pojem'), h(2, 'Další')], 'own', 'Kapitola 2. Pojem'))).toEqual(['Další'])
  // Mode missing: the part does not open with its title, so a heading saying it sits below opening text and is listed (2026-10-21).
  expect(texts(partChildHeadings([h(2, 'Kapitola 2. Pojem'), h(2, 'Další')], 'missing', 'Kapitola 2. Pojem'))).toEqual(['Kapitola 2. Pojem', 'Další'])
  // A leading heading with different text is still listed.
  expect(texts(partChildHeadings([h(2, 'Something else'), h(2, 'Kapitola 3')], 'missing', 'Kapitola 3'))).toEqual(['Something else', 'Kapitola 3'])
  // Same normalisation as the title rule: markup and spacing are ignored.
  expect(texts(partChildHeadings([h(2, '**Kapitola   4**')], 'own', 'Kapitola 4'))).toEqual([])
  // Without a title the old rule holds.
  expect(texts(partChildHeadings([h(1, 'A'), h(2, 'B')], 'own'))).toEqual(['B'])
})

test('Add-all sheet: files in chapter order, manifest-carried files left out, rows move by drag and Alt+arrows', () => {
  const rows = addAllCandidates([
    { path: 'f/kapitola-10.md', title: 'Ten' }, { path: 'f/kapitola-2.md', title: 'Two' }, { path: 'f/doslov.md', title: 'Afterword' },
    { path: 'f/in-manifest.md', title: 'M', manifestBacked: true }, { path: null, title: 'No file' },
  ])
  expect(rows.map((r) => r.title)).toEqual(['Two', 'Ten', 'Afterword'])
  expect(nudgeRow(rows, 1, -1)).toMatchObject({ index: 0 })
  expect(nudgeRow(rows, 1, -1).rows.map((r) => r.title)).toEqual(['Ten', 'Two', 'Afterword'])
  expect(nudgeRow(rows, 0, -1).rows.map((r) => r.title)).toEqual(['Two', 'Ten', 'Afterword']) // at the edge: stays
  expect(nudgeRow(rows, 2, 1).index).toBe(2)
  expect(moveRowTo(rows, 2, 0).map((r) => r.title)).toEqual(['Afterword', 'Two', 'Ten'])
})

test('Sort order: parts with no file keep their positions, the rest go by chapter order; the inverse undoes it', () => {
  const paths = ['k/kapitola-10.md', null, 'k/kapitola-2.md', 'k/doslov.md', null, 'k/kapitola-1.md']
  const order = chapterSortOrder(paths)
  expect(order.map((index) => paths[index])).toEqual(['k/kapitola-1.md', null, 'k/kapitola-2.md', 'k/kapitola-10.md', null, 'k/doslov.md'])
  expect(order[1]).toBe(1)
  expect(order[4]).toBe(4)
  const sorted = order.map((index) => paths[index])
  expect(inverseOrder(order).map((index) => sorted[index])).toEqual(paths)
  expect(isIdentityOrder(chapterSortOrder(['a-1.md', null, 'b-2.md']))).toBe(true)
})

test('Add-all sheet keys: Esc and ⌘↵ from any focus, Tab trapped and wrapping', () => {
  expect(sheetKeyAction({ key: 'Escape' })).toBe('close')
  expect(sheetKeyAction({ key: 'Enter', metaKey: true })).toBe('add')
  expect(sheetKeyAction({ key: 'Enter', ctrlKey: true })).toBe('add')
  expect(sheetKeyAction({ key: 'Enter' })).toBeNull()
  expect(sheetKeyAction({ key: 'Tab' })).toBe('tab')
  expect(trappedFocus(3, 2, false)).toBe(0) // past the last: back to the first
  expect(trappedFocus(3, 0, true)).toBe(2) // before the first: to the last
  expect(trappedFocus(3, 1, false)).toBe(2)
  expect(trappedFocus(3, -1, false)).toBe(0) // focus outside the sheet's controls comes back in
  expect(trappedFocus(3, -1, true)).toBe(2)
  expect(trappedFocus(0, -1, false)).toBeNull()
})

// ---- main: Make a Folio fallback order, and the one-write reorder ----

let root: string
let ws: Workspace
const DIR = 'kn'
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const INDEX = `${DIR}/_kn_INDEX.md`
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'writeflex-chapter-order-')); ws = new Workspace(root); invalidateFolioPlaces(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const read = (path: string) => readFile(join(root, path), 'utf8')
const p = (name: string) => `${DIR}/${name}.md`

async function setup(order: string[]): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  for (const name of ['kapitola-1', 'kapitola-2', 'kapitola-10', 'doslov']) await writeFile(join(root, DIR, `${name}.md`), `# ${name}\n`)
  await writeFile(join(root, MANIFEST), ['{', '  "schema_version": 1,', '  "content_root": "",', '  "files": [', order.map((n) => `    { "path": "${n}.md" }`).join(',\n'), '  ]', '}', ''].join('\n'))
  await writeFile(join(root, INDEX), `# Kn\n\n## Running order\n\n${order.map((n) => `- [[${n}]]`).join('\n')}\n`)
  invalidateFolioPlaces(root)
}

test('Make a Folio fallback orders kapitola-2 before kapitola-10', async () => {
  await setup(['kapitola-1'])
  expect(await fallbackFolioParts(ws, DIR)).toEqual(['kapitola-1', 'kapitola-2', 'kapitola-10', 'doslov'].map(p))
})

test('reorder writes the new order to both documents in one go, changes no format, and undoes exactly', async () => {
  const before = ['doslov', 'kapitola-10', 'kapitola-2', 'kapitola-1']
  await setup(before)
  const manifestBefore = await read(MANIFEST)
  const indexBefore = await read(INDEX)
  const expected = before.map(p)
  const target = sortByChapterOrder(expected, (path) => path)
  expect(target).toEqual(['kapitola-1', 'kapitola-2', 'kapitola-10', 'doslov'].map(p))
  const sorted = await reorderFolioPieces(ws, DIR, { order: target, expected })
  expect(sorted.result).toEqual({ ok: true, changed: true, order: target })
  expect((await readPlan(ws, DIR))?.parts.map((part) => part.path)).toEqual(target)
  // Same shape of file: the manifest is the old text with its entries in the new order; the Index Note keeps its lines.
  expect(await read(MANIFEST)).toBe(manifestBefore.replace(/    \{ "path": "[^"]+" \},?\n/g, '').replace('"files": [\n', `"files": [\n${target.map((t, i) => `    { "path": "${t.slice(DIR.length + 1)}" }${i < target.length - 1 ? ',' : ''}\n`).join('')}`))
  expect((await read(INDEX)).split('\n').length).toBe(indexBefore.split('\n').length)
  const undone = await reorderFolioPieces(ws, DIR, { order: expected, expected: target })
  expect(undone.result).toEqual({ ok: true, changed: true, order: expected })
  expect(await read(MANIFEST)).toBe(manifestBefore)
  expect(await read(INDEX)).toBe(indexBefore)
})

test('reorder refuses a stale order and a non-permutation, writing nothing', async () => {
  await setup(['kapitola-1', 'kapitola-2', 'kapitola-10', 'doslov'])
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const stale = await reorderFolioPieces(ws, DIR, { order: ['kapitola-2', 'kapitola-1', 'kapitola-10', 'doslov'].map(p), expected: ['kapitola-2', 'kapitola-1', 'kapitola-10', 'doslov'].map(p) })
  expect(stale.result).toMatchObject({ ok: false, stale: true })
  const bad = await reorderFolioPieces(ws, DIR, { order: ['kapitola-1', 'kapitola-1', 'kapitola-10', 'doslov'].map(p), expected: ['kapitola-1', 'kapitola-2', 'kapitola-10', 'doslov'].map(p) })
  expect(bad.result).toMatchObject({ ok: false, stale: false })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('reorder on a manifest with no Index Note writes only the manifest', async () => {
  await setup(['doslov', 'kapitola-2', 'kapitola-1', 'kapitola-10'])
  await rm(join(root, INDEX))
  invalidateFolioPlaces(root)
  const expected = ['doslov', 'kapitola-2', 'kapitola-1', 'kapitola-10'].map(p)
  const target = sortByChapterOrder(expected, (path) => path)
  const outcome = await reorderFolioPieces(ws, DIR, { order: target, expected })
  expect(outcome.result).toEqual({ ok: true, changed: true, order: target })
  expect(await Bun.file(join(root, INDEX)).exists()).toBe(false)
  expect(JSON.parse(await read(MANIFEST)).files.map((f: { path: string }) => f.path)).toEqual(target.map((t) => t.slice(DIR.length + 1)))
})
