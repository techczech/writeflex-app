import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { containWorkspacePath } from './wf-asset'
import { scanWidgets } from '../shared/markdown/widgets'
import type { Workspace } from './workspace'

/**
 * Where an embed line's file is, and whether it may run (interactive-widgets-in-documents, ticket
 * 01). Containment is `containWorkspacePath` (wf-asset.ts), the same rule the image protocol uses;
 * this adds only the document-folder base and the widget's own refusals.
 */
export type WidgetResolution =
  | { ok: true; absolutePath: string; relativePath: string }
  | { ok: false; reason: 'missing' | 'outside-workspace' | 'not-html' | 'web-address' }

/** Anything with a scheme (`https:`, `file:`, `data:`) or a protocol-relative `//host` is not a local path. */
const WEB_ADDRESS = /^(?:[a-z][a-z0-9+.-]+:|\/\/)/i

/**
 * `documentPath` is the document's path, workspace-relative or absolute. `relativePath` in the
 * result is the real file's path from the workspace root, with `/` separators.
 */
export async function resolveWidget(workspaceRoot: string, documentPath: string, rawPath: string): Promise<WidgetResolution> {
  const raw = rawPath.trim()
  if (WEB_ADDRESS.test(raw)) return { ok: false, reason: 'web-address' }
  const base = dirname(resolve(workspaceRoot, documentPath))
  const contained = await containWorkspacePath(workspaceRoot, relative(workspaceRoot, resolve(base, raw)) || '.')
  if (!contained.ok) return { ok: false, reason: contained.reason === 'outside' ? 'outside-workspace' : 'missing' }
  if (!/^\.html?$/i.test(extname(contained.realPath))) return { ok: false, reason: 'not-html' }
  // A directory named `x.html` is not a page.
  if (!(await stat(contained.realPath).then((info) => info.isFile(), () => false))) return { ok: false, reason: 'not-html' }
  const realRoot = await realpath(workspaceRoot)
  return { ok: true, absolutePath: contained.realPath, relativePath: relative(realRoot, contained.realPath).split('\\').join('/') }
}

/** What the agent sees of a resolution: workspace-relative paths only, never a host path. */
export type WidgetListingResolution = { ok: true; relativePath: string } | { ok: false; reason: Exclude<WidgetResolution, { ok: true }>['reason'] }

export type WidgetListing = {
  path: string
  widgets: Array<{ ordinal: number; source: string; path: string; resolution: WidgetListingResolution }>
}

export async function listWidgetsInFile(workspace: Workspace, path: string): Promise<WidgetListing> {
  let file: Awaited<ReturnType<Workspace['readFile']>>
  try {
    file = await workspace.readFile(path)
  } catch (error) {
    // The filesystem's own message carries the host path; the agent gets the workspace path only.
    const message = error instanceof Error ? error.message : ''
    const shown = isAbsolute(path) ? relative(workspace.root, path) : path
    if (/outside the open Workspace/.test(message) || shown === '..' || shown.startsWith('../')) throw new Error('Path is outside the open Workspace.')
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT' || /File not found/.test(message)) throw new Error(`${shown} does not exist in the open Workspace.`)
    throw new Error(`${shown} could not be read.`)
  }
  const widgets = await Promise.all(scanWidgets(file.content).map(async (entry) => {
    const resolved: WidgetResolution = entry.refusal
      ? { ok: false, reason: entry.refusal }
      : await resolveWidget(workspace.root, file.file.path, entry.path)
    const resolution: WidgetListingResolution = resolved.ok ? { ok: true, relativePath: resolved.relativePath } : resolved
    return { ordinal: entry.ordinal, source: entry.source, path: entry.path, resolution }
  }))
  return { path: file.file.path, widgets }
}
