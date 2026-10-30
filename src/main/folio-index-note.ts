/**
 * Creating a folder's Index Note, as far as a Folio is concerned. A Folio has one Index Note, in its own folder
 * (`indexNotePath`); the Folio is the one `folio-place.ts` resolves, read fresh from disk here because these
 * checks guard a write.
 *
 * `indexNoteCreationRefusal`: every creation of an Index Note file is refused for a folder inside another Folio (a
 * part's folder, `content_root`), whose Index Note would be a second one, and for a folder whose Index Note path is
 * already taken (by a file, a link or anything else). It is applied by the creation itself, never by a caller:
 * collection.ts `createIndexNote` (the Folio page's Start, `collection:create-index`, an agent's running-order
 * proposal, a counted diary, a Folder Piece's mode) and plan.ts `commitPlanDocuments` (a Folio page edit on a Folio
 * with no Index Note yet, which writes the Index Note and the edit in one write). Main refuses; the renderer only
 * stops offering it.
 */

import { lstatSync } from 'node:fs'
import { posix } from 'node:path'
import { indexNotePath } from './folio'
import { assertNoRelatedFolio } from './folio-declaration'
import type { Workspace } from './workspace'

export const INDEX_NOTE_EXISTS = (file: string): string => `This folder already has its Index Note, ${file}. Nothing was created.`

/** Whether anything at all stands at the workspace path (a file, a folder, a link, even a broken one). */
export function pathIsTaken(ws: Workspace, path: string): boolean {
  try {
    lstatSync(ws.absolute(path))
    return true
  } catch (error) {
    // Only "nothing there" is free: a path that cannot be looked at (or that the workspace refuses) is never treated as free.
    return (error as NodeJS.ErrnoException | null)?.code !== 'ENOENT'
  }
}

/** Why the folder's Index Note must not be created now, in a sentence; null when it may be. */
export async function indexNoteCreationRefusal(ws: Workspace, dir: string): Promise<string | null> {
  const path = indexNotePath(ws, dir)
  if (pathIsTaken(ws, path)) return INDEX_NOTE_EXISTS(posix.basename(path))
  try { await assertNoRelatedFolio(ws, dir) }
  catch (error) { return error instanceof Error ? error.message : String(error) }
  return null
}
