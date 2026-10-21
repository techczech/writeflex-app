/**
 * The one way a document or a folder of documents changes its name when the path came from somewhere
 * other than the writer's own hand in the sidebar: the command line's moves (cli/guarded-fs.ts
 * `movePath`) and the in-app agent's renames (workspace.ts `renameFile` and `renameFolder` with
 * `documentOnly`). It is the move's counterpart of the guarded write (guarded-document-write.ts) and
 * closes the same gap, between judging a path and acting on it:
 *
 * - what stands at the old name is looked at without following a link (a link is never moved), and
 *   must be of the kind asked for; with `expect` it must be that very file or folder;
 * - the folders holding the old and the new name are resolved to their real locations, which must be
 *   folders the sidebar shows, before and again after the last wait; from there on both names are
 *   addressed through those real folders, never through the typed path;
 * - immediately before the move, what stands at the old name must still be the same file or folder
 *   (device and inode) that was judged;
 * - a FILE takes its new name by a hard link, which fails when the name is taken, and only then
 *   loses its old one: a move never replaces a file. (On a disk without hard links the name is
 *   looked at once more and the file renamed.) A FOLDER is renamed; the system refuses a name that
 *   holds a folder with anything in it.
 *
 * What cannot be closed from Node: it has no way to act relative to an open folder, so between the
 * last check and the link or rename a part of the REAL path could still be replaced; and a folder
 * renamed onto a name where an EMPTY folder appeared in that instant takes its place (nothing is in
 * an empty folder to lose). Only a program on this Mac can do either.
 */
import { link, lstat, rename, unlink } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { assertCollectionWritable } from './collection-write-gate'
import type { PathKind } from './document-path'
import { NO_HARD_LINKS, realDocumentParent, type WriteSeams } from './guarded-document-write'
import type { Workspace } from './workspace'

export type GuardedMoveCode = 'outside' | 'hidden' | 'missing' | 'is-a-link' | 'wrong-kind' | 'not-the-same' | 'into-itself' | 'exists' | 'no-folder' | 'swapped'

/** Why a guarded move moved nothing. `path` is the name the reason is about; each caller says it in its own words. */
export class GuardedMoveRefused extends Error {
  override readonly name = 'GuardedMoveRefused'
  constructor(readonly code: GuardedMoveCode, readonly path: string, readonly kind: PathKind) {
    super({
      outside: `${path} is outside this Collection.`,
      hidden: `${path} is in a folder WriteFlex keeps for itself or hides from the sidebar.`,
      missing: `${path} does not exist.`,
      'is-a-link': `${path} is a link, so it was not moved.`,
      'wrong-kind': `${path} is not a ${kind}.`,
      'not-the-same': `${path} is not the ${kind} it was a moment ago (it was replaced), so it was not moved.`,
      'into-itself': 'A folder cannot be moved into itself.',
      exists: `${path} already exists.`,
      'no-folder': `The folder for ${path} does not exist.`,
      swapped: `${path} was not moved: its folder changed meanwhile (a link now stands where the folder was).`,
    }[code])
  }
}

type GuardedWorkspace = Pick<Workspace, 'root' | 'classifyPath' | 'absolute'>

/** Which file or folder a name stands for: its device and inode, which a rename keeps and a replacement does not. */
export type PathIdentity = { dev: number; ino: number }

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Move the file or folder at Collection-relative `from` to the free name `to`. The folder to move
 * into must exist. Renaming to the same name in another letter case is allowed on a disk that ignores
 * case. `beforeCommit` runs, synchronously, just before the name changes, with nothing awaited between
 * it and that system call; on a disk without hard links it runs twice (before the link that fails and
 * again before the rename), so it must be safe to repeat. Throws `GuardedMoveRefused`
 * when nothing was moved for a reason of its own.
 */
export async function moveDocumentGuarded(
  ws: GuardedWorkspace,
  from: string,
  to: string,
  kind: PathKind,
  options: { seams?: WriteSeams; expect?: PathIdentity; beforeCommit?: () => void } = {},
): Promise<void> {
  assertCollectionWritable(ws.root)
  const judged = (path: string): string => {
    const verdict = ws.classifyPath(path, kind)
    if (verdict !== 'document') throw new GuardedMoveRefused(verdict, path, kind)
    return ws.absolute(path)
  }
  const absoluteFrom = judged(from)
  const absoluteTo = judged(to)
  const source = await lstat(absoluteFrom).catch(() => null)
  if (!source) throw new GuardedMoveRefused('missing', from, kind)
  if (source.isSymbolicLink()) throw new GuardedMoveRefused('is-a-link', from, kind)
  if (kind === 'file' ? !source.isFile() : !source.isDirectory()) throw new GuardedMoveRefused('wrong-kind', from, kind)
  if (options.expect && (source.ino !== options.expect.ino || source.dev !== options.expect.dev)) throw new GuardedMoveRefused('not-the-same', from, kind)
  if (kind === 'folder' && (to === from || to.startsWith(`${from}/`))) throw new GuardedMoveRefused('into-itself', from, kind)
  const target = await lstat(absoluteTo).catch(() => null)
  const caseOnly = !!target && from !== to && from.toLowerCase() === to.toLowerCase() && target.ino === source.ino && target.dev === source.dev
  if (target && !caseOnly) throw new GuardedMoveRefused('exists', to, kind)
  const realParent = async (absolute: string, path: string): Promise<string> => {
    const parent = await realDocumentParent(ws, absolute)
    if ('real' in parent) return parent.real
    throw new GuardedMoveRefused(parent.refused, path, kind)
  }
  const fromFolder = await realParent(absoluteFrom, from)
  const toFolder = await realParent(absoluteTo, to)
  await options.seams?.betweenCheckAndWrite?.(from)

  // Judged again after the gap, and addressed by the real folders from here on.
  if (await realParent(absoluteFrom, from) !== fromFolder || await realParent(absoluteTo, to) !== toFolder) throw new GuardedMoveRefused('swapped', from, kind)
  const realFrom = join(fromFolder, basename(absoluteFrom))
  const realTo = join(toFolder, basename(absoluteTo))
  const again = await lstat(realFrom).catch(() => null)
  if (!again || again.isSymbolicLink() || again.ino !== source.ino || again.dev !== source.dev) throw new GuardedMoveRefused('swapped', from, kind)
  options.beforeCommit?.()
  if (kind === 'folder' || caseOnly) {
    await rename(realFrom, realTo)
    return
  }
  try {
    // A hard link fails when the name is taken, where a rename would silently replace the file there.
    await link(realFrom, realTo)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') throw new GuardedMoveRefused('exists', to, kind)
    if (!NO_HARD_LINKS.has(errorCode(error) ?? '')) throw error
    // No hard links on this disk (the link made nothing): the name is checked free, and then
    // `beforeCommit` runs again, so that nothing is awaited between it and the rename that commits.
    if (await lstat(realTo).catch(() => null)) throw new GuardedMoveRefused('exists', to, kind)
    options.beforeCommit?.()
    await rename(realFrom, realTo)
    return
  }
  await unlink(realFrom)
}
