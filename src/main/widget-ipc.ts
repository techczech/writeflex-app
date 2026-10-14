/**
 * The one channel that hands a widget's HTML to the renderer (interactive-widgets-in-documents,
 * ticket 02). The renderer names the document and the path as typed in its embed line; main resolves
 * it inside the window's workspace with `resolveWidget` (ticket 01: containment, symlinks, HTML only)
 * and reads the real file. Nothing is written; nothing outside the workspace is read.
 */
import type { WidgetResolution } from './widgets'
import { readWidgetFile, WIDGET_MAX_BYTES } from './widget-file'
import { widgetPageTitle } from '../shared/widget-document'
import { claimWidgetKeyboardOwner } from './widget-keyboard'
import { widgetLexicalPath, resolveWidgetWatchTarget, type createWidgetWatches } from './widget-watch'

export { WIDGET_MAX_BYTES }
const PATH_MAX = 4096

export type WidgetReadRefusal = Exclude<WidgetResolution, { ok: true }>['reason'] | 'too-large'
export type WidgetReadResult =
  | { ok: true; html: string; relativePath: string; title: string }
  | { ok: false; reason: WidgetReadRefusal }

type IpcEvent = { sender: { id: number } }
export type WidgetIpcRegistrar = { handle: (channel: string, handler: (event: IpcEvent, input: unknown) => unknown) => void }

function field(input: unknown, key: string): string {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > PATH_MAX || value.includes('\0')) throw new Error(`Invalid widget request: ${key} is missing.`)
  return value
}

/** Read a widget for a document of the workspace at `root`: through a verified descriptor (widget-file.ts). */
export async function readWidget(root: string, documentPath: string, rawPath: string): Promise<WidgetReadResult> {
  const read = await readWidgetFile(root, documentPath, rawPath)
  if (!read.ok) return { ok: false, reason: read.reason === 'changed' ? 'missing' : read.reason }
  const html = read.bytes.toString('utf8')
  return { ok: true, html, relativePath: read.relativePath, title: widgetPageTitle(html) }
}

export function registerWidgetIpcHandlers(ipc: WidgetIpcRegistrar, deps: { workspaceRootFor: (event: IpcEvent) => string; watches?: ReturnType<typeof createWidgetWatches> }): void {
  ipc.handle('widget:read', async (event, input) => {
    const documentPath = field(input, 'documentPath')
    const rawPath = field(input, 'rawPath')
    return readWidget(deps.workspaceRootFor(event), documentPath, rawPath)
  })
  // Whether one of the window's widgets is engaged: keys may then go to the focused widget frame.
  // The top frame only (ipc-main-frame-only.ts); main checks a press claim against a real press it saw.
  // A widget file the workspace watcher ignores (a hidden or build folder) gets a watch of its own while a
  // block shows it (widget-watch.ts). Only a folder whose real location is inside the workspace is watched.
  ipc.handle('widget:watch', async (event, input) => {
    const path = widgetLexicalPath(field(input, 'documentPath'), field(input, 'rawPath'))
    if (!path || !deps.watches) return { watching: false }
    const target = await resolveWidgetWatchTarget(deps.workspaceRootFor(event), path)
    if (!target) return { watching: false }
    return { watching: deps.watches.watch(event.sender.id, path, target) }
  })
  ipc.handle('widget:unwatch', (event, input) => {
    const path = widgetLexicalPath(field(input, 'documentPath'), field(input, 'rawPath'))
    if (path) deps.watches?.unwatch(event.sender.id, path)
  })
  ipc.handle('widget:keyboard-owner', async (event, input) => ({ accepted: await claimWidgetKeyboardOwner(event.sender.id, input) }))
}
