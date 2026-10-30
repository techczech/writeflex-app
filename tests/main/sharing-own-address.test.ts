import { cleanUpScratch } from '../helpers/scratch-dirs'
// Your own address (src/main/sharing-own-address.ts through src/main/sharing-setup.ts; sharing ticket
// 05, spec 4.1, 6.1 rows "No domain attached" to "Domain removed or lapsed", 8 "Own address"), against
// the recorded stand-in for Cloudflare's API (tests/helpers/fake-cloudflare.ts). No real Cloudflare call.
//
// The cases of the matrix row "Own address": attach a domain; links copied afterwards use it; a link
// sent before still opens; a domain not on the account refused with the reason (before any change);
// a token without the permission; the name taken; domain removed. Throughout: the token is in no
// status, result or settings file, and in no request but the Authorization header to Cloudflare.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { readSharingRecord } from '../../src/main/sharing-record.ts'
import { registerSharingIpc } from '../../src/main/sharing-ipc.ts'
import { OWN_ADDRESS_TRUST_MS, linkAddress, linksAddressNow, linksAddressUntil, ownDomain, ownHostname, ownName, refusedOutright } from '../../src/main/sharing-own-address.ts'
import {
  OWN_DOMAIN_SHAPE, OWN_LACKS_DNS, OWN_LACKS_ROUTES, OWN_NAME_SHAPE, OWN_NAME_TAKEN, OWN_NO_DOMAINS, OWN_NOT_ACTIVE, OWN_NOT_ON_ACCOUNT, OWN_OTHER_ACCOUNT,
  OWN_NO_ANSWER, OWN_NOT_REMOVED, OWN_REMOVED_NOTICE, ownAttachedNotice, ownNotAttachedText, ownWaitingText, type SharingResult,
} from '../../src/shared/sharing-setup.ts'
import { createFakeCloudflare, type FakeCloudflare, type FakeToken, type FakeZone } from '../helpers/fake-cloudflare.ts'
import { TOKEN, apiCalls, buildShipped, expectTokenNowhere, problemOf, removeShipped, world, type World } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import { registerSharingPieceIpc } from '../../src/main/sharing-piece-ipc.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const ACCOUNT = 'Example author · personal account'
const CLOUDFLARE = 'https://writeflex-sharing.example.workers.dev'
const zone = (name: string, extra: Partial<FakeZone> = {}): FakeZone => ({ id: `zone${name.replace(/\W/g, '')}`, name, status: 'active', records: [], ...extra })

/** A stand-in where the token reaches acc1 (and acc2 when asked) with the given Zone permissions. */
function fakeWith(options: { zones?: FakeZone[]; otherZones?: FakeZone[]; permission?: FakeToken['zone'] } = {}): FakeCloudflare {
  return createFakeCloudflare({
    tokens: { [TOKEN]: { status: 'active', accounts: ['acc1', 'acc2'], workers: 'edit', zone: options.permission ?? { routes: true, dns: true } } },
    accounts: {
      acc1: { name: ACCOUNT, subdomain: 'example', script: null, zones: options.zones ?? [zone('writeflex.app'), zone('lukes.example')] },
      acc2: { name: 'Department', subdomain: 'department', script: null, zones: options.otherZones ?? [] },
    },
    uploadBuild: 1,
  })
}

async function ready(fake: FakeCloudflare): Promise<World> {
  const w = world({ fake })
  expect((await w.setup.checkToken(TOKEN)).ok).toBe(true)
  expect((await w.setup.chooseAccount('acc1')).ok).toBe(true)
  expect((await w.setup.setUp()).ok).toBe(true)
  return w
}
/** Requests after `from` that change anything at Cloudflare. */
const writesSince = (w: World, from: number) => w.fake.requests.slice(from).filter((entry) => entry.method !== 'GET')

describe('the name and the domain are checked before any request (O1)', () => {
  test('one label in front; plain lower-case domains; nothing else', () => {
    expect(ownName(' Drafts ')).toBe('drafts')
    expect(ownName('share-1')).toBe('share-1')
    for (const bad of ['', 'drafts.evil', '-x', 'x-', 'a b', '../x', 'x/y', 'x?y', 'x#y', 'é', 'x'.repeat(64), null, 7]) expect(ownName(bad)).toBeNull()
    expect(ownDomain('WriteFlex.App')).toBe('writeflex.app')
    for (const bad of ['writeflex', 'writeflex.app.', 'writeflex.app/x', 'a..b', '127.0.0.1', 'x?y.app', 'x y.app', 'evil.com#', null]) expect(ownDomain(bad)).toBeNull()
    expect(ownHostname('drafts', 'writeflex.app')).toBe('drafts.writeflex.app')
  })

  test('a bad name or domain from the window sends nothing at all', async () => {
    const w = await ready(fakeWith())
    const from = w.fake.requests.length
    for (const [name, domain, problem] of [
      ['drafts.evil', 'writeflex.app', OWN_NAME_SHAPE], ['../x', 'writeflex.app', OWN_NAME_SHAPE], [{ toString: () => 'x' }, 'writeflex.app', OWN_NAME_SHAPE],
      ['drafts', 'writeflex.app/../../accounts', OWN_DOMAIN_SHAPE], ['drafts', 'writeflex.app?name=x', OWN_DOMAIN_SHAPE], ['drafts', '', OWN_DOMAIN_SHAPE],
    ] as const) {
      const result = await w.setup.attachAddress(name, domain)
      expect(problemOf(result)).toEqual(problem)
      expect(result.status.ownAddress).toBeNull()
    }
    expect(w.fake.requests.length).toBe(from)
  })
})

