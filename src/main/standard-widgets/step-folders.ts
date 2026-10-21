/**
 * The folders a widget step makes, and their removal on undo or rollback (moved out of operations.ts so the
 * own-folder step shares them): a folder is the step's only while the no-follow walk finds the very folder that
 * was made (device and inode), and only that very folder, empty, is ever removed.
 */
import { lstatSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { walkNoFollowSync } from '../widget-file'

/** The identity of `folder` (workspace-relative, '' for the Workspace folder), walked without following anything. */
export function folderIdentity(realRoot: string, folder: string): { dev: number; ino: number } | null {
  if (folder === '') {
    try { const info = lstatSync(realRoot); return info.isDirectory() ? { dev: info.dev, ino: info.ino } : null } catch { return null }
  }
  const walked = walkNoFollowSync(realRoot, folder)
  return walked.kind === 'directory' ? { dev: walked.dev, ino: walked.ino } : null
}

/** A folder a step made, with the identity it had when made: only that very folder is ever removed. */
export type MadeFolder = { path: string; dev: number; ino: number }

/** TEST-ONLY: run just after a folder is made (and its identity read), or just after a source edit is checked (and its
 *  folder's identity read), to swap a folder on the way in the race. */
export const operationSeams: {
  afterMakeFolder?: (folder: string) => void
  afterSourceCheck?: (file: string) => void
  /** After a document (or the data file) is copied to its new place (its old name is removed only at the end). */
  afterMoveWrite?: (from: string, to: string) => void
  /** After everything but the removal of the old names is done, just before the step's last part. */
  beforeRemovingOriginals?: () => void
  /** After a moved file's old name is removed, in the step's last part (the commit point). */
  afterOriginalRemoved?: (from: string) => void
  /** Just before a step's put-back (rollback, undo or clean-up) writes or removes `path`. */
  beforePutBack?: (path: string) => void
} = {}

export const LEFT_FOLDER = 'it could not be checked to be the folder WriteFlex made, so it was not removed'

/** Remove the folders a step made, deepest first, each only when empty and only when the no-follow walk finds the
 *  very folder that was made (same device and inode). Answers the made folders that could not be checked so: a
 *  link or another folder now stands on the way, so the one made is somewhere WriteFlex will not reach. */
export function removeMadeFolders(realRoot: string, folders: readonly MadeFolder[]): Array<{ path: string; reason: string }> {
  const left: Array<{ path: string; reason: string }> = []
  for (const folder of [...folders].reverse()) {
    const walked = walkNoFollowSync(realRoot, folder.path)
    if (walked.kind === 'missing') continue
    if (walked.kind !== 'directory' || walked.dev !== folder.dev || walked.ino !== folder.ino) {
      left.push({ path: folder.path, reason: LEFT_FOLDER })
      continue
    }
    try { rmdirSync(join(realRoot, ...folder.path.split('/'))) } catch { /* not empty: not the step's to remove */ }
  }
  return left
}

/** A folder was made but could not be checked to be where it was meant to go; it is left, never removed. */
export class FolderLeftBehind extends Error {
  constructor(readonly folder: string) { super(`${folder} changed while it was being made.`) }
}

/** Make `folder` (one level, its parent already a real folder), or accept it when it is a real folder. Answers the
 *  folder's identity, for the writes into it to check in the tick of their commits. A folder this call makes is
 *  the step's only when the no-follow walk then finds that very folder (its device and inode as read at the make);
 *  otherwise nothing is removed (the path may now lead anywhere) and the folder is named as left behind. */
export function ensureFolder(realRoot: string, folder: string, made: MadeFolder[]): { dev: number; ino: number } {
  const walked = walkNoFollowSync(realRoot, folder)
  if (walked.kind === 'directory') return { dev: walked.dev, ino: walked.ino }
  if (walked.kind !== 'missing' || !walked.last) throw new Error(`${folder} is not a real folder, so WriteFlex will not put a widget there.`)
  const absolute = join(realRoot, ...folder.split('/'))
  mkdirSync(absolute)
  let created: { dev: number; ino: number } | null = null
  try {
    const info = lstatSync(absolute)
    if (info.isDirectory()) created = { dev: info.dev, ino: info.ino }
  } catch { /* gone already: not checked, so not ours to remove */ }
  operationSeams.afterMakeFolder?.(folder)
  const now = walkNoFollowSync(realRoot, folder)
  if (!created || now.kind !== 'directory' || now.dev !== created.dev || now.ino !== created.ino) throw new FolderLeftBehind(folder)
  made.push({ path: folder, ...created })
  return created
}
