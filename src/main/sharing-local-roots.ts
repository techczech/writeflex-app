// Portable identities never change merely because a folder has a new local path.
import { statSync } from 'node:fs'
import type { WorkspaceIdentity } from '../../sharing-service/share-record-protocol.ts'
import { sharingWorkspace } from './sharing-workspace'
import { normaliseRoot as canonicalSharingRoot } from './root-resolution'
export { canonicalSharingRoot }

export type RememberedSharingRoot = { root: string; dev: number; ino: number }
// Strings are the pre-filesystem-identity settings format; upgraded on the next successful read.
export type SharingWorkspaceRoots = Record<string, string | RememberedSharingRoot>
export type WorkspaceRootsStore = { read(): SharingWorkspaceRoots; write(roots: SharingWorkspaceRoots): boolean }
function location(root: string): RememberedSharingRoot | null {
  try { const stat = statSync(root); return { root, dev: stat.dev, ino: stat.ino } }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null; throw error }
}
const sameFolder = (a: RememberedSharingRoot | null, b: RememberedSharingRoot | null) => !!a && !!b && a.dev === b.dev && a.ino === b.ino
export const sameSharingFolder = (a: string, b: string): boolean => {
  try { return sameFolder(location(a), location(b)) } catch { return false }
}
const pathOf = (value: string | RememberedSharingRoot) => typeof value === 'string' ? value : value.root

type Snapshot = { ids: WorkspaceIdentity[] | null; conflict: { roots: string[] } | null; at: number }

export function createLocalSharingRoots(ports: {
  store?: WorkspaceRootsStore
  openRoots?(): string[]
  now?(): number
  changed?(): void
}) {
  // Deliberately project only root locations: older settings may contain saved copy holds.
  let remembered: SharingWorkspaceRoots = Object.fromEntries(Object.entries(ports.store?.read() ?? {}).map(([id, v]) =>
    [id, typeof v === 'string' ? v : { root: v.root, dev: v.dev, ino: v.ino }]))
  const cache = new Map<string, Snapshot>()
  const refreshing = new Map<string, Promise<void>>()
  const now = ports.now ?? Date.now
  let revision = 0
  let queue: Promise<unknown> = Promise.resolve()
  function serial<T>(act: () => Promise<T>): Promise<T> {
    const next = queue.then(act, act)
    queue = next.catch(() => {})
    return next
  }

  // One snapshot of present facts. No cached conflict or closed, previously seen copy is a candidate.
  async function compute(root: string, create = false, remember = true): Promise<WorkspaceIdentity[]> {
    const before = revision
    const paths = new Set([...Object.values(remembered).map(pathOf), ...ports.openRoots?.() ?? [], root].map(canonicalSharingRoot))
    const facts = new Map<string, { here: RememberedSharingRoot | null; ids: WorkspaceIdentity[] | null }>()
    for (const path of paths) {
      let here: RememberedSharingRoot | null = null, ids: WorkspaceIdentity[] | null = []
      try {
        here = location(path)
        if (here) {
          ids = await sharingWorkspace(path, undefined, { readOnly: true })
          if (path === root && create && !ids.length) ids = await sharingWorkspace(path)
        }
      } catch { ids = null }
      facts.set(path, { here, ids })
    }
    // A watcher arrival during an awaited read invalidates the entire derived snapshot.
    if (before !== revision) return compute(root, create, remember)
    const byId = new Map<string, RememberedSharingRoot[]>()
    for (const { here, ids } of facts.values()) if (here) for (const id of ids ?? []) {
      const roots = byId.get(id.id) ?? []
      if (!roots.some(other => sameFolder(here, other))) roots.push(here)
      byId.set(id.id, roots)
    }
    const next = { ...remembered }
    for (const [id, roots] of byId) if (roots.length === 1) {
      // Prefer the open/current spelling after a case-only rename of the same physical folder.
      const preferred = [root, ...ports.openRoots?.() ?? []].map(canonicalSharingRoot)
        .map(path => facts.get(path)?.here).find(here => sameFolder(here ?? null, roots[0]))
      next[id] = preferred ?? roots[0]
    }
    if (remember && JSON.stringify(next) !== JSON.stringify(remembered)) {
      if (ports.store && !ports.store.write(next)) throw new Error('This Mac could not remember the shared original folder.')
      remembered = next
    }
    const at = now()
    for (const [path, { ids }] of facts) {
      const roots = new Set((ids ?? []).flatMap(id => {
        const matches = byId.get(id.id) ?? []
        return matches.length > 1 ? matches.map(here => here.root) : []
      }))
      cache.set(path, { ids, conflict: roots.size ? { roots: [...roots].sort() } : null, at })
    }
    const current = cache.get(root)
    return current?.conflict ? [] : current?.ids ?? []
  }
  function touch(root: string): Promise<void> {
    root = canonicalSharingRoot(root)
    const held = cache.get(root)
    if (held && now() - held.at < 5000) return Promise.resolve()
    const active = refreshing.get(root)
    if (active) return active
    const task = serial(async () => { await compute(root); ports.changed?.() }).finally(() => refreshing.delete(root))
    refreshing.set(root, task)
    return task
  }
  return {
    identify: (root: string, create = false) => serial(() => compute(canonicalSharingRoot(root), create)),
    touch,
    conflict: (root: string) => cache.get(canonicalSharingRoot(root))?.conflict ?? null,
    unreadable: (root: string) => cache.get(canonicalSharingRoot(root))?.ids === null,
    copied(record: { root: string; workspaceId?: string }): boolean {
      const held = cache.get(canonicalSharingRoot(record.root))
      return !!record.workspaceId && !!held?.ids && !held.ids.some(id => id.id === record.workspaceId)
    },
    invalidate(_root: string): void {
      revision++
      // Any identity arrival can release or impose a hold on the other known roots.
      for (const [key, held] of cache) cache.set(key, { ...held, at: -Infinity })
    },
    allowed(record: { root: string; workspaceId?: string }): boolean {
      const held = cache.get(canonicalSharingRoot(record.root))
      if (held?.conflict || held?.ids === null) return false
      return !record.workspaceId || !!held?.ids?.some(id => id.id === record.workspaceId)
    },
    chooseOriginal(root: string, chosen: string): Promise<boolean> {
      return serial(async () => {
        root = canonicalSharingRoot(root); chosen = canonicalSharingRoot(chosen)
        await compute(root)
        const problem = cache.get(root)?.conflict
        const original = location(chosen)
        if (!original || !problem?.roots.some(path => sameSharingFolder(path, chosen))) return false
        const ids = cache.get(chosen)?.ids ?? await sharingWorkspace(chosen, undefined, { readOnly: true })
        if (!ids.length) return false
        // Each physical copy occurs once. Re-read before writing; vanished or detached copies have
        // already resolved themselves. Every spelling of the chosen folder keeps its exact bytes.
        const written: RememberedSharingRoot[] = []
        for (const path of problem.roots) {
          const here = location(path)
          if (!here || sameFolder(here, original) || written.some(other => sameFolder(here, other))) continue
          const current = await sharingWorkspace(path, undefined, { readOnly: true })
          if (!current.some(id => ids.some(own => own.id === id.id))) continue
          if (!sameFolder(location(chosen), original) || !sameFolder(location(path), here)) return false
          await sharingWorkspace(path, undefined, { fresh: true })
          written.push(here)
        }
        // The choice persists only the copies' fresh identities. The next normal check remembers
        // single roots as usual; no hold or release flag is ever saved.
        await compute(chosen, false, false)
        return true
      })
    },
  }
}
