/**
 * The own-folder step of Create and insert (contracts §14 C5, all amendments; locked drawing
 * docs/design/2026-10-20-folio-on-widget-insert/). Main process only.
 *
 *   readOwnFolderFacts   what is in the document's folder, for the sheet and for the engine to carry the sheet's
 *                        plan out (shared/own-folder-plan.ts). Reads only; nothing is written.
 *   copyFileGuarded      one file to its new place inside the step: read without following a link, written as a
 *                        new file by the guarded write into the very folder made for it (never over anything);
 *   removeOriginalGuarded
 *                        its old name removed, in the step's last part only, only while it still holds what was
 *                        read and only while its folder is still the folder that was checked (both in the tick of
 *                        the unlink).
 *   retargetLinksElsewhere / repairWikilinksForMoves
 *                        the links in other Markdown files that pointed at a moved file, carried to its new place
 *                        (relative links here, wikilinks by the app's rename repair).
 * Every write goes through the Workspace inside the create step's record, so the step's rollback and its one undo
 * put all of it back.
 */
import { readdirSync, type Dirent } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { documentTitle } from '../frontmatter'
import { folioContaining } from '../folio-place'
import { rebaseRelativeLinks } from '../relative-link-rebase'
import { applyRenameRepair, planRenameRepair } from '../rename-repair'
import { readContainedFile, walkNoFollowSync } from '../widget-file'
import { assertRelativeWorkspacePath, isHiddenWorkspacePath, type Workspace } from '../workspace'
import { AGENTS_FILE_NAME, CLAUDE_FILE_NAME, folderNameFromTitle, type OwnFolderFacts } from '../../shared/own-folder-plan'
import { VISUALISATIONS_DIR, writeInWidgetFolder } from './build'
import { folderIdentity, operationSeams } from './step-folders'
import { noteBytesBefore } from './step-bytes-before'

const parentDir = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))
const inFolder = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const MARKDOWN = /\.(md|markdown)$/i
/** A document larger than this is not moved by a widget insert. */
export const MOVE_MAX_BYTES = 16 * 1024 * 1024

