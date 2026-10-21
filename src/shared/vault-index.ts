/**
 * The vault index the renderer receives (ticket 0.25-02): which files of a vault are works, what each
 * is called, and what the sidebar's Writing only filter hides. Computed in main (src/main/vault-works.ts),
 * read through `window.writeflex.getVaultIndex()` and refreshed by `onVaultIndexChanged`. Node-free so
 * the sidebar, Titles view and dashboard tickets share one shape.
 *
 * Every path is root-relative POSIX, no leading `./`, no trailing `/`.
 */

/** `folio`: a folder with a Folio manifest. `folder-piece`: a folder that is one work (ADR-0033, or
 *  numbered parts). `file`: a single Markdown file. */
export type VaultWorkKind = 'folio' | 'folder-piece' | 'file'

export type VaultWork = {
  /** The work's own path: the folder for a Folio or folder piece, the file for a single-file work. */
  path: string
  kind: VaultWorkKind
  /** ADR-0034: first heading of any level of the main document, else the file or folder name. */
  title: string
  /** Frontmatter `status` exactly as found (Folio: main document, else the manifest's `status`); null when none. */
  status: string | null
  /** The document the title and status come from; null when a folder work has none (title = folder name). */
  mainPath: string | null
  /** Folio: manifest parts in manifest order. Folder piece: its direct-child content files in part order. */
  parts: string[]
  /** Same-stem files (`x.review.md`, `x.*.md`) and files inside `x.editing/`-style sidecar folders. */
  sidecars: string[]
  /** Everything else that rolls into the work: support folders, nested folders, loose files. */
  support: string[]
}

export type VaultHidden = {
  /** Top-most hidden entries only: a hidden folder's children are not listed. Sorted. */
  paths: string[]
  /** The sidebar's count line: `3 folders and 2 files hidden`, `1 folder hidden`, `4 files hidden`. */
  countText: string
}

export type VaultIndex = {
  works: VaultWork[]
  hidden: VaultHidden
  /** Titles view: work path → title for every work. */
  labels: Record<string, string>
  /** Folders that are works (Folio or folder piece): one non-expanding row in the Titles view. */
  workFolders: string[]
}

/** The count line for a number of top-most hidden folders and files. */
export function hiddenCountText(folders: number, files: number): string {
  const folderText = `${folders} ${folders === 1 ? 'folder' : 'folders'}`
  const fileText = `${files} ${files === 1 ? 'file' : 'files'}`
  if (folders > 0 && files > 0) return `${folderText} and ${fileText} hidden`
  if (folders > 0) return `${folderText} hidden`
  if (files > 0) return `${fileText} hidden`
  return 'Nothing hidden'
}
