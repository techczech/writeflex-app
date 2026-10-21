/**
 * The folder the Folio page opens on. Main resolves the Folio (`folio:dir`, the rule and cache the Outline's
 * `folio:place` uses), so whatever is open — the Index Note, a part, a part in the Folio's `content_root`, a nested
 * part, or a sub-folder of the Folio shown as a Collection — the page reads the Folio and the Index Note the Outline
 * reads. The nearest Collection (`collectionDirFor`) is only the answer for a file in no Folio: a part in `contents/`
 * would otherwise open `contents/`, a folder with no Index Note, and the page offered to start a second one.
 */
export type PlanDirApi = {
  /** The Folio folder a folder belongs to, or null (`readFolioDir`). */
  folioDirOf: (dir: string) => Promise<string | null>
  /** The nearest ancestor Collection of a file, else its own folder. */
  collectionDirFor: (path: string) => Promise<string>
}

/** What the page is opened from: an open file, or a folder (the folder view, the Board, the last Collection). */
export type PlanDirSource = { file: string } | { folder: string }

const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

export async function planDirFor(source: PlanDirSource, api: PlanDirApi): Promise<string> {
  const start = 'file' in source ? folderOf(source.file) : source.folder
  const folio = await api.folioDirOf(start).catch(() => null)
  if (folio !== null) return folio
  return 'file' in source ? api.collectionDirFor(source.file) : source.folder
}
