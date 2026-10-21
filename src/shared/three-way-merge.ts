/**
 * Three-way merge of a document that changed on disk while it had unsaved edits (roadmap: the Merge
 * button on the changed-on-disk banner). `base` is the version both sides started from (the buffer's
 * saved baseline), `mine` the editor's buffer, `theirs` the version on disk the banner was raised for.
 *
 * Line by line (a line is the text between `\n`s, so a Markdown paragraph is one line):
 * - a region only one side changed is taken from that side, on its own;
 * - a region both sides changed the same way is taken once;
 * - a region both sides changed differently is a conflict, and the writer picks mine, theirs or both
 *   (mine first). Regions that overlap or touch count as one region: nothing is combined by guess.
 *
 * Nothing is lost by the split: joining every chunk's lines with `\n` gives back each side exactly.
 * Line endings and a leading BOM are not differences (line-endings.ts): every side is merged in the
 * editor's form, and the result carries mine's BOM. Pure: no IO.
 */
import { editorTextOf } from './line-endings'

const BOM = '﻿'

export type MergeChunk =
  /** Unchanged on both sides. */
  | { kind: 'same'; lines: string[] }
  /** Changed on one side only (`mine` or `theirs`), or the same way on both (`both`): taken as `lines`. */
  | { kind: 'mine' | 'theirs' | 'both'; base: string[]; lines: string[] }
  /** Changed differently on both sides; `index` counts conflicts from 0 in document order. */
  | { kind: 'conflict'; index: number; base: string[]; mine: string[]; theirs: string[] }

export type ConflictPick = 'mine' | 'theirs' | 'both'

export type ThreeWayMerge = {
  chunks: MergeChunk[]
  /** How many chunks are conflicts. */
  conflicts: number
  /** Mine started with a BOM: the merged text does too. */
  bom: boolean
}

type Hunk = { aStart: number; aEnd: number; bStart: number; bEnd: number }

/** Past this many edits the diff stops looking for a shortest script and calls the rest one change. */
const MAX_EDITS = 4000

/**
 * The regions where `b` differs from `a` (Myers' shortest edit script on interned lines), in order, each
 * as half-open ranges of both. Common prefix and suffix are trimmed first.
 */
function diffHunks(a: readonly number[], b: readonly number[]): Hunk[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const N = A.length
  const M = B.length
  if (N === 0 && M === 0) return []
  const whole: Hunk[] = [{ aStart: pre, aEnd: pre + N, bStart: pre, bEnd: pre + M }]
  if (N === 0 || M === 0) return whole

  const max = N + M
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d]: v over k in [-d, d] as it stood when step d began (the values step d - 1 left).
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d += 1) {
    trace.push(v.slice(off - d, off + d + 1))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && A[x] === B[y]) { x += 1; y += 1 }
      v[off + k] = x
      if (x >= N && y >= M) { found = d; break }
    }
    if (found >= 0) break
  }
  if (found < 0) return whole

  // Walk back from (N, M), collecting the matched pairs.
  const matches: Array<[number, number]> = []
  let x = N
  let y = M
  for (let d = found; d > 0; d -= 1) {
    const row = trace[d]
    const at = (k: number): number => row[k + d]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1; y -= 1
      matches.push([x, y])
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) { x -= 1; y -= 1; matches.push([x, y]) }
  matches.reverse()

  const hunks: Hunk[] = []
  let ax = 0
  let by = 0
  for (const [mx, my] of [...matches, [N, M] as [number, number]]) {
    if (mx > ax || my > by) hunks.push({ aStart: pre + ax, aEnd: pre + mx, bStart: pre + by, bEnd: pre + my })
    ax = mx + 1
    by = my + 1
  }
  return hunks
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

/** Merge three line arrays. */
export function mergeLines(base: readonly string[], mine: readonly string[], theirs: readonly string[]): Omit<ThreeWayMerge, 'bom'> {
  const ids = new Map<string, number>()
  const intern = (lines: readonly string[]): number[] => lines.map((line) => {
    let id = ids.get(line)
    if (id === undefined) { id = ids.size; ids.set(line, id) }
    return id
  })
  const b = intern(base)
  const mineHunks = diffHunks(b, intern(mine)).map((h) => ({ ...h, side: 'mine' as const }))
  const theirHunks = diffHunks(b, intern(theirs)).map((h) => ({ ...h, side: 'theirs' as const }))
  const all = [...mineHunks, ...theirHunks].sort((p, q) => p.aStart - q.aStart || p.aEnd - q.aEnd)

  const chunks: MergeChunk[] = []
  let conflicts = 0
  let at = 0
  const sideOf = (lines: readonly string[], hunks: ReadonlyArray<Hunk>, lo: number, hi: number): string[] => {
    if (hunks.length === 0) return base.slice(lo, hi)
    const first = hunks[0]
    const last = hunks[hunks.length - 1]
    return lines.slice(first.bStart - (first.aStart - lo), last.bEnd + (hi - last.aEnd))
  }
  for (let i = 0; i < all.length;) {
    let lo = all[i].aStart
    let hi = all[i].aEnd
    const cluster = [all[i]]
    i += 1
    // Overlapping regions are one region, and so is an insertion that touches another change (the order
    // of the two would be a guess). Two changes of neighbouring lines are not: each takes its own lines.
    const joins = (next: Hunk): boolean => next.aStart < hi
      || (next.aStart === hi && (next.aStart === next.aEnd || cluster.some((h) => h.aStart === hi && h.aEnd === hi)))
    while (i < all.length && joins(all[i])) {
      hi = Math.max(hi, all[i].aEnd)
      lo = Math.min(lo, all[i].aStart)
      cluster.push(all[i])
      i += 1
    }
    if (lo > at) chunks.push({ kind: 'same', lines: base.slice(at, lo) })
    const ours = cluster.filter((h) => h.side === 'mine')
    const others = cluster.filter((h) => h.side === 'theirs')
    const baseLines = base.slice(lo, hi)
    const mineLines = sideOf(mine, ours, lo, hi)
    const theirLines = sideOf(theirs, others, lo, hi)
    if (others.length === 0) chunks.push({ kind: 'mine', base: baseLines, lines: mineLines })
    else if (ours.length === 0) chunks.push({ kind: 'theirs', base: baseLines, lines: theirLines })
    else if (sameLines(mineLines, theirLines)) chunks.push({ kind: 'both', base: baseLines, lines: mineLines })
    else {
      // Lines both sides start or end the region with are no part of the choice (a trailing blank line, a
      // shared first sentence): they stand once, beside the conflict, so the writer picks only what differs.
      let head = 0
      while (head < mineLines.length && head < theirLines.length && mineLines[head] === theirLines[head]) head += 1
      let tail = 0
      while (tail < mineLines.length - head && tail < theirLines.length - head
        && mineLines[mineLines.length - 1 - tail] === theirLines[theirLines.length - 1 - tail]) tail += 1
      if (head > 0) chunks.push({ kind: 'both', base: [], lines: mineLines.slice(0, head) })
      chunks.push({
        kind: 'conflict',
        index: conflicts++,
        base: baseLines,
        mine: mineLines.slice(head, mineLines.length - tail),
        theirs: theirLines.slice(head, theirLines.length - tail),
      })
      if (tail > 0) chunks.push({ kind: 'both', base: [], lines: mineLines.slice(mineLines.length - tail) })
    }
    at = hi
  }
  if (at < base.length) chunks.push({ kind: 'same', lines: base.slice(at) })
  return { chunks, conflicts }
}

