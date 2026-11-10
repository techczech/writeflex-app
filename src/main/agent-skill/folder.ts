// The write path of the built-in agent skill: one skill folder inside another tool's skills folder.
// Strict by design (contract: agent-skill.md, "Writes"):
//
//  - the app owns a folder only if it holds the marker `.app-skill.json` naming this app, with the hash of
//    each file; anything else, and any symlink, is someone else's and is never touched;
//  - never write through a symlink: the skills folder's own real path is resolved (a config folder may be
//    a link to another), the skill folder itself must not be a link;
//  - write to a temporary folder beside the target, then rename; a folder being replaced is renamed aside
//    first and put back if the swap fails; nothing is written outside the skill's own folder;
//  - remove deletes only an owned, unedited folder, and leaves the skills folder.
//
// No Electron import; no app specifics. Tests run it against a disposable HOME only.
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, posix, resolve } from 'node:path'
import { compareVersions } from '../../shared/agent-skill/versions.ts'
import { MARKER_FILE, readSkillMetadata, sha256, type SkillSource } from './skill-source.ts'

export interface Marker { format: 1; app: string; version: string; files: Record<string, string> }

export type Inspection =
  | { kind: 'absent' }
  | { kind: 'owned'; version: string; edited: boolean; why: string | null; link: string | null }
  | { kind: 'separate'; version: string | null; plain: boolean; link: string | null }
  | { kind: 'foreign'; symlink: boolean }
  | { kind: 'unreadable'; reason: string }

/** A failure with words a person can read; the cause's code is kept for the log. */
export class FolderError extends Error {
  code: string | undefined
  constructor(message: string, code?: string) { super(message); this.code = code }
}

export function plainReason(error: unknown): string {
  if (error instanceof FolderError) return error.message
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'The folder is read-only, or this computer will not let the app write there.'
  if (code === 'ENOSPC') return 'The disk is full.'
  if (code === 'ENOTDIR') return 'Something that is not a folder is in the way.'
  return 'The folder could not be written.'
}

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

/**
 * The real path of `path`, whether or not it exists yet: the deepest existing ancestor is resolved (a
 * symlinked config folder is followed there) and the missing rest is appended. A dangling link on the
 * way is refused.
 */
export async function resolveReal(path: string): Promise<string> {
  let cur = resolve(path)
  const rest: string[] = []
  for (;;) {
    try {
      const real = await realpath(cur)
      if (rest.length === 0) return real
      if (!(await lstat(real)).isDirectory()) throw new FolderError('Something that is not a folder is in the way.', 'ENOTDIR')
      return join(real, ...rest.reverse())
    } catch (e) {
      if (e instanceof FolderError) throw e
      if (errno(e) !== 'ENOENT') throw e
      let there = true
      try { await lstat(cur) } catch { there = false }
      if (there) throw new FolderError('A link in the way points nowhere.', 'ELOOP')
      const up = dirname(cur)
      if (up === cur) throw new FolderError('The folder cannot be found.', 'ENOENT')
      rest.push(basename(cur))
      cur = up
    }
  }
}

async function readRegular(path: string): Promise<Buffer | null> {
  try {
    const s = await lstat(path)
    if (!s.isFile()) return null
    return await readFile(path)
  } catch { return null }
}

/** Every regular file under `dir` (relative, posix), and whether anything else (a link, a device) is in there. */
async function listTree(dir: string): Promise<{ files: string[]; odd: string | null }> {
  const files: string[] = []
  let odd: string | null = null
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const childRel = rel ? posix.join(rel, entry.name) : entry.name
      if (entry.isSymbolicLink()) odd = odd ?? childRel
      else if (entry.isDirectory()) await walk(join(abs, entry.name), childRel)
      else if (entry.isFile()) files.push(childRel)
      else odd = odd ?? childRel
    }
  }
  await walk(dir, '')
  return { files, odd }
}