describe('attach a domain', () => {
  test('drafts on writeflex.app: refusals checked, attached, proved, answering; new links read it; workers.dev untouched', async () => {
    const w = await ready(fakeWith())
    const before = await w.setup.status()
    expect(before.ownAddress).toBeNull()
    expect(before.linksAddress).toBe(CLOUDFLARE)

    const domains = await w.setup.domains()
    expect(domains).toEqual({ ok: true, domains: ['lukes.example', 'writeflex.app'] })

    const from = w.fake.requests.length
    const attached = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(attached).toMatchObject({ ok: true, notice: ownAttachedNotice('drafts.writeflex.app') })
    expect(attached.status.ownAddress).toEqual({ hostname: 'drafts.writeflex.app', name: 'drafts', domain: 'writeflex.app', state: 'attached', earlier: [] })
    expect(attached.status.linksAddress).toBe('https://drafts.writeflex.app')
    // The Cloudflare address is still the service's address; requests keep going there.
    expect(attached.status.address).toBe(CLOUDFLARE)
    expect(w.setup.serviceAccess()).toMatchObject({ address: CLOUDFLARE, linkAddress: 'https://drafts.writeflex.app' })

    expect(apiCalls(w).slice(apiCalls(w).length - 6)).toEqual([
      'GET /zones',
      'GET /accounts/acc1/workers/domains',
      'GET /zones/zonewriteflexapp/dns_records',
      'PUT /accounts/acc1/workers/domains',
      // The proof is the ownership confirmation: the list, then the zone on this account, active.
      'GET /accounts/acc1/workers/domains',
      'GET /zones',
    ])
    const put = w.fake.requests.find((entry) => entry.method === 'PUT' && entry.url.endsWith('/workers/domains'))!
    expect(JSON.parse(put.body)).toEqual({ environment: 'production', hostname: 'drafts.writeflex.app', service: 'writeflex-sharing', zone_id: 'zonewriteflexapp' })
    // The one write is the attach: the script, its workers.dev switch and its keys are not touched.
    expect(writesSince(w, from).map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual(['PUT /client/v4/accounts/acc1/workers/domains'])
    expect(w.fake.accounts.acc1.script!.workersDev).toBe(true)
    // The record holds no secret and survives a restart.
    const settings = readFileSync(w.settingsPath, 'utf8')
    expect(readSharingRecord(JSON.parse(settings).sharing)?.ownAddress).toMatchObject({ name: 'drafts', domain: 'writeflex.app', lapsed: false })
    expectTokenNowhere(w, [attached])
    expect(JSON.stringify(domains)).not.toContain(TOKEN)

    // Attaching it again does nothing more.
    const again = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(again.ok).toBe(true)
    expect(writesSince(w, from)).toHaveLength(1)
  })

  test('attaching later does not break a link already sent; links copied afterwards use the own address', async () => {
    const fake = fakeWith()
    const w = await publishWorld({ fake, files: { 'Piece.md': '# A piece\n\nA reading list is a promise.\n' } })
    const made = await w.publisher.make(w.root, 'Piece.md', { name: 'Marta', comments: true })
    expect(made.ok).toBe(true)
    const sent = made.view.links[0].address
    expect(sent).toBe(linkAddress(CLOUDFLARE, made.view.links[0].shareId))

    const attached = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(attached.ok).toBe(true)
    const view = w.publisher.view(w.root, 'Piece.md')
    const link = view.links[0]
    expect(view.address).toBe('https://drafts.writeflex.app')
    expect(view.cloudflareAddress).toBe(CLOUDFLARE)
    expect(view.ownAddress?.state).toBe('attached')
    // Copy link now gives the own address; the same link on the Cloudflare address is kept beside it.
    expect(link.address).toBe(`https://drafts.writeflex.app/s/${link.shareId}`)
    expect(link.cloudflareAddress).toBe(sent)

    // A reader with the link sent before still gets the page, and so does one with the new address.
    for (const address of [sent, link.address]) {
      const response = await fake.serviceFetch(address)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('A reading list is a promise.')
    }
    // A new link reads the own address from the start.
    const another = await w.publisher.make(w.root, 'Piece.md', { name: null, comments: false })
    expect(another.ok && another.view.links.find((entry) => entry.shareId === another.shareId)!.address).toStartWith('https://drafts.writeflex.app/s/')
  })

  test('Cloudflare still preparing the address: attached, links keep the Cloudflare address until it answers', async () => {
    const fake = fakeWith()
    fake.newDomainsAnswer = false
    const w = await ready(fake)
    const attached = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(attached).toMatchObject({ ok: true, notice: ownWaitingText('drafts.writeflex.app') })
    expect(attached.status.ownAddress?.state).toBe('waiting')
    expect(attached.status.linksAddress).toBe(CLOUDFLARE)
    expect(w.setup.serviceAccess()?.linkAddress).toBe(CLOUDFLARE)

    // Still not answering: still waiting, never flagged (no link has used it).
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('waiting')
    fake.accounts.acc1.domains![0].answering = true
    const now = await w.setup.status({ askService: true })
    expect(now.ownAddress?.state).toBe('attached')
    expect(now.linksAddress).toBe('https://drafts.writeflex.app')
  })
})

describe('refusals, in plain words, before any change (O2)', () => {
  test('a domain on another account is refused with the reason before any change is made', async () => {
    const w = await ready(fakeWith({ zones: [], otherZones: [zone('writeflex.app')] }))
    const from = w.fake.requests.length
    const result = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(result)).toEqual(OWN_OTHER_ACCOUNT('writeflex.app', ACCOUNT))
    expect(problemOf(result)!.reason).toBe('writeflex.app cannot be attached.')
    expect(problemOf(result)!.fix).toContain('It is on another Cloudflare account, not on Example author · personal account.')
    expect(writesSince(w, from)).toEqual([])
    expect(result.status.ownAddress).toBeNull()
    // Sharing carries on with the earlier address.
    expect(result.status.linksAddress).toBe(CLOUDFLARE)
    expect(w.fake.accounts.acc2.domains ?? []).toEqual([])
  })

  test('a domain that is on no account the token reaches; a token that reaches no domain at all', async () => {
    let w = await ready(fakeWith())
    let from = w.fake.requests.length
    expect(problemOf(await w.setup.attachAddress('drafts', 'nobody.example'))).toEqual(OWN_NOT_ON_ACCOUNT('nobody.example', ACCOUNT))
    expect(writesSince(w, from)).toEqual([])

    w = await ready(fakeWith({ permission: { routes: false, dns: false } }))
    from = w.fake.requests.length
    expect(await w.setup.domains()).toEqual({ ok: false, problem: OWN_NO_DOMAINS(ACCOUNT) })
    expect(problemOf(await w.setup.attachAddress('drafts', 'writeflex.app'))).toEqual(OWN_NO_DOMAINS(ACCOUNT))
    expect(writesSince(w, from)).toEqual([])
  })

  test('a domain not active yet', async () => {
    const w = await ready(fakeWith({ zones: [zone('writeflex.app', { status: 'pending' })] }))
    const from = w.fake.requests.length
    expect(problemOf(await w.setup.attachAddress('drafts', 'writeflex.app'))).toEqual(OWN_NOT_ACTIVE('writeflex.app'))
    expect(writesSince(w, from)).toEqual([])
  })

  test('name taken: a DNS record at that name, or another Worker on it; the other Worker is never moved', async () => {
    const fake = fakeWith({ zones: [zone('writeflex.app', { records: ['www.writeflex.app'] })] })
    const w = await ready(fake)
    fake.accounts.acc1.domains = [{ id: 'domother', hostname: 'blog.writeflex.app', service: 'my-blog', zoneId: 'zonewriteflexapp', answering: true }]
    const from = w.fake.requests.length
    expect(problemOf(await w.setup.attachAddress('www', 'writeflex.app'))).toEqual(OWN_NAME_TAKEN('www.writeflex.app', 'writeflex.app'))
    expect(problemOf(await w.setup.attachAddress('blog', 'writeflex.app'))).toEqual(OWN_NAME_TAKEN('blog.writeflex.app', 'writeflex.app'))
    expect(writesSince(w, from)).toEqual([])
    expect(fake.accounts.acc1.domains).toEqual([{ id: 'domother', hostname: 'blog.writeflex.app', service: 'my-blog', zoneId: 'zonewriteflexapp', answering: true }])
    // Taken between the check and the attach: Cloudflare's own refusal reads the same, and nothing is kept.
    fake.afterOnce('GET', /\/dns_records$/, () => { fake.accounts.acc1.zones![0].records.push('drafts.writeflex.app') })
    const raced = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(raced)).toEqual(OWN_NAME_TAKEN('drafts.writeflex.app', 'writeflex.app'))
    expect(raced.status.ownAddress).toBeNull()
  })

  test('the token lacks the permission: DNS, or Workers Routes; sharing carries on with the earlier address', async () => {
    let w = await ready(fakeWith({ permission: { routes: true, dns: false } }))
    let from = w.fake.requests.length
    const noDns = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(noDns)).toEqual(OWN_LACKS_DNS('writeflex.app'))
    expect(problemOf(noDns)!.fix).toBe('Your token cannot change DNS for this domain; it lacks “Zone · DNS · Edit”. Replace the token with one that has it, or carry on with the address Cloudflare gives your account and add your own address later in Settings.')
    expect(writesSince(w, from)).toEqual([])
    expect(noDns.status.linksAddress).toBe(CLOUDFLARE)

    w = await ready(fakeWith({ permission: { routes: false, dns: true } }))
    from = w.fake.requests.length
    const noRoutes = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(noRoutes)).toEqual(OWN_LACKS_ROUTES('writeflex.app'))
    // Cloudflare refused the one write: the record is as it was.
    expect(noRoutes.status.ownAddress).toBeNull()
    expect(readSharingRecord(JSON.parse(readFileSync(w.settingsPath, 'utf8')).sharing)?.ownAddress).toBeNull()
    expectTokenNowhere(w, [noDns, noRoutes])
  })

  test('no answer to the attach: the pending record stays not attached (never "waiting"), and Try again sends the attach again', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    fake.failOnce('PUT', /\/workers\/domains$/, 'network')
    const lost = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(lost.ok).toBe(false)
    expect(problemOf(lost)).toEqual(OWN_NO_ANSWER('drafts.writeflex.app'))
    expect(lost.status.ownAddress?.state).toBe('not-attached')
    expect(lost.status.linksAddress).toBe(CLOUDFLARE)
    // Check again (a status read) does not make it look attached: Cloudflare does not list it.
    const checked = await w.setup.status({ askService: true })
    expect(checked.ownAddress?.state).toBe('not-attached')
    // Try again (the Settings card sends the record's name and domain) re-sends the attach.
    const from = w.fake.requests.length
    const again = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(again.ok).toBe(true)
    expect(writesSince(w, from).map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual(['PUT /client/v4/accounts/acc1/workers/domains'])
    expect(again.status.ownAddress?.state).toBe('attached')
    expect(again.status.linksAddress).toBe('https://drafts.writeflex.app')
  })

  test('Try again when the first attach had landed: attached, no "name taken", nothing sent twice', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    fake.failOnce('PUT', /\/workers\/domains$/, 504)
    const lost = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(lost)).toEqual(OWN_NO_ANSWER('drafts.writeflex.app'))
    expect(lost.details).toContain('Attaching the address')
    expect(lost.status.ownAddress?.state).toBe('not-attached')
    // It did happen at Cloudflare: the Custom Domain is there for the sharing service, with its DNS record.
    fake.accounts.acc1.domains = [{ id: 'domlanded', hostname: 'drafts.writeflex.app', service: 'writeflex-sharing', zoneId: 'zonewriteflexapp', answering: true }]
    fake.accounts.acc1.zones![0].records = ['drafts.writeflex.app']
    const from = w.fake.requests.length
    const again = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(again).toMatchObject({ ok: true, notice: ownAttachedNotice('drafts.writeflex.app') })
    expect(again.status.ownAddress?.state).toBe('attached')
    expect(writesSince(w, from)).toEqual([])
  })

  test('a recheck that finds the landed attach moves it on from not attached', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    fake.failOnce('PUT', /\/workers\/domains$/, 'network')
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).status.ownAddress?.state).toBe('not-attached')
    // Listed for the sharing service, not answering yet: attached, still preparing.
    fake.accounts.acc1.domains = [{ id: 'domlanded', hostname: 'drafts.writeflex.app', service: 'writeflex-sharing', zoneId: 'zonewriteflexapp', answering: false }]
    const waiting = await w.setup.status({ askService: true })
    expect(waiting.ownAddress?.state).toBe('waiting')
    expect(waiting.linksAddress).toBe(CLOUDFLARE)
    fake.accounts.acc1.domains[0].answering = true
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('attached')
  })

  test('a refusal keeps its own reason; no clear answer says Cloudflare did not answer in time', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    fake.failOnce('PUT', /\/workers\/domains$/, 403)
    const refused = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(refused)).toEqual(OWN_LACKS_ROUTES('writeflex.app'))
    expect(refused.status.ownAddress).toBeNull()
    fake.failOnce('PUT', /\/workers\/domains$/, 'network')
    const unclear = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(unclear)!.reason).toBe('Cloudflare did not answer in time when WriteFlex asked it to attach drafts.writeflex.app, so it may or may not have been attached.')
    expect(problemOf(unclear)!.fix).toBe('Press Try again: WriteFlex checks with Cloudflare and finishes attaching it. New links use the address Cloudflare gives your account until then.')
    expect(problemOf(unclear)!.reason).not.toBe(problemOf(refused)!.reason)
    expect(ownNotAttachedText('drafts.writeflex.app')).not.toContain('is attached')
    expect(ownNotAttachedText('drafts.writeflex.app')).toContain('Press Try again to check')
    expect(ownNotAttachedText('drafts.writeflex.app', 'settings')).toContain('Press Try again in Settings › Sharing to check')
    expect(ownWaitingText('drafts.writeflex.app')).toContain('is attached')
  })

  test('not attached: new and copied links stay on workers.dev', async () => {
    const fake = fakeWith()
    const w = await publishWorld({ fake, files: { 'Piece.md': '# A piece\n\nText.\n' } })
    fake.failOnce('PUT', /\/workers\/domains$/, 'network')
    const lost = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(lost.status.ownAddress?.state).toBe('not-attached')
    expect(lost.status.linksAddress).toBe(CLOUDFLARE)
    expect(w.setup.serviceAccess()).toMatchObject({ address: CLOUDFLARE, linkAddress: CLOUDFLARE, linkAddressUntil: null, ownAddress: { state: 'not-attached' } })
    const made = await w.publisher.make(w.root, 'Piece.md', { name: 'Marta', comments: true })
    expect(made.ok).toBe(true)
    expect(made.view.links[0].address).toBe(linkAddress(CLOUDFLARE, made.view.links[0].shareId))
    expect(w.publisher.view(w.root, 'Piece.md').address).toBe(CLOUDFLARE)
  })

  test('not set up: nothing to attach to', async () => {
    const w = world({ fake: fakeWith() })
    expect((await w.setup.checkToken(TOKEN)).ok).toBe(true)
    const result = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(problemOf(result)?.reason).toBe('Sharing is not set up on this Mac.')
  })
})

