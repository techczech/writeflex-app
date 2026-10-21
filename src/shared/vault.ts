/**
 * The vault file (`.writeflex/vault.json`, version 1): its settings shape, the defaults a missing or
 * mistyped field reads as, and the pin-path rule. Shared by main (vault-store.ts, which owns every
 * read and write) and the renderer (tickets 03–06 import these types through the preload bridge).
 *
 * Pure and dependency-free: no filesystem, no Electron.
 */

/** The status ladder's steps, in order. */
export const VAULT_STEPS = ['Idea', 'Notes', 'Drafting', 'In review', 'Final', 'Done'] as const
export type VaultStep = (typeof VAULT_STEPS)[number]

const IN_PROGRESS_STEPS: readonly VaultStep[] = ['Notes', 'Drafting', 'In review', 'Final']

/** Works whose status maps to Notes, Drafting, In review or Final: the sidebar's and the start screen's "in progress". */
export function inProgressCount(works: ReadonlyArray<{ status: string | null }>, statusMap: Readonly<Record<string, VaultStep>>): number {
  return works.filter((work) => {
    const step = work.status === null ? undefined : statusMap[work.status]
    return step !== undefined && IN_PROGRESS_STEPS.includes(step)
  }).length
}

/** Folder names that never yield works (a work's sources, builds and the like). */
export const DEFAULT_SUPPORT_FOLDERS: readonly string[] = [
  'source', 'sources', 'research', 'feedback', 'html', 'build', 'assets', 'evidence', 'exports', 'scripts', 'versions',
]

/** Reserved `hidden` entry: hide sync conflict copies. A leading colon marks a rule, not a
 *  file-name pattern (no real file or folder pattern a writer types starts with `:`). */
export const CONFLICT_COPIES_RULE = ':conflict-copies'
/** Reserved `hidden` entry: hide folders left with no work and no content Markdown. */
export const EMPTY_FOLDERS_RULE = ':empty-folders'
/** Optional `hidden` entry the Make-vault sheet offers: index notes (folder covers). Not in the built-in list. */
export const INDEX_NOTE_RULE = '_*_INDEX.md'

/**
 * The built-in hide rules: what `hidden` reads as when the file has no `hidden` key. `hidden` is the
 * vault's COMPLETE list of hide rules (not additions to a fixed list): detection applies exactly the
 * entries listed. A pattern without `/` matches a name at any level, one with `/` the root-relative path,
 * a trailing `/` limits it to folders; `*`, `**`, `?` are wildcards; case is ignored. Entries starting with
 * `:` are reserved rules (`:conflict-copies`, `:empty-folders`). A work's main document is never hidden by
 * these housekeeping names (README.md inside a Folio stays the Folio's main document).
 */
export const DEFAULT_VAULT_HIDDEN: readonly string[] = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'README.md', 'CONTEXT.md',
  '_TASK-LOG/', '_AGENT-INSTRUCTIONS/', '_ADR/', '_sources/', '_TEMPLATE/', 'cache/', 'tools/', '__pycache__/',
  CONFLICT_COPIES_RULE, EMPTY_FOLDERS_RULE,
]

/** The known fields of a version-1 vault file. Unknown keys in the file are kept by main on every write. */
export type VaultSettings = {
  version: 1
  /** Display name; the folder's name when the file names none. */
  name: string
  /** Ordered root-relative POSIX paths of pinned folders and Markdown documents (`.md`), one shared drag
   *  order: no leading "./", no "..", no trailing "/". The kind is read from disk (VaultView.pinKinds). */
  pins: string[]
  /** The complete list of hide rules (see DEFAULT_VAULT_HIDDEN); absent in the file → the built-in list. */
  hidden: string[]
  supportFolders: string[]
  /** Raw frontmatter status -> step; insertion order kept. */
  statusMap: Record<string, VaultStep>
  ladder: string[]
}

/** What a pin names on disk right now: a folder, a Markdown document, or nothing pinnable (`missing`:
 *  gone, or no longer a folder or `.md` document inside the root). */
export type VaultPinKind = 'folder' | 'document' | 'missing'

/** The file extension a pinnable document carries. */
export const PIN_DOCUMENT_EXTENSION = /\.md$/i

/** What the renderer is given for the window's root when it is a vault (null when it is not). */
export type VaultView = {
  settings: VaultSettings
  /** Each pin in `settings.pins` with what it names on disk as main read it, in pin order. A list of
   *  [path, kind] pairs rather than an object, so a folder named `__proto__` keeps its entry across the
   *  IPC hop. The sidebar trusts the live tree over this reading when the two differ (vault-pins.ts). */
  pinKinds: Array<[string, VaultPinKind]>
  /** The file holds something that is not a JSON object: `settings` are the defaults, and no pin
   *  operation or create writes over it. */
  unreadable: boolean
  /** Content hash of the file's bytes as read; a whole save passes it back as its base. */
  hash: string
}

/** What a create may propose (the Make-vault sheet); every missing field takes its default. */
export type VaultCreateInput = Partial<Omit<VaultSettings, 'version'>>

export type VaultWriteRefusal = 'not-a-vault' | 'exists' | 'unreadable' | 'invalid' | 'changed' | 'refused'

