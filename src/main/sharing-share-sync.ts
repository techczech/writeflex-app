// Account-wide discovery/backfill behind one seam. Local settings are a cache, not a registry.
import type { LinkRecord, WorkspaceIdentity } from '../../sharing-service/share-record-protocol.ts'
import { parseLinkRecord, workspaceIdentity } from '../../sharing-service/share-record-protocol.ts'
import type { ServiceAccess, ServiceClient } from './sharing-client'
import { readRecords, type ShareRecord } from './sharing-share-record'
import { sharingWorkspace } from './sharing-workspace'
import { canonicalSharingRoot, createLocalSharingRoots, sameSharingFolder, type WorkspaceRootsStore } from './sharing-local-roots'
import { isShareId } from '../../sharing-service/share-id.ts'

export function createShareSync(ports: {
  access(): ServiceAccess | null; client: ServiceClient
  records(): readonly ShareRecord[]; replace(records: ShareRecord[]): boolean
  tokenFor(id: string): string | null; keepToken(id: string, token: string): boolean
  workspaceRoots?: WorkspaceRootsStore
  openRoots?(): string[]
  now?(): number
  problem?(shareId: string, reason: string, kind?: import('../shared/sharing-links').SharePublishProblem['kind']): void
  changed?(): void
}) {
  const active = new Map<string, Promise<void>>()
  const refreshed = new Map<string, number>()
  const now = ports.now ?? Date.now
  const local = createLocalSharingRoots({ store: ports.workspaceRoots, openRoots: ports.openRoots, now, changed: ports.changed })
  function wire(record: ShareRecord, workspace: WorkspaceIdentity): LinkRecord {
    return { workspace, kind: record.kind, path: record.path, name: record.name, madeAt: record.madeAt, partKeys: record.partKeys, parts: record.parts }
  }
  async function register(record: ShareRecord): Promise<boolean> {
    const access = ports.access(), owner = ports.tokenFor(record.shareId)
    if (!access || !owner) return false
    let identity: WorkspaceIdentity | undefined
    try { identity = (await local.identify(record.root, !record.workspaceId))[0] } catch { return false }
    if (!identity || !local.allowed(record)) return false
    if (!parseLinkRecord(wire(record, identity))) {
      ports.problem?.(record.shareId, 'This link cannot be shared with other Macs: its path or part metadata is not uploadable. Paths cannot contain control characters or parent-folder steps; part titles must be at most 1,000 characters.', 'not-uploadable')
      return false
    }
    const answer = await ports.client.putRecord(access.base, record.shareId, owner, wire(record, identity))
    if (answer.kind === 'refused' && answer.code === 'older_service') ports.problem?.(record.shareId, 'Moved here; links follow once the sharing service is updated (Settings › Sharing › Update)', 'service-update')
    const kept = answer.kind === 'ok' && answer.body.kept === true
    const current = ports.records().find((r) => r.shareId === record.shareId)
    if (kept && current?.problem && ['not-uploadable', 'service-update'].includes(current.problem.kind)) ports.problem?.(record.shareId, '')
    if (kept && current && current.generation === record.generation && current.path === record.path) ports.replace(ports.records().map((r) => r === current ? { ...r, workspaceId: identity.id, registryPending: undefined } : r))
    return kept
  }
  async function refreshNow(root: string): Promise<void> {
    const access = ports.access()
    if (!access) return
    const before = JSON.stringify(local.conflict(root))
    const workspaces = await local.identify(root, ports.records().some((r) => canonicalSharingRoot(r.root) === root && !r.workspaceId))
    if (JSON.stringify(local.conflict(root)) !== before) ports.changed?.()
    // A case-only rename remains the same physical folder even while its identity is held.
    ports.replace(ports.records().map(record => sameSharingFolder(record.root, root) ? { ...record, root } : record))
    if (!workspaces.length) return
    // A moved folder (or an explicit original choice) carries its existing links to the new root.
    const nextRoots = ports.records().map((record) => {
      const follows = workspaces.some((id) => id.id === record.workspaceId) && !local.conflict(record.root)
      return follows || canonicalSharingRoot(record.root) === root ? { ...record, root } : record
    })
    if (!ports.replace(nextRoots)) return
    for (const record of ports.records().filter((r) => r.root === root && !local.allowed(r))) {
      ports.replace(ports.records().map((r) => r.shareId === record.shareId ? { ...r, problem: { kind: 'workspace-copy', reason: 'This folder was marked as a copy on another Mac. Its links stay with the original.', at: now() } } : r))
    }
    if ((refreshed.get(root) ?? 0) > now() && !ports.records().some((r) => r.root === root && r.registryPending)) return
    for (const record of ports.records().filter((r) => r.root === root && r.registryPending)) await register(record)
    let answer = await ports.client.listShares(access, workspaces)
    // Older services keep their existing behaviour until the user updates the service.
    if (answer.kind !== 'ok') return
    const canonical = workspaceIdentity(answer.body.workspace)
    if (!canonical || !Array.isArray(answer.body.records)) throw new Error('Invalid sharing registry answer.')
    // Discovery cannot rewrite a synced identity, including after an intervening copy choice.
    const stillHere = () => sharingWorkspace(root, undefined, { readOnly: true }).then((ids) => JSON.stringify(ids) === JSON.stringify(workspaces) && !local.conflict(root))
    if (!await stillHere()) return
    const known = new Set(answer.body.records.map((r) => r.shareId))
    let backfilled = false
    for (const record of ports.records().filter((r) => r.root === root && !known.has(r.shareId))) {
      if (await register(record)) backfilled = true
    }
    if (backfilled) answer = await ports.client.listShares(access, workspaces)
    if (answer.kind !== 'ok' || !await stillHere()) return
    const next = [...ports.records()]
    for (const remote of answer.body.records) {
      const identity = parseLinkRecord({ workspace: remote.workspace, kind: remote.kind, path: remote.path, name: remote.name, madeAt: remote.madeAt, partKeys: remote.partKeys, parts: remote.parts })
      if (!identity || !isShareId(remote.shareId)) continue
      if (!ports.tokenFor(remote.shareId)) {
        const minted = await ports.client.mintOwner(access, remote.shareId)
        if (minted.kind !== 'ok' || minted.body.shareId !== remote.shareId || typeof minted.body.ownerToken !== 'string' || minted.body.ownerToken.length < 16 || !ports.keepToken(remote.shareId, minted.body.ownerToken)) continue
      }
      if (!await stillHere()) return
      const at = next.findIndex((r) => r.shareId === remote.shareId), old = at >= 0 ? next[at] : null
      if (old && (old.root !== root || !local.allowed(old))) continue
      const seenPartKeys = old?.seenPartKeys ?? []
      const parsed = readRecords([{ ...old, ...identity, ...(identity.kind === 'folio' ? { seenPartKeys } : {}), ...(old?.registryPending ? { path: old.path, partKeys: old.partKeys, parts: old.parts } : {}), ...(old?.problem?.kind === 'workspace-copy' ? { problem: null } : {}), shareId: remote.shareId, root, workspaceId: canonical.id, comments: remote.revision === 0 && old ? old.comments : remote.comments === true, notes: remote.revision === 0 && old ? old.notes : remote.notes, hasPrivateComments: remote.hasPrivateComments, on: remote.on, revision: remote.revision, publishedAt: remote.publishedAt, publishedSavedAt: remote.savedAt, publishedHash: remote.sourceHash ?? null }])[0]
      if (!parsed) continue
      // An off state observed at the service cancels only publishing, not a local unsaved document.
      if (!parsed.on) { parsed.queuedAt = null; parsed.problem = null; parsed.lost = null }
      if (at < 0) next.push(parsed)
      else next[at] = parsed
    }
    if (!await stillHere()) return
    ports.replace(next)
    refreshed.set(root, now() + 60_000)
  }
  return {
    register,
    async rename(record: ShareRecord, name: string | null): Promise<boolean> {
      const access = ports.access(), owner = ports.tokenFor(record.shareId)
      if (!access || !owner) return false
      await local.identify(record.root, !record.workspaceId)
      if (!local.allowed(record)) return false
      const build = await ports.client.serviceBuild(access.base)
      if (build !== null && build < 15) return true
      const answer = await ports.client.getRecord(access.base, record.shareId, owner)
      if (answer.kind !== 'ok') return false
      const remote = answer.body
      const base = parseLinkRecord({ workspace: remote.workspace, kind: remote.kind, path: remote.path, name: remote.name, madeAt: remote.madeAt, partKeys: remote.partKeys, parts: remote.parts })
      if (!base) return false
      const unchanged = () => {
        const current = ports.records().find((r) => r.shareId === record.shareId)
        return current?.generation === record.generation && current.path === record.path && !current.registryPending
      }
      if (!unchanged()) return false
      const kept = await ports.client.putRecord(access.base, record.shareId, owner, { ...base, name }, base)
      if (kept.kind !== 'ok' || !unchanged()) return false
      return ports.replace(ports.records().map((r) => r.shareId === record.shareId ? { ...r, path: base.path, partKeys: base.partKeys, parts: base.parts, name } : r))
    },
    conflict: local.conflict,
    allowed: local.allowed,
    touch: local.touch,
    unreadable: local.unreadable,
    copied: local.copied,
    invalidate: local.invalidate,
    async chooseOriginal(root: string, chosen: string): Promise<boolean> {
      const ok = await local.chooseOriginal(root, chosen)
      if (ok) refreshed.clear()
      return ok
    },
    refresh(root: string, force = false): Promise<void> {
      root = canonicalSharingRoot(root)
      if (force) { refreshed.delete(root); local.invalidate(root) }
      const old = active.get(root)
      if (old) return old
      const task = refreshNow(root).finally(() => active.delete(root))
      active.set(root, task)
      return task
    },
  }
}
