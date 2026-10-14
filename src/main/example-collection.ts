/**
 * The Example collection's first run (ADR-0043, ticket 06): eleven bundled lesson files written
 * once to `<Documents>/WriteFlex/Example collection`, shown on the start screen as two marked
 * entries. The only code in the app that writes into the person's Documents folder unasked.
 *
 * WRITTEN LIMITS. This module creates one folder, one `assets` folder inside it and twelve files (the
 * eleven lessons and the widget page 02 embeds), each only if nothing is there,
 * and never deletes, renames or overwrites. It does not prove the folder at the fixed path is the
 * one it made: if a person or a sync tool puts another folder at that exact path, WriteFlex shows
 * that folder as the Example collection. Nothing in it is changed by that. Removing the example (a
 * separate feature) asks first, names the folder, and moves it to the Bin. With only path-based
 * file calls, a folder swapped in during the few milliseconds of the first write may receive
 * created lesson files; none is written over an existing file.
 *
 * The rules, each a test in `tests/main/example-collection.test.ts`:
 *
 * A. THE PATH IS FIXED, NEVER STORED. It is computed from the injected Documents directory every
 *    time. Settings hold no path, identity or name, and none is read from them.
 * B. THE RECORD IS ONE WORD (`writing`, `written`, `incomplete`, `removed`). If the `example` key
 *    is present in the settings file in any form, nothing is ever created. Only an absent key
 *    allows the first write.
 * C. FIRST WRITE (key absent): record `writing` — if that cannot be saved, create nothing. Make
 *    the folder with an exclusive mkdir; if anything is there it is the person's, untouched, and
 *    the record becomes `incomplete`. Create the eleven files exclusively; any error creating
 *    one, a file already being there included, ends the write. Record `written` only if all
 *    eleven were created and are regular files at the fixed path; otherwise `incomplete`.
 *    Refused before anything is created: no Documents folder; `WriteFlex` or the final path being
 *    a symlink or resolving outside Documents. ANY failure or refusal once Documents is looked at
 *    ends as `incomplete` for good (when settings can be saved): no later launch tries again.
 * G. TOP-UP (see `#topUp`): in the `written` state, bundled files never written before and missing now are created.
 *    This is the one exception to D: it creates only inside the folder and never overwrites.
 * H. RECORDED BEFORE CREATED. The settings file keeps the names of the bundled files this collection
 *    has ever been given (`exampleFiles`), and a name is saved there BEFORE its file is created,
 *    everywhere a file is created: the first write and the restore save the whole bundle's names
 *    before they make the folder, the top-up saves each name before it creates that file. If the
 *    names cannot be saved, nothing is created. So a file on disk that this module made is always
 *    a recorded one, and the top-up never brings back a lesson the writer deleted. THE ACCEPTED
 *    FAILURE is the other way round: a file recorded and then not created (the disk failed, the
 *    app was killed in between) is never delivered by a later launch. That loses one bundled
 *    lesson for that person; it never puts back anything they removed.
 * D. LATER LAUNCHES CREATE NOTHING. `writing` found at launch becomes `written` if all eleven
 *    regular files are at the fixed path, else `incomplete`. The other states are left alone.
 * E. THE MARKED ENTRIES SHOW when the state is `written` AND the fixed path is a directory: one
 *    asynchronous check, made when the start screen or the native menu asks.
 * F. OUT OF PINS AND RECENTS by a lexical comparison with the fixed path, in `SettingsStore`,
 *    while the entries are shown. No filesystem call; stored lists are never rewritten.
 *
 * FAILS QUIET: `ensure()` never throws and shows nothing; one log line, an error code only.
 * TESTS NEVER TOUCH THE REAL HOME: the Documents directory and the filesystem port are injected.
 */
import type { Stats } from 'node:fs'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import type { ExampleState } from './settings'
import { sameLexicalPath } from './lexical-path'
import { EXAMPLE_OBJECTS_FILE } from '../shared/example-files'

