/**
 * `FolioWorkspace`: the one workspace object Folio room code is given (spec-folio-room-data-model § 9 D-WRITE-1,
 * invariant I-2). It is the SAME Workspace (one write turn, one own-write record, one search cache, one write gate),
 * seen through the Folio's rule: every file it writes is physically inside the Folio's own folder.
 *
 * - It reads like the Workspace: every reading member is the Workspace's own, unchanged.
 * - Its writing members are exactly `saveFile`, `saveFileWithoutReadBack`, `saveFileOver`, `createFile` and
 *   `removeFileOverRead`. Each one, before anything is written:
 *   1. refuses a path that is not lexically inside the Folio folder (normalised; `..`, an absolute path or a
 *      backslash never steps out), and a path in a folder below the Folio folder that is itself a Folio by the
 *      app's own rule (`isFolioFolderNow`: a manifest, or an Index Note that declares a running order; a folder
 *      whose Index Note is only a cover is not one; a read that fails counts as one): another Folio's files are
 *      never this Folio's, which matters most for a Folio at the Collection root;
 *   2. pins the target's parent folder: every folder from the workspace root down to it is a folder and not a link
 *      (`lstat`), the real path of the parent relative to the real workspace root folds to the lexical parent, and
 *      the parent is a folder at that real path, giving `{ real, dev, ino }`. The parent must exist: the room never
 *      makes folders;
 *   3. hands the write to the Workspace with `documentOnly: true` and `inFolder: <pin>`, so it always takes the
 *      guarded route, which checks the pin again when it resolves the folder and, synchronously, just before the
 *      commit system call (guarded-document-write.ts `isPinnedFolder`).
 *   A refusal at any of these steps, or the guarded write's own refusal of a swapped or missing folder, reads
 *   FOLIO_REFUSAL and nothing was written.
 * - Every other member of `Workspace` that writes, moves, removes or makes anything throws ROOM_REFUSAL when called,
 *   and so do `constructor` (a second Workspace made from the view would be a bare one) and the write gate
 *   `assertWritable` (below). A member that is in no list (one added to Workspace later, or any symbol-keyed
 *   member) is refused the same way, and `unclassifiedWorkspaceMembers` names it, so a test fails until it is
 *   classed here (folio-workspace.test.ts).
 * - The view's prototype (`Object.getPrototypeOf`) is a shadow whose own prototype is `Workspace.prototype`, so
 *   `instanceof Workspace` holds, and which answers every member as the view does: a blocked member taken from it
 *   refuses, whatever `this` it is called with.
 * - A Workspace method taken from the class itself (`Workspace.prototype.createFolder.call(view, …)`) cannot be
 *   intercepted, so it fails closed through the view it runs on: every writing member of Workspace other than
 *   `saveFileOver`, `saveFileOverRead` and `saveFileWithoutReadBack` asks `this.assertWritable()` before it touches
 *   the disk, and the view refuses that; those three reach the disk only through `this.saveFile`, which on the view
 *   is the pinned writer; `receiptForOwnRoute` needs a private field the view does not have (a TypeError). The room
 *   needs no `assertWritable` of its own: its five writers ask the Workspace's inside the Workspace.
 * - The boundary: the view stops room code (our own main-process code) from holding or constructing an unpinned
 *   Workspace by ordinary use, enforced by a source scan (room modules import `Workspace` as a type only and never
 *   reach `getPrototypeOf`, `__proto__` or `.constructor`); it does not claim to stop reflection up the prototype
 *   chain, where `Workspace.prototype.constructor` is the class, as `instanceof Workspace` requires.
 *
 * Writers the room reuses (the Plan writers, Start this part, the status writer, the Undo of Add) take this view in
 * place of the Workspace and need no change: they call the same five members.
 *
 * What is not guaranteed: as for every guarded write in the app, the physical check and the commit system call are
 * issued with nothing awaited between them; another process acting inside that gap is not claimed to be stopped.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { join, posix, relative, sep } from 'node:path'
import { GuardedWriteRefused, carryLeftover, type FolderIdentity } from './guarded-document-write'
import { NotADocumentPathError, Workspace, normaliseMarkdownPath, type SaveFileOptions } from './workspace'
import { folioDeclarationOnDisk } from './folio-declaration'
import { markReadsAsWorkspace } from './file-facts'
import type { SaveBasis } from '../shared/save-basis'

/** What a refused room write says. Nothing was written. */
export const FOLIO_REFUSAL = 'This file is not inside the Folio’s own folder, so nothing was changed.'
/** What a Workspace member the room may not use says when called. */
export const ROOM_REFUSAL = 'Not allowed from the Folio room'

