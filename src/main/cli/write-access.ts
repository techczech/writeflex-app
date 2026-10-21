/**
 * What an operation that writes is given, and the conditions under which it gets it:
 *
 * 1. The root was chosen by the user: named with `--root`, or found by climbing AND on the app's own
 *    list of opened Collections. A marker folder alone (it may have arrived in a download) is not
 *    enough to change files.
 * 2. No app owns the Collection. The command line takes the owner lock for the length of the
 *    operation and gives it up on success, on refusal and on a thrown error. When an app does own
 *    it, the write is not made here at all: `chooseWriteRoute` says so and the command line files a
 *    request for the app instead (request-route.ts).
 * 3. The lock is confirmed again before each file is written; `withOwnerLock` does not stop an
 *    operation whose lock was taken, so the WriteSession asks.
 *
 * WHAT A DIRECT WRITE NEEDS BESIDES THE COLLECTION. A change to an existing file or path is recorded
 * for undo in application data (journal.ts), so that folder must be writable too; when it is not, the
 * change is refused before anything is touched, with the folder to allow. A write that changes
 * nothing existing (a new file, a new folder, the Trash) keeps no record, writes nothing there, and
 * is not refused for it. With the app open the command line writes only its request, in the
 * Collection's inbox, and reads the reply key: nothing in application data is written from here.
 *
 * The owner lock decides the route and nothing else. It is a file inside the Collection, so it is
 * never what makes a reply from the app trusted (reply-key.ts is).
 *
 * A failed operation is put back from what the session remembers before the lock is released, while
 * the lock is still this command's. ONCE THE LOCK IS ANOTHER'S, NOTHING IS WRITTEN, PUTTING BACK
 * INCLUDED: the command stops, keeps its write-ahead record in application data, and says what it had
 * changed and what it had not; `writeflex undo` finishes the job from that record once the
 * Collection is free (write-session.ts states which system call can still land, and why).
 *
 * One write is not a document's and does not go through the session: saving a version, which goes to
 * the app's history stores through their own code (`saveVersion`; history-store.ts), under the same
 * lock, confirmed again before each store is written.
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { standardRecordsPlace, type RecordsPlace, type VariantFolder } from '../collection-records'
import { REPLY_KEY_FOLDER } from '../reply-key'
import { inspectOwnerLock, OwnerLockBusyError, OwnerLockFolderError, refreshOwnerLock, withOwnerLock, type OwnerLockEnv } from '../owner-lock'
import { WritesPausedError } from '../collection-write-gate'
import { VersionSaveRefused, type SavedTextVersion } from '../saved-text-version'
import { followRenamesInLedger, saveVersionFromCommandLine, type VersionSaveInput } from './history-store'
import { leaveFollowSignal } from '../sharing-follow-signals'
import type { WriteSeams } from './guarded-fs'
import { CommandLineWorkspace } from './guarded-workspace'
import { Journal, type JournalSeams } from './journal'
import type { IntentLog } from './journal-intent'
import type { Workspace } from '../workspace'
import { CliError } from './operation'
import { appSettingsFiles, openedCollections } from './opened-collections'
import type { CollectionRoot } from './root'
import { removeStaleTemporaryFiles } from './stale-temporary-files'
import { systemTrash, type TrashMover } from './system-trash'
import { WriteSession, WritingWorkspace, type SessionStep } from './write-session'

/** How long to wait for another `writeflex` command to finish with the Collection. */
const OTHER_COMMAND_WAIT_MS = 5000

/** Test seams and surroundings; production passes nothing. */
export type WriteEnv = {
  /** The app settings files that list opened Collections. Default: the user's own, under `home`. */
  settingsFiles?: string[]
  home?: string
  trash?: TrashMover
  now?: () => Date
  seams?: WriteSeams
  lockEnv?: OwnerLockEnv
  /** The folders that may hold a Collection's reply key (reply-key.ts). Default: beside each of `settingsFiles`. */
  keyFolders?: string[]
  /** How long to wait for the app's reply to a request, and how often to look. Default 10 s, 100 ms. */
  request?: { waitMs?: number; pollMs?: number }
  /** The application-data folders the undo journal and the app's records are kept under
   *  (collection-records.ts): this process's own first, which is the only one written; the rest are
   *  read. Default: the standard ones under `home`, `variant`'s first. */
  appDataFolders?: string[]
  /** Which app this command line belongs to (the bundle it runs from; writeflex-cli.ts). Default: the release app. */
  variant?: VariantFolder
  /** The journal's entry limit in bytes. Default 64 MiB. */
  maxJournalEntryBytes?: number
  /** Test seams of the undo journal (journal.ts). */
  journalSeams?: JournalSeams
}

