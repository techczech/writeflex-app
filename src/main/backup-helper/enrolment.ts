/**
 * Automatic backup enrolment: which of this Mac's folders the backup helper serves, and the helper's
 * life while WriteFlex runs.
 *
 * - Off by default. Nothing here starts a process, reads a credential or opens a socket until a folder is
 *   registered; with none registered the app runs exactly as before (no helper, no timers, no scans).
 * - The user turns backup on for the sending window's own folder only (Settings › Backup). Main resolves
 *   the window's folder; the renderer names nothing. The folder must be the top folder of a Git checkout
 *   (trial-config.ts isGitWorktreeRoot); a folder inside one is refused, as is a cloud-synced folder or a
 *   network drive (the engine's own location rules, applied by the helper's preview and again by the engine
 *   on enable and on every operation).
 * - Registrations are machine-local, in `userData/backup-helper/registrations.json` (0600, written
 *   atomically and synced): folder, an id minted here, the GitHub repository confirmed at enrolment and
 *   whether public publication was confirmed. Nothing is written into the vault except what the engine
 *   itself keeps inside the checkout's `.git` folder; no id, path or credential travels with the vault.
 *   A damaged registrations file is never overwritten: backup stays off until it is fixed by hand.
 * - Before Turn on, the helper's `preview` reports the exact paths that would be sent, the scope, the
 *   remote and its visibility, and what is published (snapshots of those files only, in a chain separate
 *   from the user's own commits). `enable` refuses unless the programs are trusted, the remote is an HTTPS
 *   github.com repository or a local folder, and its visibility is private (or public and confirmed).
 * - A preview is bound in main: it gets an opaque single-use id, kept with the sending window, the binding
 *   of that window's folder (bumped when the window navigates, crashes, closes or binds a folder again,
 *   even the same one), the folder's real path, the remote repository, its visibility and the scope.
 *   `enable` consumes only that id, and only while all of it still holds: the folder is checked again
 *   after every wait, and a fresh helper check that finds another repository, another destination,
 *   another visibility or another scope voids it (the window must check again and show the new answer).
 *   Enable is run with the bound repository and the bound destination digest, so the engine compares the
 *   address it is about to pin with what was shown (local folder or GitHub), never with what it finds now.
 * - Effects are admitted, not just preceded by a check: the binding is asked synchronously immediately
 *   before the registration file's rename, the configuration file's rename and the helper's spawn, after
 *   every wait (durable-file.ts `admit`, supervisor.ts `start(…, admit)`). Withdrawn before the
 *   registration is published: nothing is registered and the engine switch this call made is removed.
 *   Withdrawn after it, or after a rename whose outcome is unknown (its folder sync or the rename itself
 *   failed: durable-file.ts WriteOutcomeUnknown), or when serving the new map throws: reconcile undoes
 *   only this attempt. It owns one entry, never a file: the entry it wrote carries a fresh `attempt` id,
 *   and reconcile removes exactly that entry (or puts back the entry it replaced) in the registrations
 *   file as it is NOW, keeping every other writer's additions and changes, then serves that current
 *   union (the copy guard stays a union until a helper is known gone). The engine switch is removed only
 *   when no registration for the folder exists now and none existed before this attempt. When the entry
 *   was changed by another writer it is theirs and is left alone; when the file is damaged or keeps
 *   changing, nothing is overwritten, the folder is held back and the answer says the undo is uncertain.
 * - Restart authority (activation-attempts.ts): every enable first records its attempt (id, folder, the
 *   entry it writes, the entry it replaces) durably, before the engine switch or the registration can
 *   change; the record goes only when the attempt was accepted (served, then the record removed) or its
 *   undo finished. Acceptance is the rename that removes the record, admitted by the binding immediately
 *   before it: from then on the attempt is accepted, whatever fails after it (see enable). A folder with a record is never served, in this session or after a restart: startup
 *   takes the attempt's own entry out of the file first and keeps the record until a later accepted Turn
 *   on or Turn off of the folder. A folder registered before the attempt keeps its earlier entry, held
 *   (the switch may carry the attempt's settings), until it is checked and turned on again. A record
 *   that cannot be read serves nothing. A registrations entry alone is never authority for an attempt.
 * - Registration updates are conditional: each one re-reads the current file and replaces it only if,
 *   synchronously immediately before the rename, the file still has the bytes it was computed from
 *   (another change in between: read again, a few times, then refuse). Ownership is cooperative:
 *   writers of this file are this process's serialised operations (one app instance per userData, its
 *   single-instance lock). The byte comparison narrows, but cannot close, the window for a program of
 *   the same user that ignores all of this and writes the file directly.
 * - Named versions ARE sent, as the helper's history projection (`history: writeflex-named-versions` in
 *   the helper configuration; src/backup-helper/history-projection.ts runs only in the separate WriteFlex
 *   helper process): the in-scope version records, their restore points and snapshot entries, and the
 *   objects they name, at their own paths and formats, checked as a whole. Agent sessions, other
 *   snapshots, pending changes and the review ledger are not. The preview shows the exact selection or
 *   why it cannot be read, and Turn on is blocked until it can; a helper without the projection refuses.
 * - Copy guard (active-services.ts setCopyGuard): from before the old helper is told to stop until a new
 *   helper is running and its services are built, every folder either helper may capture refuses the
 *   non-atomic copy route. It stays when a stop is overdue, a start does not reach running, or receipts
 *   are paused: a stopped receipt lane is not proof that no helper captures.
 * - Turning backup off runs the engine's `disable` (removes its per-folder switch only; backup branches,
 *   receipts and unprotected-edit records stay) and drops the registration.
 * - Each change rewrites the helper configuration (`helper-config.json`, version 2, 0600, atomic), stops
 *   the running helper, starts a new one, and only then rebuilds the control and receipt services for the
 *   registered folders (active-services.ts), so both lanes serve the same map and every window gets a new
 *   lifetime and owner. A registration whose folder no longer resolves to itself is left out and shown as
 *   moved; the engine refuses moved folders anyway.
 * - Programs: Git and gitleaks are taken from fixed trusted locations (never the shell PATH) and the helper
 *   checks their ownership, permissions and version before use. The GitHub credential is Git's
 *   macOS Keychain helper (`osxkeychain`); main never reads it.
 * Operations are serialised; a second one waits for the first.
 */
import { createEarlierLocations } from './earlier-locations'
import { WRITEFLEX_SCOPE } from '../../shared/backup-scope'
import { HISTORY_APPROVAL_BASENAME } from '../../backup-helper/history-approvals'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { BackupEarlierInput, BackupEnableInput, BackupEnrolmentPreview, BackupEnrolmentResult, BackupEnrolmentStatus, BackupHelperRun, BackupPrerequisite, BackupRemoteView } from '../../shared/backup-enrolment'
import { createActivationAttempts, type AttemptRecord } from './activation-attempts'
import type { ActiveBackupServices } from './active-services'
import { WriteOutcomeUnknown, WriteRefused, writeFileDurable } from './durable-file'
import { VAULT_ID } from './reply-check'
import type { HelperSupervisor, SupervisorState } from './supervisor'
import { BACKUP_HELPER_TRIAL_DISABLED, isGitWorktreeRoot, resolveBackupHelperTrial } from './trial-config'