export const EXAMPLE_PARENT_NAME = 'WriteFlex'
export const EXAMPLE_FOLDER_NAME = 'Example collection'
export const EXAMPLE_START_FILE = '00 Start here.md'
export { EXAMPLE_OBJECTS_FILE }
/** The welcome, the ten chapters in order and the lesson on objects. */
export const EXAMPLE_LESSON_FILES: readonly string[] = [
  EXAMPLE_START_FILE,
  '01 Write.md',
  '02 Shape the document.md',
  '03 Stay focused.md',
  '04 Listen.md',
  '05 Review and versions.md',
  '06 Find and manage files.md',
  '07 Collect and plan.md',
  '08 Work with the agent.md',
  '09 Share and export.md',
  '10 Set up WriteFlex.md',
  EXAMPLE_OBJECTS_FILE,
]

/**
 * Files the lessons point at, inside the folder (interactive widgets, ticket 05): the walking-pace
 * widget that 02 Shape the document embeds with `[Simulation: assets/walking-pace.html]`. They are
 * written, restored and counted with the lessons, exclusively and once, like them; the only
 * subfolder the example has is `assets`, made with the same exclusive mkdir.
 */
export const EXAMPLE_ASSET_FILES: readonly string[] = ['assets/walking-pace.html', 'assets/packing-list.html', 'assets/wold-view.png']
/** Every file of the bundle, lessons first. The write and the restore take all of them or nothing. */
export const EXAMPLE_BUNDLE_FILES: readonly string[] = [...EXAMPLE_LESSON_FILES, ...EXAMPLE_ASSET_FILES]

/**
 * The twelve files every build before the lesson on objects wrote. A collection whose record holds
 * no list of written files is read as having had exactly these written, so the top-up brings it only
 * what is newer than them.
 */
export const EXAMPLE_ORIGINAL_FILES: readonly string[] = [
  EXAMPLE_START_FILE,
  '01 Write.md',
  '02 Shape the document.md',
  '03 Stay focused.md',
  '04 Listen.md',
  '05 Review and versions.md',
  '06 Find and manage files.md',
  '07 Collect and plan.md',
  '08 Work with the agent.md',
  '09 Share and export.md',
  '10 Set up WriteFlex.md',
  'assets/walking-pace.html',
]

/** Read the whole bundle from the app's own resources (a missing file throws). */
export async function readExampleBundle(bundledDir: string, names: readonly string[] = EXAMPLE_BUNDLE_FILES): Promise<Array<{ name: string; data: Buffer }>> {
  const files: Array<{ name: string; data: Buffer }> = []
  for (const name of names) files.push({ name, data: await readFile(join(bundledDir, name)) })
  return files
}

/** Create the bundle's files under `root`: a subfolder by an exclusive mkdir the first time a file needs it, each file exclusively. */
export async function writeExampleBundle(fs: Pick<ExampleFs, 'mkdir' | 'writeNewFile'>, root: string, bundle: ReadonlyArray<{ name: string; data: Buffer }>): Promise<void> {
  const made = new Set<string>()
  for (const file of bundle) {
    const folder = dirname(file.name)
    if (folder !== '.' && !made.has(folder)) { await fs.mkdir(join(root, folder)); made.add(folder) }
    await fs.writeNewFile(join(root, file.name), file.data)
  }
}

/** The name of the harness override for the Documents directory. See `resolveExampleDocumentsDir`. */
export const EXAMPLE_DOCUMENTS_OVERRIDE = 'WRITEFLEX_E2E_DOCUMENTS'

/**
 * Where `<Documents>` is for this run, or null for "write nothing, show nothing".
 *
 * Any run with the e2e flag set never sees the real Documents folder: it gets the directory named
 * by `WRITEFLEX_E2E_DOCUMENTS`, honoured only when the app is unpackaged AND `WRITEFLEX_E2E` is
 * `1`, and otherwise nothing. A normal launch uses the system's Documents folder.
 */
export function resolveExampleDocumentsDir(input: {
  isPackaged: boolean
  env: Record<string, string | undefined>
  systemDocuments: () => string
}): string | null {
  if (input.env.WRITEFLEX_E2E === '1') {
    const override = input.isPackaged ? '' : input.env[EXAMPLE_DOCUMENTS_OVERRIDE]?.trim() ?? ''
    return override === '' ? null : resolve(override)
  }
  return input.systemDocuments()
}

