/**
 * The Workspace handed to everything that acts on a path somebody else named: the agent's
 * capabilities (run in a turn or adopted from a proposal), the staging reads that copy a proposal's
 * target into the review ledger, and the running-order desk. It is the SAME Workspace (one own-write
 * record, one search cache, one write gate), seen through a rule: every path it reads, writes,
 * creates, renames or resolves must be a document the sidebar would show (`Workspace.classifyPath`:
 * the typed path and its real location on disk). Anything else throws `NotADocumentPathError`.
 * A document's text is read through ONE handle that does not follow a final link, and the file that
 * was opened is the file judged and read; a save is the Workspace's guarded write (`documentOnly`).
 *
 * This is where the rule is enforced. Nothing upstream has to predict which files a capability will
 * touch, and a capability added later is covered without being listed anywhere, because the only
 * Workspace it is given is this one. Two things make that hold:
 *  - `absolute` is guarded too, so code that resolves a path and then uses the file system directly
 *    (delete a scraps file, read synchronously) is refused at the resolve;
 *  - a Workspace member this file does not name is not reachable at all (it throws), so a method
 *    added to Workspace later has to be classed here as a read, a guarded write or a pass-through
 *    before any capability can call it.
 *
 * The Workspace's own internal steps (the empty-write rescue copy under `.writeflex/rescue`) are not
 * affected: they run inside the real Workspace, on paths it chose itself.
 */
import { statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { NotADocumentPathError, normaliseMarkdownPath, type SaveFileOptions, type Workspace } from './workspace'
import type { PathKind } from './document-path'
import type { SaveBasis } from '../shared/save-basis'
import { DocumentReadRefused, asFileSystemError, readDocumentFile } from './guarded-document-read'

export type DocumentOnlyView = {
  /** The guarded Workspace. `instanceof Workspace` holds. */
  workspace: Workspace
  /** One line per refused path, oldest first: how a caller tells that something it ran was refused. */
  refusals: string[]
}

/** Members that neither take a path to act on nor write: reachable unchanged. */
const PASS_THROUGH = new Set<string>([
  'root', 'relative', 'recordOwnWrite', 'wasRecentlyWrittenByApp', 'isVisiblePath', 'classifyPath',
  'assertWritable', 'assertDocumentPath', 'listFiles', 'listFolders', 'listSources', 'checklistProgress',
  'search', 'searchIndex',
  // A listing of one folder: what `listFiles` filtered to it returns (hidden and linked folders list nothing).
  'listFilesIn',
  // The Collection's write turn (collection-write-turn.ts): asks for it, writes nothing itself. Every write
  // made inside is still one of the guarded members below.
  'exclusive', 'exclusiveAll', 'writersWaiting',
  // Write to names the Workspace generates itself, under `assets/` (judged below as a folder).
  'saveImage', 'saveNamedImage',
  // The save fix's per-call records (receipts, refusals, an operation's writes for its rollback) and the
  // refusal it makes: they write nothing themselves; every write made inside is a guarded member below.
  'withWriteReceipts', 'recordingOperationWrites', 'outsideCallRecords', 'changedSinceRead', 'receiptFor',
])

export function documentOnlyView(ws: Workspace): DocumentOnlyView {
  const refusals: string[] = []

  const judge = (path: string, kind: PathKind = 'file'): void => {
    const verdict = ws.classifyPath(path, kind)
    if (verdict === 'document') return
    const error = new NotADocumentPathError(path, verdict)
    refusals.push(error.message)
    throw error
  }
  /** Run the real method; a refusal raised inside it (the late re-check at the write) is logged too. */
  const real = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      if (error instanceof NotADocumentPathError) refusals.push(error.message)
      throw error
    }
  }
  /** An existing folder is judged in every segment; anything else as a file in its folders. */
  const kindOnDisk = (absolute: string): PathKind => {
    try { return statSync(absolute).isDirectory() ? 'folder' : 'file' } catch { return 'file' }
  }

  const guarded: Record<string, unknown> = {
    absolute(path: string): string {
      let resolved: string
      try { resolved = ws.absolute(path) } catch (error) { refusals.push(error instanceof Error ? error.message : String(error)); throw error }
      judge(path, kindOnDisk(resolved))
      return resolved
    },
    async readFile(path: string) {
      judge(path)
      // One handle, opened without following a final link; the opened file is judged and read
      // (guarded-document-read.ts). A link put at the name after `judge` is refused, not followed.
      try {
        return await readDocumentFile(ws, path)
      } catch (error) {
        if (!(error instanceof DocumentReadRefused)) throw error
        if (error.code !== 'not-a-document') throw asFileSystemError(error, path)
        const verdict = ws.classifyPath(path)
        const refusal = new NotADocumentPathError(path, verdict === 'document' ? 'outside' : verdict)
        refusals.push(refusal.message)
        throw refusal
      }
    },
    async saveFile(path: string, content: string, options: SaveFileOptions = {}) {
      judge(path)
      return real(() => ws.saveFile(path, content, { ...options, documentOnly: true }))
    },
    async saveFileWithoutReadBack(path: string, content: string, options: SaveFileOptions = {}) {
      judge(path)
      return real(() => ws.saveFileWithoutReadBack(path, content, { ...options, documentOnly: true }))
    },
    async saveEditorText(path: string, text: string, basis: SaveBasis, options: SaveFileOptions = {}) {
      judge(path)
      return real(() => ws.saveEditorText(path, text, basis, { ...options, documentOnly: true }))
    },
    // The save fix's writes over a version read (R5): judged here, written by the guarded write.
    async saveFileOver(path: string, content: string, basis: SaveBasis, options: SaveFileOptions = {}) {
      judge(path)
      return real(() => ws.saveFileOver(path, content, basis, { ...options, documentOnly: true }))
    },
    async saveFileOverRead(path: string, next: string, read: string, options: SaveFileOptions = {}) {
      judge(path)
      return real(() => ws.saveFileOverRead(path, next, read, { ...options, documentOnly: true }))
    },
    removeFileOverRead(path: string, read: string): void {
      judge(path)
      ws.removeFileOverRead(path, read)
    },
    commitOnlyOver(path: string, basis: SaveBasis): () => void {
      judge(path)
      return ws.commitOnlyOver(path, basis)
    },
    async assertOnDisk(path: string, basis: SaveBasis) {
      judge(path)
      return ws.assertOnDisk(path, basis)
    },
    async createFile(path: string, content: string) {
      judge(normaliseMarkdownPath(path))
      return real(() => ws.createFile(path, content, { documentOnly: true }))
    },
    async duplicateFile(path: string) {
      judge(path) // the copy lands beside it, in the folder just judged
      return real(() => ws.duplicateFile(path, { documentOnly: true }))
    },
    async createFolder(path: string) {
      judge(path, 'folder')
      return ws.createFolder(path)
    },
    async renameFolder(path: string, newName: string) {
      judge(path, 'folder')
      judge(join(dirname(path), newName), 'folder')
      return real(() => ws.renameFolder(path, newName, { documentOnly: true }))
    },
    renameTarget(path: string, newPath: string): string {
      judge(path)
      const target = ws.renameTarget(path, newPath)
      judge(ws.relative(target))
      return target
    },
    async renameFile(path: string, newPath: string) {
      judge(path)
      judge(ws.relative(ws.renameTarget(path, newPath)))
      return real(() => ws.renameFile(path, newPath, { documentOnly: true }))
    },
    async saveImage(bytes: Uint8Array, ext: string) {
      judge('assets', 'folder')
      return real(() => ws.saveImage(bytes, ext, { documentOnly: true }))
    },
    async saveNamedImage(bytes: Uint8Array, name: string) {
      judge('assets', 'folder')
      return real(() => ws.saveNamedImage(bytes, name, { documentOnly: true }))
    },
  }

  const workspace = new Proxy(ws, {
    get(target, property) {
      if (typeof property === 'symbol' || property === 'constructor') return Reflect.get(target, property, target)
      if (Object.hasOwn(guarded, property)) return guarded[property]
      if (PASS_THROUGH.has(property)) {
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      }
      if (!(property in target)) return undefined
      throw new Error(`Workspace.${property} is not available to agent capabilities: class it in document-only-workspace.ts first.`)
    },
    set() {
      throw new Error('The document-only Workspace cannot be modified.')
    },
  })
  return { workspace, refusals }
}
