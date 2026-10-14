/**
 * Focus a folder (ticket 03, frame D4). The focus is a VIEW state inside one window: a
 * workspace-relative folder path that narrows the Files tree and scopes search. It is never a second
 * root binding — the window's Workspace root is unchanged — and it is owned by main: the live value
 * sits on the window's state, the persisted copy on the root's recents entry (SettingsStore), which is
 * the record that reopens the root. Nothing here reaches localStorage.
 *
 * Every renderer-supplied path is validated here before it is kept or written: relative, no `..`,
 * inside the Workspace guard, an existing directory the file walk can see.
 */

import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { collectionCoverPaths, readManifest } from './folio'
import type { SettingsStore } from './settings'
import type { Workspace } from './workspace'

/** What the focused folder is, for the Search switch's label: a Folio ("This folio"), a folder with
 *  an Index Note or other recognised cover ("This collection"), or a plain folder ("This folder"). */
export type FolderFocusKind = 'folio' | 'collection' | 'folder'
export type FolderFocus = { path: string; kind: FolderFocusKind }

type FocusWorkspace = Pick<Workspace, 'root' | 'absolute' | 'isVisiblePath' | 'readFile'>
type FocusSettings = Pick<SettingsStore, 'folderFocus' | 'setFolderFocus'>

/**
 * Validate a renderer-supplied focus path into its stored form (no leading/trailing slash). Throws on
 * anything that is not a plain workspace-relative path. `''` (the root) is not a focus: the caller
 * clears instead.
 */
export function normaliseFocusPath(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Folder focus must be a workspace-relative path.')
  const trimmed = input.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '' || input.trim().startsWith('/')) throw new Error('Folder focus must be a workspace-relative path.')
  const normalised = posix.normalize(trimmed)
  if (normalised === '.' || normalised === '..' || normalised.startsWith('../') || normalised !== trimmed) {
    throw new Error('Folder focus must be a workspace-relative path.')
  }
  return normalised
}

/** Whether `path` names an existing, walk-visible folder inside the Workspace (guard included). */
export function isFocusableFolder(ws: FocusWorkspace, path: string): boolean {
  try {
    if (!ws.isVisiblePath(`${path}/file.md`)) return false
    return statSync(ws.absolute(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(ws: FocusWorkspace, path: string): Promise<boolean> {
  try {
    return (await stat(ws.absolute(path))).isFile()
  } catch {
    return false
  }
}

/** Folio first (a manifest is a deliberate declaration), then any recognised cover, else a folder. */
export async function folderFocusKind(ws: FocusWorkspace, path: string): Promise<FolderFocusKind> {
  if (await readManifest(ws, path)) return 'folio'
  for (const cover of collectionCoverPaths(ws, path)) if (await isFile(ws, cover)) return 'collection'
  return 'folder'
}

/**
 * The focus a freshly bound window starts with: the root's recorded focus when that folder still
 * exists, else none. A recorded folder that has gone (deleted, renamed, or an invalid record) is
 * cleared from the record silently — the window just opens on the whole archive.
 */
export function restoreFolderFocus(settings: FocusSettings, ws: FocusWorkspace): string | null {
  const recorded = settings.folderFocus(ws.root)
  if (recorded === null) return null
  let path: string
  try {
    path = normaliseFocusPath(recorded)
  } catch {
    settings.setFolderFocus(ws.root, null)
    return null
  }
  if (isFocusableFolder(ws, path)) return path
  settings.setFolderFocus(ws.root, null)
  return null
}

/**
 * Apply a renderer's focus request: null (or the root) clears; a folder path is validated, recorded
 * on the root's entry, and returned as the new live value. Throws, changing nothing, when the path is
 * not a folder in this Workspace.
 */
export function applyFolderFocus(settings: FocusSettings, ws: FocusWorkspace, input: unknown): string | null {
  if (input === null || input === '') {
    settings.setFolderFocus(ws.root, null)
    return null
  }
  const path = normaliseFocusPath(input)
  if (!isFocusableFolder(ws, path)) throw new Error(`Not a folder in this Workspace: ${path}`)
  settings.setFolderFocus(ws.root, path)
  return path
}

/** The live focus as the renderer sees it, with its kind; null when nothing is focused. */
export async function describeFolderFocus(ws: FocusWorkspace, path: string | null): Promise<FolderFocus | null> {
  if (path === null) return null
  return { path, kind: await folderFocusKind(ws, path) }
}
