/**
 * The read side of Folio versions (Folio versions ticket 03): the versions of one Folio, newest first,
 * and which of them a backup leaves out. Writes nothing.
 *
 * THE LEFT-OUT LIST. A Folio version whose files have since moved out of ordinary backup scope (a part
 * put in the bin) is left out of the backup entirely, with a plain reason (ADR-0052 amendment, ticket
 * 02). The list is the backup projection's own answer (`readHistoryProjection`, which this calls in
 * the main process; the engine's preview does not carry it), so the backup status and the Versions tab
 * say exactly what the backup will do. It is restricted to this Folio's versions. When the projection
 * cannot be read (a damaged history file, a limit passed) that is said as `unavailable` with its
 * reason, never as an empty list.
 *
 * Electron-free.
 */
import { realpath } from 'node:fs/promises'
import { readHistoryProjection, type FolioLeftOut } from '../backup-helper/history-projection'
import { WRITEFLEX_SCOPE } from '../shared/backup-scope'
import { indexNotePath } from './folio'
import { folioDeclaration } from './folio-declaration'
import type { FolioVersionStore, ListedFolioVersion } from './folio-versions'
import type { Workspace } from './workspace'

/** How long the backup projection may take to be read for a list. */
export const FOLIO_LEFT_OUT_BUDGET_MS = 20_000

export type FolioBackupState = { state: 'ok'; leftOut: FolioLeftOut[] } | { state: 'unavailable'; reason: string }

export type FolioVersionListing = {
  /** The Folio's folder ('' is the Collection root) and its Index Note, whose history is the Folio's identity. */
  dir: string
  indexPath: string
  /** Newest first, the latest mark applied. */
  versions: ListedFolioVersion[]
  /** Which of these versions a backup leaves out, and why. */
  backup: FolioBackupState
}

/** Every Folio version the backup would leave out, from the projection itself. */
export async function folioBackupLeftOut(root: string, isDocument?: (path: string) => boolean, signal?: AbortSignal, isInsertedFile?: (path: string) => boolean): Promise<FolioBackupState> {
  try {
    const scope = isDocument ?? (await import('@app-patterns/vault-sync/helper/host')).ordinaryScopeTest(WRITEFLEX_SCOPE)
    const inserted = isInsertedFile ?? (await import('../backup-helper/inserted-scope')).insertedFileScopeTest(WRITEFLEX_SCOPE)
    const result = await readHistoryProjection(await realpath(root), scope, undefined, signal ?? AbortSignal.timeout(FOLIO_LEFT_OUT_BUDGET_MS), undefined, inserted)
    if (result.state === 'unavailable') return { state: 'unavailable', reason: result.reason }
    return { state: 'ok', leftOut: result.folioLeftOut ?? [] }
  } catch (error) {
    return { state: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The Folio versions of the Folio at `dir`, with the backup's left-out list for them. Throws a sentence when `dir` is not a Folio. */
export async function listFolioVersions(workspace: Workspace, store: Pick<FolioVersionStore, 'list'>, dir: string, opts: { isDocument?: (path: string) => boolean; signal?: AbortSignal } = {}): Promise<FolioVersionListing> {
  if (!folioDeclaration(workspace, dir).isFolio) throw new Error(`${dir === '' ? 'The Collection folder' : dir} is not a Folio.`)
  const indexPath = indexNotePath(workspace, dir)
  const versions = await store.list(indexPath)
  if (versions.length === 0) return { dir, indexPath, versions, backup: { state: 'ok', leftOut: [] } }
  const backup = await folioBackupLeftOut(workspace.root, opts.isDocument, opts.signal)
  const mine = new Set(versions.map((version) => version.id))
  return { dir, indexPath, versions, backup: backup.state === 'ok' ? { state: 'ok', leftOut: backup.leftOut.filter((entry) => mine.has(entry.id)) } : backup }
}
