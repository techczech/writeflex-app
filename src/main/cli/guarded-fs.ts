/**
 * The command line's file primitives: write a file whole, make folders, move a file or folder, read a
 * file's bytes. Each asks the shared Collection write gate, judges the path with the Workspace's own
 * document-path rule, and then closes the gap between that check and the write. Writing a file whole
 * is the app's own guarded write (guarded-document-write.ts) and reading one its guarded read
 * (guarded-document-read.ts), each said here in the command line's words:
 *
 * - A file is never written in place. Its bytes go to a new temporary file beside it, opened so that
 *   a link at that name is refused, and the real location of the file that was actually opened is
 *   compared with the folder judged a moment before. A folder swapped for a link in between puts the
 *   temporary file somewhere else, which is seen and refused before a byte is written.
 * - The file then takes its name by a hard link (a new file: fails if the name is taken) or a rename
 *   (a rewrite), addressed through the folder's real path, never through the typed one.
 * - A final link is never followed: a document that is itself a link is refused.
 * - A file is read through ONE handle, opened without following a final link; the opened file is
 *   judged (an ordinary file, really at a document path) and the bytes come from that handle, never
 *   from the name again.
 *
 * What cannot be closed from Node: it has no way to act relative to an open folder, so between the
 * last check and the link or rename a part of the REAL path could still be replaced. The path used
 * there held no link when it was checked.
 */
import { lstat, mkdir, realpath, rmdir, stat, unlink } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { assertCollectionWritable } from '../collection-write-gate'
import { type PathKind } from '../document-path'
import { DocumentReadRefused, readDocumentBytesGuarded } from '../guarded-document-read'
import { GuardedMoveRefused, moveDocumentGuarded, type PathIdentity } from '../guarded-document-move'
import { GuardedWriteRefused, carryLeftover, isDocumentFolder, realDocumentParent, writeDocumentGuarded, type GuardedWriteResult, type WriteSeams } from '../guarded-document-write'
import type { Workspace } from '../workspace'
import { CliError } from './operation'

export type { WriteSeams } from '../guarded-document-write'
export type { PathIdentity } from '../guarded-document-move'

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

const swapped = (path: string): CliError =>
  new CliError(`${path} was not written: its folder changed while the command was running (a link now stands where the folder was).`)

/**
 * A rewrite refused because, at the moment before the rename, the file no longer held the bytes of the
 * fingerprint the caller checked (`expect`): somebody wrote it since. Nothing was written.
 */
export class ChangedSinceChecked extends CliError {
  constructor(readonly path: string) {
    super(`${path} changed while it was being saved, so nothing was written.`)
  }
}

const outside = (ws: Workspace, path: string): CliError => new CliError(`${path} is outside the Collection at ${ws.root}.`)
const hidden = (path: string): CliError => new CliError(`${path} is under a dot-folder or an ignored folder, which is not part of the Collection.`)

/** The absolute form of a Collection-relative path the sidebar would show, or a refusal. */
export function documentPath(ws: Workspace, path: string, kind: PathKind): string {
  const verdict = ws.classifyPath(path, kind)
  if (verdict === 'outside') throw outside(ws, path)
  if (verdict === 'hidden') throw hidden(path)
  return ws.absolute(path)
}

/** The real location of the folder holding `absolute`, which must be a folder the sidebar shows. */
async function realParent(ws: Workspace, absolute: string, path: string): Promise<string> {
  const parent = await realDocumentParent(ws, absolute)
  if ('real' in parent) return parent.real
  throw parent.refused === 'no-folder' ? new CliError(`The folder for ${path} does not exist.`) : swapped(path)
}

/**
 * The bytes of a document, read through one handle that does not follow a final link: what is judged
 * is the file that was opened, and the bytes come from it. A link put at the name after the path was
 * judged is refused; a folder above it swapped for a link is seen in the opened file's real location.
 */
export async function readBytes(ws: Workspace, path: string, seams: WriteSeams = {}): Promise<Buffer> {
  documentPath(ws, path, 'file')
  try {
    const between = seams.betweenCheckAndWrite
    return (await readDocumentBytesGuarded(ws, path, between ? { beforeOpen: () => between(path) } : {})).bytes
  } catch (error) {
    if (!(error instanceof DocumentReadRefused)) throw error
    if (error.code === 'missing') throw new CliError(`${path} does not exist.`)
    if (error.code === 'is-a-link') throw new CliError(`${path} is a link; the command line does not read or write through a linked file.`)
    if (error.code === 'is-a-folder' || error.code === 'not-a-file') throw new CliError(`${path} is not a file.`)
    if (error.code === 'not-a-document' || error.code === 'moved') throw new CliError(`${path} was not read: its folder changed while the command was running (a link now stands in its path).`)
    throw new CliError(error.message)
  }
}

/**
 * Write `content` whole to `path`. `create` refuses a name that is taken; `replace` refuses anything
 * but an existing ordinary file, and keeps its permissions. The folder must exist (makeFolders). With
 * `expect` (a rewrite), the file must still hold the bytes of that fingerprint, or nothing is written.
 */
export async function writeWhole(ws: Workspace, path: string, content: string | Uint8Array, mode: 'create' | 'replace', seams: WriteSeams = {}, expect?: { fingerprint: string }): Promise<GuardedWriteResult> {
  try {
    // Written, but perhaps with `leftover`: the caller says it (write-session.ts), never as a failure.
    return await writeDocumentGuarded(ws, path, content, mode, { seams, ...(expect ? { expect } : {}) })
  } catch (error) {
    // In the command line's words, still naming any temporary file the write could not remove.
    throw carryLeftover(writeRefusal(ws, path, error), error)
  }
}

