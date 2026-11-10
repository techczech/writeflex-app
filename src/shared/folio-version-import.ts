/**
 * Importing a co-author's Word revision, steps 1 and 2 (ADR-0052 § Records `incoming`; Folio versions ticket 14; journey J3). Pure: the
 * words the import view uses, the one rule for the default base, and the shapes that cross the IPC seam. Main builds the answers
 * (folio-version-import.ts, folio-version-import-ipc.ts) and the renderer draws them. Nothing here reads or writes a file.
 */
import type { AmbiguousItem, ConfidenceWord, MatchedItem, NewItem, PartRef } from '../main/folio-version-match'
import { stagedLine, type RevisionReport, type StageOutcome } from './folio-version-stage'
import type { WordRefusalCode } from '../main/word-reader'
import { normaliseSentTo } from './folio-version-export'

/** The largest Word file the import reads, in bytes. Equal to the cap on an inserted file (a Folio version keeps the file as an object). */
export const IMPORT_MAX_DOCX_BYTES = 25 * 1024 * 1024
/** The most sections of hers one import keeps: each is an object and a line of the record. */
export const IMPORT_MAX_SECTIONS = 1000
/** The longest heading the record keeps (a heading is a line, not a paragraph); a longer one is cut in the record and kept whole in the object. */
export const IMPORT_MAX_HEADING = 500
/** The most decisions one request may carry: one per section of hers. */
export const IMPORT_MAX_RESOLUTIONS = IMPORT_MAX_SECTIONS

/** The name of the safety version saved first. */
export const safetyVersionName = (author: string): string => `Before importing ${author}’s revision`
/** The name of the incoming version. */
export const incomingVersionName = (author: string): string => `${author}’s revision`

/** The sentence for a "From" name that cannot be kept; null when it can. It is the same rule as "sent to". */
export function fromProblem(raw: unknown): string | null {
  try { normaliseSentTo(raw) } catch (error) { return error instanceof Error ? error.message.replace('Say who it was sent to.', 'Say who the revision is from.') : 'Say who the revision is from.' }
  return null
}
export const normaliseFrom = (raw: unknown): string => {
  const problem = fromProblem(raw)
  if (problem !== null) throw new Error(problem)
  return normaliseSentTo(raw)
}

/** One version she could have started from. */
export type ImportBaseChoice = { id: string; name: string; ts: number; sentTo?: string }

const nameKey = (text: string): string => text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-GB')

/**
 * The version offered as the one she started from: the newest version marked as sent to her, else the newest. `versions` is newest
 * first and holds only versions that can be a base (not her own revisions, not withdrawn ones). Equal names only, ignoring case and
 * spacing: a name that merely resembles hers is not the same person, so it is not guessed. Null when there is no version at all.
 */
export function defaultImportBase(versions: readonly ImportBaseChoice[], from: string): { id: string; reason: 'sent' | 'latest' } | null {
  const wanted = nameKey(from)
  const sent = versions.find((version) => version.sentTo !== undefined && nameKey(version.sentTo) === wanted)
  if (sent) return { id: sent.id, reason: 'sent' }
  const latest = versions[0]
  return latest ? { id: latest.id, reason: 'latest' } : null
}

/** The line under "She started from" when no version is marked as sent to her. */
export const latestBaseNote = (from: string, name: string): string => `No version is marked as sent to ${from}, so the latest, “${name}”, is offered. Choose another if they started from a different one.`

/** Why a request was refused. `nothing-written` is always true of a refusal: no safety version, no object, no record. */
export type ImportRefusalCode =
  | WordRefusalCode
  | 'unreadable-file'
  | 'not-a-folio'
  | 'bad-name'
  | 'bad-request'
  | 'no-versions'
  | 'bad-base'
  | 'version-unsettled'
  | 'too-many-sections'
  | 'needs-decision'
  | 'file-changed'
  | 'safety-not-saved'
  | 'not-recorded'
  | 'writes-paused'
  | 'collection-closed'
  /** Ticket 15: this Word file's suggestions are already waiting in the margins. */
  | 'already-waiting'
  /** Ticket 15: more changes than one revision may stage. */
  | 'too-many-changes'
  /** Ticket 15: the revision was stored but its changes could not be staged; it is marked withdrawn and no part changed. */
  | 'staging-failed'
  /** Ticket 15: the Word file is not inside the Collection (the agent's verb reads only files the Collection holds). */
  | 'file-not-in-collection'

