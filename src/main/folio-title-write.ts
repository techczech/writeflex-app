/** Title changes at command boundaries. Storage and ordinary prose saves do not depend on Folio logic. */
import { posix } from 'node:path'
import { candidateTitle } from './wikilinks'
import { partTitle } from '../shared/folio-part-title'
import { folioDeclaration } from './folio-declaration'
import { linkFolioFilesInWriteTurn } from './folio-identity-open'
import type { PlanWriteOptions } from './plan'
import { inheritWorkspaceFacts } from './file-facts'
import { fingerprintOfRead } from './guarded-document-read'
import { DiskChangedUnderBuffer, SavedButNotReadBack, Workspace, type SaveFileOptions } from './workspace'
import type { SaveBasis } from '../shared/save-basis'
export type IdentityLinked = { root: string; dir: string; indexPath: string; undoToken?: string; warning?: string }
export type TitleIdentityOptions = {
  onLinked?: (result: IdentityLinked) => void
  onWarning?: (message: string) => void
  beforeIndexWrite?: PlanWriteOptions['beforeIndexWrite']
}
export const TITLE_WRITERS = new Set<PropertyKey>(['saveFile', 'saveFileWithoutReadBack', 'saveEditorText', 'saveFileOver', 'saveFileOverRead'])
/** Each other writer is classified explicitly: it creates a new file, moves/removes one, writes assets or app state;
 * none replaces an existing chapter's text. Unknown future members are refused until classified here. */
export const TITLE_PASSTHROUGH = new Set<PropertyKey>([
  'root', 'onDocumentWritten', 'onWriteNotice', 'searchIndex',
  'absolute', 'relative', 'isVisiblePath', 'classifyPath', 'assertDocumentPath', 'renameTarget',
  'readFile', 'listFiles', 'listFilesAndFolders', 'listFilesIn', 'listFolders', 'listSources', 'checklistProgress', 'search',
  'exclusive', 'exclusiveAll', 'writersWaiting', 'assertWritable', 'commitOnlyOver', 'assertOnDisk',
  'withWriteReceipts', 'recordingOperationWrites', 'outsideCallRecords', 'changedSinceRead', 'receiptFor', 'receiptForOwnRoute',
  'recordOwnWrite', 'forgetOwnWrites', 'wasRecentlyWrittenByApp', 'announceWriteNotice',
  'saveImage', 'saveNamedImage', 'createFile', 'duplicateFile', 'removeFileOverRead', 'setAsideBackupRecord',
  'moveToTrash', 'createFolder', 'renameFolder', 'renameFile', 'writeAppStoreFile',
])
export const TITLE_BLOCKED = new Set<PropertyKey>(['constructor', 'session'])
export function unclassifiedTitleWorkspaceMembers(instance?: Workspace): PropertyKey[] {
  return [...new Set([...Reflect.ownKeys(Workspace.prototype), ...(instance ? Reflect.ownKeys(instance) : [])])]
    .filter(key => !TITLE_WRITERS.has(key) && !TITLE_PASSTHROUGH.has(key) && !TITLE_BLOCKED.has(key))
}