/** What the start screen needs to draw the two marked entries. */
export type ExampleView = {
  /** The fixed path (the row's tooltip; never sent back to open it). */
  root: string
  /** The folder it sits in, home-relative where it can be: `~/Documents/WriteFlex`. */
  location: string
  /** How many of the eleven lesson files are in the folder now. */
  lessonFiles: number
}

export type ExampleOutcome =
  /** No Documents directory for this run (a harness run without the override). */
  | 'unavailable'
  /** All eleven lesson files are in place and recorded, on this launch. */
  | 'written'
  /** Recorded as written on an earlier launch; nothing touched. */
  | 'present'
  /** The person removed it; nothing touched. */
  | 'removed'
  /** A first write that did not finish, or a record that cannot be read: nothing touched, final. */
  | 'incomplete'
  /** Something was already at the fixed path; left alone, and recorded as incomplete. */
  | 'foreign'
  /** A symlink, a non-directory, or a path resolving outside Documents; nothing touched, and final. */
  | 'refused'
  /** Documents, the bundle, the disk or the settings save failed. */
  | 'failed'

export type ExampleStateStore = {
  exampleState(): ExampleState | 'absent'
  setExampleState(state: ExampleState): boolean
  /** Bundled files this collection has ever been given (rule H; the top-up never brings back one of these). */
  exampleFiles(): readonly string[]
  /** Save that list. False when it could not be saved: the caller then creates nothing. */
  setExampleFiles(names: readonly string[]): boolean
}

/** Everything this module does to the disk. There is no remove, rename or overwrite to call. */
export type ExampleFs = {
  lstat: (path: string) => Promise<Stats>
  realpath: (path: string) => Promise<string>
  /** Create ONE directory. Fails with EEXIST if anything of that name exists. Never recursive. */
  mkdir: (path: string) => Promise<void>
  /** Create a file that does not exist. Fails with EEXIST otherwise; never opens an existing file. */
  writeNewFile: (path: string, data: Buffer) => Promise<void>
}

export const nodeExampleFs: ExampleFs = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  mkdir: async (path) => { await mkdir(path) },
  writeNewFile: (path, data) => writeFile(path, data, { flag: 'wx', mode: 0o644 }),
}

