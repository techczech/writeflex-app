/**
 * The three-way paragraph alignment of a part both sides changed (ADR-0052 § Decision 1, journey J3; Folio versions ticket 17). Pure: no disk, no
 * clock, no UI. Three lists of paragraphs go in (the part as it was SENT, as the co-author wrote it, and as it stands NOW), a list of rows
 * comes out, one row per stretch, in the order of the sent text. Nothing here judges meaning: two paragraphs are the same when their text is the
 * same once white space is collapsed and the text is in canonical form (the equality staging uses, `folio-version-stage.ts`: the one function below).
 *
 * HOW. The sent text is compared with each of the other two by longest common subsequence, which gives each side's RUNS (a run is a stretch of
 * sent paragraphs replaced by a stretch of that side's paragraphs; either may be empty). Runs of the two sides that OVERLAP (share a sent
 * paragraph, or an insertion inside a replaced stretch, or two insertions at the same place) are one row: the two sides touched the same
 * ground. Runs that only touch (one ends where the other begins) are separate rows, so two changes side by side stay two decisions. What is
 * left between rows is unchanged on both sides.
 *
 * ROW KINDS.
 *  - `same`: neither side changed these paragraphs (a stretch of one or more).
 *  - `only-mine`: only the writer changed it; her text is the sent text. It decides itself: the result is the writer's.
 *  - `only-hers`: only the co-author changed it (a changed, an added or a deleted paragraph); the writer's text is the sent text.
 *  - `both-same`: both changed it, to the same words. It decides itself.
 *  - `both-different`: both changed it, differently. This is the row the writer decides.
 */

/** Paragraphs `from` to `to` (half-open) of one of the three lists. Empty when `from === to`. */
export type ParagraphRange = { from: number; to: number }

export type AlignKind = 'same' | 'only-mine' | 'only-hers' | 'both-same' | 'both-different'

/** What a side did to the stretch of sent paragraphs: put others in their place, added some where there were none, or took them out. */
export type SideChange = 'none' | 'replace' | 'insert' | 'delete'

export type AlignRow = {
  kind: AlignKind
  sent: ParagraphRange
  hers: ParagraphRange
  yours: ParagraphRange
  /** What the co-author did to this stretch and what the writer did. `none` for a side that left it as sent. */
  herChange: SideChange
  yourChange: SideChange
}

/** Above this many cells in the table of the comparison of two lists (a list's length times the other's) nothing is aligned: the part is too long to compare. */
export const ALIGN_MAX_CELLS = 4_000_000

/**
 * The equality of two paragraphs: the same words, however the white space falls and however a letter is encoded (composed or decomposed: NFC).
 * Never the compatibility forms (NFKC): `x2` and `x²`, `fine` and `ﬁne`, `1/2` and `½` are different text, and her correction of one to the other must show.
 * Staging (`folio-version-stage.ts`) compares by this same function, so what is staged and what is shown as hers agree.
 */
export const squashParagraph = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim()

type Run = { sFrom: number; sTo: number; xFrom: number; xTo: number }

/** The runs that turn `a` into `b`, by longest common subsequence. Null when the lists are too large to compare. */
function runsOf(a: readonly string[], b: readonly string[]): Run[] | null {
  if (a.length * b.length > ALIGN_MAX_CELLS) return null
  const n = a.length
  const m = b.length
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const runs: Run[] = []
  let i = 0
  let j = 0
  let open: { sFrom: number; xFrom: number } | null = null
  const flush = (): void => { if (open) { runs.push({ sFrom: open.sFrom, sTo: i, xFrom: open.xFrom, xTo: j }); open = null } }
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { flush(); i += 1; j += 1; continue }
    open ??= { sFrom: i, xFrom: j }
    if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) j += 1
    else i += 1
  }
  flush()
  return runs
}

type Tagged = Run & { side: 'hers' | 'yours' }

/** Whether `run` shares ground with the group that spans sent paragraphs `from` to `to` (touching is not sharing). */
function overlaps(from: number, to: number, run: Run): boolean {
  const insert = run.sFrom === run.sTo
  if (from === to) return insert ? run.sFrom === from : run.sFrom < from && from < run.sTo
  return insert ? from < run.sFrom && run.sFrom < to : run.sFrom < to && from < run.sTo
}

