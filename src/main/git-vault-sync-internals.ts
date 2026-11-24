/** Closed, reader-audited policy for the two app-owned folders. See ADR 0055. */
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { forkArtifactSource, forkMarker, preserveJournalFork, projectJournalForks } from './git-vault-sync-journals'
import { parseChangeLine, mergeChangeJournalCopies, serializeChanges } from './changes'
import { refuse, type GitSyncWarning } from './git-vault-sync-types'
import type { SyncGit, TreeEntry } from './git-vault-sync-git'
export type InternalKind = 'object' | 'item' | 'ledger' | 'value' | 'local'
export function internalKind(path: string): InternalKind | null {
  const parts = path.split('/'), at = parts.findIndex(p => ['.bridle', '.writeflex'].includes(p.toLowerCase()))
  if (at < 0) return null
  const store = parts[at].toLowerCase(), rel = parts.slice(at + 1).join('/')
  const artifact = forkArtifactSource(path)
  if (artifact) return internalKind(artifact) === 'ledger' ? 'object' : 'local'
  const recovery = /\.git-incoming-[a-f0-9]{64}(?:-\d+)?$/.exec(rel)
  if (recovery) {
    const source = internalKind([...parts.slice(0, at + 1), rel.slice(0, recovery.index)].join('/'))
    return source && source !== 'local' ? 'object' : 'local'
  }
  if (/\.tmp$|\.lock$|\.taken$|(?:^|\/)tmp-/.test(rel)) return 'local'
  if (store === '.bridle') {
    if (/^objects\/[a-f0-9]{64}$/.test(rel)) return 'object'
    return /^journal(?:[- ].*)?\.jsonl$/.test(rel) ? 'ledger' : 'local'
  }
  if (/^sharing-workspace.* \(Git identity [a-f0-9]{64}(?:-\d+)?\)\.json$/.test(rel)) return 'object'
  if (/^(?:folio-objects|replica-versions\/objects)\/[a-f0-9]{64}$/.test(rel)) return 'object'
  if (/^replica-versions\/records\/[^/]+\.json$/.test(rel)) return 'object'
  if (/^(inbox|outbox)\/[^/]+\.json$/.test(rel)) return 'item'
  if (/^(sync-copies|rescue)\//.test(rel) || /^scratchpad-item-[^/]+\.md$/.test(rel)) return 'object'
  if (/^(changes|versions|folio-versions|folio-decisions|folio-save-commits)(?:[- ].*)?\.jsonl$/.test(rel)) return 'ledger'
  if (/^(vault|sharing-workspace(?:[- ].*)?|scratchpad-index|scratchpad-item-[^/]+|folio-declarations-set-aside)\.json$/.test(rel)) return 'value'
  return 'local' // unknown internal files are not authority to publish private state
}
export const sharedInternal = (path: string) => { const k = internalKind(path); return k !== null && k !== 'local' }
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex')
export function warn(warnings: GitSyncWarning[], warning: GitSyncWarning): void {
  if (!warnings.some(w => w.code === warning.code && w.path === warning.path && w.copy === warning.copy)) warnings.push(warning)
}
function lines(bytes: Buffer): { valid: string[]; damaged: boolean; chained: boolean } {
  const valid: string[] = []; let damaged = false, chained = false
  for (const line of bytes.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && ['prevHash', 'previousHash', 'previous_hash'].some(k => Object.hasOwn(value, k))) chained = true
      valid.push(line)
    } catch (error) { if (error instanceof Error && 'reason' in error) throw error; damaged = true }
  }
  return { valid, damaged, chained }
}
/** Preserve each branch's causal order; never sort rows by timestamps or IDs. */
function orderedUnion(a: string[], b: string[]): string[] {
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  return [...new Set([...a.slice(0, common), ...a.slice(common), ...b.slice(common)])]
}
function containsInOrder(base: string[], branch: string[]): boolean {
  let at = 0
  for (const line of branch) if (line === base[at]) at++
  return at === base.length
}
function changesSnapshot(changed: string[], base: string[]): string[] {
  const rows = changed.map(parseChangeLine), old = base.map(parseChangeLine)
  if (!rows.every(v => v !== null) || !old.every(v => v !== null)) return orderedUnion(base, changed)
  const held = new Map(rows.map(row => [row.id, row]))
  if (old.every(row => held.has(row.id))) return changed // incoming FF order is already authoritative
  const oldIds = new Set(old.map(row => row.id))
  return serializeChanges([...old.map(row => held.get(row.id) ?? row), ...rows.filter(row => !oldIds.has(row.id))]).trimEnd().split('\n').filter(Boolean)
}
/** Match SnapshotStore.publicEntries + snapshotRestorePointPath: first later write per point. */
function firstSnapshotWrites(rows: string[]) {
  const records = rows.map(line => JSON.parse(line) as Record<string, unknown>).filter(row => row && typeof row === 'object')
  const discarded = new Set(records.filter(row => row.kind === 'discard-restore-point').map(row => row.restorePointId))
  const points = new Map<string, { session: unknown; write?: string; writeSession?: unknown }>()
  let next: Record<string, unknown> | undefined
  for (const row of records.reverse()) {
    if (row.kind === 'snapshot' || row.kind === 'undo-action') next = row
    if (row.kind === 'restore-point' && typeof row.id === 'string' && !discarded.has(row.id)) points.set(row.id, {
      session: row.sessionId, ...(typeof next?.id === 'string' ? { write: next.id, writeSession: next.sessionId } : {}) })
  }
  return points
}
function snapshotOrder(candidate: string[], a: string[], b: string[]): boolean {
  const merged = firstSnapshotWrites(candidate)
  for (const source of [a, b]) for (const [id, before] of firstSnapshotWrites(source)) {
    const after = merged.get(id)
    // A different session's write after a shared unfinished point never supplies its own completion.
    if (before.write && (!before.session || !before.writeSession || before.session === before.writeSession)) {
      if (after?.write !== before.write) return false
    } else if (!before.write && after?.write && (!before.session || before.session !== after.writeSession)) return false
  }
  return true
}
function stamp(bytes: Buffer): number | null {
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    for (const key of ['updatedAt', 'modifiedAt', 'ts', 'createdAt']) {
      if (typeof value?.[key] === 'number' && Number.isFinite(value[key])) return value[key]
      if (typeof value?.[key] === 'string' && Number.isFinite(Date.parse(value[key]))) return Date.parse(value[key])
    }
  } catch { /* an opaque single-value file still has the keep-local fallback */ }
  return null
}
export async function reconcileInternals(input: {
  git: SyncGit; root: string; prefix: string; ours: Map<string, TreeEntry>; theirs: Map<string, TreeEntry>; base: Map<string, TreeEntry>
  ownName: string; otherName: string; live?: Map<string, Buffer>; oursFirst: boolean; conflicts: Set<string>; set: (path: string, entry?: TreeEntry) => Promise<void>; warnings: GitSyncWarning[]
}) {
  const { git, prefix, ours, theirs, base, set, warnings } = input
  const bytes = (entry?: TreeEntry) => entry ? git.ok(['cat-file', 'blob', entry.oid]) : Promise.resolve(Buffer.alloc(0))
  const write = async (path: string, content: Buffer, mode = '100644') => {
    const oid = (await git.ok(['hash-object', '-w', '--stdin'], {}, content)).toString().trim()
    await set(path, { mode, oid })
  }
  const preserve = async (path: string, data: Buffer, identity = false) => {
    let suffix = 1, copy: string
    for (;;) {
      copy = identity ? `${path.slice(0, -5)} (Git identity ${sha(data)}${suffix === 1 ? '' : `-${suffix}`}).json`
        : `${path}.git-incoming-${sha(data)}${suffix === 1 ? '' : `-${suffix}`}`
      const existing = ours.get(copy) ?? theirs.get(copy)
      if (existing && (await bytes(existing)).equals(data)) break
      if (!existing && !await lstat(join(input.root, copy)).then(() => true, () => false)) break
      suffix++
    }
    await write(copy, data)
    return copy.slice(prefix.length)
  }

  const forked = await projectJournalForks(input)
  for (const path of new Set([...ours.keys(), ...theirs.keys(), ...input.conflicts])) {
    if (forked.has(path) || [...forked].some(p => forkArtifactSource(path) === p)) continue
    if (!path.startsWith(prefix)) continue // sibling authority remains parcel 1's rule
    const kind = internalKind(path)
    if (!kind) continue
    const own = ours.get(path), other = theirs.get(path), ancestor = base.get(path)
    if (kind === 'local') {
      if (own || other) warn(warnings, { code: 'machine-local-tracked', path: path.slice(prefix.length), message: 'This machine-local path is already tracked. Its working file and index entry were left alone.' })
      if (input.conflicts.has(path)) await set(path, own ?? other)
      continue
    }
    if (own?.oid === other?.oid && own?.mode === other?.mode) continue
    if ((own && !['100644', '100755'].includes(own.mode)) || (other && !['100644', '100755'].includes(other.mode))) refuse('unsupported', 'An internal file is not a regular file.', path.slice(prefix.length))
    if (kind === 'item' && (!own || !other)) {
      // Request/reply removal is consumption, not loss of immutable history. Do not resurrect an unchanged consumed item.
      const remaining = own ?? other
      await set(path, ancestor?.oid === remaining?.oid ? undefined : remaining)
      continue
    }
    if (kind === 'object' || kind === 'item') {
      await set(path, own ?? other) // history objects are monotone, including a delete/edit conflict
      if (own && other && own.oid !== other.oid) {
        const copy = await preserve(path, await bytes(other))
        warn(warnings, { code: 'internal-content-mismatch', path: path.slice(prefix.length), copy, message: 'An immutable internal name had different bytes. The local bytes and a clearly named incoming copy were both kept.' })
      }
      continue
    }
    if (kind === 'value') {
      let winner = own ?? other
      if (own?.oid === ancestor?.oid) winner = other ?? own
      else if (other?.oid !== ancestor?.oid && own && other) {
        const a = stamp(await bytes(own)), b = stamp(await bytes(other))
        if (a !== null && b !== null && b > a) winner = other
        const identityCopy = /\/sharing-workspace.*\.json$/.test(path)
          ? await preserve(path, await bytes(winner === own ? other : own), true) : undefined
        warn(warnings, { ...(identityCopy ? { copy: identityCopy } : {}), code: 'internal-value-selected', path: path.slice(prefix.length), message: 'Concurrent internal settings were reconciled by their own timestamp, or kept local when no newer timestamp was available.' })
      }
      await set(path, winner)
      continue
    }
    const ownBytes = await bytes(own), otherBytes = await bytes(other)
    let a: ReturnType<typeof lines>, b: ReturnType<typeof lines>, ancestorLines: ReturnType<typeof lines>
    try { a = lines(ownBytes); b = lines(otherBytes); ancestorLines = lines(await bytes(ancestor)) } catch (error) {
      if (error && typeof error === 'object' && 'reason' in error) (error.reason as { document?: string }).document = path.slice(prefix.length)
      throw error
    }
    for (const [data, damaged] of [[ownBytes, a.damaged], [otherBytes, b.damaged]] as const) if (damaged) {
      const copy = await preserve(path, data)
      warn(warnings, { code: 'internal-ledger-recovery', path: path.slice(prefix.length), copy, message: 'Malformed ledger bytes were preserved separately. The shared ledger contains only complete valid JSON lines.' })
    }
    if (a.chained || b.chained || ancestorLines.chained) {
      if (own && other && own.oid !== ancestor?.oid && other.oid !== ancestor?.oid) await preserveJournalFork(input, path, true)
      else await write(path, own?.oid === ancestor?.oid ? otherBytes : ownBytes, (own ?? other)?.mode)
      continue
    }
    const [first, second] = input.oursFirst ? [a.valid, b.valid] : [b.valid, a.valid]
    let union = own?.oid === ancestor?.oid ? (containsInOrder(ancestorLines.valid, b.valid) ? b.valid : orderedUnion(ancestorLines.valid, b.valid))
      : other?.oid === ancestor?.oid ? (containsInOrder(ancestorLines.valid, a.valid) ? a.valid : orderedUnion(ancestorLines.valid, a.valid))
      : orderedUnion(first, second)
    union = [...new Set(union)]
    // ChangeStore rewrites decisions in place. Its existing merge handles pending -> decided and gives
    // different decisions stable derived IDs, so neither decision disappears behind a duplicate ID.
    if (/\/changes(?:[- ].*)?\.jsonl$/.test(path) && own && other) {
      if (own.oid === ancestor?.oid) union = changesSnapshot(b.valid, ancestorLines.valid)
      else if (other.oid === ancestor?.oid) union = changesSnapshot(a.valid, ancestorLines.valid)
      else {
        const x = first.map(parseChangeLine), y = second.map(parseChangeLine)
        if (x.every(v => v !== null) && y.every(v => v !== null)) union = changesSnapshot(serializeChanges(mergeChangeJournalCopies(x, [y])).trimEnd().split('\n').filter(Boolean), ancestorLines.valid)
      }
    }
    if (/\.bridle\/journal(?:[- ].*)?\.jsonl$/.test(path) && !snapshotOrder(union, a.valid, b.valid)) {
      const alternate = orderedUnion(second, first)
      if (!snapshotOrder(alternate, a.valid, b.valid)) { await preserveJournalFork(input, path, true); continue }
      union = alternate
    }
    await write(path, Buffer.from(union.length ? union.join('\n') + '\n' : ''), (own ?? other)?.mode)
  }
}
