import { replicaRecoveryDir } from '../replica-save-cycles'
import { COMMAND_STORE_GRACE_MS } from '../document-write-versions'
import { withFolioTitleIdentity } from '../folio-title-write'
/**
 * What an operation that writes is given, and the conditions under which it gets it:
 *
 * 1. The root was chosen by the user: named with `--root`, or found by climbing AND on the app's own
 *    list of opened Collections. A marker folder alone (it may have arrived in a download) is not
 *    enough to change files.
 * 2. WriteFlex on THIS computer does not have the Collection open. When it does (its reply key and
 *    presence record in its own application-data folder say so: reply-key.ts), the write is not made
 *    here at all: `chooseWriteRoute` says so and the command line files a request for the app instead
 *    (request-route.ts).
 *
 * THERE IS NO COLLECTION LOCK. Nothing inside the Collection, and nothing synced from another
 * computer, decides whether this command may write; a leftover `.writeflex/owner.lock` from an older
 * WriteFlex is neither read nor removed. Each file is still written only if it holds what the
 * operation read (guarded-fs.ts and write-session.ts: the fingerprint and outside-change checks), and
 * existing files are journalled for undo. The contract:
 * docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md.
 *
 * WHAT A DIRECT WRITE NEEDS BESIDES THE COLLECTION. A change to an existing file or path is recorded
 * for undo in application data (journal.ts), so that folder must be writable too; when it is not, the
 * change is refused before anything is touched, with the folder to allow. A write that changes
 * nothing existing (a new file, a new folder, the Trash) keeps no record, writes nothing there, and
 * is not refused for it. With the app open the command line writes only its request, in the
 * Collection's inbox, and reads the reply key: nothing in application data is written from here.
 *
 * A failed operation is put back from what the session remembers: every file that still holds exactly
 * what the operation wrote is put back, and a file somebody has written since is left and named.
 *
 * One write is not a document's and does not go through the session: saving a version, which goes to
 * the app's history stores through their own code (`saveVersion`; history-store.ts).
 */
import { withFolioNotices } from '../folio-declaration'
import { settleVersionMoves } from '../version-moves'
import { reattachVersionHistory, type HistoryRequest, type HistoryResult } from '../version-history-reattach'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { standardRecordsPlace, type RecordsPlace, type VariantFolder } from '../collection-records'
import { REPLY_KEY_FOLDER, appHasCollectionOpen } from '../reply-key'
import type { LocalProcessSeams } from '../local-process'
import { WritesPausedError } from '../collection-write-gate'
import { FolderNotUsableError, privateFolder } from './request-files'
import { VersionSaveRefused, type SavedTextVersion } from '../saved-text-version'
import { followRenamesInLedger, saveFolioVersionFromCommandLine, saveVersionFromCommandLine, type VersionSaveInput } from './history-store'
import type { RevisionImportInput } from '../requested-folio-revision'
import type { WithdrawResult } from '../folio-version-stage'
import type { ImportCommitAnswer } from '../../shared/folio-version-import'
import type { FolioSaveInput, SavedFolioVersion } from '../folio-version-save'
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