/** A room write refused because its file is not physically inside the Folio's own folder. A `NotADocumentPathError`
 *  (verdict `outside`), so every caller that already answers that refusal answers this one; only the words differ. */
export class NotInsideFolioError extends NotADocumentPathError {
  constructor(path: string) {
    super(path, 'outside')
    this.message = FOLIO_REFUSAL
  }
}

/** A Workspace member the room may not use, called from the room. */
export class NotAllowedFromFolioRoom extends Error {
  readonly member: string
  constructor(member: PropertyKey) {
    super(ROOM_REFUSAL)
    this.member = String(member)
  }
}

/** The members a `FolioWorkspace` writes through, each pinned to the Folio (D-WRITE-1). */
export const FOLIO_WRITERS: ReadonlySet<string> = new Set([
  'saveFile', 'saveFileWithoutReadBack', 'saveFileOver', 'createFile', 'removeFileOverRead', 'setAsideBackupRecord',
])

/** Members that write nothing on disk: reachable unchanged. A member goes here only when it neither writes, moves,
 *  removes nor makes a file or folder, nor commits a write by a route of its own. */
export const FOLIO_READERS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  // Instance fields (not on the prototype).
  'root', 'searchIndex', 'onWriteNotice', 'onDocumentWritten',
  // Paths and their judgement.
  'absolute', 'relative', 'isVisiblePath', 'classifyPath', 'assertDocumentPath', 'renameTarget',
  // Reads and listings.
  'readFile', 'listFiles', 'listFilesAndFolders', 'listFilesIn', 'listFolders', 'listSources', 'checklistProgress', 'search',
  // The Collection's write turn: asks for it, writes nothing itself; every write made inside is one of the writers above.
  'exclusive', 'exclusiveAll', 'writersWaiting',
  // Per-call records and refusals, the own-write record and the write notice: none of them touches a file.
  'withWriteReceipts', 'recordingOperationWrites', 'outsideCallRecords', 'changedSinceRead', 'receiptFor',
  'recordOwnWrite', 'forgetOwnWrites', 'wasRecentlyWrittenByApp', 'announceWriteNotice',
  // Byte checks made in the tick of a commit, or now: they read, and refuse by throwing.
  'commitOnlyOver', 'assertOnDisk',
  // Symbol-keyed members: none is let through (Workspace has none today). One goes here only by name.
])

/** Members that write, move, remove or make something, or commit by a route of their own: refused from the room.
 *  Also `constructor` (a Workspace made from it is a bare one) and `assertWritable`, the gate every Workspace writer
 *  but three asks first: refusing it is what stops a Workspace method taken from the class and run on the view. */
export const FOLIO_BLOCKED: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  'saveFileOverRead', 'saveEditorText', 'saveImage', 'saveNamedImage', 'duplicateFile', 'moveToTrash',
  'createFolder', 'renameFolder', 'renameFile', 'receiptForOwnRoute', 'writeAppStoreFile',
  'constructor', 'assertWritable',
])

/** `Object.prototype` members the view answers as any object does. Not `__proto__` (it would read the Workspace's real
 *  prototype past the shadow) nor `__defineGetter__` and its kin (they change the object). */
const OBJECT_MEMBERS: ReadonlySet<PropertyKey> = new Set<PropertyKey>([
  'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
])

const classed = (key: PropertyKey): boolean =>
  (typeof key === 'string' && FOLIO_WRITERS.has(key)) || FOLIO_READERS.has(key) || FOLIO_BLOCKED.has(key)

