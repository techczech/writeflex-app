import { ChangeSet, Text } from '@codemirror/state'
import { textChanges } from '../../../shared/text-diff'
import type { WriterPendingChange } from './writer-review'
import { isTextChange } from '../../../shared/line-endings'
import { basisFromBaseline, type SaveBasis } from '../../../shared/save-basis'

/**
 * - `none`: nothing to do.
 * - `adopt`: the disk holds the buffer's own document in another form (line endings, BOM) or with the
 *   same bytes the buffer was based on: take the disk's bytes as the baseline, the buffer stays.
 * - `replace`: the buffer has nothing unsaved and takes the disk version.
 * - `conflict`: the buffer may hold text that is not on disk; the writer is asked.
 */
export type ExternalContentReconcileAction = 'none' | 'adopt' | 'replace' | 'conflict'

/**
 * Classify a disk read for an open buffer without mutating editor state. Identical live text always
 * wins over timing.
 *
 * `baseline` is the saved baseline in the editor's form; `baselineDisk` the same baseline as it is on
 * disk (EditorBaselines.diskText). With `baselineDisk` given, the disk is compared byte for byte (review
 * round 1, Sol M3): a line-ending or BOM change made by another program is a change, adopted silently
 * by a buffer with nothing unsaved and asked about over one with unsaved text. `diskUnknown`: a write of
 * unknown outcome means the buffer's equality with the baseline does not make it clean (Sol M2): only
 * the writer's explicit choice replaces it.
 */
export function externalContentReconcileAction(input: {
  buffer: string
  baseline: string | undefined
  disk: string
  baselineDisk?: string
  diskUnknown?: boolean
}): ExternalContentReconcileAction {
  const { buffer, baseline, disk, baselineDisk, diskUnknown = false } = input
  // The buffer is the disk's document: nothing unsaved to lose. Its basis becomes the disk's bytes.
  if (!isTextChange(disk, buffer)) return baselineDisk === undefined || baselineDisk === disk ? 'none' : 'adopt'
  // The disk still holds exactly what the buffer was based on (a late echo of the app's own save).
  if (baselineDisk !== undefined ? disk === baselineDisk : baseline !== undefined && !isTextChange(baseline, disk)) return 'none'
  const clean = baseline !== undefined && !isTextChange(baseline, buffer) && !diskUnknown
  // Another program changed only the form (line endings, BOM) of the version the buffer was based on.
  if (baseline !== undefined && !isTextChange(baseline, disk)) return clean ? 'adopt' : 'conflict'
  if (clean) return 'replace'
  return baseline === undefined && !diskUnknown ? 'replace' : 'conflict'
}

/** The banner raised for an open file whose disk copy changed or went away under it. `dirty`: the buffer
 *  held unsaved text then. `diskText`: the disk text the banner was raised for (null when the file is gone
 *  or could not be read); Keep mine is a choice against exactly that text. `again`: raised because the
 *  disk moved once more while the writer was answering an earlier banner with Keep mine. */
export type ExternalDiskNotice = { kind: 'changed' | 'removed'; dirty: boolean; diskText: string | null; again?: boolean }

/**
 * May this buffer be written while `notice` stands for its path? A notice raised over unsaved text is a
 * choice the writer has not made: the disk holds another version (or could not be read), and writing
 * the buffer would replace it. No automatic save, close or Save command writes then. Only the answer
 * "Keep mine" does, and only for the very notice it answered (`answered`): one raised since, for a
 * later outside change, is a new question. A file removed on disk is that question whether or not the
 * buffer held unsaved text: no automatic write recreates it until the writer chooses Keep mine.
 */
export function mayWriteUnderDiskNotice(notice: ExternalDiskNotice | undefined, answered?: ExternalDiskNotice): boolean {
  if (!notice) return true
  if (notice.kind === 'changed' && !notice.dirty) return true
  return notice === answered
}

/**
 * The basis a write of this buffer carries to main (shared/save-basis.ts). The saved baseline, unless
 * the write is the answer Keep mine to the notice standing now: then the disk text that notice was raised
 * for, or, for a file that is gone, "never on disk" (Keep mine recreates it).
 */
export function saveBasisFor(baselineDisk: string | undefined, notice?: ExternalDiskNotice, answered?: ExternalDiskNotice): SaveBasis {
  if (answered && notice === answered) {
    return answered.diskText === null ? { kind: 'new' } : { kind: 'keep-mine', text: answered.diskText }
  }
  return basisFromBaseline(baselineDisk)
}

/** The notice for a save main refused because the disk holds `diskText` (null: no file), not the
 *  version the buffer was based on. `answering`: the refused save was Keep mine to that notice. */
export function noticeForRefusedSave(diskText: string | null, answering?: ExternalDiskNotice): ExternalDiskNotice {
  return { kind: diskText === null ? 'removed' : 'changed', dirty: true, diskText, ...(answering ? { again: true } : {}) }
}

/** Whether a fresh read of the disk asks the same question as the notice already standing: raising it
 *  again would replace the notice object, and turn a Keep mine already clicked into an answer to an old one.
 *  Byte for byte: Keep mine is a choice against the exact disk text the notice carries. */
