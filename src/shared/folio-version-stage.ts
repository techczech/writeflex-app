/**
 * Staging a co-author's changes as suggestions, and taking them back (ADR-0052 § The eight changes 5 and 6, § Agent verbs; journeys J3
 * and J6; Folio versions ticket 15). Pure types, the marker a staged change carries, the words, and the one function that turns a
 * matching into the rows the decide list shows. Main stages (`main/folio-version-stage.ts`), the margin and the Versions tab read.
 *
 * A STAGED CHANGE is an ordinary proposal in the change ledger, shown in the part's margin. It is filed with the ledger's `agent`
 * provenance because that is the value the one Accept every proposal has replays (`WorkspaceAgent.resolveChange`); a record with the
 * ledger's `reviewer` provenance is the writer's own typed text and is settled without placing anything. What makes it HERS is the
 * marker below (the reviewer's name, the revision, the section) and the record's author: the margin names her, never the importer.
 * Nothing is written to a part until the writer accepts.
 */

/** What a staged change carries beside the shared ledger's fields. Extra field; older builds pass it through. */
export type FolioRevisionMarker = {
  /** The incoming Folio version (`fv_…`) whose changes these are. */
  revisionId: string
  /** The reviewer, as the import named her. Never an agent's name. */
  reviewer: string
  /** Her section's index in her file (a heading can appear twice, so never the heading alone). */
  section: number
  /** Her heading, for the card. */
  heading: string
  /** How many tracked changes in her file this one change gathers (0 when it comes from comparing her text with the base). */
  tracked: number
  /** The first 12 hex characters of her file's SHA-256: the same file is not staged twice while it still waits. */
  file: string
  /** Ticket 17: the three-text view's row (`text:…`) this suggestion was staged for, when the writer asked for it there. */
  row?: string
}
export type FolioRevisionFields = { folioRevision?: FolioRevisionMarker }

/** The revision a change was staged from, or null for any other change. Tolerates any record. */
export function folioRevisionOf(change: object): FolioRevisionMarker | null {
  const raw = (change as FolioRevisionFields).folioRevision as unknown
  if (!raw || typeof raw !== 'object') return null
  const { revisionId, reviewer, section, heading, tracked, file, row } = raw as Record<string, unknown>
  if (typeof revisionId !== 'string' || !/^fv_[A-Za-z0-9_-]{1,64}$/.test(revisionId)) return null
  if (typeof reviewer !== 'string' || reviewer.trim() === '' || typeof heading !== 'string' || typeof file !== 'string') return null
  if (!Number.isSafeInteger(section) || (section as number) < 0 || !Number.isSafeInteger(tracked) || (tracked as number) < 0) return null
  return { revisionId, reviewer, section: section as number, heading, tracked: tracked as number, file, ...(typeof row === 'string' && /^text:\d{1,6}:[a-f0-9]{16}:\d{1,4}$/.test(row) ? { row } : {}) }
}

/** The most staged changes one revision may file, and the most text they may carry (old and new text together). Past either, nothing is staged. */
export const STAGE_MAX_CHANGES = 1000
export const STAGE_MAX_TEXT_BYTES = 16 * 1024 * 1024

/** The refusal when an agent tries to confirm a close match (ADR-0052: the writer confirms matches, in the app; an agent never does). */
export const AGENT_CANNOT_CONFIRM_MATCH = 'An agent cannot confirm a match. Only the writer can, in WriteFlex: leave the match out and import again, and any close match is reported as match-needs-confirmation and left unstaged until the writer confirms it. Nothing was done.'

/** Why a stretch of her text was not staged. It is reported, never guessed at. */
export type NotStagedReason =
  /** The part is gone, or is not a Markdown file inside the Folio now. */
  | 'part-gone'
  /** The text she changed is not in the part exactly as it was sent, or it appears more than once: the part has been edited, so the three-text view (a later step) is where the writer decides. */
  | 'text-changed'
  /** Her new paragraph has no paragraph before it in the section to be placed after. */
  | 'no-place'
  /** The section and its part are too long to compare. */
  | 'too-long'

export type NotStaged = { section: number; heading: string; part: string; reason: NotStagedReason; why: string }