export type ExampleCollectionDeps = {
  /** The one source of `<Documents>`; null means this run has none. */
  documentsDir: () => string | null
  /** The folder holding the eleven bundled lesson files (the app's own resources). */
  bundledDir: string
  store: ExampleStateStore
  /** The person's home, for the home-relative path line. */
  home?: () => string
  /** One line per first-run outcome worth keeping. Never given paths or file contents. */
  log?: (event: string, details: Record<string, unknown>) => void
  /** The filesystem port; the real one unless a test fences it. */
  fs?: ExampleFs
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

class Refused extends Error {}

export class ExampleCollection {
  readonly #deps: ExampleCollectionDeps
  readonly #fs: ExampleFs
  #ensured: Promise<ExampleOutcome> | null = null
  /** The fixed path for this launch (rule A): computed, held in memory, never stored. */
  #root: string | null = null
  /** The fixed path while the marked entries are shown, as the last check found it. */
  #shown: string | null = null

  constructor(deps: ExampleCollectionDeps) {
    this.#deps = deps
    this.#fs = deps.fs ?? nodeExampleFs
  }

  /** First run, at most once per launch. Never throws; resolves with what happened. */
  ensure(): Promise<ExampleOutcome> {
    this.#ensured ??= this.#ensure().then(
      (outcome) => {
        if (outcome === 'written' || outcome === 'foreign' || outcome === 'incomplete') this.#log(outcome)
        return outcome
      },
      (error: unknown) => {
        this.#log(error instanceof Refused ? 'refused' : 'failed', error instanceof Refused ? undefined : errorCode(error))
        return error instanceof Refused ? 'refused' : 'failed'
      },
    )
    return this.#ensured
  }

  /**
   * Rule E, the one asynchronous check: the fixed path when the state is `written` and it is a
   * directory there, else null. Changes nothing on disk or in settings either way.
   */
  async current(): Promise<string | null> {
    await this.ensure()
    let shown: string | null = null
    if (this.#root !== null && this.#deps.store.exampleState() === 'written') {
      shown = (await this.#lstatOrNull(this.#root).catch(() => null))?.isDirectory() ? this.#root : null
    }
    this.#shown = shown
    return shown
  }

  /** The fixed path while the marked entries are shown, from the last `current()`. No filesystem call. */
  shownRoot(): string | null {
    return this.#shown
  }

  /** The explicit rule for the window-opening guard: is `path`, as written, the shown example folder? */
  isRoot(path: string): boolean {
    return this.#shown !== null && sameLexicalPath(path, this.#shown)
  }

  /** What the start screen draws; null when the entries are not shown. */
  async view(): Promise<ExampleView | null> {
    const root = await this.current()
    if (root === null) return null
    let lessonFiles = 0
    for (const name of EXAMPLE_LESSON_FILES) if (await this.#isFile(join(root, name))) lessonFiles += 1
    return { root, location: this.#homeRelative(dirname(root)), lessonFiles }
  }

  /** `00 Start here.md` when the example is shown and still holds it, else null. */
  async startFile(): Promise<string | null> {
    const root = await this.current()
    return root !== null && (await this.#isFile(join(root, EXAMPLE_START_FILE))) ? EXAMPLE_START_FILE : null
  }

  #homeRelative(path: string): string {
    const home = (this.#deps.home ?? homedir)()
    return home !== '' && path.startsWith(home.endsWith(sep) ? home : home + sep) ? `~${sep}${path.slice(home.length).replace(/^[/\\]+/, '')}` : path
  }

  #log(outcome: ExampleOutcome, code?: string): void {
    try {
      this.#deps.log?.('example-collection.first-run', { outcome, ...(code ? { code } : {}) })
    } catch {
      /* logging never breaks a launch */
    }
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

  /** Are all eleven lesson names, and the widget page they point at, regular files at the fixed path? */
  async #complete(root: string): Promise<boolean> {
    if (!(await this.#lstatOrNull(root).catch(() => null))?.isDirectory()) return false
    for (const name of EXAMPLE_BUNDLE_FILES) if (!(await this.#isFile(join(root, name)))) return false
    return true
  }

  #record(state: ExampleState): void {
    if (!this.#deps.store.setExampleState(state)) throw failure('SETTINGS_UNWRITABLE')
  }

  /** Record `written` if all eleven are in place, otherwise `incomplete`. Creates nothing. */
  async #settle(root: string): Promise<ExampleOutcome> {
    const complete = await this.#complete(root)
    this.#record(complete ? 'written' : 'incomplete')
    return complete ? 'written' : 'incomplete'
  }

  /**
   * TOP-UP (rule G). A collection in the `written` state gets each bundled file that no earlier
   * launch ever recorded and that is not in the folder now: created exclusively, subfolder included.
   * A file that is there (edited or not) is never touched, a file the writer deleted that an earlier
   * launch recorded is never brought back, and a bundled file whose text changed is not rewritten.
   * It does nothing when the folder is absent and refuses, as the first write does, a `WriteFlex` or
   * `Example collection` that is a symlink or resolves outside Documents. It never throws and never
   * changes the state.
   *
   * Rule H, one file at a time: the name is saved to the record first, and only when that save
   * succeeded is the subfolder made and the file created. A save that fails ends the top-up for
   * this launch with nothing further created. A create that fails after its name was saved leaves
   * the name recorded: that file is never delivered (the accepted failure), and the files after it
   * are tried on the next launch. A file whose subfolder is a symlink or a file is neither recorded
   * nor created.
   */
  async #topUp(documents: string, root: string): Promise<void> {
    let added = 0
    try {
      const parent = dirname(root)
      const parentStat = await this.#lstatOrNull(parent)
      if (!parentStat?.isDirectory()) return
      if (dirname(await this.#fs.realpath(parent)) !== documents) return
      if (!(await this.#lstatOrNull(root))?.isDirectory()) return // absent, a symlink or a file: nothing to add to
      const store = this.#deps.store
      const known = new Set(store.exampleFiles())
      const wanted = EXAMPLE_BUNDLE_FILES.filter((name) => !known.has(name))
      if (wanted.length === 0) return
      const bundle = await readExampleBundle(this.#deps.bundledDir, wanted)
      for (const file of bundle) {
        const folder = dirname(file.name)
        const folderStat = folder === '.' ? null : await this.#lstatOrNull(join(root, folder))
        if (folderStat && !folderStat.isDirectory()) continue // a symlink or a file where the subfolder belongs: leave it, try again next launch
        const path = join(root, file.name)
        const there = await this.#lstatOrNull(path)
        known.add(file.name)
        if (!store.setExampleFiles([...known])) throw failure('SETTINGS_UNWRITABLE') // not recorded: not created, and nothing after it
        if (there) continue // anything of that name is the writer's: recorded, never touched
        try {
          if (folder !== '.' && !folderStat) await this.#fs.mkdir(join(root, folder)).catch((error: unknown) => { if (errorCode(error) !== 'EEXIST') throw error })
          await this.#fs.writeNewFile(path, file.data)
          added += 1
        } catch (error) {
          if (errorCode(error) !== 'EEXIST') throw error
        }
      }
    } catch (error) {
      try { this.#deps.log?.('example-collection.top-up', { outcome: 'failed', code: errorCode(error) }) } catch { /* logging never breaks a launch */ }
    }
    if (added > 0) try { this.#deps.log?.('example-collection.top-up', { added }) } catch { /* logging never breaks a launch */ }
  }

  async #ensure(): Promise<ExampleOutcome> {
    const { store } = this.#deps
    const documentsDir = this.#deps.documentsDir()
    if (documentsDir === null) return 'unavailable'
    const state = store.exampleState()

    if (state !== 'absent') {
      // A: the fixed path, from the Documents directory, every launch. B and D: a record of any
      // kind means nothing is created in this launch.
      const documents = await this.#fs.realpath(documentsDir).catch(() => resolve(documentsDir))
      const root = join(documents, EXAMPLE_PARENT_NAME, EXAMPLE_FOLDER_NAME)
      this.#root = root
      if (state === 'written') {
        await this.#topUp(documents, root)
        return 'present'
      }
      if (state === 'removed') return 'removed'
      return state === 'writing' ? this.#settle(root) : 'incomplete'
    }

    // C: the first write. The bundle is the app's own resources, read whole before the person's
    // disk is looked at: all eleven or nothing (a broken install is not the person's doing, so it
    // records nothing).
    const lessons = await readExampleBundle(this.#deps.bundledDir)

    try {
      // The refusals, checked once, before anything is created.
      const documents = await this.#fs.realpath(documentsDir)
      const parent = join(documents, EXAMPLE_PARENT_NAME)
      const root = join(parent, EXAMPLE_FOLDER_NAME)
      this.#root = root
      const parentStat = await this.#lstatOrNull(parent)
      if (parentStat && !parentStat.isDirectory()) throw new Refused('WriteFlex is not a plain folder.')
      if (parentStat && dirname(await this.#fs.realpath(parent)) !== documents) throw new Refused('WriteFlex resolves outside Documents.')
      if (parentStat && (await this.#lstatOrNull(root))?.isSymbolicLink()) throw new Refused('Example collection is a symlink.')

      // Rule H, then rule C: the names, then `writing`. If either cannot be saved, nothing is created.
      if (!store.setExampleFiles(EXAMPLE_BUNDLE_FILES)) throw failure('SETTINGS_UNWRITABLE')
      this.#record('writing')
      if (!parentStat) await this.#fs.mkdir(parent).catch((error: unknown) => { if (errorCode(error) !== 'EEXIST') throw error })
      try {
        await this.#fs.mkdir(root) // exclusive: anything already there is the person's
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error
        this.#record('incomplete')
        return 'foreign'
      }
      try {
        await writeExampleBundle(this.#fs, root, lessons)
      } catch (error) {
        // A lesson name already taken is not an accident to report: the write simply ends here.
        if (errorCode(error) !== 'EEXIST') throw error
        this.#record('incomplete')
        return 'incomplete'
      }
      return await this.#settle(root)
    } catch (error) {
      // Any failure or refusal is final. Nothing is removed; whatever was created stays. If the
      // record itself cannot be saved there is nothing more to do but report the first error.
      if (errorCode(error) !== 'SETTINGS_UNWRITABLE') this.#deps.store.setExampleState('incomplete')
      throw error
    }
  }
}
