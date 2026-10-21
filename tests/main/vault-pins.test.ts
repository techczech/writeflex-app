import { expect, test } from 'bun:test'
import { movePin, pinnedRows } from '../../src/renderer/src/vault-pins'
import type { VaultIndex, VaultWork } from '../../src/shared/vault-index'

const work = (path: string, kind: VaultWork['kind'], parts: string[] = []): VaultWork => ({ path, kind, title: path, status: null, mainPath: null, parts, sidecars: [], support: [] })
const index: VaultIndex = {
  works: [work('reports/a', 'folio', ['1', '2', '3']), work('reports/b.md', 'file'), work('reports/c.md', 'file'), work('blogs/x', 'folder-piece'), work('blogs/y.md', 'file')],
  hidden: { paths: [], countText: 'Nothing hidden' },
  labels: { 'reports/a': 'Research agent policy', 'blogs/x': 'Schemas' },
  workFolders: ['reports/a', 'blogs/x'],
}
const folders = new Set(['reports', 'reports/a', 'blogs', 'blogs/x', 'empty'])
const documents = new Set(['reports/b.md', 'reports/c.md', 'blogs/y.md', 'loose.md'])
const titled: VaultIndex = { ...index, labels: { ...index.labels, 'reports/b.md': 'The B report' } }

test('rows keep pin order; a folder counts the works under it, a Folio its parts', () => {
  const rows = pinnedRows({ pins: ['reports', 'reports/a', 'blogs', 'empty'], index, folders, titles: false })
  expect(rows.map((r) => [r.path, r.countText, r.folio, r.missing])).toEqual([
    ['reports', '3 works', false, false],
    ['reports/a', 'Folio · 3 parts', true, false],
    ['blogs', '2 works', false, false],
    ['empty', '0 works', false, false],
  ])
})

test('Titles view labels a pinned work folder by its title; File names and plain folders show the path', () => {
  const pins = ['reports/a', 'reports']
  expect(pinnedRows({ pins, index, folders, titles: true }).map((r) => r.label)).toEqual(['Research agent policy', 'reports'])
  expect(pinnedRows({ pins, index, folders, titles: false }).map((r) => r.label)).toEqual(['reports/a', 'reports'])
})

test('a pin whose folder is gone is missing, with no count; no index yet gives no counts; singular count', () => {
  const [gone] = pinnedRows({ pins: ['old/place'], index, folders, titles: true })
  expect(gone).toMatchObject({ missing: true, countText: '', label: 'old/place', folio: false })
  expect(pinnedRows({ pins: ['reports'], index: null, folders, titles: true })[0]!.countText).toBe('')
  expect(pinnedRows({ pins: ['blogs/x'], index, folders, titles: false })[0]!.countText).toBe('1 work')
  expect(pinnedRows({ pins: [], index, folders, titles: true })).toEqual([])
})

test('movePin lands the row before the target slot; no change gives null', () => {
  const pins = ['a', 'b', 'c', 'd']
  expect(movePin(pins, 'c', 1)).toEqual(['a', 'c', 'b', 'd'])
  expect(movePin(pins, 'a', 4)).toEqual(['b', 'c', 'd', 'a'])
  expect(movePin(pins, 'b', 0)).toEqual(['b', 'a', 'c', 'd'])
  expect(movePin(pins, 'b', 1)).toBeNull()
  expect(movePin(pins, 'b', 2)).toBeNull()
  expect(movePin(pins, 'z', 0)).toBeNull()
})

test('a document pin is a document row: no count, labelled by title under Titles and by file name under File names', () => {
  const pins = ['reports/b.md', 'loose.md']
  const kinds = [['reports/b.md', 'document'], ['loose.md', 'document']] as const
  const titles = pinnedRows({ pins, kinds, index: titled, folders, documents, titles: true })
  expect(titles.map((r) => [r.kind, r.label, r.countText, r.missing, r.folio])).toEqual([
    ['document', 'The B report', '', false, false],
    ['document', 'loose.md', '', false, false],
  ])
  expect(titles[0]!.tip).toEqual({ text: 'b.md', mono: true })
  expect(titles[1]!.tip).toBeNull()
  const names = pinnedRows({ pins, kinds, index: titled, folders, documents, titles: false })
  expect(names.map((r) => r.label)).toEqual(['b.md', 'loose.md'])
  expect(names[0]!.tip).toEqual({ text: 'The B report', mono: false })
  expect(names[1]!.tip).toBeNull()
})

