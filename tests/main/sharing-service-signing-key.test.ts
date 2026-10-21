// The sharing service's signing key (sharing-service/signing-key.ts): made once by the registry
// object, never replaced, never made over a value it cannot read, and never in an error's text.
import { describe, expect, test } from 'bun:test'
import { SigningKeyTable, SharingRegistry, SigningKeyUnavailable, signingKey } from '../../sharing-service/signing-key.ts'
import type { Env } from '../../sharing-service/http.ts'
import { fakeObjectState } from '../helpers/sharing-service-runtime.ts'

describe('the signing key table', () => {
  test('makes one key and gives the same one back', () => {
    const state = fakeObjectState()
    const first = new SigningKeyTable(state.storage.sql as never).fetchOrCreate()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(new SigningKeyTable(state.storage.sql as never).fetchOrCreate()).toBe(first)
    expect(state.db.query('SELECT COUNT(*) AS n FROM signing_key').get()).toEqual({ n: 1 })
  })

  test('a stored value that is not a key is never replaced; the registry answers 500 without it', async () => {
    const state = fakeObjectState()
    new SigningKeyTable(state.storage.sql as never)
    state.db.query("INSERT INTO signing_key (id, key, created_at) VALUES (1, 'not a key', 0)").run()
    const registry = new SharingRegistry(state as never, {})
    const response = await registry.fetch(new Request('https://internal/internal/signing-key', { method: 'POST' }))
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('not a key')
    expect(state.db.query('SELECT key FROM signing_key').get()).toEqual({ key: 'not a key' })
  })

  test('the registry hands the key out on its one internal route only', async () => {
    const registry = new SharingRegistry(fakeObjectState() as never, {})
    expect((await registry.fetch(new Request('https://internal/internal/signing-key'))).status).toBe(404)
    expect((await registry.fetch(new Request('https://internal/anything', { method: 'POST' }))).status).toBe(404)
  })
})

describe('signingKey', () => {
  test('a registry that cannot answer gives an error with no key in it', async () => {
    const env = { SHARING_REGISTRY: { idFromName: () => 'x', get: () => ({ fetch: async () => new Response('{"key":"short"}') }) } } as unknown as Env
    const error = await signingKey(env).catch((e) => e)
    expect(error).toBeInstanceOf(SigningKeyUnavailable)
    expect(String(error.message)).not.toContain('short')
  })
})
