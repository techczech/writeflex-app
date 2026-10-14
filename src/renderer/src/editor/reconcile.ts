import type { WriterPendingChange } from './writer-review'
import { isTextChange } from '../../../shared/line-endings'

export type ExternalContentReconcileAction = 'none' | 'replace' | 'conflict'

/** Classify a watcher read without mutating editor state. Identical live text always wins over timing.
 *  Compared in the editor's form: a disk read that differs only in line endings or BOM is no change. */
export function externalContentReconcileAction(input: {
  buffer: string
  baseline: string | undefined
  disk: string
}): ExternalContentReconcileAction {
  if (!isTextChange(input.disk, input.buffer)) return 'none'
  if (input.baseline !== undefined && !isTextChange(input.baseline, input.disk)) return 'none'
  return input.baseline !== undefined && isTextChange(input.baseline, input.buffer) ? 'conflict' : 'replace'
}

/** The banner raised for an open file whose disk copy changed or went away under it. `dirty`: the buffer held unsaved text then. */
export type ExternalDiskNotice = { kind: 'changed' | 'removed'; dirty: boolean }

/**
 * May this buffer be written while `notice` stands for its path? A notice raised over unsaved text is a
 * choice the writer has not made: the disk holds another version (or could not be read), and writing
 * the buffer would replace it. No automatic save, close or Save command writes then. Only the answer
 * "Keep mine" does, and only for the very notice it answered (`answered`): one raised since, for a
 * later outside change, is a new question.
 */
export function mayWriteUnderDiskNotice(notice: ExternalDiskNotice | undefined, answered?: ExternalDiskNotice): boolean {
  if (!notice || !notice.dirty) return true
  return notice === answered
}

/** What the status bar says when a save or a close is refused for that reason. */
export function diskNoticeRefusalMessage(path: string, notice: ExternalDiskNotice): string {
  const name = path.split('/').at(-1) ?? path
  return notice.kind === 'removed'
    ? `${name} is no longer readable on disk. Choose Reload or Keep mine above the text; nothing was saved.`
    : `${name} changed on disk. Choose Reload or Keep mine above the text; nothing was saved.`
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
): MinimalReplace | null {
  const window = minimalReplace(clean, next)
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
