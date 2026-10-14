/**
 * What the Outline's Folio part draws: the running order and the folder's other files, each with its
 * title and headings. Read-only. The Folio is the one `folioPlace` resolves (same rule, same cache), and
 * only files `listFilesIn(<Folio folder>)` returns are ever read, so an entry outside the Folio's folder
 * is never opened and a symlinked folder lists nothing.
 *
 * A file's headings are cached per workspace root by path, valid while its size, modified and changed times and inode are
 * unchanged. `file:changed-on-disk` and a `collection:changed` that names paths drop those entries, a workspace bind drops the root, at most
 * 2,000 files are held per root (oldest out first), a failed read is not kept, and at most 2 MB + 1 byte of a file is read. A tab switch inside one Folio therefore lists
 * the folder and reads no file for its headings that has not changed.
 *
 * Whether the Outline may change the running order (`orderInPlanOnly`) and which files Add will accept
 * (`addable`) come from `folioOrderFacts`, kept per Folio folder (folio-order-cache.ts): a tab switch inside
 * one unchanged Folio loads no Plan. "Also in this folder" is the folder's direct children plus the files the
 * Plan reports as not in the running order (for a `content_root` Folio they are in that folder), and only
 * ever files `listFilesIn(<Folio folder>)` returned.
 */

import { open, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { folioOrderFacts } from './folio-order-facts'
import { folioContaining } from './folio-place'
import { documentTitle } from './frontmatter'
import { scanText } from './jumps'
import type { Workspace } from './workspace'
import { groupAlsoInFolder, subFolderOf, type FolioOutline, type FolioOutlineFile } from '../shared/folio-outline'

/** A file with more headings than this lists the first ones only (the payload stays bounded). */
const MAX_HEADINGS_PER_FILE = 400
/** A heading's or title's text is cut to this many characters. */
const MAX_HEADING_CHARS = 200

/** Every title the reader returns goes through here, so the cap covers filename fallbacks too. */
function cappedTitle(content: string, path: string): string {
  return documentTitle(content, path).slice(0, MAX_HEADING_CHARS)
}
/** A file larger than this is not read: it lists no headings and is flagged `tooLarge`. */
export const MAX_OUTLINE_FILE_BYTES = 2 * 1024 * 1024
/** Cached files per workspace root; the oldest entry goes first. */
const MAX_CACHED_FILES = 2000
/** Files read at once. */
const READ_BATCH = 12

type Parsed = Pick<FolioOutlineFile, 'title' | 'headings' | 'tooLarge'>
type Entry = { stamp: string; parsed: Promise<Parsed | null> }
const cache = new Map<string, Map<string, Entry>>()

/** The file system the reader uses; the real one is the default, a test passes its own. */
export type OutlineHandle = {
  stat(): Promise<{ size: number }>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}
export type OutlineFs = {
  stat(absolute: string): Promise<{ size: number; mtimeMs: number; ctimeMs: number; ino: number }>
  open(absolute: string): Promise<OutlineHandle>
}
const realFs: OutlineFs = {
  stat: (absolute) => stat(absolute),
  open: async (absolute) => {
    const handle = await open(absolute, 'r')
    return {
      stat: () => handle.stat(),
      read: async (buffer, offset, length, position) => ({ bytesRead: (await handle.read(buffer, offset, length, position)).bytesRead }),
      close: () => handle.close(),
    }
  },
}

/** Workspace bind: forget a whole root. */
export function invalidateFolioOutlines(root: string): void {
  cache.delete(root)
}

/** One file changed (or was renamed, trashed, restored, created): forget only its entry. */
export function invalidateFolioOutlineFile(root: string, path: string): void {
  cache.get(root)?.delete(path)
}

/** The paths held for a root, oldest first (read-only; for tests and diagnostics). */
export function cachedFolioOutlinePaths(root: string): string[] {
  return [...(cache.get(root)?.keys() ?? [])]
}

/** Read at most the cap plus one byte of a file. Null content = it is over the cap (whatever its size was when stat'ed). */
async function readBounded(handle: OutlineHandle): Promise<string | null> {
  const info = await handle.stat()
  if (info.size > MAX_OUTLINE_FILE_BYTES) return null
  const buffer = Buffer.allocUnsafe(MAX_OUTLINE_FILE_BYTES + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
    if (bytesRead <= 0) break
    total += bytesRead
  }
  if (total > MAX_OUTLINE_FILE_BYTES) return null
  return buffer.toString('utf8', 0, total)
}

/** Read one file for its headings, within the size bound. Null when the read failed. */
async function readParsed(fs: OutlineFs, ws: Workspace, path: string): Promise<Parsed | null> {
  let handle: OutlineHandle | undefined
  try {
    handle = await fs.open(ws.absolute(path))
    const content = await readBounded(handle)
    if (content === null) return { title: cappedTitle('', path), headings: [], tooLarge: true }
    const headings: Parsed['headings'] = []
    for (const entry of scanText(content, { headings: true, headingLimit: MAX_HEADINGS_PER_FILE })) {
      if (entry.kind !== 'heading') continue
      headings.push({ level: entry.level, text: entry.text.slice(0, MAX_HEADING_CHARS), line: entry.line })
    }
    return { title: cappedTitle(content, path), headings }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** The file's stamp (size, modified and changed times, inode), or null when it cannot be stat'ed. */
async function stampOf(fs: OutlineFs, ws: Workspace, path: string): Promise<string | null> {
  try {
    const info = await fs.stat(ws.absolute(path))
    return `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}`
  } catch {
    return null
  }
}

/** Answer one file from the cache or start its read. Registers the entry synchronously, so entries enter the cache (and leave it) in the order they are asked for. */
function parsedFile(fs: OutlineFs, ws: Workspace, path: string, stamp: string | null): Promise<Parsed> {
  const empty = (): Parsed => ({ title: cappedTitle('', path), headings: [] })
  if (stamp === null) return Promise.resolve(empty())
  let byPath = cache.get(ws.root)
  if (!byPath) cache.set(ws.root, (byPath = new Map()))
  const held = byPath.get(path)
  if (held && held.stamp === stamp) return held.parsed.then((kept) => kept ?? empty())
  const map = byPath
  const entry: Entry = { stamp, parsed: readParsed(fs, ws, path) }
  map.delete(path)
  map.set(path, entry)
  while (map.size > MAX_CACHED_FILES) map.delete(map.keys().next().value as string)
  return entry.parsed.then((parsed) => {
    // A failed read is answered for this request only, never remembered.
    if (parsed) return parsed
    if (map.get(path) === entry) map.delete(path)
    return empty()
  })
}

/** Null when the path is not in a Folio. Throws for a path that is not a workspace-relative path. */
export async function folioOutline(ws: Workspace, path: string, fs: OutlineFs = realFs): Promise<FolioOutline | null> {
  const folio = await folioContaining(ws, path)
  if (!folio) return null
  const { dir } = folio
  // `folio.pieces` is `folioPieces` (the list the Plan and the export use); this lists exactly those, nested-manifest entries included.
  const listed = await ws.listFilesIn(dir)
  const byPath = new Map(listed.map((file) => [file.path, file]))
  // Whether the Outline may change this Folio's order, and which files Add will accept: the rule main's write
  // routes apply, kept per Folio folder. A failed read hides the controls.
  const facts = await folioOrderFacts(ws, dir)
  const also = groupAlsoInFolder(listed, folio.pieces, dir, new Set(facts.changeable ? facts.addable : []), new Set(facts.unlisted))
  const wanted = [...new Set([...folio.pieces, ...also.map((file) => file.path)])].filter((p) => byPath.has(p))
  const parsed = new Map<string, Parsed>()
  for (let at = 0; at < wanted.length; at += READ_BATCH) {
    const batch = wanted.slice(at, at + READ_BATCH)
    const stamps = await Promise.all(batch.map((p) => stampOf(fs, ws, p)))
    await Promise.all(batch.map(async (p, i) => { parsed.set(p, await parsedFile(fs, ws, p, stamps[i])) }))
  }
  const fileOf = (p: string, addable?: boolean): FolioOutlineFile => ({
    path: p,
    ...(addable !== undefined && subFolderOf(dir, p) ? { under: subFolderOf(dir, p) as string } : {}),
    title: parsed.get(p)?.title ?? cappedTitle('', p),
    headings: parsed.get(p)?.headings ?? [],
    ...(parsed.get(p)?.tooLarge ? { tooLarge: true } : {}),
    ...(addable === undefined ? {} : { addable }),
  })
  return {
    dir,
    name: dir === '' ? posix.basename(ws.root) : posix.basename(dir),
    pieces: folio.pieces.filter((p) => byPath.has(p)).map((p) => fileOf(p)),
    also: also.map((file) => fileOf(file.path, file.addable)),
    ...(facts.changeable ? {} : { orderInPlanOnly: true as const }),
  }
}
