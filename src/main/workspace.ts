import { join, relative, resolve, sep, dirname, basename, extname, isAbsolute, posix } from 'node:path'
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { parseFrontmatter } from './frontmatter'
import { OwnWriteTracker } from './workspace-watcher'
import { SearchIndex, SEARCH_INDEX_READ_CONCURRENCY } from './search-index'
import { comparePieces, parseQuery, pieceTitle, snippetOf, type LineHit, type PieceHit, type RankKey, type Snippet } from './search-query'
import { isPathInSearchScope } from '../shared/search-scope'
import { textForSave } from '../shared/line-endings'

export type MarkdownFile = { path: string; name: string; directory: string; modifiedAt: number; size: number }
export type FileReadResult = { file: MarkdownFile; content: string }
/** A checklist note's progress as the Files tree and Quick Open show it: "done / total". */
export type ChecklistProgress = { path: string; done: number; total: number }
/** A reference-material file under research/ (Task 21, PRD S30). `kind` drives the row icon and the
 *  open-vs-reveal split: md sources open in a tab, everything else reveals in the OS file manager. */
export type SourceKind = 'md' | 'pdf' | 'image' | 'other'
export type SourceFile = { name: string; path: string; kind: SourceKind; size: number }
/** One matching piece, located at its best line. column/length are 1-based char offsets into the
 *  untrimmed doc line, so the renderer can place a real selection over the primary hit
 *  (jump-to-match); `snippet` is that line as the result row shows it, every term marked. */
export type SearchMatch = {
  path: string
  line: number
  column: number
  length: number
  preview: string
  /** Every term span on the best line, 1-based columns into `preview` (the untrimmed line, capped at
   *  200 chars — a span past the cap is the renderer's to clip), so the preview can mark them all. */
  marks: LineHit[]
  context: { before: string[]; after: string[] }
  snippet: Snippet
}
/** The search result: one match per piece, ranked, capped; `total` counts every matching piece so
 *  the panel can say how many the cap left out. `note` is 'literal' when an invalid /regex/ fell
 *  back to a literal search. */
export type SearchResult = { matches: SearchMatch[]; total: number; note?: 'literal'; scope?: SearchScopeCounts }
/** A folder scope for `search` (focus a folder, ticket 03): `folder` is workspace-relative; `results`
 *  says which side the matches come from — the focused folder (the default) or everywhere. Both
 *  counts come back either way, so the panel always shows what the narrowing leaves out. */
export type SearchScope = { folder: string; results?: 'folder' | 'everywhere' }
export type SearchScopeCounts = { folder: string; results: 'folder' | 'everywhere'; inFolder: number; everywhere: number }

/** Whether a workspace-relative path lies in `folder` (at any depth); '' is the whole workspace. */
export function isPathInFolder(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(`${folder}/`)
}
/** Pieces a search returns at most; the rest are counted in `total`. */
export const SEARCH_RESULT_CAP = 300
export type SaveFileOptions = {
  allowExplicitEmpty?: boolean
  /**
   * Main-process only (a function cannot cross IPC, and no handler forwards renderer options here). Called
   * synchronously in the SAME TICK as the rename that commits the save: check, then renameSync, with no await
   * between. If it throws, the temp file is removed, the document on disk is untouched, and the save rejects
   * with what it threw. The invariant: a refusal raised before a file's commit syscall stops that commit;
   * nothing after the commit is undone.
   */
  beforeCommit?: () => void
}

/**
 * Whether a workspace-relative path lies inside a hidden folder (any folder whose name starts with a dot:
 * `.writeflex`, `.bridle`, `.git`, ..., in any letter case and with stray spaces), climbs out with `..`, or is
 * not a relative path at all. The ONE rule for "not a writer's document": no Change may target such a path and
 * no widget is made beside one. A dot-prefixed FILE in a visible folder is not hidden by this rule.
 */
export function isHiddenWorkspacePath(path: unknown): boolean {
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0') || isAbsolute(path)) return true
  const segments = posix.normalize(path.replace(/\\/g, '/')).split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((segment) => segment === '..')) return true
  return segments.slice(0, -1).some((segment) => segment.trim().startsWith('.'))
}

