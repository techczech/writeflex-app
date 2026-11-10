import { errorResponse, jsonResponse } from './http.ts'
import { isShareId } from './share-id.ts'
import { workspaceIdentity, type WorkspaceIdentity } from './share-record-protocol.ts'

/** Registry directory only indexes shares; their own Durable Objects hold the current record/state. */
export class ShareDirectory {
  constructor(private readonly sql: SqlStorage) {
    sql.exec('CREATE TABLE IF NOT EXISTS workspace_aliases (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, canonical TEXT NOT NULL)')
    sql.exec('CREATE TABLE IF NOT EXISTS share_directory (share_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)')
  }
  private resolve(values: unknown): WorkspaceIdentity | null {
    if (!Array.isArray(values) || !values.length || values.length > 64) return null
    const checked = values.map(workspaceIdentity)
    if (checked.some((v) => !v)) return null
    const identities = new Map(checked.map((w) => [w!.id, w!]))
    // Previously folded aliases must survive a later request naming only the losing id.
    for (const w of identities.values()) {
      const old = [...this.sql.exec<{ canonical: string }>('SELECT canonical FROM workspace_aliases WHERE id = ?', w.id)][0]
      if (old) for (const row of this.sql.exec<{ id: string; created_at: number }>('SELECT id, created_at FROM workspace_aliases WHERE canonical = ?', old.canonical)) identities.set(row.id, { id: row.id, createdAt: row.created_at })
    }
    const winner = [...identities.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
    for (const w of identities.values()) this.sql.exec('INSERT INTO workspace_aliases (id, created_at, canonical) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET canonical = excluded.canonical', w.id, w.createdAt, winner.id)
    return winner
  }
  async route(request: Request, url: URL): Promise<Response | null> {
    if (!['/internal/share-directory/list', '/internal/share-directory/register'].includes(url.pathname)) return null
    if (request.method !== 'POST') return errorResponse('not_found', 'Registry route not found.', 404)
    const body = await request.json().catch(() => null) as { workspaces?: unknown; shareId?: unknown; workspace?: unknown } | null
    if (url.pathname.endsWith('/register')) {
      const w = workspaceIdentity(body?.workspace)
      if (!w || !isShareId(body?.shareId)) return errorResponse('invalid_record', 'Invalid share identity.', 400)
      this.resolve([w])
      this.sql.exec('INSERT INTO share_directory (share_id, workspace_id) VALUES (?, ?) ON CONFLICT(share_id) DO UPDATE SET workspace_id = excluded.workspace_id', body!.shareId as string, w.id)
      return jsonResponse({ registered: true })
    }
    const workspace = this.resolve(body?.workspaces)
    if (!workspace) return errorResponse('invalid_workspace', 'Invalid workspace identities.', 400)
    const ids = [...this.sql.exec<{ share_id: string }>('SELECT d.share_id FROM share_directory d JOIN workspace_aliases w ON d.workspace_id = w.id WHERE w.canonical = ? ORDER BY d.share_id', workspace.id)].map((r) => r.share_id)
    return jsonResponse({ workspace, ids })
  }
}
