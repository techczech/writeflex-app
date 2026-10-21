/**
 * The documents a folder-scoped operation covers (docs/plans/saving-over-an-outside-change/
 * document-owner-plan.md, parcel 2b round 3): decided by path scope over everything the app has a record
 * of, never by tabs, dirty dots or registry entries alone. Tabs and dots are display.
 *
 * `prefix` is a folder prefix with its trailing slash (`essays/`), or `''` for the whole workspace.
 */
export type DocumentSources = {
  /** Every path the document owner has a record for under the prefix (open, in flight, or settled). */
  owned: Iterable<string>
  /** Paths under an unanswered changed-on-disk notice. */
  notices: Iterable<string>
  /** Paths the unsaved registry holds text or a write for. */
  registry: Iterable<string>
  /** Open document tabs (no Board tabs). */
  tabs: Iterable<string>
}

export function documentsUnder(prefix: string, sources: DocumentSources): string[] {
  const found = new Set<string>()
  for (const list of [sources.owned, sources.notices, sources.registry, sources.tabs]) {
    for (const path of list) if (path.startsWith(prefix)) found.add(path)
  }
  return [...found]
}

/** The folder prefix for a directory (`''` for the workspace root). */
export function folderPrefix(dir: string): string {
  return dir === '' ? '' : `${dir}/`
}

/**
 * The documents a single file's rename or move holds (2b round 3 review, finding 1): the file itself, every
 * document main's link repair may rewrite (`repairPaths`, the plan's targets), and every document the app
 * has a record of anywhere in the workspace (`known`, `documentsUnder('')`). A document with work in flight
 * (an accept of a closed document) has a record, so the rename waits for it, and its link, if it gained one,
 * is repaired over the accepted text; a document with typed but unsaved text is written first, so a link
 * typed into it is on disk when main plans the repair.
 */
export function renameMembers(moving: readonly string[], repairPaths: readonly string[], known: readonly string[]): string[] {
  return [...new Set([...moving, ...repairPaths, ...known])]
}
