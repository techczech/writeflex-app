// Authenticated per-share metadata and token audit. No local root, key or token is stored.
import { errorResponse, jsonResponse } from './http.ts'
import { parseLinkRecord, type LinkRecord } from './share-record-protocol.ts'

export class ShareOwnerState {
  constructor(private readonly sql: SqlStorage) {}
  ensure(): void {
    this.sql.exec('CREATE TABLE IF NOT EXISTS sharing_meta (id INTEGER PRIMARY KEY CHECK(id = 1), record TEXT, source_hash TEXT, changed_at INTEGER)')
    this.sql.exec('INSERT OR IGNORE INTO sharing_meta (id) VALUES (1)')
  }
  hash(): string | null {
    this.ensure()
    return [...this.sql.exec<{ source_hash: string | null }>('SELECT source_hash FROM sharing_meta WHERE id = 1')][0]?.source_hash ?? null
  }
  published(hash: string | null, folioState?: Pick<LinkRecord, 'partKeys' | 'parts'>): void {
    this.ensure()
    this.sql.exec('UPDATE sharing_meta SET source_hash = ?, changed_at = ? WHERE id = 1', hash, Date.now())
    const record = this.record()
    if (record && folioState) this.sql.exec('UPDATE sharing_meta SET record = ? WHERE id = 1', JSON.stringify({ ...record, ...folioState }))
  }
  changedAt(): number | null { this.ensure(); return [...this.sql.exec<{ changed_at: number | null }>('SELECT changed_at FROM sharing_meta WHERE id = 1')][0].changed_at }
  touch(): void { this.ensure(); this.sql.exec('UPDATE sharing_meta SET changed_at = ? WHERE id = 1', Date.now()) }
  record(): LinkRecord | null {
    this.ensure()
    const raw = [...this.sql.exec<{ record: string | null }>('SELECT record FROM sharing_meta WHERE id = 1')][0]?.record
    return raw ? parseLinkRecord(JSON.parse(raw)) : null
  }
  keep(value: unknown): Response {
    const envelope = value as { record?: unknown; baseRecord?: unknown } | null
    const conditional = envelope && Object.hasOwn(envelope, 'baseRecord')
    const record = parseLinkRecord(conditional ? envelope.record : value)
    if (!record) return errorResponse('invalid_record', 'The link record is invalid.', 400)
    this.ensure()
    // Backfill is idempotent. Later explicit metadata writes use the record already fetched by the app.
    const old = this.record()
    if (conditional && JSON.stringify(parseLinkRecord(envelope.baseRecord)) !== JSON.stringify(old)) return errorResponse('record_conflict', 'The link changed on another Mac. Read it again before renaming.', 409)
    const next = old && old.path === record.path ? { ...record, partKeys: old.partKeys, parts: old.parts } : record
    this.sql.exec('UPDATE sharing_meta SET record = ?, changed_at = ? WHERE id = 1', JSON.stringify(next), Date.now())
    return jsonResponse({ kept: true })
  }
  mint(value: unknown): Response {
    const computerId = (value as { computerId?: unknown } | null)?.computerId
    if (typeof computerId !== 'string' || !/^[a-z0-9]{1,64}$/.test(computerId)) return errorResponse('invalid_computer', 'A computer identity is required.', 400)
    this.sql.exec('CREATE TABLE IF NOT EXISTS owner_token_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, computer_id TEXT NOT NULL, at INTEGER NOT NULL)')
    const now = Date.now()
    const count = [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM owner_token_audit WHERE computer_id = ? AND at > ?', computerId, now - 3600000)][0].n
    if (count >= 10) return errorResponse('owner_token_rate', 'Too many owner tokens requested for this share. Try later.', 429)
    this.sql.exec('INSERT INTO owner_token_audit (computer_id, at) VALUES (?, ?)', computerId, now)
    // Keep recent requests for rate limiting and the latest 1000 older audit entries.
    this.sql.exec('DELETE FROM owner_token_audit WHERE at <= ? AND seq NOT IN (SELECT seq FROM owner_token_audit ORDER BY seq DESC LIMIT 1000)', now - 3600000)
    return jsonResponse({ allowed: true })
  }
}
