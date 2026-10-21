/**
 * Merge, the third answer on the changed-on-disk banner (roadmap: merge-button-on-the-changed-on-disk-banner).
 * The writer has unsaved text and the file changed on disk; Merge shows both against the version they
 * began from (shared/three-way-merge.ts), combines what does not overlap and asks about what does.
 *
 * What holds:
 * - Opening the sheet and cancelling it write nothing and change nothing: the session is a snapshot.
 * - Neither version is lost. Before anything replaces it, exactly the disk version the sheet showed is
 *   kept in History (main's preserve operation; with no History in this window nothing is written), and
 *   main answers with a receipt whose sha256 must equal that text's. The writer's version is then written
 *   over exactly that disk version (Keep mine's own write, so main compares the bytes in the rename tick)
 *   and kept the same way, its receipt matching the text as written. Only then does the editor take the
 *   merged text, as one undoable edit, and the normal save writes it over the writer's version.
 * - Nothing is written when the disk moved since the sheet opened (a newer notice, or a receipt for other
 *   bytes), when the buffer moved (typing behind the sheet), or when there is no receipt.
 * - Every write goes through the document owner's queue and main's basis check: a refusal at any step
 *   stops the route there, with the reason.
 *
 * Pure of React and IPC: everything goes through the ports.
 */
import { mergedText, threeWayMerge, type ConflictPick, type ThreeWayMerge } from '../../../shared/three-way-merge'
import type { ExternalDiskNotice } from '../editor/reconcile'
import { receiptFor } from '../../../shared/preserve-receipt'

export type DiskMergeSession = {
  path: string
  /** The notice the sheet answers; the disk version is its `diskText`. */
  notice: ExternalDiskNotice & { kind: 'changed'; diskText: string }
  /** The buffer when the sheet opened. */
  mine: string
  merge: ThreeWayMerge
}

/** The sheet for the notice standing over `path`, or null when Merge is not a question it asks. */
export function beginDiskMerge(input: {
  path: string
  notice: ExternalDiskNotice | undefined
  buffer: string | null | undefined
  /** The buffer's saved baseline (the version both sides began from), in the editor's form. */
  baseline: string | undefined
}): DiskMergeSession | null {
  const { path, notice, buffer, baseline } = input
  if (!notice || notice.kind !== 'changed' || notice.diskText === null || typeof buffer !== 'string') return null
  return {
    path,
    notice: notice as DiskMergeSession['notice'],
    mine: buffer,
    merge: threeWayMerge(baseline, buffer, notice.diskText),
  }
}

/** Whether the banner offers Merge for this notice: a changed file under unsaved text. */
export function offersMerge(notice: ExternalDiskNotice | undefined): boolean {
  return !!notice && notice.kind === 'changed' && notice.dirty && notice.diskText !== null
}

export type DiskMergePorts = {
  notice(path: string): ExternalDiskNotice | undefined
  buffer(path: string): string | null | undefined
  /** Keep exactly `text` as a version of `path` (main's preserve operation). The answer is checked here:
   *  only a receipt whose sha256 is that of `text` counts. A rejection means nothing was kept. */
  preserve(path: string, text: string): Promise<unknown>
  /** The document's saved baseline after a write: the editor's form and the text as written to disk. */
  saved(path: string): { editor: string | undefined; disk: string | undefined }
  /** A checkpoint of the file as it is on disk now (History), best effort: used only for the merged text,
   *  which is on disk by then. */
  checkpoint(path: string): Promise<void>
  /** Keep mine on `notice`: the buffer written over exactly the notice's disk text, in the owner's queue. */
  keepMine(path: string, notice: ExternalDiskNotice): Promise<boolean>
  /** The notice was answered by the write: clear it. */
  answered(path: string): void
  /** The editor takes `merged` as one undoable edit. False: no editor for the path, nothing changed. */
  placeMerged(path: string, merged: string): boolean
  /** The normal save of the buffer (the owner's save, basis = the version just written). */
  save(path: string): Promise<boolean>
}

export type DiskMergeOutcome =
  /** Picks missing: nothing done. */
  | { kind: 'unresolved' }
  /** The disk moved since the sheet opened (a newer notice, or the file no longer holds the version the
   *  sheet showed when it was to be kept): nothing written. */
  | { kind: 'disk-moved' }
  /** The buffer changed behind the sheet: nothing written. */
  | { kind: 'buffer-moved' }
  /** The disk version could not be kept in History (no History in this window, or no receipt for its
   *  exact text): nothing written. */
  | { kind: 'no-history' }
  /** Keep mine's write was refused (the disk changed again; the banner says so): nothing written. */
  | { kind: 'mine-refused' }
  /** The writer's version is on disk and the disk version is kept, but the merge was not placed (`why`).
   *  `no-history`: the writer's version could not be kept, so nothing was written over it. */
  | { kind: 'mine-only'; why: 'disk-moved' | 'buffer-moved' | 'no-history' | 'no-editor' }
  /** The merged text would be empty (each side deleted what the other kept): both versions are in History,
   *  the writer's is on disk and in the editor, and the empty text is neither placed nor saved. */
  | { kind: 'merged-empty' }
  /** The merged text is in the editor; its save did not go through (the save said why). */
  | { kind: 'merged-unsaved' }
  /** The merged text is on disk. */
  | { kind: 'merged' }

