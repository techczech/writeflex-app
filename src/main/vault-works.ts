/**
 * Work detection for a vault (ticket 0.25-02). Pure: a vault's file and folder listing, its
 * `vault.json` work settings and a reader for the few facts it needs from a file in; the works, the
 * Writing only hidden set and the Titles-view labels out. Nothing here touches the disk; the caller
 * (vault-index-service.ts) supplies the reader, backed by the search content cache.
 *
 * Detection order (locked notes § Concepts, made consistent with ADR-0033):
 * 1. A folder with a Folio manifest is one work (`folio`).
 * 2. A folder recognised as a folder piece is one work (`folder-piece`): by main document (folder-named
 *    file, `README.md`, `index.md`; the covers `_<folder>.md` / `_<folder>_INDEX.md` only when the index
 *    note declares `piece: one`, per ADR-0033's 2026-08-02 ruling), or because its Markdown files are
 *    numbered parts. An index note declaring `piece: many` keeps the folder a Collection.
 * 3. Any other Markdown file is one work (`file`); same-stem sidecars roll into it.
 * Folders are judged top-down: everything inside a work, support folder or hidden folder is decided by
 * that ancestor and never yields a work of its own.
 *
 * Reads are memoised for the pass, so no file is asked for twice.
 */

import type { FolioDeclaration } from './folio-declaration'
import { declaresRunningOrder } from '../shared/folio-declaration'
import { manifestPartEntries, parseManifest } from './folio'
import { parseFrontmatter } from './frontmatter'
import { listingTitle } from '../shared/markdown/listing-title'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { isAgentInstructionsName } from '../shared/folio-agent-files'
import { isConflictCopyOf } from '../shared/conflict-copy'
import { hiddenCountText, type VaultIndex, type VaultWork } from '../shared/vault-index'
import {
  CONFLICT_COPIES_RULE, DEFAULT_SUPPORT_FOLDERS, DEFAULT_VAULT_HIDDEN, EMPTY_FOLDERS_RULE, INDEX_NOTE_RULE,
} from '../shared/vault'

export { DEFAULT_SUPPORT_FOLDERS, DEFAULT_VAULT_HIDDEN }

/** The two `vault.json` settings work detection uses (ticket 01 owns the file and its reader). `hidden` is
 *  the vault's complete list of hide rules (shared/vault.ts DEFAULT_VAULT_HIDDEN documents the forms). */
export type VaultWorkSettings = { hidden: string[]; supportFolders: string[] }

/** What a vault without `hidden` / `supportFolders` keys reads as. */
export const DEFAULT_VAULT_WORK_SETTINGS: VaultWorkSettings = {
  hidden: [...DEFAULT_VAULT_HIDDEN],
  supportFolders: [...DEFAULT_SUPPORT_FOLDERS],
}

/**
 * Bounds on the `hidden` list a synced vault.json (or the Make-vault sheet) may carry; entries past them are
 * ignored with one warning per detection. `wildcards`: `*`, `**` or `?` runs per rule. `budget`: the total
 * matcher cost of all wildcard rules, where a rule costs its matcher tokens (each literal character, `?` and
 * star run is one token); a rule with no wildcard matches by equality and costs nothing. Matching one name
 * costs at most budget × name length steps, whatever the rules hold.
 */
export const HIDE_RULE_LIMITS = { entries: 200, length: 200, wildcards: 16, budget: 400 } as const

/**
 * A numbered part: digits then `-` or `_` (`01-intro.md`, `0001_body.md`), the Folio numeric-prefix rule,
 * except a date prefix (`2024-03-05-post.md`, `2024-05-notes.md`): a dated name is a work of its own, and a
 * folder of dated posts is a Collection of works, not one numbered piece.
 */
const isNumberedPart = (name: string): boolean => /^\d+[-_]/.test(name) && !/^\d{4}-\d{2}/.test(name)
const NUMERIC_ORDER = /^(\d+)[-_]/
const MARKDOWN = /\.(?:md|markdown|mdx)$/i