/** The answer to every vault write. On `changed` nothing was written and `vault` is the file as it now is. */
export type VaultWriteResult =
  | { ok: true; vault: VaultView }
  | { ok: false; reason: VaultWriteRefusal; message: string; vault?: VaultView | null }

/** Pushed to every window on the root after any change. `outside`: the change came from outside this
 *  app (another Mac via file sync, git, an editor); false for this app's own writes. */
export type VaultChangedEvent = { vault: VaultView | null; outside: boolean }

/** The defaults, named for the folder (`folderName` is the root's last segment). */
export function defaultVaultSettings(folderName: string): VaultSettings {
  return {
    version: 1,
    name: folderName,
    pins: [],
    hidden: [...DEFAULT_VAULT_HIDDEN],
    supportFolders: [...DEFAULT_SUPPORT_FOLDERS],
    statusMap: {},
    ladder: [...VAULT_STEPS],
  }
}

const isStep = (value: unknown): value is VaultStep => typeof value === 'string' && (VAULT_STEPS as readonly string[]).includes(value)

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : null

/**
 * A pin path in its stored form, or the reason it cannot be one. The normalisation is structural only:
 * a leading "./", a trailing "/", doubled "/" and "." segments go; spaces are never trimmed, because a
 * folder may be named " reports " beside "reports". Refuses an absolute path, any ".." segment, a
 * backslash, an empty path, the root itself and anything in the vault's own `.writeflex` folder.
 * Folder or document is not told here: main reads that from disk.
 */
export function normalisePinPath(input: unknown): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof input !== 'string') return { ok: false, message: 'A pin must be named by a path.' }
  const raw = input
  if (raw.includes('\\') || raw.includes('\0')) return { ok: false, message: `${raw} is not a path inside this vault.` }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { ok: false, message: `${raw} is not inside this vault (it is an absolute path).` }
  const segments = raw.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) return { ok: false, message: `${raw} reaches outside this vault ("..").` }
  if (segments.length === 0) return { ok: false, message: 'The vault folder itself cannot be pinned.' }
  if (segments[0]!.toLowerCase() === '.writeflex') return { ok: false, message: `${raw} is the vault's own settings folder and cannot be pinned.` }
  return { ok: true, path: segments.join('/') }
}

/** Distinct normalised pins in first-seen order; entries that are not pin paths are dropped. */
function pinList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const pins: string[] = []
  for (const entry of value) {
    const normal = normalisePinPath(entry)
    if (normal.ok && !pins.includes(normal.path)) pins.push(normal.path)
  }
  return pins
}

function statusMapOf(value: unknown): Record<string, VaultStep> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const map: Record<string, VaultStep> = {}
  for (const [raw, step] of Object.entries(value)) if (isStep(step)) map[raw] = step
  return map
}

/** The settings a parsed file reads as: each known field when it has the right type, else its default. */
export function settingsFromRaw(raw: Record<string, unknown>, folderName: string): VaultSettings {
  const defaults = defaultVaultSettings(folderName)
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : defaults.name
  return {
    version: 1,
    name,
    pins: pinList(raw.pins) ?? defaults.pins,
    hidden: stringList(raw.hidden) ?? defaults.hidden,
    supportFolders: stringList(raw.supportFolders) ?? defaults.supportFolders,
    statusMap: statusMapOf(raw.statusMap) ?? defaults.statusMap,
    ladder: stringList(raw.ladder) ?? defaults.ladder,
  }
}

/**
 * Settings the renderer sent for a create or a whole save, checked field by field. A field that is
 * present must have the right type (a wrong one refuses the whole request); pins are normalised.
 */
export function checkSettingsInput(input: unknown): { ok: true; fields: Partial<Omit<VaultSettings, 'version'>> } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, fields: {} }
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Vault settings must be an object.' }
  const value = input as Record<string, unknown>
  const fields: Partial<Omit<VaultSettings, 'version'>> = {}
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.trim() === '') return { ok: false, message: 'The vault name must be some text.' }
    fields.name = value.name
  }
  if (value.pins !== undefined) {
    if (!Array.isArray(value.pins)) return { ok: false, message: 'Pins must be a list of folder or document paths.' }
    const pins: string[] = []
    for (const entry of value.pins) {
      const normal = normalisePinPath(entry)
      if (!normal.ok) return { ok: false, message: normal.message }
      if (!pins.includes(normal.path)) pins.push(normal.path)
    }
    fields.pins = pins
  }
  for (const key of ['hidden', 'supportFolders', 'ladder'] as const) {
    if (value[key] === undefined) continue
    const list = stringList(value[key])
    if (!list) return { ok: false, message: `${key} must be a list of names.` }
    fields[key] = list
  }
  if (value.statusMap !== undefined) {
    const map = value.statusMap
    if (!map || typeof map !== 'object' || Array.isArray(map)) return { ok: false, message: 'The status map must map statuses to steps.' }
    for (const step of Object.values(map)) if (!isStep(step)) return { ok: false, message: `${String(step)} is not a status step.` }
    fields.statusMap = { ...(map as Record<string, VaultStep>) }
  }
  return { ok: true, fields }
}