/** A widget folder name: lower-case letters, digits, single hyphens; at most 60 characters; `widget` when nothing is left. */
export function widgetFolderName(name: unknown, ordinal = 1): string {
  const suffix = ordinal > 1 ? `-${ordinal}` : ''
  const clean = (typeof name === 'string' ? name : '').normalize('NFKD').replace(/[^\x20-\x7e]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${(clean || 'widget').slice(0, 60 - suffix.length).replace(/-+$/g, '') || 'widget'}${suffix}`
}

/** The first free widget folder under `visualisations` (a path, '' the Workspace folder), or null after 999. */
export function freeWidgetFolder(realRoot: string, visualisations: string, name: string): string | null {
  for (let ordinal = 1; ordinal <= 999; ordinal += 1) {
    const folder = `${visualisations}/${widgetFolderName(name, ordinal)}`
    if (walkNoFollowSync(realRoot, folder).kind === 'missing') return folder
  }
  return null
}

export type OwnFolderFactsRequest = { documentPath: string; sourceFile?: string; name: string; title?: string }
/** `needed: false`: no sheet; the insert goes ahead as it is (the document is in a Folio already, or it is the
 *  only file in its folder and that folder becomes the Folio in place). */
export type OwnFolderFactsAnswer = { ok: true; needed: false } | { ok: true; needed: true; facts: OwnFolderFacts } | { ok: false; message: string }

/** What is in the document's folder, for the sheet. Reads only. */
export async function readOwnFolderFacts(ws: Workspace, request: OwnFolderFactsRequest): Promise<OwnFolderFactsAnswer> {
  const documentPath = request.documentPath
  try { assertRelativeWorkspacePath(documentPath) } catch { return { ok: false, message: 'The document must be a path inside the open Workspace.' } }
  if (!MARKDOWN.test(documentPath) || isHiddenWorkspacePath(documentPath)) return { ok: false, message: `${documentPath} is not a Markdown document in a visible folder.` }
  const realRoot = await realpath(ws.root)
  if (walkNoFollowSync(realRoot, documentPath).kind !== 'file') return { ok: false, message: `${documentPath} is not a real document in real folders of the open Workspace.` }
  if (await folioContaining(ws, documentPath)) return { ok: true, needed: false }
  const folder = parentDir(documentPath)
  if (folder !== '' && walkNoFollowSync(realRoot, folder).kind !== 'directory') return { ok: false, message: `${folder} is not a real folder of the open Workspace.` }
  const document = posix.basename(documentPath)
  let entries: Dirent[]
  try { entries = readdirSync(join(realRoot, ...folder.split('/').filter(Boolean)), { withFileTypes: true }) } catch { return { ok: false, message: `${folder || 'The Workspace folder'} could not be read.` } }
  const taken: OwnFolderFacts['taken'] = []
  const documents: string[] = []
  const files: string[] = []
  const folders: string[] = []
  for (const entry of entries) {
    const path = inFolder(folder, entry.name)
    const walked = walkNoFollowSync(realRoot, path)
    taken.push({ name: entry.name, folder: walked.kind === 'directory' })
    if (entry.name === document || entry.name.startsWith('.')) continue
    if (walked.kind === 'directory') {
      if (ws.isVisiblePath(`${path}/file.md`)) folders.push(entry.name)
    } else if (ws.isVisiblePath(path)) {
      // A link is never moved or listed as a document; it is shown where it stays.
      if (walked.kind === 'file' && MARKDOWN.test(entry.name)) documents.push(entry.name)
      else files.push(entry.name)
    }
  }
  if (documents.length === 0 && files.length === 0) return { ok: true, needed: false }
  const byName = (a: string, b: string): number => a.localeCompare(b)
  documents.sort(byName); files.sort(byName); folders.sort(byName)
  const text = (await ws.readFile(documentPath)).content
  const visualisations = inFolder(folder, VISUALISATIONS_DIR)
  const inPlaceFolder = freeWidgetFolder(realRoot, visualisations, request.name)
  let source: string | null = null
  if (typeof request.sourceFile === 'string' && request.sourceFile !== '') {
    const normal = posix.normalize(request.sourceFile)
    if (folder === '' ? !normal.startsWith('../') && normal !== '..' : normal.startsWith(`${folder}/`)) source = folder === '' ? normal : normal.slice(folder.length + 1)
  }
  const names = new Set(taken.map((entry) => entry.name))
  return {
    ok: true,
    needed: true,
    facts: {
      folder,
      folderLabel: folder === '' ? posix.basename(realRoot) : posix.basename(folder),
      document,
      documents,
      files,
      folders,
      taken,
      defaultName: folderNameFromTitle(documentTitle(text, documentPath), document),
      widgetTitle: request.title ?? request.name,
      widgetFolder: { inPlace: posix.basename(inPlaceFolder ?? widgetFolderName(request.name)), ownFolder: widgetFolderName(request.name) },
      source,
      agentFiles: { agents: names.has(AGENTS_FILE_NAME), claude: names.has(CLAUDE_FILE_NAME) },
      hasVisualisations: folders.includes(VISUALISATIONS_DIR),
    },
  }
}

/** A folder checked once, by path and identity, for the step's writes and removals to check again. */
export type CheckedFolder = { path: string; id: { dev: number; ino: number } }

export function checkedFolder(realRoot: string, path: string): CheckedFolder {
  const id = folderIdentity(realRoot, path)
  if (!id) throw new Error(`${path || 'The Workspace folder'} is not a real folder of the open Workspace, so nothing was moved.`)
  return { path, id }
}

export type GuardedCopy = {
  from: string
  to: string
  toFolder: CheckedFolder
  /** The new text from the text read (a moved document's links carried along). */
  transform?: (text: string) => string
  /** The text the caller saw: the copy refuses when the file holds anything else. */
  expected?: string
  /** The text to write in place of the file's own (an edited data file); the file must still hold `expected`. */
  replacement?: string
  /** Called with the original's bytes after they are read and before the copy is written (the step journal notes
   *  the original's evidence there, so a copy never exists without it). */
  beforeWrite?: (read: Buffer) => void
}

/** The text of a real file reached without a link, refused when its bytes are not UTF-8 text that reads back to the
 *  same bytes (rewriting it would change bytes the writer never saw). */
async function readPlainText(realRoot: string, path: string, verb: string): Promise<string> {
  const read = await readContainedFile(realRoot, path, MOVE_MAX_BYTES)
  if (!read.ok) throw new Error(read.reason === 'missing' ? `${path} is missing, so it was not ${verb}.` : `${path} is not a real file in real folders of the open Workspace, so it was not ${verb}.`)
  const text = read.bytes.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(read.bytes)) throw new Error(`${path} is not plain text, so WriteFlex did not move it.`)
  return text
}

/** Whether `path` is a real file whose bytes are UTF-8 text that reads back to the same bytes. */
export async function isPlainTextFile(realRoot: string, path: string): Promise<boolean> {
  const read = await readContainedFile(realRoot, path, MOVE_MAX_BYTES)
  return read.ok && Buffer.from(read.bytes.toString('utf8'), 'utf8').equals(read.bytes)
}

/** Copy one text file to its new place inside a recorded step (the original is not touched; the step removes it at
 *  its end, `removeOriginalGuarded`): read without following a link, written as a new file by the guarded write
 *  into the very folder made for it (never over anything). Answers the text read and the text written. */
export async function copyFileGuarded(ws: Workspace, realRoot: string, copy: GuardedCopy): Promise<{ read: string; written: string }> {
  const text = await readPlainText(realRoot, copy.from, 'copied')
  if (copy.expected !== undefined && text !== copy.expected) throw new Error(`${copy.from} changed since it was read, so it was not moved.`)
  const written = copy.replacement ?? (copy.transform ? copy.transform(text) : text)
  // The text read round-trips UTF-8 (readPlainText), so these are the original's bytes.
  copy.beforeWrite?.(Buffer.from(text, 'utf8'))
  await writeInWidgetFolder(ws, realRoot, copy.toFolder.path, copy.toFolder.id, copy.to, written, { exclusive: true })
  operationSeams.afterMoveWrite?.(copy.from, copy.to)
  return { read: text, written }
}

/** Remove a moved file's old name, the step's commit point: in one tick, its folder is the one checked, the name is a
 *  real file, and it is removed only while it holds exactly `read` (the text the copy was made from). */
export function removeOriginalGuarded(ws: Workspace, realRoot: string, original: { from: string; fromFolder: CheckedFolder; read: string }): void {
  const now = folderIdentity(realRoot, original.fromFolder.path)
  if (!now || now.dev !== original.fromFolder.id.dev || now.ino !== original.fromFolder.id.ino) throw new Error(`${original.fromFolder.path || 'The Workspace folder'} changed while ${original.from} was being moved, so the move was stopped.`)
  if (walkNoFollowSync(realRoot, original.from).kind !== 'file') throw new Error(`${original.from} is no longer a plain file, so the move was stopped.`)
  ws.removeFileOverRead(original.from, original.read)
  operationSeams.afterOriginalRemoved?.(original.from)
}

/** Carry the relative links in every other Markdown file of the Workspace that pointed at a moved file. Answers
 *  the files rewritten, and a notice for each file left as it is because its bytes are not plain UTF-8 text (it is
 *  never rewritten: its bytes would change). Each is written only over the text read. */
export async function retargetLinksElsewhere(ws: Workspace, realRoot: string, moves: ReadonlyMap<string, string>, skip: ReadonlySet<string>, madeByStep: (path: string) => boolean = () => false): Promise<{ written: string[]; notices: string[] }> {
  const where = (path: string): string => moves.get(path) ?? path
  const written: string[] = []
  const notices: string[] = []
  for (const file of await ws.listFiles()) {
    if (skip.has(file.path) || moves.has(file.path) || madeByStep(file.path)) continue
    const read = await readContainedFile(realRoot, file.path, MOVE_MAX_BYTES)
    if (!read.ok) continue
    const text = read.bytes.toString('utf8')
    // Every Markdown file is read by the parser: a destination may name a moved file in any spelling (escapes,
    // percent-encoding), so no text search can tell which files link to one.
    const next = rebaseRelativeLinks(text, file.path, file.path, where)
    if (next.rewritten === 0 || next.text === text) continue
    if (!Buffer.from(text, 'utf8').equals(read.bytes)) { notices.push(notUpdated(file.path)); continue }
    // The bytes written over, for the step's put-back to be checked against (step-bytes-before.ts).
    noteBytesBefore(file.path, read.bytes)
    await ws.saveFile(file.path, next.text, { documentOnly: true, beforeCommit: ws.commitOnlyOver(file.path, { kind: 'disk', text }) })
    written.push(file.path)
  }
  return { written, notices }
}

export const notUpdated = (path: string): string => `Links in ${path} were not updated: it is not plain UTF-8 text, so WriteFlex did not rewrite it.`

/** The Workspace as the rename repair should see it once the moves are done: the old names of the moved files are
 *  not listed (they are still on disk until the step's last part). Every other call is the Workspace's own. */
function workspaceWithout(ws: Workspace, hidden: ReadonlySet<string>, madeByStep: (path: string) => boolean = () => false): Workspace {
  const gone = (path: string): boolean => hidden.has(path) || madeByStep(path)
  return new Proxy(ws, {
    get(target, property) {
      if (property === 'listFiles') return async () => (await target.listFiles()).filter((file) => !gone(file.path))
      if (property === 'listFilesIn') return async (dir: string, options?: { recursive?: boolean }) => (await target.listFilesIn(dir, options)).filter((file) => !gone(file.path))
      if (property === 'listFilesAndFolders') return async () => { const listed = await target.listFilesAndFolders(); return { ...listed, files: listed.files.filter((file) => !gone(file.path)) } }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** The app's rename repair (wikilinks, Plans and Folio manifests) for each moved document, planned and applied over
 *  the Workspace as it will be once the old names are removed (`hidden`). A file the repair would rewrite whose
 *  bytes are not plain UTF-8 text is left out of the repair and named. Answers what it could not repair, to be told. */
export async function repairWikilinksForMoves(ws: Workspace, realRoot: string, moves: ReadonlyArray<{ from: string; to: string }>, hidden: ReadonlySet<string>, madeByStep: (path: string) => boolean = () => false): Promise<string[]> {
  const view = workspaceWithout(ws, hidden, madeByStep)
  const notices: string[] = []
  for (const { from, to } of moves) {
    const plan = await planRenameRepair(view, from, to, { ignore: madeByStep })
    const writes = []
    for (const write of plan.writes) {
      const read = await readContainedFile(realRoot, write.path, MOVE_MAX_BYTES)
      if (read.ok && Buffer.from(read.bytes.toString('utf8'), 'utf8').equals(read.bytes)) {
        // The bytes written over, for the step's put-back to be checked against (step-bytes-before.ts).
        noteBytesBefore(write.path, read.bytes)
        writes.push(write)
      } else notices.push(notUpdated(write.path))
    }
    const repair = await applyRenameRepair({ ...plan, writes }, view)
    notices.push(...repair.unrepairedReferences)
  }
  return notices
}

export { MARKDOWN as MARKDOWN_FILE, inFolder, parentDir }
