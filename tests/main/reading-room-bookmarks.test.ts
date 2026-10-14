import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SidecarStore, type ReadingRoomDocument } from '@readflex/sidecar'
import { createBunSqliteDriver } from '@readflex/sqlite-driver/bun'
import { createReadingRoomBookmarks } from '../../src/main/reading-room-bookmarks'

const directories: string[] = []

function sidecar(): SidecarStore {
  const directory = mkdtempSync(join(tmpdir(), 'wf-reading-bookmarks-'))
  directories.push(directory)
  return new SidecarStore(createBunSqliteDriver(), join(directory, 'sidecar.sqlite'))
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const document: ReadingRoomDocument = {
  attachmentKey: 'ATTACHMENT1',
  authorYear: 'Lakoff · 1987',
  itemKey: 'PARENT1',
  kind: 'pdf',
  libraryId: 1,
  path: '/tmp/one.pdf',
  shortTitle: 'Women, Fire…',
}

test('requires an active document before adding or listing bookmarks', () => {
  const store = sidecar()
  const bookmarks = createReadingRoomBookmarks({ currentDocument: () => null, store })

  expect(() => bookmarks.add({ label: 'Page 91', position: { pageIndex: 90 } })).toThrow(
    'There is no open document to bookmark.',
  )
  expect(() => bookmarks.list()).toThrow('There is no open document to bookmark.')
  store.close()
})

test('persists view state in creation order and scopes rows to the active attachment', () => {
  const store = sidecar()
  let activeDocument: ReadingRoomDocument | null = document
  const bookmarks = createReadingRoomBookmarks({ currentDocument: () => activeDocument, store })

  expect(bookmarks.add({ label: 'Page 91', position: { pageIndex: 90, scale: 1.25 } })).toMatchObject({
    label: 'Page 91',
    position: { pageIndex: 90, scale: 1.25 },
  })
  expect(bookmarks.add({ label: 'Key chart', position: { pageIndex: 92 } })).toMatchObject({
    label: 'Key chart',
    position: { pageIndex: 92 },
  })

  activeDocument = { ...document, attachmentKey: 'ATTACHMENT2', path: '/tmp/two.pdf' }
  expect(bookmarks.add({ label: 'Page 4', position: { pageIndex: 3 } })).toMatchObject({
    label: 'Page 4',
    position: { pageIndex: 3 },
  })
  expect(bookmarks.list().map((row) => row.label)).toEqual(['Page 4'])

  activeDocument = document
  expect(bookmarks.list().map((row) => row.label)).toEqual(['Page 91', 'Key chart'])
  expect(store.listBookmarks(1, 'ATTACHMENT1').map((row) => JSON.parse(row.position))).toEqual([
    { pageIndex: 90, scale: 1.25 },
    { pageIndex: 92 },
  ])
  store.close()
})

test('rejects invalid bookmark position and label values at the boundary', () => {
  const store = sidecar()
  const bookmarks = createReadingRoomBookmarks({ currentDocument: () => document, store })

  expect(() => bookmarks.add({ label: 'Page 1', position: [] })).toThrow(
    'The bookmark position must be a view-state object.',
  )
  expect(() => bookmarks.add({ label: '  ', position: { pageIndex: 0 } })).toThrow(
    'The bookmark label is required.',
  )
  store.close()
})
