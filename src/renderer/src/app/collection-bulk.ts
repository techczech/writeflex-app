import type { CollectionRow } from '../../../preload'
import type { FolioRunningOrder } from './folio-running-order'
import { plainErrorForScreen } from '../error-text'

export type CollectionBatchResult = { message: string; succeeded: string[]; failed: string[] }

/** Run every selected document and report bounded, named failures in plain language. */
export async function runCollectionBatch(paths: readonly string[], change: (path: string) => Promise<unknown>): Promise<CollectionBatchResult> {
  const succeeded: string[] = []
  const failed: string[] = []
  const failures: string[] = []
  for (const path of paths) {
    try { await change(path); succeeded.push(path) }
    catch (error) {
      failed.push(path)
      const name = path.split('/').at(-1) ?? path
      const raw = plainErrorForScreen(error, 'Could not save this document.')
      const reason = /\b(EACCES|EPERM)\b/.test(raw) ? 'Permission to change this document was denied.'
        : /\bENOENT\b/.test(raw) ? 'The document or destination folder no longer exists.'
          : /\bEEXIST\b/.test(raw) ? 'A document with that name already exists.'
            : raw.replace(/\.?$/, '.')
      failures.push(`${name} was not changed: ${reason}`)
    }
  }
  const more = failures.length > 3 ? ` and ${failures.length - 3} more.` : ''
  return { succeeded, failed, message: `Changed ${succeeded.length} of ${paths.length}.${failures.length ? ` ${failures.slice(0, 3).join(' ')}${more}` : ''}` }
}

/** Keep Folio's existing Undo writer authoritative, including its refusal result. */
export async function addCollectionBatchToFolio(
  runningOrder: Pick<FolioRunningOrder, 'addPieces'>,
  dir: string,
  existingPaths: readonly string[],
  paths: string[],
  rows: readonly Pick<CollectionRow, 'path' | 'title' | 'name'>[],
): Promise<CollectionBatchResult> {
  const titles = new Map(rows.map(row => [row.path, row.title || row.name]))
  const piece = (path: string) => ({ path, title: titles.get(path) || path.split('/').at(-1)! })
  const added = await runningOrder.addPieces({ dir, pieces: existingPaths.map(piece) }, paths.map(piece))
  if (!added) throw new Error('The documents were not added to the Folio. Resolve the reported problem and try again.')
  return { succeeded: paths, failed: [], message: '' }
}
