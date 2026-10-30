/**
 * The Folio bin (ADR-0049, spec docs/design/2026-10-24-folio-workspace § 1 I-1/I-2/I-3, § 2): where a part's file goes
 * when the part is removed from the Folio. The app never deletes a part's file (I-1): the owner empties the bin
 * himself, in Finder (`binFolderToShow`: the room's "Show bin in Finder" opens the real, pinned bin folder).
 *
 * On disk: `<folio>/.folio-bin/` (a hidden folder, so no listing, export, share, word count, Not in the outline,
 * Collection list or agent read ever sees it: every one of them walks or judges the workspace by the one hidden-folder
 * rule) holding the binned files under their own names (a second file of one name gets ` (2)`), and
 * `.folio-bin/.bin-index.json` recording, for each, its Folio-relative path before removal, when it was removed, its
 * title and the SHA-256 of its bytes.
 *
 * The index is a file anyone can edit, so it authorises nothing. It is a display hint (the binder row's "was <path>"
 * and title) and nothing else: Restore never takes a destination, a running-order line or a position from it, and the
 * Undo of a change works from that change's record kept in main's memory (its token), never from the file.
 *
 * Every write is one transaction (`Steps`), under the Folio's plan lock and the Collection's write turn, after the
 * Collection write gate. The rules every step keeps (Sol r2 BLOCKER 1, MAJOR 3; r3 MAJOR 2):
 * - A step's take-back is registered as soon as its write succeeded, before the next step runs, and it holds the exact
 *   bytes (or the very file, or the very permissions) that write left.
 * - A take-back is compare-and-swap: a document is reverted, a file moved back or its permissions put back, only while
 *   it still holds exactly what this operation wrote. Otherwise it is left as it is and the refusal names it. A
 *   document this operation did not change (a manifest someone made meanwhile) is never touched.
 * - The documents (Index Note, manifest) are written first and the file moves come last, so a failure in the
 *   documents' phase (a checkpoint, a write) never leaves a file moved.
 *
 * - `removePartsToBin`: one read of the Plan (`removePlanPartsOnce`, whose hook only checks the files); the documents
 *   are committed; then, in one pinned block, the bin folder (when new), the bin's list, and the file moves. One Undo token.
 * - `undoBinChange`: the Undo of a removal or a Restore, exact or refused: checks first (the documents, the bin's list
 *   and every file, its bytes too, as the change left them), then the documents, then in one pinned block the list and
 *   the file moves. One Undo token is spent.
 * - `restoreFromBin`: the file goes to the Folio's top level (the folder its manifest takes parts from, `content_root`,
 *   else the Folio's folder) under its own name in the bin (`name 2.md` when that is taken), judged by the rule for a new part's name and the FolioWorkspace guard, and joins the end of the running
 *   order as an Add puts it. Order: in one pinned block, the file's execute and set-id bits go (through its handle) and
 *   it is given its name in the Folio beside its name in the bin (a hard link, never over anything: nothing has moved
 *   yet); then the documents; then in one pinned block the bin's list and, last, the bin's name goes, which completes
 *   the move. One Undo token.
 *
 * The pin rule (Sol r1 BLOCKER 1, r3 BLOCKER 1), by construction: a real path of the bin or of a Folio file exists only
 * inside `withPinned(fws, (at) => ...)`. Its callback is synchronous: it pins (`at.bin`, `at.binFile`, `at.folio`, each
 * through the FolioWorkspace guard, the bin checked to be the very folder sealed when the action began: same real path,
 * device and inode), uses the path in the same block with `*Sync` calls, and answers plain data. When it returns, `at`
 * is revoked (any later use throws), and an answer that is a promise, a function or a string holding the workspace's
 * real path is refused. What crosses an await is plain data: workspace-relative paths, bin names, a `BinSeal` (whose
 * path cannot be read, only compared), a file's device and inode. Every await in this module is `settle(...)`, which
 * refuses to run while a block is open. A take-back that touches a file opens its own block.
 *
 * A file is moved by a hard link at the new name (link(2) never replaces anything) after the source was opened without
 * following a link and fingerprinted, the new name is checked to be that very file, and only then the old name is
 * dropped; where links are not supported, an exclusive copy whose bytes are checked. Its bytes never change. The
 * placement answers the identity (device, inode) of what it made at the new name, the file itself for a link, the
 * copy's own for a copy, and every later check and take-back of the new name uses that, while the old name is judged
 * by the source's (Sol r4 MAJOR).
 *
 * Nothing here deletes data: the only `unlinkSync` calls are in `dropSecondName` (a name goes only while the same file,
 * or its exact bytes, lives on at another name) and `removeOwnBytes` (the bin's own list or temporary file, only while
 * it holds exactly the bytes this module wrote). A test scans for any other.
 *
 * What is not guaranteed: as for every guarded write in the app, another process acting between a synchronous check
 * and the system call that follows it is not claimed to be stopped. An edit another program makes to a document or a
 * file while an operation is under way (during an awaited history checkpoint) is preserved and reported, never
 * overwritten: the take-back that would have reverted it is refused and named, so the Folio may then be left part-way,
 * exactly as the refusal says.
 */
import { finishVersionMove, prepareVersionMove, relativeHistoryPath } from './version-moves'
import { closeSync, constants, copyFileSync, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, join, posix } from 'node:path'
import { assertCollectionWritable } from './collection-write-gate'
import { MANIFEST_NAME, indexNotePath, readManifest } from './folio'
import { folioKey } from './folio-dir'
import { authoriseFolioWrite, type FolioWorkspace } from './folio-workspace'
import { appendManifestEntries, indexNoteExists, readManifestOnly } from './folio-manifest-order'
import { adoptRestoredFile, removePlanPartsOnce, type PlanCommitReceipt, type PlanRemoval, type PlanWriteOptions, type RemovedPlanPart } from './plan'
import { withPlanLock } from './plan-lock'
import { fileIdentityOf } from './workspace-watcher'
import { isHiddenWorkspacePath } from './workspace'
import type { FolderIdentity } from './guarded-document-write'
import { STALE_UNDO_MESSAGE } from '../shared/folio-running-order'
import { isNotInOutlineName } from '../shared/folio-part-name'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import type { FolioBinItem } from '../shared/folio-bin'

export const FOLIO_BIN = '.folio-bin'
export const BIN_INDEX = '.bin-index.json'

/** One checked record of the bin index (a display hint only). `path` is relative to the Folio's folder, or null when it does not read as one. */
type StoredItem = { id: string; name: string; path: string | null; title: string; removedAt: string; record: unknown }
/** The index as read: `raw` its items exactly as in the file (written back as they are), `items` the ones that passed every check. */
type BinIndex = { raw: unknown[]; items: StoredItem[] }

/** A file moved by one bin change: `path` workspace-relative, `name` its name in the bin, `into` where it went, `sha256` its bytes there. */
type Move = { path: string; name: string; into: 'bin' | 'folio'; sha256: string }