/** Where this run keeps and reads records outside the Collection (collection-records.ts). */
export function recordsPlace(env: WriteEnv): RecordsPlace {
  if (env.appDataFolders?.length) return { own: env.appDataFolders[0], others: env.appDataFolders.slice(1) }
  return standardRecordsPlace(env.home ?? homedir(), env.variant)
}

export type WriteAccess = {
  /** Reads are guarded and every save goes through `session` (write-session.ts). */
  workspace: Workspace
  session: WriteSession
  journal: Journal
  trash: TrashMover
  now: () => Date
  /** Record what the session changed. Returns the journal id to undo it by, or null when no existing
   *  file or path was changed (a new file is not journalled: undo never deletes). */
  commit: (summary: string) => Promise<string | null>
  /** Save a version of a document's saved text into the app's history stores (saved-text-version.ts).
   *  The one write that is not a document's: it goes to the stores' own code, by whoever holds the
   *  Collection (the app for a request, the command line under its lock), never through `session`. */
  saveVersion: (input: VersionSaveInput) => Promise<SavedTextVersion>
  /** The command line under its own lock only: the review ledger's undecided outside Changes follow
   *  `moves` (history-store.ts `followRenamesInLedger`). Returns how many moved. Absent when the app
   *  carries out a request: the app follows its own ledger (request-executor.ts). */
  followLedger?: (moves: Array<{ from: string; to: string }>) => Promise<number>
  /** True when the app is carrying this out for a request: the app then looks after its own review ledger. */
  byApp?: boolean
  /** Sharing (ticket 04): told what a move or a Trash finished, so a link follows its piece or ends.
   *  The app carrying out a request tells its publisher; the command line under its own lock leaves a
   *  signal for the app (sharing-follow-signals.ts). Returns a line to add to the result, or null. */
  sharing?: SharingFollow
}

export type SharingFollow = {
  moved: (moves: Array<{ from: string; to: string }>) => Promise<string | null>
  trashed: (paths: string[]) => Promise<string | null>
}

const APP_OPEN = 'WriteFlex opened this Collection while the command was starting, so nothing was changed. Run the command again: it will be passed to WriteFlex to carry out.'
const DENIED = new Set(['EACCES', 'EPERM', 'EROFS'])

function assertChosenRoot(found: CollectionRoot, env: WriteEnv): void {
  if (found.source === 'given') return
  if (openedCollections(env.settingsFiles ?? appSettingsFiles(env.home ?? homedir())).has(found.root)) return
  throw new CliError(
    `${found.root} was found by looking upwards from the current folder, and WriteFlex has never opened it (it is not among the app's recent or pinned Collections), `
    + `so the command line will not change it. To change it, name it: writeflex --root "${found.root}" <operation>.`,
    'refused', 'root-not-chosen',
  )
}

/** A refusal in plain words for the failures a write can meet; anything else passes through. */
function explained(error: unknown, root: string): unknown {
  if (error instanceof CliError) return error
  if (error instanceof OwnerLockBusyError) {
    return new CliError(error.owner?.kind === 'command-line' ? 'Another writeflex command is changing this Collection. Try again in a moment.' : APP_OPEN, 'refused', error.owner?.kind === 'command-line' ? 'command-busy' : 'app-opened-meanwhile')
  }
  // `.writeflex` is a link or a file: the Collection cannot be owned, so nothing in it is changed.
  if (error instanceof OwnerLockFolderError) return new CliError(`Nothing was changed: this Collection cannot be marked as in use, because ${error.message}`, 'refused', 'write-not-permitted')
  if (error instanceof WritesPausedError) return new CliError(error.message, 'refused', 'writes-paused')
  if (error instanceof VersionSaveRefused) return new CliError(error.message, 'refused', error.code)
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code && DENIED.has(code)) {
    return new CliError(`The command line is not allowed to write in this Collection (${code}). If it runs in a sandbox, allow writing to this folder: ${root}`, 'refused', 'write-not-permitted')
  }
  return error
}

class OwnerLockLostError extends CliError {
  constructor() {
    super('WriteFlex or another program took over this Collection while the command was running, so it stopped.', 'refused', 'owner-lock-lost')
  }
}

const listed = (items: string[]): string => items.join('; ')

