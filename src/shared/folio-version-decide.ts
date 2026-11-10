/**
 * The decide step of Import (ADR-0052 § The eight changes 4 and 5, § Rules that must hold; journey J3; Folio versions ticket 16): which
 * things of a co-author's revision the writer still has to settle, and the words for them. Pure: no disk, no clock. Main reads the records
 * and the change ledger and fills the list in (`main/folio-version-decide.ts`); the renderer draws it.
 *
 * TWO KINDS OF DECISION, ONE COUNT.
 *  - A staged SUGGESTION (ticket 15) is decided in the part's margin by the one Accept or Reject every proposal has; the change ledger
 *    holds the outcome. This step lists them per part and opens the part where the margin is.
 *  - A STRUCTURE decision is the writer's alone: add her new section as a part (or leave it out), use her order for a part that moved (or keep
 *    theirs), take a part her file does not have out of the running order (or keep it). Each is recorded as a `folio-decision` line in the
 *    Folio journal; the first record for a row stands.
 * "5 of 22 decided" counts both. No agent verb decides either: the writer's accept and reject have no verb by design (ADR-0052 § Agent verbs).
 *
 * Which sections are new, which parts are missing and which sections moved is DERIVED from the incoming record and the version she started
 * from, by the same rules as the match table of step 2 (`main/folio-version-match.ts`); a test holds the two equal.
 */
import type { FolioContentMember, FolioDecision, FolioDecisionChoice, FolioIncoming, FolioIncomingSection, FolioMember } from './folio-version-records'

/**
 * Which of an ordered list of base positions are OUT OF PLACE: the longest run still in increasing order stays put, the rest moved. The one
 * rule step 2 (matching) and this step both use, so a section is "moved" in both or in neither. Ties break as the matcher always has.
 */
export function movedFlags(order: readonly number[]): boolean[] {
  const best: number[] = []
  const before: number[] = []
  order.forEach((value, i) => {
    best[i] = 1
    before[i] = -1
    for (let j = 0; j < i; j += 1) if (order[j]! < value && best[j]! + 1 > best[i]!) {
      best[i] = best[j]! + 1
      before[i] = j
    }
  })
  const stay = new Set<number>()
  if (order.length > 0) {
    let end = 0
    best.forEach((length, i) => { if (length > best[end]!) end = i })
    for (let at = end; at >= 0; at = before[at]!) stay.add(at)
  }
  return order.map((_, i) => !stay.has(i))
}

/** A section of hers as it stands now: the record's line with the writer's own answers to `match:<n>` laid over it. */
export type EffectiveSection = FolioIncomingSection & { index: number }

export type DecisionLike = Pick<FolioDecision, 'row' | 'choice' | 'part' | 'ts'>

const matched = (section: EffectiveSection): section is EffectiveSection & { part: string } => (section.match === 'exact' || section.match === 'confirmed') && section.part !== undefined

/** The sections with the writer's decisions about unmatched ones applied: `confirm` makes a section a match of the part chosen, `none` makes it a new section. */
export function effectiveSections(incoming: Pick<FolioIncoming, 'sections'>, decisions: readonly DecisionLike[]): EffectiveSection[] {
  return incoming.sections.map((section, index) => {
    if (section.match !== 'unmatched') return { ...section, index }
    const decision = decisions.find((entry) => entry.row === `match:${index}`)
    if (decision?.choice === 'confirm' && decision.part !== undefined) return { ...section, match: 'confirmed' as const, part: decision.part, index }
    if (decision?.choice === 'none') return { heading: section.heading, ...(section.object !== undefined ? { object: section.object } : {}), match: 'new' as const, index }
    return { ...section, index }
  })
}

/** The parts of the version she started from as the matcher read them: the running order, then the files not in the outline. */
export type BaseOrderEntry = { label: string; title: string; role: 'part' | 'unlisted' }
export function baseOrder(members: readonly FolioMember[]): BaseOrderEntry[] {
  const titleOf = (member: { path: string; title?: string }): string => member.title?.trim() || (member.path.split('/').pop() ?? member.path).replace(/\.(md|markdown|mdx)$/i, '')
  type Listed = FolioContentMember & { role: 'part' | 'unlisted' }
  const ordered = (role: 'part' | 'unlisted'): Listed[] => members
    .filter((member): member is Listed => member.role === role)
    .sort((a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER))
  return [...ordered('part'), ...ordered('unlisted')].map((member) => ({ label: member.path, title: titleOf(member), role: member.role as 'part' | 'unlisted' }))
}

/** One structure row of the decide list. */
export type StructureKind = 'new' | 'moved' | 'removed'
export type StructureRow = {
  /** `new:3`, `moved:5`, `removed:<base label>`: what a decision record names. */
  key: string
  kind: StructureKind
  /** Her section (new, moved). */
  section?: number
  heading?: string
  /** The part, as the version she started from named it (moved, removed), and its title. */
  part?: string
  title?: string
  /** The title of the part her file puts this after; null when it opens her file (new, moved). */
  after?: string | null
  /** What the writer chose, and when; absent while the row waits. */
  choice?: FolioDecisionChoice
  decidedAt?: number
}