export type ImportRefused = {
  status: 'refused'
  code: ImportRefusalCode
  message: string
  /** True when the refusal wrote nothing at all (every refusal before the safety version). */
  nothingWritten: boolean
  /** Only on `file-changed`: the Word file read afresh, matched with none of the writer's decisions, so the window shows what is there now. */
  prepared?: ImportPrepared
}

/** A choice of file the writer made through the system dialog. The renderer never names a path. */
export type ImportChooseAnswer = { status: 'chosen'; name: string; bytes: number } | { status: 'cancelled' } | { status: 'error'; message: string }

/** What step 1 shows before any file is read: who it is from, the versions she could have started from and which is offered. */
export type ImportBases = {
  status: 'ready'
  from: string
  bases: ImportBaseChoice[]
  baseId: string
  /** `sent`: marked as sent to her. `latest`: no such mark, so the newest version is offered. */
  baseReason: 'sent' | 'latest'
  baseNote: string | null
  /** Parts that differ between the base and the working text now (null when that could not be worked out). */
  changedSince: number | null
  /** What the safety version will be called. */
  safetyName: string
}

export type ImportRequest = {
  dir: string
  from: string
  /** The version she started from; absent: the default. */
  base?: string
  /** The writer's decisions about her sections (see `MatchResolution`). */
  resolutions?: Array<{ section: number; part: string | null }>
  /**
   * The SHA-256 of the file the writer saw. Every request after the first reading carries it: if the file on disk is not these bytes
   * any more, main refuses (`file-changed`), applies none of the decisions and returns the file read afresh.
   */
  fileSha256?: string
}

export type ImportCommitRequest = ImportRequest & {
  /** The SHA-256 of the file the writer saw matched. If the file on disk is not these bytes any more, nothing is written. */
  fileSha256: string
}

/** The sentence when the Word file is not the one the writer was looking at. */
export const FILE_CHANGED_MESSAGE = 'The Word file changed on disk since WriteFlex matched it, so your choices were cleared. Look at the new matches and decide again. Nothing was written.'

/** A section as the table names it. */
export type ImportSectionRef = { index: number; heading: string | null }
export type ImportPartOption = { path: string; title: string; role: 'part' | 'unlisted' }

export type ImportPrepared = {
  status: 'ready'
  file: { name: string; sha256: string; bytes: number; reviewers: string[]; changes: number; sections: number; tables: number; figures: number; limitations: string[] }
  bases: ImportBases
  /** Who judged the close matches: the stand-in (`judgement-stub`) or a judge's judgements. Said in the view. */
  mechanism: 'judgement-stub' | 'judged'
  noHeadingStyles: boolean
  /** Her sections in her order, as the matcher read them. */
  items: Array<MatchedItem | AmbiguousItem | NewItem>
  /** Parts nothing in her file is, in running order. */
  missing: PartRef[]
  /** Every part of the base the writer may name, in running order (Not in the outline after). */
  parts: ImportPartOption[]
  /** Close matches and ambiguous sections still waiting for the writer; "Bring changes into the Folio" is off while it is above 0. */
  needs: number
  /** Resolutions that were refused (they changed nothing), with the sentence why. */
  unusedResolutions: Array<{ section: number; why: string }>
  confidenceWords: Record<ConfidenceWord, string>
}

export type ImportPrepareAnswer = ImportPrepared | ImportRefused

export type ImportDone = {
  status: 'done'
  /** The incoming Folio version. */
  id: string
  name: string
  /** The safety version saved first. */
  safetyId: string
  safetyName: string
  /** Sections of hers kept as objects. */
  sectionsKept: number
  /** Her changes staged as suggestions in the parts (ticket 15), and what was left out and why. Nothing is written to a part. */
  staged: StageOutcome
  /** What the matching found, as the decide list will list it (the counts equal the rows). */
  report: RevisionReport
}
export type ImportCommitAnswer = ImportDone | ImportRefused

/** The words for a close match's confidence. */
export const CONFIDENCE_WORDS: Record<ConfidenceWord, string> = { strong: 'strong', likely: 'likely', possible: 'possible' }

/** "2 matches still need your decision." */
export function needsLine(needs: number): string {
  return `${needs.toLocaleString('en-GB')} ${needs === 1 ? 'match still needs' : 'matches still need'} your decision.`
}

/** The sentence after the incoming version is stored. */
export function importedLine(done: Pick<ImportDone, 'name' | 'safetyName' | 'sectionsKept' | 'staged'>): string {
  return `“${done.name}” is stored as an incoming version with ${done.sectionsKept.toLocaleString('en-GB')} ${done.sectionsKept === 1 ? 'section' : 'sections'} of the Word file. Your current text was saved first as “${done.safetyName}”. ${stagedLine(done.staged)}`
}
