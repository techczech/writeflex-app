// Updating in place (ADR-0054, porting TalkWeaver ADR-0044): what holds a restart back in WriteFlex, when a copy
// cannot replace itself, and every word the person reads about the one click. Pure: no Electron; unit-tested in
// tests/main/update-install-words.test.ts. The states themselves are generic (update-install-state.ts); the engine
// is src/main/update-engine.ts; the screens are UpdateNotices.tsx and its view model update-notices-view.ts.
import type { UpdateFile } from './update-channels.ts'
import type { InstallPhase, FailReason, ReopenCause } from './update-install-state.ts'

export * from './update-install-state.ts'

// ── What holds a restart back (ADR-0054 "What differs" 1) ───────────────────────────────────────

/** Something a restart now would cost the person. */
export type RestartBlocker = 'focus' | 'unsaved' | 'disk-choice' | 'agent' | 'exporting' | 'sharing' | 'backup' | 'backup-unknown' | 'finishing'
export const RESTART_BLOCKERS: readonly RestartBlocker[] = ['focus', 'unsaved', 'disk-choice', 'agent', 'exporting', 'sharing', 'backup', 'backup-unknown', 'finishing']

/** Read in the main process at the moment of asking (src/main/index.ts). */
export interface RestartFacts {
  /** Distraction-free writing is on in a window (the `updates:protected` report). */
  focus: boolean
  /** A window holds text whose last save failed. */
  unsaved: boolean
  /** A window holds a document whose file changed on disk, with the person's choice not made yet. */
  diskChoice: boolean
  /** An assistant turn is running, or its proposals are being written into the review ledger. */
  agent: boolean
  /** A document, bundle or Folio version export is being written. */
  exporting: boolean
  /** A shared link is being published, changed or ended on the sharing service. */
  sharing: boolean
  /** A backup cycle is running: a Sync now, or a scheduled cycle the backup helper reports. */
  backup: boolean
  /** The backup helper is running but whether it is in a cycle could not be read (held, as a cycle would be). */
  backupUnknown?: boolean
  /** A closed window's work (its assistant's record, its checkpoints, its diary) is still being written. */
  finishing: boolean
}

/** Every reason not to restart now, in a fixed order. */
export function restartBlockers(facts: RestartFacts): RestartBlocker[] {
  const out: RestartBlocker[] = []
  if (facts.focus) out.push('focus')
  if (facts.unsaved) out.push('unsaved')
  if (facts.diskChoice) out.push('disk-choice')
  if (facts.agent) out.push('agent')
  if (facts.exporting) out.push('exporting')
  if (facts.sharing) out.push('sharing')
  if (facts.backup) out.push('backup')
  else if (facts.backupUnknown) out.push('backup-unknown')
  if (facts.finishing) out.push('finishing')
  return out
}

export const BLOCKER_TEXT: Record<RestartBlocker, string> = {
  focus: 'distraction-free writing is on',
  unsaved: 'a document has changes that could not be saved yet',
  'disk-choice': 'a document changed on disk and is waiting for your choice',
  agent: 'the assistant is still working',
  exporting: 'an export is being written',
  sharing: 'a shared link is being published',
  backup: 'a backup is running',
  'backup-unknown': 'WriteFlex cannot tell whether a backup is running',
  finishing: 'WriteFlex is still saving a closed window’s work',
}

/** "Not now: an export is being written and a backup is running." */
export function blockersSentence(blockers: readonly RestartBlocker[]): string {
  const parts = blockers.map((b) => BLOCKER_TEXT[b])
  if (parts.length === 0) return ''
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return `Not now: ${list}.`
}

// ── When a copy cannot replace itself ───────────────────────────────────────────────────────────

export type InPlaceRefusal = 'store' | 'development' | 'windows' | 'platform' | 'no-file' | 'disk-image' | 'translocated' | 'read-only' | 'other-copy'

export interface InPlaceFacts {
  platform: string
  arch: string
  /** website, store, preview or development (copySource). */
  source: string
  /** The update file the feed names for this computer, if any. */
  file: UpdateFile | null
  /** Mac: the running bundle's path (`/Applications/WriteFlex.app`); Windows: the folder holding the program. */
  appPath: string
  /** The bundle (or program folder) and the folder holding it can be written by this account. */
  writable: boolean
  /** The error code of the write check when it failed (EROFS on a disk image). */
  writeError?: string | null
  /** Mac: CFBundleIdentifier of the running app, or null when it could not be read. */
  bundleId: string | null
}

