import {
  accessSync, closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { sameLexicalPath } from './lexical-path'
import { EXAMPLE_ORIGINAL_FILES } from './example-collection'
import {
  normaliseExportPresetSettings,
  shippedExportPresetSettings,
  type ExportPresetSettings,
} from '../shared/export-presets'
import { ACTION_BAR_VISIBLE_KEY, actionBarVisibleFrom } from '../shared/action-bar-settings'
import { readSharingRecord, type SharingRecord } from './sharing-record'

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'
/** One reopenable Workspace. `focus` is the folder focused in its window (ticket 03): a
 *  workspace-relative folder path, kept on the same record that reopens the root so it survives a
 *  relaunch; absent when nothing is focused. */
export type RecentWorkspace = { root: string; openedAt: number; focus?: string }
export type ModelDefaults = { provider?: string; modelId?: string; thinkingLevel?: ThinkingLevel }
export type DefaultSource = 'settings' | 'built-in'
export type ResolvedModelDefaults = {
  model: { provider: string; id: string }
  thinking: ThinkingLevel
  sources: { model: DefaultSource; thinking: DefaultSource }
}

const BUILT_IN_MODEL = { provider: 'openai-codex', id: 'gpt-5.5' }
const BUILT_IN_THINKING: ThinkingLevel = 'medium'

/** Resolve each preference from WriteFlex Settings, then WriteFlex's own built-in default. */
export function resolveModelDefaults(explicit: ModelDefaults): ResolvedModelDefaults {
  const explicitModel = typeof explicit.modelId === 'string' && explicit.modelId.length > 0
  return {
    model: explicitModel
      ? { provider: explicit.provider ?? 'openai-codex', id: explicit.modelId! }
      : BUILT_IN_MODEL,
    thinking: explicit.thinkingLevel ?? BUILT_IN_THINKING,
    sources: {
      model: explicitModel ? 'settings' : 'built-in',
      thinking: explicit.thinkingLevel ? 'settings' : 'built-in',
    },
  }
}

/** Favourite (starred) file paths, keyed by workspace root — one pinned set per opened folder. */
type FavouritesByRoot = Record<string, string[]>

/** A generic setting value (switches, selects, the model choice). Unset keys read as null and the
 *  renderer applies that surface's default — so a revert can genuinely return a key to "untouched". */
export type SettingValue = string | number | boolean

/**
 * One settings-changelog row (Task 17, the mockup's Changelog section): a change made in the
 * Settings window, newest first. `old` is null when the key was previously unset. Reset marks the
 * entry `reverted` (dimmed, one-shot) rather than logging a mirror entry — the mockup's semantics.
 */
export type ChangelogEntry = {
  key: string
  label: string
  old: SettingValue | null
  new: SettingValue | null
  at: number
  reverted?: boolean
}

/**
 * The Example collection's per-person state (ADR-0043; `src/main/example-collection.ts` owns every
 * transition). It is one word and a time: no path, no identity, nothing that names a place on
 * disk. The folder is always at the fixed path computed from the Documents directory.
 *
 * - `writing`: the first write was started in some launch and not seen to finish.
 * - `written`: the first write finished with all eleven lesson files in place.
 * - `incomplete`: the first write did not finish, or something was in the way. Final.
 * - `removed`: the person removed the example (ticket 10).
 *
 * `absent` is the fifth answer and the only one that allows a first write: the `example` key is
 * not in the settings file at all. A key that is present in ANY form — malformed, extra fields,
 * the wrong type, null — reads as `incomplete`, and so does a settings file that exists but
 * cannot be read, since it cannot be known that it held no record.
 */
export type ExampleState = 'writing' | 'written' | 'incomplete' | 'removed'
export type ExampleRecord = { state: ExampleState; at: number }

const EXAMPLE_STATES: readonly string[] = ['writing', 'written', 'incomplete', 'removed']

function readExampleState(raw: unknown): ExampleState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'incomplete'
  const keys = Object.keys(raw)
  const { state, at } = raw as Record<string, unknown>
  const wellFormed = keys.length === 2 && typeof state === 'string' && EXAMPLE_STATES.includes(state) && typeof at === 'number' && Number.isFinite(at)
  return wellFormed ? (state as ExampleState) : 'incomplete'
}