/** The Folio's two documents at one instant, by path; null = no file. */
type Docs = { indexPath: string; manifestPath: string; index: string | null; manifest: string | null }

/** A file by its device and inode: plain data that names one file without a path. */
type FileSeal = { dev: number; ino: number }

const BIN_CHANGED = 'The Folio bin changed meanwhile.'
const BIN_UNREADABLE = 'The Folio bin’s list cannot be read. Check the .folio-bin folder in Finder.'
const NOT_IN_BIN = 'That file is no longer in the Folio bin.'
const NOT_A_FILE = (name: string): string => `“${name}” is no longer a file there.`
const FILE_CHANGED = (name: string): string => `“${name}” is not the file that was put in the Folio bin: its contents changed since.`
/** Why a take-back left a document or file as it is (its step's name comes before it). */
const CHANGED_MEANWHILE = 'it changed meanwhile, so it was left as it is'
/** A programming error: a pinned path outlived its synchronous block (module comment, the pin rule). */
const PIN_RULE = 'A pinned Folio path was used outside its synchronous block, so nothing more was done.'

const binOf = (dir: string): string => (dir === '' ? FOLIO_BIN : `${dir}/${FOLIO_BIN}`)
const withinFolio = (dir: string, path: string): string => (dir === '' ? path : path.slice(dir.length + 1))
const inFolio = (dir: string, path: string): string => (dir === '' ? path : `${dir}/${path}`)
const plain = (fws: FolioWorkspace, error: unknown): string => withoutAbsolutePaths(error instanceof Error ? error.message : String(error), fws.root)
const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code
const MARKDOWN = /\.(?:md|markdown)$/i

// ---- The file-system calls, and the awaits: each through one place --------------------------------------------------

/**
 * Every call here that opens, reads by name, writes, links, copies, renames, chmods, makes or removes goes through this
 * table: the seam a test uses to watch or fail each one (`setBinIoForTest`). The app never replaces it.
 */
const realIo = { openSync, readFileSync, writeFileSync, linkSync, copyFileSync, renameSync, unlinkSync, fchmodSync, mkdirSync, rmdirSync }
type BinIo = typeof realIo
let io: BinIo = realIo
/** Tests: watch or fail the bin's file-system calls (`null` puts the real ones back). */
export function setBinIoForTest(over: Partial<BinIo> | null): void { io = over ? { ...realIo, ...over } : realIo }

let awaitHook: ((label: string) => void | Promise<void>) | null = null
/** Tests: run `hook` at every await of this module, after the awaited work settled and before the code after it runs. */
export function setBinAwaitHookForTest(hook: ((label: string) => void | Promise<void>) | null): void { awaitHook = hook }

/** How many pinned blocks are open (0 or 1: a block is synchronous). */
let pinsOpen = 0

/** The one way this module awaits: never while a pinned block is open (the pin rule). */
async function settle<T>(label: string, work: Promise<T> | T): Promise<T> {
  if (pinsOpen !== 0) throw new Error(PIN_RULE)
  try {
    return await work
  } finally {
    if (awaitHook) await awaitHook(label)
  }
}

// ---- Pins: a real path lives only inside one synchronous block --------------------------------------------------------