const isMarker = (m: unknown, appId: string): m is Marker => {
  if (!m || typeof m !== 'object') return false
  const x = m as Record<string, unknown>
  return x.format === 1 && x.app === appId && typeof x.version === 'string' && !!x.files && typeof x.files === 'object' && !Array.isArray(x.files)
}

export async function inspectTarget(target: string, appId: string): Promise<Inspection> {
  let s
  try { s = await lstat(target) } catch (e) {
    return errno(e) === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', reason: plainReason(e) }
  }
  if (s.isSymbolicLink()) {
    // Read through the link only to name what it is (installed separately or not); never to change it.
    const meta = readSkillMetadata((await readRegularThrough(join(target, 'SKILL.md')))?.toString('utf8') ?? '')
    return meta.app === appId ? { kind: 'separate', version: meta.version, plain: false, link: null } : { kind: 'foreign', symlink: true }
  }
  if (!s.isDirectory()) return { kind: 'foreign', symlink: false }
  try {
    const markerBytes = await readRegular(join(target, MARKER_FILE))
    let marker: unknown = null
    if (markerBytes) { try { marker = JSON.parse(markerBytes.toString('utf8')) } catch { marker = null } }
    if (isMarker(marker, appId)) {
      const { files, odd } = await listTree(target)
      const present = files.filter((f) => f !== MARKER_FILE)
      let why: string | null = null
      if (odd) why = 'a link or special file was added'
      for (const [rel, hash] of Object.entries(marker.files)) {
        const bytes = await readRegular(join(target, ...rel.split('/')))
        if (!bytes) { why = why ?? 'a file was removed'; break }
        if (sha256(bytes) !== hash) { why = why ?? 'a file was edited'; break }
      }
      if (!why && present.some((f) => !Object.hasOwn(marker.files, f))) why = 'a file was added'
      return { kind: 'owned', version: marker.version, edited: why !== null, why, link: odd }
    }
    const meta = readSkillMetadata((await readRegular(join(target, 'SKILL.md')))?.toString('utf8') ?? '')
    if (meta.app !== appId) return { kind: 'foreign', symlink: false }
    // A link (or special file) anywhere inside is not ours to erase: carried so Replace can refuse.
    return { kind: 'separate', version: meta.version, plain: true, link: (await listTree(target)).odd }
  } catch (e) {
    return { kind: 'unreadable', reason: plainReason(e) }
  }
}

async function readRegularThrough(path: string): Promise<Buffer | null> {
  try { return await readFile(path) } catch { return null }
}

const suffix = (): string => `${process.pid}-${randomBytes(4).toString('hex')}`

export type Replaces = 'nothing' | 'owned' | 'any-plain'

/** Test seams: a pause after the first look and after the move aside, where another process could act. */
export interface WriteHooks {
  afterInspect?: () => Promise<void> | void
  afterAside?: () => Promise<void> | void
  /** Just before anything is moved or written in place; may throw to stop the write (the person's choice changed). */
  beforeCommit?: () => Promise<void> | void
}

/** A folder's identity as captured at the start (device and inode), so a swap for another folder is noticed. */
export interface Held { path: string; dev: number; ino: number }

/**
 * The real folder `parent` is, resolved once. A link anywhere on the way is followed here and only here;
 * every later step works relative to the result and re-checks it is still that same directory.
 */
async function resolveParent(parent: string, create: boolean): Promise<Held> {
  const wanted = await resolveReal(parent)
  if (create) await mkdir(wanted, { recursive: true })
  const real = await realpath(wanted)
  if (real !== wanted) throw new FolderError('A link appeared in the way, so nothing was written.', 'ECHANGED')
  const s = await stat(real)
  return { path: real, dev: s.dev, ino: s.ino }
}

/** Still the same real directory (not a link, same device and inode, same real path). */
async function stillHeld(h: Held): Promise<boolean> {
  try {
    const s = await lstat(h.path)
    return !s.isSymbolicLink() && s.isDirectory() && s.dev === h.dev && s.ino === h.ino && (await realpath(h.path)) === h.path
  } catch { return false }
}