/** The facts detection needs from one Markdown file. */
export type MarkdownFacts = {
  /** ADR-0034 title (first heading of any level, else the file name). */
  title: string
  /** Whether `title` came from a real heading (false: it is the file-name fallback). */
  heading: boolean
  /** Frontmatter `status` as found; null when absent or empty. */
  status: string | null
  /** An index note's `piece:` declaration (ADR-0033 flip), lower-cased; null when none. */
  runningOrder?: boolean
  piece: 'one' | 'many' | null
  /** A machine-stub index note (declaration plus at most a heading): never a main document. */
  stub: boolean
}

export type VaultReader = {
  /** Facts of one listed Markdown file; null when it cannot be read. */
  markdown(path: string): MarkdownFacts | null
  /** Shared folder identity, including recorded set-aside declarations and legacy ancestry. */
  declaration(folder: string): FolioDeclaration
  /** Raw text of the Folio manifest in `folder`; null when unreadable. */
  manifest(folder: string): string | null
}

export type VaultTree = {
  /** The vault folder's own name (for the root's index note `_<name>_INDEX.md`). */
  rootName: string
  /** Every visible Markdown file, root-relative POSIX. */
  files: readonly string[]
  /** Every visible folder (including those holding no Markdown), root-relative POSIX. */
  folders: readonly string[]
  /** Folders that hold a Folio manifest file. */
  manifests: readonly string[]
}

type FolderState =
  | { kind: 'plain' }
  | { kind: 'hidden' }
  | { kind: 'support' }
  | { kind: 'work'; work: WorkDraft }
  | { kind: 'sidecar'; owner: string }

type WorkDraft = VaultWork & { root: string }

const parentOf = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut < 0 ? '' : path.slice(0, cut)
}
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const stemOf = (name: string): string => name.replace(MARKDOWN, '')
const inDir = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const depth = (path: string): number => (path === '' ? 0 : path.split('/').length)

/** One wildcard token: a literal character, `?` (one character but `/`), `*` (any run without `/`), `**` (any run). */
type Token = string | 1 | 2 | 3
const ONE = 1
const STAR = 2
const GLOBSTAR = 3

function tokenise(glob: string): Token[] {
  const tokens: Token[] = []
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]
    if (ch === '*') {
      let run = 1
      while (glob[i + 1] === '*') { run += 1; i += 1 }
      const kind = run >= 2 ? GLOBSTAR : STAR
      const last = tokens[tokens.length - 1]
      // Adjacent stars collapse: the wider one wins.
      if (last === STAR || last === GLOBSTAR) tokens[tokens.length - 1] = last === GLOBSTAR || kind === GLOBSTAR ? GLOBSTAR : STAR
      else tokens.push(kind)
    } else if (ch === '?') tokens.push(ONE)
    else tokens.push(ch)
  }
  return tokens
}

/**
 * Whether `text` matches the tokens: one row of booleans per token over the text, so the work is
 * tokens × characters whatever the pattern holds (no backtracking; a hostile `*a*a*a…b` costs the same as
 * any other pattern of its length). Both sides arrive lower-cased.
 */
function wildcardMatch(tokens: readonly Token[], text: string): boolean {
  const n = text.length
  let prev = new Uint8Array(n + 1)
  let cur = new Uint8Array(n + 1)
  prev[0] = 1
  for (const token of tokens) {
    let any = 0
    if (token === STAR || token === GLOBSTAR) {
      cur[0] = prev[0]
      for (let j = 1; j <= n; j += 1) {
        cur[j] = prev[j] || (cur[j - 1] && (token === GLOBSTAR || text[j - 1] !== '/')) ? 1 : 0
        any |= cur[j]
      }
      any |= cur[0]
    } else {
      cur[0] = 0
      for (let j = 1; j <= n; j += 1) {
        const ch = text[j - 1]
        cur[j] = prev[j - 1] && (token === ONE ? ch !== '/' : ch === token) ? 1 : 0
        any |= cur[j]
      }
    }
    if (!any) return false
    const swap = prev
    prev = cur
    cur = swap
  }
  return prev[n] === 1
}