/** What a session had done when it was stopped, in words, each path once per kind of step. */
function stepsInWords(steps: SessionStep[]): string[] {
  const words = steps.map((step) => (step.did === 'moved' ? `${step.path} was moved to ${step.to}`
    : step.did === 'rewrote' ? `${step.path} was rewritten`
      : step.did === 'created' ? `${step.path} was created`
        : step.did === 'made-folder' ? `the folder ${step.path} was made`
          : step.did === 'trashed' ? `${step.path} was moved to the Trash`
            : `${step.path}, a second name of one file, was removed`))
  return [...new Set(words)]
}

/**
 * The refusal for an operation that lost the Collection partway (`lost` is what the ownership check
 * said): what took it, what had been changed, what had not, that nothing further was written, and
 * where the change is on record. `recorded` is the intent's id when existing files or paths were
 * changed, so there is something for undo to act on.
 */
function stoppedPartway(parts: AccessParts, steps: SessionStep[], stoppedAt: string | undefined, failure: unknown, lost: unknown, recorded: string | null): CliError {
  const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  const took = parts.byApp
    ? 'WriteFlex stopped holding this Collection partway through this request (another program or another Mac took the folder over), so the request stopped.'
    : 'WriteFlex or another program took over this Collection partway through, so the command stopped.'
  // A failure of another kind came first, and the Collection was found taken when putting back began.
  const first = said(failure) === said(lost) ? '' : `${said(failure)} Then, before anything was put back: `
  const done = `Already changed: ${listed(stepsInWords(steps))}.`
  const notDone = stoppedAt === undefined
    ? 'Whatever else it would have changed was not changed.'
    : `Not changed: ${stoppedAt}, which it was about to write when it stopped, and whatever it would have changed after that.`
  const where = recorded === null
    ? 'No existing document or path was changed, so there is nothing to undo: what was newly made stays, and can be moved to the Trash.'
    : parts.operation === 'undo'
      ? 'The undo is on record as not finished: run "writeflex undo --list" to see it, and "writeflex undo" again to finish it, or leave it, once the Collection is free.'
      : `The change is on record as interrupted (${recorded}): run "writeflex undo --list" to see it, and "writeflex undo ${recorded}" to put it back once the Collection is free.`
  return new CliError(`${first}${took} ${done} ${notDone} Nothing further was written, and nothing was put back. ${where}`, 'failed', 'owner-lock-lost')
}

/** Where the app (release or beta) keeps reply keys: in its application-data folder, beside its settings file. */
export function replyKeyFolders(env: WriteEnv): string[] {
  return env.keyFolders ?? (env.settingsFiles ?? appSettingsFiles(env.home ?? homedir())).map((file) => join(dirname(file), REPLY_KEY_FOLDER))
}

/** What one operation is run with: a session to write through, the Workspace it sees, where it records. */
export type AccessParts = {
  root: string
  operation: string
  session: WriteSession
  workspace: Workspace
  journal: Journal
  /** The write-ahead record the session was given. */
  intent?: IntentLog
  trash: TrashMover
  now: () => Date
  saveVersion: WriteAccess['saveVersion']
  followLedger?: WriteAccess['followLedger']
  byApp?: boolean
  sharing?: SharingFollow
}

/**
 * Run `work` with write access built from `parts`, and settle the journal whatever happens: a change
 * that finished is recorded; a failed one is put back from what the session remembers, and reported
 * as refused. Shared by the command line writing under its own lock and by the app carrying out a
 * request (request-executor.ts), so both keep the same promise about a failure partway:
 *  - while the Collection is still this owner's, every file that holds exactly what the operation
 *    wrote is put back, and a file somebody has written since is left and named;
 *  - once the Collection is another's, nothing is written at all. The intent stays on record and the
 *    failure (`owner-lock-lost`) says what had been changed and where to undo it.
 */