describe('domain removed or lapsed (O5)', () => {
  test('the own address stops answering while the Cloudflare address answers: flagged, links go back to the Cloudflare address', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    // Removed in Cloudflare.
    fake.accounts.acc1.domains = []
    const flagged = await w.setup.status({ askService: true })
    expect(flagged.ownAddress?.state).toBe('lapsed')
    expect(flagged.linksAddress).toBe(CLOUDFLARE)
    expect(w.setup.serviceAccess()).toMatchObject({ linkAddress: CLOUDFLARE, ownAddress: { state: 'lapsed', hostname: 'drafts.writeflex.app' } })
    // A status read without asking the service shows the same, from the record.
    expect((await w.setup.status()).ownAddress?.state).toBe('lapsed')
  })

  test('both addresses silent (this Mac offline): nothing is flagged', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.accounts.acc1.domains![0].answering = false
    fake.accounts.acc1.script!.versionAnswer = 'network'
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('attached')
  })

  test('a lapsed address that answers again is used again', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.accounts.acc1.domains![0].answering = false
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('lapsed')
    fake.accounts.acc1.domains![0].answering = true
    expect((await w.setup.status({ askService: true })).linksAddress).toBe('https://drafts.writeflex.app')
  })
})

describe('change and remove (O6)', () => {
  test('a new name: the earlier own address stays attached; Remove own address takes off both, and only ours', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    const changed = await w.setup.attachAddress('share', 'lukes.example')
    expect(changed.ok).toBe(true)
    expect(changed.status.ownAddress).toMatchObject({ hostname: 'share.lukes.example', state: 'attached', earlier: ['drafts.writeflex.app'] })
    expect(fake.accounts.acc1.domains!.map((entry) => entry.hostname)).toEqual(['drafts.writeflex.app', 'share.lukes.example'])
    const ours = fake.accounts.acc1.domains!.map((entry) => entry.id)
    fake.accounts.acc1.domains!.push({ id: 'domother', hostname: 'blog.writeflex.app', service: 'my-blog', zoneId: 'zonewriteflexapp', answering: true })

    const removed = await w.setup.removeAddress()
    expect(removed).toMatchObject({ ok: true, notice: OWN_REMOVED_NOTICE })
    expect(removed.status.ownAddress).toBeNull()
    expect(removed.status.linksAddress).toBe(CLOUDFLARE)
    expect(fake.accounts.acc1.domains).toEqual([{ id: 'domother', hostname: 'blog.writeflex.app', service: 'my-blog', zoneId: 'zonewriteflexapp', answering: true }])
    expect(w.fake.requests.filter((entry) => entry.method === 'DELETE').map((entry) => new URL(entry.url).pathname))
      .toEqual([...ours].reverse().map((id) => `/client/v4/accounts/acc1/workers/domains/${id}`))
    expect(w.fake.accounts.acc1.script!.workersDev).toBe(true)
  })

  test('removing a lapsed address that Cloudflare no longer lists deletes nothing and clears it', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.accounts.acc1.domains = []
    await w.setup.status({ askService: true })
    const removed: SharingResult = await w.setup.removeAddress()
    expect(removed.ok).toBe(true)
    expect(removed.status.ownAddress).toBeNull()
    expect(w.fake.requests.filter((entry) => entry.method === 'DELETE')).toEqual([])
  })
})

