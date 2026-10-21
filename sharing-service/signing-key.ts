// The signing key: the HMAC key behind owner tokens. Copied from TalkWeaver's worker/signing-key.ts
// (its registry path; WriteFlex has no env signing secret, as no older sharing service exists).
//
// The singleton `SharingRegistry` object makes the key on its first request (32 random bytes,
// base64url) and keeps it in its `signing_key` table; it is never replaced. No computer holds it,
// and the app never sends, lists or stores it.
//
// Rules this file holds (each has a test in tests/main/sharing-service-signing-key.test.ts):
//   - the read-then-insert is one synchronous stretch, so two first requests get the same key;
//   - only an empty table makes a key; a read that fails, or a stored value that is not a key,
//     throws and nothing is generated or written over it;
//   - the key leaves the registry object on one internal route, `POST /internal/signing-key`, that
//     only this file builds a request for. The entry Worker never forwards a public request to the
//     registry at all;
//   - the key is never logged and never put in an error's text.
//
// BARRED: a Durable Object migration that deletes or renames `SharingRegistry`, or anything that
// clears its storage. It would end every owner token, so no app could publish to or turn off any
// share again (wrangler.jsonc carries the same warning).
import { errorResponse, jsonResponse, registryStub, type Env } from './http.ts'
import { NoteBudgetTable } from './note-budget.ts'

const SIGNING_KEY_PATH = '/internal/signing-key'
const SIGNING_KEY_BYTES = 32
const STORED_KEY = /^[A-Za-z0-9_-]{43}$/

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SIGNING_KEY_BYTES))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/** The `signing_key` table of the registry object: no row, or the one row that holds the key. */
export class SigningKeyTable {
  private readonly sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.sql = sql
    sql.exec('CREATE TABLE IF NOT EXISTS signing_key (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, created_at INTEGER NOT NULL)')
  }

  /** The stored key, made first when the table is empty. Synchronous on purpose. */
  fetchOrCreate(): string {
    const rows = [...this.sql.exec<{ key: unknown }>('SELECT key FROM signing_key')]
    if (rows.length > 1) throw new Error('The signing key table holds more than one row.')
    if (rows.length === 1) {
      const stored = rows[0].key
      if (typeof stored !== 'string' || !STORED_KEY.test(stored)) throw new Error('The stored signing key is not readable.')
      return stored
    }
    const made = generateKey()
    this.sql.exec('INSERT INTO signing_key (id, key, created_at) VALUES (1, ?, ?)', made, Date.now())
    return made
  }

  route(request: Request, url: URL): Response | null {
    if (url.pathname !== SIGNING_KEY_PATH) return null
    if (request.method !== 'POST') return errorResponse('not_found', 'Registry route not found.', 404)
    try {
      return jsonResponse({ key: this.fetchOrCreate() })
    } catch (error) {
      console.error('[signing-key] the registry could not read or keep its key:', error instanceof Error ? error.name : 'error')
      return errorResponse('signing_key_unavailable', 'The sharing service could not read its signing key.', 500)
    }
  }
}

/**
 * The singleton registry object. It holds the signing key and, in a table of its own, the
 * service-wide count of readers' notes (note-budget.ts).
 */
export class SharingRegistry {
  private readonly keys: SigningKeyTable
  private readonly budget: NoteBudgetTable

  constructor(state: DurableObjectState, _env: unknown) {
    this.keys = new SigningKeyTable(state.storage.sql)
    this.budget = new NoteBudgetTable(state.storage.sql)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    return this.keys.route(request, url) ?? await this.budget.route(request, url) ?? errorResponse('not_found', 'Registry route not found.', 404)
  }
}

/** Thrown when the registry did not hand over its key. Carries no key. */
export class SigningKeyUnavailable extends Error {
  constructor(reason: string) {
    super(`The sharing service could not read its signing key (${reason}).`)
    this.name = 'SigningKeyUnavailable'
  }
}

// The registry's key, per isolate, by the namespace it came from. Never replaced, so it cannot go
// stale. A failed fetch is never remembered.
const registryKeys = new WeakMap<object, string>()

/** The key to sign and verify owner tokens with. Throws `SigningKeyUnavailable`, never makes one up. */
export async function signingKey(env: Env): Promise<string> {
  const namespace = env.SHARING_REGISTRY
  const remembered = registryKeys.get(namespace)
  if (remembered !== undefined) return remembered
  let response: Response
  try {
    response = await registryStub(env).fetch(new Request(`https://internal${SIGNING_KEY_PATH}`, { method: 'POST' }))
  } catch {
    throw new SigningKeyUnavailable('the registry could not be reached')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new SigningKeyUnavailable(`the registry answered ${response.status}`)
  }
  const body = await response.json().catch(() => null) as { key?: unknown } | null
  const key = body?.key
  if (typeof key !== 'string' || !STORED_KEY.test(key)) throw new SigningKeyUnavailable('the registry answered without a key')
  registryKeys.set(namespace, key)
  return key
}