/** Immediately before a rename. */
async function assertStillReal(h: Held): Promise<void> {
  if (!(await stillHeld(h))) throw new FolderError('The skills folder changed while it was being written, so it was left as it is.', 'ECHANGED')
}

/**
 * Cleanup by path is only safe while the parent is the folder it was at the start. If it is not, nothing is
 * deleted by path: the item is left where it is and named, so a swapped-in folder is never emptied.
 */
async function cleanup(h: Held, item: string, left: string[]): Promise<void> {
  if (!(await stillHeld(h))) { left.push(item); return }
  await rm(item, { recursive: true, force: true }).catch(() => {})
}

const leftNote = (left: string[]): string => ` ${left.length === 1 ? 'A temporary item was' : 'Temporary items were'} left at ${left.join(', ')}.`

const CHANGED = (): FolderError => new FolderError('That folder changed while it was being written, so it was left as it is.', 'ECHANGED')

/** Whether `now` may be replaced by this call. A link inside is never ours, whatever was asked. */
function replaceable(now: Inspection, opts: { replaces: Replaces; replaceEdited?: boolean }): boolean {
  // Only an install creates. An update (`owned`, `any-plain`) replaces something that is there and never makes it.
  if (now.kind === 'absent') return opts.replaces === 'nothing'
  if (now.kind === 'owned') return !now.link && opts.replaces !== 'nothing' && (!now.edited || opts.replaceEdited === true)
  if (now.kind === 'separate') return now.plain && !now.link && opts.replaces === 'any-plain'
  return false
}

/**
 * Put a copy that was moved aside back. If something else filled the place meanwhile: our own unedited copy at
 * a LOWER version than the one being put back is moved aside, the copy goes back, and the moved occupant is
 * deleted after it is checked again; any other occupant (higher or equal version, edited, not ours) is left
 * alone and nothing is deleted. False when the copy could not be put back (it stays where it was moved).
 */
async function putBack(held: Held, back: string, real: string, moved: Inspection, appId: string, left: string[]): Promise<boolean> {
  try { await rename(back, real); return true } catch { /* the place is taken */ }
  if (moved.kind !== 'owned' || moved.edited || moved.link) return false
  const occupant = await inspectTarget(real, appId)
  if (occupant.kind !== 'owned' || occupant.edited || occupant.link || compareVersions(occupant.version, moved.version) !== -1) return false
  if (!(await stillHeld(held))) return false
  const occupantAside = join(held.path, `.${basename(real)}.old-${suffix()}`)
  try {
    await rename(real, occupantAside)
  } catch { return false }
  try {
    await rename(back, real)
  } catch {
    try { await rename(occupantAside, real) } catch { left.push(occupantAside) }
    return false
  }
  const again = await inspectTarget(occupantAside, appId)
  if (again.kind === 'owned' && !again.edited && !again.link && (await stillHeld(held))) await rm(occupantAside, { recursive: true, force: true }).catch(() => { left.push(occupantAside) })
  else left.push(occupantAside)
  return true
}

/**
 * Put `source` at `target`. `replaces` says what may already be there: nothing; our own copy (unedited, or
 * edited when the person asked to replace); or a plain separately installed folder (the person asked to
 * replace). A link, anything else, and any folder with a link inside it, is never replaced.
 *
 * Inspection does not protect what is deleted later, so the old folder is renamed aside FIRST and what was
 * actually moved is inspected again; if that is not what was allowed it goes straight back and nothing is
 * deleted.
 */