export class EmptyWriteRefusal extends Error {
  override readonly name = 'EmptyWriteRefusal'

  constructor(
    readonly path: string,
    readonly rescueDirectory: string,
    readonly previousRescuePath: string,
    readonly rejectedRescuePath: string,
  ) {
    super(
      `WriteFlex prevented an empty save over ${path}. The previous content is intact. ` +
      `Rescue copies are in ${rescueDirectory}. Choose “Clear document…” from the Command Palette ` +
      'if you meant to remove everything.',
    )
  }
}

/**
 * saveFile wrote the file (the atomic write committed) and then could not read it back. The save is NOT undone
 * and must not be treated as a failed save: a caller that rolls back companion work on a save error has to
 * tell this case apart, because the document on disk already holds the new text.
 */
export class SavedButNotReadBack extends Error {
  override readonly name = 'SavedButNotReadBack'

  constructor(readonly path: string, readonly reason: string) {
    super(`${path} was saved, but could not be read back afterwards (${reason}).`)
  }
}

const MARKDOWN_EXTENSION = /\.(md|markdown|mdx)$/i
const PDF_EXTENSION = /\.pdf$/i
const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|svg|bmp|tiff?|heic|heif|avif|ico)$/i
const IGNORED_DIRS = new Set(['.git', '.bridle', '.writeflex', '.obsidian', 'node_modules', 'out', 'release'])
/** Directories whose contents surface in the Sources pane (Task 21). `research/` is the built-in
 *  convention; Folio-manifest-declared `source` dirs join this list in Task 24 (the named seam). */
const SOURCE_DIRS = ['research']

/** Classify a source file by extension for its row icon (Task 21). Non-md kinds reveal in Finder. */
function sourceKind(name: string): SourceKind {
  if (MARKDOWN_EXTENSION.test(name)) return 'md'
  if (PDF_EXTENSION.test(name)) return 'pdf'
  if (IMAGE_EXTENSION.test(name)) return 'image'
  return 'other'
}

/** Sidebar naming rule (ADR-0017, from TalkWeaver): keep the typed name faithfully — only strip
 *  path separators and trim. Slugging is for agent/palette flows; a person renaming a file gets
 *  exactly the name they typed or a refusal, never a silent transformation. */
export function sanitiseFileName(input: string): string {
  return input.trim().replace(/[/\\]/g, '-')
}

export function slugifyFileName(input: string): string {
  const withoutExtension = input.replace(MARKDOWN_EXTENSION, '')
  const slug = withoutExtension.toLowerCase().replace(/['"']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'untitled'}.md`
}

export function normaliseMarkdownPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) throw new Error('Path is required.')
  return MARKDOWN_EXTENSION.test(trimmed) ? trimmed : `${trimmed}.md`
}

export function pastedImagePath(ext: string, now = new Date(), exists: (path: string) => boolean): string {
  const cleanExt = ext.toLowerCase().replace(/^\./, '').replace(/[^a-z0-9]/g, '') || 'png'
  const iso = now.toISOString()
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, '')}`
  const base = `assets/pasted-${stamp}`
  let candidate = `${base}.${cleanExt}`
  let counter = 2
  while (exists(candidate)) candidate = `${base}-${counter++}.${cleanExt}`
  return candidate
}

/**
 * Boundary guard for renderer-supplied favourite paths (called from the ipc handler, not the store):
 * favourites are persisted POSIX-relative to the workspace root, so reject empty, absolute, or
 * `..`-escaping strings before they can be written into settings.json. The normalised form is checked
 * with posix semantics because that is how favourites are stored.
 */
export function assertRelativeWorkspacePath(path: string): void {
  const invalid = new Error('favourite path must be workspace-relative')
  if (typeof path !== 'string' || path.trim() === '' || isAbsolute(path)) throw invalid
  const normalised = posix.normalize(path)
  if (normalised === '..' || normalised.startsWith('../')) throw invalid
}

/** The query parser and piece matcher live in search-query.ts; re-exported so existing callers keep one import. */
export { parseQuery } from './search-query'
export type { LineHit, Matcher, PieceHit } from './search-query'

