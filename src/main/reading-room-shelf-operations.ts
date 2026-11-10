import type { IpcMainInvokeEvent } from 'electron'
import type { SidecarStore, ReadingRoomDocument, RecentDocument } from '@readflex/sidecar'
import { collectionNodes, type ShelfCollectionNode } from '../shared/shelf-collections'
import { shelfPage, shelfRow, readingRoomDocumentFor, type ShelfSearchResult } from './reading-room-shelf'
import { itemSelectLink, type LibrarySegments } from './zotero-links'
import { isRecord, type createShelfLoader } from './reading-room-inputs'
import type { ReadingRoomContexts } from './reading-room-context'
import type { ReadingRoomState } from './reading-room'

type ShelfOperations = {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any): void
  store: SidecarStore
  shelf: ReturnType<typeof createShelfLoader>
  contexts: ReadingRoomContexts
  draftPathFrom(value: unknown): string | null
  rememberDocument(document: ReadingRoomDocument): void
  readingRoomState(segments?: LibrarySegments): Promise<ReadingRoomState>
}
export function registerReaderShelfOperations({ handle, store, shelf, contexts, draftPathFrom, rememberDocument, readingRoomState }: ShelfOperations): void {
  /** Papers opened recently, newest first — global and persistent (ReadFlex ADR-0032, decision 3). */
  handle('reading-room:recent-documents', (): RecentDocument[] =>
    store.listRecentDocuments(12))

  /** The collection tree for the Shelf's filter: ids, names, parents, subtree item counts. Read-only. */
  handle('reading-room:shelf-collections', async (): Promise<ShelfCollectionNode[]> => {
    // Raised alongside the empty-query search: same staleness check, so tree, counts and the
    // remembered-choice fallback agree with the index the search will use.
    // The tree is library data, not per-draft data. The Shelf asks for it on mount, before the Room's
    // get-state binds the draft, so a selection-epoch check here failed on every first raise and the
    // picker silently never appeared. Only the owner must still be live.
    const ownerLive = contexts.admitCompletion()
    shelf.refresh()
    const state = await shelf.load()
    ownerLive()
    return collectionNodes(state.items, state.collections)
  })

  handle('reading-room:search-shelf', async (
    _event,
    rawQuery: unknown,
    rawCollection?: unknown,
  ): Promise<ShelfSearchResult> => {
    const query = typeof rawQuery === 'string' ? rawQuery : ''
    const trimmed = query.trim()
    // The Shelf is always raised on an empty query, so this is where a library changed in Zotero
    // since the index was built gets picked up — never mid-typing.
    if (!trimmed) shelf.refresh()
    const state = await shelf.load()
    contexts.checkIfBound()
    const found = state.index ? (trimmed ? state.index.search(trimmed) : state.items) : []
    // The collection filter runs on the whole match set BEFORE the row limit, so a collection of
    // hundreds of items is searchable within. An id that is not a known collection is ignored.
    const page = shelfPage(found, state.collections, rawCollection)
    return {
      diagnostics: state.index?.diagnostics.map((entry) => entry.message) ?? [],
      error: state.error,
      matched: page.matched,
      query,
      rows: page.items
        .map((item) => shelfRow(item, itemSelectLink(state.librarySegments, item.libraryId, item.itemKey))),
      total: state.items.length,
      zoteroDataDirectory: state.index?.zoteroDataDirectory.path ?? '',
    }
  })

  handle('reading-room:open-shelf-item', async (_event, input: unknown): Promise<ReadingRoomState> => {
    if (!isRecord(input) || typeof input.itemKey !== 'string' || typeof input.libraryId !== 'number') {
      throw new Error('Invalid Shelf selection.')
    }
    const attachmentKey = typeof input.attachmentKey === 'string' ? input.attachmentKey : null
    // The draft this open belongs to travels WITH the open, so the paper cannot land against a draft
    // the renderer has meanwhile left. A recents row is opened through this same handler — it carries
    // only keys, which is why a reindexed, retitled or moved paper still resolves.
    contexts.select(draftPathFrom(input.draftPath), true)
    const state = await shelf.load()
    contexts.checkIfBound()
    contexts.check()
    if (state.error) throw new Error(state.error)
    const item = state.byKey.get(`${input.libraryId}:${input.itemKey}`)
    if (!item) throw new Error('That item is no longer in the Shelf. Search again.')
    rememberDocument(readingRoomDocumentFor(item, attachmentKey))
    return await readingRoomState(state.librarySegments)
  })

}
