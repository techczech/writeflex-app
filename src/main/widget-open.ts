/**
 * "Open file" on a widget's caption bar (interactive-widgets-in-documents, ticket 03): show the widget's
 * HTML in the default browser.
 *
 * Security round 3: no workspace pathname is ever handed to the browser (a path checked now can point
 * elsewhere by the time the browser opens it). The file is read through a verified descriptor exactly as
 * for running it (widget-file.ts), and those bytes are written to a fresh file in a private folder of the
 * app's (0700, removed when the app quits); that copy is what the browser opens. A page that loads
 * siblings by relative address will not find them there: the copy is for reading the widget's source.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readWidgetFile } from './widget-file'
import type { WidgetIpcRegistrar } from './widget-ipc'

let privateFolder: Promise<string> | null = null
let madeFolder: string | null = null
/** The app's private folder for opened copies, made on first use (mkdtemp: 0700, a unique name). */
function copiesFolder(base = tmpdir()): Promise<string> {
  if (!privateFolder) privateFolder = mkdtemp(join(base, 'writeflex-widget-open-')).then((folder) => { madeFolder = folder; return folder })
  return privateFolder
}

/** Remove every copy (tests; the app uses the synchronous form when it quits). */
export async function removeOpenedWidgetCopies(): Promise<void> {
  const folder = privateFolder
  privateFolder = null
  madeFolder = null
  if (folder) await rm(await folder, { recursive: true, force: true }).catch(() => {})
}

/** Remove every copy now (on quit). */
export function removeOpenedWidgetCopiesSync(): void {
  const folder = madeFolder
  privateFolder = null
  madeFolder = null
  if (folder) { try { rmSync(folder, { recursive: true, force: true }) } catch { /* nothing left to do */ } }
}

export async function openWidgetFile(
  root: string,
  documentPath: string,
  rawPath: string,
  openExternal: (url: string) => void,
): Promise<{ ok: boolean }> {
  const read = await readWidgetFile(root, documentPath, rawPath)
  if (!read.ok) return { ok: false }
  const folder = await copiesFolder()
  const name = `${randomBytes(8).toString('hex')}-${basename(read.relativePath).replace(/[^\w.-]/g, '_')}`
  const copy = join(folder, name)
  // A fresh name, created here: never an existing file, never a link.
  await writeFile(copy, read.bytes, { mode: 0o600, flag: 'wx' })
  openExternal(pathToFileURL(copy).href)
  return { ok: true }
}

export function registerWidgetOpenHandler(
  ipc: WidgetIpcRegistrar,
  deps: { workspaceRootFor: (event: { sender: { id: number } }) => string; openExternal: (url: string) => void },
): void {
  ipc.handle('widget:open-file', async (event, input) => {
    const record = (input ?? {}) as Record<string, unknown>
    const documentPath = record.documentPath
    const rawPath = record.rawPath
    if (typeof documentPath !== 'string' || typeof rawPath !== 'string' || !documentPath || !rawPath || rawPath.length > 4096 || rawPath.includes('\0')) {
      throw new Error('Invalid widget request: the document and path are required.')
    }
    return openWidgetFile(deps.workspaceRootFor(event), documentPath, rawPath, deps.openExternal)
  })
}
