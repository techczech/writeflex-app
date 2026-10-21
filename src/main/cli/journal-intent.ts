/**
 * The journal's record of a change that has not finished: `<id>.intent.jsonl` beside the entries in
 * the journal folder (journal.ts says where that is: outside the Collection). A complete entry needs fingerprints of the content AFTER the change, so it
 * can only be written at the end; a process killed partway through a rename repair would otherwise
 * leave rewritten files and nothing to undo them by.
 *
 * The intent is written ahead: before a file is rewritten, a line holding its content before and the
 * fingerprint of what is about to be written is appended and flushed; before a path moves, a line
 * naming the move. No file is ever changed without its line already on disk. When the operation ends,
 * the journal writes the complete entry under the same id and removes the intent. An intent with no
 * complete entry is an INTERRUPTED change.
 *
 * Undoing an interrupted change (`undoInterrupted`) acts file by file, by this rule:
 *  - the file holds its content before: nothing to do;
 *  - the file holds exactly what the command line was about to write (a recorded fingerprint): the
 *    content before is put back;
 *  - anything else was written by someone since, and the file is refused by name and left alone.
 * A move is reversed when the disk shows it happened (the new name exists and the old does not). A
 * file move stopped between making the new name and removing the old leaves two names for one file;
 * the new name is removed, which loses nothing. Any other state of a move is refused by name.
 *
 * NESTED MOVES. A move's paths are recorded as they were when it was made, that is, after every
 * earlier move of the same operation (a folder's Index Note is renamed inside the folder's new name).
 * The moves still standing are always the first few, in the forward operation as in an undo, which
 * reverses from the last. So a move whose two names are both absent is judged again with its paths
 * taken back through the earlier moves, nearest first, as if those were reversed; it is then judged
 * where it stands, and those earlier moves must themselves be found reversed, or the undo is refused.
 * Only the identity checks of the session's writes then act on what is found.
 *
 * Like an entry, an intent is DATA: every path in it is judged with the Workspace's document-path
 * rule before undo acts, and undo acts only through the WriteSession, which judges again at the write.
 *
 * AN UNDO'S INTENT holds one line and no content: `undoes`, the id of the entry being undone. That is
 * all the next undo needs. The entry already says what each file held before and after, so a file
 * found holding either is known to be the command line's, and the same file-by-file rule finishes the
 * undo that was killed.
 *
 * THE SIZE IS BUDGETED FIRST AND COUNTED AS IT GROWS. An operation that knows what it will change (a
 * move and the files its link repair will rewrite) has the whole record budgeted before it changes
 * anything (`budget`); and an intent line that would take the record over the entry limit is refused
 * before it is written, which is before the file it announces is touched.
 */
import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { posix } from 'node:path'
import { assertCollectionWritable } from '../collection-write-gate'
import type { PathKind } from '../document-path'
import { MANIFEST_NAME } from '../../shared/folio-constants'
import type { Workspace } from '../workspace'
import { readBytes } from './guarded-fs'
import { CliError } from './operation'
import { NOT_THE_FOLDER_MOVED, fingerprint, isTheFolderMoved, type SessionMove, type WriteSession } from './write-session'

export const INTENT_SUFFIX = '.intent.jsonl'
const MARKDOWN = /\.(?:md|markdown|mdx)$/i
const SHA = /^[0-9a-f]{64}$/

const isText = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max

/**
 * The folder a recorded move says it moved: `{ dev, ino }`, `{}` when the record carries none (a file
 * move, or a record made before folders were identified), null when what it carries is not usable.
 */
export function parseIdentity(move: Record<string, unknown>): { dev?: number; ino?: number } | null {
  if (move.dev === undefined && move.ino === undefined) return {}
  const whole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  return move.kind === 'folder' && whole(move.dev) && whole(move.ino) ? { dev: move.dev, ino: move.ino } : null
}

/** What an interrupted change left on record. `files` are keyed by the path each would have had at the end. */
export type Interrupted = {
  id: string
  at: string
  operation: string
  moves: SessionMove[]
  files: Array<{ path: string; before: string; wrote: string[] }>
  /** Present on an undo's intent: the id of the entry it was undoing. Such an intent has no moves and no files. */
  undoes?: string
}

/**
 * What an operation is about to record, judged before it changes anything: each path it will move, and
 * each file it will rewrite with the size of its content before (null for a file already on record,
 * whose content before is not written again).
 */
export type PlannedRecord = {
  moves: Array<{ from: string; to: string; kind: PathKind }>
  files: Array<{ path: string; beforeBytes: number | null }>
}

