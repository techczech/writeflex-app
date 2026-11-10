/**
 * The one place the Workspace asks whether it may write a document non-atomically (editor receipts,
 * locked plan §10). Today the only such write is the exclusive create's copy fallback on a disk without
 * hard links (workspace.ts `#writeAtomic`): the destination is visible while it is copied, so the backup
 * helper could capture partial bytes.
 *
 * - With a save receipt (`SaveFileOptions.receipt`, main-only, from file:save): the receipt decides. It
 *   copies only with an exact durable write start for this save; otherwise it stores the complete bytes
 *   durably off the vault and the save refuses with HeldForBackup, so the editor keeps its buffer unsaved.
 * - Without one: `nonAtomicWritePolicy(root)`. Default `copy` (the behaviour before receipts). Main sets a
 *   policy that answers `refuse` for a folder enrolled with the backup helper; such a write then fails with
 *   NonAtomicWriteRefused and nothing is copied. Ordinary atomic replacement is never asked about.
 *
 * Neither error carries a sentence meant for the writer: the locked plan reuses an existing refusal
 * sentence or stops, and none fits (disposition-writeflex-editor-receipts-main-a1.md). Both reach the
 * renderer as a failed save, whose existing handling keeps the text unsaved.
 */

/** Thrown by the hold route: the bytes are kept durably off the vault; nothing was written there. */
export class HeldForBackup extends Error {
  override readonly name = 'HeldForBackup'
  constructor(readonly path: string) {
    super(`${path}: the new file was not created; its text is kept by WriteFlex and the editor keeps it unsaved.`)
  }
}

/** Thrown when an enrolled folder's non-atomic create has no receipt to authorise it. Nothing was copied. */
export class NonAtomicWriteRefused extends Error {
  override readonly name = 'NonAtomicWriteRefused'
  constructor(readonly path: string) {
    super(`${path}: this disk cannot create the file atomically, and no backup receipt authorised a copy.`)
  }
}

/** What a save receipt answers for a non-atomic create. */
export type NonAtomicDecision =
  | {
    kind: 'copy'
    /**
     * Asked synchronously in the tick of the copy itself, after every await (nothing is awaited between this
     * answer and the copy call): whether the authority that granted the copy still stands. False: nothing is
     * copied; `refused` takes the hold route instead.
     */
    admit(): boolean
    /** Admission was refused at the copy: the complete bytes go off the vault, the granted start owes its
     *  abandon, and the save must refuse with HeldForBackup. Nothing was opened at the destination. */
    refused(): Promise<void>
    /** The copy finished and its descriptors are closed: the durable barrier and the flush follow. */
    copied(absolute: string): Promise<void>
    /** The copy threw (its descriptors are closed): the abandon follows. */
    copyFailed(): Promise<void>
  }
  /** The complete bytes are durable off the vault: the save must refuse with HeldForBackup. */
  | { kind: 'held' }

/** A save's receipt as the Workspace sees it. Main-only: a function never crosses IPC. */
export type SaveReceiptHandle = {
  nonAtomicCreate(bytes: Uint8Array): Promise<NonAtomicDecision>
}

let policy: ((root: string) => 'copy' | 'refuse') | null = null

/** Main sets this once (backup receipts service); tests may reset it with null. */
export function setNonAtomicWritePolicy(next: ((root: string) => 'copy' | 'refuse') | null): void {
  policy = next
}

/** Whether a non-atomic create without a receipt may copy in `root`. A policy that throws refuses. */
export function nonAtomicWritePolicy(root: string): 'copy' | 'refuse' {
  if (!policy) return 'copy'
  try { return policy(root) } catch { return 'refuse' }
}
