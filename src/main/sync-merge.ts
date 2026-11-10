/**
 * Three-way merge of two copies of one document that share a known common version (contract rule 4:
 * "merge only provably compatible changes with a common base"). Structural only: it never reads the
 * text for meaning and never guesses which side the writer meant (judgement-vs-code: correctness here is
 * line positions and exact bytes, not intent).
 *
 * Each side's changes from the base are taken as line hunks (@bridle/ledger `diffContent`, the diff the
 * Compare view uses). The copies merge only when:
 *  - every hunk's base text is exactly the base's lines at that place (a check on the diff itself);
 *  - no hunk of one side overlaps or touches a hunk of the other (adjacent edits are a conflict, as in
 *    git), except where both sides made the identical change at the identical place.
 * The result is the base with both sides' hunks applied at their own base positions, so every change
 * either side made is in it and nothing else is.
 * Anything else is `null`: not merged, both copies kept for the writer.
 */
import { diffContent } from '../engine'

type Hunk = { start: number; lines: number; oldText: string; newText: string }

const linesOf = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/))

function hunksOf(base: string, side: string, baseLines: string[]): Hunk[] | null {
  const hunks: Hunk[] = []
  for (const hunk of diffContent(base, side)) {
    const start = hunk.oldStart - 1
    if (!Number.isInteger(start) || start < 0 || start + hunk.oldLines > baseLines.length) return null
    // An insertion's oldStart points one past the line it follows; its base text is empty.
    if (baseLines.slice(start, start + hunk.oldLines).join('') !== hunk.oldText) return null
    hunks.push({ start, lines: hunk.oldLines, oldText: hunk.oldText, newText: hunk.newText })
  }
  return hunks
}

const touches = (a: Hunk, b: Hunk): boolean => a.start <= b.start + b.lines && b.start <= a.start + a.lines
const same = (a: Hunk, b: Hunk): boolean => a.start === b.start && a.lines === b.lines && a.newText === b.newText

/** `ours` and `theirs` merged over `base`, or null when they cannot be merged without a choice. */
export function mergeThreeWay(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs) return ours
  if (ours === base) return theirs
  if (theirs === base) return ours
  const baseLines = linesOf(base)
  const a = hunksOf(base, ours, baseLines)
  const b = hunksOf(base, theirs, baseLines)
  if (!a || !b) return null
  const merged: Hunk[] = [...a]
  for (const hunk of b) {
    const clash = a.filter((other) => touches(other, hunk))
    if (clash.length === 0) { merged.push(hunk); continue }
    if (clash.length === 1 && same(clash[0], hunk)) continue
    return null
  }
  merged.sort((x, y) => x.start - y.start || x.lines - y.lines)
  let out = ''
  let at = 0
  for (const hunk of merged) {
    if (hunk.start < at) return null
    out += baseLines.slice(at, hunk.start).join('') + hunk.newText
    at = hunk.start + hunk.lines
  }
  out += baseLines.slice(at).join('')
  return out
}