/** A section of the Word file that matches no part yet and that the writer has to place (an agent's import leaves these). */
export type MatchRowOfList = { key: string; section: number; heading: string; choice?: FolioDecisionChoice; part?: string; decidedAt?: number }

export type Derived = { rows: StructureRow[]; matches: MatchRowOfList[]; sections: EffectiveSection[]; /** The parts of the version she started from that no section matches (yet): what an unplaced section can be placed as. */ free: BaseOrderEntry[] }

/** The structure rows and the unplaced sections of an incoming revision, from the records alone. */
export function deriveStructure(incoming: Pick<FolioIncoming, 'sections'>, base: readonly BaseOrderEntry[], decisions: readonly DecisionLike[]): Derived {
  const sections = effectiveSections(incoming, decisions)
  const decided = (key: string): DecisionLike | undefined => decisions.find((entry) => entry.row === key)
  const withDecision = (key: string): Pick<StructureRow, 'choice' | 'decidedAt'> => { const found = decided(key); return found ? { choice: found.choice, decidedAt: found.ts } : {} }
  const titleOf = (label: string): string => base.find((entry) => entry.label === label)?.title ?? label
  const unplaced = sections.filter((section) => section.match === 'unmatched')

  // Her order of the sections that matched a part, and where each part stood in the version she started from.
  const mine = sections.filter(matched)
  const baseIndex = (label: string): number => base.findIndex((entry) => entry.label === label)
  const moved = movedFlags(mine.map((section) => baseIndex(section.part)))
  const previousTitle = (section: EffectiveSection): string | null => {
    for (let at = section.index - 1; at >= 0; at -= 1) {
      const before = sections[at]!
      if (matched(before)) return titleOf(before.part)
    }
    return null
  }

  const rows: StructureRow[] = []
  for (const section of sections) {
    if (section.match === 'new') rows.push({ key: `new:${section.index}`, kind: 'new', section: section.index, heading: section.heading, after: previousTitle(section), ...withDecision(`new:${section.index}`) })
  }
  // A section of hers that matches no part yet could be any part, so "moved" and "missing" cannot be told until the writer has placed it: those rows are listed then.
  if (unplaced.length === 0) {
    mine.forEach((section, at) => {
      if (moved[at]) rows.push({ key: `moved:${section.index}`, kind: 'moved', section: section.index, heading: section.heading, part: section.part, title: titleOf(section.part), after: previousTitle(section), ...withDecision(`moved:${section.index}`) })
    })
    const taken = new Set(mine.map((section) => section.part))
    for (const entry of base) {
      if (entry.role === 'part' && !taken.has(entry.label)) rows.push({ key: `removed:${entry.label}`, kind: 'removed', part: entry.label, title: entry.title, ...withDecision(`removed:${entry.label}`) })
    }
  }
  const matches = unplaced.map((section): MatchRowOfList => {
    const found = decided(`match:${section.index}`)
    return { key: `match:${section.index}`, section: section.index, heading: section.heading, ...(found ? { choice: found.choice, ...(found.part !== undefined ? { part: found.part } : {}), decidedAt: found.ts } : {}) }
  })
  const takenNow = new Set(sections.flatMap((section) => (matched(section) ? [section.part] : [])))
  return { rows, matches, sections, free: base.filter((entry) => !takenNow.has(entry.label)) }
}

export const isStructureDecided = (row: Pick<StructureRow, 'choice'>): boolean => row.choice !== undefined

/** The two choices of each structure row, in the order the buttons show them (the first is the one that changes the Folio). */
export const STRUCTURE_CHOICES: Record<StructureKind, ReadonlyArray<{ choice: FolioDecisionChoice; label: string; note: string }>> = {
  new: [
    { choice: 'add', label: 'Add as a part', note: 'Makes one new part from that section and puts it in the running order.' },
    { choice: 'skip', label: 'Leave it out', note: 'Nothing is added. The section stays in the revision’s record.' },
  ],
  moved: [
    { choice: 'hers', label: 'Use their order', note: 'Moves the part in the running order to where the Word file has it. Only the order changes.' },
    { choice: 'mine', label: 'Keep my order', note: 'The running order stays as it is.' },
  ],
  removed: [
    { choice: 'take-out', label: 'Take it out of the order', note: 'The part leaves the running order and appears under Not in the outline. Its file is not deleted.' },
    { choice: 'keep', label: 'Keep it', note: 'The part stays where it is in the running order.' },
  ],
}

/** What a placed section says. */
export function placedWords(row: Pick<MatchRowOfList, 'heading' | 'choice' | 'part'>, title: string | null): string {
  return row.choice === 'none' ? `“${row.heading}” is a new section.` : `“${row.heading}” is placed as “${title ?? row.part ?? ''}”.`
}