/**
 * What WriteFlex backs up in an enrolled vault as ordinary files: authored documents and the vault's
 * settings file. The history files are never ordinary files: only the projection sends them, as a whole.
 */
/** The history projection every WriteFlex vault requires (src/backup-helper/history-projection.ts). */
export const WRITEFLEX_HISTORY = 'writeflex-named-versions'

export { WRITEFLEX_SCOPE }

/** How long a shown preview may be used to turn backup on. */
export const PREVIEW_TTL_MS = 10 * 60_000

export const GIT_CANDIDATES = ['/Library/Developer/CommandLineTools/usr/bin/git', '/Applications/Xcode.app/Contents/Developer/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git']
export const GITLEAKS_CANDIDATES = ['/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks']
/** sun_path on macOS, without its NUL. */
export const MAX_SOCKET_BYTES = 103
const CLIENT = 'WriteFlex'

/** `attempt`: the enable that wrote this entry (32 hex), so its undo can tell its own entry from another writer's. */
type Registration = { id: string; root: string; github: { repository: string } | null; local: string | null; publicConfirmed: boolean; enrolledAt: number; attempt?: string }
type RegistrationsFile = { schema: 1; machineId: string; vaults: Registration[] }
/** `text`: the file's bytes as read, the identity a conditional update compares (null when absent). */
type Loaded = { state: 'ok'; file: RegistrationsFile; text: string } | { state: 'absent'; text: null } | { state: 'damaged' }
const ATTEMPT_ID = /^[0-9a-f]{32}$/
const UPDATE_TRIES = 3

export type EnrolmentOptions = {
  /** `userData/backup-helper`. */
  dir: string
  windowRoot: (senderId: number) => string | null
  /** Absolute path of the helper's bin.js, or null when this build has none. */
  helperEntry: () => string | null
  /** Fixed trusted candidate locations; first existing file wins. Packaged resources may add one. */
  gitCandidates?: readonly string[]
  gitleaksCandidates?: readonly string[]
  credentialHelper?: string
  /** Supplying this enables host mode. Missing accepted identity then refuses; no ambient fallback. */
  githubBinding?: (vault: { id: string; root: string; repository: string | null }) => { repository: string; repositoryId: number } | null
  githubUncertainty?: () => boolean
  supervisor: HelperSupervisor
  services: ActiveBackupServices
  /** A short folder for the socket when `dir/run` would be too long. */
  shortRuntimeBase: string
  resolveReal?: (path: string) => Promise<string>
  isWorktreeRoot?: (realRoot: string) => Promise<boolean>
  now?: () => number
}

export type BackupEnrolment = {
  status(senderId: number): Promise<BackupEnrolmentStatus>
  preview(senderId: number): Promise<BackupEnrolmentPreview>
  enable(senderId: number, input: BackupEnableInput): Promise<BackupEnrolmentResult>
  confirmEarlier(senderId: number, input: BackupEarlierInput): Promise<BackupEnrolmentResult>
  disable(senderId: number): Promise<BackupEnrolmentResult>
  /** The window navigated, crashed, closed or bound a folder (even the same one): its preview is void. */
  retireSender(senderId: number): void
  /** At app start: serve the registered folders, if any. With none, does nothing at all. */
  startup(): Promise<void>
  /** App quit: ask the helper to stop; does not wait. */
  quit(): void
}

/**
 * The helper's runnable entry: the WriteFlex helper (src/backup-helper/writeflex-helper.ts, the generic
 * helper built with WriteFlex's named-version projection), bundled to one file by
 * scripts/build-backup-helper.ts. In a packaged app `Resources/vault-sync-helper/writeflex-backup-helper.js`
 * (staged by electron-builder outside app.asar); in development the built file under `out/backup-helper`.
 * Never a source file. The generic `bin.js` is not used: it refuses vaults that require named versions.
 */
export function backupHelperEntry(packaged: boolean, resourcesPath: string, appPath: string): string {
  return packaged ? join(resourcesPath, 'vault-sync-helper', 'writeflex-backup-helper.js') : join(appPath, 'out', 'backup-helper', 'writeflex-backup-helper.js')
}

const firstFile = (candidates: readonly string[]): string | null => {
  for (const c of candidates) {
    try { if (statSync(c).isFile()) return c } catch { /* next */ }
  }
  return null
}

const VISIBILITY_WORDS: Record<string, string> = {
  'no-credential': 'WriteFlex could not get a GitHub sign-in for this repository from the macOS Keychain',
  'no-credential-helper': 'not connected yet. Give WriteFlex access to this repository in the GitHub steps above, then check again',
  denied: 'GitHub refused the sign-in from the macOS Keychain',
  'not-found': 'GitHub does not show this repository to the signed-in account',
  redirected: 'GitHub answered with a redirect (the repository may have been renamed or moved)',
  'rate-limited': 'GitHub is limiting requests; try again later',
  network: 'GitHub could not be reached',
  'http-error': 'GitHub answered with an error',
  'unexpected-answer': 'GitHub gave an answer WriteFlex could not check',
  'other-repository': 'the remote is a different repository from the one backup was turned on for',
  'not-github-address': 'the remote is not a plain github.com address',
  'untrusted-credential-helper': 'the GitHub sign-in program could not be trusted (it, or a folder above it, can be changed by another user)',
  'unsupported-remote': 'the remote must be an HTTPS github.com repository or a local folder',
}

/** One registration entry, strictly; null when anything in it is not exactly valid. */
function parseRegistration(e: unknown): Registration | null {
  if (!e || typeof e !== 'object') return null
  const r = e as Record<string, unknown>
  const github = r.github === null ? null : (r.github && typeof r.github === 'object' && typeof (r.github as Record<string, unknown>).repository === 'string' ? { repository: (r.github as { repository: string }).repository } : undefined)
  const local = r.local === null ? null : typeof r.local === 'string' ? r.local : undefined
  if (typeof r.id !== 'string' || !VAULT_ID.test(r.id) || typeof r.root !== 'string' || !r.root.startsWith('/') || github === undefined || local === undefined || typeof r.publicConfirmed !== 'boolean' || !Number.isSafeInteger(r.enrolledAt)) return null
  if (r.attempt !== undefined && (typeof r.attempt !== 'string' || !ATTEMPT_ID.test(r.attempt))) return null
  return { id: r.id, root: r.root, github, local, publicConfirmed: r.publicConfirmed, enrolledAt: r.enrolledAt as number, ...(r.attempt !== undefined ? { attempt: r.attempt } : {}) }
}

function parseRegistrations(value: unknown): RegistrationsFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.schema !== 1 || typeof v.machineId !== 'string' || !VAULT_ID.test(v.machineId) || !Array.isArray(v.vaults) || v.vaults.length > 32) return null
  const vaults: Registration[] = []
  for (const e of v.vaults) {
    const r = parseRegistration(e)
    if (!r) return null
    vaults.push(r)
  }
  return { schema: 1, machineId: v.machineId, vaults }
}

