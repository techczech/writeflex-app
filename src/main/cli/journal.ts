/**
 * The command line's undo journal (specification section 4): one file per direct change, holding the
 * paths that moved and, for every existing file the change touched, its content before and a
 * fingerprint of its content after.
 *
 * WHERE IT IS. An entry's `before` is written back into a document by undo, so the journal is kept
 * where nothing that can only write or sync the Collection can reach it: in application data
 * (collection-records.ts). Nothing inside a Collection is ever read as a journal entry. Undo therefore
 * covers the changes made on this Mac only.
 *
 * TWO JOURNALS, ONE PER ROUTE. The command line writing directly keeps its journal in
 * `command-line-undo`, the one folder its process writes (and the one a sandbox is told to allow). The
 * app carrying out a request keeps its own in `app-undo`, among its records, which the command line's
 * process never writes. A journal of one route never reads the other's folder, so each route undoes
 * only its own changes: an undo REQUEST makes the app act on nothing but entries the app wrote. An
 * agent allowed to write `command-line-undo` can forge an entry there, and a direct undo would act
 * on it, inside document paths only; that agent could write those documents itself. It cannot make
 * the app act on one. `undo --list` reads both and says which is which.
 *
 * It is WRITTEN to this process's own variant's folder (`place.own`) and nowhere else, and READ from
 * the other variant's too. So an entry made by one variant and undone by the other is marked undone
 * by a copy of the entry, with its `undoneAt`, in the undoer's own folder; of two files with one id
 * the undone one stands, and a finished entry stands over an intent.
 *
 * An entry is written whole to a temporary name and renamed into place. It is still treated as DATA:
 * undo judges every path in it with the Workspace's document-path rule before it acts, and acts only
 * through the WriteSession, which judges each path again at the write.
 *
 * UNDO IS ITSELF ANNOUNCED. Before undo changes anything it leaves an intent naming the entry it is
 * undoing (journal-intent.ts). If the process is killed partway, the next `writeflex undo` finds that
 * intent and finishes file by file, by the interrupted-change rule: a file already put back is left,
 * a file still holding what the command line wrote is put back, anything else is refused by name.
 *
 * A FOLDER MOVE RECORDS WHICH FOLDER MOVED (its device and inode; write-session.ts). Undo moves a
 * folder back only if the folder at the new name is that one. Files edited inside it after the move
 * go back with their edits; a folder put at the name since is refused and left where it is.
 *
 * NO ENTRY LARGER THAN THE LIMIT. A change whose entry would not fit is refused before the file that
 * would take it over the limit is touched (the intent counts as it goes), so no change is ever left
 * with a record undo cannot read.
 */