function editorForm(text: string): { text: string; bom: boolean } {
  const lf = editorTextOf(text)
  return lf.startsWith(BOM) ? { text: lf.slice(1), bom: true } : { text: lf, bom: false }
}

/**
 * Merge the editor's buffer (`mine`) with the disk version (`theirs`) against the version both began from
 * (`base`; undefined when the buffer was never read from disk, merged as an empty base). Every side is
 * taken in the editor's form (line endings and a leading BOM are not differences).
 */
export function threeWayMerge(base: string | undefined, mine: string, theirs: string): ThreeWayMerge {
  const b = editorForm(base ?? '')
  const m = editorForm(mine)
  const t = editorForm(theirs)
  const split = (text: string): string[] => text.split('\n')
  // An empty side is no lines at all, so adding text to an empty file is an insertion, not a change of ''.
  const lines = (text: string): string[] => text === '' ? [] : split(text)
  return { ...mergeLines(lines(b.text), lines(m.text), lines(t.text)), bom: m.bom }
}

/** A line of running prose: not blank, and not a list item, table row, quote, heading, fence or indented code. */
function isProseLine(line: string | undefined): boolean {
  if (line === undefined || line.trim() === '') return false
  if (/^(?: {4}|\t)/.test(line)) return false
  return !/^ {0,3}(?:[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|\||>|#{1,6}(?:\s|$)|```|~~~)/.test(line)
}

/**
 * Whether `lines` leave a code fence open, by CommonMark's rule: a fence opens with three or more backticks
 * or tildes (indented at most three spaces; a backtick fence's info string holds no backtick), and only a
 * line of the same character, at least as long, with nothing after it but spaces or tabs closes it. Any
 * other line inside, a shorter or other-character fence included, is code.
 */
function insideFence(lines: readonly string[]): boolean {
  let open: { char: string; length: number } | null = null
  for (const line of lines) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!fence) continue
    const marker = fence[1]!
    const rest = fence[2]!
    if (open === null) {
      if (marker[0] === '`' && rest.includes('`')) continue
      open = { char: marker[0]!, length: marker.length }
    } else if (marker[0] === open.char && marker.length >= open.length && /^[ \t]*$/.test(rest)) {
      open = null
    }
  }
  return open !== null
}

/**
 * The merged text, in the editor's form, with each conflict resolved by its pick (`picks[index]`).
 * Null while any conflict has no pick: nothing is written from a half-made merge.
 *
 * Keep both puts the writer's lines first, then the disk's. When the writer's block ends in prose and the
 * disk's begins in prose (and they are not inside a code fence), one blank line goes between them, so the
 * two paragraphs stay two paragraphs instead of running together.
 */
export function mergedText(merge: ThreeWayMerge, picks: ReadonlyArray<ConflictPick | undefined>): string | null {
  const out: string[] = []
  for (const chunk of merge.chunks) {
    if (chunk.kind === 'conflict') {
      const pick = picks[chunk.index]
      if (pick === undefined) return null
      if (pick !== 'theirs') out.push(...chunk.mine)
      if (pick === 'both' && isProseLine(chunk.mine.at(-1)) && isProseLine(chunk.theirs[0]) && !insideFence(out)) out.push('')
      if (pick !== 'mine') out.push(...chunk.theirs)
    } else {
      out.push(...chunk.lines)
    }
  }
  return (merge.bom ? BOM : '') + out.join('\n')
}

/** How the merge splits up, for the sheet's summary line. */
export function mergeCounts(merge: ThreeWayMerge): { fromDisk: number; fromMine: number; same: number; conflicts: number } {
  let fromDisk = 0
  let fromMine = 0
  let same = 0
  for (const chunk of merge.chunks) {
    if (chunk.kind === 'theirs') fromDisk += 1
    else if (chunk.kind === 'mine') fromMine += 1
    else if (chunk.kind === 'both') same += 1
  }
  return { fromDisk, fromMine, same, conflicts: merge.conflicts }
}