export function sameDiskNotice(standing: ExternalDiskNotice | undefined, kind: ExternalDiskNotice['kind'], diskText: string | null): boolean {
  if (!standing || standing.kind !== kind) return false
  return standing.diskText === diskText
}

/**
 * After main refused a save, may the buffer simply take the disk version (as the watcher would give it)
 * instead of the writer being asked? Only with nothing unsaved in it: it equals its baseline, that baseline
 * is known (no write of unknown outcome since: Sol M2), and the refused write was not Keep mine.
 */
export function refusalMayReload(input: { baseline: string | undefined; buffer: string; diskUnknown: boolean; answering?: ExternalDiskNotice }): boolean {
  return !input.answering && input.baseline !== undefined && !isTextChange(input.baseline, input.buffer) && !input.diskUnknown
}

/**
 * The notice for a save main refused (Muse S2): the notice standing, when it already asks about exactly
 * this disk text, so a Keep mine clicked on it (perhaps queued behind the refused save) stays its answer;
 * otherwise a new one. `answering`: the refused save was itself Keep mine to the standing notice, and the
 * disk moved since (a new question, marked `again`).
 */
export function noticeAfterRefusal(standing: ExternalDiskNotice | undefined, diskText: string | null, answering?: ExternalDiskNotice): ExternalDiskNotice {
  if (!answering && standing && standing.dirty && sameDiskNotice(standing, diskText === null ? 'removed' : 'changed', diskText)) return standing
  return noticeForRefusedSave(diskText, answering)
}

/**
 * Does Keep mine on `notice` write the buffer (true), or only dismiss the notice (false)? Keep mine is the
 * writer's explicit choice and is carried out against the notice whatever the dirty dot says (Sol S5: an
 * undo can clear the dot while the disk holds another version). Only a "changed" notice raised over a
 * buffer with nothing unsaved, which still has nothing unsaved (`unsavedNow`: the dot, or text the unsaved
 * registry holds), is answered by dismissing it: there is nothing of the writer's to keep.
 */
export function keepMineWrites(notice: ExternalDiskNotice | undefined, unsavedNow: boolean): boolean {
  if (!notice) return false
  return notice.kind === 'removed' || notice.dirty || unsavedNow
}

/** What the status bar says when a save or a close is refused for that reason. */
export function diskNoticeRefusalMessage(path: string, notice: ExternalDiskNotice): string {
  const name = path.split('/').at(-1) ?? path
  if (notice.again) {
    return notice.kind === 'removed'
      ? `${name} was removed on disk after the banner was shown. The banner now says so; nothing was saved.`
      : `${name} changed on disk again after the banner was shown. The banner now shows the newer version; nothing was saved.`
  }
  return notice.kind === 'removed'
    ? `${name} is no longer readable on disk. Choose Keep mine above the text to write it again, or close the tab to discard the text; nothing was saved.`
    : `${name} changed on disk. Choose Reload or Keep mine above the text; nothing was saved.`
}

/** The question a tab close asks when its file was removed on disk under text that is only in the tab
 *  (Muse S1, round 2): closing is the writer's way to let the text go, and it is asked, never assumed. */
export function removedTabDiscardQuestion(name: string): string {
  return `${name} was removed on disk, and this tab holds text that is not saved anywhere.\n\n`
    + 'Close the tab and discard that text? Cancel keeps the tab; Keep mine above the text writes the file again.'
}

/** A closing window's line for the documents it could not write: the reason each one gave (a disk notice,
 *  a refusal from main), then a count of those that failed for no stated reason. Every refused path is
 *  named; a reason recorded for one path never stands in for another. */
export function closeRefusalMessage(failed: ReadonlyArray<{ path: string; reason?: string }>): string {
  const reasons = failed.flatMap((entry) => (entry.reason ? [entry.reason] : []))
  const unexplained = failed.length - reasons.length
  const count = unexplained > 0 ? [`Could not save ${unexplained} document${unexplained > 1 ? 's' : ''} — the window stays open`] : []
  if (reasons.length === 0) return count.join('')
  return [...reasons, ...count, ...(unexplained > 0 ? [] : ['The window stays open.'])].join(' ')
}

/**
 * Buffer reconciliation (2026-07-11 "auto-accepted my sentence" walk report): when disk moves under an
 * open buffer (an agent edit applied, a version saved), the old path replaced the WHOLE document and
 * cleared every writer-review mark — silently folding the writer's tracked edits into plain text. This
 * computes the smallest RAW-buffer replacement that turns the buffer's derived clean text into the new
 * disk text, so tracked writer edits outside the changed region survive by ordinary position mapping.
 * A writer change INSIDE the changed region folds into the disk text (the degraded case: writer and
 * disk touched the same passage) — never the whole document.
 */

export type MinimalReplace = { from: number; to: number; insert: string }

/** The smallest single replacement turning `current` into `next` (common prefix/suffix trimmed), or
 *  null when they are identical. Coordinates are in `current`. */
