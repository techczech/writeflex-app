/**
 * Removing the Example collection and bringing it back (ADR-0043, ticket 10). The first run is
 * `example-collection.ts` and is not changed by anything here; this module is the only code in the
 * app that moves a folder in the person's Documents to the Bin.
 *
 * WRITTEN LIMITS. WriteFlex does not prove the folder at the fixed path is the one it made (see the
 * header of `example-collection.ts`), so the confirmation names the folder as it is on disk and
 * counts the files in it at that moment, and the person decides. Between the last checks below and
 * the move to the Bin there is a gap in which another program, running with the person's own
 * permissions, could swap what is at the path; the trash function is then given the same fixed
 * path. If the LAST part of the path (`Example collection`) has become a symlink, the link itself is
 * moved and what it points to stays. If an EARLIER part (`WriteFlex`, or a folder above it) has
 * become a symlink, that redirects the trash: the path is followed through the link and whatever
 * folder named `Example collection` is at the far end is what goes to the Bin. This is an accepted
 * limit, as in ticket 06; nothing here narrows it.
 *
 * Saving: every window whose folder is the example, or a folder inside it, is closed before the move,
 * by the app's normal close route, which writes all it holds first (rule I). A closed window cannot
 * take more typing. When a save fails or a window refuses to close, nothing is binned; saves that did
 * succeed before the refusal stay written (that is the person's own text reaching disk, not a loss),
 * and windows that did close stay closed. A window whose folder CONTAINS the example (for example
 * `Documents/WriteFlex` opened as a folder) is not closed: an unsaved buffer of an example file in
 * such a window stays in that window after removal and can still be saved elsewhere.
 *
 * The e2e stand-in Bin (`resolveExampleTrash`) has a check-then-move gap against a hostile local
 * process: its folder is checked, then the folder is moved into it. It is test-only and cannot be
 * reached in a packaged launch.
 *
 * The rules, each a test in `tests/main/example-removal.test.ts`:
 *
 * A. THE PATH IS FIXED: `<Documents>/WriteFlex/Example collection`, computed from the injected
 *    Documents directory on every call. Nothing path-like is an argument of any method here, and
 *    none is read from settings. `remove` takes the confirmation's token (rule H), which is 64
 *    hexadecimal characters and is never used as, or as part of, a path; `preview` and `remove`
 *    also take the number main gives the asking window, never anything the window sent.
 * B. ONE DESTRUCTIVE CALL. `remove()` calls the injected trash function at most once, with exactly
 *    the fixed path. This module has no delete, rename or overwrite to call: its filesystem port is
 *    lstat, realpath, readdir, an exclusive mkdir and an exclusive file create.
 * C. REMOVE ONLY WHAT IS SHOWN. `remove()` acts only while the state is `written` (the only state
 *    in which the marked entries are on the start screen). In any other state it changes nothing:
 *    a folder at the path under `incomplete` is the person's own.
 * D. CHECKED BEFORE IT IS MOVED. The path must be a real directory, not a symlink, and `WriteFlex`
 *    and the folder must each resolve to a place directly inside the one above, up to the real
 *    Documents folder. If any of that fails, nothing changes and one sentence says so.
 * E. ORDER. The token and the checks; then the example's windows closed (rule I); then the checks of
 *    rule D and the fresh count of rule H once more (outside WriteFlex's own records); then trash. Only when it has succeeded AND the
 *    path is then empty: record `removed` (which takes both entries off the start screen). If the
 *    trash fails: state unchanged, one sentence; the windows already closed stay closed. If the
 *    folder is already gone: record `removed`, no trash call, no error.
 * F. RESTORE starts only from `removed` or `incomplete`, and creates only by the first run's rule:
 *    an exclusive mkdir of the folder and exclusive creates of the eleven files, never into an
 *    existing folder. A folder already at the path is pinned as it is when it holds
 *    `00 Start here.md` (state `written`, nothing written to disk); otherwise one sentence says a
 *    folder of that name is in the way and nothing changes.
 * G. ONE AT A TIME. Calls run in the order they were made, so two confirmations cannot both reach
 *    the trash function for one folder.
 * H. MAIN HOLDS THE CONFIRMATION. `preview()` makes a random single-use token and keeps it with the
 *    window it was shown in, the count it showed and the time. `remove(token)` changes nothing and
 *    asks the person to look again unless the token is the live one, comes from that same window,
 *    is younger than five minutes, and a fresh count of the folder equals the count shown. Any
 *    call to `remove` uses the token up, whatever it was given; a new `preview` replaces it. A
 *    folder holding more than `EXAMPLE_COUNT_LIMIT` entries is not the example: `preview` refuses
 *    it and issues no token, and a count that reaches the limit at `remove` refuses too, so no
 *    capped count is ever compared. The count after the windows have closed (rule E) leaves out
 *    WriteFlex's own records (`.bridle` and `.writeflex` directly inside the folder), because the
 *    close itself writes them there; every other file must still be as shown.
 * I. NOTHING UNSAVED IS BINNED. Before the trash call the injected `closeWindows` port closes every
 *    window whose folder is the example or inside it, by the app's normal close route (which writes
 *    every unsaved buffer first and keeps the window open when a write fails). Unless it answers
 *    `closed` within `EXAMPLE_CLOSE_MS` (a save failed, a window refused, or one did not close in
 *    time), nothing is binned: no trash call, no state change, and one sentence says so.
 *
 * Guide progress is another settings key and is never read or written here.
 */
