// Sharing's IPC and what the running app is pointed at (src/main/sharing-ipc.ts, cloudflare-api.ts),
// and the settings record (sharing-record.ts): the channels route to the set-up; the test stand-ins
// are honoured only in an unpackaged e2e run and only on loopback; the record keeps no secret and a
// malformed one reads as an earlier stage, never as "set up".
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CLOUDFLARE_API_BASE, cloudflareApiBase, loopbackOrigin } from '../../src/main/cloudflare-api.ts'
import { REMOVAL_CONFIRMATION_MS, SHARING_CHANNELS, registerSharingIpc } from '../../src/main/sharing-ipc.ts'
import { REMOVE_NOT_CONFIRMED } from '../../src/shared/sharing-setup.ts'
import { readSharingRecord } from '../../src/main/sharing-record.ts'
import type { SharingSetup } from '../../src/main/sharing-setup.ts'
import type { RemovalTarget } from '../../src/main/sharing-removal.ts'
import type { SharingRemovalQuestion, SharingResult } from '../../src/shared/sharing-setup.ts'
import { TOKEN, buildShipped, deletes, removeShipped, world } from '../helpers/sharing-world.ts'

describe('IPC', () => {
  /** The channels with a stand-in set-up; windows 1 and 3 are WriteFlex's, anything else is not. */
  function wired() {
    const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
    const calls: string[] = []
    const answer = (name: string) => async (...args: unknown[]) => { calls.push(`${name}(${args.map((arg) => JSON.stringify(arg)).join(',')})`); return { ok: true } }
    const target: RemovalTarget = { operation: 'remove', accountId: 'acc1', accountName: 'Personal', scriptName: 'writeflex-sharing', recordedBuild: 1, setUpAt: 5, anyway: null }
    let asks = false
    const setup = {
      status: answer('status'), checkToken: answer('checkToken'), checkSavedToken: answer('checkSavedToken'), chooseAccount: answer('chooseAccount'),
      setUp: answer('setUp'),
      remove: async (confirmed: RemovalTarget) => {
        calls.push(`remove(${confirmed.anyway ? `anyway ${confirmed.anyway.kind} ${confirmed.anyway.build}` : confirmed.operation} ${confirmed.accountId})`)
        return asks && !confirmed.anyway
          ? { ok: false, status: {}, problem: { reason: 'r', fix: 'f' }, removeAnyway: true, ask: { ...confirmed, anyway: { kind: 'replaced', build: 2 } } }
          : { ok: true, status: {} }
      },
      removalTarget: () => target, serviceAccess: () => null,
    } as unknown as SharingSetup
    const opened: string[] = []
    let clock = 1_000_000
    let n = 0
    registerSharingIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, setup, {
      openExternal: (url) => opened.push(url),
      isAppWindow: (id) => id === 1 || id === 3,
      now: () => clock,
      random: (bytes) => Buffer.alloc(bytes, (n += 1)),
    })
    const call = (channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input)
    return { handlers, calls, opened, call, tick: (ms: number) => { clock += ms }, asking: () => { asks = true } }
  }

  test('every channel routes to the set-up; Open Cloudflare opens the tokens page only', async () => {
    const { handlers, calls, opened, call } = wired()
    expect([...handlers.keys()]).toEqual([...SHARING_CHANNELS])
    await call('sharing:status', 1, { askService: true })
    await call('sharing:status', 1, { askService: 'yes' })
    await call('sharing:check-token', 1, 'cfut_x')
    await call('sharing:choose-account', 1, 'acc1')
    await call('sharing:set-up', 1)
    const { confirmation } = await call('sharing:removal-confirmation', 1) as { confirmation: string }
    await call('sharing:remove', 1, { confirmation })
    await call('sharing:open-cloudflare', 1, 'https://evil.example')
    expect(calls).toEqual(['status({"askService":true})', 'status({"askService":false})', 'checkToken("cfut_x")', 'chooseAccount("acc1")', 'setUp()', 'remove(remove acc1)'])
    expect(opened).toEqual(['https://dash.cloudflare.com/profile/api-tokens'])
  })

  test('a renderer that is not one of WriteFlex\'s windows is answered on no channel', async () => {
    const { calls, opened, call } = wired()
    for (const channel of SHARING_CHANNELS) expect(() => call(channel, 2, {})).toThrow('Not a WriteFlex window.')
    expect(calls).toEqual([])
    expect(opened).toEqual([])
  })

  test('remove needs the confirmation main issued: single-use, the same window, recent', async () => {
    const { calls, call, tick } = wired()
    const refused = async (input: unknown, sender = 1) => {
      const before = calls.filter((entry) => entry.startsWith('remove')).length
      const result = await call('sharing:remove', sender, input) as { ok: boolean; problem?: unknown }
      expect(result).toMatchObject({ ok: false, problem: REMOVE_NOT_CONFIRMED })
      expect(calls.filter((entry) => entry.startsWith('remove')).length).toBe(before)
    }
    await refused(undefined)
    await refused({ confirmation: 'a'.repeat(64) })
    // Issued to window 1, presented by window 3: refused, and used up.
    let { confirmation } = await call('sharing:removal-confirmation', 1) as { confirmation: string }
    await refused({ confirmation }, 3)
    await refused({ confirmation }, 1)
    // Too old.
    ;({ confirmation } = await call('sharing:removal-confirmation', 1) as { confirmation: string })
    tick(REMOVAL_CONFIRMATION_MS)
    await refused({ confirmation })
    // Right: once. A window's own `anyway` is not read: what may be deleted is bound in main.
    ;({ confirmation } = await call('sharing:removal-confirmation', 1) as { confirmation: string })
    await call('sharing:remove', 1, { confirmation, anyway: true })
    expect(calls.filter((entry) => entry.startsWith('remove'))).toEqual(['remove(remove acc1)'])
    await refused({ confirmation })
  })

  test('a removal that stops to ask answers with the Remove anyway confirmation, bound to the answer found, for that window only', async () => {
    const { calls, call, asking } = wired()
    asking()
    const { confirmation } = await call('sharing:removal-confirmation', 1) as { confirmation: string }
    const stopped = await call('sharing:remove', 1, { confirmation }) as { removeAnyway?: boolean; anywayConfirmation?: string; ask?: unknown }
    expect(stopped.removeAnyway).toBe(true)
    expect(stopped.anywayConfirmation).toMatch(/^[0-9a-f]{64}$/)
    expect(stopped.ask).toBeUndefined()
    // Another window cannot use it (and uses it up).
    expect(await call('sharing:remove', 3, { confirmation: stopped.anywayConfirmation })).toMatchObject({ ok: false, problem: REMOVE_NOT_CONFIRMED })
    const again = await call('sharing:remove', 1, { confirmation: (await call('sharing:removal-confirmation', 1) as { confirmation: string }).confirmation }) as { anywayConfirmation: string }
    await call('sharing:remove', 1, { confirmation: again.anywayConfirmation })
    expect(calls.filter((entry) => entry.startsWith('remove'))).toEqual(['remove(remove acc1)', 'remove(remove acc1)', 'remove(anyway replaced 2 acc1)'])
  })
})

