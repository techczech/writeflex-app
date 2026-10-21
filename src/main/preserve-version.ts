/**
 * Keep one exact version of a document before something replaces it (Merge on the changed-on-disk banner,
 * review round 1 findings 1 and 2). The caller names the text it means, not "whatever is on disk now",
 * and gets back a receipt only when History (the Collection's snapshot store) holds a copy whose sha256
 * equals that text's bytes:
 *
 * - The file is snapshotted and the entry's hash must equal the expected hash. A different hash means the
 *   disk no longer holds the text the caller meant (another program wrote it meanwhile): the answer is
 *   `mismatch`, and the caller writes nothing over it.
 * - No History in this window (no agent: a Workspace still waiting for a model choice, or one whose agent
 *   failed to start), or a snapshot that failed or was not made: `unavailable`. Nothing is kept anywhere
 *   else and nothing is written, so the caller writes nothing (review round 3: a copy outside History
 *   would be a new write path that Node cannot guard against another process moving folders meanwhile).
 *
 * The text is compared as UTF-8 bytes. A file that is not valid UTF-8 never matches, which refuses the
 * write rather than keeping something else.
 */
import { createHash } from 'node:crypto'
import type { PreserveReceipt, PreserveResult } from '../shared/preserve-receipt'

export type { PreserveReceipt, PreserveResult }

/** A snapshot of the file as it is on disk now; null when the store made none (the path is refused, the
 *  Collection's writes are paused). A rejection means none was made either. */
export type HistorySnapshot = () => Promise<{ id: string; hash: string } | null>

export const sha256Of = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Keep `text`, the version of the file the caller means, in History. See the module comment. */
export async function preserveVersion(input: { text: string; history: HistorySnapshot | null }): Promise<PreserveResult> {
  if (!input.history) return { kept: false, refused: 'unavailable' }
  const expected = sha256Of(Buffer.from(input.text, 'utf8'))
  let entry: { id: string; hash: string } | null = null
  try { entry = await input.history() } catch { entry = null }
  if (!entry) return { kept: false, refused: 'unavailable' }
  if (entry.hash !== expected) return { kept: false, refused: 'mismatch' }
  return { kept: true, receipt: { store: 'history', entryId: entry.id, sha256: entry.hash } }
}