test('linksAddressNow: the own address only while it answers and Cloudflare confirmed it less than a day ago', () => {
  const at = Date.UTC(2026, 9, 15, 12)
  const own = { name: 'drafts', domain: 'writeflex.app', zoneId: 'z', attachedAt: 1, answeredAt: 2, lapsed: false, ownershipConfirmedAt: new Date(at).toISOString(), earlier: [] }
  const links = (ownAddress: typeof own | null, now = at + 1000, address: string | null = CLOUDFLARE) => linksAddressNow({ address, ownAddress }, now)
  expect(links(null)).toBe(CLOUDFLARE)
  expect(links(own)).toBe('https://drafts.writeflex.app')
  expect(links(own, at + OWN_ADDRESS_TRUST_MS - 1)).toBe('https://drafts.writeflex.app')
  expect(links(own, at + OWN_ADDRESS_TRUST_MS)).toBe(CLOUDFLARE)
  expect(links(own, at - 1000)).toBe(CLOUDFLARE)
  expect(links({ ...own, ownershipConfirmedAt: null })).toBe(CLOUDFLARE)
  expect(links({ ...own, answeredAt: null })).toBe(CLOUDFLARE)
  expect(links({ ...own, attachedAt: null })).toBe(CLOUDFLARE)
  expect(links({ ...own, lapsed: true })).toBe(CLOUDFLARE)
  expect(links(own, at, null)).toBeNull()
  expect(linkAddress('https://drafts.writeflex.app', 'abcdefgh12')).toBe('https://drafts.writeflex.app/s/abcdefgh12')
})

