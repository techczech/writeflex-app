/**
 * The one way a document is written when its path came from somewhere other than the writer's own
 * open editor: the command line's direct writes (cli/guarded-fs.ts `writeWhole`), an accepted Change,
 * and the in-app agent's capabilities (workspace.ts `saveFile` with `documentOnly`). It closes the gap
 * between judging a path and writing it:
 *
 * - A file is never written in place. Its bytes go to a new temporary file beside it, opened so that
 *   a link at that name is refused, and the real location of the file that was actually opened is
 *   compared with the folder judged a moment before. A folder swapped for a link in between puts the
 *   temporary file somewhere else, which is seen and refused before a byte is written.
 * - The file then takes its name by a hard link (a new file: fails if the name is taken) or a rename
 *   (a rewrite), addressed through the folder's real path, never through the typed one.
 * - A final link is never followed: a document that is itself a link is refused.
 * - A rewrite can carry the fingerprint of the bytes its new text was worked out from (`expect`).
 *   The file standing at the name is then read through one no-follow handle immediately before the
 *   rename, and the write is refused (`changed`) when its bytes are not those: nothing is written.
 *
 * What cannot be closed from Node: it has no way to act relative to an open folder, so between the
 * last check and the link or rename a part of the REAL path could still be replaced, and another
 * program could rewrite the file in the instant between the fingerprint check and the rename. The
 * path used there held no link when it was checked. Writers inside this app cannot get into that
 * instant: they are serialised by the Collection's write turn (collection-write-turn.ts).
 *
 * The same limit applies to removing the temporary file after a failed or finished write. It is removed only if
 * the file at its name has the device and inode it was created with, which narrows the window but does not close
 * it: a file put at that name between that check and the unlink can be removed. A temporary file that cannot be
 * removed is named: in the refusal of a failed write, and in `GuardedWriteResult.leftover` of a committed one.
 */
import { constants, realpathSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { assertCollectionWritable } from './collection-write-gate'
import { isHiddenFolderName } from './document-path'
import type { Workspace } from './workspace'

/**
 * The identity of the one folder a write is allowed to land in (its real path, device and inode), pinned by a
 * caller that authorised that folder and then awaited something before writing (folio-details.ts). The guarded
 * write refuses (`swapped`) unless the folder it resolves is that one, and checks it again, synchronously, just
 * before the call that commits.
 */
export type FolderIdentity = { real: string; dev: number; ino: number }

/** Whether the folder at real path `folder` is, at this instant, the pinned one. Follows links: a swapped-in link
 *  resolves to another folder's device and inode. */
export function isPinnedFolder(folder: string, pinned: FolderIdentity): boolean {
  if (folder !== pinned.real) return false
  try {
    const now = statSync(folder)
    return now.isDirectory() && now.dev === pinned.dev && now.ino === pinned.ino
  } catch {
    return false
  }
}

/** @internal Test seams: both run inside a write, never in production. */
export type WriteSeams = {
  /** Before anything is checked for the write of `path`. */
  beforeWrite?: (path: string) => Promise<void>
  /** After the path has been judged, before the file is opened or moved. */
  betweenCheckAndWrite?: (path: string) => Promise<void>
  /** After the bytes are staged in the judged folder, before the file takes its name. */
  afterStage?: (path: string) => Promise<void>
}

/** What a committed write reports. `leftover`: the sentence naming the temporary file that could not be removed
 *  after a create committed by a hard link. It is a second name for the new document (changing it changes the
 *  document), so the caller shows it; the write itself succeeded. */
export type GuardedWriteResult = { leftover?: string }

/** What `beforeCommit` is told: the real folder (links resolved when the path was judged) that the file takes its
 *  name in. A caller that holds a folder's identity checks it here, so a folder swapped for a link and back between
 *  the judging and the commit is seen. */
export type CommitTarget = { folder: string }

/** @internal The seams of a `documentOnly` save in the app (the command line passes its own). */
export const documentSaveSeams: WriteSeams = {}

export type GuardedWriteCode = 'outside' | 'hidden' | 'is-a-link' | 'exists' | 'not-a-file' | 'no-folder' | 'swapped' | 'changed'

/** Why a guarded write wrote nothing. `code` is stable; each caller says it in its own words. */
export class GuardedWriteRefused extends Error {
  override readonly name = 'GuardedWriteRefused'
  constructor(readonly code: GuardedWriteCode, readonly path: string) {
    super({
      outside: `${path} is outside this Collection.`,
      hidden: `${path} is in a folder WriteFlex keeps for itself or hides from the sidebar.`,
      'is-a-link': `${path} is a link, not a document of its own, so it was not written.`,
      exists: `${path} already exists.`,
      'not-a-file': `${path} is not an existing file.`,
      'no-folder': `The folder for ${path} does not exist.`,
      swapped: `${path} was not written: its folder changed while it was being saved (a link now stands where the folder was).`,
      changed: `${path} changed while it was being saved, so nothing was written.`,
    }[code])
  }
}

type GuardedWorkspace = Pick<Workspace, 'root' | 'classifyPath' | 'absolute'>

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
/** A disk that has no hard links answers a link with one of these. */
export const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])

