// Setting up sharing, once (src/main/sharing-setup.ts; sharing ticket 02, spec 4.1, 6.1 and 8),
// against a recorded stand-in for Cloudflare's API (tests/helpers/fake-cloudflare.ts) with the real
// bundle built from sharing-service/. No real Cloudflare call is made.
//
// The states of the ticket: first run; wrong token; token lacking a permission; set-up interrupted
// and resumed; a second Mac joining an account that already has the service; an older service
// updated; token rejected later; remove sharing. Throughout: the token is never in settings, in any
// status or result, in any request to the sharing service, or anywhere on the wire but the
// Authorization header to Cloudflare.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SharingSettingsPanel } from '../../src/renderer/src/components/settings/SharingSettingsPanel'
import { createSharingSetup, readKeyBlob } from '../../src/main/sharing-setup.ts'
import { SHARING_SERVICE_BUILD } from '../../sharing-service/version.ts'
import { NOT_OURS } from '../../src/main/sharing-setup.ts'
import {
  APP_OLDER, INSTALLATION_PROBLEM, JOINED_NOTICE, OVERWRITTEN_NEWER, OVERWRITTEN_OLDER, REMOVAL_PENDING, SERVICE_CHANGED, accountLocked, NO_ACCOUNTS, NO_WORKERS_ACCOUNT, NO_WORKERS_ADDRESS, OFFLINE, SAVED_TOKEN_REJECTED,
  TOKEN_EXPIRED, TOKEN_REJECTED, TOKEN_SHAPE, UPDATED_NOTICE,
} from '../../src/shared/sharing-setup.ts'
import { createFakeCloudflare, newScript, uploadFromElsewhere } from '../helpers/fake-cloudflare.ts'
import {
  OTHER_TOKEN, TOKEN, apiCalls, buildShipped, deletes, expectTokenNowhere, problemOf, removeAnyway, removeNow, removeShipped, shipped, twoAccounts, world,
} from '../helpers/sharing-world.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

describe('first run', () => {
  test('paste, check, account, Set up sharing: the service is uploaded, this Mac\'s key added, never asked again', async () => {
    const w = world()
    const before = await w.setup.status()
    expect(before.ready).toBe(false)
    expect(before.token.stored).toBe(false)

    const checked = await w.setup.checkToken(`  ${TOKEN}\n`)
    expect(checked.ok).toBe(true)
    expect(checked.status.token.stored).toBe(true)
    expect(checked.status.accounts).toEqual([{ id: 'acc1', name: 'Example author · personal account', workers: true, address: 'https://writeflex-sharing.example.workers.dev' }])
    // One usable account: chosen for the person.
    expect(checked.status.account).toEqual({ id: 'acc1', name: 'Example author · personal account' })
    // Checking a token writes nothing at Cloudflare.
    expect(w.fake.requests.every((entry) => entry.method === 'GET')).toBe(true)

    const chosen = await w.setup.chooseAccount('acc1')
    const done = await w.setup.setUp()
    expect(done).toMatchObject({ ok: true, status: { ready: true, address: 'https://writeflex-sharing.example.workers.dev', interrupted: false } })
    expect(done.ok && done.notice).toBeFalsy()

    expect(apiCalls(w).slice(3)).toEqual([
      'GET /accounts/acc1/workers/services/writeflex-sharing',
      'GET /accounts/acc1/workers/subdomain',
      'PUT /accounts/acc1/workers/scripts/writeflex-sharing',
      'POST /accounts/acc1/workers/scripts/writeflex-sharing/subdomain',
      'GET /accounts/acc1/workers/scripts/writeflex-sharing/deployments',
      'PATCH /accounts/acc1/workers/scripts/writeflex-sharing/secrets-bulk',
      'GET /accounts/acc1/workers/scripts/writeflex-sharing/secrets',
    ])
    const upload = w.fake.requests.find((entry) => entry.method === 'PUT')!
    expect(new URL(upload.url).search).toBe('?excludeScript=true&bindings_inherit=strict')
    expect(upload.body).toContain('"new_tag":"v1"')
    expect(upload.body).toContain('"class_name":"SharingRegistry"')

    // The key: made on this Mac, kept in the Keychain, sent once under this Mac's name only.
    const keys = readKeyBlob(w.secrets.store.read('sharing-keys'))
    expect(keys).toHaveLength(1)
    const secretNames = Object.keys(w.fake.accounts.acc1.script!.secrets)
    expect(secretNames).toEqual([`ADMIN_SECRET_${keys[0].computerId}`])
    expect(w.fake.accounts.acc1.script!.secrets[secretNames[0]] === keys[0].key).toBe(true)
    const patch = w.fake.requests.find((entry) => entry.method === 'PATCH')!
    expect(Object.keys(JSON.parse(patch.body).secrets)).toEqual(secretNames)
    for (const request of w.fake.requests) expect(request.url).not.toContain(keys[0].key)
    expect(w.fake.wire('service')).not.toContain(keys[0].key)
    expect(readFileSync(w.settingsPath, 'utf8')).not.toContain(keys[0].key)

    expectTokenNowhere(w, [checked, chosen, done])

    // Set-up is never asked for again on this Mac: a fresh start reads it as done.
    const again = world({ secrets: w.secrets, settingsPath: w.settingsPath, fake: w.fake })
    expect((await again.setup.status()).ready).toBe(true)
    expect(again.setup.serviceAccess()).toEqual({
      address: 'https://writeflex-sharing.example.workers.dev', base: 'https://writeflex-sharing.example.workers.dev', key: keys[0].key,
      // Ticket 05: no own address, so links read the Cloudflare address, with no end to it.
      linkAddress: 'https://writeflex-sharing.example.workers.dev', linkAddressUntil: null, ownAddress: null,
    })
  })
})