const CHANGED_SINCE_PREVIEW = 'Something changed since this vault was checked. Check it again and review the new answer before turning backup on.'
const DAMAGED_FILE = 'The backup settings file of this Mac cannot be read; backup stays off.'
const ATTEMPTS_DAMAGED = 'The record of unfinished backup changes on this Mac cannot be read; backup stays off.'
/** Status of a folder whose Turn on, in this session, ended with its outcome unknown (enable `ok: null`). */
const UNCONFIRMED = 'Whether backup was turned on for this folder could not be confirmed: the record of unfinished backup changes on this Mac cannot be read, and undoing the attempt did not finish. Its backup settings may still be in place, so backup may start for this folder once that record can be read again, for example when WriteFlex next starts.'
const HELD_OWN = 'Turning backup on for this folder did not finish and could not be undone yet, so it is not backed up. WriteFlex finishes undoing it when it next starts; then turn backup on again here.'
const HELD_PRIOR = 'An attempt to change backup for this folder did not finish, so its earlier backup settings are kept but not used: it is not backed up until it is checked again and turned on.'
const msg = (error: unknown): string => String((error as Error)?.message ?? error).slice(0, 200)

/** The same entry, field for field (its `attempt` included): the one an attempt wrote is still there. */
const sameRegistration = (a: Registration, b: Registration): boolean =>
  a.id === b.id && a.root === b.root && a.attempt === b.attempt && a.publicConfirmed === b.publicConfirmed && a.enrolledAt === b.enrolledAt
  && a.local === b.local && (a.github?.repository ?? null) === (b.github?.repository ?? null)

function runView(s: SupervisorState): BackupHelperRun {
  if (s.state === 'running' || s.state === 'starting' || s.state === 'stopped') return { state: s.state }
  if (s.state === 'restarting' || s.state === 'failed') return { state: s.state, message: s.lastError }
  return { state: 'stop-overdue' }
}

