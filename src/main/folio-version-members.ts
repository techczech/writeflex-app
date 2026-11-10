/**
 * Which files a Folio version holds (ADR-0052 § What a Folio version holds). Read only: it writes
 * nothing and takes no lock.
 *
 *   index       the Index Note
 *   part        the parts in running order (the Folio workspace's own order, `readFolioPlan`)
 *   unlisted    the Markdown files in the Folio folder that are not in the outline: exactly the
 *               set the Folio workspace lists as "Not in the outline" (ADR-0046), less anything in
 *               `data/`, `research/`, `assets/`, `offcuts/`, `archive/` or another support folder, and
 *               anything in a hidden folder (the bin, `.writeflex/`, `.bridle/`)
 *   inserted    files the text EMBEDS: a widget line (`[Simulation: path]`) or an image / embed
 *               (`![alt](path)`), wherever they sit (a table in `data/`, an image in `assets/`, a
 *               widget page). Inserted files follow the insert, not the folder.
 *   reference   files the text only LINKS to (`[words](path)` to a local file that is not Markdown):
 *               listed with their sha256 and not kept
 *
 * THE RULE FOR "INSERTED". WriteFlex has one embed syntax for files today, the image/embed form and the
 * widget line. A bare Markdown link is a link. A quotation copied from `research/` is text and needs
 * nothing. A Markdown file the text links to is a cross-reference, not a member. This module only
 * decides which paths to look at; the save looks at the files (type, size, bytes).
 *
 * Electron-free.
 */
import { posix } from 'node:path'
import { readDocument, type Block, type Inline } from '../shared/markdown/model'
import { folioDeclaration } from './folio-declaration'
import { indexNotePath } from './folio'
import { readFolioPlan } from './plan'
import { isHiddenWorkspacePath, type Workspace } from './workspace'

export type FolioFileRole = 'index' | 'part' | 'unlisted' | 'inserted' | 'linked'
export type FolioFileRef = { role: FolioFileRole; path: string; title?: string; order?: number }
export type GatheredFolio = {
  /** The Folio's folder (Collection-relative; '' is the Collection root). */
  dir: string
  indexPath: string
  /** In the order the version records them: Index Note, parts in running order, unlisted, inserted, linked. */
  files: FolioFileRef[]
  /** Parts of the running order that have no file to save (unwritten, or their file is missing). */
  notWritten: Array<{ title: string; why: string }>
  /** For each inserted file, the Folio's Markdown files whose text inserts it (the change cues put a Binder dot on those parts). */
  insertedBy: Record<string, string[]>
}

/** Raised for a Folio that cannot be saved as it stands; the message is for the person. */
export class FolioGatherRefused extends Error {
  override readonly name = 'FolioGatherRefused'
}

/** Folders whose files are never "not in the outline": the five support folders (ADR-0052) and the Folio room's own. */
const SUPPORT_FOLDERS = new Set(['data', 'research', 'assets', 'offcuts', 'archive', 'source', 'sources', 'notes', 'archives', 'feedback', 'scraps'])
const MARKDOWN = /\.(md|markdown)$/i
/** More files than this in one Folio version is refused: a Folio this size is not what the save is for. */
export const MAX_FOLIO_VERSION_FILES = 2000

const webAddress = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i

/** The Collection-relative path a local link or embed names from the document `from`, or null (a web address, a fragment, a path that leaves the Collection or enters a hidden folder). */
export function localTarget(from: string, raw: string): string | null {
  let target = raw.trim()
  if (target === '' || target.startsWith('#') || webAddress.test(target)) return null
  target = target.split('#')[0].split('?')[0]
  if (target === '') return null
  try { target = decodeURIComponent(target) } catch { /* keep the spelling as typed */ }
  if (target.startsWith('/') || target.includes('\\') || target.includes('\0')) return null
  const folder = posix.dirname(from) === '.' ? '' : posix.dirname(from)
  const joined = posix.normalize(folder === '' ? target : posix.join(folder, target))
  if (joined === '.' || joined === '..' || joined.startsWith('../') || joined.endsWith('/')) return null
  if (isHiddenWorkspacePath(joined)) return null
  return joined
}

/** What a document's text embeds and what it only links to, as raw targets in document order. */
export function insertedAndLinked(markdown: string): { embedded: string[]; linked: string[] } {
  const embedded: string[] = []
  const linked: string[] = []
  const inlines = (items: readonly Inline[]): void => {
    for (const inline of items) {
      if (inline.kind === 'image') embedded.push(inline.src)
      else if (inline.kind === 'link') { linked.push(inline.href); inlines(inline.children) }
      else if (inline.kind === 'emphasis' || inline.kind === 'strong' || inline.kind === 'strike' || inline.kind === 'mark') inlines(inline.children)
    }
  }
  const blocks = (items: readonly Block[]): void => {
    for (const block of items) {
      if (block.kind === 'heading' || block.kind === 'paragraph') inlines(block.children)
      else if (block.kind === 'quote') blocks(block.children)
      else if (block.kind === 'list') for (const item of block.items) blocks(item.children)
      else if (block.kind === 'table') { for (const cell of block.header) inlines(cell); for (const row of block.rows) for (const cell of row) inlines(cell) }
      else if (block.kind === 'widget' && !block.refusal) embedded.push(block.path)
    }
  }
  blocks(readDocument(markdown).blocks)
  return { embedded, linked }
}

