/**
 * The Folio bin as the room shows it (main/folio-bin.ts): one row per file in `<folio>/.folio-bin/`. Plain data.
 * The app never deletes a binned file: the owner empties the bin in Finder ("Show bin in Finder").
 */
export type FolioBinItem = {
  /** What Restore names: the bin index's id, or `file:<name>` for a file the index does not know. */
  id: string
  /** The file's name in the bin. Restore puts it at the Folio's top level under this name (`name 2.md` when taken). */
  name: string
  /** Workspace-relative: where it was before removal, as the bin's list says (a display hint only; null when unknown). */
  was: string | null
  /** The part's title when it was removed (the file name for a file the index does not know). */
  title: string
  /** ISO time of removal; '' when unknown. */
  removedAt: string
}

/** The toast after a removal (spec folio-workspace § 1, drawing 4A). */
export function binRemovalMessage(removed: ReadonlyArray<{ title: string }>, binned: ReadonlyArray<{ name: string }>): string {
  const what = removed.length === 1 ? `“${removed[0].title}”` : `${removed.length} parts`
  if (binned.length === 0) return `Removed ${what} from the outline`
  const files = binned.length === 1 ? `${binned[0].name} is` : `${binned.length} files are`
  return `Removed ${what} from the outline · ${files} in the Folio bin`
}