/** Every own key of `Workspace.prototype` (accessors, `constructor` and symbol keys included), and of `instance` when
 *  given (its fields), that none of the three lists classes. Empty when the view is complete; a member named here is
 *  refused from the room until it is classed. */
export function unclassifiedWorkspaceMembers(instance?: Workspace): PropertyKey[] {
  const keys = new Set<PropertyKey>([...Reflect.ownKeys(Workspace.prototype), ...(instance ? Reflect.ownKeys(instance) : [])])
  return [...keys].filter((key) => !classed(key))
}

const fold = (text: string): string => text.normalize('NFC').toLocaleLowerCase()

/** The Folio folder in one lexical spelling ('' for the workspace root), or null when it is not a place inside the
 *  workspace (absolute, stepping out, or holding a backslash). */
function folioFolder(dir: string): string | null {
  if (typeof dir !== 'string' || dir.includes('\\') || posix.isAbsolute(dir)) return null
  const normal = posix.normalize(dir === '' ? '.' : dir).replace(/\/+$/, '')
  if (normal === '.' || normal === '') return ''
  if (normal === '..' || normal.startsWith('../')) return null
  return normal
}

/** `path` (workspace-relative) normalised, when it names a file strictly inside the Folio folder `folio`; else null.
 *  A backslash is refused: elsewhere in the app it may be read as a separator, so a path holding one could name
 *  two places. */
function insideFolio(folio: string, path: string): string | null {
  if (typeof path !== 'string' || path === '' || path.includes('\\') || posix.isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return null
  const normal = posix.normalize(path)
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.endsWith('/')) return null
  return folio === '' || normal.startsWith(`${folio}/`) ? normal : null
}

/** The pin of the folder `parent` (workspace-relative, lexical) as it stands now, or null when it may not be written
 *  into: missing, not a folder, a link at it or anywhere on the way from the workspace root, or a real path that is
 *  not the lexical one. Synchronous. */
export function pinParent(root: string, parent: string): FolderIdentity | null {
  try {
    const segments = parent === '' ? [] : parent.split('/')
    let cursor = root
    for (const segment of segments) {
      cursor = join(cursor, segment)
      // lstat, never stat: a link is not a folder here, wherever it leads.
      if (!lstatSync(cursor).isDirectory()) return null
    }
    const realRoot = realpathSync.native(root)
    const real = realpathSync.native(join(root, parent))
    // Letter case or Unicode form alone may differ (a volume that ignores them); anything else is a link on the way.
    if (fold(relative(realRoot, real).split(sep).join('/')) !== fold(parent)) return null
    const stat = lstatSync(real)
    return stat.isDirectory() && !stat.isSymbolicLink() ? { real, dev: stat.dev, ino: stat.ino } : null
  } catch {
    return null
  }
}

/**
 * The one guard for a write at `path` (workspace-relative) in the Folio at `folio` (one lexical spelling, '' for the
 * workspace root): rule 1 and 2 of the module comment. The pin of its parent folder, or `NotInsideFolioError`
 * (thrown) when the path is not lexically inside the Folio folder, its parent is not a plain folder inside it, or a
 * folder between the Folio folder and the file is itself a Folio (`isFolioFolderNow`; a read that fails counts as
 * one). Synchronous: a caller that writes by a route of its own (the Folio bin's moves, folio-bin.ts) asks it in the
 * tick of its system call. Every writer of the view asks it too.
 */
export function authoriseFolioWrite(root: string, folio: string, path: string): FolderIdentity {
  const normal = insideFolio(folio, path)
  const parent = normal === null ? null : posix.dirname(normal) === '.' ? '' : posix.dirname(normal)
  const pinned = parent === null ? null : pinParent(root, parent)
  if (!pinned || foldersBelow(folio, parent as string).some((dir) => isAnotherFolio(root, dir))) throw new NotInsideFolioError(path)
  return pinned
}

