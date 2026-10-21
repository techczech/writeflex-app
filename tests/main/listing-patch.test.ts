import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { changedEntryPaths, listingEntryOf, patchedListing, type ListingEntry } from '../../src/shared/listing-patch'
import { mergeChecklistProgress } from '../../src/renderer/src/hooks/useChecklistProgress'

// 0.24.1 R4: a save does not re-list the folder. The workspace view is one walk; an own save in place
// patches its one listing entry; checklist chips re-ask about the patched paths only.

let root: string
let ws: Workspace

const write = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-listing-patch-'))
  ws = new Workspace(root)
  await write('b.md', '# B\n')
  await write('A.md', '# A\n')
  await write('notes/todo.md', '- [ ] one\n- [x] two\n')
  await write('notes/deep/inner/z.markdown', 'z\n')
  await write('notes/deep/plain.txt', 'not markdown\n')
  await write('Zed/x.mdx', 'x\n')
  await write('.hidden/secret.md', 'hidden\n')
  await write('notes/.cache/c.md', 'hidden too\n')
  await write('node_modules/pkg/readme.md', 'ignored\n')
  await write('.draft.md', 'a dot-named file in a shown folder is listed\n')
  await mkdir(join(root, 'empty/child'), { recursive: true })
  await mkdir(join(root, 'real'), { recursive: true })
  await write('real/r.md', 'r\n')
  await symlink(join(root, 'real'), join(root, 'linked'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

test('listFilesAndFolders is listFiles and listFolders from one walk: same entries, same order', async () => {
  const both = await ws.listFilesAndFolders()
  expect(both.files).toEqual(await ws.listFiles())
  expect(both.folders).toEqual(await ws.listFolders())
  expect(both.folders).toEqual(['empty', 'empty/child', 'notes', 'notes/deep', 'notes/deep/inner', 'real', 'Zed'].sort((a, b) => a.localeCompare(b)))
  expect(both.files.map((file) => file.path)).not.toContain('linked/r.md')
})

const entry = (path: string, modifiedAt = 1, size = 10): ListingEntry => ({
  path, name: path.split('/').at(-1)!, directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', modifiedAt, size,
})
const listing = [entry('a.md'), entry('notes/b.md'), entry('notes/c.md')]

test('an own save of a known path patches that one entry and keeps every other entry object', () => {
  const saved = entry('notes/b.md', 99, 42)
  const next = patchedListing(listing, { ownSave: saved })!
  expect(next).not.toBe(listing)
  expect(next[1]).toEqual(saved)
  expect(next[1]).not.toBe(saved)
  expect(next[0]).toBe(listing[0])
  expect(next[2]).toBe(listing[2])
  expect(listing[1].modifiedAt).toBe(1) // the old listing is not touched
  // Unchanged stat still swaps in a new entry, so chips keyed on entries re-ask about the file.
  expect(patchedListing(listing, { ownSave: entry('a.md') })![0]).not.toBe(listing[0])
})

test('anything that is not an own save of a known path asks for a full re-list', () => {
  expect(patchedListing(listing, null)).toBeNull() // agent writes, creates, deletes, outside edits, folder changes
  expect(patchedListing(listing, undefined)).toBeNull()
  expect(patchedListing(listing, {})).toBeNull()
  expect(patchedListing(listing, { ownSave: entry('new.md') })).toBeNull() // a new path
  expect(patchedListing(listing, { ownSave: entry('notes/renamed.md') })).toBeNull() // a renamed path
  expect(patchedListing([listing[0], listing[2]], { ownSave: entry('notes/b.md') })).toBeNull() // deleted from the listing
  expect(patchedListing(listing, { ownSave: { ...entry('notes/b.md'), directory: 'elsewhere' } })).toBeNull()
  expect(patchedListing(listing, { ownSave: { path: 'a.md', name: 'a.md', directory: '', modifiedAt: '1', size: 1 } })).toBeNull()
})

test('listingEntryOf keeps exactly the five listing fields', () => {
  expect(listingEntryOf({ ...entry('a.md'), content: 'x' } as ListingEntry)).toEqual(entry('a.md'))
})

test('changedEntryPaths names the patched entries, and nothing for a re-list or a changed shape', () => {
  const patched = patchedListing(listing, { ownSave: entry('notes/c.md', 5, 5) }) as ListingEntry[]
  expect(changedEntryPaths(listing, patched)).toEqual(['notes/c.md'])
  expect(changedEntryPaths(listing, listing.map((file) => ({ ...file })))).toBeNull() // a re-list: every entry new
  expect(changedEntryPaths(listing, listing.slice(0, 2))).toBeNull() // removed
  expect(changedEntryPaths(listing, [...listing, entry('z.md')])).toBeNull() // added
  expect(changedEntryPaths(listing, [listing[0], entry('notes/moved.md'), listing[2]])).toBeNull() // renamed in place
  expect(changedEntryPaths(listing, listing.slice())).toBeNull() // nothing changed: ask again in full
})

test('checklist progress for named paths matches the full answer for them, without walking the tree', async () => {
  await write('notes/second.md', '- [x] a\n- [x] b\n')
  const full = await ws.checklistProgress()
  let walks = 0
  const listFiles = ws.listFiles.bind(ws)
  ws.listFiles = async () => { walks += 1; return listFiles() }
  const some = await ws.checklistProgress(['notes/todo.md', 'notes/second.md', 'A.md', 'gone.md', '.hidden/secret.md', 'notes/deep/plain.txt'])
  expect(walks).toBe(0)
  expect(some.sort((a, b) => a.path.localeCompare(b.path))).toEqual(full.filter((row) => row.path.startsWith('notes/')).sort((a, b) => a.path.localeCompare(b.path)))

  // A saved tick reaches the chip through the one-path ask, as it would through the full one.
  await write('notes/todo.md', '- [x] one\n- [x] two\n- [ ] three\n')
  const later = new Date(Date.now() + 5_000)
  await utimes(join(root, 'notes/todo.md'), later, later)
  expect(await ws.checklistProgress(['notes/todo.md'])).toEqual([{ path: 'notes/todo.md', done: 2, total: 3 }])
  expect(walks).toBe(0)
  ws.listFiles = listFiles
  expect((await ws.checklistProgress()).find((row) => row.path === 'notes/todo.md')).toEqual({ path: 'notes/todo.md', done: 2, total: 3 })
})

test('a partial checklist answer replaces exactly the asked paths', () => {
  const shown = new Map([['a.md', { done: 1, total: 2 }], ['b.md', { done: 0, total: 1 }]])
  const next = mergeChecklistProgress(shown, ['a.md', 'c.md'], [{ path: 'c.md', done: 3, total: 3 }])
  expect([...next.entries()]).toEqual([['b.md', { done: 0, total: 1 }], ['c.md', { done: 3, total: 3 }]])
  expect(shown.size).toBe(2)
})