import { randomBytes } from 'node:crypto'
import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, sep } from 'node:path'
import {
  EXAMPLE_BUNDLE_FILES,
  EXAMPLE_FOLDER_NAME,
  EXAMPLE_PARENT_NAME,
  EXAMPLE_START_FILE,
  nodeExampleFs,
  readExampleBundle,
  writeExampleBundle,
  type ExampleFs,
  type ExampleStateStore,
} from './example-collection'
import { sameLexicalPath } from './lexical-path'

/** The first run's port plus one read: the names in a directory. Still no remove, rename or overwrite. */
export type ExampleRemovalFs = ExampleFs & {
  readdir: (path: string) => Promise<Dirent[]>
}

export const nodeExampleRemovalFs: ExampleRemovalFs = {
  ...nodeExampleFs,
  readdir: (path) => readdir(path, { withFileTypes: true }),
}

/** Moves one path to the Bin, or rejects. `shell.trashItem` in production. */
export type TrashItem = (path: string) => Promise<void>

export type ExampleRemovalDeps = {
  /** The one source of `<Documents>`; null means this run has none. */
  documentsDir: () => string | null
  /** The folder holding the eleven bundled lesson files (the app's own resources). */
  bundledDir: string
  store: ExampleStateStore
  /** THE destructive call. Given the fixed path and nothing else. */
  trash: TrashItem
  /**
   * Rule I: close every window whose folder is the example or inside it, by the app's normal close
   * route, and answer `closed` only when every one of them has closed. Given the fixed path. Called
   * before the trash.
   */
  closeWindows: (root: string) => Promise<ExampleWindowsClosed>
  /** The person's home, for the home-relative path in the confirmation. */
  home?: () => string
  /** One line per removal or restore. Never given paths or file contents. */
  log?: (event: string, details: Record<string, unknown>) => void
  /** The filesystem port; the real one unless a test fences it. */
  fs?: ExampleRemovalFs
  /** The clock for the confirmation's age (rule H); `Date.now` unless a test sets it. */
  now?: () => number
  /** Rule I's bound, `EXAMPLE_CLOSE_MS` unless a test shortens it. */
  closeMs?: number
}

/** Rule I: what the close of the example's windows came to. Anything but `closed` stops the removal. */
export type ExampleWindowsClosed = 'closed' | 'open'

