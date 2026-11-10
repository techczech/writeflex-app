// Non-secret share identities. Absolute local roots and credentials have no field here.

export type WorkspaceIdentity = { id: string; createdAt: number }
export type LinkRecord = {
  workspace: WorkspaceIdentity; kind: 'piece' | 'folio'; path: string; name: string | null; madeAt: number
  partKeys: Record<string, string>; parts: Array<{ path: string; title: string; missing: boolean }>
}
export const workspaceIdentity = (v: unknown): WorkspaceIdentity | null => {
  const x = v as Partial<WorkspaceIdentity> | null
  return x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(x.id) && Number.isSafeInteger(x.createdAt) && x.createdAt! > 0 ? { id: x.id, createdAt: x.createdAt! } : null
}
export function safeRelative(v: unknown, empty = false): v is string {
  return typeof v === 'string' && (empty && v === '' || v.length > 0 && v.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(v) && !/^[A-Za-z]:\//.test(v) && !v.split('/').some((s) => !s || s === '.' || s === '..'))
}
export function parseLinkRecord(v: unknown): LinkRecord | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const x = v as Record<string, unknown>, workspace = workspaceIdentity(x.workspace)
  if (Object.keys(x).some((k) => !['workspace', 'kind', 'path', 'name', 'madeAt', 'partKeys', 'parts'].includes(k))) return null
  if (!workspace || x.kind !== 'piece' && x.kind !== 'folio' || !safeRelative(x.path, x.kind === 'folio')) return null
  if (x.name !== null && (typeof x.name !== 'string' || x.name.length > 60 || /[\x00-\x1f\x7f]/.test(x.name))) return null
  if (!Number.isSafeInteger(x.madeAt) || (x.madeAt as number) <= 0) return null
  if (!x.partKeys || typeof x.partKeys !== 'object' || Array.isArray(x.partKeys) || Object.entries(x.partKeys).length > 2000) return null
  if (Object.entries(x.partKeys).some(([p, key]) => !safeRelative(p) || typeof key !== 'string' || !/^[a-z][a-z0-9]{5}$/.test(key))) return null
  if (!Array.isArray(x.parts) || x.parts.length > 200 || x.parts.some((p) => !p || !safeRelative(p.path) || typeof p.title !== 'string' || p.title.length > 1000 || typeof p.missing !== 'boolean' || Object.keys(p).some((k) => !['path', 'title', 'missing'].includes(k)))) return null
  return { workspace, kind: x.kind, path: x.path, name: x.name as string | null, madeAt: x.madeAt as number, partKeys: { ...x.partKeys } as Record<string, string>, parts: x.parts.map((p) => ({ path: p.path, title: p.title, missing: p.missing })) }
}

