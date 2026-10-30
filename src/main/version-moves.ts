/** Unfinished move state table (identity alone decides; reads never write):
 * Destination identity found                 -> happened, versions at destination.
 * Source identity only                      -> not happened, versions at source.
 * Neither recorded identity found           -> held back, visible at neither path; map to any name.
 * Both names, hard links (not case-only)     -> destination wins.
 * Both names resolve to one inode, case-only -> full on-disk spelling decides, including parents.
 * Hold record                               -> assigned IDs stay held back.
 * Explicit map                              -> assigned IDs attach; pending inference is cancelled.
 * Undo map                                  -> recovered IDs return to held back.
 * Copy identity is content, not inode: identical empty/template files can match.
 * Copy moves use the recorded destination hash instead of destination inode identity.
 * Device changes on remount and inode reuse remain identity limitations; intents do not expire.
 * Claim and pre-save settlement freeze resolved states before atomic saves replace identities.
 * Every in-process move holds the Collection write turn; pinned blocks stay synchronous, so
 * settlement cannot race another move in flight. Re-entrant copy saves see the destination hash.
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, posix, relative } from 'node:path'
import { parseVersionLine, sortVersionsNewestFirst, type Version } from '../engine'
import { appendStoreLineSync } from './checked-store-append'
import { assertCollectionWritable } from './collection-write-gate'
import { isListedPath, realLocation } from './document-path'
import { MAX_GUARDED_DOCUMENT_BYTES } from './guarded-document-read'

const JOURNAL = '.writeflex/versions.jsonl'
type Assignment = { id: string; from: string; to: string }
type Evidence = { from: string; to: string; dev: number; ino: number; hash?: string; beforeHash?: string }
type MoveRecord = { kind: 'version-paths'; id: string; ts?: number; assignments: Assignment[]; destinationIds?: string[]; evidence?: Evidence; undoes?: string; reattachedIds?: string[]; heldBackIds?: string[] }
type Finish = { kind: 'version-paths-finish'; id: string; state: 'done' | 'cancelled' }
type JournalRecord = Version | MoveRecord | Finish

export function historyPath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path === '..' || path.startsWith('../') || posix.normalize(path) !== path || path.endsWith('/')) throw new Error('History paths must be normalised workspace-relative paths.')
  return path
}

/** Refuse links in every component before reading journal data or move evidence. */
function ordinary(root: string, path: string): string {
  historyPath(path)
  let current = realpathSync(root)
  const parts = path.split('/')
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i])
    const info = lstatSync(current)
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory())) throw Object.assign(new Error('History cannot use a linked path.'), { code: 'ELOOP' })
  }
  return current
}

function journal(root: string): JournalRecord[] {
  let path: string
  try { path = ordinary(root, JOURNAL) } catch (error) {
    if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
    throw error
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) return []
    const rows: JournalRecord[] = []
    const lines = readFileSync(fd, 'utf8').split('\n')
    // Parse a complete final record even without a newline; malformed tails have no authority.
    for (const line of lines) {
      const version = parseVersionLine(line)
      if (version) { rows.push(version); continue }
      try {
        const row = JSON.parse(line)
        if (row?.kind === 'version-paths' && typeof row.id === 'string' && Array.isArray(row.assignments) && row.assignments.every((a: Assignment) => typeof a.id === 'string' && historyPath(a.from) && historyPath(a.to))) {
          if (['reattachedIds', 'heldBackIds'].some(key => row[key] !== undefined && (!Array.isArray(row[key]) || !row[key].every((id: unknown) => typeof id === 'string')))) continue
          if (row.destinationIds !== undefined && (!Array.isArray(row.destinationIds) || !row.destinationIds.every((id: unknown) => typeof id === 'string'))) continue
          if (row.evidence) {
            historyPath(row.evidence.from); historyPath(row.evidence.to)
            if (row.evidence.beforeHash !== undefined && !/^[a-f0-9]{64}$/.test(row.evidence.beforeHash)) continue
            if (!Number.isFinite(row.evidence.dev) || !Number.isFinite(row.evidence.ino) || (row.evidence.hash !== undefined && !/^[a-f0-9]{64}$/.test(row.evidence.hash))) continue
          }
          rows.push(row)
        } else if (row?.kind === 'version-paths-finish' && typeof row.id === 'string' && ['done', 'cancelled'].includes(row.state)) rows.push(row)
      } catch { /* Unknown or malformed records have no authority. */ }
    }
    return rows
  } finally { closeSync(fd) }
}

