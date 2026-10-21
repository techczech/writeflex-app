/**
 * The folder the Export sheet bundles for a piece. A piece inside a Folio (the Index Note, a part in the
 * Folio's `content_root`, a part in a subfolder) bundles THE FOLIO: the folder holding the manifest, whose
 * listed parts are what the export writes. The nearest ancestor the Collection organ recognises is only
 * the answer for a piece in no manifest Folio: a part in `report/evidence/` would otherwise name its own
 * subfolder, which lists none of the Folio's parts, so the sheet offered no whole-Folio scope and the
 * export wrote the open file alone.
 */
export type ExportDirApi = {
  /** The Folio the path belongs to (`readFolioPlace`): its folder, or null. */
  folioDirOf: (path: string) => Promise<string | null>
  /** Whether the folder declares a manifest (`readFolioPieces` is not null). */
  hasManifest: (dir: string) => Promise<boolean>
  /** The nearest ancestor Collection, else the piece's own folder (`collectionDirFor`). */
  collectionDirFor: (path: string) => Promise<string>
}

/** The folder the sheet bundles, and whether that folder is a Folio (a manifest, not just a Collection). */
export type ExportPlace = { dir: string; inFolio: boolean }

export async function exportPlaceFor(path: string, api: ExportDirApi): Promise<ExportPlace> {
  const folio = await api.folioDirOf(path).catch(() => null)
  if (folio !== null && await api.hasManifest(folio).catch(() => false)) return { dir: folio, inFolio: true }
  return { dir: await api.collectionDirFor(path), inFolio: false }
}

export async function exportCollectionDirFor(path: string, api: ExportDirApi): Promise<string> {
  return (await exportPlaceFor(path, api)).dir
}