/** Whether a Folio-relative location is inside a support folder (any segment below the Folio's folder). */
function inSupportFolder(dir: string, path: string): boolean {
  const below = dir === '' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path
  return below.split('/').slice(0, -1).some((segment) => SUPPORT_FOLDERS.has(segment.toLowerCase()))
}

/**
 * The files of the Folio at `dir`. Throws `FolioGatherRefused` when `dir` is not a Folio, has no Index
 * Note file yet (a Folio's identity is its Index Note's history), or its running order has a link that
 * names two files (the version would not say which it holds).
 */
export async function gatherFolio(ws: Workspace, dir: string, options: { /** Default true. False leaves the files not in the outline out (and any file only their text inserts); the save sheet's tick box. */ includeUnlisted?: boolean } = {}): Promise<GatheredFolio> {
  if (!folioDeclaration(ws, dir).isFolio) throw new FolioGatherRefused(`${dir === '' ? 'The Collection folder' : dir} is not a Folio, so there is no Folio version to save.`)
  const plan = await readFolioPlan(ws, dir)
  if (!plan) throw new FolioGatherRefused(`${dir === '' ? 'The Collection folder' : dir} is not a Folio, so there is no Folio version to save.`)
  const indexPath = indexNotePath(ws, dir)
  if (plan.indexNoteAbsent) throw new FolioGatherRefused(`This Folio has no Index Note file yet, and a Folio version is kept under its Index Note. Open the Folio's outline in WriteFlex to create it, then save the version.`)
  const ambiguous = plan.parts.filter((part) => part.resolution === 'ambiguous')
  if (ambiguous.length > 0) throw new FolioGatherRefused(`The running order has ${ambiguous.length === 1 ? 'a link that names' : 'links that name'} more than one file (${ambiguous.map((part) => `"${part.title}"`).join(', ')}), so a Folio version would not say which file it holds. Repair the link${ambiguous.length === 1 ? '' : 's'} and save again.`)

  const files: FolioFileRef[] = [{ role: 'index', path: indexPath }]
  const seen = new Set<string>([indexPath])
  const notWritten: GatheredFolio['notWritten'] = []
  plan.parts.forEach((part, at) => {
    if (part.path === null || part.resolution === 'missing') { notWritten.push({ title: part.title, why: part.path === null ? 'it has no file yet' : `its file ${part.path} is missing` }); return }
    if (seen.has(part.path)) return
    seen.add(part.path)
    files.push({ role: 'part', path: part.path, title: part.title, order: at + 1 })
  })
  for (const part of options.includeUnlisted === false ? [] : plan.unlisted) {
    const path = part.path
    if (path === null || seen.has(path) || !MARKDOWN.test(path) || isHiddenWorkspacePath(path) || inSupportFolder(dir, path)) continue
    seen.add(path)
    files.push({ role: 'unlisted', path, title: part.title })
  }

  // Inserted and linked files, found in the text of the Markdown files above.
  const inserted: FolioFileRef[] = []
  const linked: FolioFileRef[] = []
  const insertedBy: Record<string, string[]> = {}
  for (const member of [...files]) {
    let content: string
    try { content = (await ws.readFile(member.path)).content } catch { continue }
    const found = insertedAndLinked(content)
    for (const raw of found.embedded) {
      const path = localTarget(member.path, raw)
      if (path === null) continue
      if (!seen.has(path)) { seen.add(path); inserted.push({ role: 'inserted', path }) }
      if (inserted.some((file) => file.path === path)) {
        const by = insertedBy[path] ?? []
        if (!by.includes(member.path)) by.push(member.path)
        insertedBy[path] = by
      }
    }
    for (const raw of found.linked) {
      const path = localTarget(member.path, raw)
      // A link to Markdown is a cross-reference; only a link to some other local file is a reference member.
      if (path === null || seen.has(path) || MARKDOWN.test(path)) continue
      seen.add(path)
      linked.push({ role: 'linked', path })
    }
  }
  const all = [...files, ...inserted, ...linked]
  if (all.length > MAX_FOLIO_VERSION_FILES) throw new FolioGatherRefused(`This Folio has more than ${MAX_FOLIO_VERSION_FILES} files to keep, which is more than a Folio version holds. Nothing was saved.`)
  return { dir, indexPath, files: all, notWritten, insertedBy }
}
