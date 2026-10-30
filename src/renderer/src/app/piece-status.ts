import type { FileReadResult } from '../../../preload'
import type { DocumentOwner } from './document-owner'

/** The answer when the owner could not flush the piece's buffer first (spec-folio-room-data-model D-STA-1). */
export const PIECE_STATUS_NOT_SAVED = 'Could not save this document. Try again.'

/** Main's status route (`collection:set-status`), as the preload exposes it. */
export type SetStatusRoute = (dir: string, path: string, status: string) => Promise<FileReadResult>

/**
 * Change one piece's `status:` the one safe way, for every caller (the Board, the Collection's bulk action, the
 * Folio room): any unsaved text of the piece is written first (`owner.withFlushed`), main's status route then
 * writes over exactly that version (it refuses when the file changed under it), and the editor takes main's
 * text only if nothing was typed since the snapshot (`replaceFromMain`, `replace`), so no keystroke is lost.
 * Throws when the buffer could not be written first or main refused; nothing was written then.
 */
export async function setPieceStatusFlushed(
  owner: Pick<DocumentOwner, 'withFlushed' | 'replaceFromMain'>,
  setStatus: SetStatusRoute,
  dir: string,
  path: string,
  status: string,
): Promise<FileReadResult> {
  const result = await owner.withFlushed([path], async (snapshots) => {
    const snapshot = snapshots.get(path)!
    const saved = await setStatus(dir, path, status)
    owner.replaceFromMain(path, saved, { since: snapshot.gen, mode: 'replace' })
    return saved
  })
  if (result.status !== 'acted') throw new Error(PIECE_STATUS_NOT_SAVED)
  return result.result
}
