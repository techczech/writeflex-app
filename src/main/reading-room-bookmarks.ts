import type { ReadingRoomDocument, SidecarStore } from '@readflex/sidecar'

export type ReadingBookmarkInput = {
  label: string
  position: Record<string, unknown>
}

export type ReadingBookmarkRow = {
  createdAt: string
  id: number
  label: string
  position: Record<string, unknown>
}

type ReadingRoomBookmarksOptions = {
  currentDocument: () => ReadingRoomDocument | null
  store: SidecarStore
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function activeDocument(currentDocument: () => ReadingRoomDocument | null): ReadingRoomDocument {
  const document = currentDocument()
  if (!document) throw new Error('There is no open document to bookmark.')
  return document
}

function bookmarkRow(row: {
  createdAt: string
  id: number
  label: string | null
  position: string
}): ReadingBookmarkRow {
  const position = JSON.parse(row.position) as unknown
  if (!isRecord(position)) {
    throw new Error('The saved bookmark position is not a view-state object.')
  }
  return {
    createdAt: row.createdAt,
    id: row.id,
    label: row.label ?? '',
    position,
  }
}

export function createReadingRoomBookmarks({
  currentDocument,
  store,
}: ReadingRoomBookmarksOptions): {
  add(input: unknown): ReadingBookmarkRow
  list(): ReadingBookmarkRow[]
  savePosition(input: unknown): boolean
} {
  return {
    savePosition(input) {
      if (!isRecord(input) || !isRecord(input.viewState)) throw new Error('Invalid Reading Room view state.')
      const document = currentDocument()
      // The previous iframe can emit a final debounced position after main has opened its replacement.
      // It owns no position in the new document; refusing that stale update is an ordinary no-op.
      if (!document || input.libraryId !== document.libraryId || input.attachmentKey !== document.attachmentKey) return false
      store.savePosition({ itemKey: document.attachmentKey, libraryId: document.libraryId, position: JSON.stringify(input.viewState) })
      return true
    },
    add(input) {
      const document = activeDocument(currentDocument)
      if (!isRecord(input) || !isRecord(input.position)) {
        throw new Error('The bookmark position must be a view-state object.')
      }
      const label = typeof input.label === 'string' ? input.label.trim() : ''
      if (!label) throw new Error('The bookmark label is required.')
      return bookmarkRow(store.addBookmark({
        itemKey: document.attachmentKey,
        label,
        libraryId: document.libraryId,
        position: JSON.stringify(input.position),
      }))
    },
    list() {
      const document = activeDocument(currentDocument)
      return store
        .listBookmarks(document.libraryId, document.attachmentKey)
        .map(bookmarkRow)
    },
  }
}