describe('the token', () => {
  test('wrong token: the plain reason and the fix; nothing kept', async () => {
    const w = world()
    const result = await w.setup.checkToken(OTHER_TOKEN)
    expect(problemOf(result)).toEqual(TOKEN_REJECTED)
    expect(w.secrets.store.has('cloudflare-token')).toBe(false)
    expect(w.settings.sharingRecord()).toBeNull()
    expectTokenNowhere(w, [result], OTHER_TOKEN)
  })

  test('not a token at all: refused before anything is sent', async () => {
    const w = world()
    expect(problemOf(await w.setup.checkToken('not a token'))).toEqual(TOKEN_SHAPE)
    expect(w.fake.requests).toEqual([])
  })

  test('expired token', async () => {
    const w = world()
    w.fake.tokens[TOKEN].status = 'expired'
    expect(problemOf(await w.setup.checkToken(TOKEN))).toEqual(TOKEN_EXPIRED)
    expect(w.secrets.store.has('cloudflare-token')).toBe(false)
  })

  test('lacking Account Settings · Read: names that permission', async () => {
    const w = world()
    w.fake.tokens[TOKEN].accounts = []
    const result = await w.setup.checkToken(TOKEN)
    expect(problemOf(result)).toEqual(NO_ACCOUNTS)
    expect(problemOf(result)!.reason).toBe('The token is missing the permission “Account · Account Settings · Read”.')
  })

  test('lacking Workers Scripts: names that permission; a token that can only read is caught at the upload', async () => {
    const none = world()
    none.fake.tokens[TOKEN].workers = 'none'
    const refused = await none.setup.checkToken(TOKEN)
    expect(problemOf(refused)).toEqual(NO_WORKERS_ACCOUNT)
    expect(problemOf(refused)!.reason).toBe('The token is missing the permission “Account · Workers Scripts · Edit”.')
    expect(none.secrets.store.has('cloudflare-token')).toBe(false)

    const readOnly = world()
    readOnly.fake.tokens[TOKEN].workers = 'read'
    expect((await readOnly.setup.checkToken(TOKEN)).ok).toBe(true)
    const result = await readOnly.setup.setUp()
    expect(problemOf(result)).toEqual(NO_WORKERS_ACCOUNT)
    expect(result.ok ? '' : result.details).toBe('Uploading the sharing service: Cloudflare answered 403 (error 10000).')
    expect(readOnly.fake.accounts.acc1.script).toBeNull()
  })

  test('an account with no workers.dev address yet', async () => {
    const w = world()
    w.fake.accounts.acc1.subdomain = null
    expect((await w.setup.checkToken(TOKEN)).ok).toBe(true)
    expect(problemOf(await w.setup.setUp())).toEqual(NO_WORKERS_ADDRESS)
  })

  test('token rejected later: Settings says so, the service is untouched, a new token clears it', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    const service = structuredClone(w.fake.accounts.acc1.script)
    w.fake.tokens[TOKEN].status = 'expired'
    const checked = await w.setup.checkSavedToken()
    expect(problemOf(checked)).toEqual(SAVED_TOKEN_REJECTED)
    expect(checked.status.ready).toBe(true)
    expect(checked.status.token.problem).toEqual(SAVED_TOKEN_REJECTED)
    expect(w.fake.accounts.acc1.script).toEqual(service)

    w.fake.tokens[OTHER_TOKEN] = { status: 'active', accounts: ['acc1'], workers: 'edit' }
    const replaced = await w.setup.checkToken(OTHER_TOKEN)
    expect(replaced.ok && replaced.status.token.problem).toBeNull()
    expect(w.secrets.store.read('cloudflare-token') === OTHER_TOKEN).toBe(true)
    expectTokenNowhere(w, [checked, replaced])
    expectTokenNowhere(w, [checked, replaced], OTHER_TOKEN)
  })
})