/** The longest a recorded fingerprint, device or inode can be written. */
const LONGEST_FINGERPRINT = '0'.repeat(64)
const LONGEST_NUMBER = Number.MAX_SAFE_INTEGER

export const changeTooLarge = (max: number): CliError =>
  new CliError(`This change is too large for the command line to keep a record to undo it by (the record would be over ${max} bytes), so it was refused. Make the change in WriteFlex.`)

/** The write-ahead half: one per operation, creating its file only when something is first recorded. */
export class IntentLog {
  #started = false
  #kept = false
  #undoes: string | undefined
  #bytes = 0

  constructor(
    readonly id: string,
    private readonly root: string,
    private readonly header: { at: string; operation: string },
    /** The verified journal folder (journal.ts), made if missing. */
    private readonly folder: () => Promise<string>,
    /** The entry limit, and how a failure to write application data is told (journal.ts). */
    private readonly limits: { maxBytes: number; refusal: (error: unknown) => Promise<unknown> },
  ) {}

  /** Whether anything was recorded, that is, whether the intent file exists. */
  get started(): boolean {
    return this.#started
  }

  /** Whether the intent stays on record when its operation fails (an undo that put back only part). */
  get kept(): boolean {
    return this.#kept
  }

  keep(): void {
    this.#kept = true
  }

  /** This operation is an undo of the entry `id`. Said before anything is recorded. */
  undoes(id: string): void {
    this.#undoes = id
  }