/** Whether `realDir` (links resolved) is the Collection root or a folder the sidebar shows inside it. */
export function isDocumentFolder(ws: Pick<Workspace, 'root'>, realDir: string): boolean {
  const rel = relative(realpathSync(ws.root), realDir)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
  return !rel.split(sep).filter(Boolean).some(isHiddenFolderName)
}

/** The real location of the folder holding `absolute`, or why it cannot be written into. */
export async function realDocumentParent(ws: Pick<Workspace, 'root'>, absolute: string): Promise<{ real: string } | { refused: 'no-folder' | 'swapped' }> {
  let real: string
  try {
    real = await realpath(dirname(absolute))
  } catch {
    return { refused: 'no-folder' }
  }
  return isDocumentFolder(ws, real) ? { real } : { refused: 'swapped' }
}

/** The identity of the staged file, taken from its open handle when it was created. */
type StagedId = { dev: number; ino: number }

/** The sentence naming a temporary file a failed write could not remove, keyed by the error that reports it. */
const leftovers = new WeakMap<object, string>()

/** The sentence naming the temporary file the failed write that threw `error` left behind, if it left one. */
export function leftoverNote(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? leftovers.get(error) : undefined
}

/** `said` (a caller's own words for the failure `from`), naming after its reason the temporary file `from` left
 *  behind, if any. */
export function carryLeftover<E>(said: E, from: unknown): E {
  const note = leftoverNote(from)
  if (!note || !(said instanceof Error) || leftovers.has(said)) return said
  said.message = `${said.message} ${note}`
  leftovers.set(said, note)
  return said
}

/** Removes the file at `at` only if it is still the staged file `id`, so a different file found standing at that
 *  name (its folder was moved and another put in its place) is left. Narrowed, not eliminated: Node has no
 *  unlinkat, so a file put at the name between the check and the unlink can be removed. Whether it was removed. */
async function removeStaged(at: string, id: StagedId): Promise<boolean> {
  try {
    const there = await lstat(at)
    if (!there.isFile() || there.dev !== id.dev || there.ino !== id.ino) return false
    await unlink(at)
    return true
  } catch {
    return false
  }
}

/**
 * `error`, once the staged file at `at` is removed. When it cannot be (its folder was moved, so the name no longer
 * holds it), the error names the file and the folder it was last known in, after its own reason, so the leftover is
 * not silent. The disk is not searched for the moved folder.
 */
async function cleanUpStaged(error: unknown, at: string, id: StagedId): Promise<unknown> {
  if (await removeStaged(at, id)) return error
  const note = `A temporary file it left, ${basename(at)}, could not be removed; it is in the folder last known as ${dirname(at)}.`
  const reported = typeof error === 'object' && error !== null ? error : new Error(String(error))
  if (reported instanceof Error) reported.message = `${reported.message} ${note}`
  leftovers.set(reported, note)
  return reported
}

/** Refuses unless the ordinary file standing at `final` is `standing` and its bytes have `fingerprint`. */
async function assertUnchanged(final: string, standing: { ino: number; dev: number }, fingerprint: string, path: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    throw new GuardedWriteRefused('changed', path)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== standing.ino || opened.dev !== standing.dev) throw new GuardedWriteRefused('changed', path)
    const hash = createHash('sha256').update(await handle.readFile()).digest('hex')
    if (hash !== fingerprint) throw new GuardedWriteRefused('changed', path)
  } finally {
    await handle.close()
  }
}

/**
 * Write `content` whole to the document at Collection-relative `path`. `create` refuses a name that
 * is taken; `replace` refuses anything but an existing ordinary file, and keeps its permissions. The
 * folder must exist. `expect` (a rewrite only) refuses unless the file's bytes still have that
 * fingerprint. `inFolder` refuses (`swapped`) unless the file lands in that pinned folder. `beforeCommit` runs,
 * synchronously, just before the file takes its name (told the real folder it takes it in): nothing is
 * awaited between it and the system call that commits. On a disk without hard links it runs twice
 * (before the link that fails, and again before the rename), so it must be safe to repeat. Throws
 * `GuardedWriteRefused` when nothing was written for a reason of its own. Returns `leftover` when a create
 * committed but its temporary file could not be removed.
 */