/** Last finish wins, consistently across reads and every journal lookup. */
function finishState(rows: JournalRecord[]): Map<string, Finish['state']> {
  const states = new Map<string, Finish['state']>()
  for (const row of rows) if ('kind' in row && row.kind === 'version-paths-finish') states.set(row.id, row.state)
  return states
}

/** Listed files include dot-named documents; the bin is a recovery source only. */
export function isHistoryMapPath(path: string, source = false): boolean {
  return isListedPath(path, 'file') || (source && path.startsWith('.folio-bin/') && isListedPath(path.slice('.folio-bin/'.length), 'file'))
}

/** Only copy evidence needs bytes on reads; bound both allocation and bytes read, even if it grows. */
function fileHash(path: string): string | undefined {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > MAX_GUARDED_DOCUMENT_BYTES) return undefined
    const digest = createHash('sha256')
    const chunk = Buffer.alloc(64 * 1024)
    let total = 0
    while (total <= MAX_GUARDED_DOCUMENT_BYTES) {
      const count = readSync(fd, chunk, 0, Math.min(chunk.length, MAX_GUARDED_DOCUMENT_BYTES + 1 - total), null)
      if (!count) return digest.digest('hex')
      total += count
      digest.update(chunk.subarray(0, count))
    }
    return undefined
  } finally { closeSync(fd) }
}

type MoveState = 'happened' | 'not-happened' | 'held-back'
function moveEvidence(root: string, e: Evidence): MoveState {
  let sourceMatches = false
  let targetMatches = false
  try {
    const source = lstatSync(ordinary(root, e.from))
    sourceMatches = source.dev === e.dev && source.ino === e.ino
  } catch { /* Missing, linked or unreadable grants no identity. */ }
  try {
    const path = ordinary(root, e.to)
    const target = lstatSync(path)
    targetMatches = e.hash ? fileHash(path) === e.hash : target.dev === e.dev && target.ino === e.ino
    if (sourceMatches && targetMatches && !e.hash && e.from.toLowerCase() === e.to.toLowerCase()) {
      try {
        const actual = relativeHistoryPath(root, realpathSync.native(path))
        return actual === e.to ? 'happened' : actual === e.from ? 'not-happened' : 'held-back'
      } catch { return 'held-back' }
    }
  } catch { /* Existence alone never establishes ownership. */ }
  return targetMatches ? 'happened' : sourceMatches ? 'not-happened' : 'held-back'
}

function projectMovedVersions(root: string): { visible: Version[]; heldBack: Version[] } {
  const rows = journal(root)
  const states = finishState(rows)
  const versions = new Map<string, Version>()
  const assignedPaths = new Map<string, string>()
  const unresolved = new Set<string>()
  for (const row of rows) {
    if (!('kind' in row)) {
      const current = versions.get(row.id)
      if (!current || row.ts >= current.ts) versions.set(row.id, { ...row, path: assignedPaths.get(row.id) ?? row.path })
    } else if (row.kind === 'version-paths' && states.get(row.id) !== 'cancelled') {
      const state = states.get(row.id) === 'done' || !row.evidence ? 'happened' : moveEvidence(root, row.evidence)
      for (const a of row.assignments) {
        const version = versions.get(a.id)
        if (version?.path !== a.from) continue
        if (state === 'happened') {
          unresolved.delete(a.id)
          assignedPaths.set(a.id, a.to)
          versions.set(a.id, { ...version, path: a.to })
          if (row.heldBackIds?.includes(a.id)) unresolved.add(a.id)
        } else if (state === 'held-back') unresolved.add(a.id)
      }
    }
  }
  return {
    visible: sortVersionsNewestFirst([...versions.values()].filter(version => !unresolved.has(version.id))),
    heldBack: sortVersionsNewestFirst([...versions.values()].filter(version => unresolved.has(version.id))),
  }
}