/** Whether the folder `dir` (workspace-relative, below a Folio folder) is itself a Folio. Only a read that fails counts as one. */
function isAnotherFolio(root: string, dir: string): boolean {
  try {
    // An ignored legacy declaration still protects its authored files from another Folio's operations.
    return folioDeclarationOnDisk({ root, absolute: path => join(root, path) }, dir).isFolio
  } catch {
    return true
  }
}

/** The folders strictly below the Folio folder `folio` down to `parent` (inclusive), shallowest first. */
function foldersBelow(folio: string, parent: string): string[] {
  const below = folio === '' ? parent : parent === folio ? '' : parent.slice(folio.length + 1)
  if (below === '') return []
  const segments = below.split('/')
  return segments.map((_, at) => posix.join(...(folio === '' ? [] : [folio]), ...segments.slice(0, at + 1)))
}

/** The guarded write's refusal of a pinned folder (swapped, missing or not the pinned one), in the room's words. */
function asFolioRefusal(error: unknown, path: string): unknown {
  const pinRefused = (error instanceof NotADocumentPathError && error.verdict === 'outside' && !(error instanceof NotInsideFolioError))
    || (error instanceof GuardedWriteRefused && error.code === 'no-folder')
  return pinRefused ? carryLeftover(new NotInsideFolioError(path), error) : error
}

const views = new WeakSet<object>()

export interface FolioWorkspace extends Workspace {
  /** The Folio folder this view writes into, as one lexical spelling ('' for the workspace root). */
  readonly folioDir: string
}

/**
 * `new FolioWorkspace(ws, dir)`: the view of `ws` for the Folio at `dir` (module comment). `instanceof Workspace` and
 * `instanceof FolioWorkspace` both hold. A `dir` that is not a place inside the workspace is refused here.
 */
export class FolioWorkspace {
  static [Symbol.hasInstance](value: unknown): boolean {
    return typeof value === 'object' && value !== null && views.has(value)
  }

