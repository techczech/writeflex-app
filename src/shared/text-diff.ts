/** Disjoint raw-text edits using the existing bounded Myers line diff. No document identity is
 * inferred: these edits only map positions already held by an open editor. */
import { diffHunks } from './three-way-merge'
export type TextEdit = { from: number; to: number; insert: string }

const alignedHunks = (a: readonly number[], b: readonly number[], reverse: boolean) => reverse
  ? diffHunks([...a].reverse(), [...b].reverse()).reverse().map((h) => ({ aStart: a.length - h.aEnd, aEnd: a.length - h.aStart, bStart: b.length - h.bEnd, bEnd: b.length - h.bStart }))
  : diffHunks(a, b)


export function textChanges(before: string, after: string, reverse = false): TextEdit[] {
  if (before === after) return []
  // Keep line terminators so every hunk is an exact byte-for-byte text replacement.
  const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const a = lines(before), b = lines(after)
  const offsets = (ls: string[]): number[] => { const out = [0]; for (const l of ls) out.push(out[out.length - 1] + l.length); return out }
  const ao = offsets(a), bo = offsets(b)
  const ids = new Map<string, number>()
  const intern = (ls: string[]): number[] => ls.map((line) => {
    if (!ids.has(line)) ids.set(line, ids.size)
    return ids.get(line)!
  })
  const ai = intern(a), bi = intern(b)
  const hunks = alignedHunks(ai, bi, reverse)
  return hunks.flatMap((h) => {
    const old = before.slice(ao[h.aStart], ao[h.aEnd]), next = after.slice(bo[h.bStart], bo[h.bEnd])
    let start = 0, end = 0
    while (start < old.length && start < next.length && old[start] === next[start]) start++
    while (end < old.length - start && end < next.length - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++
    if (start > 0 && /[\uD800-\uDBFF]/.test(old[start - 1])) start--
    if (end > 0 && /[\uDC00-\uDFFF]/.test(old[old.length - end])) end--
    const from = ao[h.aStart] + start
    const oldPart = old.slice(start, old.length - end), nextPart = next.slice(start, next.length - end)
    // Refine changed lines too: two edits on one line must not replace unchanged text between them.
    // Bound refinement for large replacements; the existing conservative provenance fallback applies.
    if (oldPart.length + nextPart.length > 65_536) return [{ from, to: ao[h.aEnd] - end, insert: nextPart }]
    const oldPoints = Array.from(oldPart), nextPoints = Array.from(nextPart)
    const oldOffsets = offsets(oldPoints), nextOffsets = offsets(nextPoints)
    return alignedHunks(oldPoints.map((point) => point.codePointAt(0)!), nextPoints.map((point) => point.codePointAt(0)!), reverse)
      .map((part) => ({ from: from + oldOffsets[part.aStart], to: from + oldOffsets[part.aEnd], insert: nextPart.slice(nextOffsets[part.bStart], nextOffsets[part.bEnd]) }))
  })
}
