/**
 * What an invocation of the command line came to, in words an agent cannot misread. Two closed lists,
 * defined here once and nowhere else:
 *
 *  - OUTCOMES: the top-level `outcome` of every `--json` document, success and error. Exactly one per
 *    invocation. The exit code is unchanged by it (0 done/filed, 1 refused/failed/needs-writer/an
 *    error that could not be verified, 2 usage, 3 sent to the app and not confirmed or not verified).
 *  - ERROR_CODES: the `error.code` of an error document. Each maps to exactly one outcome.
 *
 * `renderOutcome` is the one place the fixed first line of a write-kind result is made.
 *
 * ONE VOCABULARY. A result document (`result`) carries no `outcome` of its own: the top-level one is
 * the only word for what happened. A refusal that travels in a reply from the app carries its code
 * from ERROR_CODES (request-format.ts checks it strictly), so no code is ever worked out from a
 * message's wording.
 */
import type { OperationResult } from './operation'

export const OUTCOMES = ['done', 'filed', 'refused', 'sent-not-confirmed', 'not-verified', 'needs-writer', 'usage', 'failed'] as const
export type Outcome = (typeof OUTCOMES)[number]

export const OUTCOME_LINES: Record<Outcome, string> = {
  done: 'Done:',
  filed: 'Waiting for review in WriteFlex (not applied):',
  refused: 'Refused:',
  'sent-not-confirmed': 'Sent to WriteFlex, not confirmed:',
  'not-verified': 'Could not be verified:',
  'needs-writer': 'The writer must act in WriteFlex first:',
  usage: 'Not run, the arguments are wrong:',
  failed: 'Failed:',
}

/** What each outcome means, and what an agent does next. Carried in `help --json`. */
export const OUTCOME_MEANINGS: Record<Outcome, string> = {
  done: 'Carried out now.',
  filed: 'Shown first: the change waits for the writer in WriteFlex and is NOT applied. `result.shown` says whether it is in the review dock now ("now") or will appear when the Collection is next opened ("when-opened").',
  refused: 'A rule said no. Nothing changed. Read the message, change the request, do not repeat it unchanged.',
  'sent-not-confirmed': 'WriteFlex has the Collection open and did not answer in time. The request is left for it. Check the Collection before repeating the command.',
  'not-verified': 'WriteFlex appears to own the Collection, or answered, but that could not be verified. The message (and `sent` in an error) says whether anything was sent. Check the Collection before repeating.',
  'needs-writer': 'The writer must act in WriteFlex first (save the version there; clear the review dock). Nothing changed. Tell the writer; do not retry until they have.',
  usage: 'Bad arguments. Nothing ran. Run `writeflex describe <operation>`.',
  failed: 'An unexpected error. The message says what is known about the state.',
}

/** The generic codes (`usage`, `refused`, `failed`) are the older ones and stay; the rest say why. */
export const ERROR_CODES = [
  'usage', 'refused', 'failed',
  'root-not-chosen', 'command-busy', 'app-opened-meanwhile', 'writes-paused', 'write-not-permitted', 'app-data-not-writable',
  'request-too-large', 'not-passable-to-app', 'confirmation-needed',
  'version-unsettled', 'review-allowance-full',
  'owner-not-verified', 'reply-unreadable', 'owner-lock-lost',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export const ERROR_OUTCOME: Record<ErrorCode, Outcome> = {
  usage: 'usage', refused: 'refused', failed: 'failed',
  'root-not-chosen': 'refused', 'command-busy': 'refused', 'app-opened-meanwhile': 'refused', 'writes-paused': 'refused', 'write-not-permitted': 'refused', 'app-data-not-writable': 'refused',
  'request-too-large': 'refused', 'not-passable-to-app': 'refused', 'confirmation-needed': 'refused',
  'version-unsettled': 'needs-writer', 'review-allowance-full': 'needs-writer',
  'owner-not-verified': 'not-verified', 'reply-unreadable': 'not-verified', 'owner-lock-lost': 'failed',
}

/** The coarse class of a code: what decides the exit status (`usage` exits 2, the rest 1). */
export function coarseOf(code: ErrorCode): 'usage' | 'refused' | 'failed' {
  return code === 'usage' ? 'usage' : ERROR_OUTCOME[code] === 'failed' ? 'failed' : 'refused'
}

export const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)

/** The sentence that says where a filed change is, from `result.shown`. */
function shownLine(shown: unknown): string {
  return shown === 'now'
    ? "It is in WriteFlex's review dock now. Nothing in the document has changed; the writer accepts or rejects it there."
    : 'It is not in the review dock yet: it will appear there when the Collection is next opened. Nothing in the document has changed.'
}

/** A write-kind result as plain text: the fixed line, for `filed` where it is, then the operation's own words. */
export function renderOutcome(outcome: Outcome, result: Pick<OperationResult, 'data' | 'text'>): string {
  const data = (result.data ?? {}) as { shown?: unknown }
  return [OUTCOME_LINES[outcome], ...(outcome === 'filed' ? [shownLine(data.shown)] : []), result.text].join('\n')
}
