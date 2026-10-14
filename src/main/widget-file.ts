/**
 * Reading a widget's file so that what is read is the file that passed containment
 * (interactive-widgets-in-documents, security round 3).
 *
 * `resolveWidget` checks a pathname; a pathname can change before it is opened (a folder on the way
 * swapped for a symlink to somewhere outside the workspace, the file itself swapped). So the file is
 * opened first and the open descriptor is what gets checked: after opening, every component of the
 * resolved real path is examined again from the workspace's real root without following anything
 * (each must be a real folder, the last a real file), and the last one must be the very file the
 * descriptor holds (same device and inode). A swap before the open makes the descriptor a different
 * file than the one inside; a swap after it does not matter, the descriptor is already open. The
 * bytes are then read from the descriptor.
 */
import { open, realpath } from 'node:fs/promises'
import { constants, lstatSync } from 'node:fs'
import { join, sep } from 'node:path'
import { assertRelativeWorkspacePath } from './workspace'
import { resolveWidget, type WidgetResolution } from './widgets'

/** macOS (11+): the kernel refuses the open if any path component is a symlink. Not in fs.constants. It cannot be
 *  combined with O_NOFOLLOW (the kernel answers EINVAL), and it already refuses a symlink in the last component,
 *  so on Darwin it is used alone. */
const O_NOFOLLOW_ANY = 0x20000000
/** The one no-follow open flag, to be OR-ed into any open of a workspace path that must not pass through a link
 *  (reading a widget here; creating one in widget-create.ts). Never add O_NOFOLLOW beside it on Darwin. */
export const OPEN_NOFOLLOW = process.platform === 'darwin' ? O_NOFOLLOW_ANY : constants.O_NOFOLLOW
const OPEN_FLAGS = constants.O_RDONLY | OPEN_NOFOLLOW

/** Larger pages are refused rather than copied across IPC into a frame. */
export const WIDGET_MAX_BYTES = 16 * 1024 * 1024

export type WidgetFileRefusal = Exclude<WidgetResolution, { ok: true }>['reason'] | 'too-large' | 'changed'
export type WidgetFileRead =
  | { ok: true; bytes: Buffer; relativePath: string }
  | { ok: false; reason: WidgetFileRefusal }

/** TEST-ONLY: run between resolving the path and opening it (to swap a folder in the race). */
let pauseBeforeOpen: (() => Promise<void>) | null = null
export function setWidgetFilePauseForTest(pause: (() => Promise<void>) | null): void { pauseBeforeOpen = pause }

/** What stands at a workspace-relative path when nothing on the way is followed. */
export type NoFollowWalk =
  | { kind: 'file' | 'directory'; dev: number; ino: number }
  /** `depth` is the index of the first component that does not exist (the last index: only the leaf is missing). */
  | { kind: 'missing'; depth: number; last: boolean }
  /** A component is a symlink, a non-folder stands where a folder is needed, the leaf is neither file nor folder,
   *  or the path is empty or carries `.` / `..`. */
  | { kind: 'refused' }

/**
 * THE no-follow walk: every component of `relativePath` (`/` separators) under `realRoot` is examined with lstat,
 * so a symlink anywhere, the leaf included, is refused rather than resolved. Used to verify an open descriptor
 * (readWidgetFile below, writeWidgetFile in widget-create.ts) and to decide where a new widget may go.
 */
export function walkNoFollowSync(realRoot: string, relativePath: string): NoFollowWalk {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '..' || part === '.' || part.includes('\0'))) return { kind: 'refused' }
  let at = realRoot
  for (let i = 0; i < parts.length; i += 1) {
    at = join(at, parts[i])
    let info: ReturnType<typeof lstatSync>
    try { info = lstatSync(at) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', depth: i, last: i === parts.length - 1 }
      return { kind: 'refused' }
    }
    if (info.isSymbolicLink()) return { kind: 'refused' }
    if (i < parts.length - 1) {
      if (!info.isDirectory()) return { kind: 'refused' }
      continue
    }
    if (info.isFile()) return { kind: 'file', dev: info.dev, ino: info.ino }
    if (info.isDirectory()) return { kind: 'directory', dev: info.dev, ino: info.ino }
  }
  return { kind: 'refused' }
}

/** The same walk for callers already in async code. One implementation: the synchronous one above, which the
 *  widget write needs so that nothing can happen between its permission read and its syscalls. */
export async function walkNoFollow(realRoot: string, relativePath: string): Promise<NoFollowWalk> {
  return walkNoFollowSync(realRoot, relativePath)
}

/** Whether the file at `relativePath` under `realRoot`, walked without following anything, is the file
 *  identified by `dev` / `ino`. */
async function sameFileInside(realRoot: string, relativePath: string, dev: number, ino: number): Promise<boolean> {
  const walked = await walkNoFollow(realRoot, relativePath)
  return walked.kind === 'file' && walked.dev === dev && walked.ino === ino
}

/** Resolve, open, verify the open file, and read it. */
export async function readWidgetFile(root: string, documentPath: string, rawPath: string): Promise<WidgetFileRead> {
  assertRelativeWorkspacePath(documentPath)
  const resolved = await resolveWidget(root, documentPath, rawPath)
  if (!resolved.ok) return resolved
  let realRoot: string
  try { realRoot = await realpath(root) } catch { return { ok: false, reason: 'missing' } }
  if (!resolved.absolutePath.startsWith(realRoot + sep)) return { ok: false, reason: 'outside-workspace' }
  if (pauseBeforeOpen) await pauseBeforeOpen()
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(resolved.absolutePath, OPEN_FLAGS)
    const info = await handle.stat()
    if (!info.isFile()) return { ok: false, reason: 'not-html' }
    if (!(await sameFileInside(realRoot, resolved.relativePath, info.dev, info.ino).catch(() => false))) return { ok: false, reason: 'changed' }
    if (info.size > WIDGET_MAX_BYTES) return { ok: false, reason: 'too-large' }
    const bytes = await handle.readFile()
    if (bytes.byteLength > WIDGET_MAX_BYTES) return { ok: false, reason: 'too-large' }
    return { ok: true, bytes, relativePath: resolved.relativePath }
  } catch {
    return { ok: false, reason: 'missing' }
  } finally {
    await handle?.close().catch(() => {})
  }
}