/** Rule I: how long the windows have to write what they hold and close. */
export const EXAMPLE_CLOSE_MS = 5000

/** Rule H: a confirmation older than this is not acted on. */
export const EXAMPLE_CONFIRMATION_MS = 5 * 60 * 1000

/** The count stops past here, and a folder holding more is not the example (rule H): nothing is offered. */
export const EXAMPLE_COUNT_LIMIT = 10_000

/** What the confirmation shows, read from disk at the moment it opens. */
export type ExampleRemovalPreview =
  | { ok: true; /** The folder as it is on disk, home-relative where it can be. */ folder: string; files: number; /** Rule H: what `remove` must be given back. Not a path. */ token: string }
  | { ok: false; message: string }

export type ExampleRemoveResult =
  | { ok: true; outcome: 'moved-to-bin' | 'already-gone' }
  | { ok: false; message: string }

export type ExampleRestoreResult =
  | { ok: true; outcome: 'written' | 'pinned-as-it-is' }
  | { ok: false; message: string }

/** Every sentence this module can show the person. One sentence each. */
export const EXAMPLE_REMOVAL_TEXT = {
  lookAgain: 'The Example collection may have changed since you were shown it, so nothing was removed and you are asked to look again.',
  unsaved: 'The Example collection has unsaved changes that could not be written, so nothing was removed.',
  notShown: 'The Example collection is not on the start screen, so there is nothing to remove.',
  tooMany: `The folder at the Example collection's place holds more than ${EXAMPLE_COUNT_LIMIT.toLocaleString('en-GB')} files, so it is not the example and there is nothing to remove.`,
  noDocuments: 'WriteFlex could not find your Documents folder, so nothing was changed.',
  notPlain: 'The Example collection is not a plain folder inside Documents, so WriteFlex left it where it is.',
  trashFailed: 'The Example collection could not be moved to the Bin, so nothing was changed.',
  notRecorded: 'The Example collection is in the Bin, but WriteFlex could not save that to its settings.',
  goneNotRecorded: 'WriteFlex could not save its settings, so nothing was changed.',
  parentNotPlain: `${EXAMPLE_PARENT_NAME} in your Documents folder is not a plain folder, so the example was not brought back.`,
  notRemoved: 'The Example collection has not been removed, so there is nothing to bring back.',
  inTheWay: `A folder named ${EXAMPLE_FOLDER_NAME} is already in the way, so the example was not brought back.`,
  bundleMissing: 'The example files that come with WriteFlex could not be read, so nothing was changed.',
  writeFailed: 'The Example collection could not be written to your Documents folder.',
  restoreNotRecorded: 'WriteFlex could not save its settings, so the example is not back on the start screen.',
} as const

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

type Located =
  /** A real directory at the fixed path, inside the real Documents folder. */
  | { kind: 'present'; root: string; real: string }
  /** Nothing at the fixed path (or nothing above it). */
  | { kind: 'gone'; root: string; parentExists: boolean }
  /** Something other than a plain directory inside Documents. Not touched. */
  | { kind: 'refused'; what: 'parent' | 'folder' }
  /** No Documents directory for this run, or it cannot be resolved. */
  | { kind: 'no-documents' }

/** Rule H: the one confirmation main is holding. `files` is the count shown; `own` leaves out WriteFlex's records. */
type Confirmation = { token: string; sender: number; files: number; own: number; at: number }

/** What a walk of the folder found. `capped`: it stopped past the limit, so neither number is whole. */
type Counted = { files: number; own: number; capped: boolean }

/**
 * WriteFlex's own records, directly inside a folder it has open: the snapshot store and the change and
 * version journals (`workspace.ts` IGNORED_DIRS). Closing a window writes into them (rule E).
 */
const WRITEFLEX_RECORD_DIRS = new Set(['.bridle', '.writeflex'])

const TOKEN_SHAPE = /^[0-9a-f]{64}$/