export function createBackupEnrolment(options: EnrolmentOptions): BackupEnrolment {
  const resolveReal = options.resolveReal ?? realpath
  const isWorktreeRoot = options.isWorktreeRoot ?? isGitWorktreeRoot
  const now = options.now ?? Date.now
  const credentialHelper = options.credentialHelper ?? 'osxkeychain'
  const registrationsFile = join(options.dir, 'registrations.json')
  const earlierLocations = createEarlierLocations({ file: join(options.dir, HISTORY_APPROVAL_BASENAME), root: options.windowRoot, now, ttl: PREVIEW_TTL_MS })
  const configFile = join(options.dir, 'helper-config.json')
  const candidateFile = join(options.dir, 'candidate-config.json')
  let chain: Promise<unknown> = Promise.resolve()
  /** Folders registered but no longer resolving to themselves, from the last apply. */
  let moved = new Set<string>()
  /** Folders in the configuration the supervisor was last started with (it may still capture them). */
  let served = new Set<string>()
  /** The copy guard as last set (active-services.ts setCopyGuard). */
  let guard = new Set<string>()
  /**
   * Unfinished Turn on attempts (activation-attempts.ts), durable: written before an attempt's first effect,
   * removed only when it was accepted or completely undone. Their folders are never served (apply).
   */
  const attempts = createActivationAttempts<Registration>({ file: join(options.dir, 'activation-attempts.json'), ensureDir: () => privateDir(options.dir), parseEntry: parseRegistration })
  const setGuard = (roots: Iterable<string>): void => {
    guard = new Set(roots)
    options.services.setCopyGuard(guard)
  }
  /** Per window: its folder binding's number, bumped by retireSender. */
  const bindings = new Map<number, number>()
  const bindingOf = (senderId: number): number => bindings.get(senderId) ?? 0
  type BoundPreview = {
    id: string; senderId: number; binding: number; root: string; real: string; issuedAt: number
    machineId: string; reg: Registration; remote: string; destination: string; visibility: 'private' | 'public' | 'unknown'; scope: string; needsPublicConfirmation: boolean
  }
  /** The one preview each window was last shown. */
  const previews = new Map<number, BoundPreview>()
  /** Folders (real paths) whose Turn on ended with its outcome unknown in this session, until their status can be read again. */
  const unconfirmed = new Set<string>()
  const remoteKey = (r: BackupRemoteView): string => JSON.stringify(r.kind === 'github' ? { kind: 'github', repository: r.repository.toLowerCase() } : r)
  const scopeKey = (include: readonly string[], exclude: readonly string[]): string => JSON.stringify([include, exclude])
  const rootNow = (senderId: number): string | null => { try { return options.windowRoot(senderId) } catch { return null } }
  /** Synchronous: the window still has the binding and folder the preview was made for. */
  const sameBinding = (b: BoundPreview): boolean => bindingOf(b.senderId) === b.binding && rootNow(b.senderId) === b.root
  /** After a wait: the same binding, and its folder still resolves to the same real folder. */
  const stillCurrent = async (b: BoundPreview): Promise<boolean> => {
    if (!sameBinding(b)) return false
    let real: string | null
    try { real = await resolveReal(b.root) } catch { real = null }
    return real === b.real && sameBinding(b)
  }

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn)
    chain = next.catch(() => undefined)
    return next
  }

  async function privateDir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const info = await lstat(dir)
    const uid = process.getuid?.()
    if (!info.isDirectory() || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) throw new Error(`${dir} must be a private folder of this user (0700)`)
  }

  function parsed(text: string): Loaded {
    let file: RegistrationsFile | null = null
    try { file = parseRegistrations(JSON.parse(text)) } catch { file = null }
    return file ? { state: 'ok', file, text } : { state: 'damaged' }
  }

  async function load(): Promise<Loaded> {
    let text: string
    try { text = await readFile(registrationsFile, 'utf8') } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent', text: null } : { state: 'damaged' }
    }
    return parsed(text)
  }

  /** Synchronous: the file still has the bytes `loaded` was read from (asked immediately before a rename). */
  function unchangedSince(loaded: Loaded): boolean {
    if (loaded.state === 'damaged') return false
    try { return readFileSync(registrationsFile, 'utf8') === loaded.text } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && loaded.text === null
    }
  }

  type Updated = { outcome: 'written'; file: RegistrationsFile; from: Loaded } | { outcome: 'unchanged'; from: Loaded } | { outcome: 'damaged' } | { outcome: 'conflict' }
  /**
   * A conditional update of the registrations as they are now: `change` gets the current file and returns
   * the replacement, null for "leave it", or 'refuse'. Published only if the file still has the bytes
   * `change` saw, checked synchronously immediately before the rename together with `admit` (a no from
   * `admit` throws WriteRefused; another change makes it read again, then 'conflict'). A damaged file is
   * never passed to `change` and never overwritten. Errors of a rename whose outcome is unknown
   * (WriteOutcomeUnknown) are thrown as they are.
   */
  async function update(change: (current: Loaded & { state: 'ok' | 'absent' }) => RegistrationsFile | null | 'refuse', admit?: () => boolean): Promise<Updated> {
    for (let i = 0; i < UPDATE_TRIES; i++) {
      const current = await load()
      if (current.state === 'damaged') return { outcome: 'damaged' }
      const next = change(current)
      if (next === 'refuse') return { outcome: 'damaged' }
      if (next === null) return { outcome: 'unchanged', from: current }
      let moved = false
      try {
        await privateDir(options.dir)
        await writeFileDurable(registrationsFile, `${JSON.stringify(next, null, 2)}\n`, () => {
          if (admit && !admit()) return false
          moved = !unchangedSince(current)
          return !moved
        })
        return { outcome: 'written', file: next, from: current }
      } catch (error) {
        if (!(error instanceof WriteRefused) || !moved) throw error
      }
    }
    return { outcome: 'conflict' }
  }

  /** An unconditional-intent change (turn off) made conditional: the current file, `change`d. */
  async function save(change: (file: RegistrationsFile) => RegistrationsFile): Promise<Updated> {
    return update((current) => (current.state === 'ok' ? change(current.file) : null))
  }

  /**
   * Takes an attempt's own entry out of the registrations as they are now: removed, or the entry it
   * replaced put back, only while it is still field for field the one it wrote. `seen.mine` says whether it
   * was (set even when the write then throws).
   */
  function undoEntry(r: AttemptRecord<Registration>, seen: { mine: boolean }): Promise<Updated> {
    return update((current) => {
      if (current.state !== 'ok') return null
      const at = current.file.vaults.findIndex((v) => v.root === r.root)
      if (at < 0 || !sameRegistration(current.file.vaults[at]!, r.entry)) return null
      seen.mine = true
      const vaults = [...current.file.vaults]
      if (r.prior) vaults[at] = r.prior
      else vaults.splice(at, 1)
      return { ...current.file, vaults }
    })
  }

  function tools(): { git: string | null; gitleaks: string | null } {
    return { git: firstFile(options.gitCandidates ?? GIT_CANDIDATES), gitleaks: firstFile(options.gitleaksCandidates ?? GITLEAKS_CANDIDATES) }
  }

  function helperEntry(): string | null {
    const entry = options.helperEntry()
    if (!entry) return null
    try { return lstatSync(entry).isFile() ? entry : null } catch { return null }
  }

  /** Missing pieces this Mac must have before anything runs; names and fixed locations only. */
  function missing(): BackupPrerequisite[] {
    const t = tools()
    const entry = helperEntry()
    return [
      { name: 'helper', ok: entry !== null, detail: entry ? 'included with this WriteFlex build' : 'this WriteFlex build does not include the backup helper' },
      { name: 'git', ok: t.git !== null, detail: t.git ?? `Git was not found at ${GIT_CANDIDATES.slice(0, 2).join(' or ')} (install the Xcode Command Line Tools) or in Homebrew` },
      { name: 'gitleaks', ok: t.gitleaks !== null, detail: t.gitleaks ?? 'gitleaks was not found in Homebrew (/opt/homebrew/bin or /usr/local/bin); the secret check before every backup needs it' },
      { name: 'credential', ok: true, detail: options.githubBinding ? 'WriteFlex GitHub account and explicitly accepted repository required for GitHub origins' : 'GitHub sign-in from the macOS Keychain (Git credential helper osxkeychain)' },
    ]
  }

  function helperConfig(machineId: string, vaults: Registration[], git: string, gitleaks: string): unknown {
    return {
      configVersion: 2,
      machineId,
      tools: { git, gitleaks },
      ...(options.githubBinding ? {} : { credentialHelper }),
      vaults: vaults.map((v) => {
        const binding = options.githubBinding?.({ id: v.id, root: v.root, repository: v.github?.repository ?? null })
        if (v.github && binding && v.github.repository.toLowerCase() !== binding.repository.toLowerCase()) throw new Error('GitHub accepted binding changed')
        const repository = v.github?.repository ?? binding?.repository
        const github = options.githubBinding ? (repository ? { repository, credentialMode: 'host', repositoryId: binding?.repositoryId } : null) : v.github
        return { id: v.id, path: v.root, include: WRITEFLEX_SCOPE.include, exclude: WRITEFLEX_SCOPE.exclude, remote: 'origin', ...(github ? { github } : {}), history: WRITEFLEX_HISTORY }
      }),
    }
  }

  async function writeConfig(file: string, value: unknown, admit?: () => boolean): Promise<void> {
    await privateDir(options.dir)
    await writeFileDurable(file, `${JSON.stringify(value, null, 2)}\n`, admit)
  }

  /** A runtime folder whose socket path fits sun_path: `dir/run`, else a short per-user folder. */
  async function runtimeDir(): Promise<string> {
    for (const dir of [join(options.dir, 'run'), options.shortRuntimeBase]) {
      if (Buffer.byteLength(join(dir, 'helper.sock')) > MAX_SOCKET_BYTES) continue
      await privateDir(dir)
      return dir
    }
    throw new Error('no runtime folder short enough for the helper socket')
  }

  /** The folder the window shows, as its real path, when it is a checkout's top folder. */
  async function windowFolder(senderId: number): Promise<{ root: string; real: string | null; topLevel: boolean } | null> {
    let root: string | null
    try { root = options.windowRoot(senderId) } catch { root = null }
    if (!root) return null
    let real: string | null
    try { real = await resolveReal(root) } catch { real = null }
    return { root, real, topLevel: real !== null && (await isWorktreeRoot(real)) }
  }

  /**
   * Serves the registered folders: config, helper, then services. With none, everything is off.
   * `admit` (an enable's binding) is asked after the old helper's stop, immediately before the
   * configuration's rename and the helper's spawn, and after the spawn and the services: 'withdrawn' as
   * soon as it says no, and the caller reconciles. Without `admit` it always answers 'applied'.
   */
  async function apply(loaded: Loaded, admit?: () => boolean, exempt?: string): Promise<'applied' | 'withdrawn'> {
    // A folder with an unfinished attempt is never served; only the enable now finishing it (`exempt`) is.
    // An unreadable attempts record serves nothing at all.
    const pending = await attempts.load()
    const held = pending.state === 'ok' ? new Set(pending.attempts.map((r) => r.root).filter((r) => r !== exempt)) : null
    const regs = loaded.state === 'ok' && held ? loaded.file.vaults.filter((r) => !held.has(r.root)) : []
    const live: Registration[] = []
    const gone = new Set<string>()
    for (const r of regs) {
      let real: string | null
      try { real = await resolveReal(r.root) } catch { real = null }
      if (real === r.root && (await isWorktreeRoot(real))) live.push(r)
      else gone.add(r.root)
    }
    moved = gone
    const liveRoots = live.map((r) => r.root)
    // Before anything changes: every folder the old helper serves and every folder the new one will serve
    // refuses the copy route, until a helper is known to be gone or a new receipt instance serves it.
    setGuard([...guard, ...served, ...liveRoots])
    // Old lanes are retired before the helper they talk to is replaced.
    await options.services.configure(BACKUP_HELPER_TRIAL_DISABLED)
    const stopped = await options.supervisor.stop()
    // An overdue stop: the old helper may still capture; nothing is started and the guard stays.
    if (stopped.state !== 'stopped') return 'applied'
    served = new Set()
    if (admit && !admit()) return 'withdrawn'
    const t = tools()
    const entry = helperEntry()
    if (loaded.state !== 'ok' || live.length === 0 || !t.git || !t.gitleaks || !entry) { if (!options.githubUncertainty?.()) setGuard([]); return 'applied' }
    try {
      await writeConfig(configFile, helperConfig(loaded.file.machineId, live, t.git, t.gitleaks), admit)
    } catch (error) {
      if (error instanceof WriteRefused) return 'withdrawn'
      throw error
    }
    const run = await runtimeDir()
    served = new Set(liveRoots)
    setGuard(served)
    let refused = false
    const started = await options.supervisor.start(configFile, run, admit ? () => (refused = !admit()) === false : undefined)
    if (refused) { served = new Set(); return 'withdrawn' }
    // Withdrawn while the helper started: the caller stops it again (reconcile).
    if (admit && !admit()) return 'withdrawn'
    // Not running (yet): the supervisor may still start it later, so its folders stay guarded.
    if (started.state !== 'running') return 'applied'
    const trial = await resolveBackupHelperTrial({ enabled: true, socketPath: join(run, 'helper.sock'), client: CLIENT, vaults: live.map((r) => ({ root: r.root, vaultId: r.id })) })
    // Receipts paused: the guard stays. Configured: the new instance refuses the copy route for its folders.
    if ((await options.services.configure(trial)) === 'configured' && !options.githubUncertainty?.()) setGuard([])
    return admit && !admit() ? 'withdrawn' : 'applied'
  }

  async function statusNow(senderId: number): Promise<BackupEnrolmentStatus> {
    const loaded = await load()
    const pending = loaded.state === 'damaged' ? null : await attempts.load()
    if (!pending || pending.state === 'damaged') {
      // Not "stays off" for a folder whose Turn on ended unknown: its registration may remain.
      if (unconfirmed.size > 0) {
        const root = rootNow(senderId)
        let real: string | null = null
        if (root) try { real = await resolveReal(root) } catch { real = null }
        if (real !== null && unconfirmed.has(real)) return { state: 'unavailable', reason: UNCONFIRMED, activation: 'unconfirmed' }
      }
      return { state: 'unavailable', reason: pending ? ATTEMPTS_DAMAGED : DAMAGED_FILE }
    }
    const folder = await windowFolder(senderId)
    if (!folder) return { state: 'no-folder' }
    // Both files read: this folder's status is known again.
    if (folder.real !== null) unconfirmed.delete(folder.real)
    const reg = loaded.state === 'ok' ? loaded.file.vaults.find((v) => v.root === folder.real || v.root === folder.root) : undefined
    if (!reg) return { state: 'off', folder: folder.root }
    const open = pending.attempts.filter((r) => r.root === reg.root)
    if (open.length > 0) return { state: 'unavailable', reason: open.some((r) => sameRegistration(r.entry, reg)) ? HELD_OWN : HELD_PRIOR }
    if (moved.has(reg.root) || folder.real !== reg.root) return { state: 'moved', folder: folder.root }
    const remote: BackupRemoteView = reg.github ? { kind: 'github', repository: reg.github.repository } : { kind: 'local', path: reg.local ?? '' }
    return { state: 'on', folder: folder.root, remote, publicConfirmed: reg.publicConfirmed, helper: runView(options.supervisor.state()) }
  }

  type HelperPreview = {
    root: string | null; refused: string | null
    tools: Record<'git' | 'gitleaks', { path: string; version: string } | { error: string }>
    remote: BackupRemoteView; visibility: 'private' | 'public' | 'unknown'; visibilityReason: string | null
    scope: { include: string[]; exclude: string[] }; files: { count: number; items: string[]; omitted: number }
    destinationDigest?: string | null
    history?: { name: string; state: 'complete'; files: number; bytes: number; summary?: Record<string, number> } | { name: string; state: 'unavailable'; reason: string } | null
    skipped: string[]; unreadable: string[]; enabled: boolean
    publication: { branchPrefix: string; block: { message: string } | null }
  }

  /** Only the response shape used below; failure text never includes any part of stdout. */
  function previewShape(value: unknown): value is HelperPreview {
    const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)
    const strings = (v: unknown): boolean => Array.isArray(v) && v.every(x => typeof x === 'string')
    const tool = (v: unknown): boolean => record(v) && (typeof v.error === 'string' || (typeof v.path === 'string' && typeof v.version === 'string'))
    if (!record(value)) return false
    const p = value
    return record(p.tools) && tool(p.tools.git) && tool(p.tools.gitleaks)
      && (p.refused === null || typeof p.refused === 'string')
      && record(p.remote) && ['github', 'local', 'missing', 'unsupported'].includes(p.remote.kind)
      && ['private', 'public', 'unknown'].includes(p.visibility)
      && record(p.scope) && strings(p.scope.include) && strings(p.scope.exclude)
      && record(p.files) && Number.isSafeInteger(p.files.count) && strings(p.files.items) && Number.isSafeInteger(p.files.omitted)
      && strings(p.skipped) && strings(p.unreadable)
      && record(p.publication) && typeof p.publication.branchPrefix === 'string'
      && (p.publication.block === null || (record(p.publication.block) && typeof p.publication.block.message === 'string'))
  }

  /** Runs one helper command against a configuration naming only this folder. */
  async function oneShot(command: 'preview' | 'enable' | 'disable', machineId: string, reg: Registration, extra: string[] = []): Promise<{ code: number | null; json: unknown; stderr: string; diagnostic: string }> {
    const t = tools()
    if (!t.git || !t.gitleaks) return { code: null, json: null, stderr: 'git or gitleaks is missing', diagnostic: `${command}: helper did not run` }
    await writeConfig(candidateFile, helperConfig(machineId, [reg], t.git, t.gitleaks))
    try {
      const out = await options.supervisor.runOnce([command, '--config', candidateFile, '--vault', reg.id, ...extra])
      let json: unknown = null
      let format = 'unexpected response'
      try { json = JSON.parse(out.stdout) } catch { format = out.stdout.length === 0 ? 'empty response' : 'invalid or incomplete JSON' }
      // Metadata only: parse exceptions can include fragments of private stdout on modern Node.
      const diagnostic = `${command}: ${format} (${Buffer.byteLength(out.stdout, 'utf8')} bytes received; exit ${out.code ?? 'unknown'})`
      return { code: out.code, json, stderr: out.stderr, diagnostic }
    } finally {
      await unlink(candidateFile).catch(() => undefined)
    }
  }

  function prerequisitesFrom(p: HelperPreview | null): BackupPrerequisite[] {
    const base = missing()
    if (!p) return base
    return base.map((x) => {
      if (x.name !== 'git' && x.name !== 'gitleaks') return x
      const t = p.tools[x.name]
      return 'error' in t ? { name: x.name, ok: false, detail: t.error } : { name: x.name, ok: true, detail: `${x.name} ${t.version} at ${t.path}` }
    })
  }

  type Checked = { preview: BackupEnrolmentPreview; machineId: string; reg: Registration | null; helper: HelperPreview | null; folder: { root: string; real: string } | null; destination?: string | null }
  /** The helper's check of the window's folder. `keep` reuses the ids a bound preview minted. */
  async function previewNow(senderId: number, keep?: { machineId: string; reg: Registration }): Promise<Checked> {
    const loaded = await load()
    const folder = await windowFolder(senderId)
    const refused = (reason: string, prereq = missing()): Checked => ({ preview: { state: 'refused' as const, folder: folder?.root ?? null, reason, prerequisites: prereq }, machineId: '', reg: null, helper: null, folder: null })
    if (loaded.state === 'damaged') return refused('The backup settings file of this Mac cannot be read; backup stays off.')
    if (!folder) return refused('Open a vault in this window first.')
    if (!folder.real) return refused('This folder cannot be found.')
    if (!folder.topLevel) return refused('Backup works on the top folder of a Git checkout. This folder is not one, or is a folder inside one.')
    const prereq = missing()
    const lacking = prereq.find((p) => !p.ok)
    if (lacking) return refused(lacking.detail, prereq)
    const machineId = loaded.state === 'ok' ? loaded.file.machineId : keep?.machineId ?? `wf-${randomBytes(6).toString('hex')}`
    const existing = loaded.state === 'ok' ? loaded.file.vaults.find((v) => v.root === folder.real) : undefined
    const reg: Registration = existing ?? (keep && keep.reg.root === folder.real ? keep.reg : { id: `v-${randomBytes(8).toString('hex')}`, root: folder.real, github: null, local: null, publicConfirmed: false, enrolledAt: now() })
    const out = await oneShot('preview', machineId, { ...reg, github: null })
    const p = out.json as HelperPreview | null
    if (out.code !== 0 || !previewShape(p)) return refused(`The backup helper could not check this folder: ${out.diagnostic}${out.stderr ? `; ${out.stderr}` : '.'}`)
    const prerequisites = prerequisitesFrom(p)
    if (p.refused) return { ...refused(p.refused, prerequisites), machineId }
    const remote = p.remote
    const visibilityProblem = p.visibility === 'unknown' ? VISIBILITY_WORDS[p.visibilityReason ?? ''] ?? 'whether the repository is private could not be checked' : null
    const h = p.history
    // Only the helper's checked projection counts; anything else is not included, never assumed.
    const history: Extract<BackupEnrolmentPreview, { state: 'ready' }>['history'] = h && h.state === 'complete' && h.name === WRITEFLEX_HISTORY
      && Number.isSafeInteger(h.files) && Number.isSafeInteger(h.bytes)
      ? { included: true, namedVersions: Number.isSafeInteger(h.summary?.namedVersions) ? h.summary!.namedVersions! : 0, files: h.files, bytes: h.bytes }
      : { included: false, reason: h && h.state === 'unavailable' ? h.reason : 'this backup helper cannot read named versions' }
    const destination = typeof p.destinationDigest === 'string' && /^[0-9a-f]{64}$/.test(p.destinationDigest) ? p.destinationDigest : null
    const blocker = prerequisites.find((x) => !x.ok)?.detail
      ?? (remote.kind === 'missing' ? 'This checkout has no remote named origin to back up to.' : null)
      ?? (remote.kind === 'unsupported' ? VISIBILITY_WORDS['unsupported-remote']! : null)
      ?? (p.visibility === 'unknown' ? `Backup stays off: ${visibilityProblem}.` : null)
      ?? (p.publication.block ? p.publication.block.message : null)
      ?? (destination === null && (remote.kind === 'github' || remote.kind === 'local') ? 'The backup helper did not identify the remote it would back up to.' : null)
      ?? (history.included ? null : `Named versions cannot be backed up: ${history.reason}. Backup is held until they can.`)
    const preview: BackupEnrolmentPreview = {
      state: 'ready', folder: folder.root, remote, visibility: p.visibility, visibilityProblem,
      include: p.scope.include, exclude: p.scope.exclude, files: p.files, skipped: p.skipped, unreadable: p.unreadable,
      prerequisites, publication: { branchPrefix: p.publication.branchPrefix, userCommitsSent: false, problem: p.publication.block?.message ?? null },
      blocker, needsPublicConfirmation: p.visibility === 'public',
      history,
      previewId: '',
    }
    return { preview, machineId, reg: { ...reg, github: remote.kind === 'github' ? { repository: remote.repository } : null, local: remote.kind === 'local' ? remote.path : null }, helper: p, folder: { root: folder.root, real: folder.real }, destination }
  }

  return {
    status: (senderId) => serial(() => statusNow(senderId)),

    preview: (senderId) => serial(async (): Promise<BackupEnrolmentPreview> => {
      previews.delete(senderId)
      earlierLocations.retire(senderId)
      const binding = bindingOf(senderId)
      const checked = await previewNow(senderId)
      if (checked.preview.state !== 'ready' || !checked.reg || !checked.folder || !checked.destination) return checked.preview
      const bound: BoundPreview = {
        id: randomBytes(16).toString('hex'), senderId, binding, root: checked.folder.root, real: checked.folder.real, issuedAt: now(),
        machineId: checked.machineId, reg: checked.reg, remote: remoteKey(checked.preview.remote), destination: checked.destination, visibility: checked.preview.visibility,
        scope: scopeKey(checked.preview.include, checked.preview.exclude), needsPublicConfirmation: checked.preview.needsPublicConfirmation,
      }
      // The window moved on while the helper looked: what it would be shown is not about its folder now.
      if (!(await stillCurrent(bound))) return { state: 'refused', folder: rootNow(senderId), reason: CHANGED_SINCE_PREVIEW, prerequisites: checked.preview.prerequisites }
      const scope = { include: checked.preview.include, exclude: checked.preview.exclude }
      const earlier = !checked.preview.history.included ? await earlierLocations.inspect(bound.real, scope) : undefined
      if (!(await stillCurrent(bound))) return { state: 'refused', folder: rootNow(senderId), reason: CHANGED_SINCE_PREVIEW, prerequisites: checked.preview.prerequisites }
      if (earlier) earlierLocations.bind(senderId, bound.id, bound.root, bound.real, scope, earlier)
      previews.set(senderId, bound)
      return { ...checked.preview, previewId: bound.id, ...(earlier ? { earlierLocations: earlier.roots } : {}) }
    }),

    confirmEarlier: (senderId, input) => serial(async () => {
      previews.delete(senderId)
      const ok = await earlierLocations.confirm(senderId, input)
      return ok ? { ok: true, status: await statusNow(senderId) } : { ok: false, reason: 'Earlier locations could not be confirmed. Check this vault again.', status: await statusNow(senderId) }
    }),

    enable: (senderId, input) => serial(async (): Promise<BackupEnrolmentResult> => {
      const fail = async (reason: string): Promise<BackupEnrolmentResult> => ({ ok: false, reason, status: await statusNow(senderId) })
      // Single use: whatever happens next, this preview cannot be used again.
      const bound = previews.get(senderId)
      earlierLocations.retire(senderId)
      previews.delete(senderId)
      if (!bound || bound.id !== input.previewId || now() - bound.issuedAt > PREVIEW_TTL_MS || now() < bound.issuedAt) return fail(CHANGED_SINCE_PREVIEW)
      if (!(await stillCurrent(bound))) return fail(CHANGED_SINCE_PREVIEW)
      const fresh = await previewNow(senderId, { machineId: bound.machineId, reg: bound.reg })
      if (!(await stillCurrent(bound))) return fail(CHANGED_SINCE_PREVIEW)
      const { preview } = fresh
      if (preview.state !== 'ready' || !fresh.reg) return fail(preview.state === 'refused' ? preview.reason : 'Backup cannot be turned on here.')
      // Another repository, visibility, scope, folder or id than the one shown: never applied silently.
      if (remoteKey(preview.remote) !== bound.remote || fresh.destination !== bound.destination || preview.visibility !== bound.visibility || scopeKey(preview.include, preview.exclude) !== bound.scope
        || fresh.machineId !== bound.machineId || fresh.reg.id !== bound.reg.id || fresh.reg.root !== bound.real) return fail(CHANGED_SINCE_PREVIEW)
      if (preview.blocker) return fail(preview.blocker)
      if (bound.needsPublicConfirmation && !input.confirmPublic) return fail('This repository is public. Confirm that drafts may be published there first.')
      const confirmPublic = bound.needsPublicConfirmation && input.confirmPublic
      const before = await load()
      if (before.state === 'damaged') return fail('The backup settings file of this Mac cannot be read; backup stays off.')
      /** The entry this attempt replaces, if any (its owner keeps the switch), fixed before any effect. */
      const prior = (before.state === 'ok' ? before.file.vaults.find((v) => v.root === bound.real) : undefined) ?? null
      // The registration as shown: its repository is the bound one, which the helper's enable rechecks.
      const reg: Registration = { ...bound.reg, publicConfirmed: confirmPublic }
      // This attempt's own entry: `attempt` tells it apart from any other writer's entry for the folder.
      const mine: Registration = { ...reg, attempt: randomBytes(16).toString('hex') }
      const intent: AttemptRecord<Registration> = { attempt: mine.attempt!, root: reg.root, entry: mine, prior, at: now() }
      // Recorded durably before the engine switch or the registration can change: until this record is
      // removed the attempt is unfinished, here and after any restart. Not recorded: nothing is done.
      try {
        const added = await attempts.add(intent)
        if (added !== 'written') return fail(added === 'full' ? 'Too many unfinished attempts to turn backup on are recorded on this Mac; backup cannot be turned on now.' : ATTEMPTS_DAMAGED)
      } catch (error) {
        await attempts.retire((r) => r.attempt === intent.attempt).catch(() => undefined)
        return fail(`Backup was not turned on: this Mac could not record the attempt first (${msg(error)}).`)
      }
      const retireThis = () => attempts.retire((r) => r.attempt === intent.attempt)
      /** Nothing of this attempt took effect: its record goes (left behind, it only holds the folder back). */
      const unchanged = async (reason: string): Promise<BackupEnrolmentResult> => { await retireThis().catch(() => undefined); return fail(reason) }
      if (!(await stillCurrent(bound))) return unchanged(CHANGED_SINCE_PREVIEW)
      /** Who holds the folder's registration NOW: nobody, this attempt (its entry unchanged), another writer. */
      const ownerNow = async (): Promise<'none' | 'mine' | 'other' | 'unknown'> => {
        const current = await load()
        if (current.state === 'damaged') return 'unknown'
        const entry = current.state === 'ok' ? current.file.vaults.find((v) => v.root === reg.root) : undefined
        return !entry ? 'none' : sameRegistration(entry, mine) ? 'mine' : 'other'
      }
      /**
       * Removes the engine switch this call made, only when no registration for the folder existed before
       * this attempt and none but this attempt's own exists now (another writer's registration owns its
       * switch). Returns a problem to report, or null.
       */
      const undoSwitch = async (): Promise<string | null> => {
        if (prior) return null
        const owner = await ownerNow()
        if (owner === 'other') return null
        if (owner === 'unknown') return 'the backup settings file cannot be read, so the backup switch this attempt made was left as it is'
        try {
          const out = await oneShot('disable', bound.machineId, reg)
          const answer = out.json as { disabled?: boolean } | null
          return out.code === 0 && answer?.disabled !== false ? null : `the backup switch this attempt made could not be removed${out.stderr ? ` (${out.stderr.slice(0, 200)})` : ''}`
        } catch (error) {
          return `the backup switch this attempt made could not be removed (${msg(error)})`
        }
      }
      /**
       * Undoes this attempt after its engine switch may have changed (`published`: its entry may also be in
       * the file). Only this attempt: its entry, if still exactly as written, is removed (or the entry it
       * replaced put back) in the file as it is now; every other entry stays; the current union is served
       * again, without this folder while its record stays; then the switch (only when the folder had no
       * registration before). The record is removed only when all of that finished. When the folder had a
       * registration before, its switch may now carry this attempt's settings: the earlier entry is kept but
       * held (not served) until a later Turn on or Turn off. Failures are reported, not hidden.
       */
      const settle = async (reason: string, published: boolean, cause?: unknown, label = 'the settings write failed', outcomeUnknown = false): Promise<BackupEnrolmentResult> => {
        const problems: (string | null)[] = cause ? [`${label} (${msg(cause)})`] : []
        const seen = { mine: false }
        let removed = false
        let entryGone = !published
        if (published) {
          try {
            const done = await undoEntry(intent, seen)
            removed = done.outcome === 'written'
            entryGone = removed || done.outcome === 'unchanged'
            if (done.outcome === 'damaged') problems.push('the backup settings file cannot be read, so it was not changed')
            if (done.outcome === 'conflict') problems.push('the backup settings file kept changing, so it was not changed')
          } catch (error) {
            problems.push(`the backup settings file could not be put right (${msg(error)})`)
          }
        }
        if (published || prior) {
          try {
            // Serve the registrations as they are now; apply keeps the guard a union until a helper is gone.
            await apply(await load())
          } catch (error) {
            problems.push(`the backup helper could not be restarted for the other folders (${msg(error)})`)
          }
        }
        // Removed, or left in the file but still this attempt's own: the engine switch this attempt made goes.
        const switchProblem = !published || removed || seen.mine ? await undoSwitch() : null
        problems.push(switchProblem)
        if (prior) problems.push('this folder\'s earlier backup settings are kept but not used until it is checked again')
        else if (entryGone && switchProblem === null) {
          try {
            const r = await retireThis()
            if (r !== 'written' && r !== 'unchanged') problems.push('the record of this attempt could not be cleared, so the folder is held until backup is turned on again')
          } catch (error) {
            problems.push(`the record of this attempt could not be cleared (${msg(error)})`)
          }
        }
        const left = problems.filter((p): p is string => p !== null)
        const text = left.length === 0 ? reason : `${reason} Undoing this attempt is uncertain: ${left.join('; ')}.`
        // Outcome unknown and not proven undone (this attempt's entry out of the file and its switch removed,
        // with no earlier entry whose switch it may have changed): neither failed nor on, and its status says
        // so until it can be read. A record that only could not be cleared serves nothing on its own.
        if (outcomeUnknown && !(entryGone && switchProblem === null && !prior)) {
          unconfirmed.add(reg.root)
          return { ok: null, reason: text, status: await statusNow(senderId) }
        }
        return fail(text)
      }
      let out: Awaited<ReturnType<typeof oneShot>>
      try {
        // The engine pins the destination only when it is the one shown (its digest), local folder or GitHub.
        out = await oneShot('enable', bound.machineId, reg, ['--expected-destination', bound.destination, ...(confirmPublic ? ['--confirm-public'] : [])])
      } catch (error) {
        return settle('Backup was not turned on.', false, error, 'the backup helper could not be asked')
      }
      const answer = out.json as { enabled?: boolean; reason?: string } | null
      if (!answer || answer.enabled !== true) return unchanged(answer?.reason ? `Backup was not turned on: ${answer.reason}.` : `Backup was not turned on: ${out.diagnostic}${out.stderr ? `; ${out.stderr}` : '.'}`)
      const loaded = await load()
      // The window left the folder while the helper worked: undo the engine's switch this call made.
      if (loaded.state === 'damaged' || !(await stillCurrent(bound))) return settle(loaded.state === 'damaged' ? DAMAGED_FILE : CHANGED_SINCE_PREVIEW, false)
      const admit = (): boolean => sameBinding(bound)
      let published: RegistrationsFile
      try {
        // Conditional on the file as read and admitted immediately before the rename, after every wait.
        const done = await update((current) => {
          const file: RegistrationsFile = current.state === 'ok' ? current.file : { schema: 1, machineId: bound.machineId, vaults: [] }
          const replaced = file.vaults.find((v) => v.root === reg.root) ?? null
          // The entry replaced must be the one the record names, or the undo could not put it back.
          if (replaced === null ? prior !== null : prior === null || !sameRegistration(replaced, prior)) return null
          return { ...file, vaults: [...file.vaults.filter((v) => v.root !== reg.root), mine] }
        }, admit)
        if (done.outcome !== 'written') return settle(done.outcome === 'damaged' ? DAMAGED_FILE : CHANGED_SINCE_PREVIEW, false)
        published = done.file
      } catch (error) {
        // Refused before the rename: nothing was published.
        if (error instanceof WriteRefused) return settle(CHANGED_SINCE_PREVIEW, false)
        // The rename was attempted: the entry may be what the next start reads (its record makes it unfinished).
        if (error instanceof WriteOutcomeUnknown && !admit()) return settle(CHANGED_SINCE_PREVIEW, true, error)
        throw error
      }
      if (!admit()) return settle(CHANGED_SINCE_PREVIEW, true)
      let applied: 'applied' | 'withdrawn'
      try {
        applied = await apply({ state: 'ok', file: published, text: '' }, admit, reg.root)
      } catch (error) {
        if (!admit()) return settle(CHANGED_SINCE_PREVIEW, true, error)
        throw error
      }
      if (applied === 'withdrawn' || !admit()) return settle(CHANGED_SINCE_PREVIEW, true)
      // Acceptance. The commit point is the rename that removes this attempt's record (and any older
      // unfinished one for this folder, superseded now), admitted by the binding synchronously immediately
      // before it, after every wait. Before that rename nothing is accepted: refused, failed, or the file
      // damaged or changing, the record stays and the attempt is undone like a withdrawal (restart holds
      // the folder whatever the undo manages). Once the rename has returned, the attempt is accepted and
      // never reported as failed: a folder sync failing after it (or the window going away) cannot withdraw
      // it, since withdrawing would need a further write. Its durability is then that of the rename alone:
      // a power loss may bring the record back, and then the folder is held (shown off, never served) until
      // turned on again. A rename whose own outcome is unknown is classified by reading the record back.
      const NOT_RECORDED = 'Backup was not turned on: this Mac could not record that turning it on finished.'
      try {
        const r = await attempts.retire((x) => x.root === reg.root, admit)
        if (r !== 'written' && r !== 'unchanged') return settle(NOT_RECORDED, true, new Error(r === 'damaged' ? 'the record of unfinished changes cannot be read' : 'the record of unfinished changes kept changing'), 'the record could not be updated')
      } catch (error) {
        if (error instanceof WriteRefused) return settle(CHANGED_SINCE_PREVIEW, true)
        const after = !(error instanceof WriteOutcomeUnknown) ? 'held' : error.renamed ? 'released' : attempts.holds(intent.attempt)
        if (after === 'held') return settle(NOT_RECORDED, true, error, 'the record could not be updated')
        // Unknown both ways (the rename failed and the record cannot be read back): undone as far as the disk
        // allows. Undone completely: not turned on. Otherwise the outcome stays unknown (`ok: null`): a later
        // start may serve it, so it is reported as neither failed nor on.
        if (after === 'unknown') return settle('Backup may not have been turned on: this Mac could not tell whether it recorded that turning it on finished.', true, error, 'the record could not be read back', true)
      }
      return { ok: true, status: await statusNow(senderId) }
    }),

    disable: (senderId) => serial(async (): Promise<BackupEnrolmentResult> => {
      const loaded = await load()
      const folder = await windowFolder(senderId)
      if (loaded.state !== 'ok' || !folder) return { ok: false, reason: 'Backup is not on for this folder.', status: await statusNow(senderId) }
      const reg = loaded.file.vaults.find((v) => v.root === folder.real || v.root === folder.root)
      if (!reg) return { ok: false, reason: 'Backup is not on for this folder.', status: await statusNow(senderId) }
      // The window's folder as it was when asked; another folder by now is not turned off for it.
      if (rootNow(senderId) !== folder.root) return { ok: false, reason: CHANGED_SINCE_PREVIEW, status: await statusNow(senderId) }
      previews.delete(senderId)
      // Only this folder's entry goes, from the file as it is now; other writers' entries stay.
      const done = await save((file) => ({ ...file, vaults: file.vaults.filter((v) => v.root !== reg.root) }))
      if (done.outcome === 'damaged' || done.outcome === 'conflict') return { ok: false, reason: done.outcome === 'damaged' ? DAMAGED_FILE : 'The backup settings file kept changing; try again.', status: await statusNow(senderId) }
      // The helper stops serving the folder first; then the engine's switch is removed (when the folder is still there).
      await apply(done.outcome === 'written' ? { state: 'ok', file: done.file, text: '' } : done.from)
      let switchOff = !(folder.real === reg.root && existsSync(reg.root))
      if (!switchOff) switchOff = (await oneShot('disable', loaded.file.machineId, reg)).code === 0
      // Turned off with its switch removed: no unfinished attempt for the folder is left to undo.
      if (switchOff) await attempts.retire((r) => r.root === reg.root).catch(() => undefined)
      return { ok: true, status: await statusNow(senderId) }
    }),

    startup: () => serial(async () => {
      // Unfinished attempts first, before anything is served: never taken as accepted. Each one's own entry
      // is taken out of the file as it is now (or the entry it replaced put back); nothing else changes, no
      // helper command runs, and its record stays, so apply holds its folder back. A record that cannot be
      // read serves nothing (apply).
      const pending = await attempts.load()
      if (pending.state === 'ok') for (const r of pending.attempts) await undoEntry(r, { mine: false }).catch(() => undefined)
      const loaded = await load()
      // Nothing registered: no helper, no timers, no scans, no credential lookup.
      if (loaded.state !== 'ok' || loaded.file.vaults.length === 0) return
      await apply(loaded)
    }),

    retireSender(senderId) {
      earlierLocations.retire(senderId)
      bindings.set(senderId, bindingOf(senderId) + 1)
      previews.delete(senderId)
    },

    quit() {
      options.supervisor.stopNow()
    },
  }
}