test('folders and documents mix in one order; folder rows keep their counts and plain tooltip', () => {
  const rows = pinnedRows({ pins: ['loose.md', 'reports', 'blogs/y.md'], kinds: [['loose.md', 'document'], ['reports', 'folder'], ['blogs/y.md', 'document']], index, folders, documents, titles: false })
  expect(rows.map((r) => [r.path, r.kind, r.countText])).toEqual([
    ['loose.md', 'document', ''],
    ['reports', 'folder', '3 works'],
    ['blogs/y.md', 'document', ''],
  ])
  expect(rows[1]!.tip).toBeNull()
})

test('a document pin is missing when main says so and the tree lacks it, or when the tree no longer lists it', () => {
  const [gone, deleted] = pinnedRows({ pins: ['old.md', 'reports/c.md'], kinds: [['old.md', 'missing'], ['reports/c.md', 'document']], index, folders, documents: new Set(), titles: true })
  expect(gone).toMatchObject({ kind: 'missing', missing: true, label: 'old.md', countText: '', tip: null })
  expect(deleted).toMatchObject({ kind: 'missing', missing: true, label: 'reports/c.md' })
  // Main read the pin as missing, the tree lists it again: the tree's kind until main reads again.
  const [back] = pinnedRows({ pins: ['loose.md'], kinds: [['loose.md', 'missing']], index, folders, documents, titles: false })
  expect(back).toMatchObject({ kind: 'document', missing: false, label: 'loose.md' })
  // Main says folder but the folder is gone from the tree.
  expect(pinnedRows({ pins: ['reports'], kinds: [['reports', 'folder']], index, folders: new Set(), documents, titles: false })[0]!.missing).toBe(true)
})

test('movePin moves documents and folders alike', () => {
  expect(movePin(['reports', 'loose.md', 'blogs'], 'loose.md', 0)).toEqual(['loose.md', 'reports', 'blogs'])
  expect(movePin(['reports', 'loose.md', 'blogs'], 'reports', 3)).toEqual(['loose.md', 'blogs', 'reports'])
})

test('a pin whose target changed kind takes the kind the tree lists now, not main\'s earlier reading', () => {
  // note.md was a document when main read the vault; it is now a folder of that name (and the reverse).
  const [nowFolder] = pinnedRows({ pins: ['note.md'], kinds: [['note.md', 'document']], index, folders: new Set(['note.md']), documents: new Set(), titles: false })
  expect(nowFolder).toMatchObject({ kind: 'folder', missing: false, label: 'note.md' })
  const [nowDocument] = pinnedRows({ pins: ['reports'], kinds: [['reports', 'folder']], index, folders: new Set(), documents: new Set(['reports']), titles: false })
  expect(nowDocument).toMatchObject({ kind: 'document', missing: false, label: 'reports' })
})

test('a folder named __proto__ is read as its own entry in main\'s kinds', () => {
  const [row] = pinnedRows({ pins: ['__proto__'], kinds: [['__proto__', 'folder']], index: null, folders: new Set(['__proto__']), documents: new Set(), titles: false })
  expect(row).toMatchObject({ kind: 'folder', missing: false, label: '__proto__' })
  const [gone] = pinnedRows({ pins: ['__proto__'], kinds: [['__proto__', 'folder']], index: null, folders: new Set(), documents: new Set(), titles: false })
  expect(gone).toMatchObject({ kind: 'missing', missing: true })
})

test('every pinned row that names something offers hover Unpin (folders and documents alike); a missing row has Remove instead', () => {
  const rows = pinnedRows({ pins: ['reports', 'loose.md', 'old/place'], kinds: [['reports', 'folder'], ['loose.md', 'document'], ['old/place', 'missing']], index, folders, documents, titles: false })
  expect(rows.map((r) => [r.path, r.unpinnable])).toEqual([['reports', true], ['loose.md', true], ['old/place', false]])
  expect(rows.filter((r) => r.missing).every((r) => !r.unpinnable)).toBe(true)
})