function writeRefusal(ws: Workspace, path: string, error: unknown): unknown {
  if (!(error instanceof GuardedWriteRefused)) return error
  if (error.code === 'outside') return outside(ws, path)
  if (error.code === 'hidden') return hidden(path)
  if (error.code === 'is-a-link') return new CliError(`${path} is a link; the command line does not write through a linked file.`)
  if (error.code === 'exists') return new CliError(`${path} already exists.`)
  if (error.code === 'not-a-file') return new CliError(`${path} is not an existing file.`)
  if (error.code === 'no-folder') return new CliError(`The folder for ${path} does not exist.`)
  if (error.code === 'swapped') return swapped(path)
  if (error.code === 'changed') return new ChangedSinceChecked(path)
  return new CliError(error.message)
}

/**
 * Make `path` and any missing folders above it. Returns the folders it created, outermost first. A
 * link to an ordinary folder inside the Collection is walked through; a link elsewhere is refused.
 */
export async function makeFolders(ws: Workspace, path: string): Promise<string[]> {
  if (path === '') return []
  assertCollectionWritable(ws.root)
  const absolute = documentPath(ws, path, 'folder')
  const segments = relative(ws.root, absolute).split(sep).filter(Boolean)
  const created: string[] = []
  const undo = async (): Promise<void> => {
    for (const made of [...created].reverse()) await rmdir(join(ws.root, made)).catch(() => {})
  }
  try {
    for (let depth = 1; depth <= segments.length; depth++) {
      const current = segments.slice(0, depth).join('/')
      const here = join(ws.root, ...segments.slice(0, depth))
      if ((await stat(here).catch(() => null))?.isDirectory()) continue
      if (await lstat(here).catch(() => null)) throw new CliError(`${current} exists and is not a folder.`)
      await mkdir(here)
      created.push(current)
    }
    if (!isDocumentFolder(ws, await realpath(absolute))) throw swapped(path)
  } catch (error) {
    await undo()
    throw error
  }
  return created
}

/**
 * Move a file or a folder to a free name: the app's guarded move (guarded-document-move.ts), said in
 * the command line's words. The folder to move into must exist. Renaming a file to the same name in
 * another letter case is allowed on a disk that ignores case. With `expect`, what stands at `from`
 * must be that very file or folder (device and inode), or nothing is moved.
 */
export async function movePath(ws: Workspace, from: string, to: string, kind: PathKind, seams: WriteSeams = {}, expect?: PathIdentity): Promise<void> {
  try {
    await moveDocumentGuarded(ws, from, to, kind, { seams, ...(expect ? { expect } : {}) })
  } catch (error) {
    if (!(error instanceof GuardedMoveRefused)) throw error
    const { code, path } = error
    if (code === 'outside') throw outside(ws, path)
    if (code === 'hidden') throw hidden(path)
    if (code === 'missing') throw new CliError(`${path} does not exist.`)
    if (code === 'is-a-link') throw new CliError(`${path} is a link; the command line does not move links.`)
    if (code === 'no-folder') throw new CliError(`The folder for ${path} does not exist.`)
    if (code === 'swapped') throw swapped(from)
    throw new CliError(error.message)
  }
}

/** The identity of the folder at `path` (not a link), or null when no folder stands there. */
export async function folderIdentity(ws: Workspace, path: string): Promise<PathIdentity | null> {
  const info = await lstat(documentPath(ws, path, 'folder')).catch(() => null)
  return info?.isDirectory() ? { dev: info.dev, ino: info.ino } : null
}

/** The real path of an existing file or folder to hand to the Trash; refuses a link. */
export async function realPathForTrash(ws: Workspace, path: string, kind: PathKind, seams: WriteSeams = {}): Promise<string> {
  assertCollectionWritable(ws.root)
  const absolute = documentPath(ws, path, kind)
  const info = await lstat(absolute).catch(() => null)
  if (!info) throw new CliError(`${path} does not exist.`)
  if (info.isSymbolicLink()) throw new CliError(`${path} is a link; the command line does not move links to the Trash.`)
  await seams.betweenCheckAndWrite?.(path)
  const real = join(await realParent(ws, absolute, path), basename(absolute))
  const again = await lstat(real).catch(() => null)
  if (!again || again.isSymbolicLink() || again.ino !== info.ino || again.dev !== info.dev) throw swapped(path)
  return real
}

/**
 * Remove `extra` when it is a second name of the ordinary file at `kept` (same file, two names): what
 * a file move leaves when it is stopped between linking the new name and removing the old. Refuses
 * anything else, so it can never remove the only name of a file.
 */
export async function dropSecondName(ws: Workspace, extra: string, kept: string, seams: WriteSeams = {}): Promise<void> {
  assertCollectionWritable(ws.root)
  const absoluteExtra = documentPath(ws, extra, 'file')
  const absoluteKept = documentPath(ws, kept, 'file')
  await seams.betweenCheckAndWrite?.(extra)
  const folder = await realParent(ws, absoluteExtra, extra)
  const real = join(folder, basename(absoluteExtra))
  const [one, other] = await Promise.all([lstat(real).catch(() => null), lstat(absoluteKept).catch(() => null)])
  if (!one?.isFile() || !other?.isFile() || one.ino !== other.ino || one.dev !== other.dev || one.nlink < 2 || real === join(await realParent(ws, absoluteKept, kept), basename(absoluteKept))) {
    throw new CliError(`${extra} is not a second name of ${kept}; it was left alone.`)
  }
  await unlink(real)
}
