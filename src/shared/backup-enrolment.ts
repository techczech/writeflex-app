/**
 * Automatic backup enrolment as the renderer sees it (main backup-helper/enrolment.ts). Types and constants
 * only: no Node, no IPC.
 *
 * The renderer names nothing: every call is about the sending window's own folder, which main resolves.
 * No vault id, path chosen by the renderer, socket, command, credential or remote address with credentials
 * crosses the bridge. The only argument is `enable`'s `{ previewId, confirmPublic }`: `previewId` is the
 * opaque token main issued with the preview the window showed. Main binds it to that window, its folder,
 * the remote repository and its visibility; it is used once, and anything that changed since makes it
 * void (the window must check again and show the new preview).
 */

export const BACKUP_ENROLMENT_CHANNELS = {
  status: 'backup-enrolment:status',
  preview: 'backup-enrolment:preview',
  enable: 'backup-enrolment:enable',
  disable: 'backup-enrolment:disable',
  confirmEarlier: 'backup-enrolment:confirm-earlier',
  /** Main → every window: enrolment changed; ask for a new receipt lifetime and status. */
  changed: 'backup-enrolment:changed',
} as const

/** A program or setting backup needs, as checked for this Mac. */
export type BackupPrerequisite = { name: 'git' | 'gitleaks' | 'helper' | 'credential'; ok: boolean; detail: string }

export type BackupHelperRun =
  | { state: 'running' | 'starting' | 'stopped' }
  | { state: 'restarting' | 'failed'; message: string | null }
  | { state: 'stop-overdue' }

export type BackupRemoteView = { kind: 'github'; repository: string } | { kind: 'local'; path: string } | { kind: 'unsupported'; display: string } | { kind: 'missing' }

export type BackupEnrolmentStatus =
  /** The window shows no folder. */
  | { state: 'no-folder' }
  /** Backup is off for this folder (the default). */
  | { state: 'off'; folder: string }
  | { state: 'on'; folder: string; remote: BackupRemoteView; publicConfirmed: boolean; helper: BackupHelperRun }
  /** Registered, but the folder no longer resolves to the place it was turned on for (moved, renamed or replaced by a link). Backup does not run there. */
  | { state: 'moved'; folder: string }
  /** `activation: 'unconfirmed'`: a Turn on in this session ended with its outcome unknown (see
   *  BackupEnrolmentResult `ok: null`); kept until this folder's status can be read again. */
  | { state: 'unavailable'; reason: string; activation?: 'unconfirmed' }

export type BackupEnrolmentPreview =
  | { state: 'refused'; folder: string | null; reason: string; prerequisites: BackupPrerequisite[] }
  | {
    state: 'ready'
    folder: string
    remote: BackupRemoteView
    visibility: 'private' | 'public' | 'unknown'
    /** Why visibility is unknown, in words; null when known. */
    visibilityProblem: string | null
    include: string[]
    exclude: string[]
    /** Every path the backup would send now (the first 2 000), never file contents. */
    files: { count: number; items: string[]; omitted: number }
    skipped: string[]
    unreadable: string[]
    prerequisites: BackupPrerequisite[]
    publication: { branchPrefix: string; userCommitsSent: false; problem: string | null }
    /** What still stops Turn on, in words; null when it can be turned on. */
    blocker: string | null
    needsPublicConfirmation: boolean
    /** Named versions of the vault's documents, as the helper's history projection would send them (the
     *  same selection and checks every backup applies). `included` only when the whole selection was read
     *  and checked: the version records, their restore points and snapshot entries, and every object they
     *  name. Otherwise `reason` says why and Turn on stays blocked. Pending changes and the review ledger
     *  are never part of it. */
    history:
      | { included: true; namedVersions: number; files: number; bytes: number }
      | { included: false; reason: string }
    earlierLocations?: { root: string; namedVersions: number }[]
    /** Main's opaque, single-use token for exactly this preview; `enable` needs it. */
    previewId: string
  }

/**
 * `ok: true` done; `ok: false` not done (known). `ok: null`, from enable only: the outcome is unknown. This
 * Mac could not tell whether turning backup on was recorded as finished, and undoing it did not complete,
 * so it is neither on nor off: its registration may remain, and backup may start for the folder once the
 * record of unfinished changes can be read again. Never shown as success or as off.
 */
export type BackupEnrolmentResult =
  | { ok: true; status: BackupEnrolmentStatus }
  | { ok: false; reason: string; status: BackupEnrolmentStatus }
  | { ok: null; reason: string; status: BackupEnrolmentStatus }

export type BackupEnableInput = { previewId: string; confirmPublic: boolean }

export const PREVIEW_ID = /^[0-9a-f]{32}$/

/** The one argument `enable` accepts, exactly. */
export function checkEnableInput(args: readonly unknown[]): BackupEnableInput | null {
  if (args.length !== 1) return null
  const x = args[0]
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const keys = Object.keys(x).sort()
  if (keys.length !== 2 || keys[0] !== 'confirmPublic' || keys[1] !== 'previewId') return null
  const { previewId, confirmPublic } = x as { previewId: unknown; confirmPublic: unknown }
  if (typeof confirmPublic !== 'boolean' || typeof previewId !== 'string' || !PREVIEW_ID.test(previewId)) return null
  return { previewId, confirmPublic }
}

export type BackupEarlierInput = { previewId: string; confirmEarlier: boolean }
export function checkEarlierInput(args: readonly unknown[]): BackupEarlierInput | null {
  if (args.length !== 1) return null
  const x = args[0]
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const keys = Object.keys(x).sort(), v = x as Record<string, unknown>
  if (keys.length !== 2 || keys[0] !== 'confirmEarlier' || keys[1] !== 'previewId' || typeof v.confirmEarlier !== 'boolean' || typeof v.previewId !== 'string' || !PREVIEW_ID.test(v.previewId)) return null
  return { previewId: v.previewId, confirmEarlier: v.confirmEarlier }
}