describe('resuming and joining', () => {
  test('set-up interrupted after the upload: resumed by pressing Set up sharing again, nothing uploaded twice', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    w.fake.failOnce('POST', /\/subdomain$/, 'network')
    const stopped = await w.setup.setUp()
    expect(problemOf(stopped)).toEqual(OFFLINE)
    expect(stopped.status).toMatchObject({ ready: false, interrupted: true })

    // A restart in between: the record and the Keychain carry it.
    const later = world({ secrets: w.secrets, settingsPath: w.settingsPath, fake: w.fake })
    expect((await later.setup.status()).interrupted).toBe(true)
    const resumed = await later.setup.setUp()
    expect(resumed.ok).toBe(true)
    expect(resumed.status.ready).toBe(true)
    expect(w.fake.requests.filter((entry) => entry.method === 'PUT')).toHaveLength(1)
    // The same key as the stopped run made, kept before anything was written.
    expect(readKeyBlob(w.secrets.store.read('sharing-keys'))).toHaveLength(1)
  })

  test('a second Mac joins an account that already has the service: only its own key is added', async () => {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: newScript(1, { ADMIN_SECRET_studiomac: 'the-other-macs-key-abcdef' }) } },
      uploadBuild: 1,
    })
    const w = world({ fake })
    await w.setup.checkToken(TOKEN)
    const joined = await w.setup.setUp()
    expect(joined).toMatchObject({ ok: true, notice: JOINED_NOTICE, status: { ready: true } })
    expect(w.fake.requests.some((entry) => entry.method === 'PUT')).toBe(false)
    const own = readKeyBlob(w.secrets.store.read('sharing-keys'))[0]
    expect(fake.accounts.acc1.script!.secrets).toEqual({ ADMIN_SECRET_studiomac: 'the-other-macs-key-abcdef', [`ADMIN_SECRET_${own.computerId}`]: own.key })
    expect(w.fake.wire()).not.toContain('the-other-macs-key-abcdef')
  })

  test('a service from an older WriteFlex: status offers Update, Update uploads over it and keeps every key', async () => {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: newScript(1, { ADMIN_SECRET_studiomac: 'the-other-macs-key-abcdef' }) } },
      uploadBuild: 2,
    })
    const first = world({ fake, build: 1 })
    await first.setup.checkToken(TOKEN)
    await first.setup.setUp()
    // This Mac now runs a WriteFlex that carries build 2.
    const newer = world({ fake, build: 2, secrets: first.secrets, settingsPath: first.settingsPath })
    const status = await newer.setup.status({ askService: true })
    expect(status.service).toEqual({ installedBuild: 1, appBuild: 2, compare: 'update' })
    fake.accounts.acc1.script!.staleReads = 2
    const updated = await newer.setup.setUp()
    expect(updated).toMatchObject({ ok: true, notice: UPDATED_NOTICE })
    const upload = fake.requests.filter((entry) => entry.method === 'PUT')
    expect(upload).toHaveLength(1)
    expect(upload[0].body).not.toContain('"migrations"')
    expect(Object.keys(fake.accounts.acc1.script!.secrets)).toContain('ADMIN_SECRET_studiomac')
    // Success came from Cloudflare's deployments; the service's own answer catches up after.
    for (let read = 0; read < 2; read += 1) await newer.setup.status({ askService: true })
    expect((await newer.setup.status({ askService: true })).service).toEqual({ installedBuild: 2, appBuild: 2, compare: 'current' })
  })

  test('ticket 08 review round 2: a build-6 service (replies not answered one by one) is offered the update to this WriteFlex\'s build', async () => {
    expect(SHARING_SERVICE_BUILD).toBeGreaterThanOrEqual(7)
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: newScript(6) } },
      uploadBuild: SHARING_SERVICE_BUILD,
    })
    const first = world({ fake, build: 6 })
    await first.setup.checkToken(TOKEN)
    await first.setup.setUp()
    // This Mac now runs this WriteFlex, which carries SHARING_SERVICE_BUILD.
    const now = world({ fake, build: SHARING_SERVICE_BUILD, secrets: first.secrets, settingsPath: first.settingsPath })
    expect((await now.setup.status({ askService: true })).service).toEqual({ installedBuild: 6, appBuild: SHARING_SERVICE_BUILD, compare: 'update' })
    expect(await now.setup.setUp()).toMatchObject({ ok: true, notice: UPDATED_NOTICE })
    expect(fake.requests.filter((entry) => entry.method === 'PUT')).toHaveLength(1)
    expect(fake.accounts.acc1.script!.build).toBe(SHARING_SERVICE_BUILD)
  })

  test('ticket 12 and the Inline word: a build-7 service is offered the update to build 10, which says Comments and Inline', async () => {
    expect(SHARING_SERVICE_BUILD).toBe(10)
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: newScript(7) } },
      uploadBuild: SHARING_SERVICE_BUILD,
    })
    const first = world({ fake, build: 7 })
    await first.setup.checkToken(TOKEN)
    await first.setup.setUp()
    const now = world({ fake, build: SHARING_SERVICE_BUILD, secrets: first.secrets, settingsPath: first.settingsPath })
    expect((await now.setup.status({ askService: true })).service).toEqual({ installedBuild: 7, appBuild: 10, compare: 'update' })
    expect(await now.setup.setUp()).toMatchObject({ ok: true, notice: UPDATED_NOTICE })
    expect(fake.accounts.acc1.script!.build).toBe(10)
  })

  test('a service from a newer WriteFlex: nothing is sent over it', async () => {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: newScript(3) } },
      uploadBuild: 2,
    })
    const w = world({ fake, build: 2 })
    await w.setup.checkToken(TOKEN)
    expect(problemOf(await w.setup.setUp())).toEqual(APP_OLDER)
    expect(fake.requests.filter((entry) => entry.method !== 'GET')).toEqual([])
  })

  test('an incomplete installation sends nothing at all', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    const sent = w.fake.requests.length
    w.ports.shipped = () => ({ ...shipped(), bundle: new Uint8Array([1, 2, 3]) })
    const result = await createSharingSetup(w.ports).setUp()
    expect(problemOf(result)).toEqual(INSTALLATION_PROBLEM)
    expect(w.fake.requests.length).toBe(sent)
  })
})