type SettingsData = {
  recents: RecentWorkspace[]
  /** Pinned Workspace roots in the user's order (start screen left column). No cap. */
  pinned: string[]
  modelDefaults: ModelDefaults
  favourites: FavouritesByRoot
  values: Record<string, SettingValue>
  changelog: ChangelogEntry[]
  exportPresets: ExportPresetSettings
  /** The `example` key exactly as the file held it, or as WriteFlex last set it. `undefined` is
   *  the key being absent, and JSON leaves an undefined key out, so absence survives a save. */
  example?: unknown
  /** Bundled Example files ever written (names); see `exampleFiles()`. Absent in files from older builds. */
  exampleFiles?: unknown
  /** Sharing's set-up record (sharing-record.ts): never a secret. Absent until set-up starts. */
  sharing?: unknown
  /** The links made on this Mac (sharing-publisher.ts ShareRecord[]): never a secret. */
  sharingLinks?: unknown
}

const MAX_RECENTS = 10
/** Changelog cap — enough to cover any realistic forget-what-I-tweaked window without letting
 *  settings.json grow without bound. Oldest entries drop off the tail. */
const MAX_CHANGELOG = 100
const RETIRED_SETTING_KEYS = new Set(['editor.tabLayout'])

/**
 * The file a save replaces: the settings path itself, or, when that path is a symlink (a settings
 * file kept in a synced or dotfiles folder), the regular file the whole chain of links ends at, so
 * every link stays a link. Throws, and the save is then refused with nothing changed on disk, when
 * the path is a symlink that does not end at something that exists (a link, at any depth, whose
 * target is missing, or a loop). A save never creates a file through a link.
 */
function saveTarget(path: string): string {
  try {
    if (!lstatSync(path).isSymbolicLink()) return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
    return path // nothing is there yet
  }
  return realpathSync(path)
}

