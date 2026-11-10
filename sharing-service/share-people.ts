// Personal credentials and identity live together; callers retain only an identity lease and
// recheck it synchronously after awaited work, immediately before reading or writing content.
import { constantTimeEqual, hmac, hashSecret } from './auth.ts'
import { stripPersonCharacters, validPersonEmail } from './person-email.ts'
import { errorResponse, jsonResponse } from './http.ts'

export type PersonRow = { id: string; name: string; email: string; salt: string; status: 'on' | 'off'; removed: number; created_at: number; opened_at: number | null; open_count: number }
export type PersonLease = Pick<PersonRow, 'id' | 'salt' | 'name'> & { readerKey: string }
export type PersonView = { id: string; name: string; email: string; status: 'on' | 'off'; createdAt: number; openedAt: number | null; openCount: number; commentCount: number; token: string }
export function ensurePeopleSchema(sql: SqlStorage): void {
  if (![...sql.exec<{ name: string }>('PRAGMA table_info(share)')].some(c => c.name === 'plain_link')) sql.exec('ALTER TABLE share ADD COLUMN plain_link INTEGER NOT NULL DEFAULT 1')
  if (![...sql.exec<{ name: string }>('PRAGMA table_info(notes)')].some(c => c.name === 'person_id')) sql.exec('ALTER TABLE notes ADD COLUMN person_id TEXT')
  sql.exec(`CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, salt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'on', removed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, opened_at INTEGER, open_count INTEGER NOT NULL DEFAULT 0)`)
  // One page-load nonce is retained for a bounded interval, so retries/polls cannot add openings.
  sql.exec('CREATE TABLE IF NOT EXISTS person_openings (person_id TEXT NOT NULL, load_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(person_id, load_id))')
}
export class SharePeople {
  constructor(private readonly sql: SqlStorage) {}
  private rows(): PersonRow[] { return [...this.sql.exec<PersonRow>('SELECT * FROM people')] }
  private token(shareId: string, p: PersonRow, key: string): Promise<string> { return hmac(`person:${shareId}:${p.id}:${p.salt}`, key) }
  private async list(shareId: string, key: string): Promise<PersonView[]> {
    const rows = this.rows().filter(p => !p.removed)
    return Promise.all(rows.map(async p => ({ id: p.id, name: p.name, email: p.email, status: p.status, createdAt: p.created_at, openedAt: p.opened_at, openCount: p.open_count,
      commentCount: [...this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM notes WHERE person_id = ?', p.id)][0]?.n ?? 0, token: await this.token(shareId, p, key) })))
  }
  async resolve(shareId: string, token: unknown, key: string): Promise<PersonLease | null> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    key = await hmac('writeflex-person-token-v1', key)
    // The opaque credential contains no id. The share caps this bounded search at 100 people.
    for (const p of this.rows()) {
      if (p.removed || p.status !== 'on') continue
      if (constantTimeEqual(await this.token(shareId, p, key), token)) return { id: p.id, salt: p.salt, name: p.name, readerKey: await hashSecret(`person:${shareId}:${p.id}`) }
    }
    return null
  }
  current(lease: PersonLease): boolean {
    return this.rows().some(p => p.id === lease.id && p.salt === lease.salt && p.status === 'on' && !p.removed)
  }
  opened(lease: PersonLease, load: unknown): void {
    if (typeof load !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(load)) return
    const now = Date.now()
    this.sql.exec('DELETE FROM person_openings WHERE at < ?', now - 86_400_000)
    if ([...this.sql.exec('SELECT load_id FROM person_openings WHERE person_id = ? AND load_id = ?', lease.id, load)].length) return
    this.sql.exec('INSERT INTO person_openings(person_id, load_id, at) VALUES (?, ?, ?)', lease.id, load, now)
    this.sql.exec('UPDATE people SET opened_at = ?, open_count = open_count + 1 WHERE id = ?', now, lease.id)
  }
  async owner(shareId: string, key: string, method: string, value: unknown): Promise<Response> {
    key = await hmac('writeflex-person-token-v1', key)
    if (method === 'GET') return jsonResponse({ people: await this.list(shareId, key), plainLink: this.plainLink() })
    const v = value as { id?: unknown; name?: unknown; email?: unknown; status?: unknown; remove?: unknown; reissue?: unknown; plainLink?: unknown } | null
    if (!v || typeof v !== 'object') return errorResponse('invalid_person', 'Enter a name and email address.', 400)
    if (Object.hasOwn(v, 'plainLink')) {
      if (typeof v.plainLink !== 'boolean') return errorResponse('invalid_person', 'Choose whether the plain link is on.', 400)
      this.sql.exec('UPDATE share SET plain_link = ? WHERE id = 1', v.plainLink ? 1 : 0)
    } else if (typeof v.id === 'string') {
      if (!this.rows().some(p => p.id === v.id && !p.removed)) return errorResponse('unknown_person', 'This person is no longer listed.', 404)
      if (v.remove === true) this.sql.exec("UPDATE people SET removed = 1, status = 'off', email = '' WHERE id = ?", v.id)
      else if (v.reissue === true) this.sql.exec('UPDATE people SET salt = ? WHERE id = ?', crypto.randomUUID(), v.id)
      else if (v.status === 'on' || v.status === 'off') this.sql.exec('UPDATE people SET status = ? WHERE id = ?', v.status, v.id)
      else return errorResponse('invalid_person', 'Choose on or off.', 400)
    } else {
      const name = typeof v.name === 'string' ? stripPersonCharacters(v.name) : ''
      const email = typeof v.email === 'string' ? stripPersonCharacters(v.email) : ''
      if (!name || name.length > 80 || !validPersonEmail(email)) return errorResponse('invalid_person', 'Enter a name (1–80 characters) and a valid email address.', 400)
      const rows = this.rows()
      if (rows.filter(p => !p.removed).length >= 100) return errorResponse('people_full', 'This link has reached its limit of 100 people.', 409)
      if (rows.length >= 500) return errorResponse('people_storage_full', 'This link has reached its limit of 500 retained people records.', 409)
      const id = crypto.randomUUID()
      this.sql.exec("INSERT INTO people(id, name, email, salt, created_at) VALUES (?, ?, ?, ?, ?)", id, name, email, crypto.randomUUID(), Date.now())
      const person = (await this.list(shareId, key)).find(p => p.id === id)!
      return jsonResponse({ person, token: person.token }, 201)
    }
    return jsonResponse({ people: await this.list(shareId, key), plainLink: this.plainLink() })
  }
  plainLink(): boolean { return [...this.sql.exec<{ plain_link: number }>('SELECT plain_link FROM share WHERE id = 1')][0]?.plain_link !== 0 }
}
