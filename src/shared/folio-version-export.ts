/**
 * Exporting a saved Folio version and marking it as sent (ADR-0052 § The eight changes 1; Folio versions ticket 11). Pure: the
 * words the sheets use, the one rule for who a version was sent to, and the shapes that cross the IPC seam. Main builds the answers
 * (folio-version-export.ts, folio-version-mark-sent.ts, folio-version-export-ipc.ts) and the renderer draws them; the command line
 * says the same sentences, so the app and an agent cannot disagree about what a mark is.
 */
import type { ExportFormat, HtmlExportOptions } from '../main/export'
import type { FolioCompareResult } from './folio-version-compare'

/** The longest name a version is marked as sent to. A name, not a paragraph. */
export const SENT_TO_MAX = 120

/** The sentence for a name that cannot be a "sent to"; null when it can. */
export function sentToProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return 'Say who it was sent to.'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw.trim())) return 'A name is one line of text.'
  if (raw.trim().length > SENT_TO_MAX) return `Keep the name to ${SENT_TO_MAX} characters.`
  return null
}

/** The name as it is kept: trimmed, inner runs of spaces made one. Throws the sentence for a name that cannot be kept. */
export function normaliseSentTo(raw: unknown): string {
  const problem = sentToProblem(raw)
  if (problem !== null) throw new Error(problem)
  return (raw as string).trim().replace(/\s+/g, ' ')
}

/** What was asked of the export (the renderer never names a file: main asks the save dialog). `markSentTo` marks the version once the file is written. */
export type FolioVersionExportRequest = {
  dir: string
  id: string
  format: ExportFormat
  html?: HtmlExportOptions
  markSentTo?: string
}

/** What came back. A mark that could not be written never undoes the file: it is said beside the export. */
export type FolioVersionExportAnswer =
  | { status: 'cancelled' }
  | {
    status: 'done'
    target: string
    format: ExportFormat
    pieces: number
    listed: number
    missingImages: string[]
    unreadableImages: string[]
    /** The name the version now says it was sent to, when the writer asked for the mark and it was written. */
    sentTo?: string
    /** The sentence for a mark that was asked for and not written; the file is written. */
    markRefused?: string
  }
  | { status: 'error'; message: string }

/** The answer to marking a version as sent on its own. */
export type FolioVersionMarkAnswer = { status: 'done'; sentTo: string } | { status: 'error'; message: string }

/** "Made from this saved version (19 Oct, 16:40), not from the working draft." and, when known, how much has changed since. */
export function madeFromLine(when: string, changedParts: number | null): string {
  const base = `Made from this saved version (${when}), not from the working draft.`
  if (changedParts === null || changedParts === 0) return base
  return `${base} ${changedParts === 1 ? '1 part has' : `${changedParts.toLocaleString('en-GB')} parts have`} changed since.`
}

/** How many parts of the Folio now differ from the version: changed, added, taken out or moved. Null when the comparison could not be made. */
export function partsChangedSince(result: FolioCompareResult | { refused: string } | null): number | null {
  if (result === null || 'refused' in result) return null
  return result.parts.filter((part) => part.state !== 'unchanged').length
}

/** The note under "Mark as sent to": what the mark does. */
export function markNote(name: string): string {
  const who = name.trim() === '' ? 'the name you give' : name.trim()
  return `The version then carries “sent to ${who}”. When their revision comes back, Import offers this version as the one they started from. Marks on other versions stay in the list.`
}

/** When the version already says it was sent to someone else, the mark replaces that. */
export function replacesLine(current: string | undefined, next: string): string | null {
  if (current === undefined || current === '' || current === next.trim()) return null
  return `It is marked sent to ${current} now; this replaces that mark.`
}

/** The one sentence after an export: what was written, and the mark if one was asked for. */
export function exportedLine(answer: Extract<FolioVersionExportAnswer, { status: 'done' }>): string {
  const what = `${answer.format === 'docx' ? 'Word' : 'HTML'} file written from the saved version`
  if (answer.markRefused !== undefined) return `${what}. It could not be marked as sent: ${answer.markRefused}`
  if (answer.sentTo !== undefined) return `${what}, and the version is marked sent to ${answer.sentTo}.`
  return `${what}.`
}