export function readHeldBackVersions(root: string): Version[] { return projectMovedVersions(root).heldBack }

export function readMovedVersions(root: string): Version[] { return projectMovedVersions(root).visible }

/** Collection-wide notice: held-back versions are never offered as restorable file versions. */
export function waitingVersionHistory(root: string): Array<{ from: string; count: number }> {
  const counts = new Map<string, number>()
  for (const version of projectMovedVersions(root).heldBack) counts.set(version.path, (counts.get(version.path) ?? 0) + 1)
  return [...counts].map(([from, count]) => ({ from, count }))
}

function append(root: string, record: MoveRecord | Finish): void {
  assertCollectionWritable(root)
  // Non-recursive creation refuses a linked parent before the checked append.
  try { mkdirSync(join(realpathSync(root), '.writeflex')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  appendStoreLineSync(root, JOURNAL, `${JSON.stringify('assignments' in record ? { ts: Date.now(), ...record } : record)}\n`)
}

/** Called before a known move, including a folder move. No versions means no journal write. */
export function prepareVersionMove(root: string, from: string, to: string, copy = false): { id: string | null; finish(): void; cancel(): void } {
  settleVersionMoves(root)
  historyPath(from); historyPath(to)
  if (!readMovedVersions(root).length) return { id: null, finish() {}, cancel() {} }
  if (posix.dirname(to) !== '.') ordinary(root, posix.dirname(to))
  // Preserve the requested leaf for a genuine case-only rename, but resolve every parent.
  from = relativeHistoryPath(root, realpathSync.native(ordinary(root, from)))
  const parent = realLocation(dirname(join(root, to)))
  if (parent) to = relativeHistoryPath(root, join(parent, posix.basename(to)))
  if (from === to) return { id: null, finish() {}, cancel() {} }
  const versions = readMovedVersions(root)
  const records = journal(root)
  const states = finishState(records)
  const prior = records.slice().reverse().find((r): r is MoveRecord => 'kind' in r && r.kind === 'version-paths' && !!r.evidence && states.get(r.id) !== 'cancelled' && ((r.evidence.from === to && r.evidence.to === from) || (r.evidence.from === from && r.evidence.to === to)))
  const excluded = new Set(prior?.evidence?.from === to ? prior.destinationIds ?? [] : [])
  const assignments = versions.filter(v => !excluded.has(v.id) && (v.path === from || v.path.startsWith(`${from}/`))).map(v => ({ id: v.id, from: v.path, to: `${to}${v.path.slice(from.length)}` }))
  const destinationIds = versions.filter(v => v.path === to || v.path.startsWith(`${to}/`)).map(v => v.id)
  if (!assignments.length) return { id: null, finish() {}, cancel() {} }
  const source = ordinary(root, from)
  const info = lstatSync(source)
  const id = randomUUID()
  const evidence: Evidence = { from, to, dev: info.dev, ino: info.ino, ...(info.isFile() ? { beforeHash: fileHash(source) } : {}), ...(copy && info.isFile() ? { hash: fileHash((() => { try { return ordinary(root, to) } catch { return source } })()) } : {}) }
  if (copy && info.isFile() && !evidence.hash) throw new Error('This file is too large to identify a history copy safely.')
  append(root, { kind: 'version-paths', id, assignments, destinationIds, evidence })
  return {
    id,
    finish() {
      // The synced intent already carries history. A failed completion append must not turn a
      // successful file move into an unrecorded failure in its caller's rollback stack.
      finishVersionMove(root, id)
    },
    cancel() { append(root, { kind: 'version-paths-finish', id, state: 'cancelled' }) },
  }
}

/** Match Bridle's rename activity to the explicit move records made during those turns.
 * Some Bridle builds describe a rename as a deleted/created pair rather than a moved item. */
export function versionMovesForRestore(root: string, turns: ReadonlyArray<{ startedAt: number; endedAt?: number; items: ReadonlyArray<{ kind: string; capability: string; path?: string; toPath?: string }> }>): Array<{ from: string; to: string }> {
  const rows = journal(root)
  const result: Array<{ from: string; to: string }> = []
  for (const turn of turns) {
    const renamePaths = new Set(turn.items.filter(item => item.capability === 'housekeeping.rename_file').flatMap(item => [item.path, item.toPath].filter((path): path is string => !!path)))
    for (const row of rows.slice().reverse()) {
      if ('kind' in row && row.kind === 'version-paths' && row.evidence && row.ts !== undefined && row.ts >= turn.startedAt && row.ts <= (turn.endedAt ?? Infinity)
        && renamePaths.has(row.evidence.from) && renamePaths.has(row.evidence.to)) result.push({ from: row.evidence.to, to: row.evidence.from })
    }
  }
  return result
}

/** Bridle restores snapshots rather than calling Workspace.renameFile. Carry the exact
 * reversed move map in durable intents before that restore, including chains across turns. */
export function prepareVersionRestore(root: string, moves: ReadonlyArray<{ from: string; to: string }>): { settle(): void } {
  const rows = journal(root)
  const states = finishState(rows)
  const groups = new Map<string, { from: string; to: string; evidenceTo: string; hash?: string; assignments: Assignment[] }>()
  for (const version of readMovedVersions(root)) {
    let to = version.path
    let evidenceTo = version.path
    let originalHash: string | undefined
    for (const move of moves) {
      if (evidenceTo === move.from || evidenceTo.startsWith(`${move.from}/`)) {
        const forward = rows.slice().reverse().find((r): r is MoveRecord => 'kind' in r && r.kind === 'version-paths' && r.evidence?.from === move.to && r.evidence.to === move.from && states.get(r.id) !== 'cancelled')
        evidenceTo = `${move.to}${evidenceTo.slice(move.from.length)}`
        originalHash = forward?.evidence?.beforeHash
      }
      if (to !== move.from && !to.startsWith(`${move.from}/`)) continue
      const forward = rows.slice().reverse().find((r): r is MoveRecord => 'kind' in r && r.kind === 'version-paths' && r.evidence?.from === move.to && r.evidence.to === move.from && states.get(r.id) !== 'cancelled')
      if (forward?.destinationIds?.includes(version.id)) continue
      to = `${move.to}${to.slice(move.from.length)}`
    }
    if (to === version.path) continue
    const key = `${version.path}\0${to}`
    const group = groups.get(key) ?? { from: version.path, to, evidenceTo, hash: originalHash, assignments: [] }
    group.assignments.push({ id: version.id, from: version.path, to })
    groups.set(key, group)
  }
  const intents: MoveRecord[] = []
  try {
    for (const group of groups.values()) {
      const source = ordinary(root, group.from)
      const info = lstatSync(source)
      const record: MoveRecord = { kind: 'version-paths', id: randomUUID(), assignments: group.assignments,
        evidence: { from: group.from, to: group.evidenceTo, dev: info.dev, ino: info.ino, ...(group.hash ? { hash: group.hash } : {}) } }
      append(root, record)
      intents.push(record)
    }
  } catch (error) {
    for (const intent of intents) append(root, { kind: 'version-paths-finish', id: intent.id, state: 'cancelled' })
    throw error
  }
  return { settle() {
    for (const intent of intents) {
      const state = moveEvidence(root, intent.evidence!)
      if (state !== 'held-back') append(root, { kind: 'version-paths-finish', id: intent.id, state: state === 'happened' ? 'done' : 'cancelled' })
    }
  } }
}

/** Complete a move by its opaque id; no pinned filesystem path escapes a synchronous block. */
export function finishVersionMove(root: string, id: string | null): void {
  if (id === null) return
  try { append(root, { kind: 'version-paths-finish', id, state: 'done' }) } catch (error) {
    console.error('WriteFlex could not finish a version-history move; the next settle will retry.', { root, id, error })
  }
}

/** Freeze recovered moves. Cancellation is allowed only at fresh owner claim or before
 * a save in the Collection write turn; heartbeat checks may observe a move in flight. */
export function settleVersionMoves(root: string, cancelBeforeMove = false): void {
  const rows = journal(root)
  const finished = finishState(rows)
  for (const row of rows) {
    if ('kind' in row && row.kind === 'version-paths' && row.evidence && !finished.has(row.id)) {
      const evidence = moveEvidence(root, row.evidence)
      if (evidence === 'happened' || (cancelBeforeMove && evidence === 'not-happened')) {
        append(root, { kind: 'version-paths-finish', id: row.id, state: evidence === 'happened' ? 'done' : 'cancelled' })
      }
    }
  }
}

export async function withVersionMove<T>(root: string, from: string, to: string, move: () => Promise<T>): Promise<T> {
  let intent: ReturnType<typeof prepareVersionMove>
  try { intent = prepareVersionMove(root, from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOOP') throw error
    console.warn('The file rename will proceed, but its history cannot move through a linked path.', error)
    return move()
  }
  let result: T
  try { result = await move() } catch (error) { intent.cancel(); throw error }
  intent.finish()
  return result
}

export type HistoryFollowResult = { undo: string | null; attached: number; refused: Array<{ line: number; from: string; to: string; reason: string }> }

/** Read-only parser and validation shared by approval previews and map imports. */
export function previewVersionMap(root: string, text: string, heldBackOnly = false): { assignments: Assignment[]; accepted: Array<{ line: number; from: string; to: string }>; refused: HistoryFollowResult['refused'] } {
  const { visible, heldBack } = projectMovedVersions(root)
  const assignments: Assignment[] = []
  const used = new Set<string>()
  const result: ReturnType<typeof previewVersionMap> = { assignments, accepted: [], refused: [] }
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || (index === 0 && line === 'old_path\tnew_path')) return
    const [from = '', to = '', ...extra] = line.split('\t')
    try {
      historyPath(from); historyPath(to)
      if (extra.length) throw new Error('Give two paths separated by one tab.')
      if (!isHistoryMapPath(from, true) || !isHistoryMapPath(to)) throw new Error('A map may only name visible documents.')
      const pending = heldBack.filter(v => v.path === from)
      if (from === to && !pending.length) throw new Error('The old path has no history waiting to be reattached.')
      let sourceExists = false
      try {
        lstatSync(join(root, from))
        sourceExists = true
        if (!pending.length) throw new Error('The old path still exists; history can only follow an outside move.')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const target = ordinary(root, to)
      if (!lstatSync(target).isFile()) throw new Error('The new path is not a file.')
      // A live replacement keeps its own visible versions; only the held-back history moves.
      const found = heldBackOnly || sourceExists ? pending : [...visible.filter(v => v.path === from), ...pending]
      if (!found.length) throw new Error('The old path has no versions.')
      if (found.some(v => used.has(v.id))) throw new Error('The old path is listed more than once.')
      for (const v of found) { used.add(v.id); assignments.push({ id: v.id, from, to }) }
      result.accepted.push({ line: index + 1, from, to })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const reason = code === 'ENOENT' ? 'A map path does not exist; check the old and new workspace-relative paths.'
        : code === 'ELOOP' ? 'History cannot use a linked path.'
        : code === 'EACCES' || code === 'EPERM' ? 'A map path cannot be read; check its permissions.'
        : code ? 'A map path could not be checked; check the old and new workspace-relative paths.'
        : error instanceof Error ? error.message : 'The history map row could not be checked.'
      result.refused.push({ line: index + 1, from, to, reason })
    }
  })
  return result
}

/** The same dry-run parser determines the exact rows committed in one journal record. */
export function followVersionMap(root: string, text: string, approvedPlan?: string, heldBackOnly = false): HistoryFollowResult {
  const plan = previewVersionMap(root, text, heldBackOnly)
  if (approvedPlan !== undefined && JSON.stringify(plan) !== approvedPlan) throw new Error('History map validation changed since approval; preview again. Nothing was written.')
  const result: HistoryFollowResult = { undo: null, attached: plan.accepted.length, refused: plan.refused }
  if (plan.assignments.length) {
    settleVersionMoves(root)
    const heldBack = projectMovedVersions(root).heldBack
    const heldIds = new Set(heldBack.map(v => v.id))
    const reattachedIds = plan.assignments.filter(a => heldIds.has(a.id)).map(a => a.id)
    const taken = new Set(reattachedIds)
    const rows = journal(root)
    const finished = finishState(rows)
    // Retire the superseded inference before the map, in this same Collection write turn.
    for (const row of rows) {
      if ('kind' in row && row.kind === 'version-paths' && row.evidence && !finished.has(row.id) && row.assignments.some(a => taken.has(a.id))) {
        // Cancelling a folder intent must not expose descendants omitted from this map.
        // Freeze its held-back assignments first, so cancellation cannot release them on replay.
        const ids = new Set(row.assignments.map(a => a.id))
        const held = heldBack.filter(v => ids.has(v.id))
        append(root, { kind: 'version-paths', id: randomUUID(),
          assignments: held.map(v => ({ id: v.id, from: v.path, to: v.path })), heldBackIds: held.map(v => v.id) })
        append(root, { kind: 'version-paths-finish', id: row.id, state: 'cancelled' })
      }
    }
    result.undo = randomUUID()
    append(root, { kind: 'version-paths', id: result.undo, assignments: plan.assignments, reattachedIds })
  }
  return result
}

/** Exact inverse of only the versions the import moved. Refuses if any has since moved. */
export function undoVersionMap(root: string, id: string): number {
  const rows = journal(root)
  const record = rows.find((r): r is MoveRecord => 'kind' in r && r.kind === 'version-paths' && r.id === id && !r.evidence && !r.undoes)
  if (!record || rows.some(r => 'kind' in r && r.kind === 'version-paths' && r.undoes === id)) throw new Error('No pending history attachment with that id.')
  const current = new Map(readMovedVersions(root).map(v => [v.id, v.path]))
  if (record.assignments.some(a => current.get(a.id) !== a.to)) throw new Error('History moved again; Undo refused without changing anything.')
  append(root, { kind: 'version-paths', id: randomUUID(), undoes: id, heldBackIds: record.reattachedIds, assignments: record.assignments.map(a => ({ id: a.id, from: a.to, to: a.from })) })
  return record.assignments.length
}

export function relativeHistoryPath(root: string, absolute: string): string { return historyPath(relative(realpathSync(root), absolute).split('\\').join('/')) }

/** The latest explicit attachment still available to Undo for this file, including after reload. */
export function pendingHistoryAttachment(root: string, path: string): { id: string; files: number } | null {
  historyPath(path)
  const rows = journal(root)
  const undone = new Set(rows.flatMap(row => 'kind' in row && row.kind === 'version-paths' && row.undoes ? [row.undoes] : []))
  const current = new Map(readMovedVersions(root).map(version => [version.id, version.path]))
  for (const row of rows.slice().reverse()) {
    if (!('kind' in row) || row.kind !== 'version-paths' || row.evidence || row.undoes || undone.has(row.id)) continue
    if (row.assignments.some(a => a.to === path) && row.assignments.every(a => current.get(a.id) === a.to)) return { id: row.id, files: new Set(row.assignments.map(a => a.to)).size }
  }
  return null
}