import { randomBytes } from 'node:crypto'
import { lstat, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { assertCollectionWritable } from '../collection-write-gate'
import { APP_UNDO_KIND, AppDataNotWritableError, JOURNAL_KIND, RecordsNotUsableError, asNotWritable, recordsFolder, type RecordKind, type RecordsPlace } from '../collection-records'
import type { PathKind } from '../document-path'
import { MANIFEST_NAME } from '../../shared/folio-constants'
import type { Workspace } from '../workspace'
import { readBytes } from './guarded-fs'
import { CliError } from './operation'
import { INTENT_SUFFIX, IntentLog, changeTooLarge, parseIdentity, parseIntent, type Interrupted, type PlannedRecord } from './journal-intent'
import { NOT_THE_FOLDER_MOVED, fingerprint, isTheFolderMoved, type SessionFile, type SessionMove, type WriteSession } from './write-session'

/** @internal Test seams; production passes nothing. */
export type JournalSeams = {
  /** After an undo's last change to the Collection, before the entry is marked undone: where a kill leaves an undo that did everything and is not on record as done. */
  beforeMarkUndone?: () => Promise<void>
}

export const JOURNAL_KEEP_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024
/** A temporary file a killed write left in the journal folder is removed once it is this old. */
const STALE_TEMPORARY_MS = 10 * 60_000
const TEMPORARY_NAME = /^\d{8}T\d{9}Z-[0-9a-f]{8}\.[0-9a-f]{8}\.tmp$/
const ENTRY_NAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-[0-9a-f]{8}(\.json|\.intent\.jsonl)$/
const MARKDOWN = /\.(?:md|markdown|mdx)$/i

export type JournalEntry = {
  version: 1
  /** Also the file's name without `.json`; begins with the time of the change, so names sort by age. */
  id: string
  at: string
  operation: string
  summary: string
  /** In the order made. */
  moves: SessionMove[]
  /** Each file at its path AFTER the moves: content before (base64) and a SHA-256 of content after. */
  files: Array<{ path: string; before: string; after: string; wrote?: string[] }>
  undoneAt?: string
  /** The change did not finish (journal-intent.ts): read from its intent, or an intent since undone.
   *  Each file then carries `wrote`, every fingerprint the command line was about to write to it, and
   *  `path` and `moves` say what was INTENDED, not what is known to have happened. */
  interrupted?: true
  /** Never stored: the ids of the intents of undos of this entry that did not finish. While there is
   *  one, the entry is undone file by file, as an interrupted change is. */
  undoStopped?: string[]
}

/** Who made a change, and so whose journal holds it and who can undo it. */
export type JournalRoute = 'command-line' | 'app'

/** What went wrong with application data, in the command line's words and with its code (outcome.ts). */
export function recordsRefusal(error: unknown, route: JournalRoute = 'command-line'): unknown {
  if (error instanceof AppDataNotWritableError && route === 'app') {
    return new CliError(`WriteFlex could not write its undo record in its own application data (${error.errno}: ${error.allow}), so nothing was changed.`, 'failed')
  }
  if (error instanceof AppDataNotWritableError) {
    return new CliError(
      `The command line could not write its undo record, so nothing was changed. The record is kept outside the Collection, in WriteFlex's application data, which it is not allowed to write (${error.errno}). `
      + `If it runs in a sandbox, allow writing to this folder: ${error.allow} . Opening the Collection in WriteFlex also works: WriteFlex then does the writing, and the command line needs to write nothing there.`,
      'refused', 'app-data-not-writable',
    )
  }
  if (error instanceof RecordsNotUsableError) return new CliError(`${error.message.replace(/, so it is not used\.$/, '')}, so the undo journal cannot be used.`)
  return error
}

const isText = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max

/** A well-formed entry, or null. Shape only: whether its paths may be acted on is undo's question. */
function parseEntry(text: string, id: string): JournalEntry | null {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  if (entry.version !== 1 || entry.id !== id || !isText(entry.at) || !isText(entry.operation) || !isText(entry.summary)) return null
  if (!Array.isArray(entry.moves) || !Array.isArray(entry.files)) return null
  if (entry.undoneAt !== undefined && !isText(entry.undoneAt)) return null
  if (entry.interrupted !== undefined && entry.interrupted !== true) return null
  const moves: SessionMove[] = []
  for (const move of entry.moves as Array<Record<string, unknown> | null>) {
    if (!move || !isText(move.from) || !isText(move.to) || (move.kind !== 'file' && move.kind !== 'folder')) return null
    const identity = parseIdentity(move)
    if (identity === null) return null
    moves.push({ from: move.from, to: move.to, kind: move.kind, ...identity })
  }
  const files: JournalEntry['files'] = []
  for (const file of entry.files as Array<Record<string, unknown> | null>) {
    if (!file || !isText(file.path) || typeof file.before !== 'string' || !isText(file.after) || !/^[0-9a-f]{64}$/.test(file.after)) return null
    const wrote = file.wrote
    if (wrote !== undefined && !(Array.isArray(wrote) && wrote.every((print) => typeof print === 'string' && /^[0-9a-f]{64}$/.test(print)))) return null
    files.push({ path: file.path, before: file.before, after: file.after, ...(wrote === undefined ? {} : { wrote: wrote as string[] }) })
  }
  return {
    version: 1, id, at: entry.at, operation: entry.operation, summary: entry.summary, moves, files,
    ...(entry.undoneAt === undefined ? {} : { undoneAt: entry.undoneAt }),
    ...(entry.interrupted === true ? { interrupted: true as const } : {}),
  }
}

const idOf = (name: string): string => name.replace(/\.json$|\.intent\.jsonl$/, '')

/** When the change named by a journal file name was made, from the name alone. */
function timeOf(name: string): number | null {
  const m = ENTRY_NAME.exec(name)
  if (!m) return null
  const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${m[7]}Z`)
  return Number.isNaN(at) ? null : at
}

/** Each route undoes its own changes; the refusals say where the other route's are undone. */
const NOTHING: Record<JournalRoute, string> = {
  'command-line': 'There is nothing to undo: the command line has no direct change on record for this Collection on this Mac. A change WriteFlex made on request is undone with the Collection open in WriteFlex; "writeflex undo --list" shows both kinds.',
  app: 'There is nothing to undo here: WriteFlex has no change it made on request on record for this Collection on this Mac. A change the command line made directly is undone with the Collection closed in WriteFlex; "writeflex undo --list" shows both kinds.',
}
const NOT_HERE: Record<JournalRoute, string> = {
  'command-line': 'among the changes the command line made directly. Run "writeflex undo --list" to see them; one marked as made by WriteFlex on request is undone with the Collection open in WriteFlex.',
  app: 'among the changes WriteFlex made on request. Run "writeflex undo --list" to see them; one marked as made by the command line directly is undone with the Collection closed in WriteFlex.',
}

export class Journal {
  readonly #now: () => Date
  readonly #max: number
  /** The intent of the operation this journal was last asked to begin. */
  #current: IntentLog | undefined

  readonly route: JournalRoute
  readonly #kind: RecordKind

  /** `route` says whose journal this is (default the command line's own): it reads and writes that route's folder and no other. */
  readonly #seams: JournalSeams

  constructor(private readonly root: string, private readonly place: RecordsPlace, options: { now?: () => Date; maxEntryBytes?: number; route?: JournalRoute; seams?: JournalSeams } = {}) {
    this.#seams = options.seams ?? {}
    this.#now = options.now ?? (() => new Date())
    this.#max = options.maxEntryBytes ?? MAX_ENTRY_BYTES
    this.route = options.route ?? 'command-line'
    this.#kind = this.route === 'app' ? APP_UNDO_KIND : JOURNAL_KIND
  }

  #refusal(error: unknown): unknown {
    return recordsRefusal(asNotWritable(error, this.place.own, this.#kind), this.route)
  }

  /** This process's own journal folder, or null when there is none and `create` is false. */
  async #folder(create: boolean): Promise<string | null> {
    try {
      return await recordsFolder(this.place.own, this.root, this.#kind, create)
    } catch (error) {
      throw this.#refusal(error)
    }
  }

  /** Every journal folder there is to read: this process's own first, then the other variants' that are usable. */
  async #folders(): Promise<string[]> {
    const folders: string[] = []
    const own = await this.#folder(false)
    if (own) folders.push(own)
    for (const appData of this.place.others) {
      const other = await recordsFolder(appData, this.root, this.#kind, false).catch(() => null)
      if (other) folders.push(other)
    }
    return folders
  }

  async #write(folder: string, entry: JournalEntry): Promise<void> {
    assertCollectionWritable(this.root)
    const { undoStopped: _never, ...stored } = entry
    const text = `${JSON.stringify(stored)}\n`
    if (Buffer.byteLength(text) > this.#max) throw changeTooLarge(this.#max)
    const staged = join(folder, `${entry.id}.${randomBytes(4).toString('hex')}.tmp`)
    try {
      const handle = await open(staged, 'wx', 0o600)
      try {
        await handle.writeFile(text)
        await handle.sync().catch(() => {})
      } finally {
        await handle.close()
      }
      await rename(staged, join(folder, `${entry.id}.json`))
    } catch (error) {
      await unlink(staged).catch(() => {})
      throw this.#refusal(error)
    }
  }

  /** Remove this process's own entries older than 30 days, judged by the time in the file's name, and
   *  the temporary files a killed write left. Returns the ids removed. */
  async prune(): Promise<string[]> {
    const folder = await this.#folder(false)
    if (!folder) return []
    const removed: string[] = []
    for (const name of await readdir(folder)) {
      if (TEMPORARY_NAME.test(name)) {
        const info = await lstat(join(folder, name)).catch(() => null)
        if (info?.isFile() && this.#now().getTime() - info.mtimeMs > STALE_TEMPORARY_MS) await unlink(join(folder, name)).catch(() => {})
        continue
      }
      const at = timeOf(name)
      // A name that is not an entry's (a stray file) is never touched.
      if (at === null || this.#now().getTime() - at <= JOURNAL_KEEP_MS) continue
      if (!(await lstat(join(folder, name)).catch(() => null))?.isFile()) continue
      await unlink(join(folder, name)).catch(() => {})
      removed.push(idOf(name))
    }
    return removed
  }

  /** The write-ahead record for one operation about to start (journal-intent.ts). Writes nothing yet. */
  begin(operation: string): IntentLog {
    const at = this.#now()
    this.#current = new IntentLog(
      `${at.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`, this.root,
      { at: at.toISOString(), operation }, async () => (await this.#folder(true))!,
      { maxBytes: this.#max, refusal: async (error) => this.#refusal(error) },
    )
    return this.#current
  }

  /**
   * Refuse, before anything is changed, an operation whose finished record would be over the entry
   * limit: `planned` is everything it is about to record (journal-intent.ts `IntentLog.budget`).
   * The intent still counts as it grows, as the second defence.
   */
  budget(planned: PlannedRecord): void {
    this.#current?.budget(planned)
  }

  /** The operation begun is an undo of `entry`: its intent says so, and holds nothing else (journal-intent.ts). */
  undoing(entry: JournalEntry): void {
    this.#current?.undoes(entry.id)
  }

  /**
   * The undo begun put back part of `entry` and refused the rest. Its intent is kept, so the next undo
   * of the entry goes file by file again; the intents of earlier undos of it are then of no further use.
   */
  async keepUndoIntent(entry: JournalEntry): Promise<void> {
    if (!this.#current?.started) return
    this.#current.keep()
    const folder = await this.#folder(false)
    for (const id of entry.undoStopped ?? []) if (folder && id !== this.#current.id) await unlink(join(folder, `${id}${INTENT_SUFFIX}`)).catch(() => {})
  }

  /** Remove an intent whose operation changed nothing in the end (it failed and was put back). */
  async abandon(intent: IntentLog): Promise<void> {
    if (!intent.started || intent.kept) return
    const folder = await this.#folder(false)
    if (folder) await unlink(join(folder, `${intent.id}${INTENT_SUFFIX}`)).catch(() => {})
  }

  /** Record one finished change (pruning old entries first) and return its entry. Given the
   *  operation's `intent`, the entry takes its id and the intent is removed once the entry is in place. */
  async record(operation: string, summary: string, change: { moves: SessionMove[]; files: SessionFile[] }, intent?: IntentLog): Promise<JournalEntry> {
    const folder = (await this.#folder(true))!
    await this.prune()
    const at = this.#now()
    const entry: JournalEntry = {
      version: 1,
      id: intent?.started ? intent.id : `${at.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`,
      at: at.toISOString(), operation, summary,
      moves: change.moves,
      files: change.files.map((file) => ({ path: file.path, before: file.before.toString('base64'), after: file.after })),
    }
    await this.#write(folder, entry)
    if (intent?.started) await unlink(join(folder, `${entry.id}${INTENT_SUFFIX}`)).catch(() => {})
    return entry
  }

  /** Every readable entry, newest first, an intent with no finished entry among them as an
   *  `interrupted` one. `unreadable` names the files that are not well-formed entries. */
  async list(): Promise<{ entries: JournalEntry[]; unreadable: string[] }> {
    /** id -> the folders holding its entry file, and those holding its intent. */
    const found = new Map<string, { entries: string[]; intents: string[] }>()
    for (const folder of await this.#folders()) {
      for (const name of await readdir(folder).catch(() => [] as string[])) {
        if (!ENTRY_NAME.test(name)) continue
        const at = found.get(idOf(name)) ?? { entries: [], intents: [] }
        ;(name.endsWith(INTENT_SUFFIX) ? at.intents : at.entries).push(folder)
        found.set(idOf(name), at)
      }
    }
    const read = async (folder: string, name: string): Promise<string> => {
      const info = await lstat(join(folder, name)).catch(() => null)
      return info?.isFile() && info.size <= this.#max ? readFile(join(folder, name), 'utf8').catch(() => '') : ''
    }
    const entries: JournalEntry[] = []
    const unreadable: string[] = []
    /** The entry an unfinished undo was undoing -> the ids of those undos' intents. */
    const stopped = new Map<string, string[]>()
    for (const id of [...found.keys()].sort().reverse()) {
      const at = found.get(id)!
      if (at.entries.length > 0) {
        // The entry was written and the process stopped before removing the intent: the entry stands.
        // Of an entry and its undone copy in the other variant's folder, the undone one stands.
        const parsed: JournalEntry[] = []
        for (const folder of at.entries) {
          const entry = parseEntry(await read(folder, `${id}.json`), id)
          if (entry) parsed.push(entry)
        }
        const entry = parsed.find((candidate) => candidate.undoneAt) ?? parsed[0]
        if (entry) entries.push(entry)
        else unreadable.push(`${id}.json`)
        continue
      }
      const intent = parseIntent(await read(at.intents[0], `${id}${INTENT_SUFFIX}`), id)
      if (!intent) unreadable.push(`${id}${INTENT_SUFFIX}`)
      // An undo's intent is never an entry: it marks the entry it was undoing (below).
      else if (intent.undoes !== undefined) stopped.set(intent.undoes, [...(stopped.get(intent.undoes) ?? []), id])
      else entries.push(interruptedEntry(intent))
    }
    // An unfinished undo of an entry since undone, or no longer on record, means nothing.
    for (const entry of entries) {
      const undos = stopped.get(entry.id)
      if (undos && !entry.undoneAt) entry.undoStopped = undos
    }
    return { entries, unreadable }
  }

  /** The entry with this id, or the most recent one not yet undone. */
  async find(id?: string): Promise<JournalEntry> {
    const { entries } = await this.list()
    if (id === undefined) {
      const latest = entries.find((entry) => !entry.undoneAt)
      if (!latest) throw new CliError(NOTHING[this.route])
      return latest
    }
    const entry = entries.find((candidate) => candidate.id === id)
    if (!entry) throw new CliError(`No journal entry ${id} ${NOT_HERE[this.route]}`)
    if (entry.undoneAt) throw new CliError(`Journal entry ${id} was already undone.`)
    return entry
  }

  async markUndone(entry: JournalEntry): Promise<void> {
    await this.#seams.beforeMarkUndone?.()
    const folder = (await this.#folder(true))!
    await this.#write(folder, { ...entry, undoneAt: this.#now().toISOString() })
    const intents = [...(entry.interrupted ? [entry.id] : []), ...(entry.undoStopped ?? []), ...(this.#current?.started ? [this.#current.id] : [])]
    for (const id of intents) await unlink(join(folder, `${id}${INTENT_SUFFIX}`)).catch(() => {})
  }
}

/** An intent in the shape of an entry, so that listing and finding treat both alike. */
function interruptedEntry(intent: Interrupted): JournalEntry {
  return {
    version: 1, id: intent.id, at: intent.at, operation: intent.operation, interrupted: true,
    summary: `Interrupted ${intent.operation}: it stopped before it finished (${intent.files.length} file${intent.files.length === 1 ? '' : 's'} on record)`,
    moves: intent.moves,
    files: intent.files.map((file) => ({ path: file.path, before: file.before, after: file.wrote[file.wrote.length - 1], wrote: file.wrote })),
  }
}

/** The path as the journal may name it: canonical, a document path, and (for a file) a kind undo restores. */
function judged(ws: Workspace, path: string, kind: PathKind): void {
  const refuse = (): never => {
    throw new CliError(`Undo refused: the journal entry names ${JSON.stringify(path)}, which is not a ${kind === 'file' ? 'document' : 'folder'} in this Collection. Nothing was changed.`)
  }
  if (path === '' || path.includes('\\') || posix.normalize(path) !== path || path.startsWith('/') || path.endsWith('/')) refuse()
  if (ws.classifyPath(path, kind) !== 'document') refuse()
  if (kind === 'file' && !MARKDOWN.test(path) && posix.basename(path) !== MANIFEST_NAME) refuse()
}

/**
 * Undo one journal entry through `session`: every path judged first, then every fingerprint checked,
 * and only then content restored and paths moved back. Refuses, naming the file, when a file no
 * longer holds what the command line wrote. Returns the files restored and the moves reversed.
 */
export async function undoEntry(entry: JournalEntry, ws: Workspace, session: WriteSession): Promise<{ restored: string[]; moved: SessionMove[] }> {
  if (entry.interrupted) throw new CliError(`Journal entry ${entry.id} did not finish; it is undone file by file (journal-intent.ts).`, 'failed')
  for (const file of entry.files) judged(ws, file.path, 'file')
  for (const move of entry.moves) {
    judged(ws, move.from, move.kind)
    judged(ws, move.to, move.kind)
  }
  const exists = async (path: string): Promise<boolean> => (await lstat(ws.absolute(path)).catch(() => null)) !== null
  for (const move of entry.moves) {
    if (!(await exists(move.to))) throw new CliError(`Undo refused: ${move.to} is no longer there.`)
    if (await exists(move.from) && move.from.toLowerCase() !== move.to.toLowerCase()) throw new CliError(`Undo refused: ${move.from} exists again, so ${move.to} cannot be moved back.`)
    // A folder's contents are not on record, so the folder itself must be the one that was moved.
    if (!(await isTheFolderMoved(ws, move))) throw new CliError(`Undo refused: ${move.to} ${NOT_THE_FOLDER_MOVED}. Nothing was changed.`)
  }
  const files = entry.files.map((file) => ({ path: file.path, before: Buffer.from(file.before, 'base64'), after: file.after }))
  for (const file of files) {
    if (!(await exists(file.path))) throw new CliError(`Undo refused: ${file.path} is no longer there.`)
    if (fingerprint(await readBytes(ws, file.path)) !== file.after) {
      throw new CliError(`Undo refused: ${file.path} has changed since the command line wrote it. Nothing was changed.`)
    }
  }
  const restored: string[] = []
  for (const file of files) {
    if (fingerprint(file.before) === file.after) continue
    // The check above is made again by the write itself, on the file's handle, immediately before the rename.
    if (await session.restore(file.path, file.before, file.after) === 'changed') {
      throw new CliError(`Undo refused: ${file.path} has changed since the command line wrote it. Nothing was changed.`)
    }
    restored.push(file.path)
  }
  const moved: SessionMove[] = []
  for (const move of [...entry.moves].reverse()) {
    await session.move(move.to, move.from, move.kind)
    moved.push({ from: move.to, to: move.from, kind: move.kind })
    // Report each restored file where it is now, after the move back.
    restored.forEach((path, i) => {
      if (path === move.to || path.startsWith(`${move.to}/`)) restored[i] = `${move.from}${path.slice(move.to.length)}`
    })
  }
  return { restored, moved }
}
