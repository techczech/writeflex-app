/**
 * What the review margin says about changes that came from outside WriteFlex (locked design
 * docs/design/2026-10-07-outside-changes-in-the-dock, carried into the margin by ADR-0045): every sentence
 * and ordering rule, as pure functions. No React, no DOM: the components only draw what these return.
 */
import { OUTSIDE_SOURCE_LABELS, type OutsideSource, type OutsideSummary } from '../../../shared/outside-source'
import { closedCodeOf } from '../../../shared/closed-code'
import type { Change } from '../../../preload'

export const num = (n: number): string => n.toLocaleString('en-GB')

/** True for a pending or held change: the ones that appear as cards. */
export const isUndecided = (change: Change): boolean => change.status === 'pending' || change.status === 'held'

export const isFromOutside = (change: Change): boolean => change.outsideSource !== undefined

/** A change closed by the app without being applied (ticket 01): listed under "could not be applied" and nowhere else. */
export const isNotApplied = (change: Change): boolean =>
  change.status === 'rejected' && typeof change.closedReason === 'string' && change.closedReason !== ''

export const sourceLabel = (source: OutsideSource): string => OUTSIDE_SOURCE_LABELS[source]

/** The label a tag carries: the source's, or the author of an in-app Change closed by the app. */
export function tagLabelOf(change: Change): string {
  if (change.outsideSource) return sourceLabel(change.outsideSource)
  return change.author?.name?.trim() || 'Agent'
}

/** 24-hour clock, local time: `14:02`. */
export function clockTime(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString()

/** `14:02 today`, or `7 Oct 14:02` on another day. */
export function whenPhrase(at: number, now: number = Date.now()): string {
  if (sameDay(at, now)) return `${clockTime(at)} today`
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(at))
  return `${day} ${clockTime(at)}`
}

/** The tag's hover title and accessible name: `From Claude Code, 14:02 today, change 2 of 5`. */
export function tagTitle(label: string, at: number | undefined, index: number, count: number, now: number = Date.now()): string {
  const when = at === undefined ? '' : `, ${whenPhrase(at, now)}`
  return `From ${label}${when}${count > 1 ? `, change ${index} of ${count}` : ''}`
}

export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}


// ---- the allowance strip -------------------------------------------------------------------------

/** Text with `**bold**` runs; the strip draws the runs in `--ink`. */
export type StripText = string

/** The one strip that applies, in the design's order of precedence, or null. */
export type ScopedOutsideSummary = OutsideSummary & { relevantSources?: OutsideSource[]; collectionWide?: boolean }

export function allowanceStrip(summary: ScopedOutsideSummary | null): StripText | null {
  const text = collectionAllowanceStrip(summary)
  return text && summary?.collectionWide ? `Across this collection: ${text}` : text
}

function collectionAllowanceStrip(summary: ScopedOutsideSummary | null): StripText | null {
  if (!summary) return null
  const { limit, limitPerSource, undecided, bySource, lastLook } = summary
  const left = lastLook?.left ?? 0
  const because = lastLook?.leftBecause ?? []
  const refused = lastLook?.refusedFull ?? 0
  const sourceRows = bySource.filter(row => !summary.relevantSources || summary.relevantSources.includes(row.source))
  const fullSource = sourceRows.find((row) => row.undecided >= limitPerSource)
  const nearSource = sourceRows.find((row) => row.undecided >= 0.9 * limitPerSource)
  const allFull = undecided >= limit
  const allNear = undecided >= 0.9 * limit

  if (allFull) {
    if (left > 0) return `**${num(limit)}** changes from outside are waiting, the most WriteFlex keeps. **${num(left)} more requests** are waiting and will be added as you decide some of these.`
    if (refused > 0) return `**${num(limit)}** changes from outside are waiting, the most WriteFlex keeps. **${num(refused)} new requests** were turned away, and their senders were told why.`
  }
  if (fullSource) {
    const label = fullSource.label
    if (left > 0) return `**${num(limitPerSource)}** changes from ${label} are waiting, the most WriteFlex keeps from one source. **${num(left)} more requests** are waiting and will be added as you decide some of these.`
    if (refused > 0) return `**${num(limitPerSource)}** changes from ${label} are waiting, the most WriteFlex keeps from one source. **${num(refused)} new requests** were turned away, and ${label} was told why.`
  }
  if (left > 0 && because.includes('not-held')) return `**${num(left)} requests** are waiting. They cannot be added from this window, because another copy of WriteFlex has this collection open.`
  if (left > 0 && because.includes('ledger-not-writable')) return `**${num(left)} requests** are waiting. WriteFlex could not save them to this collection’s review list and will try again.`
  if (left > 0 && (because.includes('look-limit') || !(allNear || nearSource))) return `**${num(left)} more requests** are waiting. WriteFlex adds them a batch at a time; they will appear here shortly.`
  if (allNear) return `**${num(undecided)} of ${num(limit)}** changes from outside are waiting. At ${num(limit)}, WriteFlex stops adding requests until you decide some.`
  if (nearSource) return `**${num(nearSource.undecided)} of ${num(limitPerSource)}** changes from ${nearSource.label} are waiting. At ${num(limitPerSource)}, WriteFlex stops adding requests from ${nearSource.label} until you decide some.`
  return null
}