const sameParagraphs = (a: readonly string[], aRange: ParagraphRange, b: readonly string[], bRange: ParagraphRange): boolean => {
  if (aRange.to - aRange.from !== bRange.to - bRange.from) return false
  for (let at = 0; at < aRange.to - aRange.from; at += 1) if (a[aRange.from + at] !== b[bRange.from + at]) return false
  return true
}

const changeOf = (sLength: number, xLength: number): SideChange => (sLength === 0 ? 'insert' : xLength === 0 ? 'delete' : 'replace')

/**
 * The rows of three lists of paragraphs, or null when they are too long to compare (`ALIGN_MAX_CELLS`). The rows cover each list from its first
 * paragraph to its last, in order and without a gap: concatenating every row's `sent` range gives the whole sent list, and the same for hers and
 * yours. Paragraphs are compared after `squashParagraph`; the ranges index the lists as given.
 */
export function alignThreeWay(sent: readonly string[], hers: readonly string[], yours: readonly string[]): AlignRow[] | null {
  const s = sent.map(squashParagraph)
  const h = hers.map(squashParagraph)
  const y = yours.map(squashParagraph)
  const herRuns = runsOf(s, h)
  const yourRuns = runsOf(s, y)
  if (herRuns === null || yourRuns === null) return null

  const all: Tagged[] = [...herRuns.map((run): Tagged => ({ ...run, side: 'hers' })), ...yourRuns.map((run): Tagged => ({ ...run, side: 'yours' }))]
    .sort((a, b) => a.sFrom - b.sFrom || a.sTo - b.sTo || (a.side === b.side ? 0 : a.side === 'hers' ? -1 : 1))
  // Group the runs that share ground.
  const groups: Array<{ from: number; to: number; runs: Tagged[] }> = []
  for (const run of all) {
    const last = groups[groups.length - 1]
    if (last && overlaps(last.from, last.to, run)) {
      last.runs.push(run)
      last.to = Math.max(last.to, run.sTo)
    } else groups.push({ from: run.sFrom, to: run.sTo, runs: [run] })
  }

  const rows: AlignRow[] = []
  let sAt = 0
  let hAt = 0
  let yAt = 0
  const pushSame = (until: number): void => {
    const length = until - sAt
    if (length <= 0) return
    rows.push({ kind: 'same', sent: { from: sAt, to: until }, hers: { from: hAt, to: hAt + length }, yours: { from: yAt, to: yAt + length }, herChange: 'none', yourChange: 'none' })
    sAt += length; hAt += length; yAt += length
  }
  for (const group of groups) {
    pushSame(group.from)
    const span = group.to - group.from
    const delta = (side: 'hers' | 'yours'): number => group.runs.filter((run) => run.side === side).reduce((sum, run) => sum + (run.xTo - run.xFrom) - (run.sTo - run.sFrom), 0)
    const sent_: ParagraphRange = { from: sAt, to: sAt + span }
    const hers_: ParagraphRange = { from: hAt, to: hAt + span + delta('hers') }
    const yours_: ParagraphRange = { from: yAt, to: yAt + span + delta('yours') }
    const herChanged = group.runs.some((run) => run.side === 'hers')
    const yourChanged = group.runs.some((run) => run.side === 'yours')
    const herChange: SideChange = herChanged ? changeOf(span, hers_.to - hers_.from) : 'none'
    const yourChange: SideChange = yourChanged ? changeOf(span, yours_.to - yours_.from) : 'none'
    const kind: AlignKind = herChanged && yourChanged ? (sameParagraphs(h, hers_, y, yours_) ? 'both-same' : 'both-different') : herChanged ? 'only-hers' : 'only-mine'
    rows.push({ kind, sent: sent_, hers: hers_, yours: yours_, herChange, yourChange })
    sAt = sent_.to; hAt = hers_.to; yAt = yours_.to
  }
  pushSame(s.length)
  return rows
}

/** Whether each side changed anything: the co-author (some row is not `same` or `only-mine`) and the writer (some row is not `same` or `only-hers`). */
export function whoChanged(rows: readonly AlignRow[]): { hers: boolean; yours: boolean } {
  return { hers: rows.some((row) => row.herChange !== 'none'), yours: rows.some((row) => row.yourChange !== 'none') }
}

/** The rows the writer has to decide: `both-different`, and `only-hers`, which is hers to take or leave. The others decide themselves. */
export const needsDecision = (row: Pick<AlignRow, 'kind'>): boolean => row.kind === 'both-different' || row.kind === 'only-hers'