test('the record reads back only a well-formed own address', () => {
  const base = { stage: 'ready', account: { id: 'acc1', name: 'A' }, address: CLOUDFLARE, build: 1 }
  expect(readSharingRecord({ ...base, ownAddress: { name: 'drafts', domain: 'writeflex.app', zoneId: 'z1', attachedAt: 5, answeredAt: null, lapsed: false, earlier: ['old.writeflex.app', 'not a host'] } })?.ownAddress)
    .toEqual({ name: 'drafts', domain: 'writeflex.app', zoneId: 'z1', attachedAt: 5, answeredAt: null, lapsed: false, ownershipConfirmedAt: null, earlier: ['old.writeflex.app'] })
  const own = { name: 'drafts', domain: 'writeflex.app', zoneId: 'z1', attachedAt: 5, answeredAt: 6, lapsed: false, earlier: [] }
  expect(readSharingRecord({ ...base, ownAddress: { ...own, ownershipConfirmedAt: '2026-10-15T12:00:00.000Z' } })?.ownAddress?.ownershipConfirmedAt).toBe('2026-10-15T12:00:00.000Z')
  for (const bad of [1791965520000, 'yesterday', '2026-10-15', '2026-13-45T99:00:00.000Z', null]) {
    expect(readSharingRecord({ ...base, ownAddress: { ...own, ownershipConfirmedAt: bad } })?.ownAddress?.ownershipConfirmedAt).toBeNull()
  }
  for (const bad of [{ name: 'a.b', domain: 'writeflex.app', zoneId: 'z' }, { name: 'drafts', domain: 'evil/..', zoneId: 'z' }, { name: 'drafts', domain: 'writeflex.app', zoneId: '../z' }, 'x']) {
    expect(readSharingRecord({ ...base, ownAddress: bad })?.ownAddress).toBeNull()
  }
})

test('the IPC: only WriteFlex windows; what the window sends goes to the checks as it is; every window is told after', async () => {
  const w = await ready(fakeWith())
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  let changed = 0
  registerSharingIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.setup, { openExternal: () => {}, isAppWindow: (id) => id === 1, changed: () => { changed += 1 } })
  const call = (channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input)
  for (const channel of ['sharing:domains', 'sharing:attach-address', 'sharing:remove-address']) expect(() => call(channel, 2, {})).toThrow('Not a WriteFlex window.')
  const from = w.fake.requests.length
  for (const input of [null, 'drafts.writeflex.app', { name: ['drafts'], domain: 'writeflex.app' }, { name: 'drafts', domain: { toString: () => 'writeflex.app' } }]) {
    const result = await call('sharing:attach-address', 1, input) as SharingResult
    expect(result.ok).toBe(false)
  }
  expect(w.fake.requests.length).toBe(from)
  expect(await call('sharing:domains', 1)).toEqual({ ok: true, domains: ['lukes.example', 'writeflex.app'] })
  const done = await call('sharing:attach-address', 1, { name: 'drafts', domain: 'writeflex.app' }) as SharingResult
  expect(done.ok).toBe(true)
  expect(changed).toBe(5)
  expect(JSON.stringify(done)).not.toContain(TOKEN)
})

// ── Review round 1 (docs/plans/sharing-by-link/reviews/ticket-05-sol-review-round-1.md) ──────────────

const OWN = 'drafts.writeflex.app'
/** Someone else's sharing service at `hostname`, on an account that is not the service's (acc2): its `/version` reads as ours. */
function impersonate(fake: FakeCloudflare, hostname: string): void {
  fake.accounts.acc2.script = { ...fake.accounts.acc1.script!, secrets: {} }
  fake.accounts.acc2.domains = [{ id: 'domattacker', hostname, service: 'writeflex-sharing', zoneId: 'zoneattacker', answering: true }]
}
const toOwn = (w: World) => w.fake.requests.filter((entry) => new URL(entry.url).hostname === OWN)
const recordOf = (w: World) => readSharingRecord(JSON.parse(readFileSync(w.settingsPath, 'utf8')).sharing)!

describe('finding 1: the /version answer is never proof of ownership (O7)', () => {
  test('a lapsed domain answering as the sharing service from elsewhere is not used again', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.accounts.acc1.domains = []
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('lapsed')
    impersonate(fake, OWN)
    const after = await w.setup.status({ askService: true })
    expect(after.ownAddress?.state).toBe('lapsed')
    expect(after.linksAddress).toBe(CLOUDFLARE)
    expect(w.setup.serviceAccess()?.linkAddress).toBe(CLOUDFLARE)
    // Nothing sent to the own address ever carries a credential: only `GET /version`, bare.
    expect(toOwn(w).length).toBeGreaterThan(0)
    for (const entry of toOwn(w)) {
      expect(`${entry.method} ${new URL(entry.url).pathname}`).toBe('GET /version')
      expect(Object.keys(entry.headers).map((name) => name.toLowerCase())).not.toContain('authorization')
    }
    expectTokenNowhere(w, [after])
  })

  test('a pending attachment is not promoted by the answer alone: Cloudflare\'s list must name it', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    fake.failOnce('PUT', /\/workers\/domains$/, 'network')
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(false)
    expect(recordOf(w).ownAddress).toMatchObject({ name: 'drafts', attachedAt: null })
    impersonate(fake, OWN)
    const after = await w.setup.status({ askService: true })
    expect(after.ownAddress?.state).toBe('not-attached')
    expect(after.linksAddress).toBe(CLOUDFLARE)
    expect(recordOf(w).ownAddress).toMatchObject({ attachedAt: null, answeredAt: null })
  })

  test('first answer: links move to the own address only once Cloudflare\'s list, read with the token, confirms it', async () => {
    const fake = fakeWith()
    fake.newDomainsAnswer = false
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).status.ownAddress?.state).toBe('waiting')
    fake.accounts.acc1.domains![0].answering = true
    // The list cannot be read: answering is not enough.
    fake.failOnce('GET', /\/workers\/domains$/, 'network')
    expect((await w.setup.status({ askService: true })).linksAddress).toBe(CLOUDFLARE)
    // No usable token: answering is not enough either.
    const token = w.secrets.store.read('cloudflare-token')!
    w.secrets.store.write('cloudflare-token', 'not-a-token')
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('waiting')
    w.secrets.store.write('cloudflare-token', token)
    // Check again with the token: confirmed, used.
    const checked = await w.setup.status({ askService: true })
    expect(checked.ownAddress?.state).toBe('attached')
    expect(checked.linksAddress).toBe('https://drafts.writeflex.app')
  })

  test('recovery from lapsed needs the domain still an active zone on the account', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.accounts.acc1.domains![0].answering = false
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('lapsed')
    // The registration moved elsewhere: Cloudflare still lists the Custom Domain, the zone is no longer active.
    fake.accounts.acc1.zones![0].status = 'moved'
    fake.accounts.acc1.domains![0].answering = true
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('lapsed')
    fake.accounts.acc1.zones![0].status = 'active'
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('attached')
  })

  test('without a usable token a lapse is still flagged: links only move away', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    w.secrets.store.write('cloudflare-token', 'not-a-token')
    fake.accounts.acc1.domains![0].answering = false
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('lapsed')
  })
})

