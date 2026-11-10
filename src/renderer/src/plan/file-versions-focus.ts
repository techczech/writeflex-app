import { useSyncExternalStore } from 'react'

/**
 * Which inserted file the Inspector's file-versions panel shows for a Folio, and the commands that act on it (Folio versions ticket 19).
 *
 * The Inspector's "Inserted files" list is the one place the panel is drawn. Something else that knows a file (the cursor panel on a table the
 * cursor is on, a palette command) asks for it here: `focusFileVersions(dir, path)` records the file and the room's Inspector, which is
 * subscribed, shows its versions. A command (save a version of this file, compare, restore, save as a copy) is an event the panel answers; if
 * nothing answers (no Folio open, no file chosen) the caller tells the writer what to do first.
 */
export type FileVersionsAction = 'show' | 'save' | 'compare' | 'restore' | 'copy'
export type FileVersionsFocus = { path: string; /** Changes on every request, so asking for the same file again still acts. */ seq: number; action: FileVersionsAction }

export const FILE_VERSIONS_COMMAND_EVENT = 'writeflex:file-versions-command'
export type FileVersionsCommandDetail = { action: FileVersionsAction; handled: boolean }

const focuses = new Map<string, FileVersionsFocus>()
const listeners = new Set<() => void>()
let seq = 0

export function focusFileVersions(dir: string, path: string, action: FileVersionsAction = 'show'): void {
  seq += 1
  focuses.set(dir, { path, seq, action })
  for (const listener of [...listeners]) listener()
}
export function useFileVersionsFocus(dir: string): FileVersionsFocus | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => focuses.get(dir) ?? null)
}
/** Ask the panel to do `action` to the file it shows. True when something answered. */
export function runFileVersionsCommand(action: FileVersionsAction): boolean {
  const detail: FileVersionsCommandDetail = { action, handled: false }
  window.dispatchEvent(new CustomEvent(FILE_VERSIONS_COMMAND_EVENT, { detail }))
  return detail.handled
}