/** The bin folder as pinned when an action began: compared, never read as a path. */
class BinSeal {
  readonly #real: string
  readonly #dev: number
  readonly #ino: number
  constructor(pin: FolderIdentity) { this.#real = pin.real; this.#dev = pin.dev; this.#ino = pin.ino }
  /** Whether `now` is this very folder: same real path, device and inode. */
  is(now: FolderIdentity): boolean { return now.real === this.#real && now.dev === this.#dev && now.ino === this.#ino }
}

/** The bin folder's pin now (the FolioWorkspace guard, nested Folios refused), or null when there is none. */
function binPinNow(root: string, dir: string): FolderIdentity | null {
  if (isAbsent(join(root, binOf(dir)))) return null
  return authoriseFolioWrite(root, dir, `${binOf(dir)}/${BIN_INDEX}`)
}

/** The real paths of one synchronous block (`withPinned`), each made again at the call. Revoked when the block ends. */
class Pinned {
  #live = true
  constructor(private readonly fws: FolioWorkspace) {}
  revoke(): void { this.#live = false }
  #now(): void { if (!this.#live) throw new Error(PIN_RULE) }

  /** The bin's seal now, or null when there is none. */
  binNow(): BinSeal | null {
    this.#now()
    const pin = binPinNow(this.fws.root, this.fws.folioDir)
    return pin && new BinSeal(pin)
  }

  /** The bin's seal, the folder made (one folder, in the pinned Folio folder) when there is none. */
  ensureBin(): { seal: BinSeal; created: boolean } {
    const existing = this.binNow()
    if (existing) return { seal: existing, created: false }
    const folio = authoriseFolioWrite(this.fws.root, this.fws.folioDir, inFolio(this.fws.folioDir, FOLIO_BIN))
    io.mkdirSync(join(folio.real, FOLIO_BIN))
    const made = this.binNow()
    if (!made) throw new Error(BIN_CHANGED)
    return { seal: made, created: true }
  }

  /** The bin's real path now: the very folder `seal` names, or BIN_CHANGED. */
  bin(seal: BinSeal): string {
    this.#now()
    let now: FolderIdentity | null
    try { now = binPinNow(this.fws.root, this.fws.folioDir) } catch { throw new Error(BIN_CHANGED) }
    if (!now || !seal.is(now)) throw new Error(BIN_CHANGED)
    return now.real
  }

  /** The real path of `name` directly in the bin `seal`, now. */
  binFile(seal: BinSeal, name: string): string {
    if (!isBinName(name)) throw new Error(NOT_IN_BIN)
    return join(this.bin(seal), name)
  }

  /** The real path of workspace-relative `path`, a file of the Folio outside its bin and any hidden folder, through the FolioWorkspace guard now. */
  folio(path: string): string {
    this.#now()
    const pin = authoriseFolioWrite(this.fws.root, this.fws.folioDir, path)
    const normal = posix.normalize(path)
    if (isHiddenWorkspacePath(withinFolio(this.fws.folioDir, normal))) throw new Error(`“${posix.basename(normal)}” is in a hidden folder of the Folio, so nothing is moved there.`)
    return join(pin.real, posix.basename(normal))
  }
}

/** The spellings of the workspace's root a real path starts with. */
function rootsOf(fws: FolioWorkspace): string[] {
  const roots = [fws.root]
  try { roots.push(realpathSync.native(fws.root)) } catch { /* the plain spelling only */ }
  return roots
}

/** Whether `value` holds something a pinned block must not answer: a promise, a function, or a string that is a real path of the workspace. */
function escapes(value: unknown, roots: readonly string[]): boolean {
  if (typeof value === 'function') return true
  if (typeof value === 'string') return roots.some((root) => value.startsWith(root))
  if (typeof value !== 'object' || value === null || value instanceof BinSeal) return false
  if (typeof (value as { then?: unknown }).then === 'function') return true
  if (Array.isArray(value)) return value.some((item) => escapes(item, roots))
  if (Object.prototype.toString.call(value) !== '[object Object]') return true
  return Object.values(value).some((item) => escapes(item, roots))
}

/**
 * Run `block` with the pins of this instant (the pin rule, module comment): synchronous, its `at` revoked when it
 * returns, and its answer plain data. Every file-system call on a bin file or a Folio file is made inside one.
 */
function withPinned<T>(fws: FolioWorkspace, block: (at: Pinned) => T): T {
  const at = new Pinned(fws)
  pinsOpen += 1
  let answer: T
  try {
    answer = block(at)
  } finally {
    at.revoke()
    pinsOpen -= 1
  }
  if (escapes(answer, rootsOf(fws))) throw new Error(PIN_RULE)
  return answer
}

// ---- Reading -------------------------------------------------------------------------------------------------------

/** A plain name for a file directly in the bin: no folder, no hidden name, no NUL. */
const isBinName = (name: unknown): name is string => (
  typeof name === 'string' && name !== '' && !name.includes('/') && !name.includes('\\') && !name.includes('\0') && !name.trim().startsWith('.')
)

/**
 * `path` (relative to the Folio folder) when it reads as a plain Markdown path of the Folio: relative, every segment
 * plain (none empty, none starting with a dot), no backslash or NUL. Otherwise null. For display only.
 */
export function safeBinOrigin(path: unknown): string | null {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || path.includes('\0') || posix.isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return null
  if (path.split('/').some((segment) => segment === '' || segment.trim() === '' || segment.trim().startsWith('.'))) return null
  return MARKDOWN.test(path) ? path : null
}

/**
 * Whether `name` may be a restored file's name at the Folio's top level: the rule for a new part's name. Refused: a
 * name that is not Markdown, and one no part can have: `_`-prefixed (the Index Note, the manifest and their siblings),
 * agent instructions (AGENTS.md, CLAUDE.md and their conflict copies), room support files, covers (README.md,
 * index.md), backups; and, by name, the Folio's own Index Note and manifest.
 */
export function isRestorableName(ws: { root: string }, dir: string, name: string): boolean {
  if (!isBinName(name) || !MARKDOWN.test(name) || !isNotInOutlineName(name)) return false
  const folded = name.toLocaleLowerCase()
  return folded !== posix.basename(indexNotePath(ws, dir)).toLocaleLowerCase() && folded !== MANIFEST_NAME.toLocaleLowerCase()
}

/** A regular file open for reading, with what fstat said of it. */
type OpenFile = { fd: number; dev: number; ino: number; mode: number }

/** Open the regular file at `absolute` without following a link at its name; null when it is not one. */
function openRegular(absolute: string): OpenFile | null {
  let fd: number
  try { fd = io.openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW) } catch { return null }
  const stat = fstatSync(fd)
  if (!stat.isFile()) { closeSync(fd); return null }
  return { fd, dev: stat.dev, ino: stat.ino, mode: stat.mode }
}

const hashOf = (fd: number): string => createHash('sha256').update(io.readFileSync(fd)).digest('hex')

/** The text at `absolute` (no link followed), or null when nothing is there. */
function textAt(absolute: string): string | null {
  let fd: number
  try {
    fd = io.openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (errno(error) === 'ENOENT') return null
    throw new Error(BIN_UNREADABLE)
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(BIN_UNREADABLE)
    return io.readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

const isRegularFile = (absolute: string): boolean => {
  try { return lstatSync(absolute).isFile() } catch { return false }
}
const isAbsent = (absolute: string): boolean => {
  try { lstatSync(absolute); return false } catch (error) { return errno(error) === 'ENOENT' }
}

/** The SHA-256 of the regular file at `absolute` (no link followed), or null when it is not one. */
function sha256Of(absolute: string): string | null {
  const file = openRegular(absolute)
  if (!file) return null
  try { return hashOf(file.fd) } finally { closeSync(file.fd) }
}

function parseIndex(text: string | null): BinIndex {
  if (text === null) return { raw: [], items: [] }
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error(BIN_UNREADABLE) }
  const raw = typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items) ? [...(value as { items: unknown[] }).items] : []
  const items: StoredItem[] = []
  for (const record of raw) {
    if (typeof record !== 'object' || record === null) continue
    const it = record as Record<string, unknown>
    if (typeof it.id !== 'string' || it.id === '' || it.id.startsWith('file:') || !isBinName(it.name)) continue
    items.push({
      id: it.id, name: it.name, path: safeBinOrigin(it.path), record,
      title: typeof it.title === 'string' ? it.title : it.name, removedAt: typeof it.removedAt === 'string' ? it.removedAt : '',
    })
  }
  return { raw, items }
}

const serialiseIndex = (raw: readonly unknown[]): string => `${JSON.stringify({ version: 1, items: raw }, null, 2)}\n`

// ---- The only two unlinks ------------------------------------------------------------------------------------------

/**
 * Drop the name `drop` of a file only while that file lives on at `keep`: both regular files (no link followed), each
 * still the file recorded for it (`sealed`: device and inode; for a hard link the two records are one file, for a copy
 * each name has its own), and the very same file or, for a copy, the same SHA-256. It never removes the last copy of
 * any bytes: it is how a move ends (the old name goes once the new one holds the file) and how a placement is taken back.
 */
function dropSecondName(drop: string, keep: string, sealed: { drop: FileSeal; keep: FileSeal }): void {
  let a: ReturnType<typeof lstatSync>
  let b: ReturnType<typeof lstatSync>
  try { a = lstatSync(drop); b = lstatSync(keep) } catch { throw new Error(NOT_A_FILE(basename(drop))) }
  if (!a.isFile() || !b.isFile()) throw new Error(NOT_A_FILE(basename(drop)))
  if (a.dev !== sealed.drop.dev || a.ino !== sealed.drop.ino || b.dev !== sealed.keep.dev || b.ino !== sealed.keep.ino) throw new Error(CHANGED_MEANWHILE)
  if (a.dev !== b.dev || a.ino !== b.ino) {
    const kept = sha256Of(keep)
    if (kept === null || sha256Of(drop) !== kept) throw new Error(CHANGED_MEANWHILE)
  }
  io.unlinkSync(drop)
}

/** Remove the bin's own file `absolute` (its list, or a temporary file) only while it holds exactly `bytes`, which this module wrote. */
function removeOwnBytes(absolute: string, bytes: string): void {
  if (textAt(absolute) !== bytes) throw new Error(BIN_CHANGED)
  io.unlinkSync(absolute)
}

/** The real path of the Folio's bin folder, pinned now (no link on the way, not in a nested Folio), for "Show bin in Finder"; null when there is none. */
export function binFolderToShow(ws: { root: string }, dir: string): string | null {
  return binPinNow(ws.root, dir)?.real ?? null
}

// ---- The file primitives (each called inside one pinned block) ----------------------------------------------------

/**
 * Give the regular file `file` (opened, no link followed, from real path `from`; its bytes `hash`) a second name `to`,
 * never over anything at `to`: a hard link, checked to be that very file; where links are not supported, an exclusive
 * copy checked to hold its bytes. A copy that does not hold the bytes is left where it is (it is not known to hold
 * only what this wrote) and named in the error.
 *
 * Answers what stands at `to` now: for a link the very file `file` (its device and inode), for a copy the copy's own
 * device and inode. Every later check and take-back of the name `to` judges it by this, never by `file`'s identity
 * (Sol r4 MAJOR: a copy has its own inode).
 */
function placeBeside(file: OpenFile, from: string, to: string, hash: string): FileSeal {
  let linked = true
  try {
    io.linkSync(from, to)
  } catch (error) {
    if (errno(error) === 'EEXIST') throw new Error(`A file named “${basename(to)}” is already there.`)
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EMLINK', 'ENOSYS'].includes(errno(error) ?? '')) throw error
    io.copyFileSync(from, to, constants.COPYFILE_EXCL)
    linked = false
  }
  if (linked) {
    const placed = lstatSync(to)
    if (!placed.isFile() || placed.dev !== file.dev || placed.ino !== file.ino) throw new Error(NOT_A_FILE(basename(from)))
    return { dev: file.dev, ino: file.ino }
  }
  const copy = openRegular(to)
  const copied = (() => {
    if (!copy) return null
    try { return hashOf(copy.fd) === hash ? { dev: copy.dev, ino: copy.ino } : null } finally { closeSync(copy.fd) }
  })()
  if (!copied || (copied.dev === file.dev && copied.ino === file.ino)) throw new Error(`“${basename(to)}” could not be copied exactly; the copy was left where it is.`)
  return copied
}

/** What one move left: the SHA-256 of the file's bytes, and the identity of what now stands at its new name (`placeBeside`). */
type Moved = { sha256: string; placed: FileSeal }

/**
 * Move the regular file at real path `from` to real path `to`: opened without following a link (and, given `sealed`,
 * only while it is that very file), its bytes checked against `expected`, placed beside (`placeBeside`), then the old
 * name dropped while each name is still what was recorded for it; if the old name cannot go, the new one goes again at
 * once, so the move is not half made.
 */
function moveFile(from: string, to: string, expected: string | null, sealed: FileSeal | null = null): Moved {
  const file = openRegular(from)
  if (!file) throw new Error(NOT_A_FILE(basename(from)))
  try {
    if (sealed && (file.dev !== sealed.dev || file.ino !== sealed.ino)) throw new Error(CHANGED_MEANWHILE)
    const hash = hashOf(file.fd)
    if (expected !== null && hash !== expected) throw new Error(FILE_CHANGED(basename(from)))
    const source: FileSeal = { dev: file.dev, ino: file.ino }
    const placed = placeBeside(file, from, to, hash)
    try {
      dropSecondName(from, to, { drop: source, keep: placed })
    } catch (error) {
      try { dropSecondName(to, from, { drop: placed, keep: source }) } catch { /* both names hold the file; nothing is lost */ }
      throw error
    }
    return { sha256: hash, placed }
  } finally {
    closeSync(file.fd)
  }
}

/**
 * Clear the execute (and set-id, sticky) bits of the open file `file` through its handle, and register at once the
 * take-back that puts them back (the file at `locate`'s path, pinned again, only while it is that file with the
 * permissions this left).
 */
function clearExecuteBits(fws: FolioWorkspace, steps: Steps, name: string, locate: (at: Pinned) => string, file: OpenFile): void {
  const was = file.mode & 0o7777
  if ((was & 0o7111) === 0) return
  const cleared = was & 0o666
  io.fchmodSync(file.fd, cleared)
  const sealed: FileSeal = { dev: file.dev, ino: file.ino }
  steps.done(`the permissions of “${name}”`, () => withPinned(fws, (at) => {
    const again = openRegular(locate(at))
    if (!again) throw new Error(CHANGED_MEANWHILE)
    try {
      if (again.dev !== sealed.dev || again.ino !== sealed.ino || (again.mode & 0o7777) !== cleared) throw new Error(CHANGED_MEANWHILE)
      io.fchmodSync(again.fd, was)
    } finally {
      closeSync(again.fd)
    }
  }))
}

/**
 * One move of `move` between the Folio and its bin, both ends pinned now: `forward` the way the change went
 * (`move.into`), `back` the other way. Refused unless the file has the bytes `move.sha256` names and, given `sealed`
 * (a take-back: what the move it reverses placed), is that very file. Answers the SHA-256 and what now stands at the
 * new name.
 */
function moveBetween(at: Pinned, fws: FolioWorkspace, seal: BinSeal, move: Move, direction: 'forward' | 'back', sealed: FileSeal | null = null): Moved {
  const binSide = at.binFile(seal, move.name)
  const folioSide = at.folio(move.path)
  const into = direction === 'forward' ? move.into : move.into === 'bin' ? 'folio' : 'bin'
  const [from, to] = into === 'bin' ? [folioSide, binSide] : [binSide, folioSide]
  if (into === 'folio') {
    try { fws.recordOwnWrite(move.path, fileIdentityOf(lstatSync(from, { bigint: true }))) } catch { /* moveFile refuses it below */ }
  } else {
    fws.recordOwnWrite(move.path, 'absent')
  }
  try {
    const history = prepareVersionMove(fws.root, relativeHistoryPath(fws.root, from), relativeHistoryPath(fws.root, to), true)
    let moved: Moved
    try { moved = moveFile(from, to, move.sha256, sealed) } catch (error) { history.cancel(); throw error }
    history.finish()
    // A copy (no hard links) stands at the Folio name as a file of its own: the watcher is told that file.
    if (into === 'folio') fws.recordOwnWrite(move.path, fileIdentityOf(lstatSync(to, { bigint: true })))
    return moved
  } catch (error) {
    fws.forgetOwnWrites(move.path)
    throw error
  }
}

/** Write the bin index from `expected` (its text now; null = none) to `next` (null = remove it), only while it still holds `expected`. */
function writeIndex(at: Pinned, seal: BinSeal, expected: string | null, next: string | null): void {
  const real = at.bin(seal)
  const target = join(real, BIN_INDEX)
  if (textAt(target) !== expected) throw new Error(BIN_CHANGED)
  if (next === expected) return
  if (next === null) { removeOwnBytes(target, expected as string); return }
  const temp = join(real, `.bin-index.${randomUUID()}.tmp`)
  io.writeFileSync(temp, next, { flag: 'wx' })
  try {
    if (textAt(target) !== expected) throw new Error(BIN_CHANGED)
    io.renameSync(temp, target)
  } catch (error) {
    try { removeOwnBytes(temp, next) } catch { /* left beside the list: a hidden name, never listed */ }
    throw error
  }
}

/** Remove the bin folder when it is empty (and still the sealed one); kept otherwise. rmdir(2) never removes a folder that holds anything. */
function removeEmptyBin(at: Pinned, seal: BinSeal): void {
  try { io.rmdirSync(at.bin(seal)) } catch { /* not empty, or not ours: kept */ }
}

/** Register the take-back of the bin's list written from `was` to `wrote`. */
function registerIndex(fws: FolioWorkspace, steps: Steps, seal: BinSeal, was: string | null, wrote: string | null): void {
  steps.done('the Folio bin’s list', () => withPinned(fws, (at) => writeIndex(at, seal, wrote, was)))
}

/** Register the take-back of `move`, made the way it names (`forward`) or back, which left `placed` at its new name: moved back only while that name holds that very file. */
function registerMove(fws: FolioWorkspace, steps: Steps, seal: BinSeal, move: Move, made: 'forward' | 'back', what: string, placed: FileSeal): void {
  steps.done(what, () => { withPinned(fws, (at) => moveBetween(at, fws, seal, move, made === 'forward' ? 'back' : 'forward', placed)) })
}

// ---- The documents --------------------------------------------------------------------------------------------------

const docsOf = (receipt: PlanCommitReceipt, side: 'before' | 'after'): Docs => ({
  indexPath: receipt.index.path, manifestPath: receipt.manifest.path, index: receipt.index[side], manifest: receipt.manifest[side],
})
const DOCUMENTS = ['index', 'manifest'] as const
type Which = typeof DOCUMENTS[number]
const textOf = (docs: Docs, which: Which): string | null => docs[which]
const pathOf = (docs: Docs, which: Which): string => (which === 'index' ? docs.indexPath : docs.manifestPath)
const NAMES = { index: 'the Index Note', manifest: 'the Folio manifest' } as const

/** The document at workspace-relative `path` now (null: no file). */
function documentNow(fws: FolioWorkspace, path: string): string | null {
  try {
    return readFileSync(fws.absolute(path), 'utf8')
  } catch (error) {
    if (errno(error) === 'ENOENT') return null
    throw new Error(`“${posix.basename(path)}” could not be read, so nothing was written over it.`)
  }
}

/** Thrown when a document is not what a write expects it to hold. */
class DocumentChanged extends Error {}

/** Write the document at `path` from `from` to `to` (null = remove it), only while it holds `from`: compared now and in the tick of the commit. */
async function writeDocument(fws: FolioWorkspace, path: string, from: string | null, to: string | null): Promise<void> {
  const holds = (): void => { if (documentNow(fws, path) !== from) throw new DocumentChanged(CHANGED_MEANWHILE) }
  holds()
  if (to === null) {
    // A document this operation created: removed only while it holds exactly the bytes this operation wrote (`from`).
    fws.removeFileOverRead(path, from as string)
    return
  }
  await settle('document-write', fws.saveFileWithoutReadBack(path, to, { allowExplicitEmpty: true, beforeCommit: holds }))
}

/**
 * Register the take-back of the documents a writer committed (`wrote`, from `was`, its receipt's exact bytes): the
 * manifest then the Index Note when taken back, each put back to `was` only while it still holds exactly `wrote`. A
 * document the writer did not change is never touched, whatever happened to it meanwhile.
 */
function registerDocuments(fws: FolioWorkspace, steps: Steps, was: Docs, wrote: Docs): void {
  for (const which of DOCUMENTS) {
    if (textOf(was, which) === textOf(wrote, which)) continue
    steps.done(NAMES[which], () => writeDocument(fws, pathOf(wrote, which), textOf(wrote, which), textOf(was, which)))
  }
}

/**
 * Write the documents from `from` to `to` (an Undo): the history checkpoints first, then both documents compared with
 * `from`, then the Index Note and the manifest, each compare-and-swap, each take-back registered once it is written.
 */
async function writeDocuments(fws: FolioWorkspace, steps: Steps, from: Docs, to: Docs, options: PlanWriteOptions): Promise<void> {
  const changing = DOCUMENTS.filter((which) => textOf(from, which) !== textOf(to, which))
  if (changing.includes('index')) await settle('index-checkpoint', options.beforeIndexWrite?.(to.indexPath))
  if (changing.includes('manifest')) await settle('manifest-checkpoint', options.beforeManifestWrite?.(to.manifestPath))
  for (const which of DOCUMENTS) if (documentNow(fws, pathOf(from, which)) !== textOf(from, which)) throw new UndoStale()
  for (const which of changing) {
    try {
      await settle('document', writeDocument(fws, pathOf(from, which), textOf(from, which), textOf(to, which)))
    } catch (error) {
      throw error instanceof DocumentChanged ? new UndoStale() : error
    }
    steps.done(NAMES[which], () => writeDocument(fws, pathOf(to, which), textOf(to, which), textOf(from, which)))
  }
}

// ---- Transactions -----------------------------------------------------------------------------------------------------

/** The take-backs of one bin change's steps made so far, newest last. */
class Steps {
  private readonly made: Array<{ what: string; takeBack: () => void | Promise<void> }> = []
  /** A step's write succeeded: `takeBack` reverses it, compare-and-swap, or throws. `what` names it in a refusal that could not. */
  done(what: string, takeBack: () => void | Promise<void>): void { this.made.push({ what, takeBack }) }
  /** Take back every step made, newest first; answers what could not be taken back. */
  async rollBack(fws: FolioWorkspace): Promise<string[]> {
    const left: string[] = []
    for (const step of this.made.splice(0).reverse()) {
      try { await settle('take-back', step.takeBack()) } catch (error) { left.push(`${step.what} (${plain(fws, error).replace(/\.$/, '')})`) }
    }
    return left
  }
}

const NOTHING = '[,;]?\\s*(?:so\\s+)?nothing (?:was|has been) (?:changed|removed|written|added|restored)\\.?'
/** Whether `text` already says nothing was changed. */
const saysNothing = (text: string): boolean => new RegExp(NOTHING, 'i').test(text)
/** `text` without its "nothing was changed" clauses (for a refusal where something was). */
const withoutNothing = (text: string): string => text.replace(new RegExp(NOTHING, 'gi'), '.').replace(/\.{2,}/g, '.')

/** The refusal's sentence: the reason, then "Nothing was changed." when every step was taken back, else what was left. */
function refusalText(fws: FolioWorkspace, error: unknown, left: readonly string[], kept = 'Nothing was changed.'): string {
  const reason = plain(fws, error).trim()
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`
  if (left.length === 0) return saysNothing(sentence) ? sentence : `${sentence} ${kept}`
  return `${withoutNothing(sentence)} Not everything could be put back: ${left.join('; ')}. Check the Folio and its bin in Finder.`
}

/** What the bin holds now: listed files (index order, newest first) and files it does not know. Reads only (I-4), in one synchronous block. */
export function readFolioBin(ws: { root: string }, dir: string): { items: FolioBinItem[]; unreadable: boolean } {
  let bin: FolderIdentity | null
  try { bin = binPinNow(ws.root, dir) } catch { return { items: [], unreadable: true } }
  if (!bin) return { items: [], unreadable: false }
  let index: BinIndex
  let unreadable = false
  try { index = parseIndex(textAt(join(bin.real, BIN_INDEX))) } catch { index = { raw: [], items: [] }; unreadable = true }
  let names: string[]
  try {
    names = readdirSync(bin.real, { withFileTypes: true }).filter((entry) => entry.isFile() && isBinName(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b))
  } catch {
    return { items: [], unreadable: true }
  }
  const present = new Set(names)
  const known = new Set<string>()
  const items: FolioBinItem[] = []
  for (const item of [...index.items].reverse()) {
    if (!present.has(item.name) || known.has(item.name)) continue
    known.add(item.name)
    items.push({ id: item.id, name: item.name, was: item.path === null ? null : inFolio(dir, item.path), title: item.title, removedAt: item.removedAt })
  }
  for (const name of names) {
    if (!known.has(name)) items.push({ id: `file:${name}`, name, was: null, title: name, removedAt: '' })
  }
  return { items, unreadable }
}

// ---- Undo records (in memory, as the Undo of Add's: a restart forgets them) -----------------------------------------

/** One change's record, the authority for its Undo: the exact documents and bin list before and after it, and its moves. */
type BinRecord = { folio: string; docsBefore: Docs | null; docsAfter: Docs | null; moves: Move[]; binBefore: string | null; binAfter: string | null; binCreated: boolean }
const records = new Map<string, BinRecord>()
const BIN_UNDO_KEPT = 16
const folioOf = (fws: FolioWorkspace): string => {
  const key = folioKey(fws.root, fws.folioDir)
  return `${key.root}\u0000${key.dir}`
}
function keep(fws: FolioWorkspace, record: Omit<BinRecord, 'folio'>): string {
  const token = `bin:${randomUUID()}`
  const folio = folioOf(fws)
  records.set(token, { folio, ...record })
  const mine = [...records.entries()].filter(([, kept]) => kept.folio === folio)
  for (const [old] of mine.slice(0, Math.max(0, mine.length - BIN_UNDO_KEPT))) records.delete(old)
  return token
}
/** Forget every record (tests). */
export function forgetBinUndoRecords(): void { records.clear() }
export const isBinUndoToken = (token: string): boolean => token.startsWith('bin:')

/** Run `work` as one bin change: the Folio's lock, the Collection's write turn, its write gate. */
function binChange<T>(fws: FolioWorkspace, work: () => Promise<T>): Promise<T> {
  return withPlanLock(fws, fws.folioDir, () => fws.exclusiveAll(async () => {
    assertCollectionWritable(fws.root)
    return work()
  }))
}

// ---- Remove ----------------------------------------------------------------------------------------------------------

export type BinRemovalAnswer =
  | { ok: true; token: string | null; removed: RemovedPlanPart[]; binned: Array<{ path: string; name: string }>; indexPath: string | null; manifestPath: string }
  | { ok: false; message: string }

type Binned = { moves: Move[]; before: string | null; after: string; created: boolean }

/**
 * Remove the parts at `indices` (the running order the room showed is `expected`) from the Folio: their lines and
 * manifest entries go, then each written part's file moves into the bin, in one change with one Undo token.
 */
export async function removePartsToBin(fws: FolioWorkspace, indices: number[], expected: Parameters<typeof removePlanPartsOnce>[3], options: PlanWriteOptions = {}): Promise<BinRemovalAnswer> {
  const dir = fws.folioDir
  const manifestPath = dir === '' ? MANIFEST_NAME : `${dir}/${MANIFEST_NAME}`
  try {
    return await settle('remove', binChange(fws, async () => {
      const steps = new Steps()
      let receipt: PlanCommitReceipt | null = null
      let files: Array<RemovedPlanPart & { path: string }> = []
      // Every check of the Plan passed: the files are checked too, writing nothing (the documents go first, the files last).
      const beforeWrite = async (removal: PlanRemoval): Promise<void> => {
        files = removal.removed.filter((part): part is RemovedPlanPart & { path: string } => part.path !== null)
        withPinned(fws, (at) => {
          for (const part of files) if (!isRegularFile(at.folio(part.path))) throw new Error(NOT_A_FILE(posix.basename(part.path)))
          if (files.length) at.binNow()
        })
      }
      let removal: PlanRemoval | null
      try {
        removal = await settle('remove:documents', removePlanPartsOnce(fws, dir, indices, expected, { ...options, onCommit: (made) => { receipt = made; options.onCommit?.(made) } }, { beforeWrite }))
      } catch (error) {
        const made = receipt as PlanCommitReceipt | null
        if (made) registerDocuments(fws, steps, docsOf(made, 'before'), docsOf(made, 'after'))
        return { ok: false, message: refusalText(fws, error, await settle('remove:roll-back', steps.rollBack(fws))) }
      }
      if (!removal) return { ok: true, token: null, removed: [], binned: [], indexPath: null, manifestPath }
      const committed = receipt as PlanCommitReceipt | null
      if (committed) registerDocuments(fws, steps, docsOf(committed, 'before'), docsOf(committed, 'after'))
      let made: Binned | null = null
      try {
        if (files.length) made = withPinned(fws, (at) => binIn(at, fws, files, steps))
      } catch (error) {
        return { ok: false, message: refusalText(fws, error, await settle('remove:roll-back', steps.rollBack(fws))) }
      }
      const token = committed || made ? keep(fws, {
        docsBefore: committed ? docsOf(committed, 'before') : null, docsAfter: committed ? docsOf(committed, 'after') : null,
        moves: made?.moves ?? [], binBefore: made?.before ?? null, binAfter: made?.after ?? null, binCreated: made?.created ?? false,
      }) : null
      return {
        ok: true, token, removed: removal.removed, indexPath: removal.indexNoteAbsent ? null : removal.indexPath, manifestPath,
        binned: (made?.moves ?? []).map((move) => ({ path: move.path, name: move.name })),
      }
    }))
  } catch (error) {
    return { ok: false, message: refusalText(fws, error, []) }
  }
}

/**
 * After the documents, in one pinned block: the bin folder (when there is none), its list, then the file moves. Each
 * step is registered in `steps` once made, before the next; the caller takes them back on failure.
 */
function binIn(at: Pinned, fws: FolioWorkspace, files: Array<RemovedPlanPart & { path: string }>, steps: Steps): Binned {
  const dir = fws.folioDir
  const { seal, created } = at.ensureBin()
  if (created) steps.done('the empty Folio bin folder', () => withPinned(fws, (again) => removeEmptyBin(again, seal)))
  const before = textAt(join(at.bin(seal), BIN_INDEX))
  const index = parseIndex(before)
  const taken = new Set(index.items.map((item) => item.name))
  const now = new Date().toISOString()
  const moves: Move[] = files.map((part) => {
    const name = freeName(at.bin(seal), basename(part.path), taken)
    taken.add(name)
    const sha256 = sha256Of(at.folio(part.path))
    if (sha256 === null) throw new Error(NOT_A_FILE(posix.basename(part.path)))
    index.raw.push({ id: randomUUID(), name, path: withinFolio(dir, part.path), title: part.title, removedAt: now, sha256 })
    return { path: part.path, name, into: 'bin', sha256 }
  })
  const after = serialiseIndex(index.raw)
  writeIndex(at, seal, before, after)
  registerIndex(fws, steps, seal, before, after)
  for (const move of moves) {
    const { placed } = moveBetween(at, fws, seal, move, 'forward')
    registerMove(fws, steps, seal, move, 'forward', `“${posix.basename(move.path)}” (in the Folio bin)`, placed)
  }
  return { moves, before, after, created }
}

/** A name for `name` in the bin (at real path `bin`) that nothing holds yet. */
function freeName(bin: string, name: string, taken: ReadonlySet<string>): string {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`
    if (!taken.has(candidate) && isAbsent(join(bin, candidate))) return candidate
  }
}

// ---- Undo ------------------------------------------------------------------------------------------------------------

export type BinUndoAnswer = { ok: true; paths: string[] } | { ok: false; stale: boolean; message: string }

/** Refusals inside an Undo's transaction that say "this Undo can no longer be made" rather than "it failed". */
class UndoStale extends Error {
  constructor(message = STALE_UNDO_MESSAGE) { super(message) }
}

/** The Undo of a removal or a Restore (`token`, whose in-memory record is the authority): exact, or refused with every step taken back. */
export async function undoBinChange(fws: FolioWorkspace, token: string, options: PlanWriteOptions = {}): Promise<BinUndoAnswer> {
  const record = records.get(token)
  const stale: BinUndoAnswer = { ok: false, stale: true, message: STALE_UNDO_MESSAGE }
  if (!record || record.folio !== folioOf(fws)) return stale
  try {
    return await settle('undo', binChange(fws, async (): Promise<BinUndoAnswer> => {
      // Every check first, writing nothing: the documents, the bin's list and every file (its bytes too) as the change left them.
      if (record.docsAfter) {
        for (const which of DOCUMENTS) if (documentNow(fws, pathOf(record.docsAfter, which)) !== textOf(record.docsAfter, which)) return stale
      }
      const needsBin = record.moves.length > 0 || record.binAfter !== record.binBefore
      const checked = withPinned(fws, (at): { seal: BinSeal | null } | BinUndoAnswer => {
        const seal = needsBin ? at.binNow() : null
        if (needsBin && !seal) return stale
        if (seal && textAt(join(at.bin(seal), BIN_INDEX)) !== record.binAfter) return stale
        for (const move of record.moves) {
          const binSide = at.binFile(seal!, move.name)
          const folioSide = at.folio(move.path)
          const [from, to] = move.into === 'bin' ? [binSide, folioSide] : [folioSide, binSide]
          if (!isRegularFile(from) || !isAbsent(to)) return stale
          if (sha256Of(from) !== move.sha256) return { ok: false, stale: true, message: `Could not undo. ${FILE_CHANGED(move.name)} Nothing was changed.` }
        }
        return { seal }
      })
      if ('ok' in checked) return checked
      const { seal } = checked

      // The documents first, then (one pinned block) the bin's list, and the file moves last: a failure before the moves leaves no file moved.
      const steps = new Steps()
      try {
        if (record.docsAfter && record.docsBefore) await settle('undo:documents', writeDocuments(fws, steps, record.docsAfter, record.docsBefore, options))
        withPinned(fws, (at) => {
          if (seal && record.binAfter !== record.binBefore) {
            writeIndex(at, seal, record.binAfter, record.binBefore)
            registerIndex(fws, steps, seal, record.binAfter, record.binBefore)
          }
          for (const move of record.moves) {
            const { placed } = moveBetween(at, fws, seal!, move, 'back')
            registerMove(fws, steps, seal!, move, 'back', `“${move.name}”`, placed)
          }
        })
      } catch (error) {
        const left = await settle('undo:roll-back', steps.rollBack(fws))
        if (error instanceof UndoStale) {
          records.delete(token)
          if (left.length === 0) return stale
        }
        if (left.length) records.delete(token)
        return { ok: false, stale: false, message: `Could not undo. ${refusalText(fws, error, left)}` }
      }
      if (record.binCreated && seal) withPinned(fws, (at) => removeEmptyBin(at, seal))
      records.delete(token)
      return { ok: true, paths: [...record.moves.map((move) => move.path), ...(record.docsAfter ? [record.docsAfter.indexPath, record.docsAfter.manifestPath] : [])] }
    }))
  } catch (error) {
    return { ok: false, stale: false, message: `Could not undo. ${refusalText(fws, error, [])}` }
  }
}

// ---- Restore ---------------------------------------------------------------------------------------------------------

export type BinRestoreAnswer = { ok: true; token: string | null; path: string; position: number | null; message: string } | { ok: false; message: string }

/**
 * The Folio's top level for its parts, workspace-relative: the folder its manifest takes its parts from (`content_root`),
 * or the Folio's own folder when there is none (or the manifest's is refused). Never from the bin's list.
 */
async function partsFolder(fws: FolioWorkspace): Promise<string> {
  const manifest = await settle('restore:manifest-read', readManifest(fws, fws.folioDir).catch(() => null))
  const root = manifest && !manifest.contentRootRefused ? manifest.contentRoot.replace(/^\.\/?/, '').replace(/\/+$/, '') : ''
  return [fws.folioDir, root].filter((part) => part !== '').join('/')
}

/** The first workspace-relative path in `folder` for `name` that nothing holds: `name`, then `stem 2.md`, `stem 3.md`, ... */
function freeFolioPath(at: Pinned, folder: string, name: string): string {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; n < 1000; n += 1) {
    const file = n === 1 ? name : `${stem} ${n}${ext}`
    const path = folder === '' ? file : `${folder}/${file}`
    if (isAbsent(at.folio(path))) return path
  }
  throw new Error(`The Folio holds too many files named like “${name}” to restore it.`)
}