/** The count of a folder that is not there. */
const NOTHING: Counted = { files: 0, own: 0, capped: false }

export class ExampleRemoval {
  readonly #deps: ExampleRemovalDeps
  readonly #fs: ExampleRemovalFs
  /** Rule H: the live confirmation, or none. */
  #confirmation: Confirmation | null = null
  /** Rule G: the tail of the queue of removals and restores. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(deps: ExampleRemovalDeps) {
    this.#deps = deps
    this.#fs = deps.fs ?? nodeExampleRemovalFs
  }

  /** May the example be brought back (rule F's starting states)? No filesystem call. */
  canRestore(): boolean {
    const state = this.#deps.store.exampleState()
    return state === 'removed' || state === 'incomplete'
  }

  /** Did the person remove it (the record is `removed`)? No filesystem call. */
  wasRemoved(): boolean {
    return this.#deps.store.exampleState() === 'removed'
  }

  /**
   * What the confirmation shows, and the token that confirming must give back (rule H). `sender`
   * is main's own number for the asking window. Reads only; changes nothing on disk or in settings.
   */
  async preview(sender: number): Promise<ExampleRemovalPreview> {
    this.#confirmation = null // a new look replaces the last one
    try {
      if (this.#deps.store.exampleState() !== 'written') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notShown }
      const located = await this.#locate()
      if (located.kind === 'no-documents') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.noDocuments }
      if (located.kind === 'refused') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain }
      const counted = located.kind === 'gone' ? NOTHING : await this.#countFiles(located.root)
      // H: past the limit the count would be capped, and a capped count proves nothing. Not the example.
      if (counted.capped) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.tooMany }
      const { files, own } = counted
      const confirmation: Confirmation = { token: randomBytes(32).toString('hex'), sender, files, own, at: this.#now() }
      this.#confirmation = confirmation
      return { ok: true, folder: this.#homeRelative(located.kind === 'gone' ? located.root : located.real), files, token: confirmation.token }
    } catch {
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain }
    }
  }

  /**
   * Move the example to the Bin (rules B to E), given the token of the confirmation the person
   * was shown and main's own number for the window that sent it (rule H). Never throws.
   */
  remove(token: unknown, sender: number): Promise<ExampleRemoveResult> {
    // H: used up by any call, at the moment of the call, so no second call can present it.
    const held = this.#confirmation
    this.#confirmation = null
    const confirmed = held !== null
      && typeof token === 'string' && TOKEN_SHAPE.test(token) && token === held.token
      && sender === held.sender
      && this.#now() - held.at < EXAMPLE_CONFIRMATION_MS && this.#now() >= held.at
      ? held
      : null
    return this.#inTurn(async () => {
      if (confirmed === null) {
        this.#log('remove', 'not-confirmed')
        return { ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain }
      }
      const result = await this.#remove(confirmed).catch((error: unknown): ExampleRemoveResult => {
        this.#log('remove', 'failed', errorCode(error))
        return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain }
      })
      return result
    })
  }

  /** Bring the example back (rule F). Never throws. */
  restore(): Promise<ExampleRestoreResult> {
    return this.#inTurn(async () => {
      const result = await this.#restore().catch((error: unknown): ExampleRestoreResult => {
        this.#log('restore', 'failed', errorCode(error))
        return { ok: false, message: EXAMPLE_REMOVAL_TEXT.writeFailed }
      })
      return result
    })
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work)
    this.#queue = next.catch(() => undefined)
    return next
  }

  async #remove(confirmed: Confirmation): Promise<ExampleRemoveResult> {
    const { store } = this.#deps
    // C: only the shown example is removed. Under any other record the folder is not WriteFlex's to move.
    if (store.exampleState() !== 'written') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notShown }
    // D and H: what is there now is a plain folder in place, and what the person was shown.
    const located = await this.#checked(confirmed, 'every-file')
    if ('message' in located) return located
    // I: every window showing the folder writes what it holds and closes, or nothing is binned.
    if (!(await this.#windowsClosed(located.root))) {
      this.#log('remove', 'unsaved')
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.unsaved }
    }
    // D and H again: the windows may have taken seconds to close, so what is at the path is checked
    // afresh. Their close wrote WriteFlex's own records into the folder; every other file is as shown.
    const now = await this.#checked(confirmed, 'outside-records')
    if ('message' in now) return now
    if (now.kind === 'gone') {
      // E: already gone is not an error; the record and the entries follow the disk.
      if (!store.setExampleState('removed')) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.goneNotRecorded }
      this.#log('remove', 'already-gone')
      return { ok: true, outcome: 'already-gone' }
    }

    // B and E: the one destructive call, on exactly the fixed path, before anything else changes.
    try {
      await this.#deps.trash(now.root)
    } catch (error) {
      this.#log('remove', 'trash-failed', errorCode(error))
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.trashFailed }
    }
    // A trash function that returned with the folder still in place has not moved it.
    const after = await this.#lstatOrNull(now.root).catch(() => 'unknown' as const)
    if (after !== null) {
      this.#log('remove', 'trash-failed', 'STILL_PRESENT')
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.trashFailed }
    }

    const recorded = store.setExampleState('removed')
    this.#log('remove', recorded ? 'moved-to-bin' : 'not-recorded')
    return recorded ? { ok: true, outcome: 'moved-to-bin' } : { ok: false, message: EXAMPLE_REMOVAL_TEXT.notRecorded }
  }

  /**
   * Rules D and H at one moment: the fixed path is a plain folder in place (or nothing), and a fresh,
   * uncapped count of it equals the count the person was shown (`every-file`), or, once the windows
   * have closed, the count outside WriteFlex's own records (`outside-records`). Otherwise the one
   * sentence to return.
   */
  async #checked(confirmed: Confirmation, compare: 'every-file' | 'outside-records'): Promise<Extract<Located, { kind: 'present' | 'gone' }> | { ok: false; message: string }> {
    const located = await this.#locate()
    if (located.kind === 'no-documents') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.noDocuments }
    if (located.kind === 'refused') {
      this.#log('remove', 'refused')
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notPlain }
    }
    const counted = located.kind === 'gone' ? NOTHING : await this.#countFiles(located.root)
    const same = compare === 'every-file' ? counted.files === confirmed.files : counted.own === confirmed.own
    if (counted.capped || !same) {
      this.#log('remove', 'count-changed')
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.lookAgain }
    }
    return located
  }

  async #restore(): Promise<ExampleRestoreResult> {
    const { store } = this.#deps
    // F: only from `removed` or `incomplete`.
    if (!this.canRestore()) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.notRemoved }
    const located = await this.#locate()
    if (located.kind === 'no-documents') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.noDocuments }
    if (located.kind === 'refused') return { ok: false, message: located.what === 'parent' ? EXAMPLE_REMOVAL_TEXT.parentNotPlain : EXAMPLE_REMOVAL_TEXT.inTheWay }
    if (located.kind === 'present') {
      // A folder is already there. It is shown as it is when it holds the welcome file; nothing is written into it.
      if (!(await this.#isFile(join(located.root, EXAMPLE_START_FILE)))) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.inTheWay }
      if (!store.setExampleState('written')) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.restoreNotRecorded }
      this.#log('restore', 'pinned-as-it-is')
      return { ok: true, outcome: 'pinned-as-it-is' }
    }

    // The bundle is the app's own resources, read whole before the person's disk is written: all eleven or nothing.
    let lessons: Awaited<ReturnType<typeof readExampleBundle>> = []
    try {
      lessons = await readExampleBundle(this.#deps.bundledDir)
    } catch {
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.bundleMissing }
    }

    const { root } = located
    // Recorded before created (the first run's rule H): the whole bundle's names are saved before the
    // folder is made, so the top-up never brings back a lesson deleted from the restored folder.
    if (!store.setExampleFiles(EXAMPLE_BUNDLE_FILES)) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.restoreNotRecorded }
    try {
      if (!located.parentExists) await this.#fs.mkdir(dirname(root)).catch((error: unknown) => { if (errorCode(error) !== 'EEXIST') throw error })
      await this.#fs.mkdir(root) // exclusive: anything that appeared there meanwhile is the person's
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return { ok: false, message: EXAMPLE_REMOVAL_TEXT.inTheWay }
      this.#log('restore', 'failed', errorCode(error))
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.writeFailed }
    }
    // From here a folder of WriteFlex's making is at the path. A write that does not finish leaves
    // it there, untouched, and the record says `incomplete`.
    try {
      await writeExampleBundle(this.#fs, root, lessons)
      for (const name of EXAMPLE_BUNDLE_FILES) if (!(await this.#isFile(join(root, name)))) throw Object.assign(new Error('NOT_A_FILE'), { code: 'NOT_A_FILE' })
    } catch (error) {
      store.setExampleState('incomplete')
      this.#log('restore', 'incomplete', errorCode(error))
      return { ok: false, message: EXAMPLE_REMOVAL_TEXT.writeFailed }
    }
    if (!store.setExampleState('written')) return { ok: false, message: EXAMPLE_REMOVAL_TEXT.restoreNotRecorded }
    this.#log('restore', 'written')
    return { ok: true, outcome: 'written' }
  }

  /**
   * Rules A and D: the fixed path, and what is there. `WriteFlex` and the folder must each be a
   * plain directory (lstat: not a symlink) whose real path sits directly inside the real path of
   * the one above, the same rule the first run applies to `WriteFlex`.
   */
  async #locate(): Promise<Located> {
    const documentsDir = this.#deps.documentsDir()
    if (documentsDir === null) return { kind: 'no-documents' }
    let documents: string
    try {
      documents = await this.#fs.realpath(documentsDir)
    } catch {
      return { kind: 'no-documents' }
    }
    const parent = join(documents, EXAMPLE_PARENT_NAME)
    const root = join(parent, EXAMPLE_FOLDER_NAME)

    const parentStat = await this.#lstatOrNull(parent)
    if (parentStat === null) return { kind: 'gone', root, parentExists: false }
    if (!parentStat.isDirectory()) return { kind: 'refused', what: 'parent' } // a symlink is not a directory to lstat
    const realParent = await this.#fs.realpath(parent)
    if (!sameLexicalPath(dirname(realParent), documents)) return { kind: 'refused', what: 'parent' }

    const rootStat = await this.#lstatOrNull(root)
    if (rootStat === null) return { kind: 'gone', root, parentExists: true }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { kind: 'refused', what: 'folder' }
    const real = await this.#fs.realpath(root)
    if (!sameLexicalPath(dirname(real), realParent)) return { kind: 'refused', what: 'folder' }
    return { kind: 'present', root, real }
  }

  /**
   * Every entry under `root` that is not a directory, hidden ones included (`files`), and those of them
   * outside WriteFlex's records directly inside `root` (`own`). Symlinks are counted, never followed.
   * Stops once past `EXAMPLE_COUNT_LIMIT` and says so (`capped`).
   */
  async #countFiles(root: string): Promise<Counted> {
    let files = 0
    let own = 0
    const pending: Array<{ directory: string; records: boolean }> = [{ directory: root, records: false }]
    while (pending.length > 0 && files <= EXAMPLE_COUNT_LIMIT) {
      const { directory, records } = pending.pop()!
      for (const entry of await this.#fs.readdir(directory)) {
        if (entry.isDirectory()) pending.push({ directory: join(directory, entry.name), records: records || (directory === root && WRITEFLEX_RECORD_DIRS.has(entry.name)) })
        else {
          files += 1
          if (!records) own += 1
        }
      }
    }
    return { files, own, capped: files > EXAMPLE_COUNT_LIMIT }
  }

  /** Rule I: true only for the answer `closed`, in time. A port that throws or never answers has not closed them. */
  async #windowsClosed(root: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), this.#deps.closeMs ?? EXAMPLE_CLOSE_MS) })
      return (await Promise.race([this.#deps.closeWindows(root), late])) === 'closed'
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)()
  }

  async #lstatOrNull(path: string): Promise<Stats | null> {
    try {
      return await this.#fs.lstat(path)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    }
  }

  async #isFile(path: string): Promise<boolean> {
    return (await this.#lstatOrNull(path).catch(() => null))?.isFile() === true
  }

  #homeRelative(path: string): string {
    const home = (this.#deps.home ?? homedir)()
    return home !== '' && path.startsWith(home.endsWith(sep) ? home : home + sep) ? `~${sep}${path.slice(home.length).replace(/^[/\\]+/, '')}` : path
  }

  #log(action: 'remove' | 'restore', outcome: string, code?: string): void {
    try {
      this.#deps.log?.(`example-collection.${action}`, { outcome, ...(code ? { code } : {}) })
    } catch {
      /* logging never breaks a removal */
    }
  }
}

