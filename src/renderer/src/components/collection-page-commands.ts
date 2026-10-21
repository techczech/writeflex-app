export const COLLECTION_PAGE_EVENT = 'writeflex:collection-page-command'
export { COLLECTION_PAGE_COMMANDS, type CollectionPageCommand } from '../../../shared/collection-page-commands'
import { COLLECTION_PAGE_COMMANDS, type CollectionPageCommand } from '../../../shared/collection-page-commands'
export function dispatchCollectionPageCommand(command: CollectionPageCommand): void {
  window.dispatchEvent(new CustomEvent(COLLECTION_PAGE_EVENT, { detail: command }))
}

/** Validate native action ids without widening the bridge or casting sliced strings. */
export function collectionPageMenuCommand(action: string): CollectionPageCommand | null {
  return COLLECTION_PAGE_COMMANDS.find(([name]) => action === `collection-page:${name}`)?.[0] ?? null
}

export const COLLECTION_BULK_COMMANDS = {
  'bulk-status': 'status', 'bulk-move': 'move', 'bulk-folio': 'folio', 'bulk-tag': 'tag',
} as const