type HidePattern = {
  /** Lower-cased literal (no wildcard), matched by equality. */
  literal: string | null
  /** The tokens between the literal prefix and suffix (empty for a literal rule). */
  tokens: Token[]
  /** Lower-cased literal text before the first wildcard and after the last: checked before the table runs. */
  prefix: string
  suffix: string
  /** Matcher tokens of the whole rule (HIDE_RULE_LIMITS.budget); 0 for a literal rule. */
  cost: number
  /** Wildcard tokens in the rule. */
  wildcards: number
  onPath: boolean
  foldersOnly: boolean
  /** A built-in housekeeping name rule (or the index-note rule): never hides a work's main document. */
  housekeeping: boolean
}

type HideRules = { patterns: HidePattern[]; conflictCopies: boolean; emptyFolders: boolean }

const HOUSEKEEPING_RULES = new Set([...DEFAULT_VAULT_HIDDEN, INDEX_NOTE_RULE].map((rule) => rule.trim().toLocaleLowerCase()))
/** Literal name rules that also cover their sync copies (`AGENTS-Desktop.md`), as the agent-file rule does. */
const AGENT_FILE_RULES = new Set(['agents.md', 'claude.md'])

function compilePattern(raw: string): HidePattern | null {
  let pattern = raw.trim().replace(/^\.\//, '')
  if (pattern === '' || pattern.startsWith(':')) return null
  const housekeeping = HOUSEKEEPING_RULES.has(pattern.toLocaleLowerCase())
  const foldersOnly = pattern.endsWith('/')
  pattern = pattern.replace(/\/+$/, '').toLocaleLowerCase()
  if (pattern === '') return null
  const onPath = pattern.includes('/')
  if (!/[*?]/.test(pattern)) return { literal: pattern, tokens: [], prefix: '', suffix: '', cost: 0, wildcards: 0, onPath, foldersOnly, housekeeping }
  const all = tokenise(pattern)
  let start = 0
  while (typeof all[start] === 'string') start += 1
  let end = all.length
  while (typeof all[end - 1] === 'string') end -= 1
  return {
    literal: null,
    tokens: all.slice(start, end),
    prefix: all.slice(0, start).join(''),
    suffix: all.slice(end).join(''),
    cost: all.length,
    wildcards: all.filter((token) => typeof token !== 'string').length,
    onPath, foldersOnly, housekeeping,
  }
}

type HideEntrySelection = {
  /** The entries detection applies (reserved `:` entries included), in list order. */
  kept: string[]
  compiled: HidePattern[]
  pastEntries: number
  tooLong: number
  tooWild: number
  overBudget: number
}

/** The entries of a `hidden` list inside HIDE_RULE_LIMITS, in order; the first rules that fit the budget win. */
function selectHideEntries(list: readonly unknown[]): HideEntrySelection {
  const selection: HideEntrySelection = { kept: [], compiled: [], pastEntries: Math.max(0, list.length - HIDE_RULE_LIMITS.entries), tooLong: 0, tooWild: 0, overBudget: 0 }
  let spent = 0
  for (const raw of list.slice(0, HIDE_RULE_LIMITS.entries)) {
    if (typeof raw !== 'string') continue
    if (raw.length > HIDE_RULE_LIMITS.length) { selection.tooLong += 1; continue }
    const entry = raw.trim()
    if (entry === CONFLICT_COPIES_RULE || entry === EMPTY_FOLDERS_RULE) { selection.kept.push(raw); continue }
    const pattern = compilePattern(entry)
    if (!pattern) continue
    if (pattern.wildcards > HIDE_RULE_LIMITS.wildcards) { selection.tooWild += 1; continue }
    if (spent + pattern.cost > HIDE_RULE_LIMITS.budget) { selection.overBudget += 1; continue }
    spent += pattern.cost
    selection.kept.push(raw)
    selection.compiled.push(pattern)
  }
  return selection
}

/**
 * A `hidden` list from an untrusted source (the Make-vault sheet's draft) cut to what detection would apply:
 * non-strings dropped, then the entry, length, wildcard and budget bounds of HIDE_RULE_LIMITS.
 */
export function boundedHiddenList(list: unknown): string[] {
  return Array.isArray(list) ? selectHideEntries(list).kept : []
}

/** The total matcher cost of a `hidden` list's wildcard rules (HIDE_RULE_LIMITS.budget). */
export function hideListCost(list: readonly string[]): number {
  return list.reduce((sum, entry) => sum + (compilePattern(entry)?.cost ?? 0), 0)
}

/**
 * The vault's `hidden` list as rules, inside HIDE_RULE_LIMITS (the rest is ignored, with one warning).
 * Reserved `:` entries switch the conflict-copy and empty-folder rules on; an unknown `:` entry is ignored.
 */
function compileHideRules(list: readonly unknown[], warn: (message: string) => void): HideRules {
  const selection = selectHideEntries(list)
  const rules: HideRules = { patterns: selection.compiled, conflictCopies: false, emptyFolders: false }
  for (const raw of selection.kept) {
    const entry = raw.trim()
    if (entry === CONFLICT_COPIES_RULE) rules.conflictCopies = true
    else if (entry === EMPTY_FOLDERS_RULE) rules.emptyFolders = true
  }
  const parts = [
    selection.pastEntries > 0 ? `${selection.pastEntries} entries past the first ${HIDE_RULE_LIMITS.entries}` : '',
    selection.tooLong > 0 ? `${selection.tooLong} entries longer than ${HIDE_RULE_LIMITS.length} characters` : '',
    selection.tooWild > 0 ? `${selection.tooWild} entries with more than ${HIDE_RULE_LIMITS.wildcards} wildcards` : '',
    selection.overBudget > 0 ? `${selection.overBudget} wildcard entries past the matching budget of ${HIDE_RULE_LIMITS.budget}` : '',
  ].filter((part) => part !== '')
  if (parts.length > 0) {
    const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    warn(`vault.json hidden: ignored ${listed}`)
  }
  return rules
}

function patternMatches(pattern: HidePattern, path: string, isFolder: boolean): boolean {
  if (pattern.foldersOnly && !isFolder) return false
  const name = nameOf(path)
  const text = (pattern.onPath ? path : name).toLocaleLowerCase()
  if (pattern.literal !== null) {
    if (pattern.literal === text) return true
    return !pattern.onPath && !isFolder && AGENT_FILE_RULES.has(pattern.literal)
      && text.startsWith(pattern.literal.slice(0, -'.md'.length)) && isAgentInstructionsName(name)
  }
  const { prefix, suffix } = pattern
  if (text.length < prefix.length + suffix.length || !text.startsWith(prefix) || !text.endsWith(suffix)) return false
  return wildcardMatch(pattern.tokens, text.slice(prefix.length, text.length - suffix.length))
}

/** Whether one `hidden` entry matches a root-relative path (reserved `:` entries match nothing here). */
export function hideEntryMatches(entry: string, path: string, isFolder: boolean): boolean {
  if (entry.length > HIDE_RULE_LIMITS.length) return false
  const pattern = compilePattern(entry)
  return pattern !== null && pattern.wildcards <= HIDE_RULE_LIMITS.wildcards && pattern.cost <= HIDE_RULE_LIMITS.budget
    && patternMatches(pattern, path, isFolder)
}

/**
 * A sync conflict copy among its folder's Markdown names. `x (1).md` beside `x.md`; any name
 * holding `-conflict-` or `conflicted copy`; or a name the shared rule (`isConflictCopyOf`) reads as a copy
 * of a sibling whose machine suffix begins with a capital (`essay-Desktop.md`, `essay-Studio Mac.md`). The
 * capital guard keeps slug-named siblings (`what-should-educators-know-about-ai.md` beside
 * `what-should-educators-know.md`) as the separate works they are.
 */
function isConflictCopyName(name: string, siblings: readonly string[]): boolean {
  const stem = stemOf(name)
  if (/-conflict-|conflicted copy/i.test(stem)) return true
  const numbered = /^(.*) \(\d+\)$/.exec(stem)
  if (numbered && siblings.some((other) => other !== name && stemOf(other).toLocaleLowerCase() === numbered[1].toLocaleLowerCase())) return true
  return siblings.some((other) => {
    if (other === name || !isConflictCopyOf(name, other)) return false
    const suffix = stem.slice(stemOf(other).length + 1)
    const firstLetter = /\p{L}/u.exec(suffix)?.[0] ?? ''
    return firstLetter !== '' && firstLetter === firstLetter.toLocaleUpperCase() && firstLetter !== firstLetter.toLocaleLowerCase()
  })
}

function partOrder(a: string, b: string): number {
  const ma = NUMERIC_ORDER.exec(nameOf(a))
  const mb = NUMERIC_ORDER.exec(nameOf(b))
  if (ma && mb) return Number(ma[1]) - Number(mb[1]) || a.localeCompare(b)
  if (ma) return -1
  if (mb) return 1
  return a.localeCompare(b)
}

/** Detect a vault's works, its Writing only hidden set and its Titles-view labels. */
export function detectVaultWorks(
  tree: VaultTree,
  settings: VaultWorkSettings,
  reader: VaultReader,
  warn: (message: string) => void = (message) => console.warn(message),
): VaultIndex {
  const files = [...new Set(tree.files)].sort()
  const fileSet = new Set(files)
  const supportNames = new Set((settings.supportFolders ?? []).map((name) => String(name).toLocaleLowerCase()))
  const rules = compileHideRules(Array.isArray(settings.hidden) ? settings.hidden : [], warn)

  // Every folder: the listed ones plus every ancestor of a listed file.
  const folderSet = new Set<string>()
  for (const folder of tree.folders) if (folder !== '') folderSet.add(folder)
  for (const file of files) for (let dir = parentOf(file); dir !== ''; dir = parentOf(dir)) folderSet.add(dir)
  const folders = [...folderSet].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))

  const childNames = new Map<string, string[]>()
  for (const file of files) {
    const dir = parentOf(file)
    const list = childNames.get(dir)
    if (list) list.push(nameOf(file))
    else childNames.set(dir, [nameOf(file)])
  }
  const namesIn = (dir: string): string[] => childNames.get(dir) ?? []

  // One read per file per pass.
  const factsMemo = new Map<string, MarkdownFacts | null>()
  const facts = (path: string): MarkdownFacts | null => {
    if (!factsMemo.has(path)) factsMemo.set(path, fileSet.has(path) ? reader.markdown(path) : null)
    return factsMemo.get(path) ?? null
  }

  const manifestMemo = new Map<string, string | null>()
  const manifestText = (folder: string): string | null => {
    if (!manifestMemo.has(folder)) manifestMemo.set(folder, reader.manifest(folder))
    return manifestMemo.get(folder) ?? null
  }

  const declaration = (folder: string): FolioDeclaration => reader.declaration(folder)

  // Which rules match a path, memoised for the pass: 0 none, 1 housekeeping only, 2 an explicit rule.
  const hideMemo = new Map<string, 0 | 1 | 2>()
  const hideLevel = (path: string, isFolder: boolean): 0 | 1 | 2 => {
    const key = `${isFolder ? 'd' : 'f'}${path}`
    let level = hideMemo.get(key)
    if (level === undefined) {
      level = 0
      for (const pattern of rules.patterns) {
        if (!patternMatches(pattern, path, isFolder)) continue
        level = pattern.housekeeping ? 1 : 2
        if (level === 2) break
      }
      hideMemo.set(key, level)
    }
    return level
  }
  const ruleHides = (path: string, isFolder: boolean): boolean => hideLevel(path, isFolder) > 0
  /** Matched by a rule the writer added (not a housekeeping name): it outranks main-document recognition. */
  const explicitlyHidden = (path: string): boolean => hideLevel(path, false) === 2
  const isConflictHidden = (path: string): boolean => rules.conflictCopies && isConflict(path)
  const coverNames = (dir: string): string[] => {
    const name = dir === '' ? tree.rootName : nameOf(dir)
    return [`_${name}_INDEX.md`, `_${name}.md`]
  }
  const conflictMemo = new Map<string, boolean>()
  const isConflict = (path: string): boolean => {
    let answer = conflictMemo.get(path)
    if (answer === undefined) {
      answer = isConflictCopyName(nameOf(path), namesIn(parentOf(path)))
      conflictMemo.set(path, answer)
    }
    return answer
  }

  /** A Markdown file that could stand as a work, judged by name in a plain folder. */
  const standsAlone = (path: string): boolean => {
    const name = nameOf(path)
    return fileSet.has(path) && !ruleHides(path, false) && !isConflictHidden(path) && !coverNames(parentOf(path)).includes(name)
  }

  /** The file a same-stem sidecar name belongs to (`x.review.md` → `x.md`), resolved to its outermost owner. */
  const sidecarOwnerOfFile = (path: string): string | null => {
    const dir = parentOf(path)
    let stem = stemOf(nameOf(path))
    let owner: string | null = null
    for (let dot = stem.lastIndexOf('.'); dot > 0; dot = stem.lastIndexOf('.')) {
      stem = stem.slice(0, dot)
      const candidate = inDir(dir, `${stem}.md`)
      if (candidate !== path && standsAlone(candidate)) owner = candidate
    }
    return owner
  }
  /** The file a sidecar folder belongs to (`x.editing/` → `x.md`): the longest dotted stem with a sibling
   *  `.md` that stands alone (`essay.v2.editing/` → `essay.v2.md`, else `essay.md`). */
  const sidecarOwnerOfFolder = (folder: string): string | null => {
    const name = nameOf(folder)
    for (let dot = name.lastIndexOf('.'); dot > 0; dot = name.lastIndexOf('.', dot - 1)) {
      const candidate = inDir(parentOf(folder), `${name.slice(0, dot)}.md`)
      if (standsAlone(candidate)) return sidecarOwnerOfFile(candidate) ?? candidate
    }
    return null
  }

  const works = new Map<string, WorkDraft>()
  const newWork = (path: string, kind: VaultWork['kind'], mainPath: string | null, fallbackTitle: string, extraStatus: string | null = null): WorkDraft => {
    const main = mainPath ? facts(mainPath) : null
    const work: WorkDraft = {
      root: path,
      path,
      kind,
      // ADR-0034: the main document's first heading; without one, the work's own name (for a folder work,
      // the folder's name, never the main document's file name).
      title: (main?.heading ? main.title.trim() : '') || fallbackTitle,
      status: main?.status ?? extraStatus,
      mainPath,
      parts: [],
      sidecars: [],
      support: [],
    }
    works.set(path, work)
    return work
  }

  /** A file that may serve as a main document: listed and not hidden by a rule the writer added. */
  const mainCandidate = (path: string): boolean => fileSet.has(path) && !explicitlyHidden(path)

  /** ADR-0033 main document of a folder that has no manifest, or null. */
  const folderPieceMain = (folder: string, declared: 'one' | 'many' | null): string | null => {
    const name = nameOf(folder)
    for (const candidate of [`${name}.md`, 'README.md', 'index.md']) {
      const path = inDir(folder, candidate)
      if (mainCandidate(path)) return path
    }
    if (declared !== 'one') return null
    const short = inDir(folder, `_${name}.md`)
    if (mainCandidate(short)) return short
    const index = inDir(folder, `_${name}_INDEX.md`)
    if (mainCandidate(index) && !facts(index)?.stub) return index
    return null
  }

  /** A folder whose own content files are all numbered parts (at least two). */
  const hasNumberedParts = (folder: string): boolean => {
    const content = namesIn(folder).filter((name) => {
      const path = inDir(folder, name)
      return !name.startsWith('_') && standsAlone(path) && sidecarOwnerOfFile(path) === null
    })
    return content.length >= 2 && content.every(isNumberedPart)
  }

  const hiddenFolders: string[] = []
  const hiddenFiles: string[] = []
  const state = new Map<string, FolderState>()
  state.set('', { kind: 'plain' })

  for (const folder of folders) {
    const parent = state.get(parentOf(folder)) ?? { kind: 'plain' }
    const name = nameOf(folder)
    let next: FolderState
    if (parent.kind === 'hidden') next = parent
    else if (ruleHides(folder, true)) {
      next = { kind: 'hidden' }
      hiddenFolders.push(folder)
    } else if (parent.kind !== 'plain') next = parent
    else if (supportNames.has(name.toLocaleLowerCase())) next = { kind: 'support' }
    else {
      const owner = sidecarOwnerOfFolder(folder)
      if (owner) next = { kind: 'sidecar', owner }
      else if (declaration(folder).isFolio) {
        next = { kind: 'work', work: folioWork(folder) }
      } else {
        const index = inDir(folder, `_${name}_INDEX.md`)
        const declared = fileSet.has(index) ? facts(index)?.piece ?? null : null
        const main = declared === 'many' ? null : folderPieceMain(folder, declared)
        if (main || declared === 'one' || (declared !== 'many' && hasNumberedParts(folder))) {
          next = { kind: 'work', work: newWork(folder, 'folder-piece', main, name) }
        } else next = { kind: 'plain' }
      }
    }
    state.set(folder, next)
  }

  function folioWork(folder: string): WorkDraft {
    const name = nameOf(folder)
    const raw = manifestText(folder) ?? ''
    const manifest = parseManifest(folder, raw)
    let manifestStatus: string | null = null
    try {
      const json = JSON.parse(raw) as Record<string, unknown>
      if (typeof json.status === 'string' && json.status.trim() !== '') manifestStatus = json.status.trim()
    } catch { /* parseManifest already judged it */ }
    // Folio title and status: folder-named file, then README, then index (spec: "Folio: README/manifest
    // status"); a manifest part's heading names a section, not the work.
    const main = [`${name}.md`, 'README.md', 'index.md'].map((candidate) => inDir(folder, candidate)).find(mainCandidate) ?? null
    const work = newWork(folder, 'folio', main, name, manifestStatus)
    if (manifest) {
      const parts = new Set<string>()
      for (const { path } of manifestPartEntries(folder, manifest, fileSet)) {
        if (path && !isAgentInstructionsName(path) && path !== main) parts.add(path)
      }
      work.parts = [...parts]
    }
    return work
  }

  const folderOf = (path: string): FolderState => state.get(parentOf(path)) ?? { kind: 'plain' }
  const pendingSidecars: Array<{ path: string; owner: string }> = []
  const looseInWork: Array<{ path: string; work: WorkDraft }> = []
  /** Visible Markdown that counts as content for the empty-folder rule. */
  const contentFiles: string[] = []

  for (const path of files) {
    const where = folderOf(path)
    if (where.kind === 'hidden') continue
    const name = nameOf(path)
    // A main document is never hidden by a housekeeping name; a rule the writer added already kept it from being main.
    const isMain = where.kind === 'work' && where.work.mainPath === path
    if (!isMain && (ruleHides(path, false) || isConflictHidden(path))) {
      hiddenFiles.push(path)
      continue
    }
    contentFiles.push(path)
    if (where.kind === 'work') {
      if (!isMain) looseInWork.push({ path, work: where.work })
    } else if (where.kind === 'sidecar') pendingSidecars.push({ path, owner: where.owner })
    else if (where.kind === 'plain') {
      if (coverNames(parentOf(path)).includes(name)) continue // a cover: not a work, not hidden
      const owner = sidecarOwnerOfFile(path)
      if (owner) pendingSidecars.push({ path, owner })
      else newWork(path, 'file', path, stemOf(name))
    }
    // support folder outside any work: visible material, never a work
  }

  for (const { path, owner } of pendingSidecars) {
    const work = works.get(owner)
    if (work) work.sidecars.push(path)
    else newWork(path, 'file', path, stemOf(nameOf(path)))
  }

  for (const { path, work } of looseInWork) {
    if (work.parts.includes(path)) continue
    const relative = path.slice(work.root.length + 1)
    const segments = relative.split('/')
    const name = segments[segments.length - 1]
    if (segments.length === 1) {
      if (work.kind === 'folder-piece' && !name.startsWith('_') && sidecarOwnerOfFile(path) === null) work.parts.push(path)
      else if (sidecarOwnerOfFile(path) !== null) work.sidecars.push(path)
      else work.support.push(path)
      continue
    }
    const topFolder = inDir(work.root, segments[0])
    if (sidecarOwnerOfFolder(topFolder) !== null) work.sidecars.push(path)
    else work.support.push(path)
  }
  for (const work of works.values()) if (work.kind === 'folder-piece') work.parts.sort(partOrder)

  // Empty folders: plain or support folders outside any work whose subtree holds no work and no content.
  const filled = new Set<string>()
  const fill = (path: string): void => {
    for (let dir = path; dir !== '' && !filled.has(dir); dir = parentOf(dir)) filled.add(dir)
  }
  for (const path of contentFiles) fill(parentOf(path))
  for (const work of works.values()) if (work.kind !== 'file') fill(work.root)
  for (const folder of rules.emptyFolders ? folders : []) {
    const kind = state.get(folder)?.kind
    if ((kind !== 'plain' && kind !== 'support') || filled.has(folder)) continue
    const parent = parentOf(folder)
    const parentKind = state.get(parent)?.kind
    const parentEmpty = parent !== '' && (parentKind === 'plain' || parentKind === 'support') && !filled.has(parent)
    if (!parentEmpty) hiddenFolders.push(folder)
  }

  const ordered = [...works.values()].sort((a, b) => a.path.localeCompare(b.path))
  const labels: Record<string, string> = {}
  for (const work of ordered) labels[work.path] = work.title
  // Top-most only: an entry under a hidden folder is not listed (a folder hidden as empty may hold hidden files).
  const hiddenFolderSet = new Set(hiddenFolders)
  const underHidden = (path: string): boolean => {
    for (let dir = parentOf(path); dir !== ''; dir = parentOf(dir)) if (hiddenFolderSet.has(dir)) return true
    return false
  }
  const topFolders = hiddenFolders.filter((path) => !underHidden(path))
  const topFiles = hiddenFiles.filter((path) => !underHidden(path))
  const paths = [...topFolders, ...topFiles].sort()
  return {
    works: ordered.map(({ root: _root, ...work }) => work),
    hidden: { paths, countText: hiddenCountText(topFolders.length, topFiles.length) },
    labels,
    workFolders: ordered.filter((work) => work.kind !== 'file').map((work) => work.path),
  }
}