  /**
   * Put the intent on disk now, with nothing announced yet. Called before the first thing an operation
   * does on the way to changing an existing file, so that when the record cannot be written the
   * operation is refused with nothing changed at all.
   */
  async start(): Promise<void> {
    if (!this.#started) await this.#append(null)
  }

  /** Before `path` is rewritten: its content before (the first time only) and what is about to be written. */
  async file(path: string, before: Uint8Array | null, wrote: string): Promise<void> {
    if (this.#undoes !== undefined) return this.start()
    // Judged from the size before the content is encoded: base64 is four bytes for every three.
    if (before && this.#bytes + Math.ceil(before.byteLength / 3) * 4 > this.#room()) throw this.#tooLarge()
    await this.#append({ file: { path, ...(before ? { before: Buffer.from(before).toString('base64') } : {}), wrote } })
  }

  /**
   * Refuse now, with nothing written and nothing changed, when the record of `planned` would not fit
   * within the entry limit. Counted as the lines will be written, every number at its longest. An
   * undo's intent records no content and is not budgeted.
   */
  budget(planned: PlannedRecord): void {
    if (this.#undoes !== undefined) return
    const line = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + 1
    let total = this.#bytes + (this.#started ? 0 : Buffer.byteLength(this.#head()))
    for (const move of planned.moves) total += line({ move: { ...move, dev: LONGEST_NUMBER, ino: LONGEST_NUMBER } })
    for (const file of planned.files) {
      total += line({ file: { path: file.path, ...(file.beforeBytes === null ? {} : { before: '' }), wrote: LONGEST_FINGERPRINT } })
      if (file.beforeBytes !== null) total += Math.ceil(file.beforeBytes / 3) * 4
    }
    if (total > this.#room()) throw this.#tooLarge()
  }

  /** Before a path moves. */
  async move(move: SessionMove): Promise<void> {
    if (this.#undoes !== undefined) return this.start()
    await this.#append({ move })
  }

  /** What the intent may grow to: the entry limit, less room for what the finished entry adds (its summary, longer final paths). */
  #room(): number {
    return this.limits.maxBytes - Math.min(1024 * 1024, Math.floor(this.limits.maxBytes / 4))
  }

  #tooLarge(): CliError {
    return changeTooLarge(this.limits.maxBytes)
  }

  #head(): string {
    return `${JSON.stringify({ version: 1, id: this.id, intent: true, ...this.header, ...(this.#undoes === undefined ? {} : { undoes: this.#undoes }) })}\n`
  }

  async #append(line: unknown): Promise<void> {
    const head = this.#started ? '' : this.#head()
    const text = `${head}${line === null ? '' : `${JSON.stringify(line)}\n`}`
    if (this.#bytes + Buffer.byteLength(text) > this.#room()) throw this.#tooLarge()
    try {
      const folder = await this.folder()
      assertCollectionWritable(this.root)
      const flags = constants.O_WRONLY | constants.O_NOFOLLOW | (this.#started ? constants.O_APPEND : constants.O_CREAT | constants.O_EXCL)
      const handle = await open(`${folder}/${this.id}${INTENT_SUFFIX}`, flags, 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync().catch(() => {})
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw await this.limits.refusal(error)
    }
    this.#bytes += Buffer.byteLength(text)
    this.#started = true
  }
}

/**
 * A well-formed intent, or null. A last line with no line end is a write the kill cut short; the
 * change it announced had not begun, so it is dropped. Any other malformed line makes the whole
 * intent unreadable: it is never guessed at.
 */
export function parseIntent(text: string, id: string): Interrupted | null {
  const lines = text.split('\n')
  lines.pop() // '' after the final line end, or a torn last line
  const rows: unknown[] = []
  for (const line of lines) {
    try { rows.push(JSON.parse(line)) } catch { return null }
  }
  const head = rows.shift() as Record<string, unknown> | undefined
  if (!head || typeof head !== 'object' || head.version !== 1 || head.id !== id || head.intent !== true || !isText(head.at) || !isText(head.operation)) return null
  const moves: SessionMove[] = []
  let files = new Map<string, { before: string; wrote: string[] }>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) return null
    const { file, move } = row as { file?: Record<string, unknown>; move?: Record<string, unknown> }
    if (file && typeof file === 'object') {
      if (!isText(file.path) || !isText(file.wrote) || !SHA.test(file.wrote)) return null
      const known = files.get(file.path)
      if (known) known.wrote.push(file.wrote)
      else if (typeof file.before === 'string') files.set(file.path, { before: file.before, wrote: [file.wrote] })
      else return null
    } else if (move && typeof move === 'object') {
      if (!isText(move.from) || !isText(move.to) || (move.kind !== 'file' && move.kind !== 'folder')) return null
      const { from, to } = move as { from: string; to: string }
      const identity = parseIdentity(move)
      if (identity === null) return null
      moves.push({ from, to, kind: move.kind, ...identity })
      files = new Map([...files].map(([path, record]) => [path === from || path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path, record]))
    } else return null
  }
  if (head.undoes !== undefined && !isText(head.undoes)) return null
  return { id, at: head.at, operation: head.operation, moves, files: [...files].map(([path, record]) => ({ path, ...record })), ...(head.undoes === undefined ? {} : { undoes: head.undoes as string }) }
}

function judged(ws: Workspace, path: string, kind: PathKind): void {
  const refuse = (): never => {
    throw new CliError(`Undo refused: the journal names ${JSON.stringify(path)}, which is not a ${kind === 'file' ? 'document' : 'folder'} in this Collection. Nothing was changed.`)
  }
  if (path === '' || path.includes('\\') || posix.normalize(path) !== path || path.startsWith('/') || path.endsWith('/')) refuse()
  if (ws.classifyPath(path, kind) !== 'document') refuse()
  if (kind === 'file' && !MARKDOWN.test(path) && posix.basename(path) !== MANIFEST_NAME) refuse()
}

type MoveState = 'happened' | 'not' | 'two-names' | 'neither'

const neitherThere = (move: SessionMove): CliError =>
  new CliError(`Undo refused: neither ${move.from} nor ${move.to} is there, so the interrupted move cannot be judged. Nothing was changed.`)

/** What the disk says about one intended move: `neither` when both its names are absent. */
async function moveState(ws: Workspace, move: SessionMove): Promise<MoveState> {
  const [from, to] = await Promise.all([move.from, move.to].map((path) => lstat(ws.absolute(path)).catch(() => null)))
  if (to && !from) return 'happened'
  if (from && !to) return 'not'
  if (!from || !to) return 'neither'
  if (from.ino === to.ino && from.dev === to.dev) {
    if (move.from.toLowerCase() === move.to.toLowerCase()) {
      // One entry on a disk that ignores letter case: the folder's own listing says which name it has.
      const parent = posix.dirname(move.to)
      const names = await readdir(parent === '.' ? ws.root : ws.absolute(parent)).catch(() => [] as string[])
      return names.includes(posix.basename(move.to)) ? 'happened' : 'not'
    }
    if (move.kind === 'file' && from.isFile()) return 'two-names'
  }
  throw new CliError(`Undo refused: both ${move.from} and ${move.to} exist, so the interrupted move cannot be judged. Nothing was changed.`)
}

const isUnder = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`)
/** `path` as it was before `move`. */
const before = (path: string, move: SessionMove): string => (isUnder(path, move.to) ? `${move.from}${path.slice(move.to.length)}` : path)

/**
 * The state of `moves[k]`, judged where the disk has it: as recorded when that says anything, else with
 * its paths taken back through `moves[k - 1]`, `moves[k - 2]`, ... as if those were reversed, nearest
 * first. `reversedFrom` is the first of the earlier moves this assumed reversed (`k` when none was).
 * Every path is judged before it is looked at.
 */
async function judgeThroughReversed(ws: Workspace, moves: SessionMove[], k: number): Promise<{ state: Exclude<MoveState, 'neither'>; move: SessionMove; reversedFrom: number }> {
  let move = moves[k]
  for (let j = k; ; j--) {
    judged(ws, move.from, move.kind)
    judged(ws, move.to, move.kind)
    const state = await moveState(ws, move)
    if (state !== 'neither') return { state, move, reversedFrom: j }
    if (j === 0) throw neitherThere(moves[k])
    move = { ...move, from: before(move.from, moves[j - 1]), to: before(move.to, moves[j - 1]) }
  }
}

export type InterruptedUndo = { restored: string[]; moved: SessionMove[]; refused: Array<{ path: string; reason: string }> }

/**
 * Undo an interrupted change through `session` by the rule at the top of this file. Every path is
 * judged before anything is read or written. Returns what was restored and moved back, and each file
 * refused with the reason; the caller keeps the intent on record while anything is refused.
 */
export async function undoInterrupted(entry: Interrupted, ws: Workspace, session: WriteSession): Promise<InterruptedUndo> {
  for (const file of entry.files) judged(ws, file.path, 'file')
  for (const move of entry.moves) {
    judged(ws, move.from, move.kind)
    judged(ws, move.to, move.kind)
  }
  // The kill came at one moment, so the moves that happened are the first few. Walk back from the last.
  let happened = entry.moves.length
  /** The first of the moves some later move was judged as if reversed: none from there on may be found standing. */
  let reversedFrom = entry.moves.length
  let assumedBy = -1
  const twoNames: SessionMove[] = []
  while (happened > 0) {
    const k = happened - 1
    const judgedMove = await judgeThroughReversed(ws, entry.moves, k)
    if (judgedMove.state === 'happened') {
      // Standing, though found only by taking an earlier move as reversed: the disk agrees with no moment of the change.
      if (judgedMove.reversedFrom < k) throw neitherThere(entry.moves[k])
      break
    }
    if (judgedMove.state === 'two-names') twoNames.push(judgedMove.move)
    if (judgedMove.reversedFrom < reversedFrom) [reversedFrom, assumedBy] = [judgedMove.reversedFrom, k]
    happened -= 1
  }
  // A move taken as reversed to judge a later one must be reversed.
  if (happened > reversedFrom) throw neitherThere(entry.moves[assumedBy])
  /** Where a file recorded at its final path is now, given that only the first `happened` moves took place. */
  const now = (path: string): string => {
    let current = path
    for (const move of entry.moves.slice(happened).reverse()) {
      if (current === move.to || current.startsWith(`${move.to}/`)) current = `${move.from}${current.slice(move.to.length)}`
    }
    return current
  }
  const located = entry.files.map((file) => ({ path: now(file.path), before: Buffer.from(file.before, 'base64'), wrote: file.wrote }))
  for (const file of located) judged(ws, file.path, 'file')

  const result: InterruptedUndo = { restored: [], moved: [], refused: [] }
  for (const move of twoNames) await session.dropSecondName(move.to, move.from)
  for (const file of located) {
    if (!(await lstat(ws.absolute(file.path)).catch(() => null))) {
      result.refused.push({ path: file.path, reason: 'is no longer there' })
      continue
    }
    const current = fingerprint(await readBytes(ws, file.path))
    if (current === fingerprint(file.before)) continue
    // Checked here, and again by the write itself, on the file's handle, immediately before the rename.
    if (!file.wrote.includes(current) || await session.restore(file.path, file.before, current) === 'changed') {
      result.refused.push({ path: file.path, reason: 'has changed since the command line wrote it' })
      continue
    }
    result.restored.push(file.path)
  }
  for (const move of entry.moves.slice(0, happened).reverse()) {
    if (move.from.toLowerCase() !== move.to.toLowerCase() && await lstat(ws.absolute(move.from)).catch(() => null)) {
      result.refused.push({ path: move.to, reason: `cannot be moved back: ${move.from} exists again` })
      continue
    }
    if (!(await isTheFolderMoved(ws, move))) {
      result.refused.push({ path: move.to, reason: NOT_THE_FOLDER_MOVED })
      continue
    }
    await session.move(move.to, move.from, move.kind)
    result.moved.push({ from: move.to, to: move.from, kind: move.kind })
    const back = (path: string): string => (path === move.to || path.startsWith(`${move.to}/`) ? `${move.from}${path.slice(move.to.length)}` : path)
    result.restored = result.restored.map(back)
    result.refused = result.refused.map((refusal) => ({ ...refusal, path: back(refusal.path) }))
  }
  return result
}