/** What a decided row says, for the list and the toast. */
export function decidedWords(row: Pick<StructureRow, 'kind' | 'choice' | 'heading' | 'title'>): string {
  const what = row.kind === 'removed' ? `“${row.title ?? ''}”` : `“${row.heading ?? ''}”`
  switch (row.choice) {
    case 'add': return `Added ${what} as a part.`
    case 'skip': return `Left ${what} out.`
    case 'hers': return `Moved ${what} to where the Word file has it.`
    case 'mine': return `Kept ${what} where it is.`
    case 'take-out': return `Took ${what} out of the running order. Its file is under Not in the outline.`
    case 'keep': return `Kept ${what} in the running order.`
    default: return ''
  }
}

/** The line that says what a structure row is, before it is decided. */
export function rowWords(row: Pick<StructureRow, 'kind' | 'heading' | 'title' | 'after'>): string {
  if (row.kind === 'new') return `A new section, “${row.heading ?? ''}”, ${row.after === undefined || row.after === null ? 'opens the Word file.' : `follows “${row.after}”.`}`
  if (row.kind === 'moved') return `“${row.title ?? ''}” stands elsewhere in the Word file${row.after === undefined || row.after === null ? ': first.' : `: after “${row.after}”.`}`
  return `The Word file has nothing for “${row.title ?? ''}”.`
}

/** The progress the decide step, the banner and the timeline row show: suggestions in the margins plus structure rows. */
export type DecideProgress = { decided: number; total: number }
export const progressOf = (suggestions: DecideProgress, rows: ReadonlyArray<Pick<StructureRow, 'choice'>>, text: DecideProgress = { total: 0, decided: 0 }): DecideProgress => ({
  total: suggestions.total + rows.length + text.total,
  decided: suggestions.decided + rows.filter(isStructureDecided).length + text.decided,
})

export const progressLine = (progress: DecideProgress): string => `${progress.decided.toLocaleString('en-GB')} of ${progress.total.toLocaleString('en-GB')} decided`

/** The name the finishing offer proposes for the version: "After Sam Rowe’s revision". */
export const finishedVersionName = (from: string): string => `After ${from.trim()}’s revision`

// ---- What main answers --------------------------------------------------------------------

export type SuggestionOutcome = 'waiting' | 'accepted' | 'declined' | 'closed'

export type DecideSuggestion = {
  id: string
  kind: 'replace' | 'insert' | 'delete'
  /** The paragraph(s) as sent and as hers, cut for the list. */
  oldText: string
  newText: string
  outcome: SuggestionOutcome
  /** Why a change was closed without being applied, when it was. */
  why?: string
}

export type DecidePart = {
  path: string
  title: string
  /** Its place in the running order now (1-based), or null when it is not in the order. */
  position: number | null
  suggestions: DecideSuggestion[]
}

export type PlaceablePart = { label: string; title: string; role: 'part' | 'unlisted' }

/**
 * A part the three-text view is for (ticket 17): both of you changed it, or the Word file changed it somewhere the import could not stage a suggestion.
 * `total` is the rows of it that are not unchanged, `settled` how many of those are decided (rows that decide themselves count).
 */
export type DecideTextPart = { path: string; title: string; position: number | null; section: number; heading: string; both: boolean; total: number; settled: number }

export type DecideList = {
  revision: { id: string; name: string; from: string; by: string | null; ts: number; file: string; withdrawn: boolean }
  parts: DecidePart[]
  /** Ticket 17: the parts to open as three texts. Absent in a list made before the view existed. */
  texts: DecideTextPart[]
  rows: StructureRow[]
  matches: MatchRowOfList[]
  /** The parts of the version she started from that no section of hers matches: what an unplaced section can be placed as (by label, as the version named it). */
  placeable: PlaceablePart[]
  /** The running order as main read it: structure decisions are made against this order and refused if it moved. */
  order: string[]
  progress: DecideProgress
  /** Every suggestion and every structure row is decided, and no section of hers still needs placing. */
  complete: boolean
  /** The name the finishing offer proposes, present only when `complete`. */
  offer: string | null
}

export type DecideRequest = { dir: string; revision: string; row: string; choice: FolioDecisionChoice; /** The running order the writer saw (for a structure row; a match placement does not depend on it). */ expected: string[]; /** For a `match:` row with `confirm`: the part chosen, by the label the version she started from gave it. */ part?: string }
export type DecideRefusalCode = 'not-found' | 'withdrawn' | 'already-decided' | 'stale' | 'not-placeable' | 'collection-closed' | 'not-recorded' | 'bad-request'
export type DecideAnswer =
  | { status: 'done'; message: string; list: DecideList }
  /** `nothingWritten: false` says a step was made and the row is still open (a file was created and not yet added, say). */
  | { status: 'refused'; code: DecideRefusalCode; message: string; nothingWritten: boolean; list?: DecideList }

export const STALE_DECISION = 'The running order has changed since you looked at it, so nothing was changed. The list shows it as it is now; decide again.'
export const PLACE_HEAD = 'Which part is it?'
export const ALREADY_DECIDED = 'That has already been decided, so nothing was changed.'
export const REVISION_GONE = 'That revision is not in this Folio any more, so nothing was changed.'
export const REVISION_WITHDRAWN = 'That revision is withdrawn, so there is nothing to decide. Nothing was changed.'
