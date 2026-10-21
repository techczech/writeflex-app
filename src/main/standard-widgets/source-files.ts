/**
 * The CSV and JSON files a record browser in a document may read (the workbench's Source file list): every such
 * file in the document's Folio folder, or, for a document in no Folio, in its own folder (the folder a create
 * would make the Folio), and in the folders below. Read-only; main process only.
 *
 * What holds:
 * - Contained: the walk starts at that folder and never leaves it. Every folder is entered only when the no-follow
 *   walk from the Workspace root finds it a real folder, and every file is listed only when the walk finds it a
 *   real file; a link (to a file or a folder, inside or outside) is never listed or followed.
 * - Hidden folders (a name starting with a dot) are skipped, and so are the files WriteFlex itself writes there
 *   (the Folio manifest and each widget's build receipt).
 * - Bounded: at most `maxFiles` files are answered and at most `maxEntries` folder entries are looked at, nearest
 *   folders first, and folders more than eight levels down are not entered; `truncated` says when a bound left
 *   anything out.
 */
import { readdirSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { MANIFEST_NAME } from '../../shared/folio-constants'
import { folioContaining } from '../folio-place'
import { walkNoFollowSync } from '../widget-file'
import { assertRelativeWorkspacePath, isHiddenWorkspacePath, type Workspace } from '../workspace'
import { VISUALISATIONS_DIR, WIDGET_RECEIPT_NAME } from './build'

export const SOURCE_LIST_MAX_FILES = 200
export const SOURCE_LIST_MAX_ENTRIES = 5000
const MAX_DEPTH = 8
const DATA_FILE = /\.(csv|json)$/i

export type SourceFileListing =
  | { ok: true; /** The folder listed (workspace-relative; '' is the Workspace folder). */ folder: string; files: string[]; truncated: boolean }
  | { ok: false; message: string }

const inFolder = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)

/** Whether `path` is a file WriteFlex writes for itself in a widget's Folio folder, never a source. */
function ownFile(bundle: string, path: string): boolean {
  if (path === inFolder(bundle, MANIFEST_NAME)) return true
  const parts = path.split('/')
  return parts.at(-1) === WIDGET_RECEIPT_NAME && parts.at(-3) === VISUALISATIONS_DIR
}

export async function listStandardWidgetSources(ws: Workspace, documentPath: string, limits: { maxFiles?: number; maxEntries?: number } = {}): Promise<SourceFileListing> {
  try { assertRelativeWorkspacePath(documentPath) } catch { return { ok: false, message: 'The document must be a path inside the open Workspace.' } }
  if (isHiddenWorkspacePath(documentPath)) return { ok: false, message: `${documentPath} is in a hidden folder.` }
  const maxFiles = limits.maxFiles ?? SOURCE_LIST_MAX_FILES
  const maxEntries = limits.maxEntries ?? SOURCE_LIST_MAX_ENTRIES
  const folio = await folioContaining(ws, documentPath)
  const parent = posix.dirname(documentPath) === '.' ? '' : posix.dirname(documentPath)
  const bundle = folio ? folio.dir : parent
  const realRoot = await realpath(ws.root)
  if (bundle !== '' && walkNoFollowSync(realRoot, bundle).kind !== 'directory') return { ok: false, message: `${bundle} is not a real folder of the open Workspace.` }

  const files: string[] = []
  let entries = 0
  let truncated = false
  let tooDeep = false
  // Breadth first, names sorted: nearer files first, and the same answer every time.
  let level: string[] = [bundle]
  for (let depth = 0; level.length > 0 && !truncated; depth += 1) {
    const next: string[] = []
    for (const dir of level) {
      let names: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>
      try { names = readdirSync(join(realRoot, ...dir.split('/').filter(Boolean)), { withFileTypes: true }) } catch { continue }
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of names) {
        if (entries >= maxEntries || files.length >= maxFiles) { truncated = true; break }
        entries += 1
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const path = inFolder(dir, entry.name)
        // The dirent's word is not trusted: the no-follow walk from the root decides what the entry is.
        const walked = walkNoFollowSync(realRoot, path)
        if (walked.kind === 'directory') {
          if (depth + 1 < MAX_DEPTH) next.push(path)
          else tooDeep = true
        } else if (walked.kind === 'file' && DATA_FILE.test(entry.name) && !ownFile(bundle, path) && !isHiddenWorkspacePath(path)) files.push(path)
      }
      if (truncated) break
    }
    level = next
  }
  return { ok: true, folder: bundle, files, truncated: truncated || tooDeep }
}