/** Ticket 10: the margin top is reserved for reached limits and actionable collection-access failures. */
export function marginAllowanceVisible(summary: ScopedOutsideSummary | null): boolean {
  if (!summary || allowanceStrip(summary) === null) return false
  const reached = summary.undecided >= summary.limit || summary.bySource.some(row =>
    (!summary.relevantSources || summary.relevantSources.includes(row.source)) && row.undecided >= summary.limitPerSource)
  const look = summary.lastLook
  const blocked = (look?.left ?? 0) > 0 && look?.leftBecause.some(reason => reason === 'not-held' || reason === 'ledger-not-writable')
  return reached || Boolean(blocked)
}

/** Split a strip text into plain and bold runs. */
export function stripRuns(text: StripText): Array<{ text: string; bold: boolean }> {
  return text.split('**').map((part, index) => ({ text: part, bold: index % 2 === 1 })).filter((run) => run.text !== '')
}

// ---- the arrival notice --------------------------------------------------------------------------

export function arrivalText(arrived: Change[]): string {
  const sources = new Set(arrived.map((change) => change.outsideSource))
  const n = arrived.length
  const who = sources.size === 1 && arrived[0]?.outsideSource ? sourceLabel(arrived[0].outsideSource) : 'outside'
  return n === 1 ? `1 change arrived from ${who}` : `${num(n)} changes arrived from ${who}`
}

// ---- could not be applied ------------------------------------------------------------------------

const REASONS: Partial<Record<ReturnType<typeof closedCodeOf>, string>> = {
  'target-gone': 'The text this change replaces is no longer in the document.',
  'target-repeated': 'The text this change replaces appears more than once in the document, so WriteFlex cannot tell which one is meant.',
  'file-missing': 'The document was moved or deleted after this change was asked for.',
  'not-a-document': 'This path is not a document, so nothing was opened or changed.',
}

/** The sentence the entry shows: the design's for the four commonest codes, otherwise `closedReason` as written. */
export function reasonSentence(change: Change): string {
  return REASONS[closedCodeOf(change)] ?? change.closedReason ?? ''
}

/** What the request asked for: `outsideIntended` when present, otherwise the Change's own texts.
 *  `path` is where to say it was asked for: the path as the request typed it when that was not a
 *  document path (the record's own path is then a fixed label), otherwise the record's path. */
export function intendedOf(change: Change): { oldText: string; newText: string; cut: boolean; path: string } {
  const kept = change.outsideIntended
  const typed = typeof kept?.path === 'string' && kept.path !== '' ? kept.path : null
  const texts = kept ? { oldText: kept.oldText, newText: kept.newText, cut: kept.cut } : { oldText: change.oldText, newText: change.newText, cut: false }
  return { ...texts, path: typed ?? change.path }
}

export const LONG_TEXT_NOTE = 'Long text: only the first 2,000 characters were kept.'

/** Closed changes, newest `closedAt` first. */
export function sortNotApplied(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => (b.closedAt ?? b.ts) - (a.closedAt ?? a.ts))
}

/** Keep collection-wide limits/backlog, but show them only beside suggestions from a relevant source. */
export function scopeOutsideSummary(summary: OutsideSummary | null, changes: readonly Change[], paths: ReadonlySet<string>): ScopedOutsideSummary | null {
  if (!summary) return null
  const relevant = changes.filter(change => paths.has(change.path) && isFromOutside(change) && isUndecided(change))
  if (relevant.length === 0) return null
  return { ...summary, collectionWide: true, relevantSources: [...new Set(relevant.map(change => change.outsideSource!))] }
}

/** Collection navigation/counts retain other documents even when their cards are out of scope. */
export function outsideChangesElsewhere(changes: readonly Change[], active: string | null): Change[] {
  return changes.filter(change => change.path !== active && (isUndecided(change) || isNotApplied(change)))
}