describe('remove sharing', () => {
  test('deletes the service and everything in it from the account, and this Mac forgets it', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    const removed = await removeNow(w)
    expect(removed.ok).toBe(true)
    const deletion = w.fake.requests.find((entry) => entry.method === 'DELETE')!
    expect(new URL(deletion.url).pathname + new URL(deletion.url).search).toBe('/client/v4/accounts/acc1/workers/scripts/writeflex-sharing?force=true')
    expect(w.fake.accounts.acc1.script).toBeNull()
    expect(removed.status).toMatchObject({ ready: false, token: { stored: false } })
    expect(w.secrets.store.has('sharing-keys')).toBe(false)
    expect(w.settings.sharingRecord()).toBeNull()
    expectTokenNowhere(w, [removed])
  })

  test('a refused removal changes nothing on this Mac', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    w.fake.failOnce('DELETE', /writeflex-sharing$/, 500)
    const result = await removeNow(w)
    expect(result.ok).toBe(false)
    expect(result.status.ready).toBe(true)
    expect(w.fake.accounts.acc1.script).not.toBeNull()
  })
})

describe('remove: only the service this Mac set up', () => {
  test('a service another Mac reinstalled after a remove: not deleted without Remove anyway', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    // Another Mac removed sharing and set it up again: a new service, without this Mac's key.
    w.fake.accounts.acc1.script = newScript(1, { ADMIN_SECRET_studiomac: 'the-other-macs-key-abcdef' })
    const refused = await removeNow(w)
    expect(refused).toMatchObject({ ok: false, problem: SERVICE_CHANGED, removeAnyway: true, status: { ready: true } })
    expect(deletes(w)).toEqual([])
    expect(w.fake.accounts.acc1.script).not.toBeNull()
    // The explicit choice.
    const anyway = await removeAnyway(w, refused)
    expect(anyway.ok).toBe(true)
    expect(w.fake.accounts.acc1.script).toBeNull()
    expectTokenNowhere(w, [refused, anyway])
  })

  test('a service updated to another build since: not deleted without Remove anyway', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    w.fake.accounts.acc1.script!.build = 2 // a newer WriteFlex on another Mac updated it; this Mac's key is still there
    const refused = await removeNow(w)
    expect(refused).toMatchObject({ ok: false, problem: SERVICE_CHANGED, removeAnyway: true })
    expect(refused.ok === false && refused.details).toContain('build 2')
    expect(deletes(w)).toEqual([])
  })

  test('a Worker of that name that is not WriteFlex\'s is never deleted, not even with Remove anyway', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    w.fake.accounts.acc1.script!.foreign = true
    expect(problemOf(await removeNow(w))).toEqual(NOT_OURS)
    expect(deletes(w)).toEqual([])
  })
})

