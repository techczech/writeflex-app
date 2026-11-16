// Updating in place (ADR-0054, porting TalkWeaver ADR-0044 §3): what the status-bar mark, its popover, the answer to
// Check for Updates… and the About card say, as plain data from a snapshot. No React, no window: UpdateNotices.tsx
// draws it, tests/main/update-notices-view.test.ts reads it.
import { answerView, availableMarkText, cardView, dateText, versionLabel, type AnswerView, type NoteEvent, type UpdateState } from '@app-patterns/updates'
import type { UpdateSnapshot } from '../../../shared/update-checker'
import {
  DOWNLOAD_FOOT, FAIL_TEXT, REFUSAL_TEXT, blockersSentence, downloadPercent, installMarkText, reopenText, sizeText, updateFoot,
} from '../../../shared/update-install'

export type { UpdateSnapshot }

/** The answers' buttons: the shared ones, and the click's own. */
export type WfAnswerAction = NonNullable<AnswerView['action']> | 'update' | 'cancel' | 'restart' | 'retry-update'
export interface WfAnswerView extends Omit<AnswerView, 'action'> {
  action: WfAnswerAction | null
  /** Offer "Download from writeflex.app" beside the action (a failed or refused update). */
  downloadLink?: boolean
  /** The action button cannot be pressed now, and why (Restart while a reason to wait holds). */
  held?: string
}

/** The facts every shared wording function needs, from a snapshot. */
export const viewContext = (snap: UpdateSnapshot, now: number = Date.now()) =>
  ({ identity: snap.identity, arch: snap.arch, running: snap.running, platform: snap.platform, source: snap.source, enabled: snap.enabled, checking: snap.checking, now })

const stateOf = (snap: UpdateSnapshot): UpdateState => snap.state as unknown as UpdateState

/** Restarting (D3): what happens, with no promise of how long it takes (closing the documents can take until the
 *  watchdog) and no Cancel. */
const restartingText = (version: string): string =>
  `macOS checks the new version; then WriteFlex saves your documents, closes its windows and opens again as ${version}.`

/** The click's state as an answer, or null when no update is under way. */
export function installAnswer(snap: UpdateSnapshot): WfAnswerView | null {
  const s = snap.install
  switch (s.phase) {
    case 'downloading': return {
      tone: 'plain', title: `Downloading WriteFlex ${s.version}…`,
      detail: `${sizeText(s.received)} of ${sizeText(s.total)}. You can keep working.`, action: 'cancel', version: s.version,
    }
    case 'waiting': {
      const held = snap.blockers.length > 0 ? blockersSentence(snap.blockers) : undefined
      return {
        tone: 'new', title: `WriteFlex ${s.version} is ready`,
        detail: `It opens when you restart. ${held ?? 'Your documents are saved first.'}`, action: 'restart', version: s.version,
        ...(held ? { held } : {}),
      }
    }
    case 'restarting': return { tone: 'plain', title: `Restarting into ${s.version}…`, detail: restartingText(s.version), action: null, version: s.version }
    case 'reopen': { const text = reopenText(s); return { tone: 'warn', title: text.title, detail: text.detail, action: null, version: s.version } }
    case 'failed': return {
      tone: 'warn', title: `Could not update to ${s.version}`,
      detail: `${FAIL_TEXT[s.reason]} WriteFlex ${versionLabel(snap.running)} is unchanged.`, action: 'retry-update', downloadLink: true, version: s.version,
    }
    default: return null
  }
}

/** A shared answer, with Download turned into Update where this copy can update itself. */
function withUpdate(view: AnswerView, snap: UpdateSnapshot): WfAnswerView {
  if (view.action !== 'download') return view
  if (snap.refusal === null && snap.file) return { ...view, action: 'update' }
  const why = snap.refusal && snap.refusal !== 'no-file' ? ` ${REFUSAL_TEXT[snap.refusal]}` : ''
  return { ...view, detail: `${view.detail}${why}` }
}

/** What a Check for Updates… says, given the snapshot it returned (asked during distraction-free writing: that it will wait). */
export const answerOf = (snap: UpdateSnapshot): WfAnswerView =>
  snap.waiting
    ? { tone: 'plain', title: 'WriteFlex will check when distraction-free writing ends.', detail: 'Nothing is sent while you are writing distraction-free.', action: null }
    : installAnswer(snap) ?? withUpdate(answerView(stateOf(snap), viewContext(snap)), snap)

/** Which answer is open under the status bar: the answer to a check (drawn from the snapshot now), or the fixed one
 *  for a check that could not even be asked. Whether it is open is kept apart from what it says. */
export type OpenAnswer = 'check' | 'could-not-ask'

export const COULD_NOT_ASK: WfAnswerView = { tone: 'warn', title: 'Could not check for updates.', detail: 'WriteFlex could not ask for the answer. Try again.', action: 'try-again' }

/** What an open answer says now: always from the latest snapshot, so Cancel, Restart, a new offer or a change of
 *  channel shows at once, and the version on the Update button is the version the title names. */
export function openAnswerView(open: OpenAnswer | null, snap: UpdateSnapshot | null): WfAnswerView | null {
  if (open === 'could-not-ask') return COULD_NOT_ASK
  if (open === 'check' && snap) return answerOf(snap)
  return null
}

/** A button under the open answer brought back a snapshot (Try again's check, Update, Cancel, Restart): the open
 *  answer becomes the answer to a check, drawn from that snapshot, so a Try again that succeeds replaces "Could not
 *  check for updates." (held, like any answer, while distraction-free writing is on). A button that fails brings
 *  back nothing and changes nothing. */