/**
 * A file's frontmatter tags, for the `tag:` search filter. Delegates to the frontmatter organ
 * (Task 22) — the inline block-list-only reader is gone, so inline `[a, b]` tags now match in search
 * too. A file with no frontmatter (or no `tags:` key) yields no tags. This module never writes.
 */
export function extractFrontmatterTags(content: string): string[] {
  return parseFrontmatter(content)?.tags ?? []
}

/** For a tag-only query: locate the frontmatter list item whose value matches a tag term, so the
 *  single per-file hit selects the tag value. Falls back to the first line. */
function lineContext(lines: string[], index: number): SearchMatch['context'] {
  return {
    before: lines.slice(Math.max(0, index - 2), index).map((line) => line.slice(0, 200)),
    after: lines.slice(index + 1, index + 3).map((line) => line.slice(0, 200)),
  }
}

function locateTagHit(lines: string[], tagTerms: string[]): Omit<SearchMatch, 'path' | 'marks' | 'snippet'> {
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      if (lines[i].trim() === '---') break
      const m = /^([ \t]*-[ \t]*)(.+?)[ \t]*$/.exec(lines[i])
      if (!m) continue
      const value = m[2].replace(/^["']|["']$/g, '')
      if (tagTerms.some((t) => t.toLowerCase() === value.toLowerCase())) {
        return {
          line: i + 1,
          column: m[1].length + 1,
          length: m[2].length,
          preview: lines[i].slice(0, 200),
          context: lineContext(lines, i),
        }
      }
    }
  }
  return {
    line: 1,
    column: 1,
    length: 0,
    preview: lines[0]?.slice(0, 200) ?? '',
    context: lineContext(lines, 0),
  }
}

export class Workspace {
  #realRoot: string | undefined
  readonly #ownWrites = new OwnWriteTracker()
  /** Content cache behind `search` (search-index.ts). Public so the watcher can invalidate paths and
   *  tests can count reads at the seam. */
  readonly searchIndex = new SearchIndex(
    (path) => readFile(this.absolute(path), 'utf8'),
    extractFrontmatterTags,
    SEARCH_INDEX_READ_CONCURRENCY,
    pieceTitle,
  )

  constructor(readonly root: string) {}

  absolute(path: string): string {
    const resolved = resolve(this.root, path)
    const rel = relative(this.root, resolved)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Path is outside the open Workspace.')
    this.#assertNoSymlinkEscape(resolved)
    return resolved
  }

  /**
   * The lexical check above only catches `..` traversal; a symlink INSIDE the root can still
   * point anywhere on disk (e.g. `<root>/x` -> `/etc`), and readFile/writeFile/rename all follow
   * symlinks. Resolve the real path and re-check containment against the workspace's real root,
   * purely as a validation gate — the caller keeps using the lexical `resolved` it already has, so
   * every existing caller/test that combines `absolute()` output with `relative()`/`dirname()`
   * (which are lexical-root-relative) stays byte-identical. Without this, the mkdtemp roots used
   * in tests would realpath to a different absolute prefix on macOS (/var -> /private/var) and
   * break unrelated assertions that compare against `join(root, ...)`.
   */
  #assertNoSymlinkEscape(resolved: string): void {
    const realRoot = (this.#realRoot ??= realpathSync(this.root))
    const real = existsSync(resolved) ? realpathSync(resolved) : this.#realpathDeepestExisting(resolved)
    const rel = relative(realRoot, real)
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Path is outside the open Workspace.')
  }