export async function runWithAccess<T>(parts: AccessParts, work: (access: WriteAccess) => Promise<T>): Promise<T> {
  const { root, operation, session, journal, intent } = parts
  const access: WriteAccess = {
    workspace: parts.workspace, session, journal, trash: parts.trash, now: parts.now, saveVersion: parts.saveVersion,
    ...(parts.followLedger ? { followLedger: parts.followLedger } : {}), ...(parts.byApp ? { byApp: true } : {}),
    ...(parts.sharing ? { sharing: parts.sharing } : {}),
    commit: async (summary) => {
      if (!session.changedExisting) return null
      const entry = await journal.record(operation, summary, session.record(), intent)
      session.forget()
      return entry.id
    },
  }
  try {
    const result = await work(access)
    // An operation that changed existing files and did not say so is still recorded, never left as interrupted.
    if (intent?.started && session.changedExisting) await access.commit(operation)
    return result
  } catch (error) {
    const failure = explained(session.firstFailure ?? error, root)
    const changed = session.changedExisting
    const steps = session.steps
    const back = await session.rollback()
    if (back.lost !== undefined) {
      // Not this owner's Collection any more: rollback wrote nothing from the moment it found out.
      // An intent that announces nothing that happened is removed (application data, not the Collection).
      if (intent && !changed) await journal.abandon(intent).catch(() => {})
      if (steps.length === 0) throw failure
      throw stoppedPartway(parts, steps, session.stoppedAt, failure, explained(back.lost, root), changed && intent?.started ? intent.id : null)
    }
    const { problems } = back
    // Everything is back as it was: nothing is left to undo. Otherwise the intent stays, as an interrupted change.
    if (intent && problems.length === 0) await journal.abandon(intent).catch(() => {})
    if (!changed) throw failure
    const message = failure instanceof Error ? failure.message : String(failure)
    throw new CliError(problems.length
      ? `${message} Not everything could be put back: ${problems.join('; ')}.${intent?.started ? ' What is left is on record as an interrupted change: run "writeflex undo --list".' : ''}`
      : `${message} Nothing was left changed: every file and path the command had touched was put back.`)
  }
}

/**
 * Who carries out a write to this Collection: the app that has it open (`app`: the command line
 * files a request and writes nothing else), or the command line itself under the owner lock
 * (`direct`). Refuses a root the user did not choose before either.
 */
export async function chooseWriteRoute(found: CollectionRoot, env: WriteEnv): Promise<'app' | 'direct'> {
  assertChosenRoot(found, env)
  try {
    const status = await inspectOwnerLock(found.root, env.lockEnv)
    return status.state === 'held' && status.owner?.kind !== 'command-line' ? 'app' : 'direct'
  } catch (error) {
    throw explained(error, found.root)
  }
}

/** Sharing (ticket 04): the command line, with the app not holding the Collection, leaves the signal in application data. */
function commandLineSharingFollow(root: string, env: WriteEnv): SharingFollow {
  // The settings files beside the application-data folders this run uses (a test's own), else the user's.
  const files = env.settingsFiles ?? (env.appDataFolders?.length ? env.appDataFolders.map((folder) => join(folder, 'settings.json')) : appSettingsFiles(env.home ?? homedir()))
  return {
    moved: (moves) => leaveFollowSignal(files, { root, moved: moves, trashed: [] }),
    trashed: (paths) => leaveFollowSignal(files, { root, moved: [], trashed: paths }),
  }
}

/** Run `work` holding the Collection, with the one route by which it may be changed. */
export async function withWriteAccess<T>(found: CollectionRoot, env: WriteEnv, operation: string, work: (access: WriteAccess) => Promise<T>): Promise<T> {
  assertChosenRoot(found, env)
  const { root } = found
  try {
    return await withOwnerLock(root, { ...env.lockEnv, kind: 'command-line', waitMs: OTHER_COMMAND_WAIT_MS }, async (lock) => {
      // What an earlier write left when it was killed between writing a temporary file and renaming it.
      await removeStaleTemporaryFiles(root, { now: env.now })
      const journal = new Journal(root, recordsPlace(env), { now: env.now, maxEntryBytes: env.maxJournalEntryBytes, ...(env.journalSeams ? { seams: env.journalSeams } : {}) })
      // Undo is not journalled as a change (there is no undo of an undo), but it leaves an intent like
      // any other, naming the entry it undoes, so that an undo killed partway can be finished (journal.ts).
      const intent = journal.begin(operation)
      const confirmOwner = async (): Promise<void> => {
        // Rewrites the heartbeat; `lost` means another owner's record is in the lock file now.
        const state = await refreshOwnerLock(lock).catch(() => 'lost' as const)
        if (state === 'lost') throw new OwnerLockLostError()
      }
      const guarded = new CommandLineWorkspace(root)
      const session = new WriteSession(guarded, { seams: env.seams, intent, confirmOwner })
      return runWithAccess({
        root, operation, session, journal, intent, workspace: new WritingWorkspace(root, session),
        trash: env.trash ?? systemTrash, now: env.now ?? (() => new Date()),
        saveVersion: async (input) => {
          await env.seams?.beforeWrite?.(input.path)
          return saveVersionFromCommandLine(guarded, confirmOwner, input, { afterCheck: env.seams?.betweenCheckAndWrite })
        },
        followLedger: (moves) => followRenamesInLedger(guarded, confirmOwner, moves),
        sharing: commandLineSharingFollow(root, env),
      }, work)
    })
  } catch (error) {
    throw explained(error, root)
  }
}
