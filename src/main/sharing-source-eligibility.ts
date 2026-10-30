// Which source a link may publish (sharing ticket 11, Sol review round 3, P1). The one rule, used by
// the Sharing page's IPC (sharing-piece-ipc.ts: what a window may name and act on), by the publisher
// at its common boundary (sharing-publisher.ts publishNow: every creation, turn on, save, retry,
// queued and resumed publish), and by a Folio's rendering for each part before it is read
// (sharing-folio.ts). A piece is a Markdown file the sidebar would show (document-path.ts, the one
// document rule), not in a support folder, both as typed and where it really lives once links
// (symlinks) are resolved, and a file on disk now. So a link put at a piece's path to a hidden file
// (`.bridle/…`), a support file (`agent-notes/…`) or a file outside the Collection is never a source.
//
// A Folio's own metadata (its manifest `_report-structure.json`, its Index Note) keeps the same rule
// before sharing reads it, without the Markdown requirement (isEligibleFolioMetadata; Sol review round
// 4 of ticket 11, P1-2): a manifest replaced by a link to `.bridle/private.json` is never read, so none
// of its content, not even the file names it lists, reaches a reader page.
//
// Accepted residual (Sol review round 4, P1-1; orchestrator ruling): the rule judges a path, and a swap
// of the file or a parent folder between the check and the asynchronous open is not closed. Planting it
// needs write access to the Collection as the same user, who could copy the hidden bytes into the piece
// anyway; the rule guards against accidental exposure (a stray or synced link). Revisit if sharing ever
// reads on behalf of a less-trusted writer that can create symlinks (an agent).
//
// No Electron import. No Folio import (sharing-folio.ts imports this module).
import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import { classifyDocumentPath, realLocation } from './document-path'
import { resolvesToRoomSupportFile } from './room-support-target'

/** A piece path a window may name: relative, inside its Workspace, a Markdown file. */
export function piecePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) return null
  if (isAbsolute(value)) return null
  const clean = normalize(value)
  if (clean === '..' || clean.startsWith('../') || clean.startsWith('..\\')) return null
  return /\.(md|markdown)$/i.test(clean) ? clean : null
}

/** Folders whose files are the app's or an agent's, never a writer's piece. */
const SUPPORT_FOLDERS = new Set(['agent-notes'])

const inSupportFolder = (rel: string): boolean => rel.split(/[\\/]/).slice(0, -1).some((segment) => SUPPORT_FOLDERS.has(segment))

/**
 * `path` (a piecePath) names a writer's piece in `root`: the sidebar's document rule, and not in a
 * support folder, both as typed and where it really lives once links are resolved (review round 2 of
 * ticket 11, P1: a link at the path to `agent-notes/` is a support file, as one to `.bridle/` is hidden).
 */
export function isSharablePiece(root: string, path: string): boolean {
  // The Folio room's evidence-and-notes and map files are never published, under any route (I-9): judged on
  // the name as requested and on the file it really opens (a part replaced by a link to the evidence file).
  return !resolvesToRoomSupportFile(root, path) && inWritersPlace(root, path)
}

/**
 * `path` (relative to `root`) is where a writer's file may be, both as typed and where it really lives
 * once links (in the file and its parent folders) are resolved: inside the Collection, no dot-folder and
 * no support folder on the way. The file's own name and extension are not judged.
 */
function inWritersPlace(root: string, path: string): boolean {
  if (inSupportFolder(path)) return false
  let realRoot: string
  try { realRoot = realpathSync.native(root) } catch { return false }
  if (classifyDocumentPath(root, realRoot, path, 'file') !== 'document') return false
  // classifyDocumentPath established the real location is inside the Collection.
  const real = realLocation(resolve(root, path))
  return real !== null && !inSupportFolder(relative(realRoot, real).split(sep).join('/'))
}

/** `path` (a piecePath) is a file on disk in `root`. */
export function isFileOnDisk(root: string, path: string): boolean {
  try { return statSync(resolve(root, path)).isFile() } catch { return false }
}

/** A piece a link may publish now: a clean piece path, a writer's piece where it really lives, on disk. */
export function isEligiblePiece(root: string, path: string): boolean {
  return piecePath(path) === path && isSharablePiece(root, path) && isFileOnDisk(root, path)
}

/** A clean relative path in a Workspace (piecePath without the Markdown requirement). */
function metadataPath(value: string): string | null {
  if (value.length === 0 || value.length > 4096 || value.includes('\0') || isAbsolute(value)) return null
  const clean = normalize(value)
  if (clean === '.' || clean === '..' || clean.startsWith('../') || clean.startsWith('..\\')) return null
  return clean
}

/**
 * A Folio's metadata file (its manifest or its Index Note, `path` relative to `root`) sharing may read
 * now: a clean path, where a writer's file may be as typed and where it really lives (no dot-folder, no
 * `agent-notes`, inside the Collection), not a Folio room support file by name or by the file a link really
 * opens, a file on disk. The metadata counterpart of isEligiblePiece: no `.md` required (Sol review round 4 of
 * ticket 11, P1-2).
 */
export function isEligibleFolioMetadata(root: string, path: string): boolean {
  return metadataPath(path) === path && !resolvesToRoomSupportFile(root, path) && inWritersPlace(root, path) && isFileOnDisk(root, path)
}
