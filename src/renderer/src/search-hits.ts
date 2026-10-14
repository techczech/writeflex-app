/**
 * Monotonic request sequencer: `begin()` before an async call, `isCurrent(seq)` when it resolves.
 * A response whose seq is no longer current belongs to a superseded request and must be dropped —
 * without this, a slow search for "abc" resolving AFTER a fast follow-up for "xyz" would clobber
 * the newer results (same idea as App.tsx's loadSeqRef, extracted here so it's unit-testable).
 */
export function createSequencer(): { begin(): number; isCurrent(seq: number): boolean } {
  let current = 0
  return {
    begin: () => ++current,
    isCurrent: (seq) => seq === current
  }
}

export type MarkedSegment = { text: string; marked: boolean }

/** Cut a snippet into plain and marked segments from its 1-based `marks`, so every term renders as
 *  a `<mark>` without `dangerouslySetInnerHTML`. Marks are assumed sorted and non-overlapping (the
 *  backend merges them); one that runs past the text is clipped, one before the cursor is skipped. */
export function markSegments(text: string, marks: ReadonlyArray<{ column: number; length: number }>): MarkedSegment[] {
  const out: MarkedSegment[] = []
  let cursor = 0
  for (const mark of marks) {
    const start = mark.column - 1
    const end = Math.min(text.length, start + mark.length)
    if (mark.length <= 0 || start < cursor || start >= text.length) continue
    if (start > cursor) out.push({ text: text.slice(cursor, start), marked: false })
    out.push({ text: text.slice(start, end), marked: true })
    cursor = end
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), marked: false })
  return out
}

const count = (n: number): string => n.toLocaleString('en-GB')

/** The result count line: "1 piece" / "1,240 pieces". */
export function piecesLabel(n: number): string {
  return `${count(n)} piece${n === 1 ? '' : 's'}`
}

/** The over-the-cap note, or null when every matching piece is shown. */
export function capNote(shown: number, total: number): string | null {
  if (total <= shown) return null
  return `Showing ${count(shown)} of ${piecesLabel(total)} — narrow the query`
}

/** The Search switch's in-scope label for a focused folder (ticket 03): a Folio reads "This folio",
 *  a folder with an Index Note (or another recognised cover) "This collection", else "This folder". */
export function scopeLabel(kind: 'folio' | 'collection' | 'folder'): string {
  return kind === 'folio' ? 'This folio' : kind === 'collection' ? 'This collection' : 'This folder'
}