export async function writeDocumentGuarded(
  ws: GuardedWorkspace,
  path: string,
  content: string | Uint8Array,
  mode: 'create' | 'replace',
  options: { seams?: WriteSeams; expect?: { fingerprint: string }; beforeCommit?: (target: CommitTarget) => void; inFolder?: FolderIdentity } = {},
): Promise<GuardedWriteResult> {
  const seams = options.seams ?? {}
  const pinned = options.inFolder
  // Runs with the caller's `beforeCommit`, in the same tick as the commit: the folder is still the pinned one,
  // and the caller is told the real folder the file takes its name in.
  const commitCheck = (): void => {
    if (pinned && !isPinnedFolder(folder, pinned)) throw new GuardedWriteRefused('swapped', path)
    options.beforeCommit?.({ folder })
  }
  assertCollectionWritable(ws.root)
  const verdict = ws.classifyPath(path, 'file')
  if (verdict !== 'document') throw new GuardedWriteRefused(verdict, path)
  const absolute = ws.absolute(path)
  const existing = await lstat(absolute).catch(() => null)
  if (existing?.isSymbolicLink()) throw new GuardedWriteRefused('is-a-link', path)
  if (mode === 'create' && existing) throw new GuardedWriteRefused('exists', path)
  if (mode === 'replace' && !existing?.isFile()) throw new GuardedWriteRefused('not-a-file', path)
  // Bytes worked out from a document that is not there now are not written as a new one.
  if (mode === 'create' && options.expect) throw new GuardedWriteRefused('changed', path)
  const parent = await realDocumentParent(ws, absolute)
  if ('refused' in parent) throw new GuardedWriteRefused(parent.refused, path)
  const folder = parent.real
  if (pinned && !isPinnedFolder(folder, pinned)) throw new GuardedWriteRefused('swapped', path)
  await seams.betweenCheckAndWrite?.(path)

  const staged = `${absolute}.${randomUUID().slice(0, 8)}.tmp`
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, existing ? existing.mode & 0o777 : 0o644)
  let realStaged: string | null = null
  // The staged file's own identity, from its open handle: cleanup removes a file at its name only if it is this one.
  let stagedId: StagedId | null = null
  try {
    // Where did the file that was just opened really land? Trust nothing but the open handle.
    const opened = await handle.stat()
    stagedId = { dev: opened.dev, ino: opened.ino }
    const landed = await realpath(staged)
    const there = await lstat(landed)
    if (there.ino !== opened.ino || there.dev !== opened.dev) throw new GuardedWriteRefused('swapped', path)
    realStaged = landed
    if (dirname(landed) !== folder) throw new GuardedWriteRefused('swapped', path)
    await handle.writeFile(content)
    await handle.sync().catch(() => {})
  } catch (error) {
    await handle.close().catch(() => {})
    throw realStaged && stagedId ? await cleanUpStaged(error, realStaged, stagedId) : error
  }
  await handle.close()
  const id: StagedId = stagedId
  try { await seams.afterStage?.(path) } catch (error) { throw await cleanUpStaged(error, realStaged, id) }

  const final = join(folder, basename(absolute))
  try {
    if (mode === 'replace') {
      const standing = await lstat(final)
      if (!standing.isFile()) throw new GuardedWriteRefused('swapped', path)
      if (options.expect) await assertUnchanged(final, standing, options.expect.fingerprint, path)
      commitCheck()
      await rename(realStaged, final)
      return {}
    }
    commitCheck()
    try {
      await link(realStaged, final)
      // The document has its name: the staged name is a second link to it, removed only while it is still that file.
      // If it cannot be removed the write still succeeded, and the leftover name is reported.
      if (await removeStaged(realStaged, id)) return {}
      return { leftover: `${path} was saved, but its temporary file ${basename(realStaged)} could not be removed from ${folder}. It is a second name for the same document, so changing it changes the document: delete it.` }
    } catch (error) {
      if (!NO_HARD_LINKS.has(errorCode(error) ?? '')) throw error
      // No hard links on this disk (the link wrote nothing): the name is checked free, and then
      // `beforeCommit` runs again, so that nothing is awaited between it and the rename that commits.
      if (await lstat(final).catch(() => null)) throw new GuardedWriteRefused('exists', path)
      commitCheck()
      await rename(realStaged, final)
      return {}
    }
  } catch (error) {
    throw await cleanUpStaged(errorCode(error) === 'EEXIST' ? new GuardedWriteRefused('exists', path) : error, realStaged, id)
  }
}
