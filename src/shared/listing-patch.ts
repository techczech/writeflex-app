/**
 * What `collection:changed` carries, and the one change the renderer may apply to its listing without
 * re-pulling it (0.24.1, R4).
 *
 * An autosave fires after every typing pause. It used to re-list the whole folder (two recursive walks
 * and a new array of every file) only to learn the saved file's new mtime and size. Now, when the
 * editor saved a document IN PLACE, main sends that file's fresh listing entry with the event, and the
 * renderer swaps that one entry: a new array whose other entries are the same objects, so consumers
 * memoised on entries see only the change. Any other change — an agent write, a create, a rename, a
 * delete, an outside edit, a folder change, a save of a path the listing does not hold — carries no
 * entry, or one that does not patch, and the renderer re-lists as before.
 */

/** One row of the workspace listing (the preload `MarkdownFile`). */
export type ListingEntry = { path: string; name: string; directory: string; modifiedAt: number; size: number }

/** The `collection:changed` payload: `null` for every change except an own save in place. */
export type CollectionChanged = { ownSave: ListingEntry }

/** Exactly the five listing fields of `file` (a save result may carry more). */
export function listingEntryOf(file: ListingEntry): ListingEntry {
  return { path: file.path, name: file.name, directory: file.directory, modifiedAt: file.modifiedAt, size: file.size }
}

function isListingEntry(value: unknown): value is ListingEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.path === 'string' && typeof entry.name === 'string' && typeof entry.directory === 'string'
    && typeof entry.modifiedAt === 'number' && typeof entry.size === 'number'
}

/**
 * The listing with the own-saved entry swapped in, or `null` when this change needs a full re-list:
 * no own save, a malformed entry, or a path (with its name and folder) the listing does not hold.
 * The swapped entry is always a new object, even when its fields are unchanged, so a consumer keyed on
 * entries re-asks about that file (its content changed whatever its stat says).
 */
export function patchedListing<T extends ListingEntry>(files: readonly T[], change: unknown): Array<T | ListingEntry> | null {
  const saved = change && typeof change === 'object' ? (change as { ownSave?: unknown }).ownSave : undefined
  if (!isListingEntry(saved)) return null
  const at = files.findIndex((file) => file.path === saved.path)
  if (at === -1) return null
  const known = files[at]
  if (known.name !== saved.name || known.directory !== saved.directory) return null
  const next: Array<T | ListingEntry> = files.slice()
  next[at] = listingEntryOf(saved)
  return next
}

/**
 * The paths whose entries changed between two listings that hold the same paths in the same order,
 * or `null` when the change is not a patch (a file added, removed or moved, no entry changed, or every
 * entry did), in which case a consumer must re-ask about everything. Entries are compared by
 * identity: a full re-list makes every entry new, so it reads as "everything changed" and falls back.
 */
export function changedEntryPaths(before: readonly ListingEntry[], after: readonly ListingEntry[]): string[] | null {
  if (before.length !== after.length) return null
  const changed: string[] = []
  for (let i = 0; i < after.length; i += 1) {
    if (before[i] === after[i]) continue
    if (before[i].path !== after[i].path) return null
    changed.push(after[i].path)
  }
  // Nothing changed (a new array of the same entries: ask again to be safe), or every entry did (a
  // re-list): not a patch.
  if (changed.length === 0 || changed.length === after.length) return null
  return changed
}
