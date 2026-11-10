/**
 * Mark a Folio version as sent to someone (ADR-0052 § The eight changes 1; Folio versions ticket 11): one delta mark in the Folio
 * version journal, through the store's own `mark` (the checked append under the Collection write gate). The version must be one of
 * the Folio's own (another Folio's id is never answered), and the name goes through the one rule (shared/folio-version-export.ts).
 * Electron-free.
 */
import { findFolioVersion, type VersionReaderSources } from './folio-version-reader'
import type { FolioVersionStore, ListedFolioVersion } from './folio-versions'
import { normaliseSentTo } from '../shared/folio-version-export'

export class FolioMarkRefused extends Error {
  override readonly name = 'FolioMarkRefused'
}

/** Mark version `id` of the Folio at `dir` as sent to `to`. Refuses, writing nothing, when the version is not this Folio's or the name cannot be kept. */
export async function markFolioVersionSent(
  sources: Pick<VersionReaderSources, 'workspace' | 'folioVersions'>,
  store: Pick<FolioVersionStore, 'mark'>,
  dir: string,
  id: string,
  to: string,
): Promise<ListedFolioVersion> {
  let name: string
  try { name = normaliseSentTo(to) } catch (error) { throw new FolioMarkRefused(error instanceof Error ? error.message : String(error)) }
  if (!(await findFolioVersion(sources, dir, id))) throw new FolioMarkRefused('That Folio version is not in this Folio, so nothing was marked.')
  return store.mark(id, { sentTo: name })
}
