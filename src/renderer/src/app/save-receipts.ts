/**
 * The receipts the document owner issues for one open document's edits and saves (automatic-backup
 * groundwork, _TASK-LOG/2026-10-24-vault-backup-autosave.md). Edit, save start and save completion are
 * three receipts, each with its own time, so a later backup client can measure edit-to-disk age exactly.
 *
 * A document is named by `path`, `epoch` and `gen`: `epoch` is the owner's record of the path (a record
 * dropped and made again starts its gens again, under a new epoch; a move keeps it), `gen` the editor's
 * change count in that record. A save's `gen` is the one it captured in the turn it read the buffer, never
 * the gen at completion: typing during the write is newer and stays owed.
 *
 * Only `outcome: 'flushed'` says bytes reached the disk: main returned a receipt for that call and read
 * the same bytes back. Refusals, a write that threw, a readback that differs, a standing disk notice and
 * a save that found nothing to write are all other outcomes, never a flush.
 *
 * Types and a fan-out only: no IPC, no helper connection.
 */

export type EditReceipt = { path: string; epoch: number; gen: number; at: number }

/** What a save's bytes are, as the owner captured them with the read: the record's epoch and the gen. */
export type SaveIdentity = { docEpoch: number; gen: number }

/** The save read the buffer: these are the bytes it carries. */
export type SaveStartReceipt = { path: string; epoch: number; gen: number; at: number }

export type SaveOutcome =
  /** Main wrote (or found already there) the captured bytes and read them back unchanged. */
  | 'flushed'
  /** Refused before main, by a changed-on-disk notice the writer has not answered. */
  | 'refused-by-notice'
  /** Main refused it (an empty-save guard, a name taken): nothing written. */
  | 'refused-by-main'
  /** Main found another version on disk than the basis: nothing written. */
  | 'disk-changed'
  /** Main wrote, and the file read back is not what it wrote: another program's write. */
  | 'readback-mismatch'
  /** The write threw: whether it was made is not known. */
  | 'unknown'
  /** The save was not let run (a Folio running-order write moved the file). */
  | 'not-allowed'
  /** No editor (unmounted by an error): unsaved-text.ts holds the text. Nothing written. */
  | 'no-editor'
  /** The buffer is not resident and no unsaved text is held: nothing to write. */
  | 'nothing-to-write'

export type SaveCompletionReceipt = {
  path: string
  epoch: number
  /** The gen captured when the save read the buffer; absent when it never read it (refused first). */
  gen?: number
  startedAt?: number
  at: number
  outcome: SaveOutcome
  /** `flushed` only: the disk holds other bytes than the version the write was based on. */
  changed?: boolean
}

export type SaveReceiptPort = {
  edited(receipt: EditReceipt): void
  saveStarted(receipt: SaveStartReceipt): void
  saveCompleted(receipt: SaveCompletionReceipt): void
}

/** One port that hands every receipt to each of `ports` in order. A port that throws does not stop the
 *  others or the save that issued the receipt. */
export function fanOutReceipts(ports: () => readonly (SaveReceiptPort | null | undefined)[]): SaveReceiptPort {
  const each = <K extends keyof SaveReceiptPort>(kind: K, receipt: Parameters<SaveReceiptPort[K]>[0]): void => {
    for (const port of ports()) {
      if (!port) continue
      try { (port[kind] as (r: typeof receipt) => void)(receipt) } catch { /* a listener's fault is its own */ }
    }
  }
  return {
    edited: (receipt) => each('edited', receipt),
    saveStarted: (receipt) => each('saveStarted', receipt),
    saveCompleted: (receipt) => each('saveCompleted', receipt),
  }
}