export const NOT_STAGED_WORDS: Record<NotStagedReason, string> = {
  'part-gone': 'The part is not a Markdown file in this Folio any more.',
  'text-changed': 'That text is not in the part as it was sent (it has been edited since, or it appears more than once), so it was not staged.',
  'no-place': 'Her new paragraph opens the section, so there is no paragraph of yours to place it after.',
  'too-long': 'The section is too long to compare with the part.',
}

/** One staged change, as the result and the decide list describe it. */
export type StagedEntry = { id: string; section: number; heading: string; part: string; title: string; kind: 'replace' | 'insert' | 'delete'; tracked: number }

/** The words for an item of the result. */
export type MatchRow = { section: number; heading: string | null; part?: string; title?: string; confidence?: string; reason?: string }

/**
 * What an import reports, for the writer's list and for an agent's reading. Each count below is the length of its list, and the lists
 * are built from the same matching (`decideRows`), so the verb and the app cannot disagree (a test holds them equal).
 */
export type RevisionReport = {
  /** Sections matched by an exact heading or confirmed. */
  matched: MatchRow[]
  /** Close matches nobody has confirmed: not staged. Each is `match-needs-confirmation` until the writer confirms it. */
  close: Array<MatchRow & { code: 'match-needs-confirmation' }>
  /** Sections of hers that are no part of the Folio. */
  new: MatchRow[]
  /** Parts of the running order that nothing in her file is. */
  removed: Array<{ part: string; title: string }>
  /** Matched sections whose place among the others differs from their part's. */
  moved: MatchRow[]
  /** Tables and figures edited or kept in Word: reported, never applied (ADR-0052 owner choice 4). */
  assetNotes: string[]
  /** Sections the writer has to place by hand (no heading styles, repeated headings): not staged. */
  ambiguous: Array<{ sections: number[]; message: string; candidates: string[] }>
  counts: { matched: number; close: number; new: number; removed: number; moved: number; assetNotes: number; ambiguous: number }
}

/** The rows of the decide list, by kind; one row is one thing the writer settles. */
export type DecideRow =
  | { kind: 'matched'; section: number }
  | { kind: 'close'; section: number }
  | { kind: 'new'; section: number }
  | { kind: 'removed'; part: string }
  | { kind: 'moved'; section: number }
  | { kind: 'assetNote'; note: string }

/** The decide list's rows from a report. The report's counts are these rows counted by kind. */
export function decideRows(report: Pick<RevisionReport, 'matched' | 'close' | 'new' | 'removed' | 'moved' | 'assetNotes'>): DecideRow[] {
  return [
    ...report.matched.map((row): DecideRow => ({ kind: 'matched', section: row.section })),
    ...report.close.map((row): DecideRow => ({ kind: 'close', section: row.section })),
    ...report.new.map((row): DecideRow => ({ kind: 'new', section: row.section })),
    ...report.removed.map((row): DecideRow => ({ kind: 'removed', part: row.part })),
    ...report.moved.map((row): DecideRow => ({ kind: 'moved', section: row.section })),
    ...report.assetNotes.map((note): DecideRow => ({ kind: 'assetNote', note })),
  ]
}

/** What staging did. */
export type StageOutcome = {
  /** Changes now waiting in the margins of the parts. */
  changes: number
  /** Parts with at least one. */
  parts: number
  /** The sections that had changes, matched or not, and how many of them were staged. */
  sectionsChanged: number
  staged: StagedEntry[]
  notStaged: NotStaged[]
}

/** A revision's state in the Versions tab: static facts from its record, live facts from the ledger. */
export type RevisionStatus = {
  id: string
  name: string
  ts: number
  /** The reviewer. */
  from: string
  /** Who brought it in, when that is not the writer (an agent's name); null when the writer did. */
  by: string | null
  file: string
  withdrawn: boolean
  /** Changes staged for it, and how many of them are decided (accepted, declined or closed). */
  staged: number
  decided: number
  /** Parts with a staged change not yet decided, in order of first change, for "Review the revision". */
  waitingParts: Array<{ path: string; waiting: number }>
  /** Sections of hers with no part in the Folio (new), and matches nobody has confirmed. */
  newSections: number
  needsYou: number
  /** Ticket 16: the structure decisions (new section, moved part, part her file lacks) and how many the writer has made. Absent in a status made before the decide step. */
  structure?: { total: number; decided: number }
}

