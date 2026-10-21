/**
 * One direct change to a Collection, as the command line makes it. A WriteSession is the only route by
 * which a write operation touches the Collection: before each file it confirms the owner lock is
 * still held, it remembers what every existing file held and every path that moved, and it can put
 * all of that back (`rollback`) or hand it to the journal (`record`).
 *
 * PUTTING BACK IS A WRITE LIKE ANY OTHER. `rollback` asks for the owner lock before it does anything
 * and again before each thing it writes; once the lock is another's it writes nothing, and says so.
 * It restores a file only when the file holds exactly what this session wrote to it: a file somebody
 * has written since is theirs, and is left and named. This is the interrupted-change rule
 * (journal-intent.ts), which is what finishes the job later from the intent that is then kept.
 *
 * WritingWorkspace is the Workspace the app's own writers (rename repair, agent notes) are given, so
 * that their saves go through the session and nothing writes by another route.
 */
import { rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'
import type { PathKind } from '../document-path'
import { fingerprintOf } from '../guarded-document-read'
import { ChangedSinceRead, DiskChangedUnderBuffer, NameTaken, SaveWithoutBasis, type EditorSaveResult, type FileReadResult, type SaveFileOptions, type SavedFileResult, type Workspace } from '../workspace'
import { basisAllows, isSaveBasis, type SaveBasis } from '../../shared/save-basis'
import { CommandLineWorkspace } from './guarded-workspace'
import { ChangedSinceChecked, dropSecondName, folderIdentity, makeFolders, movePath, readBytes, realPathForTrash, writeWhole, type WriteSeams } from './guarded-fs'
import { CliError } from './operation'
import { markdownPath } from './paths'

/** The fingerprint of a file's bytes (one definition: guarded-document-read.ts). */
export const fingerprint = fingerprintOf

/**
 * A path that moved. A FOLDER move also records which folder it was (`dev` and `ino`, which a rename
 * keeps): undo moves a folder back only if the folder at the new name is that one. A folder's contents
 * are not recorded, so nothing else could tell a folder put there since from the one that was moved.
 */
export type SessionMove = { from: string; to: string; kind: PathKind; dev?: number; ino?: number }
/** An existing file this session changed or moved: where it is now, what it held, what it holds. */
export type SessionFile = { path: string; before: Buffer; after: string }

/** One thing a session did to the Collection, in the order done: what a stopped operation tells the writer. */
export type SessionStep =
  | { did: 'created' | 'rewrote' | 'made-folder' | 'trashed' | 'removed-second-name'; path: string }
  | { did: 'moved'; path: string; to: string }

/** What `rollback` came to. */
export type Rollback = {
  /** What could not be put back, each with its reason. */
  problems: string[]
  /** Set when the Collection was no longer this owner's: the refusal. From that moment nothing was written. */
  lost?: unknown
}

export type SessionOptions = {
  /** Throws when this process no longer holds the Collection's owner lock. */
  confirmOwner: () => Promise<void>
  /** Asked instead of `confirmOwner` before `rollback` writes, by a caller whose `confirmOwner` also
   *  refuses for a reason other than ownership (the app's executor, once disposed, still holds the
   *  Collection while it puts back). Default: `confirmOwner`. */
  confirmRollback?: () => Promise<void>
  seams?: WriteSeams
  /** Told, and waited for, BEFORE each existing file is rewritten and each path moved, so that a
   *  process killed partway leaves on disk what is needed to undo it (journal-intent.ts). */
  intent?: {
    /** Put the record on disk before anything at all is done towards changing an existing path. */
    start?: () => Promise<void>
    file: (path: string, before: Uint8Array | null, wrote: string) => Promise<void>
    move: (move: SessionMove) => Promise<void>
  }
  /** Told the path of everything about to be written, moved or trashed (the app records its own writes). */
  onWrite?: (path: string) => void
  /** Told a non-fatal notice about a write that succeeded: a new file whose temporary second name could not be
   *  removed (guarded-document-write.ts `leftover`). The app passes its window's notice; the default, for the
   *  command line, is a `writeflex: note:` line on stderr. A notice that throws never changes the write's outcome. */
  onNotice?: (message: string) => void
}

/** The command line's notice: a line on stderr, as its other notes are (run.ts). */
const noteOnStderr = (message: string): void => { process.stderr.write(`writeflex: note: ${message}\n`) }

/** The folder a recorded move moved, when the record says (a folder move made by this build or later). */
export const identityOf = (move: SessionMove): { dev: number; ino: number } | undefined =>
  (move.kind === 'folder' && move.dev !== undefined && move.ino !== undefined ? { dev: move.dev, ino: move.ino } : undefined)

/** Why a folder move is not undone when the folder at its new name is not the one that was moved. */
export const NOT_THE_FOLDER_MOVED = 'is not the folder that was moved there: another folder stands at that name now'

/** Whether the folder standing at `move.to` is the one `move` moved. True for a file move and for a record with no identity. */
export async function isTheFolderMoved(ws: Workspace, move: SessionMove): Promise<boolean> {
  const recorded = identityOf(move)
  if (!recorded) return true
  const standing = await folderIdentity(ws, move.to).catch(() => null)
  return !!standing && standing.dev === recorded.dev && standing.ino === recorded.ino
}

const under = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`)

export class WriteSession {
  readonly #moves: SessionMove[] = []
  /** Keyed by the file's CURRENT path, so a later move in the same session carries its record along. */
  #files = new Map<string, { before: Buffer; after: string }>()
  readonly #madeFolders: string[] = []
  /** The files this session created, each with the fingerprint of what it last wrote there. */
  readonly #created = new Map<string, string>()
  readonly #steps: SessionStep[] = []
  /** The first failure of a write, kept because callers that roll back themselves wrap or replace it. */
  firstFailure: unknown
  /** The path the session was about to write, move or trash when `firstFailure` stopped it. */
  stoppedAt: string | undefined

  constructor(private readonly ws: Workspace, private readonly options: SessionOptions) {}

  /** `excused`: a refusal the caller handles itself, so it is not this session's failure. */
  async #guard<T>(path: string, act: (seams: WriteSeams) => Promise<T>, excused?: (error: unknown) => boolean): Promise<T> {
    try {
      await this.options.seams?.beforeWrite?.(path)
      await this.options.confirmOwner()
      this.options.onWrite?.(path)
      return await act(this.options.seams ?? {})
    } catch (error) {
      if (!excused?.(error)) this.#failed(path, error)
      throw error
    }
  }

  #failed(path: string, error: unknown): void {
    if (this.firstFailure === undefined) this.stoppedAt = path
    this.firstFailure ??= error
  }

  /**
   * A file another program made for this operation (scout's capture): told to the app's own-write record and to
   * whoever lists touched paths. It is not a step, so a rollback never deletes it: undo never deletes a new file.
   */
  noteWritten(path: string): void {
    this.options.onWrite?.(path)
  }

  /** Throws (the session's own refusal) when this process no longer holds the Collection's owner lock. */
  async assertOwned(path: string): Promise<void> {
    try {
      await this.options.seams?.beforeWrite?.(path)
      await this.options.confirmOwner()
    } catch (error) {
      this.#failed(path, error)
      throw error
    }
  }

  /** Everything done to the Collection so far and not yet settled, in order. */
  get steps(): SessionStep[] {
    return [...this.#steps]
  }

  /** Whether an existing file was changed or a path moved: what the journal records. */
  get changedExisting(): boolean {
    return this.#moves.length > 0 || this.#files.size > 0
  }

  async folders(path: string): Promise<void> {
    if (path === '' || path === '.') return
    await this.#guard(path, async () => {
      const made = await makeFolders(this.ws, path)
      this.#madeFolders.push(...made)
      this.#steps.push(...made.map((folder) => ({ did: 'made-folder' as const, path: folder })))
    })
  }

  /** Write a new file; its folder is made if missing. Refuses a name that is taken. */
  async create(path: string, content: string | Uint8Array): Promise<void> {
    await this.folders(posix.dirname(path))
    await this.#guard(path, async (seams) => {
      const { leftover } = await writeWhole(this.ws, path, content, 'create', seams)
      this.#created.set(path, fingerprint(content))
      this.#steps.push({ did: 'created', path })
      // Created; only a create can leave a second name (a rewrite commits by rename). Said, never thrown.
      if (leftover) {
        try { (this.options.onNotice ?? noteOnStderr)(leftover) } catch { /* telling must not change a committed write */ }
      }
    })
  }

  /**
   * Write other text to a file THIS session created, and only while it still holds exactly what the
   * session wrote there. Not recorded for undo, as the creation was not: undo never covers a new file.
   */
  async rewriteCreated(path: string, content: string | Uint8Array): Promise<void> {
    const wrote = this.#created.get(path)
    if (wrote === undefined) throw new CliError(`${path} was not created by this operation, so it is not rewritten this way.`, 'failed')
    await this.#guard(path, async (seams) => {
      await writeWhole(this.ws, path, content, 'replace', seams, { fingerprint: wrote })
      this.#created.set(path, fingerprint(content))
    })
  }

  /**
   * Rewrite an existing file whole, remembering what it held the first time it is touched. With
   * `expect`, the fingerprint of the bytes the caller checked or worked `content` out from, the file
   * is compared on its handle immediately before the rename (guarded-document-write.ts), and nothing
   * is written (`ChangedSinceChecked`) when it holds anything else by then.
   */
  async replace(path: string, content: string | Uint8Array, expect?: { fingerprint: string }): Promise<void> {
    await this.#rewrite(path, content, expect)
  }

  /**
   * Undo's rewrite: put `content` back at `path` only if the file still holds the bytes of `expected`,
   * the fingerprint undo checked, at the moment of the rename. Says `changed`, having written nothing,
   * when somebody wrote the file since; that is the caller's to report and not a failure of the session.
   */
  async restore(path: string, content: string | Uint8Array, expected: string): Promise<'restored' | 'changed'> {
    try {
      await this.#rewrite(path, content, { fingerprint: expected }, (error) => error instanceof ChangedSinceChecked)
      return 'restored'
    } catch (error) {
      if (error instanceof ChangedSinceChecked) return 'changed'
      throw error
    }
  }

  async #rewrite(path: string, content: string | Uint8Array, expect: { fingerprint: string } | undefined, excused?: (error: unknown) => boolean): Promise<void> {
    await this.#guard(path, async (seams) => {
      const known = this.#files.get(path)?.before
      const before = known ?? await readBytes(this.ws, path)
      await this.options.intent?.file(path, known ? null : before, fingerprint(content))
      await writeWhole(this.ws, path, content, 'replace', seams, expect)
      this.#files.set(path, { before, after: fingerprint(content) })
      this.#steps.push({ did: 'rewrote', path })
    }, excused)
  }

  /**
   * Move a file or folder to a free name; the folder above the new name is made if missing. All that
   * the record needs is on disk before anything is made for the move, that folder included: a move that
   * cannot be recorded (application data not writable, a record over the limit) changes nothing at all.
   */
  async move(from: string, to: string, kind: PathKind): Promise<void> {
    let bytes: Buffer | null = null
    try {
      await this.options.intent?.start?.()
      bytes = kind === 'file' && !this.#files.has(from) ? await readBytes(this.ws, from) : null
      if (bytes) await this.options.intent?.file(from, bytes, fingerprint(bytes))
    } catch (error) {
      this.#failed(from, error)
      throw error
    }
    await this.folders(posix.dirname(to))
    await this.#guard(from, async (seams) => {
      // Which folder this is, on record before it moves; the move then refuses any other folder at the name.
      const identity = kind === 'folder' ? await folderIdentity(this.ws, from) : null
      const move: SessionMove = { from, to, kind, ...(identity ?? {}) }
      await this.options.intent?.move(move)
      this.options.onWrite?.(to)
      await movePath(this.ws, from, to, kind, seams, identity ?? undefined)
      this.#moves.push(move)
      this.#steps.push({ did: 'moved', path: from, to })
      if (bytes) this.#files.set(from, { before: bytes, after: fingerprint(bytes) })
      this.#files = new Map([...this.#files].map(([path, record]) => [under(path, from) ? `${to}${path.slice(from.length)}` : path, record]))
    })
  }

  /** Hand an existing file or folder to the Trash mover. Not recorded: the Trash is its own undo. */
  async trash(path: string, kind: PathKind, mover: (absolute: string) => Promise<void>): Promise<void> {
    await this.#guard(path, async (seams) => {
      await mover(await realPathForTrash(this.ws, path, kind, seams))
      this.#steps.push({ did: 'trashed', path })
    })
  }

  /** Remove `extra`, a second name of the very file at `kept`: what a file move leaves when it is
   *  stopped between making the new name and removing the old. Nothing is lost; `kept` stays. */
  async dropSecondName(extra: string, kept: string): Promise<void> {
    await this.#guard(extra, async (seams) => {
      await dropSecondName(this.ws, extra, kept, seams)
      this.#steps.push({ did: 'removed-second-name', path: extra })
    })
  }

  /** What the journal keeps: the moves in the order made, and each file at its path after them. */
  record(): { moves: SessionMove[]; files: SessionFile[] } {
    return { moves: [...this.#moves], files: [...this.#files].map(([path, record]) => ({ path, ...record })) }
  }

  /** The change is settled (journalled): a later failure must not put it back. */
  forget(): void {
    this.#files.clear()
    this.#moves.length = 0
    this.#madeFolders.length = 0
    this.#created.clear()
    this.#steps.length = 0
  }

  /**
   * Put back what this session changed: content first, then paths in reverse, then the folders it
   * made (only if empty). The owner lock is asked for first and again before each write; when it is
   * no longer held, nothing (more) is written and `lost` carries the refusal. A file is restored only
   * if it holds exactly what this session wrote to it; one that holds anything else is left and
   * named in `problems`. What the session remembers is forgotten only when everything is back.
   * The check is made twice: once on reading the file, and again by the write itself, on the handle,
   * immediately before the rename (`expect`), so a file written by somebody in between is left too.
   *
   * THE LAST CALL THAT CAN STILL LAND. Ownership is asked immediately before each write and cannot
   * be held across it, so when the lock changes hands the one write whose check had just passed may
   * still complete: its final system call is the `rename` that puts a rewritten file in place (or,
   * for a move, the `rename`, or the `link` and `unlink` pair). Nothing is started after a check fails.
   */
  async rollback(): Promise<Rollback> {
    const problems: string[] = []
    let lost: { error: unknown } | null = null
    const confirm = this.options.confirmRollback ?? this.options.confirmOwner
    const owned = async (): Promise<boolean> => {
      if (lost) return false
      try { await confirm(); return true } catch (error) { lost = { error }; return false }
    }
    const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
    if (await owned()) {
      for (const [path, { before, after }] of this.#files) {
        if (lost) break
        try {
          const current = fingerprint(await readBytes(this.ws, path))
          if (current === fingerprint(before)) continue
          if (current !== after) {
            problems.push(`${path}: it has changed since this operation wrote it, so it was left as it is`)
            continue
          }
          if (!(await owned())) break
          await writeWhole(this.ws, path, before, 'replace', this.options.seams ?? {}, { fingerprint: after })
        } catch (error) {
          problems.push(error instanceof ChangedSinceChecked ? `${path}: it has changed since this operation wrote it, so it was left as it is` : `${path}: ${reason(error)}`)
        }
      }
      for (const move of [...this.#moves].reverse()) {
        if (!(await owned())) break
        try { await movePath(this.ws, move.to, move.from, move.kind, {}, identityOf(move)) } catch (error) { problems.push(`${move.to}: ${reason(error)}`) }
      }
      for (const folder of [...this.#madeFolders].reverse()) {
        if (!(await owned())) break
        await rmdir(join(this.ws.root, folder)).catch(() => {})
      }
    }
    const stopped = lost as { error: unknown } | null
    if (stopped) return { problems, lost: stopped.error }
    this.forget()
    return { problems }
  }
}

/** A save that asks for a check in the tick of its commit (`beforeCommit`, next/0.23) is not one the session's
 *  write can honour, so it is refused rather than made without the check. No command-line operation asks for one. */
const refuseCommitCheck = (options: SaveFileOptions): void => {
  if (options.beforeCommit) throw new CliError('This change asks for a check at the moment of writing that the command line cannot make. Nothing was written.', 'failed')
}

/** What a write over a version needs of the Workspace it is made for: names, a look and a read. */
type BasisIo = {
  rel: (path: string) => string
  exists: (rel: string) => boolean
  read: (rel: string) => Promise<string>
}

/**
 * The save fix's write over a version (`Workspace.saveFileOver`; R5 in
 * docs/plans/saving-over-an-outside-change/spec-save-only-over-the-version-you-saw.md), carried out by the
 * session so it is journalled and undoable like every other command-line write. The basis is compared now
 * (DiskChangedUnderBuffer, nothing written), and the session's content check at the rename carries the
 * fingerprint of the text compared (ChangedSinceChecked, nothing written). `create` is the session's
 * create, which refuses a taken name. Returns the Collection-relative path written.
 */
async function sessionWriteOver(session: WriteSession, io: BasisIo, path: string, content: string, basis: SaveBasis, options: SaveFileOptions): Promise<string> {
  refuseCommitCheck(options)
  if (!isSaveBasis(basis)) throw new SaveWithoutBasis(path)
  const rel = io.rel(path)
  if (basis.kind === 'create') {
    if (io.exists(rel)) throw new NameTaken(rel)
    await session.create(rel, content)
    return rel
  }
  const now = io.exists(rel) ? await io.read(rel) : null
  if (!basisAllows(basis, now)) throw new DiskChangedUnderBuffer(rel, now)
  if (now === null) {
    await session.create(rel, content)
    return rel
  }
  if (!options.allowExplicitEmpty && content.trim() === '' && now.trim() !== '') {
    throw new CliError(`${rel} was not emptied: the command line does not replace a document with nothing.`)
  }
  await session.replace(rel, content, { fingerprint: fingerprintOf(now) })
  return rel
}

/** `saveFileOverRead`'s refusal: a basis refused as a change since the read, recorded for the call (R6). */
function overReadRefusal(error: unknown, changedSinceRead: (path: string, diskText: string | null) => ChangedSinceRead): unknown {
  return error instanceof DiskChangedUnderBuffer && !(error instanceof ChangedSinceRead) ? changedSinceRead(error.path, error.diskText) : error
}

const notFromHere = (what: string): never => {
  throw new CliError(`The command line does not ${what} this way.`, 'failed')
}

/**
 * The Workspace handed to write operations and, through them, to the app's own writers. Reads are the
 * command line's guarded reads; every save goes through the session. The Workspace's other writers
 * write by name with no check between judging a path and using it, so none of them is reachable.
 */
export class WritingWorkspace extends CommandLineWorkspace {
  constructor(root: string, readonly session: WriteSession) {
    super(root)
  }

  override async saveFile(path: string, content: string, options: SaveFileOptions = {}): Promise<SavedFileResult> {
    const rel = await this.#write(path, content, options)
    return { ...(await this.readFile(rel)), written: content, ...this.receiptForOwnRoute(rel, content) }
  }

  /** The save fix's writes over a version read (R5): through the session, never past it. */
  override async saveFileOver(path: string, content: string, basis: SaveBasis, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
    this.assertWritable()
    const rel = await sessionWriteOver(this.session, this.#io, path, content, basis, options)
    return { ...(await this.readFile(rel)), written: content, ...this.receiptForOwnRoute(rel, content) }
  }

  override async saveFileOverRead(path: string, next: string, read: string, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
    try {
      return await this.saveFileOver(path, next, { kind: 'disk', text: read }, options)
    } catch (error) {
      throw overReadRefusal(error, (p, disk) => this.changedSinceRead(p, disk))
    }
  }

  readonly #io: BasisIo = {
    rel: (path) => this.relative(this.absolute(path)),
    exists: (rel) => existsSync(this.absolute(rel)),
    read: async (rel) => (await this.readFile(rel)).content,
  }

  /** The Workspace's save with no read back (next/0.23): the same session write, so it is journalled and undoable. */
  override async saveFileWithoutReadBack(path: string, content: string, options: SaveFileOptions = {}): Promise<void> {
    await this.#write(path, content, options)
  }

  async #write(path: string, content: string, options: SaveFileOptions): Promise<string> {
    this.assertWritable()
    refuseCommitCheck(options)
    const rel = this.relative(this.absolute(path))
    if (!existsSync(this.absolute(rel))) await this.session.create(rel, content)
    else {
      if (!options.allowExplicitEmpty && content.trim() === '' && (await this.readFile(rel)).content.trim() !== '') {
        throw new CliError(`${rel} was not emptied: the command line does not replace a document with nothing.`)
      }
      await this.session.replace(rel, content, options.expect)
    }
    return rel
  }

  override async createFile(path: string, content: string): Promise<FileReadResult> {
    this.assertWritable()
    const rel = this.relative(this.absolute(markdownPath(path)))
    await this.session.create(rel, content)
    return this.readFile(rel)
  }

  override async duplicateFile(): Promise<FileReadResult> { return notFromHere('duplicate files') }
  override async createFolder(): Promise<{ path: string }> { return notFromHere('create folders') }
  override async renameFolder(): Promise<{ path: string }> { return notFromHere('rename folders') }
  override async renameFile(): Promise<FileReadResult> { return notFromHere('rename files') }
  override async saveImage(): Promise<{ path: string }> { return notFromHere('save images') }
  override async saveNamedImage(): Promise<{ path: string }> { return notFromHere('save images') }
}

const BARRED: Record<string, string> = {
  saveEditorText: 'save editor text', duplicateFile: 'duplicate files', createFolder: 'create folders', renameFolder: 'rename folders',
  renameFile: 'rename files', saveImage: 'save images', saveNamedImage: 'save images',
}

/**
 * The same thing as WritingWorkspace for a caller that must not make a second Workspace: the app,
 * carrying out a request. `view` is the document-only view of the app's ONE Workspace
 * (document-only-workspace.ts); this lays the session over it. Reads and path resolves go to the
 * view, which judges each one; a read of a path that is not a document fails as a file that is not
 * there, as on the command line; every save goes through the session; the Workspace's writers that
 * write by name are not reachable.
 */
export function sessionWorkspace(view: Workspace, session: WriteSession): Workspace {
  const readFile = async (path: string): Promise<FileReadResult> => {
    if (view.classifyPath(path) !== 'document') throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
    return view.readFile(path)
  }
  const write = async (path: string, content: string, options: SaveFileOptions): Promise<string> => {
    view.assertWritable()
    refuseCommitCheck(options)
    const rel = view.relative(view.absolute(path))
    if (!existsSync(view.absolute(rel))) await session.create(rel, content)
    else {
      if (!options.allowExplicitEmpty && content.trim() === '' && (await readFile(rel)).content.trim() !== '') {
        throw new CliError(`${rel} was not emptied: a request does not replace a document with nothing.`)
      }
      await session.replace(rel, content, options.expect)
    }
    return rel
  }
  const io: BasisIo = {
    rel: (path) => view.relative(view.absolute(path)),
    exists: (rel) => existsSync(view.absolute(rel)),
    read: async (rel) => (await readFile(rel)).content,
  }
  const routed: Record<string, unknown> = {
    readFile,
    async saveFile(path: string, content: string, options: SaveFileOptions = {}): Promise<FileReadResult> {
      return readFile(await write(path, content, options))
    },
    // next/0.23's save with no read back: the same session write, so it is journalled, put back on failure and undoable.
    async saveFileWithoutReadBack(path: string, content: string, options: SaveFileOptions = {}): Promise<void> {
      await write(path, content, options)
    },
    async createFile(path: string, content: string): Promise<FileReadResult> {
      view.assertWritable()
      const rel = view.relative(view.absolute(markdownPath(path)))
      await session.create(rel, content)
      return readFile(rel)
    },
    // The save fix's writes over a version read (R5): through the session, never past it to the view.
    async saveFileOver(path: string, content: string, basis: SaveBasis, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
      view.assertWritable()
      const rel = await sessionWriteOver(session, io, path, content, basis, options)
      return { ...(await readFile(rel)), written: content }
    },
    async saveFileOverRead(path: string, next: string, read: string, options: SaveFileOptions = {}): Promise<EditorSaveResult> {
      try {
        return await (routed.saveFileOver as (p: string, c: string, b: SaveBasis, o: SaveFileOptions) => Promise<EditorSaveResult>)(path, next, { kind: 'disk', text: read }, options)
      } catch (error) {
        throw overReadRefusal(error, (p, disk) => view.changedSinceRead(p, disk))
      }
    },
  }
  return new Proxy(view, {
    get(target, property) {
      if (typeof property === 'string' && Object.hasOwn(routed, property)) return routed[property]
      if (typeof property === 'string' && Object.hasOwn(BARRED, property)) return async () => notFromHere(BARRED[property])
      return Reflect.get(target, property, target) as unknown
    },
  })
}