/** Test seams and surroundings; production passes nothing. */
export type WriteEnv = {
  /** The app settings files that list opened Collections. Default: the user's own, under `home`. */
  settingsFiles?: string[]
  home?: string
  trash?: TrashMover
  now?: () => Date
  seams?: WriteSeams
  /** Test seam: how a running app's process is judged (local-process.ts). */
  processSeams?: LocalProcessSeams
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
  history?: (request: HistoryRequest) => Promise<HistoryResult>
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
   *  The one write that is not a document's: it goes to the stores' own code, by whoever carries the
   *  write out (the app for a request, otherwise the command line), never through `session`. */
  saveVersion: (input: VersionSaveInput) => Promise<SavedTextVersion>
  /** Save a Folio version (folio-version-save.ts): the same stores and the Folio journal beside them. Never settles a change. */
  saveFolioVersion: (input: FolioSaveInput) => Promise<SavedFolioVersion>
  /**
   * Bring in a co-author's Word revision and stage its changes as suggestions in the parts' margins (folio-version-import.ts, ticket 15), and
   * take a staged revision back. Both are the APP's: the suggestions live in the window's review ledger beside the margins the writer decides in,
   * so they are carried out only when WriteFlex has the Collection open (a request); written directly, they are refused with a sentence.
   */
  importRevision: (input: RevisionImportInput) => Promise<ImportCommitAnswer>
  withdrawRevision: (id: string) => Promise<WithdrawResult>
  /** The command line writing directly only: the review ledger's undecided outside Changes follow
   *  `moves` (history-store.ts `followRenamesInLedger`). Returns how many moved. Absent when the app
   *  carries out a request: the app follows its own ledger (request-executor.ts). */
  followLedger?: (moves: Array<{ from: string; to: string }>) => Promise<number>
  /** True when the app is carrying this out for a request: the app then looks after its own review ledger. */
  byApp?: boolean
  /** Sharing (ticket 04): told what a move or a Trash finished, so a link follows its piece or ends.
   *  The app carrying out a request tells its publisher; the command line writing directly leaves a
   *  signal for the app (sharing-follow-signals.ts). Returns a line to add to the result, or null. */
  sharing?: SharingFollow
}

export type SharingFollow = {
  moved: (moves: Array<{ from: string; to: string }>) => Promise<string | null>
  trashed: (paths: string[]) => Promise<string | null>
}

/** The suggestions of a revision live in WriteFlex's review ledger, beside the margins the writer decides in: no other process stages them. */
const NEEDS_THE_APP = 'A revision is staged as suggestions in WriteFlex, so WriteFlex has to have this Collection open. Open it there and run the command again. Nothing was changed.'

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
  // Path containment: `.writeflex` is a link or a file, or lies outside the Collection.
  if (error instanceof FolderNotUsableError) return new CliError(`Nothing was changed: ${error.message}`, 'refused', 'write-not-permitted')
  if (error instanceof WritesPausedError) return new CliError(error.message, 'refused', 'writes-paused')
  if (error instanceof VersionSaveRefused) return new CliError(error.message, 'refused', error.code)
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code && DENIED.has(code)) {
    return new CliError(`The command line is not allowed to write in this Collection (${code}). If it runs in a sandbox, allow writing to this folder: ${root}`, 'refused', 'write-not-permitted')
  }
  return error
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
 * The refusal for a request the app stopped partway because its window closed the Collection (`lost`
 * is what the open-Collection check said): why it stopped, what had been changed, what had not, that nothing further was written, and
 * where the change is on record. `recorded` is the intent's id when existing files or paths were
 * changed, so there is something for undo to act on.
 */
function stoppedPartway(parts: AccessParts, steps: SessionStep[], stoppedAt: string | undefined, failure: unknown, lost: unknown, recorded: string | null): CliError {
  const said = (error: unknown): string => (error instanceof Error ? error.message : String(error))
  const took = parts.byApp
    ? 'WriteFlex closed this Collection partway through this request, so the request stopped.'
    : 'The command was stopped partway through.'
  // A failure of another kind came first, and the Collection was found taken when putting back began.
  const first = said(failure) === said(lost) ? '' : `${said(failure)} Then, before anything was put back: `
  const done = `Already changed: ${listed(stepsInWords(steps))}.`
  const notDone = stoppedAt === undefined
    ? 'Whatever else it would have changed was not changed.'
    : `Not changed: ${stoppedAt}, which it was about to write when it stopped, and whatever it would have changed after that.`
  const where = recorded === null
    ? 'No existing document or path was changed, so there is nothing to undo: what was newly made stays, and can be moved to the Trash.'
    : parts.operation === 'undo'
      ? 'The undo is on record as not finished: run "writeflex undo --list" to see it, and "writeflex undo" again to finish it, or leave it.'
      : `The change is on record as interrupted (${recorded}): run "writeflex undo --list" to see it, and "writeflex undo ${recorded}" to put it back.`
  return new CliError(`${first}${took} ${done} ${notDone} Nothing further was written, and nothing was put back. ${where}`, 'failed', 'collection-closed')
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
  saveFolioVersion: WriteAccess['saveFolioVersion']
  importRevision: WriteAccess['importRevision']
  withdrawRevision: WriteAccess['withdrawRevision']
  history?: WriteAccess['history']
  followLedger?: WriteAccess['followLedger']
  byApp?: boolean
  sharing?: SharingFollow
}