describe('an interrupted set-up stays on its account', () => {
  test('after it wrote on one account, another account cannot be chosen; before it wrote, it can', async () => {
    const w = world({ fake: twoAccounts() })
    await w.setup.checkToken(TOKEN)
    await w.setup.chooseAccount('acc1')
    w.fake.failOnce('POST', /\/subdomain$/, 'network') // after the upload to acc1
    expect(problemOf(await w.setup.setUp())).toEqual(OFFLINE)
    expect(w.fake.accounts.acc1.script).not.toBeNull()
    const moved = await w.setup.chooseAccount('acc2')
    expect(problemOf(moved)).toEqual(accountLocked('Personal'))
    expect(moved.status).toMatchObject({ account: { id: 'acc1' }, interrupted: true, accountLocked: true })
    // Finishing on acc1 is what is offered, and it works.
    expect((await w.setup.setUp()).ok).toBe(true)

    const v = world({ fake: twoAccounts() })
    await v.setup.checkToken(TOKEN)
    await v.setup.chooseAccount('acc1')
    v.fake.failOnce('GET', /\/services\/writeflex-sharing$/, 'network') // before anything was written
    expect(problemOf(await v.setup.setUp())).toEqual(OFFLINE)
    expect((await v.setup.status()).accountLocked).toBe(false)
    const switched = await v.setup.chooseAccount('acc2')
    expect(switched).toMatchObject({ ok: true, status: { account: { id: 'acc2' } } })
  })
})

describe('a removal that stops part-way on this Mac', () => {
  test('keeps a pending record, never shows "not set up" with the token still kept, and Retry finishes it', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    const store = w.secrets.store
    const clear = store.clear.bind(store)
    let refuse = true
    store.clear = (slot) => { if (slot === 'cloudflare-token' && refuse) throw new Error('keychain locked'); clear(slot) }
    const stopped = await removeNow(w)
    expect(stopped.ok).toBe(false)
    expect(w.fake.accounts.acc1.script).toBeNull()
    expect(store.has('cloudflare-token')).toBe(true)
    expect(stopped.status).toMatchObject({ ready: false, removalPending: true, interrupted: false })
    expect(w.settings.sharingRecord()?.stage).toBe('removing')
    // Nothing else starts over a removal that has not finished.
    expect(problemOf(await w.setup.setUp())).toEqual(REMOVAL_PENDING)
    expect(problemOf(await w.setup.checkToken(TOKEN))).toEqual(REMOVAL_PENDING)
    // A restart in between: the record carries it.
    const later = world({ secrets: w.secrets, settingsPath: w.settingsPath, fake: w.fake })
    expect((await later.setup.status()).removalPending).toBe(true)
    refuse = false
    const retried = await removeNow(later)
    expect(retried.ok).toBe(true)
    expect(deletes(w)).toHaveLength(1)
    expect(store.has('cloudflare-token')).toBe(false)
    expect(store.has('sharing-keys')).toBe(false)
    expect(later.settings.sharingRecord()).toBeNull()
    expect(retried.status).toMatchObject({ ready: false, removalPending: false, token: { stored: false } })
    expectTokenNowhere(w, [stopped, retried])
  })
})