export function minimalReplace(current: string, next: string): MinimalReplace | null {
  if (current === next) return null
  let prefix = 0
  const max = Math.min(current.length, next.length)
  while (prefix < max && current[prefix] === next[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < max - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return {
    from: prefix,
    to: current.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  }
}

type Span = {
  rawFrom: number
  rawTo: number
  cleanFrom: number
  cleanTo: number
}

/** Each pending change's span in raw AND derived-clean coordinates, mirroring deriveCleanWriterDocument
 *  (sorted, overlaps skipped, [anchor.from..anchor.to] replaced by newText in the clean text). */
function changeSpans(changes: readonly WriterPendingChange[]): Span[] {
  const sorted = [...changes].sort((a, b) => a.anchor.from - b.anchor.from || a.anchor.to - b.anchor.to)
  const spans: Span[] = []
  let rawCursor = 0
  let delta = 0 // clean = raw + delta, in the plain text between spans
  for (const change of sorted) {
    if (change.anchor.from < rawCursor) continue // overlapping change — deriveClean skips these too
    const rawFrom = change.anchor.from
    const rawTo = change.anchor.to
    const cleanFrom = rawFrom + delta
    const cleanTo = cleanFrom + change.newText.length
    spans.push({ rawFrom, rawTo, cleanFrom, cleanTo })
    delta = cleanTo - rawTo
    rawCursor = rawTo
  }
  return spans
}

/**
 * The RAW-buffer replacement that reconciles the buffer with `next` (the new disk text), given the
 * buffer's pending writer changes and its derived clean text. Null when nothing changed. The window is
 * expanded so it never cuts through a change span: a span fully inside the window folds (replaced by
 * the disk text); a zero-width strike at a window edge is stepped over and SURVIVES.
 */
export function reconcileReplace(
  changes: readonly WriterPendingChange[],
  clean: string,
  next: string,
  window = minimalReplace(clean, next),
): MinimalReplace | null {
  if (!window) return null
  const spans = changeSpans(changes)

  let cleanFrom = window.from
  let cleanTo = window.to
  // Expand the clean window to whole spans it partially covers (never cut a change in half).
  for (const span of spans) {
    if (cleanFrom > span.cleanFrom && cleanFrom < span.cleanTo) cleanFrom = span.cleanFrom
    if (cleanTo > span.cleanFrom && cleanTo < span.cleanTo) cleanTo = span.cleanTo
  }
  // The flanks the expansion added are identical in `next` (they were outside the diff window).
  const insert = clean.slice(cleanFrom, window.from) + window.insert + clean.slice(window.to, cleanTo)

  // Map the (expanded) clean edges to raw. Edges never sit strictly inside a span now; at boundaries,
  // step OVER zero-width strikes (they contribute nothing to clean and must survive), and pin to a
  // span's raw edges when the window includes it.
  const mapEdge = (cleanPos: number, edge: 'start' | 'end'): number => {
    let raw = cleanPos
    for (const span of spans) {
      if (span.cleanTo < cleanPos) {
        raw += (span.rawTo - span.rawFrom) - (span.cleanTo - span.cleanFrom)
        continue
      }
      if (span.cleanFrom > cleanPos) break
      // cleanPos touches this span's boundary (or the span is zero-width at it).
      const isStrike = span.cleanFrom === span.cleanTo
      if (isStrike) {
        // A strike at the START edge is stepped over (window begins after it); at the END edge the
        // window stops before it. Either way the struck text stays out of the replacement.
        if (edge === 'start' && cleanPos === span.cleanFrom) raw += span.rawTo - span.rawFrom
        break
      }
      if (cleanPos === span.cleanFrom) break // window starts/ends before the span
      // cleanPos === span.cleanTo: window includes the span → account for its raw width.
      raw += (span.rawTo - span.rawFrom) - (span.cleanTo - span.cleanFrom)
      break
    }
    return raw
  }

  return { from: mapEdge(cleanFrom, 'start'), to: mapEdge(cleanTo, 'end'), insert }
}

/** Map disjoint external edits from derived clean text to the raw editor, preserving pending review
 * spans between them. Expanded overlapping windows become one replacement, never overlapping edits. */
export function reconcileChanges(changes: readonly WriterPendingChange[], clean: string, next: string): MinimalReplace[] {
  const edits = textChanges(clean, next)
  const spans = changeSpans(changes)
  const windows: Array<{ from: number; to: number }> = []
  for (const edit of edits) {
    let { from, to } = edit
    for (const span of spans) {
      if (from > span.cleanFrom && from < span.cleanTo) from = span.cleanFrom
      if (to > span.cleanFrom && to < span.cleanTo) to = span.cleanTo
    }
    const previous = windows.at(-1)
    if (previous && from <= previous.to) previous.to = Math.max(previous.to, to)
    else windows.push({ from, to })
  }
  const mapping = ChangeSet.of(edits, clean.length)
  const doc = Text.of(next.split('\n'))
  return windows.map(({ from, to }) => reconcileReplace(changes, clean, next, {
    from, to, insert: doc.sliceString(mapping.mapPos(from, -1), mapping.mapPos(to, 1)),
  })!)
}