export function withFolioTitleIdentity(ws: Workspace, options: TitleIdentityOptions = {}): Workspace {
  const warn = (path: string, error: unknown): void => {
    const message = `Could not link the chapter file ${path} before its title changed: ${error instanceof Error ? error.message : String(error)}. The document save continues; use “Link to a file…” if needed.`
    try { options.onWarning ? options.onWarning(message) : ws.announceWriteNotice(message) } catch { /* A notice cannot refuse a save. */ }
  }
  const save = (method: keyof Workspace, path: string, next: string, basis: SaveBasis | undefined, saveOptions: SaveFileOptions, args: unknown[]) => ws.exclusiveAll(async () => {
    const original = ws[method] as (...args: unknown[]) => Promise<unknown>
    const write = () => original.call(ws, path, next, ...args)
    ws.assertWritable()
    // The save's own authority checks precede any Folio read or write.
    if (basis) {
      try { await ws.assertOnDisk(path, basis) } catch (error) {
        if (method === 'saveFileOverRead' && error instanceof DiskChangedUnderBuffer) throw ws.changedSinceRead(error.path, error.diskText)
        throw error
      }
    }
    if (!/\.(md|markdown|mdx)$/i.test(path) || /(?:^|\/)(?:_[^/]+_INDEX|AGENTS|CLAUDE)\.md$/i.test(path) || ws.classifyPath(path) !== 'document') return write()
    let previous
    try { previous = await ws.readFile(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return write()
      throw error
    }
    if (saveOptions.exclusive || (saveOptions.expect && saveOptions.expect.fingerprint !== fingerprintOfRead(previous))) return write()
    if (candidateTitle(previous.content, path) === candidateTitle(next, path) && partTitle(previous.content, path).title === partTitle(next, path).title) return write()
    let linked: Awaited<ReturnType<typeof linkFolioFilesInWriteTurn>> | undefined
    let dir = posix.dirname(path); if (dir === '.') dir = ''
    let pinError: unknown
    let rollbackSource: string | undefined
    let rollbackNext: string | undefined
    const recheck = async () => { if (basis) await ws.assertOnDisk(path, basis) }
    try {
      for (;;) {
        if (folioDeclaration(ws, dir).isFolio) {
          linked = await linkFolioFilesInWriteTurn(ws, dir, {
            beforeIndexWrite: async index => { await options.beforeIndexWrite?.(index); await recheck() },
            onCommit: receipt => { rollbackSource = receipt.index.before ?? undefined; rollbackNext = receipt.index.after ?? undefined },
          }, path)
          break
        }
        if (!dir) break
        dir = posix.dirname(dir); if (dir === '.') dir = ''
      }
    } catch (error) {
      // A stale save discovered after a checkpoint still makes no pin and emits no linking notice.
      await recheck()
      pinError = error
    }
    const announce = () => {
      if (!linked?.changed || !linked.indexPath) return
      try {
        if (options.onLinked) options.onLinked({ root: ws.root, dir, indexPath: linked.indexPath, ...(linked.undoToken ? { undoToken: linked.undoToken } : {}) })
        else ws.announceWriteNotice("WriteFlex now links this Folio's chapters to their files")
      } catch (error) { warn(path, error) }
    }
    try {
      const answer = await write()
      if (pinError !== undefined) warn(path, pinError)
      announce()
      return answer
    } catch (error) {
      if (error instanceof SavedButNotReadBack) { if (pinError !== undefined) warn(path, pinError); announce(); throw error }
      // The final storage guard can still refuse. Restore only our exact pin, never another writer's text.
      if (linked?.changed && linked.indexPath && rollbackSource !== undefined && rollbackNext !== undefined) {
        try { await ws.saveFileOverRead(linked.indexPath, rollbackSource, rollbackNext) } catch (rollbackError) { warn(path, rollbackError) }
      }
      throw error
    }
  })
  const guarded: Record<string, unknown> = {
    saveFile: (path: string, text: string, o: SaveFileOptions = {}) => save('saveFile', path, text, undefined, o, [o]),
    saveFileWithoutReadBack: (path: string, text: string, o: SaveFileOptions = {}) => save('saveFileWithoutReadBack', path, text, undefined, o, [o]),
    saveEditorText: (path: string, text: string, basis: SaveBasis, o: SaveFileOptions = {}) => save('saveEditorText', path, text, basis, o, [basis, o]),
    saveFileOver: (path: string, text: string, basis: SaveBasis, o: SaveFileOptions = {}) => save('saveFileOver', path, text, basis, o, [basis, o]),
    saveFileOverRead: (path: string, text: string, read: string, o: SaveFileOptions = {}) => save('saveFileOverRead', path, text, { kind: 'disk', text: read }, o, [read, o]),
  }
  const get = (key: PropertyKey): unknown => {
    if (typeof key === 'string' && Object.hasOwn(guarded, key)) return guarded[key]
    if (TITLE_PASSTHROUGH.has(key)) { const value = Reflect.get(ws, key, ws); return typeof value === 'function' ? value.bind(ws) : value }
    if (['toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'].includes(String(key))) return Reflect.get(ws, key, ws)
    if (key === 'then' || key === 'toJSON') return undefined
    throw new Error(`Workspace member ${String(key)} is not classified for title-safe commands.`)
  }
  const shadow = new Proxy(Object.create(Workspace.prototype), { get: (_target, key) => get(key), setPrototypeOf: () => false })
  for (const key of [...TITLE_WRITERS, ...TITLE_PASSTHROUGH, ...TITLE_BLOCKED]) Object.defineProperty(shadow, key, { get: () => get(key) })
  const view = new Proxy(Object.create(shadow) as Workspace, {
    get: (_target, key) => get(key),
    set: (_target, key, value) => {
      if (key !== 'onWriteNotice' && key !== 'onDocumentWritten') throw new Error(`Workspace member ${String(key)} cannot be set from title-safe commands.`)
      return Reflect.set(ws, key, value, ws)
    },
    setPrototypeOf: () => false,
  })
  inheritWorkspaceFacts(view, ws)
  return view
}