describe('a removal stopped before the deletion, then the saved token loses its permission', () => {
  test('Retry says which permission; Settings still offers Replace token; a new token and Retry finish it', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    await w.setup.setUp()
    // The deletion gets no answer: the record stays `removing`, the service not known gone.
    w.fake.failOnce('DELETE', /writeflex-sharing$/, 'network')
    const stopped = await removeNow(w)
    expect(problemOf(stopped)).toEqual(OFFLINE)
    expect(w.fake.accounts.acc1.script).not.toBeNull()
    expect(stopped.status.removalPending).toBe(true)

    // The saved token is still active but no longer reaches Workers.
    w.fake.tokens[TOKEN].workers = 'none'
    const denied = await removeNow(w)
    expect(problemOf(denied)).toEqual(NO_WORKERS_ACCOUNT)
    expect(denied.status).toMatchObject({ removalPending: true, token: { stored: true, problem: null } })
    expect(w.fake.accounts.acc1.script).not.toBeNull()

    // Settings drawn from that status: Replace token is there, above Retry.
    const html = renderToStaticMarkup(createElement(SharingSettingsPanel, { onFlash: () => {}, onOpenSetup: () => {}, initialStatus: denied.status }))
    const words = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
    expect(html).toContain('data-panel="removal-pending"')
    expect(words).toContain('Replace token')
    expect(words.indexOf('Replace token')).toBeLessThan(words.lastIndexOf('Retry'))

    // A newly issued working token, then Retry.
    w.fake.tokens[OTHER_TOKEN] = { status: 'active', accounts: ['acc1'], workers: 'edit' }
    const replaced = await w.setup.checkToken(OTHER_TOKEN)
    expect(replaced.ok).toBe(true)
    expect(replaced.status.removalPending).toBe(true)
    const retried = await removeNow(w)
    expect(retried.ok).toBe(true)
    expect(w.fake.accounts.acc1.script).toBeNull()
    expect(retried.status).toMatchObject({ removalPending: false, token: { stored: false } })
    expect(w.settings.sharingRecord()).toBeNull()
    expectTokenNowhere(w, [stopped, denied, replaced, retried])
    expectTokenNowhere(w, [stopped, denied, replaced, retried], OTHER_TOKEN)
  })
})

describe('another Mac\'s upload landing over this one', () => {
  /** Set up on build 1, then this Mac carries `build` and presses Update while another Mac uploads `theirs`. */
  async function race(build: number, theirs: number) {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: null } },
      uploadBuild: 1,
    })
    const first = world({ fake, build: 1 })
    await first.setup.checkToken(TOKEN)
    await first.setup.setUp()
    fake.uploadBuild = build
    const fetch = fake.fetch
    const w = world({ fake, build, secrets: first.secrets, settingsPath: first.settingsPath })
    w.ports.fetch = async (input, init) => {
      const answer = await fetch(input, init)
      if (init?.method === 'PUT') uploadFromElsewhere(fake.accounts.acc1.script!, theirs)
      return answer
    }
    return { w, result: await createSharingSetup(w.ports).setUp() }
  }

  test('a newer build answers after this upload: said so, not success', async () => {
    const { w, result } = await race(2, 3)
    expect(result).toMatchObject({ ok: false, problem: OVERWRITTEN_NEWER })
    expect(result.ok === false && result.details).toContain('build 3')
    expect(w.settings.sharingRecord()?.build).toBe(1)
  })

  test('an older build that is not the one this upload went over: said so, not success', async () => {
    const { result } = await race(3, 2)
    expect(result).toMatchObject({ ok: false, problem: OVERWRITTEN_OLDER })
  })
})