/** Keep `text` in History: `kept`, or why not (no receipt for exactly that text). */
async function keep(ports: DiskMergePorts, path: string, text: string): Promise<{ kept: true } | { refused: 'mismatch' | 'unavailable' }> {
  let result: unknown
  try { result = await ports.preserve(path, text) } catch { return { refused: 'unavailable' } }
  if (await receiptFor(result, text)) return { kept: true }
  const refused = (result as { refused?: unknown } | null)?.refused
  // A receipt for other bytes is the same as main's own mismatch: the file holds something else now.
  if (refused === 'mismatch' || (result as { kept?: unknown } | null)?.kept === true) return { refused: 'mismatch' }
  return { refused: 'unavailable' }
}

/** Carry out the merge the writer chose. See the module comment for the order and what stops it. */
export async function applyDiskMerge(ports: DiskMergePorts, session: DiskMergeSession, picks: ReadonlyArray<ConflictPick | undefined>): Promise<DiskMergeOutcome> {
  const { path, notice, mine } = session
  const merged = mergedText(session.merge, picks)
  if (merged === null) return { kind: 'unresolved' }
  if (ports.notice(path) !== notice) return { kind: 'disk-moved' }
  if (ports.buffer(path) !== mine) return { kind: 'buffer-moved' }

  // 1. Exactly the disk version the sheet showed is kept, with a receipt for its bytes, before anything
  //    replaces it. A receipt for other bytes (another program wrote the file meanwhile) stops here.
  const disk = await keep(ports, path, notice.diskText)
  if ('refused' in disk) return { kind: disk.refused === 'mismatch' ? 'disk-moved' : 'no-history' }
  if (ports.notice(path) !== notice) return { kind: 'disk-moved' }
  if (ports.buffer(path) !== mine) return { kind: 'buffer-moved' }

  // 2. The writer's version over exactly that disk version.
  if (!(await ports.keepMine(path, notice))) return { kind: 'mine-refused' }
  if (ports.notice(path) !== notice) return { kind: 'mine-only', why: 'disk-moved' } // another write since
  ports.answered(path)

  // 3. Exactly the writer's version as written (the editor's text in the file's own form) is kept too.
  const written = ports.saved(path)
  if (written.editor !== mine || written.disk === undefined) return { kind: 'mine-only', why: 'buffer-moved' }
  const yours = await keep(ports, path, written.disk)
  if ('refused' in yours) return { kind: 'mine-only', why: yours.refused === 'mismatch' ? 'disk-moved' : 'no-history' }

  // 4. The merged text into the editor (undoable) and through the normal save. An empty merge is not
  //    placed or saved: the save would only meet the empty-document guard (Sol review round 4).
  if (merged.trim() === '') return { kind: 'merged-empty' }
  if (ports.buffer(path) !== mine) return { kind: 'mine-only', why: 'buffer-moved' }
  if (merged !== mine && !ports.placeMerged(path, merged)) return { kind: 'mine-only', why: 'no-editor' }
  if (!(await ports.save(path))) return { kind: 'merged-unsaved' }
  // The merged text is a returnable point too; a failed checkpoint here loses nothing (it is on disk).
  await ports.checkpoint(path).catch(() => undefined)
  return { kind: 'merged' }
}

/** What the status bar says after a merge. */
export function diskMergeMessage(path: string, outcome: DiskMergeOutcome): string | null {
  const name = path.split('/').at(-1) ?? path
  switch (outcome.kind) {
    case 'unresolved': return null
    case 'disk-moved': return `${name} changed on disk again while you were merging, so nothing was written. Choose Merge again to see the newer version.`
    case 'buffer-moved': return `${name} changed in the editor while you were merging, so nothing was written. Choose Merge again.`
    case 'no-history': return `History is not available for ${name}, so WriteFlex cannot keep a copy of the version on disk. Nothing was changed.`
    case 'mine-refused': return `${name} changed on disk again, so nothing was written. The banner shows the newer version.`
    case 'mine-only':
      if (outcome.why === 'no-history') return `Your version of ${name} was saved and the disk version is in History, but your version could not be kept in History, so the merge was not applied.`
      return `Your version of ${name} was saved and the disk version is in History, but the merge was not applied${outcome.why === 'disk-moved' ? ': the file changed on disk again' : outcome.why === 'buffer-moved' ? ': the text changed meanwhile' : ''}.`
    case 'merged-empty': return 'The merged text would be empty, so WriteFlex did not save it. Both versions are in History.'
    case 'merged-unsaved': return `The merge is in the editor but ${name} was not saved yet. Both earlier versions are in History.`
    case 'merged': return `Merged ${name}. Both earlier versions are in History.`
  }
}
