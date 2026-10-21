// What the set-up page and Settings › Sharing show, decided from a SharingSetupStatus (sharing ticket
// 02). Pure, so the step states and the problem rows are tested without a window.
import type { SharingProblem, SharingSetupStatus } from '../../../../shared/sharing-setup'
import { SAVED_TOKEN_REJECTED } from '../../../../shared/sharing-setup'

export type StepState = 'cur' | 'done' | 'wait'
export type SetupSteps = { token: StepState; paste: StepState; account: StepState }

/** Step 1 is "now" until a token is kept; step 2 likewise (its input is shown from the start); step 3 waits for step 2. */
export function setupSteps(status: SharingSetupStatus | null, changingToken: boolean): SetupSteps {
  const stored = status?.token.stored === true && !changingToken
  return {
    token: stored ? 'done' : 'cur',
    paste: stored ? 'done' : 'cur',
    account: stored ? 'cur' : 'wait',
  }
}

/** The address the "Your links will read" panel shows. */
export function linksWillRead(status: SharingSetupStatus | null): string {
  const address = status?.linksAddress ?? status?.address
  if (address) return `${address.replace(/^https:\/\//, '')}/…`
  const chosen = status?.account ? status.accounts.find((account) => account.id === status.account?.id) : null
  if (chosen?.address) return `${chosen.address.replace(/^https:\/\//, '')}/…`
  return 'writeflex-sharing.<your-account>.workers.dev/…'
}

/** A problem row at the top of the right column (frame `problems`), in the drawn order. */
export type ProblemRow = { kind: 'token-rejected' | 'service-out-of-date' | 'app-older'; title: string; text: string; tone: 'bad' | 'warn' }

export function problemRows(status: SharingSetupStatus | null): ProblemRow[] {
  if (!status?.ready) return []
  const rows: ProblemRow[] = []
  if (status.token.problem) rows.push({ kind: 'token-rejected', title: 'Token rejected', text: SAVED_TOKEN_REJECTED.reason, tone: 'bad' })
  const service = status.service
  if (service?.compare === 'update') {
    rows.push({
      kind: 'service-out-of-date', title: 'Sharing service out of date', tone: 'warn',
      text: `Your account runs sharing service build ${service.installedBuild}; this WriteFlex carries build ${service.appBuild}. Links keep working while it updates.`,
    })
  }
  if (service?.compare === 'newer') {
    rows.push({
      kind: 'app-older', title: 'WriteFlex out of date', tone: 'warn',
      text: `Your account runs sharing service build ${service.installedBuild}, from a newer WriteFlex than this one (build ${service.appBuild}). Update WriteFlex on this Mac. Links keep working.`,
    })
  }
  return rows
}

/** "14:21" for a time today, "12 Oct, 14:21" for another day. */
export function shortTime(ms: number | null, now = Date.now()): string {
  if (ms === null) return ''
  const date = new Date(ms)
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return new Date(now).toDateString() === date.toDateString() ? time : `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`
}

export const isSameProblem = (a: SharingProblem | null, b: SharingProblem): boolean => a !== null && a.reason === b.reason
