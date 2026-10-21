/**
 * Clears away what a killed write leaves behind. The command line never writes a file in place: it
 * writes a temporary file beside it and renames it (guarded-fs.ts, journal.ts, request-files.ts). A
 * process killed between the two leaves the temporary file. Nothing reads it, but it stays for ever.
 *
 * `removeStaleTemporaryFiles` removes those files and nothing else:
 *  - only names the command line itself makes: beside a document, the document's full name (a
 *    Markdown file or a Folio manifest) followed by `.<8 hex digits>.tmp`; in the inbox and the
 *    outbox, `.<request id>.json.<8 hex digits>.tmp`. A
 *    file of the user's with a merely similar name (`notes.md.tmp`, `draft.12345678.tmp`,
 *    `notes.md.backup01.tmp`) does not match and is left;
 *  - only regular files last changed more than ten minutes ago, so a write in progress is never
 *    touched (a write holds its temporary file for moments);
 *  - only in folders the sidebar shows (the document-path rule's folder names) and in the command
 *    line's own two folders under `.writeflex`, the inbox and the outbox. No link is followed: a
 *    linked folder is not entered, a linked file is not removed, and removal never follows a link.
 *
 * The undo journal and the app's records are not in the Collection (collection-records.ts); each
 * clears its own temporary files where it lives. The folders an earlier build kept them in, inside
 * the Collection, are not visited: nothing in them is read, and nothing in them is removed.
 *
 * BOUNDED IN ITS OWN TWO FOLDERS. The inbox and the outbox are folders anything can fill, so each is
 * listed up to `MAX_ENTRIES_LISTED` entries (review-format.ts) and no further; what is stale beyond
 * that goes at a later run, the folder being shorter by then. The folders of documents are the
 * writer's own and are walked whole, as the sidebar walks them.
 *
 * Run by the next command-line write to the Collection, under the owner lock, and by the app when it
 * binds the Collection. It asks the Collection write gate first and gives up quietly on any failure:
 * tidying must never stop the write it runs before.
 */
import { lstat, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { collectionWritesPaused } from '../collection-write-gate'
import { isHiddenFolderName } from '../document-path'
import { MANIFEST_NAME } from '../../shared/folio-constants'
import { entriesUpTo } from './request-files'
import { MAX_ENTRIES_LISTED } from './review-format'

export const STALE_TEMPORARY_MS = 10 * 60_000

const escaped = MANIFEST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Beside a document: `<name>.md.<8 hex>.tmp`, or the manifest's name with the same ending. */
const BESIDE_DOCUMENT = new RegExp(`(?:\\.(?:md|markdown|mdx)|^${escaped})\\.[0-9a-f]{8}\\.tmp$`, 'i')
const REQUEST_FILE = /^\.\d{8}T\d{9}Z-[0-9a-f]{16}\.json\.[0-9a-f]{8}\.tmp$/
const OWN_FOLDERS: Array<[string, RegExp]> = [['.writeflex/inbox', REQUEST_FILE], ['.writeflex/outbox', REQUEST_FILE]]

/** Remove the command line's own stale temporary files under `root`. Returns the Collection-relative paths removed. */
export async function removeStaleTemporaryFiles(root: string, options: { now?: () => Date; olderThanMs?: number } = {}): Promise<string[]> {
  if (collectionWritesPaused(root)) return []
  const nowMs = (options.now?.() ?? new Date()).getTime()
  const olderThanMs = options.olderThanMs ?? STALE_TEMPORARY_MS
  const removed: string[] = []

  const sweep = async (folder: string, pattern: RegExp, descend: boolean): Promise<void> => {
    const entries = descend
      ? await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])
      : (await entriesUpTo(join(root, folder), MAX_ENTRIES_LISTED).catch(() => ({ entries: [] }))).entries
    for (const entry of entries) {
      const rel = folder ? `${folder}/${entry.name}` : entry.name
      // A directory entry that is a link is neither a directory nor a file here: not entered, not removed.
      if (entry.isDirectory()) {
        if (descend && !isHiddenFolderName(entry.name)) await sweep(rel, pattern, true)
        continue
      }
      if (!entry.isFile() || !pattern.test(entry.name)) continue
      const info = await lstat(join(root, rel)).catch(() => null)
      if (!info?.isFile() || nowMs - info.mtimeMs <= olderThanMs) continue
      if (await unlink(join(root, rel)).then(() => true, () => false)) removed.push(rel)
    }
  }
  try {
    await sweep('', BESIDE_DOCUMENT, true)
    for (const [folder, pattern] of OWN_FOLDERS) {
      // Each of the command line's own folders only if it is a real folder all the way down.
      let real = true
      let current = root
      for (const segment of folder.split('/')) {
        current = join(current, segment)
        if (!(await lstat(current).catch(() => null))?.isDirectory()) { real = false; break }
      }
      if (real) await sweep(folder, pattern, false)
    }
  } catch { /* tidying only */ }
  return removed.sort()
}