/**
 * Run `work` with write access built from `parts`, and settle the journal whatever happens: a change
 * that finished is recorded; a failed one is put back from what the session remembers, and reported
 * as refused. Shared by the command line writing directly and by the app carrying out a request
 * (request-executor.ts), so both keep the same promise about a failure partway:
 *  - every file that holds exactly what the operation wrote is put back, and a file somebody has
 *    written since is left and named;
 *  - for a request, once the app has closed the Collection nothing is written at all. The intent
 *    stays on record and the failure (`collection-closed`) says what had been changed and where to
 *    undo it.
 */
export async function runWithAccess<T>(parts: AccessParts, work: (access: WriteAccess) => Promise<T>): Promise<T> {
  const { root, operation, session, journal, intent } = parts
  const titleNotices: string[] = []
  const titleWorkspace = withFolioTitleIdentity(parts.workspace, {
    onWarning: message => { titleNotices.push(message); if (parts.byApp) parts.workspace.announceWriteNotice(message) },
    onLinked: () => { const message = "WriteFlex now links this Folio's chapters to their files"; titleNotices.push(message); if (parts.byApp) parts.workspace.announceWriteNotice(message) },
  })
  const access: WriteAccess = {
    ...(parts.history ? { history: parts.history } : {}),
    workspace: titleWorkspace, session, journal, trash: parts.trash, now: parts.now, saveVersion: parts.saveVersion, saveFolioVersion: parts.saveFolioVersion, importRevision: parts.importRevision, withdrawRevision: parts.withdrawRevision,
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
    let { result, notices } = await withFolioNotices(() => work(access))
    const versionNotices = [...new Set(session.unkeptVersions)].map((path) =>
      `${path} was written, but its new text was not kept as a version, not even on this Mac. Keep a copy before sync replaces it.`)
    notices = [...notices, ...titleNotices, ...versionNotices]
    if (notices.length && result && typeof result === 'object') {
      result = { ...result, notices,
        ...('text' in result && typeof result.text === 'string' ? { text: `${result.text}\n${notices.join('\n')}` } : {}),
        ...('data' in result && result.data && typeof result.data === 'object' ? { data: { ...result.data, notices } } : {}),
      }
    }
    // An operation that changed existing files and did not say so is still recorded, never left as interrupted.
    if (intent?.started && session.changedExisting) await access.commit(operation)
    return result
  } catch (error) {
    const failure = explained(session.firstFailure ?? error, root)
    const changed = session.changedExisting
    const steps = session.steps
    const back = await session.rollback()
    if (back.lost !== undefined) {
      // The app closed the Collection under a request: rollback wrote nothing from the moment it found out.
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
 * Who carries out a write to this Collection: WriteFlex on this computer, when it has the Collection
 * open (`app`: the command line files a request and writes nothing else), or the command line itself
 * (`direct`). Decided from this computer's own application data only (reply-key.ts
 * `appHasCollectionOpen`), never from anything in the Collection or synced from another computer.
 * Refuses a root the user did not choose before either.
 */
export async function chooseWriteRoute(found: CollectionRoot, env: WriteEnv): Promise<'app' | 'direct'> {
  assertChosenRoot(found, env)
  return (await appHasCollectionOpen(replyKeyFolders(env), found.root, env.processSeams)) ? 'app' : 'direct'
}

/** Sharing (ticket 04): the command line, with the app not having the Collection open, leaves the signal in application data. */
function commandLineSharingFollow(root: string, env: WriteEnv): SharingFollow {
  // The settings files beside the application-data folders this run uses (a test's own), else the user's.
  const files = env.settingsFiles ?? (env.appDataFolders?.length ? env.appDataFolders.map((folder) => join(folder, 'settings.json')) : appSettingsFiles(env.home ?? homedir()))
  return {
    moved: (moves) => leaveFollowSignal(files, { root, moved: moves, trashed: [] }),
    trashed: (paths) => leaveFollowSignal(files, { root, moved: [], trashed: paths }),
  }
}

/** Run `work` writing the Collection directly, through the one guarded route by which it may be changed. */
export async function withWriteAccess<T>(found: CollectionRoot, env: WriteEnv, operation: string, work: (access: WriteAccess) => Promise<T>): Promise<T> {
  assertChosenRoot(found, env)
  const { root } = found
  try {
    return await (async () => {
      // Containment, not a lock: the Collection's own store folder must be an ordinary folder inside
      // it, so nothing this command writes there lands somewhere else through a link.
      await privateFolder(root, '.writeflex', false)
      settleVersionMoves(root, true)
      // What an earlier write left when it was killed between writing a temporary file and renaming it.
      await removeStaleTemporaryFiles(root, { now: env.now })
      const journal = new Journal(root, recordsPlace(env), { now: env.now, maxEntryBytes: env.maxJournalEntryBytes, ...(env.journalSeams ? { seams: env.journalSeams } : {}) })
      // Undo is not journalled as a change (there is no undo of an undo), but it leaves an intent like
      // any other, naming the entry it undoes, so that an undo killed partway can be finished (journal.ts).
      const intent = journal.begin(operation)
      // No owner to confirm: there is no Collection lock. Every write is still guarded by content.
      const confirmOwner = async (): Promise<void> => {}
      const guarded = new CommandLineWorkspace(root)
      // Versions in a OneDrive Collection: local recovery in this variant's application data first, the
      // synced store asynchronously (document-write-versions.ts).
      const session = new WriteSession(guarded, { seams: env.seams, intent, confirmOwner, recoveryDir: replicaRecoveryDir(recordsPlace(env).own) })
      // A short-lived process: its writes to the synced version store are waited for a bounded time before
      // it returns; what is left stays in local recovery, written by the app's next pass or the next command.
      const settleVersions = async (): Promise<void> => { await session.versionsSettled(COMMAND_STORE_GRACE_MS) }
      return await runWithAccess({
        root, operation, session, journal, intent, workspace: new WritingWorkspace(root, session),
        trash: env.trash ?? systemTrash, now: env.now ?? (() => new Date()),
        saveVersion: async (input) => {
          await env.seams?.beforeWrite?.(input.path)
          return saveVersionFromCommandLine(guarded, confirmOwner, input, { afterCheck: env.seams?.betweenCheckAndWrite })
        },
        saveFolioVersion: async (input) => {
          await env.seams?.beforeWrite?.(input.dir)
          return saveFolioVersionFromCommandLine(guarded, confirmOwner, input, { afterCheck: env.seams?.betweenCheckAndWrite })
        },
        importRevision: async () => { throw new CliError(NEEDS_THE_APP, 'refused', 'refused') },
        withdrawRevision: async () => { throw new CliError(NEEDS_THE_APP, 'refused', 'refused') },
        history: (request) => reattachVersionHistory(guarded, request, confirmOwner),
        followLedger: (moves) => followRenamesInLedger(guarded, confirmOwner, moves),
        sharing: commandLineSharingFollow(root, env),
      }, work).finally(settleVersions)
    })()
  } catch (error) {
    throw explained(error, root)
  }
}
