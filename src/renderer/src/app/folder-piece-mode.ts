import type { WriteFlexApi } from '../../../preload'
import { collectionIndexNotePath } from '../../../shared/collection-index-note'
import type { DocumentOwner } from './document-owner'

type SetPieceMode = WriteFlexApi['collection']['setPieceMode']

/** Hold the canonical Index Note until main's receipt can be reconciled with the generation we flushed. */
export async function setFolderPieceModeFlushed(
  owner: Pick<DocumentOwner, 'withFlushed' | 'replaceFromMain'>,
  setMode: SetPieceMode,
  dir: string,
  folder: string,
  mode: 'one' | 'many',
) {
  const path = collectionIndexNotePath(folder)
  const flushed = await owner.withFlushed([path], async (snapshots) => {
    const snapshot = snapshots.get(path)!
    const saved = await setMode(dir, folder, mode)
    const outcome = snapshot.text === null ? null : owner.replaceFromMain(path, saved, { since: snapshot.gen, mode: 'replace' })
    return { path, outcome }
  })
  if (flushed.status !== 'acted') throw new Error('Could not save the Index Note before changing how the folder appears.')
  return flushed.result
}