/**
 * Restore the bin item `id` (as `readFolioBin` names it): its file goes to the Folio's top level under its name in the
 * bin (`name 2.md` when that is taken) and joins the end of the running order. The bin's list is not asked where the
 * file goes; its row for the file only leaves the list.
 */
export async function restoreFromBin(fws: FolioWorkspace, id: string, options: PlanWriteOptions = {}): Promise<BinRestoreAnswer> {
  const dir = fws.folioDir
  const refused = (message: string): BinRestoreAnswer => ({ ok: false, message })
  try {
    return await settle('restore', binChange(fws, async (): Promise<BinRestoreAnswer> => {
      // Every check first, writing nothing (one pinned block): the bin, its list, the file's name.
      const found = withPinned(fws, (at) => {
        const seal = at.binNow()
        return seal ? { seal, before: textAt(join(at.bin(seal), BIN_INDEX)) } : null
      })
      if (!found) return refused(NOT_IN_BIN)
      const { seal, before } = found
      let index: BinIndex | null
      try { index = parseIndex(before) } catch { index = null }
      const stored = index?.items.find((item) => item.id === id) ?? null
      const name = stored?.name ?? (typeof id === 'string' && id.startsWith('file:') ? id.slice(5) : null)
      // A file the list knows is restored by its row (so its row leaves with it).
      if (!isBinName(name) || (!stored && index?.items.some((item) => item.name === name))) return refused(NOT_IN_BIN)
      if (!isRestorableName(fws, dir, name)) return refused(`“${name}” cannot be restored as a part: no part of a Folio can have that name. It is still in the Folio bin.`)
      if (!withPinned(fws, (at) => isRegularFile(at.binFile(seal, name)))) return refused(NOT_IN_BIN)
      const folder = await settle('restore:parts-folder', partsFolder(fws))
      const next = stored && index ? serialiseIndex(index.raw.filter((item) => item !== stored.record)) : before

      const steps = new Steps()
      let receipt: PlanCommitReceipt | null = null
      try {
        // 1. One pinned block: the file's execute and set-id bits go (through its handle), then it is given its name in
        //    the Folio beside its name in the bin. Nothing has moved yet; each step's take-back is registered at once.
        //    `source` is the bin's file, `placed` what now stands at the Folio name: the same file for a link, the copy's
        //    own identity where links are not supported. Each name is judged by its own record from here on.
        const placed = withPinned(fws, (at): { path: string; source: FileSeal; placed: FileSeal; historyId: string | null } => {
          const path = freeFolioPath(at, folder, name)
          const binSide = at.binFile(seal, name)
          const file = openRegular(binSide)
          if (!file) throw new Error(NOT_IN_BIN)
          try {
            const sha256 = hashOf(file.fd)
            clearExecuteBits(fws, steps, name, (again) => again.binFile(seal, name), file)
            const folioSide = at.folio(path)
            fws.recordOwnWrite(path, fileIdentityOf(fstatSync(file.fd, { bigint: true })))
            const history = prepareVersionMove(fws.root, relativeHistoryPath(fws.root, binSide), relativeHistoryPath(fws.root, folioSide), true)
            steps.done('the restored part’s version history', () => history.cancel())
            let made: FileSeal
            try { made = placeBeside(file, binSide, folioSide, sha256) } catch (error) { fws.forgetOwnWrites(path); throw error }
            const source: FileSeal = { dev: file.dev, ino: file.ino }
            steps.done(`“${posix.basename(path)}” (in the Folio)`, () => withPinned(fws, (again) => {
              fws.recordOwnWrite(path, 'absent')
              dropSecondName(again.folio(path), again.binFile(seal, name), { drop: made, keep: source })
            }))
            fws.recordOwnWrite(path, fileIdentityOf(lstatSync(folioSide, { bigint: true })))
            return { path, source, placed: made, historyId: history.id }
          } finally {
            closeSync(file.fd)
          }
        })
        const { path } = placed
        // 2. Its line at the end of the running order, as an Add puts it; the documents' exact bytes come from the writer.
        let position: number
        try {
          position = await settle('restore:documents', appendRestored(fws, path, { ...options, onCommit: (made) => { receipt = made; options.onCommit?.(made) } }))
        } finally {
          const made = receipt as PlanCommitReceipt | null
          if (made) registerDocuments(fws, steps, docsOf(made, 'before'), docsOf(made, 'after'))
        }
        // 3. One pinned block: its row leaves the bin's list (a list that cannot be read is left as it is); then, last,
        //    the move completes: the bin's name goes, only while the Folio's name holds what step 1 placed there (bits
        //    cleared) and the bin's name still holds the bin's file (for a copy: with the same bytes as the copy).
        const sha256 = withPinned(fws, (at): string => {
          if (next !== before) {
            writeIndex(at, seal, before, next)
            registerIndex(fws, steps, seal, before, next)
          }
          const folioSide = at.folio(path)
          const file = openRegular(folioSide)
          if (!file) throw new Error(NOT_A_FILE(posix.basename(path)))
          try {
            if (file.dev !== placed.placed.dev || file.ino !== placed.placed.ino) throw new Error(NOT_A_FILE(posix.basename(path)))
            const hash = hashOf(file.fd)
            clearExecuteBits(fws, steps, name, (again) => again.folio(path), file)
            dropSecondName(at.binFile(seal, name), folioSide, { drop: placed.source, keep: placed.placed })
            return hash
          } finally {
            closeSync(file.fd)
          }
        })
        finishVersionMove(fws.root, placed.historyId)
        const committed = receipt as PlanCommitReceipt | null
        const token = keep(fws, {
          docsBefore: committed ? docsOf(committed, 'before') : null, docsAfter: committed ? docsOf(committed, 'after') : null,
          moves: [{ path, name, into: 'folio', sha256 }], binBefore: before, binAfter: next, binCreated: false,
        })
        return { ok: true, token, path, position, message: `Restored ${posix.basename(path)} as part ${position + 1}.` }
      } catch (error) {
        const left = await settle('restore:roll-back', steps.rollBack(fws))
        return refused(refusalText(fws, error, left, 'It is still in the Folio bin; nothing was changed.'))
      }
    }))
  } catch (error) {
    return refused(refusalText(fws, error, []))
  }
}

/** The restored file `path` at the end of the running order; a Folio with no Index Note gets a manifest entry instead. Answers its position. */
async function appendRestored(fws: FolioWorkspace, path: string, options: PlanWriteOptions): Promise<number> {
  const dir = fws.folioDir
  if (indexNoteExists(fws, dir)) return settle('restore:adopt', adoptRestoredFile(fws, dir, path, options))
  const read = await settle('restore:manifest-only', readManifestOnly(fws, dir))
  if (!read.assessment.ok) throw new Error('This Folio’s manifest cannot take the file in its running order, so it was not restored.')
  const order = await settle('restore:manifest-append', appendManifestEntries(fws, dir, read as typeof read & { assessment: { ok: true; order: string[] } }, [path], options))
  return order.indexOf(path)
}