describe('Retry does not evict its own Remove it anyway', () => {
  beforeAll(buildShipped)
  afterAll(removeShipped)

  test('a removal that did not finish, the service replaced: the Remove it anyway confirmation survives a new Retry question, and is single use', async () => {
    const w = world()
    expect((await w.setup.checkToken(TOKEN)).ok).toBe(true)
    expect((await w.setup.setUp()).ok).toBe(true)
    expect(w.settings.setSharingRecord({ ...w.settings.sharingRecord()!, stage: 'removing', serviceDeleted: false })).toBe(true)
    w.fake.accounts.acc1.script!.build = 2
    const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
    registerSharingIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.setup, { openExternal: () => {}, isAppWindow: (id) => id === 1, now: () => 1_000_000 })
    const call = (channel: string, input?: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)

    const first = await call('sharing:removal-confirmation') as SharingRemovalQuestion
    expect(first.retry).toBe(true)
    const stopped = await call('sharing:remove', { confirmation: first.confirmation }) as SharingResult
    expect(stopped).toMatchObject({ ok: false, removeAnyway: true })
    const anyway = (stopped as { anywayConfirmation?: string }).anywayConfirmation
    expect(anyway).toMatch(/^[0-9a-f]{64}$/)
    // The window asks for Retry's next confirmation (as RemoveSharing did before this round).
    expect((await call('sharing:removal-confirmation') as SharingRemovalQuestion).confirmation).toMatch(/^[0-9a-f]{64}$/)
    const removed = await call('sharing:remove', { confirmation: anyway }) as SharingResult
    expect(removed.ok).toBe(true)
    expect(w.fake.accounts.acc1.script).toBeNull()
    expect(deletes(w)).toHaveLength(1)
    expect(await call('sharing:remove', { confirmation: anyway })).toMatchObject({ ok: false, problem: REMOVE_NOT_CONFIRMED })
  })
})