export async function writeSkillFolder(target: string, source: SkillSource, opts: { replaces: Replaces; replaceEdited?: boolean; /** Never put an older copy over a newer one (everything except an explicit Replace). */ noDowngrade?: boolean; hooks?: WriteHooks }): Promise<void> {
  /** A newer copy of ours than the one being written, when downgrading is not allowed. */
  const newer = (i: Inspection): boolean => opts.noDowngrade === true && i.kind === 'owned' && compareVersions(i.version, source.version) === 1
  const name = basename(target)
  const held = await resolveParent(dirname(target), true)
  const parent = held.path
  const real = join(parent, name)
  const left: string[] = []
  const tmp = join(parent, `.${name}.tmp-${suffix()}`)
  let aside: string | null = null
  try {
    await mkdir(tmp)
    for (const [rel, data] of source.files) {
      const dest = join(tmp, ...rel.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, data, { flag: 'wx', mode: 0o644 })
    }
    const marker: Marker = { format: 1, app: source.appId, version: source.version, files: source.hashes }
    await writeFile(join(tmp, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx', mode: 0o644 })

    const now = await inspectTarget(real, source.appId)
    if (newer(now)) throw new FolderError('A newer copy is there, so it was kept.', 'ENEWER')
    if (now.kind === 'absent' && opts.replaces !== 'nothing') throw new FolderError('The copy is no longer there, so nothing was written.', 'EABSENT')
    if (!replaceable(now, opts)) throw CHANGED()
    await opts.hooks?.afterInspect?.()
    await opts.hooks?.beforeCommit?.()
    await assertStillReal(held)
    if (now.kind !== 'absent') {
      aside = join(parent, `.${name}.old-${suffix()}`)
      await rename(real, aside)
      await opts.hooks?.afterAside?.()
      // What was moved is what must be checked. Anything else goes back untouched.
      const moved = await inspectTarget(aside, source.appId)
      if (!replaceable(moved, opts) || newer(moved)) {
        const wasNewer = newer(moved)
        const back = aside
        aside = null
        const stranded = (): FolderError => new FolderError(`That folder changed while it was being written. It was moved to ${back} and left there.`, 'ECHANGED')
        if (!(await stillHeld(held))) throw stranded()
        if (!(await putBack(held, back, real, moved, source.appId, left))) throw stranded()
        throw wasNewer ? new FolderError('A newer copy is there, so it was kept.', 'ENEWER') : CHANGED()
      }
    }
    await assertStillReal(held)
    try {
      await rename(tmp, real)
    } catch (e) {
      if (aside && (await stillHeld(held))) { try { await rename(aside, real); aside = null } catch { /* left beside; named below */ } }
      throw e
    }
    if (aside) { const old = aside; aside = null; await cleanup(held, old, left) }
  } catch (e) {
    if (aside) left.push(aside)
    await cleanup(held, tmp, left)
    if (left.length && e instanceof FolderError) throw new FolderError(e.message + leftNote(left), e.code)
    throw e
  }
  await cleanup(held, tmp, left)
}

/**
 * Remove our own unedited copy; the skills folder stays. Anything else is refused. The folder is renamed
 * aside first and what was moved is checked (marker, hashes, no link) before it is deleted; if it is not
 * ours it is put back.
 */
export async function removeSkillFolder(target: string, appId: string, hooks: WriteHooks = {}): Promise<void> {
  const held = await resolveParent(dirname(target), false)
  const parent = held.path
  const real = join(parent, basename(target))
  const ours = (i: Inspection): boolean => i.kind === 'owned' && !i.edited && !i.link
  if (!ours(await inspectTarget(real, appId))) throw new FolderError('Only an unedited copy installed by the app is removed.', 'ENOTOURS')
  await hooks.afterInspect?.()
  await assertStillReal(held)
  const gone = join(parent, `.${basename(target)}.rm-${suffix()}`)
  await rename(real, gone)
  await hooks.afterAside?.()
  if (!ours(await inspectTarget(gone, appId))) {
    if (!(await stillHeld(held))) throw new FolderError(`That folder changed while it was being removed. It was moved to ${gone} and left there.`, 'ECHANGED')
    try { await rename(gone, real) } catch { throw new FolderError(`That folder changed while it was being removed. It was moved to ${gone} and left there.`, 'ECHANGED') }
    throw new FolderError('That folder changed while it was being removed, so it was left as it is.', 'ECHANGED')
  }
  if (!(await stillHeld(held))) throw new FolderError(`The skills folder changed while the copy was being removed. It was moved to ${gone} and left there.`, 'ECHANGED')
  await rm(gone, { recursive: true, force: true })
}
