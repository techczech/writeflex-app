/** Author-open linking, also used by the title-write command before changing a chapter's title. */
import { readFileSync } from 'node:fs'
import { prepareFolioIdentityLinks, type PlanWriteOptions } from './plan'
import { recordAdd, type FolioDocuments } from './folio-add-undo'
import { withPlanLock } from './plan-lock'
import { SavedButNotReadBack, type Workspace } from './workspace'

export async function openFolioFileIdentity(ws: Workspace, dir: string, options: PlanWriteOptions = {}): Promise<{ changed: boolean; indexPath?: string; undoToken?: string }> {
  return withPlanLock(ws, dir, () => linkFolioFilesInWriteTurn(ws, dir, options))
}

/** Caller holds the workspace write turn; do not acquire a Folio lock from inside that turn. */
export async function linkFolioFilesInWriteTurn(ws: Workspace, dir: string, options: PlanWriteOptions = {}, onlyPath?: string): Promise<{ changed: boolean; indexPath?: string; undoToken?: string }> {
  const prepared = await prepareFolioIdentityLinks(ws, dir, onlyPath)
  if (!prepared) return { changed: false }
  const { indexPath, manifestPath, source, manifestSource, next } = prepared
  const current = (path: string): string | null => {
    try { return readFileSync(ws.absolute(path), 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  const holds = () => {
    if (current(indexPath) !== source || current(manifestPath) !== manifestSource) throw new Error('The Folio changed while opening. Its links were not changed.')
  }
  holds()
  await options.beforeIndexWrite?.(indexPath)
  holds()
  try { await ws.saveFileOverRead(indexPath, next, source) } catch (error) { if (!(error instanceof SavedButNotReadBack)) throw error }
  const documents = (text: string): FolioDocuments => ({ indexPath, manifestPath, texts: new Map([[indexPath, text], [manifestPath, manifestSource]]) })
  options.onCommit?.({ index: { path: indexPath, before: source, after: next }, manifest: { path: manifestPath, before: manifestSource, after: manifestSource } })
  const undoToken = recordAdd(ws, dir, documents(source), documents(next))
  return { changed: true, indexPath, ...(undoToken ? { undoToken } : {}) }
}