describe('the settings record', () => {
  test('a pending removal is kept as such, even without an account', () => {
    expect(readSharingRecord({ stage: 'removing', account: { id: 'acc1', name: 'A' } })!.stage).toBe('removing')
    expect(readSharingRecord({ stage: 'removing' })!.stage).toBe('removing')
    expect(readSharingRecord({ stage: 'installing', account: { id: 'acc1', name: 'A' }, wrote: true })!.wrote).toBe(true)
  })
})

describe('where requests go', () => {
  test('the API stand-in is honoured only unpackaged, in an e2e run, on loopback /client/v4', () => {
    const loopback = 'http://127.0.0.1:4567/client/v4'
    expect(cloudflareApiBase({ packaged: false, e2e: true, override: loopback })).toBe(loopback)
    expect(cloudflareApiBase({ packaged: true, e2e: true, override: loopback })).toBe(CLOUDFLARE_API_BASE)
    expect(cloudflareApiBase({ packaged: false, e2e: false, override: loopback })).toBe(CLOUDFLARE_API_BASE)
    for (const elsewhere of ['http://example.com:4567/client/v4', 'http://127.0.0.1:4567/other', 'https://127.0.0.1:4567/client/v4', 'http://user@127.0.0.1:4567/client/v4']) {
      expect(cloudflareApiBase({ packaged: false, e2e: true, override: elsewhere })).toBe(CLOUDFLARE_API_BASE)
    }
    expect(loopbackOrigin('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567')
    expect(loopbackOrigin('http://localhost:4567')).toBeNull()
    expect(loopbackOrigin('http://127.0.0.1:4567/version')).toBeNull()
  })
})

describe('the settings record', () => {
  test('reads only its own fields; a stage missing what it needs reads as the stage before', () => {
    expect(readSharingRecord(undefined)).toBeNull()
    expect(readSharingRecord({ stage: 'unknown' })).toBeNull()
    const ready = readSharingRecord({ stage: 'ready', account: { id: 'acc1', name: 'A' }, address: 'https://writeflex-sharing.a.workers.dev', build: 1, token: 'cfut_secret', extra: 1 })
    expect(ready).toMatchObject({ stage: 'ready', account: { id: 'acc1', name: 'A' }, build: 1 })
    expect(JSON.stringify(ready)).not.toContain('cfut_secret')
    expect(readSharingRecord({ stage: 'ready', account: { id: 'acc1', name: 'A' }, address: 'https://elsewhere.example', build: 1 })!.stage).toBe('installing')
    expect(readSharingRecord({ stage: 'chosen', account: { id: '../x', name: 'A' } })!.stage).toBe('checked')
  })
})
