// Which file a share is on (sharing ticket 04, orchestrator ruling round 1, R-A, R-B, R-D; Sol round 2
// P1-1). A share's piece is a FILE, not its bytes: the same device, inode and birth time. Content
// equality never moves a share. An inode number alone is not enough: a volume may give a freed inode to
// a new, unrelated file, which has a new birth time; a rename keeps all three.
//
//   I0 `sameFile` compares two identities: 'same' (device, inode and a known birth time all equal),
//      'different' (any of them differs), or 'unknown' (device and inode equal but a birth time is not
//      known: a volume that keeps none reports 0, and a record made before birth times were kept has
//      none). Only 'same' lets a share follow by itself; 'unknown' is at most offered to the writer.
//   I1 `presenceOf` says what is at a path in a Workspace now: there (a file, a folder or something
//      else, with its identity `<dev>:<ino>:<birth ns>`), gone (the Workspace is readable and the path is not in
//      it), or unreadable (the Workspace itself cannot be read: a drive not connected, a folder not
//      synced, no permission, an I/O error). Unreadable is never taken as deleted.
//   I2 `scanIds` walks a Workspace once and `candidateIn` finds in that walk the one place that holds a
//      file or folder with an identity (not 'different', I0): a candidate offered to the writer
//      ("Follow to <path>"), never followed by itself. Two places (hard links) or none: no candidate.
//      The walk is bounded and skips dot-folders. One walk serves every share of a Workspace (P3).
//
// A link (symlink) is never a piece: lstat, never stat. No Electron import.
import { lstatSync, readdirSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'

export type Presence =
  | { state: 'there'; kind: 'file' | 'folder' | 'other'; id: string }
  | { state: 'gone' }
  | { state: 'unreadable' }

/** An identity as a record keeps it: `<dev>:<ino>:<birth ns>`, all decimal (birth 0: not known). `<dev>:<ino>`: a record from before birth times were kept. */
export const PIECE_ID = /^\d{1,24}:\d{1,24}(?::\d{1,30})?$/

type Stat = { dev: bigint; ino: bigint; birthtimeNs?: bigint }
const idOfStat = (stat: Stat): string => `${stat.dev}:${stat.ino}:${stat.birthtimeNs ?? 0n}`

/** I0. */
export function sameFile(a: string | null, b: string | null): 'same' | 'different' | 'unknown' {
  if (!a || !b) return 'unknown'
  const [devA, inoA, birthA = '0'] = a.split(':')
  const [devB, inoB, birthB = '0'] = b.split(':')
  if (devA !== devB || inoA !== inoB) return 'different'
  if (/^0+$/.test(birthA) || /^0+$/.test(birthB)) return 'unknown'
  return birthA === birthB ? 'same' : 'different'
}
/** `<dev>:<ino>` of an identity: what two identities of one file always share. */
const fileKey = (id: string): string => id.split(':').slice(0, 2).join(':')

function inside(root: string, path: string): string | null {
  if (isAbsolute(path)) return null
  const absolute = resolve(root, path)
  if (path === '') return absolute
  return absolute.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) ? absolute : null
}

const GONE_CODES = new Set(['ENOENT', 'ENOTDIR'])

/** I1. */
export function presenceOf(root: string, path: string): Presence {
  const absolute = inside(root, path)
  if (!absolute) return { state: 'gone' }
  try {
    const stat = lstatSync(absolute, { bigint: true })
    return { state: 'there', kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : 'other', id: idOfStat(stat) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (!GONE_CODES.has(code)) return { state: 'unreadable' }
    // Gone only when the Workspace itself can be read: an unmounted drive or a folder not synced is not a delete.
    try {
      if (!lstatSync(root).isDirectory()) return { state: 'unreadable' }
      readdirSync(root)
      return { state: 'gone' }
    } catch { return { state: 'unreadable' } }
  }
}

const WALK_LIMIT = 20_000

/** I2: what one walk of a Workspace found: by `<dev>:<ino>`, every place and its full identity. */
export type WorkspaceIds = Map<string, Array<{ path: string; kind: 'file' | 'folder'; id: string }>>

/** I2: one bounded walk of `root`. */
export async function scanIds(root: string, limit = WALK_LIMIT): Promise<WorkspaceIds> {
  const ids: WorkspaceIds = new Map()
  let seen = 0
  const walk = async (dir: string): Promise<void> => {
    let names: string[]
    try { names = await readdir(dir === '' ? root : join(root, dir)) } catch { return }
    for (const name of names) {
      if (seen >= limit || name.startsWith('.')) continue
      seen += 1
      const rel = dir === '' ? name : `${dir}/${name}`
      try {
        const stat = await lstat(join(root, rel), { bigint: true })
        const kind = stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : null
        if (kind) {
          const id = idOfStat(stat)
          const list = ids.get(fileKey(id)) ?? []
          list.push({ path: rel, kind, id })
          ids.set(fileKey(id), list)
        }
        if (stat.isDirectory()) await walk(rel)
      } catch { /* a path that went while it was read */ }
    }
  }
  await walk('')
  return ids
}

/** I2: the one place in a walk holding `id` (a file or a folder, as `kind`; I0 not 'different'), or null. */
export function candidateIn(ids: WorkspaceIds, id: string, kind: 'file' | 'folder'): string | null {
  const found = (ids.get(fileKey(id)) ?? []).filter((entry) => entry.kind === kind && sameFile(entry.id, id) !== 'different')
  return found.length === 1 ? found[0].path : null
}

/** I2: the one path in `root` holding `id`, or null (one walk). */
export async function findById(root: string, id: string, kind: 'file' | 'folder', limit = WALK_LIMIT): Promise<string | null> {
  return candidateIn(await scanIds(root, limit), id, kind)
}