function isSettingValue(value: unknown): value is SettingValue {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * App-level persistence for recents + model defaults (userData/settings.json). Pure node — the file
 * path is injected so the store is testable without Electron, per ADR-0007 / Electron-boundary rule.
 */
export class SettingsStore {
  #path: string
  #data: SettingsData
  #needsMigration = false
  #shownExampleRoot: () => string | null

  /**
   * `shownExampleRoot` is the Example collection's fixed path while its marked entry is on the
   * start screen, else null (the example module answers from memory; nothing here reads the disk).
   */
  constructor(filePath: string, options?: { shownExampleRoot?: () => string | null }) {
    this.#path = filePath
    this.#shownExampleRoot = options?.shownExampleRoot ?? (() => null)
    this.#data = this.#load()
    if (this.#needsMigration) this.#persist()
  }

  /** Tolerate a missing or corrupt file by starting empty — settings are convenience state, never critical. */
  #load(): SettingsData {
    let text: string | null = null
    try {
      text = readFileSync(this.#path, 'utf8')
    } catch (error) {
      // No settings file at all is the one case where the example key is known to be absent.
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') text = ''
    }
    try {
      if (text === null) throw new Error('no settings file')
      const parsed = JSON.parse(text) as Partial<SettingsData>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not a settings object')
      const recents = Array.isArray(parsed.recents)
        ? parsed.recents
          .filter((r): r is RecentWorkspace => !!r && typeof r.root === 'string')
          .map((r) => {
            const { focus, ...rest } = r
            return typeof focus === 'string' && focus !== '' ? { ...rest, focus } : rest
          })
        : []
      const pinned = Array.isArray(parsed.pinned)
        ? [...new Set(parsed.pinned.filter((r): r is string => typeof r === 'string' && r !== ''))]
        : []
      const modelDefaults =
        parsed.modelDefaults && typeof parsed.modelDefaults === 'object' ? parsed.modelDefaults : {}
      const favourites = this.#sanitiseFavourites(parsed.favourites)
      const values = this.#sanitiseValues(parsed.values)
      const changelog = this.#sanitiseChangelog(parsed.changelog)
      const exportPresets = parsed.exportPresets === undefined
        ? shippedExportPresetSettings()
        : normaliseExportPresetSettings(parsed.exportPresets) ?? shippedExportPresetSettings()
      return {
        recents, pinned, modelDefaults, favourites, values, changelog, exportPresets,
        // Kept exactly as found, whatever it is: present is present.
        ...('example' in parsed ? { example: parsed.example ?? null } : {}),
        ...('exampleFiles' in parsed ? { exampleFiles: parsed.exampleFiles } : {}),
        ...('sharing' in parsed ? { sharing: parsed.sharing } : {}),
        ...('sharingLinks' in parsed ? { sharingLinks: parsed.sharingLinks } : {}),
      }
    } catch {
      return {
        recents: [], pinned: [], modelDefaults: {}, favourites: {}, values: {}, changelog: [], exportPresets: shippedExportPresetSettings(),
        // A file that is there but unreadable may have held a record: never a reason to write again.
        ...(text === null ? {} : { example: { state: 'incomplete', at: Date.now() } satisfies ExampleRecord }),
      }
    }
  }

  /** Keep only primitive values under string keys; anything else in the file is discarded. */
  #sanitiseValues(raw: unknown): Record<string, SettingValue> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: Record<string, SettingValue> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (RETIRED_SETTING_KEYS.has(key)) {
        this.#needsMigration = true
        continue
      }
      if (isSettingValue(value)) out[key] = value
    }
    return out
  }

  /** Keep only well-shaped changelog entries (old/new may be null — "was unset"). */
  #sanitiseChangelog(raw: unknown): ChangelogEntry[] {
    if (!Array.isArray(raw)) return []
    const out: ChangelogEntry[] = []
    for (const entry of raw as unknown[]) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      if (typeof e.key !== 'string' || typeof e.label !== 'string' || typeof e.at !== 'number') continue
      if (RETIRED_SETTING_KEYS.has(e.key)) {
        this.#needsMigration = true
        continue
      }
      if (!(e.old === null || isSettingValue(e.old)) || !(e.new === null || isSettingValue(e.new))) continue
      out.push({
        key: e.key,
        label: e.label,
        old: e.old as SettingValue | null,
        new: e.new as SettingValue | null,
        at: e.at,
        ...(e.reverted === true ? { reverted: true } : {})
      })
    }
    return out.slice(0, MAX_CHANGELOG)
  }

  /** Keep only string-array values keyed by string roots; anything else in the file is discarded. */
  #sanitiseFavourites(raw: unknown): FavouritesByRoot {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    const out: FavouritesByRoot = {}
    for (const [root, list] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(list)) out[root] = list.filter((p): p is string => typeof p === 'string')
    }
    return out
  }

  /**
   * Save the whole file, all of it or none of it. Returns whether it was saved; only the example
   * record's setters look.
   *
   * The new text goes to a new file beside the settings file (created exclusively, with the settings
   * file's permissions), is flushed to disk, and is then renamed over the settings file. A save that
   * fails at any step removes the new file and leaves the settings file exactly as it was, so the
   * file on disk is always one complete save or the one before it, never part of one. Kept from the
   * plain write this replaced: a settings file that is not writable is not replaced, and a settings
   * path that is a symlink stays one (see `saveTarget`). Not kept: the file's inode (a hard link to
   * the settings file stops following it), and creating a file through a link: a symlinked settings
   * path that does not end at an existing regular file is refused, nothing changed.
   */
  #persist(): boolean {
    let temp: string | null = null
    let fd: number | null = null
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const target = saveTarget(this.#path)
      let mode: number | null = null
      try {
        const info = statSync(target)
        if (!info.isFile()) return false
        accessSync(target, constants.W_OK) // a read-only settings file is the person's choice: not replaced
        mode = info.mode & 0o7777
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error
      }
      const name = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
      fd = openSync(name, 'wx', mode ?? 0o666)
      temp = name // from here the new file is this save's to remove
      if (mode !== null) fchmodSync(fd, mode)
      writeFileSync(fd, JSON.stringify(this.#data, null, 2), 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      renameSync(temp, target)
      return true
    } catch {
      // Best effort: a failed save must never break opening a Workspace. The old file is untouched.
      if (fd !== null) try { closeSync(fd) } catch { /* already closed */ }
      if (temp !== null) try { unlinkSync(temp) } catch { /* nothing to remove */ }
      return false
    }
  }

  // ---- Sharing (ticket 02) ---------------------------------------------------------------------

  /** Sharing's set-up record, or null when there is none (sharing-record.ts). Holds no secret. */
  sharingRecord(): SharingRecord | null {
    return readSharingRecord(this.#data.sharing)
  }

  /** Replace (or with null, remove) sharing's record and save. False when the save failed; the store then keeps what it had. */
  setSharingRecord(record: SharingRecord | null): boolean {
    const before = this.#data.sharing
    if (record === null) delete this.#data.sharing
    else this.#data.sharing = structuredClone(record)
    if (this.#persist()) return true
    if (before === undefined) delete this.#data.sharing
    else this.#data.sharing = before
    return false
  }

  /** The links made on this Mac, as saved (sharing-publisher.ts reads and checks them). */
  sharingLinks(): unknown {
    return structuredClone(this.#data.sharingLinks ?? [])
  }

  /** Replace the links and save. False when the save failed; the store then keeps what it had. */
  setSharingLinks(links: unknown): boolean {
    const before = this.#data.sharingLinks
    this.#data.sharingLinks = structuredClone(links)
    if (this.#persist()) return true
    if (before === undefined) delete this.#data.sharingLinks
    else this.#data.sharingLinks = before
    return false
  }

  // ---- Example collection ----------------------------------------------------------------------

  /** The Example collection's state: `absent` only when the settings file has no `example` key. */
  exampleState(): ExampleState | 'absent' {
    return this.#data.example === undefined ? 'absent' : readExampleState(this.#data.example)
  }

  /**
   * The bundled files an earlier launch wrote into the Example collection (names only), or the twelve
   * files of the builds before this record existed. Kept apart from the `example` record so that
   * record's one-word shape, and every rule that reads it, is unchanged.
   *
   * Only an array holding nothing but strings is a list. An absent key and ANY other value (not an
   * array, or an array with one non-string in it) read as the twelve original files, never as a
   * shorter list: a list read short would let the top-up bring back a lesson the writer deleted.
   * Names that are not bundled files are kept and mean nothing.
   */
  exampleFiles(): readonly string[] {
    const raw: unknown = this.#data.exampleFiles
    return Array.isArray(raw) && raw.every((name): name is string => typeof name === 'string') ? (raw as string[]) : EXAMPLE_ORIGINAL_FILES
  }

  /** Save the list of bundled files ever written. False when the save failed; the store then keeps what it had. */
  setExampleFiles(names: readonly string[]): boolean {
    const before = this.#data.exampleFiles
    this.#data.exampleFiles = [...new Set(names)]
    if (this.#persist()) return true
    if (before === undefined) delete this.#data.exampleFiles
    else this.#data.exampleFiles = before
    return false
  }

  /** Record the state and save. False when the save failed; the store then keeps what it had. */
  setExampleState(state: ExampleState, at: number = Date.now()): boolean {
    const before = this.#data.example
    this.#data.example = { state, at } satisfies ExampleRecord
    if (this.#persist()) return true
    if (before === undefined) delete this.#data.example
    else this.#data.example = before
    return false
  }

  /**
   * THE one rule that keeps the Example collection out of Pinned and Recent: while the state is
   * `written` and its marked entry is shown, an entry is the example if its path, compared
   * lexically (no filesystem call), is the fixed path. It hides on read and refuses on add; the
   * stored lists are never rewritten because of it. Nothing else is ever filtered, so a wrong
   * record can at most hide an entry for that one path while the marked entry stands in its place.
   */
  #isShownExample(): (root: string) => boolean {
    const shown = this.exampleState() === 'written' ? this.#shownExampleRoot() : null
    if (shown === null) return () => false
    return (root) => sameLexicalPath(root, shown)
  }

  /** Recents, newest first (copies). The shown Example collection is never among them. */
  recents(): RecentWorkspace[] {
    const isExample = this.#isShownExample()
    return this.#data.recents.filter((r) => !isExample(r.root)).map((r) => ({ ...r }))
  }

  /** Move `root` to the front, deduplicated, capped at MAX_RECENTS, then persist. A focused folder
   *  recorded on the entry is carried across: reopening a root must not forget its focus. */
  touchRecent(root: string): void {
    if (this.#isShownExample()(root)) return // the marked entry is its place on the start screen
    const focus = this.#data.recents.find((r) => r.root === root)?.focus
    const rest = this.#data.recents.filter((r) => r.root !== root)
    this.#data.recents = [{ root, openedAt: Date.now(), ...(focus ? { focus } : {}) }, ...rest].slice(0, MAX_RECENTS)
    this.#persist()
  }

  /** The folder focused in `root`'s window, as last recorded (workspace-relative), or null. */
  folderFocus(root: string): string | null {
    return this.#data.recents.find((r) => r.root === root)?.focus ?? null
  }

  /**
   * Record (or with null, clear) the folder focused in `root`'s window on that root's recents entry
   * and persist. Returns false when the root has no entry to carry it — every opened root is
   * touched on open, so that happens only after ten newer roots pushed it out; the focus then lives
   * for the session only. A same-value write is a no-op.
   */
  setFolderFocus(root: string, focus: string | null): boolean {
    const entry = this.#data.recents.find((r) => r.root === root)
    if (!entry) return false
    if ((entry.focus ?? null) === focus) return true
    if (focus === null || focus === '') delete entry.focus
    else entry.focus = focus
    this.#persist()
    return true
  }

  // ---- Pinned workspaces ----------------------------------------------------------------------

  /** Pinned roots in the user's order (copy). The shown Example collection is never among them. */
  pinned(): string[] {
    const isExample = this.#isShownExample()
    return this.#data.pinned.filter((r) => !isExample(r))
  }

  isPinned(root: string): boolean {
    return this.#data.pinned.includes(root) && !this.#isShownExample()(root)
  }

  /** Append `root` to the pinned list (no-op when already pinned) and persist. Recents are untouched. */
  pin(root: string): void {
    if (root === '' || this.#isShownExample()(root) || this.#data.pinned.includes(root)) return
    this.#data.pinned = [...this.#data.pinned, root]
    this.#persist()
  }

  /** Remove `root` from the pinned list and persist. A recents entry for it, if any, shows in Recent again. */
  unpin(root: string): void {
    if (!this.#data.pinned.includes(root)) return
    this.#data.pinned = this.#data.pinned.filter((r) => r !== root)
    this.#persist()
  }

  /**
   * Move a pinned root to `toIndex` (clamped) and persist. Returns false when `root` is not pinned.
   * `toIndex` counts the pins the person sees; an entry hidden as the Example collection is not
   * counted, moved or removed.
   */
  movePinned(root: string, toIndex: number): boolean {
    const isExample = this.#isShownExample()
    const visible = this.#data.pinned.filter((r) => !isExample(r))
    if (!visible.includes(root)) return false
    const reordered = visible.filter((r) => r !== root)
    reordered.splice(Math.max(0, Math.min(reordered.length, toIndex)), 0, root)
    let at = 0
    const next = this.#data.pinned.map((r) => (isExample(r) ? r : reordered[at++]!))
    if (next.some((r, i) => r !== this.#data.pinned[i])) {
      this.#data.pinned = next
      this.#persist()
    }
    return true
  }

  /**
   * Replace a pinned root with the folder it moved to, keeping its position. When `newRoot` is
   * already pinned elsewhere the old entry is dropped instead so nothing appears twice. Returns
   * false when `oldRoot` is not pinned.
   */
  locatePinned(oldRoot: string, newRoot: string): boolean {
    const at = this.isPinned(oldRoot) ? this.#data.pinned.indexOf(oldRoot) : -1
    if (at < 0 || newRoot === '' || this.#isShownExample()(newRoot)) return false
    if (oldRoot === newRoot) return true
    const without = this.#data.pinned.filter((r, i) => i === at || r !== newRoot)
    this.#data.pinned = without.map((r) => (r === oldRoot ? newRoot : r))
    this.#persist()
    return true
  }

  modelDefaults(): ModelDefaults {
    return { ...this.#data.modelDefaults }
  }

  /** Merge (not replace) so set-model and set-thinking can each update their slice independently. */
  setModelDefaults(defaults: ModelDefaults): void {
    this.#data.modelDefaults = { ...this.#data.modelDefaults, ...defaults }
    this.#persist()
  }

  /** Favourite file paths (relative to `root`) pinned for that workspace, in pin order. */
  favourites(root: string): string[] {
    return [...(this.#data.favourites[root] ?? [])]
  }

  /**
   * Toggle a path's favourite status for a root and persist; returns the updated list. A root with
   * no favourites left is dropped from the file so unopened workspaces leave no residue.
   */
  toggleFavourite(root: string, path: string): string[] {
    const current = this.#data.favourites[root] ?? []
    const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path]
    if (next.length === 0) delete this.#data.favourites[root]
    else this.#data.favourites[root] = next
    this.#persist()
    return [...next]
  }

  /** Per-machine export presets. No Workspace path or last-used Workspace choice enters this seam. */
  exportPresetSettings(): ExportPresetSettings {
    return structuredClone(this.#data.exportPresets)
  }

  setExportPresetSettings(settings: ExportPresetSettings): ExportPresetSettings {
    const safe = normaliseExportPresetSettings(settings)
    if (!safe) throw new Error('Invalid export preset settings.')
    this.#data.exportPresets = safe
    this.#persist()
    return structuredClone(safe)
  }

  /**
   * Is the action bar shown (ADR-0040)? ONE boolean for the whole app — not per window — so every
   * window agrees and the choice survives a restart. Unset reads as the shipped default rather
   * than as `false`, because "never touched" is not "hidden".
   */
  actionBarVisible(): boolean {
    return actionBarVisibleFrom(this.get(ACTION_BAR_VISIBLE_KEY))
  }

  // ---- Generic values + changelog (Task 17: the Settings window's store) ----------------------

  /** The stored value for `key`, or null when unset (the renderer applies that surface's default). */
  get(key: string): SettingValue | null {
    return this.#data.values[key] ?? null
  }

  /** A copy of every stored value — the settings window's one-pull hydrate. */
  values(): Record<string, SettingValue> {
    return { ...this.#data.values }
  }

  /**
   * Set `key` and prepend a changelog entry recording old → new (the mockup's addLogEntry). A
   * same-value set is a complete no-op (no write, no entry). `log: false` changes the value
   * WITHOUT an entry — the path for live-surface tweaks (⌘T, prose-size keys) that are not
   * "changes made in Settings", which is what the changelog documents. A `null` value UNSETS the
   * key (deleted from the record, `get` reads null again) — the same "back to unset" semantics as
   * revert, so ⌥⌘0 reset returns a key to its locked default rather than logging a concrete value.
   */
  set(key: string, value: SettingValue | null, label: string, opts?: { log?: boolean }): ChangelogEntry | null {
    if (RETIRED_SETTING_KEYS.has(key)) return null
    const old = this.get(key)
    if (old === value) return null
    if (value === null) delete this.#data.values[key]
    else this.#data.values[key] = value
    let entry: ChangelogEntry | null = null
    if (opts?.log !== false) {
      entry = { key, label, old, new: value, at: Date.now() }
      this.#data.changelog = [entry, ...this.#data.changelog].slice(0, MAX_CHANGELOG)
    }
    this.#persist()
    return entry ? { ...entry } : null
  }

  /** The changelog, newest first (copies). */
  changelog(): ChangelogEntry[] {
    return this.#data.changelog.map((entry) => ({ ...entry }))
  }

  /** Inspect a reset before a filesystem-backed setting performs its required write. */
  revertCandidate(index: number): ChangelogEntry | null {
    const entry = this.#data.changelog[index]
    return !entry || entry.reverted ? null : { ...entry }
  }

  /**
   * Revert the entry at `index` (newest = 0): the value returns to `entry.old` (null → the key is
   * unset again) and the entry is marked `reverted` — dimmed in the UI, Reset disabled. NO mirror
   * entry is logged: the mockup resets prevValues before re-firing change, so values match and
   * nothing re-logs; honesty lives in the ` · reset` marker. A later set of the same key records
   * the reverted-to value as its `old`. Returns the updated entry, or null for a bad/spent index.
   */
  revert(index: number): ChangelogEntry | null {
    const entry = this.#data.changelog[index]
    if (!entry || entry.reverted) return null
    if (entry.old === null) delete this.#data.values[entry.key]
    else this.#data.values[entry.key] = entry.old
    entry.reverted = true
    this.#persist()
    return { ...entry }
  }
}
