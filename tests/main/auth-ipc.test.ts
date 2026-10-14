import { test, expect } from 'bun:test'
import { BridleAuth } from '@bridle/core'
import { AUTH_CHANNELS, type AuthUiEvent } from '@bridle/electron'
import { registerWriteFlexAuth, WRITEFLEX_AUTH_PROVIDERS } from '../../src/main/auth'

// Bridle auth migration (0.7 part a): WriteFlex's lanes ride the framework
// broker — openai-codex OAuth ("ChatGPT") + zai/anthropic API keys. The lane
// list moved here from the deleted bespoke auth-broker.ts; this pins it.

function makeAuth() {
  const events: AuthUiEvent[] = []
  const opened: string[] = []
  const handled = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const ipcMain = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => { handled.set(channel, listener) },
    removeHandler: (channel: string) => { handled.delete(channel) }
  }
  const { broker, dispose } = registerWriteFlexAuth(ipcMain, BridleAuth.inMemory(), {
    openExternal: (url) => opened.push(url),
    emit: (event) => events.push(event)
  })
  return { broker, dispose, events, opened, handled }
}

test('the WriteFlex lane set: openai-codex OAuth + zai/anthropic api-key', () => {
  const { broker } = makeAuth()
  const providers = broker.providers()
  expect(providers.map((p) => p.id).sort()).toEqual([...WRITEFLEX_AUTH_PROVIDERS].sort())
  const byId = new Map(providers.map((p) => [p.id, p]))
  expect(byId.get('openai-codex')!.authLanes).toContain('oauth')
  expect(byId.get('zai')!.authLanes).toContain('apikey')
  expect(byId.get('anthropic')!.authLanes).toContain('apikey')
})

test('registers every bridle.auth:* request channel and unregisters on dispose', () => {
  const { dispose, handled } = makeAuth()
  const requestChannels = [
    AUTH_CHANNELS.providers, AUTH_CHANNELS.login, AUTH_CHANNELS.cancel,
    AUTH_CHANNELS.respond, AUTH_CHANNELS.setApiKey, AUTH_CHANNELS.logout
  ]
  for (const channel of requestChannels) expect(handled.has(channel)).toBe(true)
  dispose()
  for (const channel of requestChannels) expect(handled.has(channel)).toBe(false)
})

test('set-api-key and logout round-trip through the registered handlers', async () => {
  const { handled } = makeAuth()
  const set = handled.get(AUTH_CHANNELS.setApiKey)!
  const providers = (await set({}, { providerId: 'zai', key: 'sk-test' })) as Array<{ id: string; configured: boolean }>
  expect(providers.find((p) => p.id === 'zai')!.configured).toBe(true)
  const logout = handled.get(AUTH_CHANNELS.logout)!
  const after = (await logout({}, 'zai')) as Array<{ id: string; configured: boolean }>
  expect(after.find((p) => p.id === 'zai')!.configured).toBe(false)
})

test('unknown-provider login finishes with ok:false instead of crashing', async () => {
  const { handled, events } = makeAuth()
  const login = handled.get(AUTH_CHANNELS.login)!
  await login({}, { providerId: 'not-a-provider' })
  expect(events.at(-1)).toMatchObject({ kind: 'login-finished', ok: false })
})
