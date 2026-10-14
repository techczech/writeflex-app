/**
 * Finding widgets to insert (interactive-widgets-in-documents, ticket 05). Two reads, no writes:
 * the HTML files in a document's folder and below it (the Insert widget… picker), and what a file
 * dropped on the text is (inside the workspace and HTML, or refused). Containment is the one rule
 * of wf-asset.ts; nothing here opens a widget file.
 */
import { readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { containWorkspacePath } from './wf-asset'
import { relativeEmbedPath } from '../shared/widget-insert'
import type { WidgetIpcRegistrar } from './widget-ipc'

export type WidgetChoice = { name: string; /** Folder from the document's folder, '' when beside it. */ directory: string; /** What the embed line carries. */ rawPath: string }
export type WidgetChoices = { folder: string; files: WidgetChoice[]; truncated: boolean }
/** widgets.insert's `file`: a workspace-relative path to an HTML file that really is inside the workspace. */
export async function resolveWidgetFileForInsert(root: string, file: string): Promise<{ ok: true; relativePath: string } | { ok: false; message: string }> {
  const raw = file.trim()
  if (/^(?:[a-z][a-z0-9+.-]+:|\/\/)/i.test(raw)) return { ok: false, message: 'A web address cannot be a widget; only an HTML file in the open Workspace can.' }
  const contained = await containWorkspacePath(root, isAbsolute(raw) ? relative(root, raw) : raw)
  if (!contained.ok) return { ok: false, message: contained.reason === 'outside' ? 'That file is outside the open Workspace, so WriteFlex will not run it.' : `${raw} does not exist in the open Workspace.` }
  if (!HTML.test(extname(contained.realPath)) || !(await stat(contained.realPath).then((info) => info.isFile(), () => false))) return { ok: false, message: 'A widget must be an .html file.' }
  return { ok: true, relativePath: toPosix(relative(await realpath(root), contained.realPath)) }
}

export type WidgetDropResult = { ok: true; rawPath: string } | { ok: false; reason: 'outside-workspace' | 'not-html' | 'missing' }

const MAX_FILES = 300
const MAX_DEPTH = 8
const SKIP = new Set(['node_modules'])
const HTML = /^\.html?$/i
const toPosix = (path: string): string => path.split(sep).join('/')

export async function listWidgetChoices(root: string, documentPath: string): Promise<WidgetChoices> {
  const realRoot = await realpath(root)
  const documentRel = isAbsolute(documentPath) ? relative(realRoot, documentPath) : documentPath
  const folderAbs = dirname(resolve(root, documentRel))
  const folderRel = relative(root, folderAbs)
  const folder = folderRel === '' ? basename(root) : basename(folderAbs)
  const found: WidgetChoice[] = []
  let truncated = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (found.length >= MAX_FILES) { truncated = true; return }
      if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { if (depth < MAX_DEPTH) await walk(abs, depth + 1); continue }
      if (!(entry.isFile() || entry.isSymbolicLink()) || !HTML.test(extname(entry.name))) continue
      // A link must still land inside the workspace and on a file.
      const contained = await containWorkspacePath(root, relative(root, abs))
      if (!contained.ok || !(await stat(contained.realPath).then((info) => info.isFile(), () => false))) continue
      const fromFolder = toPosix(relative(folderAbs, abs))
      found.push({ name: entry.name, directory: toPosix(dirname(fromFolder)) === '.' ? '' : toPosix(dirname(fromFolder)), rawPath: fromFolder })
    }
  }
  const contained = await containWorkspacePath(root, folderRel || '.')
  if (contained.ok) await walk(folderAbs, 0)
  return { folder, files: found, truncated }
}

/** A file dropped on the text: `absolutePath` is what the OS says the file is. */
export async function resolveWidgetDrop(root: string, documentPath: string, absolutePath: string): Promise<WidgetDropResult> {
  if (!isAbsolute(absolutePath) || absolutePath.includes('\0')) return { ok: false, reason: 'missing' }
  const realRoot = await realpath(root).catch(() => null)
  if (!realRoot) return { ok: false, reason: 'missing' }
  const real = await realpath(absolutePath).catch(() => null)
  if (!real) return { ok: false, reason: 'missing' }
  const rel = relative(realRoot, real)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { ok: false, reason: 'outside-workspace' }
  if (!HTML.test(extname(real)) || !(await stat(real).then((info) => info.isFile(), () => false))) return { ok: false, reason: 'not-html' }
  const documentRel = isAbsolute(documentPath) ? toPosix(relative(realRoot, documentPath)) : documentPath
  return { ok: true, rawPath: relativeEmbedPath(documentRel, toPosix(rel)) }
}

const text = (input: unknown, key: string): string => {
  const value = (input as Record<string, unknown> | null | undefined)?.[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\0')) throw new Error(`Invalid widget request: ${key} is missing.`)
  return value
}

export function registerWidgetInsertHandlers(ipc: WidgetIpcRegistrar, deps: { workspaceRootFor: (event: { sender: { id: number } }) => string }): void {
  ipc.handle('widget:list-choices', (event, input) => listWidgetChoices(deps.workspaceRootFor(event), text(input, 'documentPath')))
  ipc.handle('widget:resolve-drop', (event, input) => resolveWidgetDrop(deps.workspaceRootFor(event), text(input, 'documentPath'), text(input, 'absolutePath')))
}
