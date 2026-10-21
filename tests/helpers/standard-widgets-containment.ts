/**
 * TEST-ONLY reference reading of the resource containment rules for FILES and FOLDERS. Not production
 * code and never imported from src/. Built on the app's own no-follow walk and open flag (src/main/widget-file.ts);
 * the builder of the folder slice adds the directory check beside `sameFileInside` and the bounded walk to the
 * contained any-file folder walk, and these fixtures become their tests.
 */
import { closeSync, constants, fstatSync, openSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { OPEN_NOFOLLOW, walkNoFollowSync } from '../../src/main/widget-file'

type Checked = { ok: true; dev: number; ino: number } | { ok: false; code: string }

/** Open `relativePath` under `realRoot` without following anything, then confirm by a second no-follow walk that the
 *  open descriptor is the walked entry of `kind` (same dev/ino). `sameFileInside` (widget-file.ts) is this check for
 *  files only; a directory needs its own because it is opened with O_DIRECTORY and walked as `kind: 'directory'`. */
function checkWalked(realRoot: string, relativePath: string, kind: 'file' | 'directory', missing: string): Checked {
  const walked = walkNoFollowSync(realRoot, relativePath)
  if (walked.kind === 'missing') return { ok: false, code: missing }
  if (walked.kind === 'refused') return { ok: false, code: 'resource-link-refused' }
  if (walked.kind !== kind) return { ok: false, code: 'resource-unreadable' }
  let fd: number
  try { fd = openSync(join(realRoot, relativePath), constants.O_RDONLY | OPEN_NOFOLLOW | (kind === 'directory' ? constants.O_DIRECTORY : 0)) } catch { return { ok: false, code: 'resource-unreadable' } }
  try {
    const info = fstatSync(fd)
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) return { ok: false, code: 'resource-unreadable' }
    const again = walkNoFollowSync(realRoot, relativePath)
    if (again.kind !== kind || again.dev !== info.dev || again.ino !== info.ino) return { ok: false, code: 'resource-unreadable' }
    return { ok: true, dev: info.dev, ino: info.ino }
  } finally { closeSync(fd) }
}

/** File verification (steps 2 and 3): no-follow walk to a regular file, NOFOLLOW open, descriptor = walked file. */
export const verifyContainedFile = (realRoot: string, relativePath: string): Checked => checkWalked(realRoot, relativePath, 'file', 'resource-missing')
/** Directory verification: no-follow walk to a directory, NOFOLLOW|O_DIRECTORY open, descriptor = walked folder. */
export const verifyContainedDirectory = (realRoot: string, relativePath: string): Checked => checkWalked(realRoot, relativePath, 'directory', 'folder-missing')

/** Bounds on one folder walk (Refresh folder, file catalogue, a sync folder's origin). */
export const FOLDER_WALK_LIMITS = { maxDepth: 8, maxEntries: 2000 }
export type FolderWalk =
  | { ok: true; files: string[]; refused: Array<{ code: string; path: string }>; hidden: string[] }
  | { ok: false; code: string; path?: string }

/**
 * Bounded member walk of the folder at `folderPath` under `realRoot` (the workspace's real root, or for a sync
 * folder the grant's origin real path with `folderPath` = '.'-free relative path of the folder inside it). The
 * folder passes directory verification first and again after each listing (same dev/ino), or the walk stops. A
 * listing only proposes names: every entry is then examined by its own no-follow walk from `realRoot`, and every
 * file passes `verifyContainedFile`, so a folder swapped during the walk can leak at most a name, never bytes.
 * Symlinks and special files are refused by name; dot-names are reported as hidden; nothing is left out silently.
 * More than `maxEntries` entries, or a folder deeper than `maxDepth` below the root folder → `folder-too-large`.
 */
export function walkFolderMembers(realRoot: string, folderPath: string, limits = FOLDER_WALK_LIMITS): FolderWalk {
  const files: string[] = []
  const refused: Array<{ code: string; path: string }> = []
  const hidden: string[] = []
  let seen = 0
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }]
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!
    const dir = rel === '' ? folderPath : `${folderPath}/${rel}`
    const before = verifyContainedDirectory(realRoot, dir)
    if (!before.ok) return { ok: false, code: before.code, path: rel || '.' }
    let names: string[]
    try { names = readdirSync(join(realRoot, dir)).sort() } catch { return { ok: false, code: 'resource-unreadable', path: rel || '.' } }
    const after = verifyContainedDirectory(realRoot, dir)
    if (!after.ok || after.dev !== before.dev || after.ino !== before.ino) return { ok: false, code: 'resource-unreadable', path: rel || '.' }
    for (const name of names) {
      seen += 1
      if (seen > limits.maxEntries) return { ok: false, code: 'folder-too-large' }
      const member = rel === '' ? name : `${rel}/${name}`
      if (name.startsWith('.')) { hidden.push(member); continue }
      const walked = walkNoFollowSync(realRoot, `${folderPath}/${member}`)
      if (walked.kind === 'directory') {
        if (depth + 1 > limits.maxDepth) return { ok: false, code: 'folder-too-large', path: member }
        queue.push({ rel: member, depth: depth + 1 })
        continue
      }
      if (walked.kind !== 'file') { refused.push({ code: walked.kind === 'missing' ? 'folder-member-missing' : 'resource-link-refused', path: member }); continue }
      const checked = verifyContainedFile(realRoot, `${folderPath}/${member}`)
      if (checked.ok) files.push(member)
      else refused.push({ code: checked.code, path: member })
    }
  }
  return { ok: true, files: files.sort(), refused, hidden }
}