test('finding 2: a status check that finishes late does not overwrite an address change', async () => {
  const fake = fakeWith()
  fake.newDomainsAnswer = false
  const w = await ready(fake)
  expect((await w.setup.attachAddress('drafts', 'writeflex.app')).status.ownAddress?.state).toBe('waiting')
  fake.accounts.acc1.domains![0].answering = true
  fake.newDomainsAnswer = true
  // Hold the own address's `/version` (the second one the status check asks; the first is workers.dev).
  let release = (): void => {}
  fake.afterOnce('GET', /^\/version$/, () => { release = fake.holdOnce('GET', /^\/version$/) })
  const asked = toOwn(w).length
  const checking = w.setup.status({ askService: true })
  for (let tries = 0; toOwn(w).length === asked && tries < 200; tries += 1) await new Promise((done) => setTimeout(done, 5))
  expect(toOwn(w)).toHaveLength(asked + 1)
  // Another window changes the address while that answer is on its way.
  const changing = w.setup.attachAddress('share', 'lukes.example')
  await new Promise((done) => setTimeout(done, 50))
  release()
  const [, changed] = await Promise.all([checking, changing])
  expect(changed.ok).toBe(true)
  const kept = recordOf(w)
  expect(kept.ownAddress).toMatchObject({ name: 'share', domain: 'lukes.example' })
  expect(kept.ownAddress?.earlier).toEqual(['drafts.writeflex.app'])
  const now = await w.setup.status()
  expect(now.ownAddress).toMatchObject({ hostname: 'share.lukes.example', state: 'attached', earlier: ['drafts.writeflex.app'] })
  expect(now.linksAddress).toBe('https://share.lukes.example')
})

describe('finding 3: only a definitive refusal puts the record back', () => {
  test('a 5xx to the attach keeps it pending; Remove own address finds it', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    fake.failOnce('PUT', /\/workers\/domains$/, 502)
    const lost = await w.setup.attachAddress('drafts', 'writeflex.app')
    expect(lost.ok).toBe(false)
    expect(lost.status.ownAddress).toMatchObject({ hostname: OWN, state: 'not-attached' })
    expect(problemOf(lost)).toEqual(OWN_NO_ANSWER(OWN))
    expect(lost.status.linksAddress).toBe(CLOUDFLARE)
    expect(recordOf(w).ownAddress).toMatchObject({ name: 'drafts', attachedAt: null })
    // It did happen after all: Remove own address takes it off.
    fake.accounts.acc1.domains = [{ id: 'domlate', hostname: OWN, service: 'writeflex-sharing', zoneId: 'zonewriteflexapp', answering: true }]
    const removed = await w.setup.removeAddress()
    expect(removed.ok).toBe(true)
    expect(fake.accounts.acc1.domains).toEqual([])
  })

  test('which answers are a refusal', () => {
    const answer = (kind: 'denied' | 'conflict' | 'refused' | 'unreachable' | 'missing', http: number | null, codes: number[] = []) => ({ kind, http, codes, result: null })
    expect(refusedOutright(answer('denied', 403, [10000]))).toBe(true)
    expect(refusedOutright(answer('conflict', 409, [100116]))).toBe(true)
    expect(refusedOutright(answer('refused', 400, [100117]))).toBe(true)
    expect(refusedOutright(answer('refused', 400, [100100]))).toBe(false)
    expect(refusedOutright(answer('refused', 502, [10000]))).toBe(false)
    expect(refusedOutright(answer('unreachable', 502))).toBe(false)
    expect(refusedOutright(answer('refused', 200))).toBe(false)
    expect(refusedOutright(answer('unreachable', null))).toBe(false)
  })
})

test('finding 4: once the current address is confirmed off, links stop using it; a retry finishes the earlier ones', async () => {
  const fake = fakeWith()
  const w = await ready(fake)
  expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
  expect((await w.setup.attachAddress('share', 'lukes.example')).ok).toBe(true)
  // The current one comes off; reading the earlier one's Custom Domains then fails.
  fake.afterOnce('DELETE', /\/workers\/domains\//, () => fake.failOnce('GET', /\/workers\/domains$/, 500))
  const partial = await w.setup.removeAddress()
  expect(partial.ok).toBe(false)
  expect(fake.accounts.acc1.domains!.map((entry) => entry.hostname)).toEqual([OWN])
  expect(partial.status.ownAddress).toBeNull()
  expect(partial.status.linksAddress).toBe(CLOUDFLARE)
  expect(partial.status.ownAddressesLeft).toEqual([OWN])
  expect(w.setup.serviceAccess()?.linkAddress).toBe(CLOUDFLARE)
  // Kept across a restart.
  expect(recordOf(w)).toMatchObject({ ownAddress: null, ownAddressesLeft: [OWN] })
  // Retry finishes it.
  const finished = await w.setup.removeAddress()
  expect(finished).toMatchObject({ ok: true, notice: OWN_REMOVED_NOTICE })
  expect(finished.status.ownAddressesLeft).toEqual([])
  expect(fake.accounts.acc1.domains).toEqual([])
})

// ── Round 1 follow-up: an address in use is checked against Cloudflare whenever the token is there ──

describe('an own address in use, still answering /version, is moved away when Cloudflare says it is no longer ours', () => {
  test('its zone is no longer active: moved away on the next status check with the token', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).status.ownAddress?.state).toBe('attached')
    fake.accounts.acc1.zones![0].status = 'moved'
    const after = await w.setup.status({ askService: true })
    expect(after.ownAddress?.state).toBe('lapsed')
    expect(after.linksAddress).toBe(CLOUDFLARE)
    expect(w.setup.serviceAccess()?.linkAddress).toBe(CLOUDFLARE)
    expect(recordOf(w).ownAddress?.lapsed).toBe(true)
  })

  test('its Custom Domain is gone from the account\'s list while someone else answers there: moved away', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.accounts.acc1.domains = []
    impersonate(fake, OWN)
    const after = await w.setup.status({ askService: true })
    expect(after.ownAddress?.state).toBe('lapsed')
    expect(after.linksAddress).toBe(CLOUDFLARE)
  })

  test('nothing moves when Cloudflare cannot be read, or without a usable token', async () => {
    const fake = fakeWith()
    const w = await ready(fake)
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    fake.failOnce('GET', /\/workers\/domains$/, 'network')
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('attached')
    fake.failOnce('GET', /^\/client\/v4\/zones$/, 503)
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('attached')
    // Without the token, as before: the service's reads alone, and it still answers.
    w.secrets.store.write('cloudflare-token', 'not-a-token')
    fake.accounts.acc1.zones![0].status = 'moved'
    expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('attached')
  })

  test('the status read without asking the service makes no Cloudflare request', async () => {
    const w = await ready(fakeWith())
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    const from = w.fake.requests.length
    expect((await w.setup.status()).ownAddress?.state).toBe('attached')
    expect(w.fake.requests.length).toBe(from)
  })
})