  constructor(ws: Workspace, dir: string) {
    const folio = folioFolder(dir)
    if (folio === null) throw new Error('A Folio folder must be a folder inside the open Workspace.')

    /** The pin for writing `path`, or the room's refusal (thrown): `authoriseFolioWrite`. */
    const authorise = (path: string): FolderIdentity => authoriseFolioWrite(ws.root, folio, path)
    const pinnedOptions = (options: SaveFileOptions, pinned: FolderIdentity): SaveFileOptions => ({ ...options, documentOnly: true, inFolder: pinned })
    const refusing = async <T>(path: string, write: () => Promise<T>): Promise<T> => {
      try {
        return await write()
      } catch (error) {
        throw asFolioRefusal(error, path)
      }
    }

    // Async, as the Workspace's are: a refusal is a rejected promise, never a synchronous throw. `removeFileOverRead`
    // stays synchronous, as the Workspace's is: its callers (the Plan writers' restores, Start's clean-up, the Undo
    // of Add) call it without awaiting and answer its throw in place.
    const writers: Record<string, unknown> = {
      async saveFile(path: string, content: string, options: SaveFileOptions = {}) {
        const pinned = authorise(path)
        return refusing(path, () => ws.saveFile(path, content, pinnedOptions(options, pinned)))
      },
      async saveFileWithoutReadBack(path: string, content: string, options: SaveFileOptions = {}) {
        const pinned = authorise(path)
        return refusing(path, () => ws.saveFileWithoutReadBack(path, content, pinnedOptions(options, pinned)))
      },
      async saveFileOver(path: string, content: string, basis: SaveBasis, options: SaveFileOptions = {}) {
        const pinned = authorise(path)
        return refusing(path, () => ws.saveFileOver(path, content, basis, pinnedOptions(options, pinned)))
      },
      async createFile(path: string, content: string, options: Pick<SaveFileOptions, 'documentOnly' | 'inFolder'> = {}) {
        // Judged as it will be written: `createFile` adds `.md` to a name without a Markdown extension.
        const normalised = normaliseMarkdownPath(path)
        const pinned = authorise(normalised)
        return refusing(normalised, () => ws.createFile(normalised, content, { ...options, documentOnly: true, inFolder: pinned }))
      },
      async setAsideBackupRecord(path: string, targetPath: string) {
        const pinned = authorise(path)
        return refusing(path, () => ws.setAsideBackupRecord(path, targetPath, { inFolder: pinned }))
      },
      removeFileOverRead(path: string, read: string, _options: Pick<SaveFileOptions, 'inFolder'> = {}): void {
        const pinned = authorise(path)
        try {
          ws.removeFileOverRead(path, read, { inFolder: pinned })
        } catch (error) {
          throw asFolioRefusal(error, path)
        }
      },
    }
    // A plain function, not an arrow: `new` on it reaches the refusal too (`new view.constructor(…)`).
    const blocked = (member: PropertyKey) => function notAllowedFromFolioRoom(): never { throw new NotAllowedFromFolioRoom(member) }
    const refuseChange = (): never => { throw new NotAllowedFromFolioRoom('a property') }
    /** What the view (and its prototype) answers for `property`. `reader` gives a reader's own value, and differs
     *  between the two: the view's is the Workspace's member bound to it, the shadow's the bare prototype value. */
    const member = (property: PropertyKey, reader: () => unknown): unknown => {
      if (typeof property === 'string' && Object.hasOwn(writers, property)) return writers[property]
      if (FOLIO_READERS.has(property)) return reader()
      // The plain-object members every object has (`${view}`, a log line), unbound: they read, never write.
      if (OBJECT_MEMBERS.has(property)) return Reflect.get(Object.prototype, property)
      // A blocked member, or one not classed (a member added to Workspace later, a symbol-keyed one): refused when called.
      if (FOLIO_BLOCKED.has(property) || property in ws) return blocked(property)
      return undefined
    }
    // `preventExtensions` (and so `Object.freeze` / `Object.seal`) is refused too: forwarded, it would make the shared
    // Workspace non-extensible behind a refused call, and break `getPrototypeOf` on every view of it.
    const unchangeable = {
      set: refuseChange, defineProperty: refuseChange, deleteProperty: refuseChange, setPrototypeOf: refuseChange,
      preventExtensions: refuseChange,
    }
    /** `in`, as `member` answers: a member is there when it reads as something. */
    const has = (property: PropertyKey): boolean => property === 'folioDir' || member(property, () => true) !== undefined

    /** The view's prototype: inherits from `Workspace.prototype` (so `instanceof Workspace` holds) and answers every
     *  member as the view does, so a member taken from it refuses whatever `this` it is called with. */
    const shadow = new Proxy(Object.create(Workspace.prototype) as object, {
      get: (_target, property) => member(property, () => Reflect.get(Workspace.prototype, property)),
      has: (_target, property) => has(property),
      ...unchangeable,
    })
    // A reader's bound method is made once per member and value, so it keeps one identity (a fresh `bind` on every
    // read would make `view.readFile !== view.readFile`).
    const bound = new Map<PropertyKey, { value: (...args: unknown[]) => unknown; bound: (...args: unknown[]) => unknown }>()
    const view = new Proxy(ws, {
      get(target, property) {
        if (property === 'folioDir') return folio
        return member(property, () => {
          const value = Reflect.get(target, property, target) as unknown
          if (typeof value !== 'function') return value
          const known = bound.get(property)
          if (known?.value === value) return known.bound
          const made = { value: value as (...args: unknown[]) => unknown, bound: (value as (...args: unknown[]) => unknown).bind(target) }
          bound.set(property, made)
          return made.bound
        })
      },
      getPrototypeOf: () => shadow,
      has: (_target, property) => has(property),
      ...unchangeable,
    })
    views.add(view)
    // Its reads are the Workspace's own (`readFile` unchanged): the per-file facts cache may serve it (file-facts.ts),
    // which the bound method's identity alone cannot show (orientation § 7).
    if (ws.readFile === Workspace.prototype.readFile) markReadsAsWorkspace(view)
    return view as unknown as FolioWorkspace
  }
}