/** Facts of one Markdown file from its content and its ADR-0034 title (the caller's cached title rule):
 *  frontmatter `status`, and an index note's `piece:` declaration and stub shape. */
export function markdownFactsFrom(content: string, path: string, title: string): MarkdownFacts {
  const frontmatter = parseFrontmatter(content)
  const status = frontmatter?.status?.trim() || null
  const rawPiece = frontmatter?.extra.piece
  const normalised = typeof rawPiece === 'string' ? rawPiece.trim().toLowerCase() : ''
  const piece = normalised === 'one' || normalised === 'many' ? normalised : null
  let stub = false
  if (piece && /^_.+_INDEX\.md$/.test(nameOf(path))) {
    const block = frontmatterBlock(content)
    const body = block ? content.slice(block.end) : content
    const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    stub = lines.length === 0 || (lines.length === 1 && /^#{1,6}\s+\S/.test(lines[0]))
  }
  return { title, status, piece, stub, runningOrder: declaresRunningOrder(content), heading: hasHeading(content, path, title) }
}

const HEADING_LIKE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|=+[ \t]*$|-+[ \t]*$)/m
/** A title-rule sentinel no real heading can equal (control characters never survive inline text). */
const NO_HEADING = '\u0001\u0002'

/** Whether the ADR-0034 title of `content` is a heading rather than the file-name fallback. A title other
 *  than the stem is a heading; a title equal to the stem is checked against the title rule itself. */
function hasHeading(content: string, path: string, title: string): boolean {
  if (title !== stemOf(nameOf(path))) return true
  if (!HEADING_LIKE.test(content)) return false
  return listingTitle(content, `${NO_HEADING}.md`) !== NO_HEADING
}