test('a failed removal says truly whether new links use the address', async () => {
  const fake = fakeWith()
  const w = await ready(fake)
  expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
  expect((await w.setup.attachAddress('share', 'lukes.example')).ok).toBe(true)
  // The current address, in use: new links keep using it.
  fake.failOnce('DELETE', /\/workers\/domains\//, 400)
  const current = await w.setup.removeAddress()
  expect(problemOf(current)).toEqual(OWN_NOT_REMOVED('share.lukes.example', true))
  expect(problemOf(current)!.fix).toBe('Try again. New links keep using it until it is removed.')
  // An earlier address, which new links never used.
  fake.afterOnce('DELETE', /\/workers\/domains\//, () => fake.failOnce('DELETE', /\/workers\/domains\//, 400))
  const earlier = await w.setup.removeAddress()
  expect(problemOf(earlier)).toEqual(OWN_NOT_REMOVED(OWN, false))
  expect(problemOf(earlier)!.fix).toBe('Try again. New links do not use it.')
  expect(earlier.status.ownAddress).toBeNull()
})

// ── Review round 2 (docs/plans/sharing-by-link/reviews/ticket-05-sol-review-round-2.md): one rule ──────
// New and copied links use the own address only while a token-backed ownership confirmation is younger
// than OWN_ADDRESS_TRUST_MS and the address answered as the sharing service (sharing-own-address.ts
// linksAddressNow). A /version answer is never proof; saved state is never authority.

const OWN_ORIGIN = `https://${OWN}`
const toApi = (w: World, from: number) => w.fake.requests.slice(from).filter((entry) => entry.to === 'api')
const toOwnSince = (w: World, from: number) => w.fake.requests.slice(from).filter((entry) => new URL(entry.url).hostname === OWN)

test('finding 1: the second /version answers with forged JSON while Cloudflare says no: links move away', async () => {
  const fake = fakeWith()
  const w = await ready(fake)
  expect((await w.setup.attachAddress('drafts', 'writeflex.app')).status.linksAddress).toBe(OWN_ORIGIN)
  // The domain changes hands: Cloudflare no longer lists it for us; someone else's server answers there.
  fake.accounts.acc1.domains = []
  impersonate(fake, OWN)
  // The first own-address probe times out (the first /version is workers.dev's); the second gets the forged answer.
  fake.afterOnce('GET', /^\/version$/, () => fake.failOnce('GET', /^\/version$/, 'network'))
  const from = w.fake.requests.length
  const after = await w.setup.status({ askService: true })
  expect(toOwnSince(w, from).map((entry) => `${entry.method} ${new URL(entry.url).pathname}`)).toEqual(['GET /version', 'GET /version'])
  // Cloudflare was asked, with the token, after the second probe answered.
  expect(apiCalls(w).slice(-1)).toEqual(['GET /accounts/acc1/workers/domains'])
  expect(after.ownAddress?.state).toBe('lapsed')
  expect(after.linksAddress).toBe(CLOUDFLARE)
  expect(w.setup.serviceAccess()?.linkAddress).toBe(CLOUDFLARE)
  expect(recordOf(w).ownAddress).toMatchObject({ lapsed: true, ownershipConfirmedAt: null })
  expectTokenNowhere(w, [after])
})

test('finding 2: Cloudflare cannot confirm, check after check: after a day links use workers.dev, and Settings says why', async () => {
  const fake = fakeWith()
  const w = await ready(fake)
  expect((await w.setup.attachAddress('drafts', 'writeflex.app')).status.linksAddress).toBe(OWN_ORIGIN)
  const confirmed = recordOf(w).ownAddress!.ownershipConfirmedAt
  expect(confirmed).toBe(new Date(Date.parse(confirmed!)).toISOString())
  // The token loses the domain's Zone permissions: every ownership read is now inconclusive.
  fake.tokens[TOKEN].zone = { routes: false, dns: false }
  for (let check = 0; check < 5; check += 1) {
    const now = await w.setup.status({ askService: true })
    expect(now.ownAddress?.state).toBe('attached')
    expect(now.linksAddress).toBe(OWN_ORIGIN)
  }
  // An inconclusive check never refreshes the confirmation.
  expect(recordOf(w).ownAddress!.ownershipConfirmedAt).toBe(confirmed)
  // Almost a day on: one more inconclusive check, still within the day.
  w.tick(OWN_ADDRESS_TRUST_MS - 120_000)
  expect((await w.setup.status({ askService: true })).linksAddress).toBe(OWN_ORIGIN)
  // Past the day: links use the workers.dev address, though the own address still answers.
  w.tick(120_000)
  const lapsedTrust = await w.setup.status({ askService: true })
  expect(lapsedTrust.linksAddress).toBe(CLOUDFLARE)
  expect(lapsedTrust.ownAddress).toMatchObject({ hostname: OWN, state: 'unconfirmed' })
  expect(w.setup.serviceAccess()).toMatchObject({ linkAddress: CLOUDFLARE, ownAddress: { state: 'unconfirmed' } })
  expect(recordOf(w).ownAddress!.ownershipConfirmedAt).toBe(confirmed)
  // Without a usable token at all: the same.
  const token = w.secrets.store.read('cloudflare-token')!
  w.secrets.store.write('cloudflare-token', 'not-a-token')
  expect((await w.setup.status({ askService: true })).ownAddress?.state).toBe('unconfirmed')
  w.secrets.store.write('cloudflare-token', token)
  // The token can read it again: confirmed, used again.
  fake.tokens[TOKEN].zone = { routes: true, dns: true }
  const again = await w.setup.status({ askService: true })
  expect(again.ownAddress?.state).toBe('attached')
  expect(again.linksAddress).toBe(OWN_ORIGIN)
  expect(Date.parse(recordOf(w).ownAddress!.ownershipConfirmedAt!)).toBeGreaterThan(Date.parse(confirmed!))
})

describe('finding 3: after a restart, nothing is trusted until the timestamp rule says so', () => {
  for (const [label, stamp] of [['missing', null], ['older than a day', 'expired']] as const) {
    test(`a saved own address whose confirmation is ${label}: status, serviceAccess, a new link and a copied link all use workers.dev, with no request`, async () => {
      const fake = fakeWith()
      const w = await publishWorld({ fake, files: { 'Piece.md': '# A piece\n\nA reading list is a promise.\n' } })
      expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
      const made = await w.publisher.make(w.root, 'Piece.md', { name: 'Marta', comments: true })
      expect(made.ok && made.view.links[0].address).toStartWith(`${OWN_ORIGIN}/s/`)
      // Saved as it would be after a quit: the confirmation missing, or a day and more old.
      const kept = recordOf(w)
      const at = stamp === null ? null : new Date(w.clock() - OWN_ADDRESS_TRUST_MS - 60_000).toISOString()
      expect(w.settings.setSharingRecord({ ...kept, ownAddress: { ...kept.ownAddress!, ownershipConfirmedAt: at } })).toBe(true)
      // The domain has since moved and answers as the service elsewhere; nothing here may find that out by asking.
      fake.accounts.acc1.domains = []
      impersonate(fake, OWN)

      const { setup, publisher } = w.restart()
      const from = w.fake.requests.length
      const status = await setup.status()
      expect(status.linksAddress).toBe(CLOUDFLARE)
      expect(status.ownAddress).toMatchObject({ hostname: OWN, state: 'checking' })
      expect(setup.serviceAccess()).toMatchObject({ address: CLOUDFLARE, linkAddress: CLOUDFLARE, ownAddress: { state: 'checking' } })
      const view = publisher.view(w.root, 'Piece.md')
      expect(view.address).toBe(CLOUDFLARE)
      // Copy link copies `address`.
      expect(view.links[0].address).toBe(linkAddress(CLOUDFLARE, view.links[0].shareId))
      expect(w.fake.requests.length).toBe(from)
      // A new link: made at the service on workers.dev, read on workers.dev; nothing to Cloudflare's API or the own address.
      const another = await publisher.make(w.root, 'Piece.md', { name: null, comments: false })
      expect(another.ok).toBe(true)
      if (!another.ok) return
      expect(another.view.links.find((entry) => entry.shareId === another.shareId)!.address).toBe(linkAddress(CLOUDFLARE, another.shareId))
      expect(toApi(w, from)).toEqual([])
      expect(toOwnSince(w, from)).toEqual([])
    })
  }

  test('a saved own address confirmed within the day: used after the restart, with no request', async () => {
    const fake = fakeWith()
    const w = await publishWorld({ fake, files: { 'Piece.md': '# A piece\n\nA reading list is a promise.\n' } })
    expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
    const made = await w.publisher.make(w.root, 'Piece.md', { name: 'Marta', comments: true })
    expect(made.ok).toBe(true)
    w.tick(OWN_ADDRESS_TRUST_MS - 3_600_000)

    const { setup, publisher } = w.restart()
    const from = w.fake.requests.length
    const status = await setup.status()
    expect(status.linksAddress).toBe(OWN_ORIGIN)
    expect(status.ownAddress?.state).toBe('attached')
    expect(setup.serviceAccess()?.linkAddress).toBe(OWN_ORIGIN)
    const view = publisher.view(w.root, 'Piece.md')
    expect(view.links[0].address).toBe(linkAddress(OWN_ORIGIN, view.links[0].shareId))
    expect(w.fake.requests.length).toBe(from)
    // The day runs out on its own, with no check: links go back to workers.dev.
    w.tick(2 * 3_600_000)
    expect((await setup.status()).linksAddress).toBe(CLOUDFLARE)
    expect(publisher.view(w.root, 'Piece.md').links[0].address).toBe(linkAddress(CLOUDFLARE, view.links[0].shareId))
    expect(w.fake.requests.length).toBe(from)
  })
})

// ── Review round 3 (docs/plans/sharing-by-link/reviews, ticket 05 round 3, P2): Copy link on a page left
// open. The window's view may be days old; Copy link asks main, which applies THE RULE at that moment,
// and a view showing the own address says when trust ends so the page can read it again then.

test('round 3: Copy link on a page left open past the day copies workers.dev; the view says when trust ends', async () => {
  const fake = fakeWith()
  const w = await publishWorld({ fake, files: { 'Piece.md': '# A piece\n\nA reading list is a promise.\n' } })
  expect((await w.setup.attachAddress('drafts', 'writeflex.app')).ok).toBe(true)
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1 || id === 2, rootFor: (id) => (id === 1 || id === 2 ? w.root : null), openExternal: () => {},
  })
  const call = (channel: string, input?: unknown, sender = 1) => handlers.get(channel)!({ sender: { id: sender } }, input) as Promise<any>
  await call('sharing:open', 'Piece.md')
  const made = await call('sharing:make', { path: 'Piece.md', name: 'Marta', comments: true })
  expect(made.ok).toBe(true)
  const shareId = made.shareId as string
  // The page's view: the own address, and the instant trust in it ends (the confirmation plus a day).
  const shown = await call('sharing:piece', 'Piece.md')
  const confirmed = Date.parse(recordOf(w).ownAddress!.ownershipConfirmedAt!)
  expect(shown.links[0].address).toBe(`https://drafts.writeflex.app/s/${shareId}`)
  expect(shown.addressUntil).toBe(confirmed + OWN_ADDRESS_TRUST_MS)
  expect(await call('sharing:copy-address', { shareId })).toBe(`https://drafts.writeflex.app/s/${shareId}`)

  // The page stays open; no change notification, no status check, no request. The day runs out.
  const from = w.fake.requests.length
  const notices = w.changes.count
  w.tick(OWN_ADDRESS_TRUST_MS)
  expect(await call('sharing:copy-address', { shareId })).toBe(`${CLOUDFLARE}/s/${shareId}`)
  const after = await call('sharing:piece', 'Piece.md')
  expect(after.links[0].address).toBe(`${CLOUDFLARE}/s/${shareId}`)
  expect(after.addressUntil).toBeNull()
  expect(w.fake.requests.length).toBe(from)
  expect(w.changes.count).toBe(notices)

  // Bound like every link action: only a link of the piece this window has open; never a URL it sends.
  expect(await call('sharing:copy-address', { shareId }, 2)).toBeNull()
  expect(await call('sharing:copy-address', { shareId: 'https://evil.example/s/x' })).toBeNull()
  await call('sharing:close')
  expect(await call('sharing:copy-address', { shareId })).toBeNull()
})

test('round 3: linksAddressUntil is the confirmation plus a day while links use the own address, and null otherwise', () => {
  const at = 1_791_965_520_000
  const own = { name: 'drafts', domain: 'writeflex.app', zoneId: 'z', attachedAt: at, answeredAt: at, lapsed: false, ownershipConfirmedAt: new Date(at).toISOString(), earlier: [] }
  expect(linksAddressUntil({ address: CLOUDFLARE, ownAddress: own }, at + 1000)).toBe(at + OWN_ADDRESS_TRUST_MS)
  expect(linksAddressUntil({ address: CLOUDFLARE, ownAddress: own }, at + OWN_ADDRESS_TRUST_MS)).toBeNull()
  expect(linksAddressUntil({ address: CLOUDFLARE, ownAddress: { ...own, lapsed: true } }, at + 1000)).toBeNull()
  expect(linksAddressUntil({ address: CLOUDFLARE, ownAddress: null }, at + 1000)).toBeNull()
})

// The shared tracker is cached across files; register this file's cleanup explicitly.
afterAll(cleanUpScratch)
