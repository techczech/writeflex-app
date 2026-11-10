/** Machine-local authority. Never part of a vault or the portable history projection. */
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, normalize, parse, join } from 'node:path'
export const HISTORY_APPROVAL_ENV = 'WRITEFLEX_HISTORY_APPROVAL_FILE'
export const HISTORY_APPROVAL_BASENAME = 'earlier-locations.jsonl'
const MAX_BYTES = 8 * 1024 * 1024
const HEX = /^[0-9a-f]{64}$/
export const historyDigest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
export type EarlierRecord = { identity: string; oldRoot: string }
export type EarlierLocations = { cohort: string; records: EarlierRecord[]; roots: { root: string; namedVersions: number }[]; approvalState: string }
export const absoluteHistoryRoot = (v: unknown): v is string => typeof v === 'string' && v.length > 1 && v.length <= 4096 && isAbsolute(v) && normalize(v) === v && !v.endsWith('/') && !/[\\\x00-\x1f]/.test(v)
function parents(file: string, create = false): void {
  if (!absoluteHistoryRoot(file)) throw new Error('invalid history approval path')
  const dir = dirname(file)
  if (create) {
    const missing: string[] = []
    for (let p = dir;; p = dirname(p)) {
      try { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('linked history approval folder') }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') missing.push(p); else throw e }
      if (p === parse(p).root) break
    }
    for (const p of missing.reverse()) mkdirSync(p, { mode: 0o700 })
  }
  for (let p = dir;; p = dirname(p)) {
    const s = lstatSync(p)
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('linked history approval folder')
    if (p === dir && ((s.mode & 0o077) !== 0 || s.uid !== process.getuid?.())) throw new Error('history approval folder is not private')
    if (p === parse(p).root) break
  }
}
function readBounded(fd: number, max: number): Buffer {
  const size = fstatSync(fd).size
  if (size > max) throw new Error('history record exceeds limit')
  const buffer = Buffer.alloc(size + 1)
  let at = 0
  while (at < buffer.length) {
    const n = readSync(fd, buffer, at, buffer.length - at, null)
    if (n === 0) break
    at += n
  }
  if (at > size) throw new Error('history record grew during read')
  return buffer.subarray(0, at)
}
/** No-follow, bounded read; the fingerprint also detects replacement, chmod and relinking. */
export function approvalBytes(file?: string): { bytes: Buffer; state: string } {
  if (!file) return { bytes: Buffer.alloc(0), state: 'absent' }
  try { parents(file) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: Buffer.alloc(0), state: 'absent' }; throw e }
  let fd: number
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: Buffer.alloc(0), state: 'absent' }; throw e }
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077) !== 0 || s.size > MAX_BYTES) throw new Error('history approval file is not private and ordinary')
    const bytes = readBounded(fd, MAX_BYTES), after = fstatSync(fd), path = lstatSync(file)
    if (bytes.length > MAX_BYTES || s.size !== after.size || s.mtimeMs !== after.mtimeMs || s.ctimeMs !== after.ctimeMs || path.dev !== s.dev || path.ino !== s.ino || path.nlink !== 1) throw new Error('history approvals changed during read')
    return { bytes, state: historyDigest(JSON.stringify([s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs, historyDigest(bytes)])) }
  } finally { closeSync(fd) }
}
type Approval = { schema: 1; root: string; cohort: string; records: EarlierRecord[]; roots: EarlierLocations['roots']; previous: string; checksum: string }
const keys = (o: object, expected: string[]) => JSON.stringify(Object.keys(o).sort()) === JSON.stringify(expected.sort())
export function loadHistoryApprovals(file?: string): { state: string; records: Map<string, Set<string>>; tail: string; bytes: Buffer } {
  const loaded = approvalBytes(file), records = new Map<string, Set<string>>()
  let tail = 'absent'
  if (loaded.bytes.length && loaded.bytes.at(-1) !== 10) throw new Error('truncated history approvals')
  if (loaded.state !== 'absent' && loaded.bytes.length === 0) throw new Error('empty history approval file')
  const lines = loaded.bytes.toString('utf8').split('\n').slice(0, -1)
  if (lines.length > 1000) throw new Error('too many history approvals')
  for (const line of lines) {
    const a = JSON.parse(line) as Approval
    if (!a || !keys(a, ['schema','root','cohort','records','roots','previous','checksum']) || a.schema !== 1 || !absoluteHistoryRoot(a.root) || !HEX.test(a.cohort) || a.previous !== tail || !Array.isArray(a.records) || !a.records.length || a.records.length > 50000 || !Array.isArray(a.roots) || !a.roots.length || a.roots.length > 32) throw new Error('damaged history approval')
    const counts = new Map<string, number>(), seen = new Set<string>()
    for (const r of a.records) {
      if (!r || !keys(r, ['identity','oldRoot']) || !HEX.test(r.identity) || !absoluteHistoryRoot(r.oldRoot) || r.oldRoot === a.root || seen.has(r.identity)) throw new Error('damaged approved identity')
      seen.add(r.identity); counts.set(r.oldRoot, (counts.get(r.oldRoot) ?? 0) + 1)
    }
    if (JSON.stringify(a.roots) !== JSON.stringify([...counts].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([root,namedVersions]) => ({ root, namedVersions })))) throw new Error('damaged approval counts')
    const { checksum, ...body } = a
    if (checksum !== historyDigest(JSON.stringify(body))) throw new Error('changed history approval')
    tail = checksum
    const approved = records.get(a.root) ?? new Set<string>()
    for (const r of a.records) approved.add(r.identity)
    records.set(a.root, approved)
  }
  return { ...loaded, records, tail }
}
/** Called synchronously under main's enrolment queue, after a fresh full history check. */
export function appendHistoryApproval(file: string, root: string, earlier: EarlierLocations, admit: () => boolean): void {
  const loaded = loadHistoryApprovals(file)
  if (loaded.state !== earlier.approvalState || !admit()) throw new Error('history confirmation changed')
  const body = { schema: 1 as const, root, cohort: earlier.cohort, records: earlier.records, roots: earlier.roots, previous: loaded.tail }
  const line = Buffer.from(JSON.stringify({ ...body, checksum: historyDigest(JSON.stringify(body)) }) + '\n')
  if (loaded.bytes.length + line.length > MAX_BYTES) throw new Error('history approvals exceed limit')
  parents(file, true)
  // No await between final admission and append; all writers share main's queue.
  if (approvalBytes(file).state !== loaded.state || !admit()) throw new Error('history confirmation changed')
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | (loaded.state === 'absent' ? constants.O_CREAT | constants.O_EXCL : 0), 0o600)
  let admitted = false
  try {
    const s = fstatSync(fd), path = lstatSync(file)
    if (!s.isFile() || s.nlink !== 1 || s.dev !== path.dev || s.ino !== path.ino || s.size !== loaded.bytes.length || (s.mode & 0o077) !== 0) throw new Error('history approval append refused')
    admitted = true
    let at = 0
    while (at < line.length) {
      const written = writeSync(fd, line, at, line.length - at)
      if (written <= 0) throw new Error('history approval append made no progress')
      at += written
    }
    fsyncSync(fd)
    const dir = openSync(dirname(file), constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(dir) } finally { closeSync(dir) }
  } catch (error) {
    if (admitted) {
      try {
        // Roll back only our admitted append on the descriptor we opened, preserving prior authority.
        ftruncateSync(fd, loaded.bytes.length)
        fsyncSync(fd)
        if (loaded.state === 'absent') {
          const s = fstatSync(fd), path = lstatSync(file)
          if (s.dev !== path.dev || s.ino !== path.ino) throw new Error('history approval rollback identity changed')
          unlinkSync(file)
        }
      } catch (rollback) { throw new AggregateError([error, rollback], 'history approval append and rollback failed') }
    }
    throw error
  } finally { closeSync(fd) }
}

/** Final synchronous source admission before append, using only the current real vault. */
export function historyCohort(root: string, versions: Buffer | null, journal: Buffer | null): string {
  const s = lstatSync(root)
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('history root changed')
  return historyDigest(JSON.stringify([root, s.dev, s.ino, versions === null ? 'absent' : historyDigest(versions), journal === null ? 'absent' : historyDigest(journal)]))
}
export function currentHistoryCohort(root: string): string {
  const read = (dir: string, name: string): Buffer | null => {
    const folder = join(root, dir), s = lstatSync(folder)
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('history folder changed')
    const fd = openSync(join(folder,name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const st = fstatSync(fd)
      if (!st.isFile() || st.nlink !== 1 || st.size > 64 * 1024 * 1024) throw new Error('history source changed')
      const bytes = readBounded(fd, 64 * 1024 * 1024)
      if (bytes.length > 64 * 1024 * 1024) throw new Error('history source exceeds limit')
      return bytes
    } finally { closeSync(fd) }
  }
  return historyCohort(root, read('.writeflex','versions.jsonl'), read('.bridle','journal.jsonl'))
}
