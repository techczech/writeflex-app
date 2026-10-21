import { AsyncLocalStorage } from 'node:async_hooks'
import { join, relative, resolve, sep, dirname, basename, extname, isAbsolute, posix } from 'node:path'
import { lstat, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { constants as fsConstants, copyFileSync, existsSync, linkSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync } from 'node:fs'
import { parseFrontmatter } from './frontmatter'
import { OwnWriteTracker } from './workspace-watcher'
import { SearchIndex, SEARCH_INDEX_READ_CONCURRENCY } from './search-index'
import { comparePieces, parseQuery, pieceTitle, snippetOf, type LineHit, type PieceHit, type RankKey, type Snippet } from './search-query'
import { isPathInSearchScope } from '../shared/search-scope'
import { textForSave } from '../shared/line-endings'
import { basisAllows, isSaveBasis, type SaveBasis } from '../shared/save-basis'
import { classifyDocumentPath, isListedPath, type PathKind, type PathVerdict } from './document-path'
import { assertCollectionWritable } from './collection-write-gate'
import { DocumentReadRefused, asFileSystemError, readDocumentBytesGuarded, readDocumentFile } from './guarded-document-read'
import { GuardedMoveRefused, moveDocumentGuarded } from './guarded-document-move'
import { recordMainProcessDiagnostic } from './shutdown'
import { GuardedWriteRefused, carryLeftover, documentSaveSeams, writeDocumentGuarded, type CommitTarget, type FolderIdentity } from './guarded-document-write'
import { CollectionWriteTurn } from './collection-write-turn'

export { WritesPausedError } from './collection-write-gate'

export type MarkdownFile = { path: string; name: string; directory: string; modifiedAt: number; size: number }
export type FileReadResult = { file: MarkdownFile; content: string }
/** An editor save's answer: the file read back after the write (`content`), and the text the save put
 *  there, or found already there when it wrote nothing (`written`). The two differ only when another
 *  program wrote the file between the commit and the readback: then `written` is what the buffer is
 *  based on and `content` is an outside change (review round 1, Sol M1 / Muse M1). */
export type EditorSaveResult = FileReadResult & { written: string; seq?: number }
/** The receipt of one write call (document-owner plan, parcel 1): the text that call put on disk and its
 *  place in the workspace's order of writes. A handler that writes an open document returns the receipt
 *  of its own call, never one looked up afterwards. */
export type WriteReceipt = { written: string; seq: number }
/** A saveFile's answer: the file read back, and the receipt of this call's write. */
export type SavedFileResult = FileReadResult & WriteReceipt

/** The receipts of the writes made inside one call (its async context: `withWriteReceipts`). A write made
 *  by another call, however close in time, is in another context and is never among them. */
const writeReceiptScope = new AsyncLocalStorage<Array<{ path: string } & WriteReceipt>>()
/** A write refused inside one call because the file no longer held the text it was derived from
 *  (ChangedSinceRead): the path and what was on disk then (null: no file). */
export type ChangedSinceReadRefusal = { path: string; diskText: string | null }
/** The refusals made inside one call (its async context: `withWriteReceipts`), beside its receipts, so the
 *  caller learns of a refusal by its type whatever the verb that met it said (final review round 2, finding 2). */
const refusalScope = new AsyncLocalStorage<ChangedSinceReadRefusal[]>()
/** One write a multi-file operation made (R7): the file's text just before it, read in the tick of the
 *  commit (null: no file), and the text it left (null: it removed the file). A rollback puts `before`
 *  back only while the file still holds `after` (operation-rollback.ts). */
export type OperationWrite = { path: string; before: string | null; after: string | null; /** Not text, or its earlier text could not be read: never put back. */ unknown?: true }
/** The writes made inside one operation (its async context: `recordingOperationWrites`). */
const operationWriteScope = new AsyncLocalStorage<OperationWrite[]>()
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
   * nothing after the commit is undone. A `documentOnly` save tells it the real folder the file takes its name in
   * (`target`); any other save tells it nothing.
   */
  beforeCommit?: (target?: CommitTarget) => void
  /** Main-process only: create the file, never replace one (link(2) of the staged file; EEXIST → NameTaken). */
  exclusive?: boolean
  /** Refuse (`NotADocumentPathError`) unless `classifyPath` calls the path a `document`, and write by
   *  the guarded write (guarded-document-write.ts): staged beside the file through a handle that
   *  follows no link and whose real location is checked, then renamed; a document that is itself a
   *  link is refused. For a write whose path came from a stored record (an accepted Change) or from
   *  an agent capability, rather than from the writer's own open document. */
  documentOnly?: boolean
  /** The fingerprint (guarded-document-read.ts `fingerprintOf`, `fingerprintOfRead`) of the document's
   *  bytes that `content` was worked out from. The save reads the file through one no-follow handle
   *  immediately before it replaces it and throws `DocumentChangedError`, writing nothing, when the
   *  bytes are not those. A save that expects is always a `documentOnly` save, said or not. */
  expect?: { fingerprint: string }
  /** Main-process only, with `documentOnly`: the folder the file must land in, pinned when the caller authorised
   *  it (guarded-document-write.ts `FolderIdentity`). Checked when the write resolves the folder and again in the
   *  tick of the rename; a different folder there (a link swapped in meanwhile) is `NotADocumentPathError`. */
  inFolder?: FolderIdentity
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

/** What the writer is told when a change could not be applied because the document changed under it. */
export const documentChangedMessage = (path: string): string =>
  `${path} changed while the change was being applied. Nothing was written. You can accept the change again.`

/** Thrown by a save with `expect` whose document no longer holds the expected bytes; nothing was written. */
export class DocumentChangedError extends Error {
  override readonly name = 'DocumentChangedError'

  constructor(readonly path: string) {
    super(documentChangedMessage(path))
  }
}

/** Thrown by a `documentOnly` save whose path is hidden or outside the Collection; nothing was written. */
export class NotADocumentPathError extends Error {
  override readonly name = 'NotADocumentPathError'

  constructor(readonly path: string, readonly verdict: Exclude<PathVerdict, 'document'>) {
    super(verdict === 'hidden'
      ? `${path} is in a folder WriteFlex keeps for itself or hides from the sidebar.`
      : `${path} is outside this Collection.`)
  }
}

export class EmptyWriteRefusal extends Error {
  override readonly name = 'EmptyWriteRefusal'

  constructor(
    readonly path: string,
    readonly rescueDirectory: string,
    readonly previousRescuePath: string,
    readonly rejectedRescuePath: string,
    /** The text that was on disk and was rescued (previousRescuePath): the version a Clear confirms. */
    readonly previousText = '',
  ) {
    super(
      `WriteFlex prevented an empty save over ${path}. The previous content is intact. ` +
      `Rescue copies are in ${rescueDirectory}. Choose “Clear document…” from the Command Palette ` +
      'if you meant to remove everything.',
    )
  }
}

/**
 * An editor save refused because the file on disk is not the version the buffer was based on (its
 * SaveBasis). Nothing was written and no temp file is left. `diskText` is what was on disk when the
 * refusal was made (null: no file there), so the renderer can raise its banner for exactly that version.
 */
export class DiskChangedUnderBuffer extends Error {
  override readonly name = 'DiskChangedUnderBuffer'

  constructor(readonly path: string, readonly diskText: string | null) {
    super(diskText === null
      ? `${path} is no longer on disk, so the editor's text was not written over it.`
      : `${path} changed on disk, so the editor's text was not written over it.`)
  }
}

/**
 * An accept (or another write of text derived from a read) refused because the file no longer holds the
 * text it read (final review round 1, finding 1): `saveFileOverRead`. Nothing was written. Made through
 * `Workspace.changedSinceRead`, it is recorded for the call (`withWriteReceipts`'s `refusals`): an accept's
 * answer carries it, and the renderer raises its notice from that, not from the watcher (final review round
 * 2, finding 2). Its sentence is about a change, not an editor buffer.
 */
export class ChangedSinceRead extends DiskChangedUnderBuffer {
  /** `message`: the sentence of the check that refused, when it was the guarded write's content check
   *  (`documentChangedMessage`), so a refusal reads the same whichever of the two checks made it first. */
  constructor(path: string, diskText: string | null, message?: string) {
    super(path, diskText)
    this.message = message ?? (diskText === null
      ? `${path} is no longer on disk, so the change was not applied; nothing was written.`
      : `${path} changed on disk while the change was being applied, so nothing was written.`)
  }
}

/** An exclusive create (SaveBasis `create`) found the name taken, by a file or a folder. Nothing written. */
export class NameTaken extends Error {
  override readonly name = 'NameTaken'

  constructor(readonly path: string) {
    super(`${path} already exists, so nothing was written there.`)
  }
}

/** A `file:save` that did not say which version of the file it was based on: a programming error. */
export class SaveWithoutBasis extends Error {
  override readonly name = 'SaveWithoutBasis'

  constructor(readonly path: string) {
    super(`A save of ${path} did not say which version of the file it was based on, so nothing was written.`)
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
/** Directories whose contents surface in the Sources pane (Task 21). `research/` is the built-in
 *  convention; Folio-manifest-declared `source` dirs join this list in Task 24 (the named seam). */
const SOURCE_DIRS = ['research']

/** Codes link(2) gives where the filesystem cannot make hard links (as against a taken name). */
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

/** Whether anything is at `absolute` (a file, a folder, a link, even a dangling one), without reading it. */
function nameIsTaken(absolute: string): boolean {
  try {
    lstatSync(absolute)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** The file's text at this instant, read synchronously, for a check made in the tick of a rename. Null
 *  only when no file is there (ENOENT). A file that is there and cannot be read stops the write. */
function textAtThisInstant(absolute: string, rel: string): string | null {
  try {
    return readFileSync(absolute, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`${rel} could not be read, so nothing was written over it.`)
  }
}

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
  /** One writer at a time in this Collection, for every writer in this process (collection-write-turn.ts). */
  readonly #turn = new CollectionWriteTurn()
  /** Told a non-fatal notice about a write that succeeded: a guarded create whose temporary file could not be
   *  removed (`GuardedWriteResult.leftover`). The app sets it to its window's status line (ipc.ts). */
  onWriteNotice: ((message: string) => void) | undefined
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

  /** A monotonic count of this workspace's committed writes: each write's `seq`. */
  #writeSeq = 0
  #committed(absolute: string, content: string | Uint8Array): { seq: number } {
    this.#writeSeq += 1
    const seq = this.#writeSeq
    if (typeof content === 'string') writeReceiptScope.getStore()?.push({ path: this.relative(absolute), written: content, seq })
    return { seq }
  }
  /** For a subclass that commits a write by its own route (the command line's write session): this write's
   *  receipt, recorded for the call as the Workspace's own writes are. */
  protected receiptForOwnRoute(path: string, content: string): { seq: number } {
    return this.#committed(this.absolute(path), content)
  }
  /**
   * Run `call` and collect the receipts of the writes it made, by path: those made in its own async
   * context (a verb run through Bridle included), never another call's (Sol r3 M1, Muse r3 S1).
   */
  async withWriteReceipts<T>(call: () => Promise<T>): Promise<{ value: T; receipts: Array<{ path: string } & WriteReceipt>; refusals: ChangedSinceReadRefusal[] }> {
    const receipts: Array<{ path: string } & WriteReceipt> = []
    const refusals: ChangedSinceReadRefusal[] = []
    const value = await writeReceiptScope.run(receipts, () => refusalScope.run(refusals, call))
    return { value, receipts, refusals }
  }
  /**
   * Run `call` and record, into `log`, every text write and removal it makes in its own async context
   * (R7): what the file held just before (read in the tick of the commit) and what the write left. `log`
   * is the caller's, so it holds the writes made before a throw. A write by another call is never in it.
   */
  recordingOperationWrites<T>(log: OperationWrite[], call: () => Promise<T>): Promise<T> {
    return operationWriteScope.run(log, call)
  }
  /** Run `call` outside every per-call record (receipts, refusals, operation writes): a rollback's own
   *  writes are not the operation's writes, nor receipts or refusals of the call that asked for it. */
  outsideCallRecords<T>(call: () => Promise<T>): Promise<T> {
    return writeReceiptScope.exit(() => refusalScope.exit(() => operationWriteScope.exit(call)))
  }
  /** The text at `absolute` now, for an operation-write record, when one is being kept (else undefined).
   *  Called in the tick of the commit; a file that cannot be read as text is recorded as unknown (the
   *  rollback then never touches it). */
  #textBeforeOperationWrite(absolute: string, exclusive: boolean): string | null | undefined {
    if (!operationWriteScope.getStore()) return undefined
    if (exclusive) return null
    try {
      return readFileSync(absolute, 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined
    }
  }
  #recordOperationWrite(absolute: string, before: string | null | undefined, after: string | Uint8Array | null): void {
    const log = operationWriteScope.getStore()
    if (!log) return
    // A binary write, or a file whose earlier text could not be read: recorded so a rollback names it and
    // leaves it as it is, never guessing what to put back.
    const path = this.relative(absolute)
    if (before === undefined || (after !== null && typeof after !== 'string')) log.push({ path, before: null, after: null, unknown: true })
    else log.push({ path, before, after: after as string | null })
  }
  /** The refusal of a write of text derived from a read, recorded for the call that asked for it
   *  (`withWriteReceipts`'s `refusals`). Throw what it returns. */
  changedSinceRead(path: string, diskText: string | null, message?: string): ChangedSinceRead {
    const refusal = new ChangedSinceRead(this.relative(this.absolute(path)), diskText, message)
    refusalScope.getStore()?.push({ path: refusal.path, diskText })
    return refusal
  }
  /** The last receipt among `receipts` for `path` (as given to the call), if that call wrote it. */
  receiptFor(receipts: ReadonlyArray<{ path: string } & WriteReceipt>, path: string): WriteReceipt | undefined {
    const rel = this.relative(this.absolute(path))
    const own = receipts.filter((receipt) => receipt.path === rel).at(-1)
    return own ? { written: own.written, seq: own.seq } : undefined
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

  /** Whether the Markdown walker can surface this path, judged as typed. File basenames remain
   *  eligible even when dot-prefixed; only containing directories are filtered. The walker never
   *  follows links, so the typed path is the real one there; a path that arrives from outside (the
   *  command line, a request file) must go through `classifyPath`, which also resolves links. */
  isVisiblePath(path: string): boolean {
    return isListedPath(path, 'file')
  }

  /**
   * Whether `path` is a document path the sidebar would show: `document`, or why not. Judges the path
   * as typed AND its real location on disk (document-path.ts), on top of `absolute`'s refusal of
   * anything that leaves the Collection. A `folder` is judged in every segment, a `file` in its
   * containing folders. Never throws.
   */
  classifyPath(path: string, kind: PathKind = 'file'): PathVerdict {
    try {
      this.absolute(path)
    } catch {
      return 'outside'
    }
    return classifyDocumentPath(this.root, (this.#realRoot ??= realpathSync(this.root)), path, kind)
  }

  /**
   * Throws `WritesPausedError` while this Collection may not be written (collection-write-gate.ts:
   * another owner holds its lock). Every write this Workspace makes asks first (documents, folders,
   * pasted images, renames), and so must any caller that changes the Collection by another route
   * (moving a file to the Trash). Reads are unaffected.
   */
  assertWritable(): void {
    assertCollectionWritable(this.root)
  }

  /**
   * Run `run` as one turn of this Collection's write turn (collection-write-turn.ts): the only
   * writer in this app while it runs. The entry point for a writer that reads a document, works out
   * new text and saves it, and must not have the document change under it in between (an accepted
   * Change). Every save of this Workspace asks for the turn too, so inside `run` a save does not wait.
   */
  // `paths` is accepted and ignored: there is one turn for the whole Collection, and the argument stays so callers that name their documents do not change.
  exclusive<T>(_paths: string | readonly string[], run: () => Promise<T>): Promise<T> {
    return this.#turn.run(run)
  }

  /** The same turn, for work that cannot name its documents beforehand (a request carried out for
   *  the command line, a folder rename, a snapshot restore). */
  exclusiveAll<T>(run: () => Promise<T>): Promise<T> {
    return this.#turn.run(run)
  }

  /** How many writers are waiting for the turn. @internal For tests: a handshake in place of a pause. */
  get writersWaiting(): number {
    return this.#turn.waiting
  }

  async listFiles(): Promise<MarkdownFile[]> {
    return this.#walk(this.root)
  }

  /**
   * `listFiles()` and `listFolders()` from ONE walk of the tree (the window's workspace view asks for
   * both on every refresh): the same entries in the same order, under the same hidden-folder rules.
   */
  async listFilesAndFolders(): Promise<{ files: MarkdownFile[]; folders: string[] }> {
    const folders: string[] = []
    const files = await this.#walk(this.root, true, folders)
    return { files, folders: folders.sort((a, b) => a.localeCompare(b)) }
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

  /** `folders`, when given, collects every visible directory the walk enters (what `listFolders` lists, unsorted). */
  async #walk(base: string, recursive = true, folders?: string[]): Promise<MarkdownFile[]> {
    const entries = await readdir(base, { withFileTypes: true })
    const files: MarkdownFile[] = []
    for (const entry of entries) {
      const absolute = join(base, entry.name)
      if (entry.isDirectory()) {
        if (recursive && this.isVisiblePath(`${this.relative(absolute)}/file.md`)) {
          folders?.push(this.relative(absolute))
          files.push(...await this.#walk(absolute, true, folders))
        }
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
  async #writeAtomic(absolute: string, content: string | Uint8Array, beforeCommit?: () => void, exclusive = false): Promise<{ seq: number }> {
    this.assertWritable()
    const tmp = `${absolute}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`
    await writeFile(tmp, content, typeof content === 'string' ? 'utf8' : undefined)
    if (exclusive) {
      // Create, never replace: link(2) fails with EEXIST when the name is taken by anything (a file, a
      // folder), and the new name appears with all of its content at once.
      let before: string | null | undefined
      try {
        beforeCommit?.()
        before = this.#textBeforeOperationWrite(absolute, true)
        this.recordOwnWrite(this.relative(absolute))
        try {
          linkSync(tmp, absolute)
        } catch (linkError) {
          // A filesystem without hard links (exFAT, some network shares): an exclusive copy instead
          // (O_EXCL; EEXIST when the name is taken). The copy's content may be seen while it is copied,
          // which is acceptable for a new file that nothing else knows of.
          if (!LINK_UNSUPPORTED.has((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError
          copyFileSync(tmp, absolute, fsConstants.COPYFILE_EXCL)
        }
      } catch (error) {
        try { unlinkSync(tmp) } catch { /* a stray temp file is not a changed document */ }
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new NameTaken(this.relative(absolute))
        throw error
      }
      const receipt = this.#committed(absolute, content)
      this.#recordOperationWrite(absolute, before, content)
      try { unlinkSync(tmp) } catch { /* the copy is made; a stray temp name is harmless */ }
      return receipt
    }
    if (beforeCommit) {
      // One tick from here to the rename: the check, then the commit syscall, nothing awaited in between.
      try { beforeCommit() } catch (refusal) {
        try { unlinkSync(tmp) } catch { /* a stray temp file is not a changed document */ }
        throw refusal
      }
      const before = this.#textBeforeOperationWrite(absolute, false)
      this.recordOwnWrite(this.relative(absolute))
      renameSync(tmp, absolute)
      this.#recordOperationWrite(absolute, before, content)
      return this.#committed(absolute, content)
    }
    const before = this.#textBeforeOperationWrite(absolute, false)
    this.recordOwnWrite(this.relative(absolute))
    await rename(tmp, absolute)
    this.#recordOperationWrite(absolute, before, content)
    return this.#committed(absolute, content)
  }

  /** With `documentOnly` the picture is written by the guarded write, as a new file that replaces nothing. */
  async saveImage(bytes: Uint8Array, ext: string, options: Pick<SaveFileOptions, 'documentOnly'> = {}): Promise<{ path: string }> {
    this.assertWritable()
    // The name is chosen and written in one turn, so two pastes at once never take one name.
    return this.exclusiveAll(async () => {
      this.assertWritable() // asked again inside the turn: it may have waited
      const path = pastedImagePath(ext, new Date(), (candidate) => existsSync(this.absolute(candidate)))
      const absolute = this.absolute(path)
      await mkdir(dirname(absolute), { recursive: true })
      if (options.documentOnly) await this.#writeDocument(this.relative(absolute), bytes, 'create')
      else await this.#writeAtomic(absolute, bytes)
      return { path: this.relative(absolute) }
    })
  }

  async saveNamedImage(bytes: Uint8Array, name: string, options: Pick<SaveFileOptions, 'documentOnly'> = {}): Promise<{ path: string }> {
    this.assertWritable()
    const cleaned = basename(name).replace(/[/\\]/g, '-') || 'image.png'
    const ext = extname(cleaned)
    const base = ext ? cleaned.slice(0, -ext.length) : cleaned
    return this.exclusiveAll(async () => {
      this.assertWritable() // asked again inside the turn: it may have waited
      let candidate = `assets/${cleaned}`
      let counter = 2
      while (existsSync(this.absolute(candidate))) candidate = `assets/${base}-${counter++}${ext}`
      const absolute = this.absolute(candidate)
      await mkdir(dirname(absolute), { recursive: true })
      if (options.documentOnly) await this.#writeDocument(this.relative(absolute), bytes, 'create')
      else await this.#writeAtomic(absolute, bytes)
      return { path: this.relative(absolute) }
    })
  }

  /** Throws `NotADocumentPathError` unless `path` is a document the sidebar would show. */
  assertDocumentPath(path: string): void {
    const verdict = this.classifyPath(path)
    if (verdict !== 'document') throw new NotADocumentPathError(path, verdict)
  }

  /**
   * A guarded read for a `documentOnly` step (guarded-document-read.ts): one no-follow handle, the
   * opened file judged, the bytes from that handle. A path that turns out not to be a document is
   * `NotADocumentPathError`; any other refusal is the error a read by name would have raised.
   */
  async #readDocument(path: string): Promise<FileReadResult> {
    try {
      return await readDocumentFile(this, path)
    } catch (error) {
      if (!(error instanceof DocumentReadRefused)) throw error
      if (error.code === 'not-a-document') {
        const verdict = this.classifyPath(path)
        throw new NotADocumentPathError(path, verdict === 'document' ? 'outside' : verdict)
      }
      throw asFileSystemError(error, path)
    }
  }

  /** The guarded write for a `documentOnly` save (guarded-document-write.ts), its refusals in this Workspace's own errors.
   *  Like `#writeAtomic` it returns this call's receipt and records the write for an operation's rollback
   *  (R7). `nameTaken`: a create over a taken name throws `NameTaken` (an exclusive save), not the create's sentence. */
  async #writeDocument(path: string, content: string | Uint8Array, mode: 'create' | 'replace', expect?: { fingerprint: string }, beforeCommit?: (target?: CommitTarget) => void, nameTaken = false, inFolder?: FolderIdentity): Promise<{ seq: number }> {
    const absolute = this.absolute(path)
    let before: string | null | undefined
    let leftover: string | undefined
    try {
      ;({ leftover } = await writeDocumentGuarded(this, path, content, mode, {
        seams: documentSaveSeams,
        ...(expect ? { expect } : {}),
        ...(inFolder ? { inFolder } : {}),
        // The caller's check first (it may refuse the commit), then the own-write record, then the rename.
        // The text there just before is read in the same tick, for an operation's rollback (R7).
        beforeCommit: (target) => {
          beforeCommit?.(target)
          before = this.#textBeforeOperationWrite(absolute, mode === 'create')
          this.recordOwnWrite(this.relative(absolute))
        },
      }))
    } catch (error) {
      // In this Workspace's words, still naming any temporary file the write could not remove.
      throw carryLeftover(this.#documentWriteError(error, path, absolute, mode, nameTaken), error)
    }
    this.#recordOperationWrite(absolute, before, content)
    const receipt = this.#committed(absolute, content)
    // Saved, but a second name for the document was left: said, never thrown (the write succeeded).
    if (leftover) this.announceWriteNotice(leftover)
    return receipt
  }

  /** Tell `onWriteNotice` about a write that succeeded. A notice that fails is recorded as a main-process
   *  diagnostic and never thrown: it cannot turn a committed write into a failure. */
  announceWriteNotice(message: string): void {
    try {
      this.onWriteNotice?.(message)
    } catch (error) {
      void recordMainProcessDiagnostic('workspace.write.notice-failed', { root: this.root, message, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A guarded write's failure `error` in this Workspace's own errors. */
  #documentWriteError(error: unknown, path: string, absolute: string, mode: 'create' | 'replace', nameTaken: boolean): unknown {
    if (!(error instanceof GuardedWriteRefused)) return error
    if (error.code === 'changed') return new DocumentChangedError(path)
    if (error.code === 'outside' || error.code === 'hidden' || error.code === 'swapped') {
      const verdict = error.code === 'swapped' ? this.classifyPath(path) : error.code
      return new NotADocumentPathError(path, verdict === 'document' ? 'outside' : verdict)
    }
    // A new file whose name was taken while it was being written: the words a create has always used.
    if (error.code === 'exists' && mode === 'create') return nameTaken ? new NameTaken(this.relative(absolute)) : new Error(`File already exists: ${path}`)
    return error
  }

  /** The guarded move for a `documentOnly` rename (guarded-document-move.ts), its refusals in this Workspace's own errors. */
  async #moveDocument(from: string, to: string, kind: PathKind): Promise<void> {
    try {
      await moveDocumentGuarded(this, from, to, kind, {
        seams: documentSaveSeams,
        beforeCommit: () => { this.recordOwnWrite(from); this.recordOwnWrite(to) },
      })
    } catch (error) {
      if (!(error instanceof GuardedMoveRefused)) throw error
      const { code, path } = error
      if (code === 'outside' || code === 'hidden' || code === 'swapped') {
        const verdict = code === 'swapped' ? this.classifyPath(path, kind) : code
        throw new NotADocumentPathError(path, verdict === 'document' ? 'outside' : verdict)
      }
      if (code === 'missing') throw new Error(kind === 'file' ? `File not found: ${path}` : `Not a folder: ${path}`)
      if (code === 'exists') throw new Error(kind === 'file' ? `File already exists: ${path}` : `A folder named “${basename(path)}” already exists here.`)
      throw error
    }
  }

  /**
   * Save a document whole. Every save is a turn of the Collection's write turn (`exclusive`), so two
   * writers in this app never write at once. With `documentOnly` the write is
   * the guarded one (staged beside the file through a no-follow handle whose real location is
   * checked, then renamed; a document that is itself a link is refused), and `expect` makes it a
   * content-checked write. The answer is the file read back and this call's own receipt: `written`
   * is `content` (what this call put there) and `seq` its place in the order of writes.
   */
  async saveFile(path: string, content: string, options: SaveFileOptions = {}): Promise<SavedFileResult> {
    this.assertWritable()
    const held = options.expect && !options.documentOnly ? { ...options, documentOnly: true } : options
    return this.exclusive(path, () => this.#saveFileHeld(path, content, held))
  }

  async #saveFileHeld(path: string, content: string, options: SaveFileOptions): Promise<SavedFileResult> {
    this.assertWritable()
    if (options.documentOnly) this.assertDocumentPath(path)
    const absolute = this.absolute(path)
    // An empty write the guard below lets through (no file, or a file with no text) commits only over what
    // it found; see `previous` below. No file: `new` (nothing there, or an empty file, at the rename).
    // (An exclusive create replaces nothing, so it needs no such check.)
    let emptyOnlyOver: (() => void) | undefined = !options.allowExplicitEmpty && !options.exclusive && content.trim() === ''
      ? this.commitOnlyOver(path, { kind: 'new' })
      : undefined
    if (!options.allowExplicitEmpty && content.trim() === '' && existsSync(absolute)) {
      const previous = options.documentOnly ? (await this.#readDocument(path)).content : await readFile(absolute, 'utf8')
      // Let through because the file held no text: it commits only over that same text (checked in the
      // rename tick), so text another program writes while the empty file is staged is never erased
      // unasked (final review round 1, finding 2). A refusal is DiskChangedUnderBuffer, nothing written.
      if (!options.exclusive) emptyOnlyOver = this.commitOnlyOver(path, { kind: 'disk', text: previous })
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
          previous,
        )
      }
    }
    const beforeCommit = emptyOnlyOver
      ? (target?: CommitTarget) => { options.beforeCommit?.(target); emptyOnlyOver() }
      : options.beforeCommit
    let seq: number
    if (options.documentOnly) {
      // Judged again inside the write, on the handle it stages through; a link swapped in while the
      // code above waited is refused there, and with `expect` so is a document that changed. An
      // exclusive save is a create whatever stands there (the guarded link refuses a taken name).
      const standing = options.exclusive ? null : await lstat(absolute).catch(() => null)
      ;({ seq } = await this.#writeDocument(path, content, standing ? 'replace' : 'create', options.expect, beforeCommit, options.exclusive === true, options.inFolder))
    } else {
      ;({ seq } = await this.#writeAtomic(absolute, content, beforeCommit, options.exclusive))
    }
    // From here the file holds `content`. A failure below is a failed read, not a failed save.
    try {
      return { ...(options.documentOnly ? await this.#readDocument(path) : await this.readFile(path)), written: content, seq }
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

  /**
   * The guard for a write that may only replace the version `basis` names (shared/save-basis.ts), as a
   * `beforeCommit`: it reads the file in the tick of the rename and throws DiskChangedUnderBuffer (or, for
   * `create`, NameTaken) when the disk holds anything else. Compared byte for byte.
   */
  commitOnlyOver(path: string, basis: SaveBasis): () => void {
    const absolute = this.absolute(path)
    const rel = this.relative(absolute)
    // `create` (Sol S2 / Muse S2, round 2): an occupied name is classified without reading what occupies
    // it (a folder cannot be read as text), and the exclusive link decides in the end.
    if (basis.kind === 'create') return () => { if (nameIsTaken(absolute)) throw new NameTaken(rel) }
    return () => {
      const now = textAtThisInstant(absolute, rel)
      if (basisAllows(basis, now)) return
      throw new DiskChangedUnderBuffer(rel, now)
    }
  }

  /** The same check, made now (before any work that should not be done over another version). */
  async assertOnDisk(path: string, basis: SaveBasis): Promise<void> {
    if (!isSaveBasis(basis)) throw new SaveWithoutBasis(path)
    this.commitOnlyOver(path, basis)()
  }

  /** saveFile that commits only over the version `basis` names (checked before and in the rename tick). */
  async saveFileOver(path: string, content: string, basis: SaveBasis, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
    if (!isSaveBasis(basis)) throw new SaveWithoutBasis(path)
    const guard = this.commitOnlyOver(path, basis)
    guard()
    // This call's own receipt, passed through: `written` is what it put on disk.
    return this.saveFile(path, content, {
      ...options,
      ...(basis.kind === 'create' ? { exclusive: true } : {}),
      beforeCommit: (target) => { options.beforeCommit?.(target); guard() },
    })
  }

  /** A write of text derived from `read` (an accept): saveFileOver with `read` as its `disk` basis, so it
   *  commits only while the file still holds exactly what was read, checked before and in the rename tick.
   *  Another version there throws ChangedSinceRead and nothing is written. */
  async saveFileOverRead(path: string, next: string, read: string, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
    try {
      return await this.saveFileOver(path, next, { kind: 'disk', text: read }, options)
    } catch (error) {
      if (error instanceof DiskChangedUnderBuffer) throw error instanceof ChangedSinceRead ? error : this.changedSinceRead(error.path, error.diskText)
      // The guarded write's own content check (`expect`) refused first: the same refusal, recorded for the
      // call (R6), with what is on disk now.
      if (error instanceof DocumentChangedError) {
        const absolute = this.absolute(path)
        throw this.changedSinceRead(path, textAtThisInstant(absolute, this.relative(absolute)), error.message)
      }
      throw error
    }
  }

  /** Remove a file only while it still holds `read` exactly, compared in the tick of the unlink (an accept
   *  that takes a file away: R5). Another version there throws ChangedSinceRead and nothing is removed; a
   *  file already gone is what was asked for. */
  removeFileOverRead(path: string, read: string): void {
    this.assertWritable()
    try {
      this.commitOnlyOver(path, { kind: 'disk', text: read })()
    } catch (error) {
      if (!(error instanceof DiskChangedUnderBuffer)) throw error
      if (error.diskText === null) return
      throw this.changedSinceRead(error.path, error.diskText)
    }
    unlinkSync(this.absolute(path))
    this.#recordOperationWrite(this.absolute(path), read, null)
  }

  /** The editor's save (file:save). The editor holds LF text, so this decides against the file's current
   *  bytes: the same document (line endings and BOM aside) writes nothing and returns the file as it is;
   *  an edit keeps the file's dominant line ending and its BOM (bug 01; ADR-0039, the file is never
   *  rewritten). Every other guard is saveFile's. The read it decides by and the write are one turn
   *  of the Collection's write turn.
   *
   *  `basis` says which version of the file the buffer was based on (shared/save-basis.ts). It is
   *  compared with the disk, byte for byte, before anything is written, and again in the tick of the
   *  rename that commits the write, with nothing awaited between that comparison and the rename. A
   *  mismatch throws DiskChangedUnderBuffer and writes nothing. A call without a well-formed basis is
   *  refused. `create` never reads or replaces anything: a taken name throws NameTaken.
   *
   *  `written` in the answer is what the buffer is based on from now: the bytes written, or the bytes
   *  found when nothing was written. A readback that differs from it is another program's write. */
  async saveEditorText(path: string, text: string, basis: SaveBasis, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
    // Checked before the unchanged-text shortcut: a paused save must never report "saved".
    this.assertWritable()
    if (!isSaveBasis(basis)) throw new SaveWithoutBasis(path)
    return this.exclusive(path, async () => {
      // Asked again inside the turn, before the unchanged-text shortcut too: the save may have waited.
      this.assertWritable()
      const absolute = this.absolute(path)
      const rel = this.relative(absolute)
      if (basis.kind === 'create') {
        if (nameIsTaken(absolute)) throw new NameTaken(rel)
        return this.saveFileOver(path, text, basis, options)
      }
      const read = (): Promise<FileReadResult> => (options.documentOnly ? this.#readDocument(path) : this.readFile(path))
      const disk = options.documentOnly
        ? (existsSync(absolute) ? (await this.#readDocument(path)).content : null)
        : textAtThisInstant(absolute, rel)
      const next = textForSave(text, disk)
      // The buffer is the document on disk: nothing is replaced, whatever it was based on. What was found
      // is what the buffer is based on now; the second read is compared with it by the renderer.
      if (disk !== null && next === disk) return { ...(await read()), written: disk }
      if (!basisAllows(basis, disk)) throw new DiskChangedUnderBuffer(rel, disk)
      return this.saveFileOver(path, next, basis, options)
    })
  }

  /**
   * Create a document; a name that is taken is refused. With `documentOnly` the file is written by
   * the guarded write, as `saveFile` does: staged beside its name through a no-follow handle whose
   * real location is checked, then given its name by a hard link, which cannot replace a file that
   * appeared there meanwhile. Without it the write is exclusive too (final review round 2, finding 1):
   * a file that appears after the check is never replaced; the create is refused with the same sentence.
   */
  async createFile(path: string, content: string, options: Pick<SaveFileOptions, 'documentOnly'> = {}): Promise<FileReadResult> {
    this.assertWritable()
    const normalised = normaliseMarkdownPath(path)
    return this.exclusive(normalised, async () => {
      this.assertWritable() // asked again inside the turn: it may have waited
      // Before the folder is made, so a refused create leaves no empty folder behind either.
      if (options.documentOnly) this.assertDocumentPath(normalised)
      const absolute = this.absolute(normalised)
      if (existsSync(absolute)) throw new Error(`File already exists: ${this.relative(absolute)}`)
      await mkdir(dirname(absolute), { recursive: true })
      if (options.documentOnly) {
        // Judged again inside the write, on the handle it stages through: making the folder waited.
        await this.#writeDocument(this.relative(absolute), content, 'create')
        return this.#readDocument(this.relative(absolute))
      }
      try {
        await this.#writeAtomic(absolute, content, undefined, true)
      } catch (error) {
        if (error instanceof NameTaken) throw new Error(`File already exists: ${this.relative(absolute)}`)
        throw error
      }
      return this.readFile(this.relative(absolute))
    })
  }

  /** Duplicate a file beside itself (ADR-0017): “name (copy).md”, auto-suffixing -2, -3… — a clone
   *  never clobbers and never refuses, unlike rename which must land exactly where pointed. */
  async duplicateFile(path: string, options: Pick<SaveFileOptions, 'documentOnly'> = {}): Promise<FileReadResult> {
    this.assertWritable()
    const absolute = this.absolute(path)
    const name = basename(absolute)
    const extMatch = name.match(MARKDOWN_EXTENSION)
    const ext = extMatch ? extMatch[0] : ''
    const base = ext ? name.slice(0, -ext.length) : name
    for (let counter = 1; ; counter += 1) {
      const candidate = counter === 1 ? `${base} (copy)${ext}` : `${base} (copy)-${counter}${ext}`
      if (existsSync(join(dirname(absolute), candidate))) continue
      // Re-validate the DESTINATION through absolute() too — containment + symlink-escape guard on the
      // exact path being written, not just the source (Codex second-look finding #3).
      const target = this.absolute(this.relative(join(dirname(absolute), candidate)))
      const copy = this.relative(target)
      // One turn: the source cannot be saved half-way through the copy, and two copies made at once
      // never take one name.
      const made = await this.exclusive([path, copy], async (): Promise<FileReadResult | null> => {
        this.assertWritable() // asked again inside the turn: it may have waited
        if (existsSync(target)) return null
        if (options.documentOnly) {
          // Copied from the bytes of ONE guarded read: a link put at the source is refused, never followed.
          let bytes: Buffer
          try {
            bytes = (await readDocumentBytesGuarded(this, path)).bytes
          } catch (error) {
            if (!(error instanceof DocumentReadRefused)) throw error
            if (error.code !== 'not-a-document') throw asFileSystemError(error, path)
            const verdict = this.classifyPath(path)
            throw new NotADocumentPathError(path, verdict === 'document' ? 'outside' : verdict)
          }
          await this.#writeDocument(copy, bytes, 'create')
          return this.#readDocument(copy)
        }
        // Exclusive: a file another program puts at the name meanwhile is never replaced; the next name is tried.
        try {
          await this.#writeAtomic(target, await readFile(absolute, 'utf8'), undefined, true)
        } catch (error) {
          if (error instanceof NameTaken) return null
          throw error
        }
        return this.readFile(copy)
      })
      if (made) return made
    }
  }

  /**
   * Move a document or a folder to the system Trash, through `trash` (Electron's `shell.trashItem`
   * in the app). One turn of the Collection's write turn, and the write gate is asked inside it,
   * immediately before the move: a Collection that stopped being this app's while the move waited
   * its turn is not touched.
   */
  async moveToTrash(path: string, trash: (absolute: string) => Promise<void>): Promise<{ path: string }> {
    this.assertWritable()
    return this.exclusiveAll(async () => {
      this.assertWritable()
      const absolute = this.absolute(path) // containment + symlink guard
      this.recordOwnWrite(path) // our own trash write must not echo back through the watcher
      await trash(absolute)
      return { path }
    })
  }

  /** Create a folder (idempotent — an existing folder is a success, matching TalkWeaver). */
  async createFolder(path: string): Promise<{ path: string }> {
    this.assertWritable()
    const cleaned = path.split('/').map(sanitiseFileName).filter(Boolean).join('/')
    if (!cleaned) throw new Error('Folder name cannot be empty.')
    const absolute = this.absolute(cleaned)
    this.recordOwnWrite(this.relative(absolute))
    await mkdir(absolute, { recursive: true })
    return { path: this.relative(absolute) }
  }

  /** Rename a folder in place. Refuses collisions — same policy as file rename. With `documentOnly`
   *  the rename is the guarded move (guarded-document-move.ts), which states the window that remains. */
  async renameFolder(path: string, newName: string, options: Pick<SaveFileOptions, 'documentOnly'> = {}): Promise<{ path: string }> {
    this.assertWritable()
    // Every document under the folder changes its path: nothing else in this app writes meanwhile.
    return this.exclusiveAll(async () => {
      this.assertWritable() // asked again inside the turn: it may have waited
      const absolute = this.absolute(path)
      if (!(await stat(absolute)).isDirectory()) throw new Error(`Not a folder: ${path}`)
      const cleaned = sanitiseFileName(newName)
      if (!cleaned) throw new Error('Folder name cannot be empty.')
      // Destination re-validated through absolute() — same guard as the source (Codex finding #4).
      const target = this.absolute(this.relative(join(dirname(absolute), cleaned)))
      if (target !== absolute && existsSync(target)) throw new Error(`A folder named “${cleaned}” already exists here.`)
      if (options.documentOnly) {
        if (target !== absolute) await this.#moveDocument(this.relative(absolute), this.relative(target), 'folder')
        return { path: this.relative(target) }
      }
      this.recordOwnWrite(this.relative(absolute))
      this.recordOwnWrite(this.relative(target))
      await rename(absolute, target)
      return { path: this.relative(target) }
    })
  }

  /** Absolute destination a rename would write to (bare names stay in the source file's folder). */
  renameTarget(path: string, newPath: string): string {
    const absolute = this.absolute(path)
    const normalised = normaliseMarkdownPath(newPath)
    return normalised.includes('/')
      ? this.absolute(normalised)
      : this.absolute(join(this.relative(dirname(absolute)) || '.', normalised))
  }

  /**
   * Rename or move a document. With `documentOnly` (a path an agent named) the move is the guarded
   * one (guarded-document-move.ts): a link is never moved, both folders are judged where they really
   * are, the file must still be the one judged, and it takes its new name by a hard link, so it can
   * never replace a file that appeared there meanwhile. `requireExistingDirectory` skips directory
   * creation for Collection bulk moves, including when a destination disappears after validation.
   */
  async renameFile(path: string, newPath: string, options: Pick<SaveFileOptions, 'documentOnly'> & { requireExistingDirectory?: boolean } = {}): Promise<FileReadResult> {
    this.assertWritable()
    // One turn: neither name is being saved while the file changes its name.
    return this.exclusive([path, this.relative(this.renameTarget(path, newPath))], () => this.#renameFileHeld(path, newPath, options.documentOnly === true, options.requireExistingDirectory === true))
  }

  async #renameFileHeld(path: string, newPath: string, documentOnly: boolean, requireExistingDirectory: boolean): Promise<FileReadResult> {
    this.assertWritable() // asked again inside the turn: it may have waited
    const absolute = this.absolute(path)
    const target = this.renameTarget(path, newPath)
    if (!existsSync(absolute)) throw new Error(`File not found: ${this.relative(absolute)}`)
    if (documentOnly) {
      if (absolute === target) return this.#readDocument(path)
      this.assertDocumentPath(this.relative(target))
      if (!requireExistingDirectory) await mkdir(dirname(target), { recursive: true })
      await this.#moveDocument(this.relative(absolute), this.relative(target), 'file')
      return this.#readDocument(this.relative(target))
    }
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
    if (!requireExistingDirectory) await mkdir(dirname(target), { recursive: true })
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
  async checklistProgress(paths?: readonly string[]): Promise<ChecklistProgress[]> {
    if (paths) return this.#checklistProgressOf(paths)
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
   * The same rows for the named files only — what the renderer asks after a save patched one entry of
   * its listing, so the chip follows the save without a walk of the whole tree. Each path is judged as
   * the listing would (a visible, in-scope Markdown file that is a regular file) and stat'ed; the
   * search content cache brings just those up to date (`ensure`, which forgets nothing else). A path
   * that would not be listed, or that has gone, yields no row.
   */
  async #checklistProgressOf(paths: readonly string[]): Promise<ChecklistProgress[]> {
    const files: Array<{ path: string; modifiedAt: number; size: number }> = []
    for (const path of new Set(paths)) {
      if (typeof path !== 'string' || !MARKDOWN_EXTENSION.test(path) || !isPathInSearchScope(path) || !this.isVisiblePath(path)) continue
      try {
        const absolute = this.absolute(path)
        const info = await lstat(absolute)
        if (info.isFile()) files.push({ path: this.relative(absolute), modifiedAt: info.mtimeMs, size: info.size })
      } catch {
        // Gone or refused: no row, as the listing would have none.
      }
    }
    await this.searchIndex.ensure(files)
    const progress: ChecklistProgress[] = []
    for (const file of files) {
      const tasks = this.searchIndex.current(file) ? this.searchIndex.tasks(file.path) : undefined
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
