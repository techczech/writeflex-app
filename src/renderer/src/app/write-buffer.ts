/**
 * Tier 1 (ADR-0013): the write of one open document's buffer to disk, and what its answer means for the
 * buffer (spec-save-only-over-the-version-you-saw.md, review round 1). App's `writePath` is this, with
 * the app's state behind the ports; nothing here holds state of its own, so a test drives the real rule.
 *
 * What holds:
 * - The buffer is read when the write runs, and the write is announced to the unsaved registry in that
 *   turn. Every write carries a basis (shared/save-basis.ts): the saved baseline as it is on disk, or the
 *   exact disk text of the notice it answers with Keep mine.
 * - No write runs under a notice the writer has not answered (mayWriteUnderDiskNotice).
 * - After a write, the baseline is what main says it WROTE (`written`), never what a later read returned
 *   (Sol M1, Muse M1). A readback that differs is another program's write: the writer is asked (`outside`).
 * - Main's refusal (`disk-changed`) raises the banner for the version main found; it is never retried.
 *   The app's own writes of an open document (accept, redo, goal, restore, clear) run in the document
 *   owner's queue, never while a save of it is in flight, so a refusal is always another version.
 * - A write whose outcome is unknown (it threw) leaves the registry holding the text, and the disk
 *   unknown for the document (unsaved-registry.ts): no automatic reload may treat the buffer as clean.
 *
 * This is the document owner's save step (document-owner.ts): the owner runs it in the path's queue and
 * reads the gen the write captures. Pure of React and IPC: everything goes through the ports.
 */
import { isTextChange } from '../../../shared/line-endings'
import type { SaveBasis } from '../../../shared/save-basis'
import { diskNoticeRefusalMessage, mayWriteUnderDiskNotice, saveBasisFor, type ExternalDiskNotice } from '../editor/reconcile'
import type { UnsavedRegistry } from './unsaved-registry'

/** What main answers a save (preload FileSaveResult, in the shape this module reads). */
export type WriteAnswer =
  | { refused: 'disk-changed'; diskText: string | null; message: string }
  | { refused: true | 'name-taken'; message: string }
  | { content: string; written: string }

export type WriteBufferPorts = {
  /** The notice standing for the path now, if any. */
  notice(path: string): ExternalDiskNotice | undefined
  /** The buffer as it is now. `undefined`: no editor at all (the app was unmounted by an error); null:
   *  the tab's buffer is not resident. */
  buffer(path: string): string | null | undefined
  /** The saved baseline in the editor's form, and as it is on disk; `setBaseline` takes on-disk text. */
  baseline(path: string): string | undefined
  baselineDisk(path: string): string | undefined
  setBaseline(path: string, diskText: string): void
  registry: Pick<UnsavedRegistry, 'typed' | 'beginWrite' | 'textOf'>
  save(path: string, doc: string, basis: SaveBasis): Promise<WriteAnswer>
  /** e2e only: what the harness does before the save reaches main (hold it, fail it). */
  beforeSave?(): Promise<void>
  setDirty(path: string, dirty: boolean, text: string): void
  setDirtyDot(path: string, dirty: boolean): void
  slow(path: string, slow: boolean): void
  /** The write was refused before it reached main, by a standing notice. */
  refusedByNotice(path: string, message: string): void
  /** Main refused it for another reason (an empty-save guard): nothing was written. */
  refusedByMain(path: string, message: string): void
  /** Main found another version on disk than the basis: nothing was written. `answering`: the write was
   *  Keep mine to that notice. */
  diskChanged(path: string, diskText: string | null, buffer: string, answering?: ExternalDiskNotice): void
  /** The write was made (or nothing needed writing). `changed`: the disk holds other bytes than the
   *  version the write was based on (false: main found the buffer already there and wrote nothing). */
  saved(path: string, changed: boolean): void
  /** The file read back after the write is not what was written: another program wrote it. */
  outsideAfterWrite(path: string, diskText: string): void
  /** The write threw: whether it was made is not known. */
  unknown(path: string): void
}

/** True when the buffer's text went to disk (or nothing needed writing). */
export async function writeBuffer(ports: WriteBufferPorts, path: string, answered?: ExternalDiskNotice): Promise<boolean> {
  // The disk changed (or went) under this buffer and the writer has not chosen: nothing writes it but the
  // answer Keep mine to that very notice. Asked when the write runs, so a queued save is stopped too.
  // The renderer's own check is the fast path; main is the rule (the basis, compared at the rename).
  const notice = ports.notice(path)
  if (notice && !mayWriteUnderDiskNotice(notice, answered)) {
    ports.refusedByNotice(path, diskNoticeRefusalMessage(path, notice))
    return false
  }
  let doc = ports.buffer(path)
  if (doc === undefined) return true // no editor: unsaved-text.ts holds the text and answers the close
  if (doc === null) {
    // Not resident: text the registry still holds is the writer's latest and is written from there.
    const kept = ports.registry.textOf(path)
    if (kept === undefined) {
      ports.setDirtyDot(path, false)
      return true
    }
    doc = kept
  } else if (isTextChange(ports.baseline(path), doc)) {
    ports.registry.typed(path, doc) // text that differs from the disk is unsaved until written
  }
  // Announced in the turn the buffer was read, with the basis read in the same turn.
  const write = ports.registry.beginWrite(path, doc)
  const answering = answered && ports.notice(path) === answered ? answered : undefined
  const basis = saveBasisFor(ports.baselineDisk(path), ports.notice(path), answered)
  const slowTimer = setTimeout(() => ports.slow(path, true), 2000)
  try {
    await ports.beforeSave?.()
    const result = await ports.save(path, doc, basis)
    if ('refused' in result && result.refused === 'disk-changed') {
      write.failed() // nothing was written
      ports.diskChanged(path, result.diskText, doc, answering)
      return false
    }
    if ('refused' in result) {
      write.failed()
      ports.refusedByMain(path, result.message)
      return false
    }
    // The buffer is based on what was written, whatever a later read returned.
    ports.setBaseline(path, result.written)
    if (result.content !== result.written) {
      // Another program wrote the file between the commit and the readback: the writer's text is not
      // on disk now. The registry keeps it and the disk is unknown for the document (no automatic
      // reload, no close, treats the buffer as clean); the writer is asked. Not a confirmed save.
      write.unknown()
      const now = ports.buffer(path)
      if (now != null) ports.setDirty(path, true, now)
      else ports.setDirtyDot(path, true)
      ports.outsideAfterWrite(path, result.content)
      return false
    }
    write.succeeded()
    ports.saved(path, basis.kind !== 'disk' || basis.text !== result.written)
    const now = ports.buffer(path)
    if (now != null) ports.setDirty(path, isTextChange(result.written, now), now)
    else {
      // No buffer to read: never let the file stand in for one and clear text the registry holds.
      const notOnDisk = isTextChange(result.written, doc)
      if (notOnDisk && ports.registry.textOf(path) === undefined) ports.registry.typed(path, doc)
      ports.setDirtyDot(path, notOnDisk)
    }
    return true
  } catch {
    write.unknown() // the registry keeps the text and the disk is unknown for the document
    ports.unknown(path)
    return false
  } finally {
    clearTimeout(slowTimer)
    ports.slow(path, false)
  }
}