export const resultEvent = (next: UpdateSnapshot): NoteEvent<OpenAnswer> => ({ kind: 'answer', view: 'check', busy: next.busy })

/** The New versions card in Settings: the click's state first, then the shared card. */
export function cardOf(snap: UpdateSnapshot): WfAnswerView | null {
  const install = installAnswer(snap)
  if (install) return install
  const view = cardView(stateOf(snap), viewContext(snap))
  return view ? withUpdate(view, snap) : null
}

// ── The status-bar mark and its popover ─────────────────────────────────────────────────────────

export type MarkIcon = 'available' | 'restart' | 'warn'
export interface MarkView { text: string; icon: MarkIcon; failed: boolean; phase: UpdateSnapshot['install']['phase'] }

/** The mark, or null when there is none (no newer version and no update under way, or distraction-free writing). */
export function markView(snap: UpdateSnapshot): MarkView | null {
  if (snap.busy) return null
  const working = snap.install.phase !== 'idle'
  if (!working && !snap.mark) return null
  const phase = snap.install.phase
  const text = installMarkText(snap.install) ?? (snap.mark ? availableMarkText(snap.mark) : '')
  const icon: MarkIcon = phase === 'failed' || phase === 'reopen' ? 'warn' : phase === 'waiting' || phase === 'restarting' ? 'restart' : 'available'
  return { text, icon, failed: phase === 'failed', phase }
}

export type PopoverAction = 'update' | 'download' | 'not-now' | 'skip' | 'cancel' | 'restart' | 'later' | 'retry-update'
export interface PopoverButton {
  action: PopoverAction
  label: string
  primary?: boolean
  quiet?: boolean
  /** Shown but not pressable, with the reason (Restart while a reason to wait holds). */
  disabledReason?: string
}
export interface PopoverView {
  /** Which row of the ADR-0044 §3 table this is. */
  state: 'available' | 'cannot-update-here' | 'downloading' | 'waiting' | 'restarting' | 'reopen' | 'failed'
  title: string
  sub: string
  /** Up to three lines from the feed. */
  summary?: string[]
  /** Why this copy cannot update itself (shown under the summary). */
  refusal?: string
  /** Whole per cent while downloading. */
  progress?: number
  buttons: PopoverButton[]
  foot?: string
  /** "What's new in X" link in the foot. */
  notesVersion?: string
}

const downloadLabel = (snap: UpdateSnapshot): string => `Download from ${new URL(snap.identity.feedUrl).host}`

/** The popover under the mark, or null when there is nothing to show. */
export function popoverView(snap: UpdateSnapshot): PopoverView | null {
  const s = snap.install
  switch (s.phase) {
    case 'downloading': return {
      state: 'downloading',
      title: `Downloading WriteFlex ${s.version}`,
      sub: `${sizeText(s.received)} of ${sizeText(s.total)}. You can keep working.`,
      progress: downloadPercent(s),
      buttons: [{ action: 'cancel', label: 'Cancel' }],
      foot: `WriteFlex restarts into ${s.version} when the download is finished and checked, unless a restart would interrupt something you are doing.`,
    }
    case 'waiting': {
      const held = snap.blockers.length > 0 ? blockersSentence(snap.blockers) : null
      return {
        state: 'waiting',
        title: `WriteFlex ${s.version} is ready`,
        sub: `It opens when you restart. ${held ?? 'Your documents are saved first.'}`,
        buttons: [
          { action: 'restart', label: 'Restart', primary: true, ...(held ? { disabledReason: held } : {}) },
          { action: 'later', label: 'Later' },
        ],
        foot: 'Nothing is installed until you restart. If WriteFlex quits first, it offers Update again when it next opens.',
      }
    }
    case 'restarting': return {
      state: 'restarting',
      title: `Restarting into ${s.version}…`,
      sub: restartingText(s.version),
      buttons: [],
    }
    case 'reopen': {
      const text = reopenText(s)
      return { state: 'reopen', title: text.title, sub: text.detail, buttons: [] }
    }
    case 'failed': return {
      state: 'failed',
      title: `Could not update to ${s.version}`,
      sub: `${FAIL_TEXT[s.reason]} WriteFlex ${versionLabel(snap.running)} is unchanged.`,
      buttons: [{ action: 'retry-update', label: 'Try again', primary: true }, { action: 'download', label: downloadLabel(snap) }],
    }
  }
  const latest = snap.mark
  if (!latest) return null
  const inPlace = snap.refusal === null && snap.file !== null
  const common = {
    title: `WriteFlex ${latest.version} is available`,
    sub: `You have ${versionLabel(snap.running)}. Released ${dateText(latest.released)}.`,
    summary: latest.summary,
    notesVersion: latest.version,
  }
  const rest: PopoverButton[] = [{ action: 'not-now', label: 'Not now' }, { action: 'skip', label: 'Skip this version', quiet: true }]
  if (inPlace && snap.file) return {
    ...common, state: 'available',
    buttons: [{ action: 'update', label: 'Update', primary: true }, ...rest],
    foot: updateFoot(latest.version, snap.file),
  }
  return {
    ...common, state: 'cannot-update-here',
    ...(snap.refusal && snap.refusal !== 'no-file' ? { refusal: REFUSAL_TEXT[snap.refusal] } : {}),
    buttons: [{ action: 'download', label: downloadLabel(snap), primary: true }, ...rest],
    foot: DOWNLOAD_FOOT,
  }
}