// ---- Words ---------------------------------------------------------------------------------

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

/** The line after staging, for the import view and the command's text. */
export function stagedLine(outcome: Pick<StageOutcome, 'changes' | 'parts' | 'notStaged'>): string {
  if (outcome.changes === 0) return outcome.notStaged.length > 0
    ? `No change of hers could be staged (${plural(outcome.notStaged.length, 'stretch', 'stretches')} did not match your text). Nothing in your parts has changed.`
    : 'Her file holds no change to the sections of your parts. Nothing in your parts has changed.'
  const left = outcome.notStaged.length > 0 ? ` ${plural(outcome.notStaged.length, 'change was', 'changes were')} not staged because your text has moved on; they are listed.` : ''
  return `${plural(outcome.changes, 'suggestion is', 'suggestions are')} waiting in the margin of ${plural(outcome.parts, 'part', 'parts')}. Nothing in your parts has changed until you accept.${left}`
}

/** "5 sections changed, 1 new; 1 match needs you." as the banner and the list's first line say it. */
export function revisionSummary(status: Pick<RevisionStatus, 'staged' | 'waitingParts' | 'newSections' | 'needsYou' | 'structure'>): string {
  const bits = [`${plural(status.staged, 'suggestion', 'suggestions')} in ${plural(Math.max(status.waitingParts.length, status.staged > 0 ? 1 : 0), 'part', 'parts')}`]
  // With the decide step's structure rows known (ticket 16) they are counted once, there; before it, a new section is mentioned on its own.
  if (status.structure !== undefined) { if (status.structure.total > 0) bits.push(plural(status.structure.total, 'structure decision', 'structure decisions')) }
  else if (status.newSections > 0) bits.push(`${plural(status.newSections, 'new section', 'new sections')}`)
  const lead = bits.join(', ')
  return status.needsYou > 0 ? `${lead}; ${plural(status.needsYou, 'match needs', 'matches need')} you.` : `${lead}.`
}

export const NOTHING_APPLIED = 'Your text is untouched until you accept changes.'

/** The timeline row's second line: "0 of 22 decided · 1 match to confirm". */
export function decidedLine(status: Pick<RevisionStatus, 'staged' | 'decided' | 'needsYou' | 'structure'>): string {
  const base = `${(status.decided + (status.structure?.decided ?? 0)).toLocaleString('en-GB')} of ${(status.staged + (status.structure?.total ?? 0)).toLocaleString('en-GB')} decided`
  return status.needsYou > 0 ? `${base} · ${plural(status.needsYou, 'match', 'matches')} to confirm` : base
}

/** Why `withdraw-revision` or the import refused. */
export type StageRefusalCode =
  | 'not-found'
  | 'not-a-revision'
  | 'already-withdrawn'
  | 'already-waiting'
  | 'too-many-changes'
  | 'staging-failed'
  | 'file-not-in-collection'

export const REVISION_NOT_FOUND = 'That is not an incoming revision of any Folio in this Collection. Nothing was changed.'
export const alreadyWaitingText = (from: string): string => `A revision from this Word file by ${from} is already waiting in the margins. Withdraw it first (writeflex withdraw-revision), or decide its changes there. Nothing was written.`
export const tooManyChangesText = (n: number): string => `That revision would stage ${n.toLocaleString('en-GB')} changes; WriteFlex stages at most ${STAGE_MAX_CHANGES.toLocaleString('en-GB')} for one revision. Nothing was written.`

/** The sentence after a withdraw. */
export function withdrawnText(name: string, taken: number, kept: number): string {
  const left = kept > 0 ? ` ${plural(kept, 'change had', 'changes had')} already been accepted or declined and stays as decided.` : ''
  return `“${name}” is withdrawn: ${plural(taken, 'staged change is', 'staged changes are')} taken back from the margins. No part was changed.${left}`
}
export const WITHDRAWN_REASON = (name: string): string => `The revision “${name.slice(0, 160)}” was withdrawn, so this suggestion was taken back.`
