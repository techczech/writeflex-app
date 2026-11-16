// Updating in place (ADR-0054, porting TalkWeaver ADR-0044 §3): the states of the one click and the one step that
// moves between them. Generic: no app name, no app wording, no Electron. The engine (src/main/update-engine.ts) and
// the app's wording (update-install.ts) both read it, so it can move into @app-patterns/updates with the engine.

export type FailReason = 'network' | 'mismatch' | 'wrong-version' | 'signature' | 'disk' | 'reopen' | 'other'

/** Why a restart the person asked for did not happen while macOS may have prepared the update (ADR-0044 §3, D4). */
export type ReopenCause = 'held' | 'no-answer' | 'install-failed'

export type InstallPhase =
  | { phase: 'idle' }
  /** D1: the app downloads and checks the file; macOS is not involved yet. Cancel. */
  | { phase: 'downloading'; version: string; received: number; total: number }
  /** D2: downloaded and checked; a reason not to restart holds. Nothing is handed to macOS; Restart waits for the person. */
  | { phase: 'waiting'; version: string }
  /** D3: the person committed to restarting: macOS prepares and checks the new version, then, if nothing holds it back at that moment, the app quits. No Cancel. */
  | { phase: 'restarting'; version: string }
  | { phase: 'failed'; version: string; reason: FailReason }
  /**
   * D4: the restart did not happen and macOS may have prepared the update; nothing more happens in this run.
   * pending: true until a withdrawal has been checked (the update will, or may, install when the app next quits);
   * false once it was checked that nothing is armed (quit and reopen the app, then press Update again).
   */
  | { phase: 'reopen'; version: string; cause: ReopenCause; pending: boolean }

export type InstallEvent =
  | { type: 'start'; version: string; total: number }
  | { type: 'progress'; received: number; total?: number }
  | { type: 'downloaded'; blockers: readonly string[] }
  | { type: 'cancelled' }
  | { type: 'failed'; reason: FailReason }
  | { type: 'restart'; blockers: readonly string[] }
  /** Permission given (nothing held the restart back): macOS prepares the new version. */
  | { type: 'prepare' }
  /** Something holds the restart back before macOS was asked: back to waiting, nothing armed. */
  | { type: 'held' }
  /** The restart did not happen while macOS may have prepared it (D4). */
  | { type: 'leftover'; cause: ReopenCause }
  /** The offer changed under a state that is not working (a newer version, or none): start again. */
  | { type: 'reset' }

export const IDLE: InstallPhase = { phase: 'idle' }

/** One step. Anything not listed leaves the state as it is. */
export function installStep(state: InstallPhase, event: InstallEvent): InstallPhase {
  switch (event.type) {
    case 'start':
      return state.phase === 'idle' || state.phase === 'failed'
        ? { phase: 'downloading', version: event.version, received: 0, total: event.total } : state
    case 'progress':
      return state.phase === 'downloading'
        ? { ...state, received: Math.max(0, Math.min(event.received, event.total ?? state.total)), total: event.total ?? state.total } : state
    case 'downloaded':
      if (state.phase !== 'downloading') return state
      return event.blockers.length === 0 ? { phase: 'restarting', version: state.version } : { phase: 'waiting', version: state.version }
    case 'cancelled':
      // No Cancel once restarting: the person has committed, and macOS may already be preparing it.
      return state.phase === 'downloading' || state.phase === 'waiting' ? IDLE : state
    case 'failed':
      return state.phase === 'downloading' || state.phase === 'restarting' || state.phase === 'waiting'
        ? { phase: 'failed', version: state.version, reason: event.reason } : state
    case 'restart':
      return state.phase === 'waiting' && event.blockers.length === 0 ? { phase: 'restarting', version: state.version } : state
    case 'prepare':
      return state.phase === 'downloading' || state.phase === 'waiting' ? { phase: 'restarting', version: state.version } : state
    case 'held':
      return state.phase === 'restarting' ? { phase: 'waiting', version: state.version } : state
    case 'leftover':
      return state.phase === 'restarting' ? { phase: 'reopen', version: state.version, cause: event.cause, pending: true } : state
    case 'reset':
      return state.phase === 'failed' ? IDLE : state
  }
}

/** Whether the app is working on an update, or has one left over (the mark stays, whatever the offer). */
export const installBusy = (state: InstallPhase): boolean => state.phase === 'downloading' || state.phase === 'waiting' || state.phase === 'restarting' || state.phase === 'reopen'

/** What went wrong, from an error electron-updater or Squirrel.Mac reported. */
export function failReasonOf(error: unknown): FailReason {
  const e = (error ?? {}) as { code?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const message = typeof e.message === 'string' ? e.message : String(error ?? '')
  if (code === 'ERR_CHECKSUM_MISMATCH' || /sha512 checksum mismatch|checksum mismatch|size mismatch|ERR_UPDATER_.*SIZE/i.test(message)) return 'mismatch'
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE' || /code signature|did not pass validation|code requirement|not signed by the application owner|SQRLCodeSignature/i.test(message)) return 'signature'
  if (code === 'ENOSPC' || /ENOSPC|no space left/i.test(message)) return 'disk'
  if (/net::ERR_|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|Cannot download|status code|HttpError|aborted|ERR_STREAM_PREMATURE_CLOSE|premature/i.test(message + ' ' + code)) return 'network'
  return 'other'
}