/** Why this copy cannot update itself in place, or null when it can. */
export function inPlaceRefusal(facts: InPlaceFacts): InPlaceRefusal | null {
  if (facts.source === 'store') return 'store'
  if (facts.source === 'development') return 'development'
  // No in-place install on Windows (ADR-0044 §1): the installer is not code-signed, so nothing could check its
  // publisher. The notice offers the download page instead.
  if (facts.platform === 'win32') return 'windows'
  if (!(facts.platform === 'darwin' && facts.arch === 'arm64')) return 'platform'
  if (!facts.file) return 'no-file'
  if (facts.appPath.includes('/AppTranslocation/')) return 'translocated'
  if (facts.appPath.startsWith('/Volumes/') && (facts.writeError === 'EROFS' || !facts.writable)) return 'disk-image'
  if (facts.writeError === 'EROFS') return 'disk-image'
  if (!facts.writable) return 'read-only'
  if (facts.file.bundleId !== undefined && facts.bundleId !== facts.file.bundleId) return 'other-copy'
  return null
}

export const REFUSAL_TEXT: Record<InPlaceRefusal, string> = {
  store: 'The Microsoft Store installs new versions of this copy.',
  development: 'This copy was started from source and does not update itself.',
  windows: 'In-place updates are not available on Windows yet.',
  platform: 'WriteFlex updates itself only on Apple silicon Macs.',
  'no-file': 'This version is only on the download page.',
  'disk-image': 'WriteFlex cannot replace itself here: it is running from a disk image. Move it to Applications and open it from there.',
  translocated: 'WriteFlex cannot replace itself here: macOS is running it from a temporary place. Move it to Applications and open it again.',
  'read-only': 'WriteFlex cannot replace itself here: this account cannot change the app’s folder.',
  'other-copy': 'WriteFlex cannot replace itself here: this copy was built for testing.',
}

// ── The words of the click ──────────────────────────────────────────────────────────────────────

export const FAIL_TEXT: Record<FailReason, string> = {
  network: 'The download stopped: github.com could not be reached.',
  mismatch: 'The downloaded file did not match the published one, so it was not used.',
  'wrong-version': 'The download was not the version offered, so it was not installed.',
  signature: 'The new version is not signed by WriteFlex’s developer, so it was not installed.',
  disk: 'There is not enough space on this Mac.',
  reopen: 'An earlier update was stopped part-way. Quit and reopen WriteFlex, then press Update again.',
  other: 'Something went wrong while installing.',
}

/** "275 MB" (decimal megabytes, as Finder shows them). */
export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const mb = bytes / 1_000_000
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`
}

/** Whole per cent of the download, 0 to 100. */
export const downloadPercent = (state: { received: number; total: number }): number =>
  state.total > 0 ? Math.max(0, Math.min(100, Math.floor((state.received / state.total) * 100))) : 0

/** The status-bar mark for the click's state, or null when the plain "is available" mark (or none) applies. */
export function installMarkText(state: InstallPhase): string | null {
  switch (state.phase) {
    case 'downloading': return `Downloading ${state.version} · ${downloadPercent(state)}%`
    case 'waiting': return 'Restart to finish updating'
    case 'restarting': return `Restarting into ${state.version}…`
    case 'failed': return `Update to ${state.version} failed`
    case 'reopen': return reopenText(state).mark
    default: return null
  }
}

/** What the person reads in the D4 state. Never "nothing will install" unless a withdrawal was checked (pending false). */
export function reopenText(state: { version: string; cause: ReopenCause; pending: boolean }): { mark: string; title: string; detail: string } {
  const why = state.cause === 'held'
    ? 'Something started that a restart would interrupt, so WriteFlex did not restart.'
    : state.cause === 'no-answer'
      ? `macOS did not finish preparing ${state.version} in time, so WriteFlex did not restart.`
      : `macOS could not finish installing ${state.version}, so WriteFlex did not restart.`
  if (!state.pending) return {
    mark: 'Reopen WriteFlex to update',
    title: 'Quit and reopen WriteFlex to update',
    detail: `${why} Nothing is installed when it quits. Quit and reopen WriteFlex, then press Update again.`,
  }
  if (state.cause === 'held') return {
    mark: `${state.version} installs when WriteFlex quits`,
    title: 'WriteFlex will finish updating when it next quits',
    detail: `${why} macOS has ${state.version} ready and installs it when you next quit WriteFlex.`,
  }
  return {
    mark: `${state.version} may install when WriteFlex quits`,
    title: 'WriteFlex may finish updating when it next quits',
    detail: `${why} The update may complete when you next quit WriteFlex. If WriteFlex then still opens as the old version, press Update again.`,
  }
}

/** The popover's foot under Update. */
export const updateFoot = (version: string, file: UpdateFile): string =>
  `Update downloads ${version} (${sizeText(file.size)}), replaces this copy and restarts WriteFlex. Your documents and settings stay as they are.`

/** The popover's foot when the download page is the way. */
export const DOWNLOAD_FOOT = 'Download opens the download page in your browser. Install it as you installed this one; your documents and settings stay as they are.'

/** The alpha switch's sentence in Settings › About and updates. */
export const ALPHA_HINT = 'Alphas come first and can break. To go back, switch this off: you keep this alpha until the next release, which then updates as usual. For an older version now, download it from writeflex.app.'

/** Appended to the shared "What the check sends" sentence. */
export const UPDATE_SENDS_TAIL = 'Only when you press Update does it download the new version from github.com.'
