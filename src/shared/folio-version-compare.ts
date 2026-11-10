/**
 * What comparing two Folio versions says (ADR-0052 § Agent verbs, `compare-folio-versions`; Folio versions ticket 08). Pure
 * types and the words the tab uses: main builds these records (`folio-version-compare.ts`) and the renderer draws them. The
 * command line, the agent's verb and the Versions tab all read the same record, so they cannot disagree.
 *
 * "working" is the text on disk now: the Index Note, the parts in the running order, the files not in the outline and the files
 * the text inserts, read as the save would read them.
 */

/** The id that names the working draft in place of a version. */
export const COMPARE_WORKING = 'working'

export type FolioCompareEnd = {
  /** A Folio version id, or `working`. */
  id: string
  name: string
  /** Null for the working draft. */
  ts: number | null
  author: string | null
  working: boolean
}

/**
 * How one part (or file) differs. `moved` means the same text in a different place in the running order; a part that moved and
 * also changed says `changed` and carries both positions.
 */
export type FolioCompareState = 'unchanged' | 'changed' | 'only-from' | 'only-to' | 'moved'

export type FolioCompareKind = 'index' | 'part' | 'unlisted' | 'inserted'

/** The per-file version an inserted file used on one side: null `version` is the working copy on disk. */
export type FolioCompareFileSide = {
  /** The per-file version's name; null for the working copy. */
  name: string | null
  ts: number | null
  /** 1 for the file's first version, 2 for its second and so on; absent when the history cannot say. */
  ordinal?: number
}

export type FolioCompareEntry = {
  /** Identity of this line across the two sides: asks for its detail (`folio-versions:compare-part`). */
  key: string
  kind: FolioCompareKind
  title: string
  /** The label shown: the later side's path when it has one, else the earlier side's. */
  path: string
  fromPath?: string
  toPath?: string
  state: FolioCompareState
  /** Words added and words removed going from the first side to the second; 0 and 0 for an unchanged line and for a file that is not text. */
  added: number
  removed: number
  /** Parts only: the 1-based place in the running order on each side. */
  fromPosition?: number
  toPosition?: number
  /** Inserted files: the per-file version each side used. */
  fromFile?: FolioCompareFileSide | null
  toFile?: FolioCompareFileSide | null
  /** Whether the line's two texts can be opened side by side (Markdown the version kept). */
  text: boolean
  /** The saved or working text of one side could not be read, so the line cannot say more than that it is there. */
  unreadable?: true
  /** A changed line that has the working draft on one side: the sha256 of the working file's bytes as this comparison read them. The take (ticket 09) sends it back and is refused if the part is no longer those bytes. */
  workingSha256?: string
}

export type FolioCompareSummary = { unchanged: number; changed: number; onlyFrom: number; onlyTo: number; moved: number }

export type FolioCompareResult = {
  dir: string
  from: FolioCompareEnd
  to: FolioCompareEnd
  /** The two sides are the same version (or the same text): nothing to show. */
  same: boolean
  index: FolioCompareEntry
  parts: FolioCompareEntry[]
  unlisted: FolioCompareEntry[]
  inserted: FolioCompareEntry[]
  /** Every line (the Index Note, parts, files not in the outline and inserted files) counted by its state. */
  summary: FolioCompareSummary
}

/** One stretch of a part's text in the opened comparison: unchanged paragraphs folded to a count, or a changed stretch with both sides. */
export type FolioCompareRow =
  | { kind: 'same'; paragraphs: number }
  | {
      kind: 'changed'; from: FolioCompareSegment[]; to: FolioCompareSegment[]; added: number; removed: number
      /** Ticket 10: the numbers (first, last; 1-based, shared/folio-version-paragraphs.ts) of the paragraphs of that side's saved text this stretch touches, for "Send a copy to Scratchpad". Absent when it touches none. */
      fromParagraphs?: [number, number]
      toParagraphs?: [number, number]
    }

export type FolioCompareSegment = { kind: 'equal' | 'added' | 'removed'; text: string }

/** A part's two texts, compared, for the opened line. */
export type FolioComparePart = {
  key: string
  title: string
  rows: FolioCompareRow[]
  added: number
  removed: number
}

/** True when nothing differs in the whole comparison. */
export function nothingChanged(result: Pick<FolioCompareResult, 'summary'>): boolean {
  const { changed, onlyFrom, onlyTo, moved } = result.summary
  return changed + onlyFrom + onlyTo + moved === 0
}

/** "+41 −18" (words added, words removed). */
export function changeCounts(entry: Pick<FolioCompareEntry, 'added' | 'removed'>): string {
  return `+${entry.added.toLocaleString('en-GB')} −${entry.removed.toLocaleString('en-GB')}`
}

/** The chip a line wears. Plain words, never ids. */
export function stateChipText(entry: FolioCompareEntry, ends: Pick<FolioCompareResult, 'from' | 'to'>): string {
  if (entry.kind === 'inserted' && entry.state === 'changed') return `${fileVersionText(entry.fromFile)} → ${fileVersionText(entry.toFile)}`
  switch (entry.state) {
    case 'unchanged': return 'unchanged'
    case 'changed': return `changed ${changeCounts(entry)}${entry.fromPosition !== undefined && entry.toPosition !== undefined && entry.fromPosition !== entry.toPosition ? ` · moved to ${entry.toPosition}` : ''}`
    case 'only-from': return `only in ${ends.from.working ? 'working draft' : `“${ends.from.name}”`}`
    case 'only-to': return `only in ${ends.to.working ? 'working draft' : `“${ends.to.name}”`}`
    case 'moved': return `moved ${entry.fromPosition ?? '?'} → ${entry.toPosition ?? '?'}`
  }
}

/** "v2", the working copy as "working copy", else the name, else "no longer in the history". */
export function fileVersionText(side: FolioCompareFileSide | null | undefined): string {
  if (!side) return 'no longer in the history'
  if (side.name === null && side.ts === null) return 'working copy'
  if (side.ordinal !== undefined) return `v${side.ordinal}`
  return side.name ?? 'a version'
}

/** The two sides in one line for the status bar and the heading: `“Draft for Sam Rowe” with the working draft`. */
export function comparingText(result: Pick<FolioCompareResult, 'from' | 'to'>): string {
  const label = (end: FolioCompareEnd): string => (end.working ? 'the working draft' : `“${end.name}”`)
  return `${label(result.from)} with ${label(result.to)}`
}

/** The sentence a comparison with nothing different says. */
export const NOTHING_CHANGED = 'Nothing changed between these two.'