/** The name of the harness override for the Bin. See `resolveExampleTrash`. */
export const EXAMPLE_BIN_OVERRIDE = 'WRITEFLEX_E2E_BIN'

/**
 * The trash function for this run. A normal launch uses the system's (`shell.trashItem`). Any run
 * with the e2e flag set never reaches the real Bin: it gets the harness's stand-in, honoured only
 * when the app is unpackaged AND `WRITEFLEX_E2E` is `1` AND `WRITEFLEX_E2E_BIN` names a directory
 * that, at the moment of the call, is not a symlink and whose real path is inside the real system
 * temporary directory (`harnessBinInsideTemp`). Otherwise the run gets a function that always fails:
 * never the real Bin, never a folder elsewhere.
 */
export function resolveExampleTrash(input: {
  isPackaged: boolean
  env: Record<string, string | undefined>
  systemTrash: TrashItem
  /** The harness's stand-in: move `path` into the directory `bin` (already checked, its real path). */
  harnessTrash: (path: string, bin: string) => Promise<void>
  /** The system temporary directory; `os.tmpdir()` unless a test sets it. */
  tempDir?: () => string
}): TrashItem {
  if (input.env.WRITEFLEX_E2E === '1') {
    const bin = input.isPackaged ? '' : input.env[EXAMPLE_BIN_OVERRIDE]?.trim() ?? ''
    if (bin === '') return async () => { throw Object.assign(new Error('No Bin in a harness run.'), { code: 'NO_BIN' }) }
    return async (path) => {
      const real = await harnessBinInsideTemp(bin, (input.tempDir ?? tmpdir)())
      if (real === null) throw Object.assign(new Error('The harness Bin is not a plain folder inside the temporary directory.'), { code: 'BIN_OUTSIDE_TEMP' })
      await input.harnessTrash(path, real)
    }
  }
  return input.systemTrash
}

/**
 * The harness Bin's real path, or null unless it is an existing directory, not itself a symlink,
 * whose real path lies strictly inside the real path of `tempDir`. Reads only (lstat, realpath).
 */
export async function harnessBinInsideTemp(bin: string, tempDir: string): Promise<string | null> {
  try {
    if (!isAbsolute(bin)) return null
    const own = await lstat(bin)
    if (own.isSymbolicLink() || !own.isDirectory()) return null
    const [real, temp] = await Promise.all([realpath(bin), realpath(tempDir)])
    const inside = temp.endsWith(sep) ? temp : temp + sep
    return real.startsWith(inside) && real.length > inside.length ? real : null
  } catch {
    return null
  }
}