  /** realpath the deepest existing ancestor (the target itself may not exist yet, e.g. createFile), then re-append the non-existing tail. */
  #realpathDeepestExisting(target: string): string {
    let existing = target
    const tail: string[] = []
    while (!existsSync(existing)) {
      const parent = dirname(existing)
      if (parent === existing) break
      tail.unshift(basename(existing))
      existing = parent
    }
    const real = realpathSync(existing)
    return tail.length ? join(real, ...tail) : real
  }

  relative(abs: string): string {
    return relative(this.root, abs).split(sep).join('/')
  }

  /** Mark an app-owned filesystem mutation before it lands so the native watcher cannot race it. */
  recordOwnWrite(path: string, at = Date.now()): void {
    this.#ownWrites.record(path, at)
    // The write is about to land; the cached text for this path is stale by definition.
    this.searchIndex.invalidate([path])
  }

  wasRecentlyWrittenByApp(path: string, at = Date.now()): boolean {
    return this.#ownWrites.isRecent(path, at)
  }

  /** Whether the Markdown walker can surface this path. File basenames remain eligible even when
   *  dot-prefixed; only containing directories are filtered. */
  isVisiblePath(path: string): boolean {
    return !path.split('/').slice(0, -1).some((segment) => IGNORED_DIRS.has(segment) || segment.startsWith('.'))
  }

  async listFiles(): Promise<MarkdownFile[]> {
    return this.#walk(this.root)
  }

  /**
   * The Markdown files inside one folder (the whole workspace when `dir` is ''): exactly what `listFiles`
   * filtered to that folder returns, but costing work proportional to that folder. `recursive: false`
   * lists direct children only. The folder goes through `absolute()` (containment; a symlink leaving the
   * root throws). A folder that is hidden, ignored or missing lists nothing, and so does a folder that
   * is a symbolic link or lies beneath one: the whole-workspace walk never enters a symlink, so its
   * files are in no listing.
   */
  async listFilesIn(dir: string, options: { recursive?: boolean } = {}): Promise<MarkdownFile[]> {
    if (dir === '') return this.#walk(this.root, options.recursive !== false)
    if (!this.isVisiblePath(`${dir}/file.md`)) return []
    try {
      const base = this.absolute(dir)
      // lstat, never stat: each folder from the root down to `dir` must be a real directory.
      let cursor = this.root
      for (const segment of relative(this.root, base).split(sep)) {
        cursor = join(cursor, segment)
        if (!(await lstat(cursor)).isDirectory()) return []
      }
      return await this.#walk(base, options.recursive !== false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return []
      throw error
    }
  }

  /** Every directory under the root (same ignore rules as the file walk), so the sidebar can show
   *  EMPTY folders too — a just-created folder must be visible before it holds a file (ADR-0017,
   *  TalkWeaver's folder-completion rule). Relative POSIX paths, sorted. */
  async listFolders(): Promise<string[]> {
    const out: string[] = []
    const walk = async (base: string): Promise<void> => {
      const entries = await readdir(base, { withFileTypes: true })
      for (const entry of entries) {
        const absolute = join(base, entry.name)
        if (!entry.isDirectory() || !this.isVisiblePath(`${this.relative(absolute)}/file.md`)) continue
        out.push(this.relative(absolute))
        await walk(absolute)
      }
    }
    await walk(this.root)
    return out.sort((a, b) => a.localeCompare(b))
  }

  async #walk(base: string, recursive = true): Promise<MarkdownFile[]> {
    const entries = await readdir(base, { withFileTypes: true })
    const files: MarkdownFile[] = []
    for (const entry of entries) {
      const absolute = join(base, entry.name)
      if (entry.isDirectory()) {
        if (recursive && this.isVisiblePath(`${this.relative(absolute)}/file.md`)) files.push(...await this.#walk(absolute))
        continue
      }
      if (!entry.isFile() || !MARKDOWN_EXTENSION.test(entry.name)) continue
      const info = await stat(absolute)
      const rel = this.relative(absolute)
      files.push({
        path: rel, name: entry.name,
        directory: dirname(rel) === '.' ? '' : dirname(rel),
        modifiedAt: info.mtimeMs, size: info.size
      })
    }
    return files.sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * List reference material under the Source dirs recursively (Task 21, PRD S30). Unlike listFiles,
   * this is NOT markdown-only — sources include PDFs and images — so it reads each dir directly under
   * the Workspace boundary + symlink guard (`absolute`), applying the same dot/state-dir ignore rules
   * and classifying each file by extension. A missing dir yields nothing. Folio-manifest `source`
   * dirs extend SOURCE_DIRS in Task 24 (the named seam).
   */
  async listSources(): Promise<SourceFile[]> {
    const sources: SourceFile[] = []
    for (const dir of SOURCE_DIRS) {
      let base: string
      try {
        base = this.absolute(dir) // boundary + symlink-escape guard; throws if research/ escapes the root
      } catch {
        continue
      }
      if (existsSync(base)) sources.push(...await this.#walkSources(base))
    }
    return sources.sort((a, b) => a.path.localeCompare(b.path))
  }

  async #walkSources(base: string): Promise<SourceFile[]> {
    const entries = await readdir(base, { withFileTypes: true })
    const files: SourceFile[] = []
    for (const entry of entries) {
      const absolute = join(base, entry.name)
      if (entry.isDirectory()) {
        if (this.isVisiblePath(`${this.relative(absolute)}/file.md`)) files.push(...await this.#walkSources(absolute))
        continue
      }
      if (!entry.isFile() || entry.name.startsWith('.')) continue
      const info = await stat(absolute)
      files.push({ name: entry.name, path: this.relative(absolute), kind: sourceKind(entry.name), size: info.size })
    }
    return files
  }

  async readFile(path: string): Promise<FileReadResult> {
    const absolute = this.absolute(path)
    const content = await readFile(absolute, 'utf8')
    const info = await stat(absolute)
    const rel = this.relative(absolute)
    return {
      file: { path: rel, name: basename(absolute), directory: dirname(rel) === '.' ? '' : dirname(rel), modifiedAt: info.mtimeMs, size: info.size },
      content
    }
  }

  /** Atomic document write: stage to a sibling temp file, then rename over the target. A plain
   *  writeFile truncates BEFORE it writes, so an app quit (or kill) racing a save could leave the
   *  document 0 bytes on disk — which is exactly how walk-sample.md was wiped on 2026-07-11. Rename
   *  is atomic on one filesystem: the file is always either the old text or the new, never empty. */
  async #writeAtomic(absolute: string, content: string | Uint8Array, beforeCommit?: () => void): Promise<void> {
    const tmp = `${absolute}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, content, typeof content === 'string' ? 'utf8' : undefined)
    if (beforeCommit) {
      // One tick from here to the rename: the check, then the commit syscall, nothing awaited in between.
      try { beforeCommit() } catch (refusal) {
        try { unlinkSync(tmp) } catch { /* a stray temp file is not a changed document */ }
        throw refusal
      }
      this.recordOwnWrite(this.relative(absolute))
      renameSync(tmp, absolute)
      return
    }
    this.recordOwnWrite(this.relative(absolute))
    await rename(tmp, absolute)
  }

  async saveImage(bytes: Uint8Array, ext: string): Promise<{ path: string }> {
    const path = pastedImagePath(ext, new Date(), (candidate) => existsSync(this.absolute(candidate)))
    const absolute = this.absolute(path)
    await mkdir(dirname(absolute), { recursive: true })
    await this.#writeAtomic(absolute, bytes)
    return { path: this.relative(absolute) }
  }

  async saveNamedImage(bytes: Uint8Array, name: string): Promise<{ path: string }> {
    const cleaned = basename(name).replace(/[/\\]/g, '-') || 'image.png'
    const ext = extname(cleaned)
    const base = ext ? cleaned.slice(0, -ext.length) : cleaned
    let candidate = `assets/${cleaned}`
    let counter = 2
    while (existsSync(this.absolute(candidate))) candidate = `assets/${base}-${counter++}${ext}`
    const absolute = this.absolute(candidate)
    await mkdir(dirname(absolute), { recursive: true })
    await this.#writeAtomic(absolute, bytes)
    return { path: this.relative(absolute) }
  }

  async saveFile(path: string, content: string, options: SaveFileOptions = {}): Promise<FileReadResult> {
    const absolute = this.absolute(path)
    if (!options.allowExplicitEmpty && content.trim() === '' && existsSync(absolute)) {
      const previous = await readFile(absolute, 'utf8')
      if (previous.trim() !== '') {
        const rescueDirectory = '.writeflex/rescue'
        const rescueAbsolute = this.absolute(rescueDirectory)
        await mkdir(rescueAbsolute, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const pathName = this.relative(absolute).replace(/[^a-zA-Z0-9._-]+/g, '--') || 'document'
        let stem = `${timestamp}--${pathName}`
        let suffix = 2
        while (
          existsSync(join(rescueAbsolute, `${stem}--previous.md`)) ||
          existsSync(join(rescueAbsolute, `${stem}--rejected.md`))
        ) {
          stem = `${timestamp}--${pathName}-${suffix++}`
        }
        const previousRescuePath = `${rescueDirectory}/${stem}--previous.md`
        const rejectedRescuePath = `${rescueDirectory}/${stem}--rejected.md`
        await this.#writeAtomic(this.absolute(previousRescuePath), previous)
        await this.#writeAtomic(this.absolute(rejectedRescuePath), content)
        throw new EmptyWriteRefusal(
          this.relative(absolute),
          rescueDirectory,
          previousRescuePath,
          rejectedRescuePath,
        )
      }
    }
    await this.#writeAtomic(absolute, content, options.beforeCommit)
    // From here the file holds `content`. A failure below is a failed read, not a failed save.
    try {
      return await this.readFile(path)
    } catch (error) {
      throw new SavedButNotReadBack(this.relative(absolute), (error as NodeJS.ErrnoException | null)?.code ?? 'read failed')
    }
  }

  /**
   * saveFile for a caller that wants the WRITE and does not use the file read back: every guard is saveFile's, and
   * a save that committed but could not be read back is a save. Use this wherever a failure is answered with a
   * rollback or with "nothing was written", so that a committed write is never mistaken for a failed one.
   */
  async saveFileWithoutReadBack(path: string, content: string, options: SaveFileOptions = {}): Promise<void> {
    try {
      await this.saveFile(path, content, options)
    } catch (error) {
      if (!(error instanceof SavedButNotReadBack)) throw error
    }
  }

  /** The editor's save (file:save). The editor holds LF text, so this decides against the file's current
   *  bytes: the same document (line endings and BOM aside) writes nothing and returns the file as it is;
   *  an edit keeps the file's dominant line ending and its BOM (bug 01; ADR-0039, the file is never
   *  rewritten). Every other guard is saveFile's. */
  async saveEditorText(path: string, text: string, options: SaveFileOptions = {}): Promise<FileReadResult> {
    const absolute = this.absolute(path)
    const disk = existsSync(absolute) ? await readFile(absolute, 'utf8') : null
    const next = textForSave(text, disk)
    if (disk !== null && next === disk) return this.readFile(path)
    return this.saveFile(path, next, options)
  }

  async createFile(path: string, content: string): Promise<FileReadResult> {
    const absolute = this.absolute(normaliseMarkdownPath(path))
    if (existsSync(absolute)) throw new Error(`File already exists: ${this.relative(absolute)}`)
    await mkdir(dirname(absolute), { recursive: true })
    await this.#writeAtomic(absolute, content)
    return this.readFile(this.relative(absolute))
  }

  /** Duplicate a file beside itself (ADR-0017): “name (copy).md”, auto-suffixing -2, -3… — a clone
   *  never clobbers and never refuses, unlike rename which must land exactly where pointed. */
  async duplicateFile(path: string): Promise<FileReadResult> {
    const absolute = this.absolute(path)
    const name = basename(absolute)
    const extMatch = name.match(MARKDOWN_EXTENSION)
    const ext = extMatch ? extMatch[0] : ''
    const base = ext ? name.slice(0, -ext.length) : name
    let candidate = `${base} (copy)${ext}`
    let counter = 2
    while (existsSync(join(dirname(absolute), candidate))) candidate = `${base} (copy)-${counter++}${ext}`
    // Re-validate the DESTINATION through absolute() too — containment + symlink-escape guard on the
    // exact path being written, not just the source (Codex second-look finding #3).
    const target = this.absolute(this.relative(join(dirname(absolute), candidate)))
    await this.#writeAtomic(target, await readFile(absolute, 'utf8'))
    return this.readFile(this.relative(target))
  }

  /** Create a folder (idempotent — an existing folder is a success, matching TalkWeaver). */
  async createFolder(path: string): Promise<{ path: string }> {
    const cleaned = path.split('/').map(sanitiseFileName).filter(Boolean).join('/')
    if (!cleaned) throw new Error('Folder name cannot be empty.')
    const absolute = this.absolute(cleaned)
    this.recordOwnWrite(this.relative(absolute))
    await mkdir(absolute, { recursive: true })
    return { path: this.relative(absolute) }
  }

  /** Rename a folder in place. Refuses collisions — same policy as file rename. */
  async renameFolder(path: string, newName: string): Promise<{ path: string }> {
    const absolute = this.absolute(path)
    if (!(await stat(absolute)).isDirectory()) throw new Error(`Not a folder: ${path}`)
    const cleaned = sanitiseFileName(newName)
    if (!cleaned) throw new Error('Folder name cannot be empty.')
    // Destination re-validated through absolute() — same guard as the source (Codex finding #4).
    const target = this.absolute(this.relative(join(dirname(absolute), cleaned)))
    if (target !== absolute && existsSync(target)) throw new Error(`A folder named “${cleaned}” already exists here.`)
    this.recordOwnWrite(this.relative(absolute))
    this.recordOwnWrite(this.relative(target))
    await rename(absolute, target)
    return { path: this.relative(target) }
  }

  /** Absolute destination a rename would write to (bare names stay in the source file's folder). */
  renameTarget(path: string, newPath: string): string {
    const absolute = this.absolute(path)
    const normalised = normaliseMarkdownPath(newPath)
    return normalised.includes('/')
      ? this.absolute(normalised)
      : this.absolute(join(this.relative(dirname(absolute)) || '.', normalised))
  }

  async renameFile(path: string, newPath: string): Promise<FileReadResult> {
    const absolute = this.absolute(path)
    const target = this.renameTarget(path, newPath)
    if (!existsSync(absolute)) throw new Error(`File not found: ${this.relative(absolute)}`)
    if (existsSync(target)) {
      const [sourceInfo, targetInfo, sourceCanonical, targetCanonical] = await Promise.all([
        stat(absolute), stat(target), realpath(absolute), realpath(target),
      ])
      const sameCanonicalPath = sourceCanonical === targetCanonical &&
        this.relative(absolute).toLocaleLowerCase() === this.relative(target).toLocaleLowerCase()
      const sameFile = sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino && sameCanonicalPath
      if (!sameFile) throw new Error(`File already exists: ${this.relative(target)}`)
      if (absolute === target) return this.readFile(path)
      const extension = extname(absolute) || '.md'
      const stem = absolute.slice(0, absolute.length - extension.length)
      const intermediate = `${stem}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.rename-tmp${extension}`
      this.recordOwnWrite(this.relative(absolute))
      this.recordOwnWrite(this.relative(target))
      await rename(absolute, intermediate)
      try {
        await rename(intermediate, target)
      } catch (error) {
        await rename(intermediate, absolute)
        throw error
      }
      return this.readFile(this.relative(target))
    }
    await mkdir(dirname(target), { recursive: true })
    this.recordOwnWrite(this.relative(absolute))
    this.recordOwnWrite(this.relative(target))
    await rename(absolute, target)
    return this.readFile(this.relative(target))
  }

  /**
   * Progress of every checklist note (docs/design/2026-09-27-checkbox-lists, frame 8), for the Files
   * tree and Quick Open; a file that is not a checklist note is absent. It reads through the search
   * content cache over the same in-scope listing `search` uses, so the two share one read of each
   * file between changes: after either has run, the other touches the disk only for changed files.
   */
  async checklistProgress(): Promise<ChecklistProgress[]> {
    const files = (await this.listFiles()).filter((candidate) => isPathInSearchScope(candidate.path))
    await this.searchIndex.refresh(files)
    const progress: ChecklistProgress[] = []
    for (const file of files) {
      const tasks = this.searchIndex.tasks(file.path)
      if (tasks?.isChecklistNote) progress.push({ path: file.path, done: tasks.done, total: tasks.open + tasks.done })
    }
    return progress
  }

  /**
   * Workspace-wide search with query syntax (PRD S20, search-query.ts). Plain words match on the
   * piece — every word somewhere in the file — and each matching file yields ONE result at its best
   * line, ranked by comparePieces and capped at `maxResults`; `total` counts them all. A `tag:` term
   * filters files by frontmatter; a query with no positive term (tag-only, or tag plus `-not`) lands
   * on the file's frontmatter tag line. Content comes from the search index: every in-scope file is
   * read from disk at most once per search, and only when it changed since the last one.
   * With a `scope` (a focused folder) the result also carries `scope`: the in-folder and everywhere
   * piece counts from the same pass; `matches`/`total` follow `scope.results` (the folder by default).
   */
  async search(query: string, opts?: { maxResults?: number; scope?: SearchScope }): Promise<SearchResult> {
    const matcher = parseQuery(query)
    const scopeFolder = opts?.scope ? opts.scope.folder.replace(/^\/+|\/+$/g, '') : null
    const scopeResults = opts?.scope?.results === 'everywhere' ? 'everywhere' : 'folder'
    const counts = (inFolder: number, everywhere: number): SearchScopeCounts | undefined =>
      scopeFolder === null ? undefined : { folder: scopeFolder, results: scopeResults, inFolder, everywhere }
    if (!matcher.usesLines && !matcher.usesTags) {
      const scope = counts(0, 0)
      return scope ? { matches: [], total: 0, scope } : { matches: [], total: 0 }
    }
    const max = opts?.maxResults ?? SEARCH_RESULT_CAP
    const files = (await this.listFiles()).filter((candidate) => isPathInSearchScope(candidate.path))
    // Freshness comes from the listing's own stat; only changed or new files touch the disk.
    await this.searchIndex.refresh(files)
    const found: Array<{ path: string; lines: string[]; piece: PieceHit | null; key: RankKey }> = []
    for (const file of files) {
      const entry = this.searchIndex.get(file.path)
      if (!entry) continue
      if (matcher.usesTags && !matcher.matchTags(entry.tags)) continue
      const lines = entry.content.split('\n')
      const piece = matcher.usesLines ? matcher.matchPiece(lines) : null
      if (matcher.usesLines && !piece) continue
      const nameMatch = matcher.hasTerms && matcher.matchName(file.name, this.searchIndex.title(file.path) ?? '')
      found.push({
        path: file.path,
        lines,
        piece,
        key: { nameMatch, distinct: piece?.distinct ?? 0, hits: piece?.hits ?? 0, modifiedAt: file.modifiedAt },
      })
    }
    // Array.prototype.sort is stable, so full ties keep the listing order.
    found.sort((a, b) => comparePieces(a.key, b.key))
    // One pass serves both counts: the scope only chooses which side the listed matches come from.
    const inFolder = scopeFolder === null ? found : found.filter((entry) => isPathInFolder(entry.path, scopeFolder))
    const shown = scopeFolder !== null && scopeResults === 'folder' ? inFolder : found
    const matches = shown.slice(0, max).map(({ path, lines, piece }): SearchMatch => {
      if (!piece || !matcher.hasTerms) {
        const tagHit = locateTagHit(lines, matcher.tagTerms)
        const marks = tagHit.length > 0 ? [{ column: tagHit.column, length: tagHit.length }] : []
        return { path, ...tagHit, marks, snippet: snippetOf(lines[tagHit.line - 1] ?? '', marks) }
      }
      const i = piece.index
      return {
        path,
        line: i + 1,
        column: piece.hit.column,
        length: piece.hit.length,
        preview: lines[i].slice(0, 200),
        marks: piece.marks.map((mark) => ({ ...mark })),
        context: lineContext(lines, i),
        snippet: snippetOf(lines[i], piece.marks),
      }
    })
    const total = shown.length
    const scope = counts(inFolder.length, found.length)
    return {
      matches,
      total,
      ...(matcher.note ? { note: matcher.note } : {}),
      ...(scope ? { scope } : {}),
    }
  }
}
