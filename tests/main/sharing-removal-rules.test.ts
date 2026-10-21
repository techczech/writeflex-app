// The rules for Remove sharing and for finishing an install (sharing ticket 02, third round), each
// tested on every path it governs, against the stand-in Cloudflare (fake-cloudflare.ts), driven
// through the IPC as the window drives it (tests/helpers/sharing-world.ts):
//   R1  retry state is durable before anything is destroyed
//   R2  identity has four answers, and only `ours` deletes without asking
//   R3  a confirmation names its target
//   R4  anything this Mac wrote to Cloudflare can be removed from the app
//   R5  install success only on proof
// The paths Remove runs from: set up (`ready`), an interrupted set-up that wrote (`installing`), and a
// removal saved but not finished, in a fresh app instance (`removing`). Then the review's six
// reproductions, by name.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { judgeIdentity, probeService, type Probe } from '../../src/main/sharing-identity.ts'
import { createRemovalConfirmations, decideRemoval, removalTargetOf, targetChanged, type RemovalTarget } from '../../src/main/sharing-removal.ts'
import { judgeDeployment } from '../../src/main/sharing-service-upload.ts'
import { NOT_OURS, createSharingSetup } from '../../src/main/sharing-setup.ts'
import type { SharingRecord } from '../../src/main/sharing-record.ts'
import {
  OVERWRITTEN, OVERWRITTEN_NEWER, OVERWRITTEN_OLDER, REMOVAL_DONE_NOT_SAVED, REMOVAL_NEEDS_TOKEN, NO_TOKEN, REMOVAL_NOT_SAVED, REMOVAL_TARGET_CHANGED, REMOVE_NOT_CONFIRMED, SERVICE_CHANGED, SERVICE_UNCONFIRMED,
  UPDATED_NOTICE, UPLOAD_UNCONFIRMED, KEY_NOT_ADDED, SAVED_TOKEN_REJECTED, type SharingResult, type SharingSetupStatus,
} from '../../src/shared/sharing-setup.ts'
import { SharingSettingsPanel } from '../../src/renderer/src/components/settings/SharingSettingsPanel'
import { SharingSetup } from '../../src/renderer/src/components/sharing/SharingSetup'
import { createFakeCloudflare, newScript, uploadFromElsewhere, type FakeCloudflare } from '../helpers/fake-cloudflare.ts'
import {
  OTHER_TOKEN, TOKEN, buildShipped, deletes, expectTokenNowhere, problemOf, removeAnyway, removeNow, removeShipped, twoAccounts, windows, world, type World,
} from '../helpers/sharing-world.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

type Path = 'ready' | 'installing' | 'removing'
const PATHS: Path[] = ['ready', 'installing', 'removing']

/**
 * A Mac on `path`, as a fresh app instance reads it from its settings file and Keychain.
 * installing: the set-up uploaded, proved the upload and added the key, then could not read the key
 * back (so it is `wrote`, unfinished). removing: a removal was saved and the app stopped before the
 * deletion (as R1 leaves it).
 */
async function onPath(path: Path, fake?: FakeCloudflare): Promise<World> {
  const first = world(fake ? { fake } : {})
  expect((await first.setup.checkToken(TOKEN)).ok).toBe(true)
  if (path === 'installing') first.fake.failOnce('GET', /\/secrets$/, 500)
  const done = await first.setup.setUp()
  if (path === 'installing') expect(problemOf(done)).toEqual(KEY_NOT_ADDED)
  else expect(done.ok).toBe(true)
  if (path === 'removing') expect(first.settings.setSharingRecord({ ...first.settings.sharingRecord()!, stage: 'removing', serviceDeleted: false })).toBe(true)
  const later = world({ fake: first.fake, secrets: first.secrets, settingsPath: first.settingsPath })
  const status = await later.setup.status()
  if (path === 'installing') expect(status).toMatchObject({ interrupted: true, accountLocked: true })
  if (path === 'removing') expect(status.removalPending).toBe(true)
  return later
}
const script = (w: World) => w.fake.accounts.acc1.script
const kept = (w: World) => ({ token: w.secrets.store.has('cloudflare-token'), keys: w.secrets.store.has('sharing-keys'), record: w.settings.sharingRecord() })
const ruleOf = (w: World): SharingRecord => w.settings.sharingRecord()!

// ── R1 ─────────────────────────────────────────────────────────────────────────────────────────
describe('R1: retry state is durable before anything is destroyed', () => {
  for (const path of PATHS) {
    test(`${path}: a save of the removal that fails stops before the deletion; nothing is cleared`, async () => {
      const w = await onPath(path)
      const confirmation = await w.ipc.ask()
      const write = w.ports.record.write
      w.ports.record.write = () => false
      const result = await w.ipc.remove(confirmation)
      w.ports.record.write = write
      expect(problemOf(result)).toEqual(REMOVAL_NOT_SAVED)
      expect(deletes(w)).toEqual([])
      expect(script(w)).not.toBeNull()
      expect(kept(w)).toMatchObject({ token: true, keys: true })
    })

    test(`${path}: a save that reports success but did not land is caught by reading it back`, async () => {
      const w = await onPath(path)
      const confirmation = await w.ipc.ask()
      const before = ruleOf(w)
      w.ports.record.write = () => true // says saved; nothing written
      const result = await w.ipc.remove(confirmation)
      if (before.stage === 'removing') {
        // Already durable as `removing`: the deletion goes on, but `serviceDeleted` did not land, so nothing is cleared.
        expect(problemOf(result)).toEqual(REMOVAL_DONE_NOT_SAVED)
        expect(script(w)).toBeNull()
        expect(kept(w)).toMatchObject({ token: true, keys: true, record: { stage: 'removing', serviceDeleted: false } })
      } else {
        expect(problemOf(result)).toEqual(REMOVAL_NOT_SAVED)
        expect(deletes(w)).toEqual([])
        expect(kept(w)).toMatchObject({ token: true, keys: true })
      }
    })

    test(`${path}: removing is saved before the deletion and before any clean-up; a stop after the deletion is finished by a fresh instance`, async () => {
      const w = await onPath(path)
      const events: string[] = []
      const write = w.ports.record.write
      w.ports.record.write = (record) => { events.push(`save ${record === null ? 'none' : `${record.stage}${record.stage === 'removing' ? ` deleted=${record.serviceDeleted}` : ''}`}`); return write(record) }
      const clear = w.secrets.store.clear.bind(w.secrets.store)
      const write2 = w.secrets.store.write.bind(w.secrets.store)
      w.secrets.store.clear = (slot) => { events.push(`clear ${slot}`); clear(slot) }
      w.secrets.store.write = (slot, value) => { events.push(`write ${slot}`); write2(slot, value) }
      const fetch = w.ports.fetch
      let stopAfterDelete = true
      w.ports.fetch = async (input, init) => {
        const answer = await fetch(input, init)
        if (init?.method === 'DELETE') { events.push('DELETE'); if (stopAfterDelete) throw new Error('the app stopped here') }
        return answer
      }
      const stopped = await w.ipc.remove(await w.ipc.ask())
      expect(stopped.ok).toBe(false)
      expect(script(w)).toBeNull()
      expect(events[0]).toBe('save removing deleted=false')
      expect(events.indexOf('DELETE')).toBeGreaterThan(0)
      expect(events.filter((entry) => entry.startsWith('clear') || entry.startsWith('write'))).toEqual([])
      expect(kept(w)).toMatchObject({ token: true, keys: true, record: { stage: 'removing' } })

      // A fresh app instance: Retry finishes it.
      stopAfterDelete = false
      const later = world({ fake: w.fake, secrets: w.secrets, settingsPath: w.settingsPath })
      expect((await later.setup.status()).removalPending).toBe(true)
      const finished = await removeNow(later)
      expect(finished.ok).toBe(true)
      expect(kept(later)).toEqual({ token: false, keys: false, record: null })
      expect(deletes(w)).toHaveLength(1)
      expectTokenNowhere(later, [stopped, finished])
    })
  }

  for (const path of PATHS) {
    for (const [how, failing] of [
      ['fails', () => false],
      ['reports success but does not land', () => true],
    ] as const) {
      test(`${path}: the save of serviceDeleted after the deletion ${how}: nothing is cleared; Retry finishes with no second DELETE`, async () => {
        const w = await onPath(path)
        const write = w.ports.record.write
        w.ports.record.write = (record) => (record?.stage === 'removing' && record.serviceDeleted ? failing() : write(record))
        const stopped = await removeNow(w)
        w.ports.record.write = write
        expect(problemOf(stopped)).toEqual(REMOVAL_DONE_NOT_SAVED)
        expect(script(w)).toBeNull()
        expect(kept(w)).toMatchObject({ token: true, keys: true, record: { stage: 'removing', serviceDeleted: false } })
        expect(stopped.status.removalPending).toBe(true)
        // Retry: the service is found gone, the removal is saved, then this Mac forgets it.
        const retried = await removeNow(w)
        expect(retried.ok).toBe(true)
        expect(kept(w)).toEqual({ token: false, keys: false, record: null })
        expect(deletes(w)).toHaveLength(1)
      })
    }
  }

  test('a removal that did not finish, with no token on this Mac: says the removal needs one, not "Paste a token first"', async () => {
    const w = await onPath('removing')
    w.secrets.store.clear('cloudflare-token')
    const result = await removeNow(w)
    expect(problemOf(result)).toEqual(REMOVAL_NEEDS_TOKEN)
    expect(problemOf(result)).not.toEqual(NO_TOKEN)
    expect(deletes(w)).toEqual([])
    expect(ruleOf(w)).toMatchObject({ stage: 'removing', serviceDeleted: false })
  })

  test('a removal saved before its deletion can be finished with a new token when the old one has expired', async () => {
    const w = await onPath('removing')
    w.fake.tokens[TOKEN].status = 'expired'
    expect(problemOf(await removeNow(w))).toEqual(SAVED_TOKEN_REJECTED)
    expect(script(w)).not.toBeNull()
    w.fake.tokens[OTHER_TOKEN] = { status: 'active', accounts: ['acc1'], workers: 'edit' }
    expect((await w.setup.checkToken(OTHER_TOKEN)).ok).toBe(true)
    expect(ruleOf(w)).toMatchObject({ stage: 'removing', serviceDeleted: false, account: { id: 'acc1' } })
    expect((await removeNow(w)).ok).toBe(true)
    expect(script(w)).toBeNull()
    expect(kept(w)).toEqual({ token: false, keys: false, record: null })
  })

  test('a refused deletion puts the record back as it was', async () => {
    const w = await onPath('ready')
    const before = ruleOf(w)
    w.fake.failOnce('DELETE', /writeflex-sharing$/, 409)
    const result = await removeNow(w)
    expect(result.ok).toBe(false)
    expect(ruleOf(w)).toEqual(before)
    expect(kept(w)).toMatchObject({ token: true, keys: true })
  })
})

// ── R2 ─────────────────────────────────────────────────────────────────────────────────────────
describe('R2: identity has four answers, and only ours deletes without asking', () => {
  test('the probe: only a clear answer is an answer', async () => {
    const answering = (status: number, body: string): typeof fetch => async () => new Response(body, { status })
    const sharing = await probeService(answering(200, '{"service":"writeflex-sharing","build":3}'), 'https://x/version', 100)
    expect(sharing).toEqual({ kind: 'sharing', build: 3 })
    expect((await probeService(answering(200, '{"service":"someone-else","build":3}'), 'https://x/version', 100)).kind).toBe('foreign')
    expect((await probeService(answering(200, '{"ok":true}'), 'https://x/version', 100)).kind).toBe('foreign')
    const inconclusive: Array<[string, typeof fetch]> = [
      ['500', answering(500, '{"service":"writeflex-sharing","build":1}')],
      ['404', answering(404, 'There is nothing here yet')],
      ['503', answering(503, '')],
      ['network error', async () => { throw new TypeError('fetch failed') }],
      ['timeout', () => new Promise<Response>(() => {})],
      ['invalid JSON', answering(200, '<html>hello</html>')],
      ['JSON that is not an object', answering(200, '[1,2]')],
      ['our name, no build', answering(200, '{"service":"writeflex-sharing"}')],
      ['our name, build 0', answering(200, '{"service":"writeflex-sharing","build":0}')],
    ]
    for (const [name, fetcher] of inconclusive) expect([name, (await probeService(fetcher, 'https://x/version', 20)).kind]).toEqual([name, 'unknown'])
  })

  test('the judgement: ours only with an accountable build, the key held and the key listed', () => {
    const at = (build: number): Probe => ({ kind: 'sharing', build })
    const judge = (probe: Probe, accountable: Array<number | null>, keyHeld: boolean, keyListed: boolean | null) => judgeIdentity({ probe, accountable, keyHeld, keyListed }).kind
    expect(judge(at(1), [1, null], true, true)).toBe('ours')
    expect(judge(at(2), [1, 2], true, true)).toBe('ours') // the build this Mac sent
    expect(judge(at(2), [1, null], true, true)).toBe('replaced')
    expect(judge(at(1), [null, null], true, true)).toBe('replaced')
    expect(judge(at(1), [1, null], false, false)).toBe('replaced')
    expect(judge(at(1), [1, null], true, false)).toBe('replaced')
    expect(judge(at(1), [1, null], true, null)).toBe('unknown')
    expect(judge({ kind: 'unknown', why: '' }, [1, null], true, true)).toBe('unknown')
    expect(judge({ kind: 'foreign' }, [1, null], true, true)).toBe('foreign')
  })

  test('the decision: ours deletes; replaced and unknown ask; foreign never; an answer confirmed deletes only while it holds', () => {
    const plain: RemovalTarget = { operation: 'remove', accountId: 'acc1', accountName: 'A', scriptName: 'writeflex-sharing', recordedBuild: 1, setUpAt: 1, anyway: null }
    const id = (kind: 'ours' | 'replaced' | 'foreign' | 'unknown', build: number | null = 1) => ({ kind, build, why: '' })
    expect(decideRemoval(plain, id('ours'))).toBe('delete')
    expect(decideRemoval(plain, id('replaced', 2))).toBe('ask')
    expect(decideRemoval(plain, id('unknown', null))).toBe('ask')
    expect(decideRemoval(plain, id('foreign', null))).toBe('never')
    const anyway: RemovalTarget = { ...plain, anyway: { kind: 'replaced', build: 2 } }
    expect(decideRemoval(anyway, id('replaced', 2))).toBe('delete')
    expect(decideRemoval(anyway, id('replaced', 3))).toBe('changed')
    expect(decideRemoval(anyway, id('unknown', null))).toBe('changed')
    expect(decideRemoval(anyway, id('ours', 2))).toBe('changed')
    expect(decideRemoval(anyway, id('foreign', null))).toBe('never')
  })

  for (const path of PATHS) {
    test(`${path}: ours is deleted on Remove`, async () => {
      const w = await onPath(path)
      const result = await removeNow(w)
      expect(result.ok).toBe(true)
      expect(script(w)).toBeNull()
      expect(kept(w)).toEqual({ token: false, keys: false, record: null })
    })

    test(`${path}: replaced (another build, or without this Mac's key) is asked about; Remove it anyway deletes`, async () => {
      for (const replace of [(s: NonNullable<FakeCloudflare['accounts'][string]['script']>) => { s.build = 2 }, (s: NonNullable<FakeCloudflare['accounts'][string]['script']>) => { s.secrets = { ADMIN_SECRET_studiomac: 'the-other-macs-key-abcdef' } }]) {
        const w = await onPath(path)
        replace(script(w)!)
        const asked = await removeNow(w)
        expect(asked).toMatchObject({ ok: false, problem: SERVICE_CHANGED, removeAnyway: true })
        expect(deletes(w)).toEqual([])
        expect(kept(w)).toMatchObject({ token: true, keys: true })
        expect((await removeAnyway(w, asked)).ok).toBe(true)
        expect(script(w)).toBeNull()
      }
    })

    test(`${path}: unknown (the service does not answer clearly) is asked about, never taken as ours; Remove it anyway deletes`, async () => {
      for (const answer of [{ status: 500, body: '' }, { status: 200, body: 'not json' }, 'network' as const, 'keys unreadable' as const]) {
        const w = await onPath(path)
        // The service answers clearly; its key list does not, at the question and again at Remove it anyway.
        if (answer === 'keys unreadable') for (let n = 0; n < 2; n += 1) w.fake.failOnce('GET', /\/secrets$/, 400)
        else script(w)!.versionAnswer = answer
        const asked = await removeNow(w)
        expect(asked).toMatchObject({ ok: false, problem: SERVICE_UNCONFIRMED, removeAnyway: true })
        expect(deletes(w)).toEqual([])
        expect((await removeAnyway(w, asked)).ok).toBe(true)
        expect(script(w)).toBeNull()
      }
    })

    test(`${path}: foreign is never deleted, not on Remove and not on a Remove anyway confirmed for something else`, async () => {
      const w = await onPath(path)
      script(w)!.foreign = true
      const result = await removeNow(w)
      expect(problemOf(result)).toEqual(NOT_OURS)
      expect(result.ok === false && result.anywayConfirmation).toBeFalsy()
      script(w)!.foreign = false
      script(w)!.build = 2
      const asked = await removeNow(w)
      script(w)!.foreign = true
      expect(problemOf(await removeAnyway(w, asked))).toEqual(NOT_OURS)
      expect(deletes(w)).toEqual([])
      expect(script(w)).not.toBeNull()
    })
  }
})

// ── R3 ─────────────────────────────────────────────────────────────────────────────────────────
describe('R3: a confirmation names its target', () => {
  test('every field the question names is compared: operation, account, script name, recorded build, set-up time', () => {
    const base: RemovalTarget = { operation: 'remove', accountId: 'acc1', accountName: 'A', scriptName: 'writeflex-sharing', recordedBuild: 1, setUpAt: 10, anyway: null }
    expect(targetChanged(base, { ...base })).toBe(false)
    expect(targetChanged(base, { ...base, accountName: 'Renamed at Cloudflare' })).toBe(false)
    for (const change of [{ operation: 'retry' as const }, { accountId: 'acc2' }, { scriptName: 'writeflex-sharing-2' }, { recordedBuild: 2 }, { recordedBuild: null }, { setUpAt: 11 }]) {
      expect([change, targetChanged(base, { ...base, ...change })]).toEqual([change, true])
    }
    expect(targetChanged(base, null)).toBe(true)
    const record = (stage: SharingRecord['stage']): SharingRecord => ({ stage, tokenAcceptedAt: null, tokenRejected: false, accounts: [], account: { id: 'acc1', name: 'A' }, address: null, build: 1, setUpAt: 10, wrote: true, sentBuild: null, serviceDeleted: false })
    expect(removalTargetOf(record('ready'), 'writeflex-sharing')).toEqual(base)
    expect(removalTargetOf(record('removing'), 'writeflex-sharing')!.operation).toBe('retry')
  })

  test('two slots: a plain confirmation issued after a Remove it anyway one is plain, and cannot delete a replaced service', () => {
    const plain: RemovalTarget = { operation: 'retry', accountId: 'acc1', accountName: 'A', scriptName: 'writeflex-sharing', recordedBuild: 1, setUpAt: 1, anyway: null }
    const replaced = { kind: 'replaced' as const, build: 2, why: '' }
    const confirmations = createRemovalConfirmations({ now: () => 1_000 })
    const anyway = confirmations.issue(1, { ...plain, anyway: { kind: 'replaced', build: 2 } })
    const fresh = confirmations.issue(1, plain)
    const taken = confirmations.take(fresh, 1)
    expect(taken).not.toBeNull()
    expect(taken!.anyway).toBeNull()
    expect(decideRemoval(taken!, replaced)).toBe('ask')
    // Taking one uses up both.
    expect(confirmations.take(anyway, 1)).toBeNull()
    // A fresh plain question leaves a live anyway one alone, and each is single use.
    const anyway2 = confirmations.issue(1, { ...plain, anyway: { kind: 'replaced', build: 2 } })
    confirmations.issue(1, plain)
    const anywayTaken = confirmations.take(anyway2, 1)
    expect(anywayTaken?.anyway).toEqual({ kind: 'replaced', build: 2 })
    expect(decideRemoval(anywayTaken!, replaced)).toBe('delete')
    expect(confirmations.take(anyway2, 1)).toBeNull()
  })

  test('through the IPC: a plain question asked after Remove it anyway was offered cannot delete the replaced service', async () => {
    const w = await onPath('removing')
    script(w)!.build = 2
    const asked = await removeNow(w)
    expect(asked).toMatchObject({ ok: false, problem: SERVICE_CHANGED, removeAnyway: true })
    const plain = await w.ipc.remove(await w.ipc.ask())
    expect(plain).toMatchObject({ ok: false, problem: SERVICE_CHANGED, removeAnyway: true })
    expect(deletes(w)).toEqual([])
    expect(script(w)).not.toBeNull()
  })

  for (const path of PATHS) {
    test(`${path}: the target changing after the question was shown refuses, and nothing is deleted`, async () => {
      const changes: Array<[string, (w: World) => void]> = [
        ['account', (w) => { w.settings.setSharingRecord({ ...ruleOf(w), account: { id: 'acc2', name: 'Department' } }) }],
        ['recorded build', (w) => { w.settings.setSharingRecord({ ...ruleOf(w), build: 7 }) }],
        ['operation', (w) => { w.settings.setSharingRecord({ ...ruleOf(w), stage: ruleOf(w).stage === 'removing' ? 'ready' : 'removing', serviceDeleted: false }) }],
        ['set-up time', (w) => { w.settings.setSharingRecord({ ...ruleOf(w), setUpAt: (ruleOf(w).setUpAt ?? 0) + 1 }) }],
      ]
      for (const [name, change] of changes) {
        const w = await onPath(path)
        const confirmation = await w.ipc.ask()
        change(w)
        const result = await w.ipc.remove(confirmation)
        expect([name, problemOf(result)]).toEqual([name, REMOVAL_TARGET_CHANGED])
        expect(deletes(w)).toEqual([])
        expect(kept(w)).toMatchObject({ token: true, keys: true })
      }
    })

    test(`${path}: Remove it anyway is bound to the answer it showed; another answer by then refuses`, async () => {
      for (const [name, change] of [
        ['another build', (s: NonNullable<FakeCloudflare['accounts'][string]['script']>) => { s.build = 3 }],
        ['no clear answer', (s: NonNullable<FakeCloudflare['accounts'][string]['script']>) => { s.versionAnswer = { status: 502, body: '' } }],
        ['ours again', (s: NonNullable<FakeCloudflare['accounts'][string]['script']>) => { s.build = 1 }],
      ] as const) {
        const w = await onPath(path)
        script(w)!.build = 2
        const asked = await removeNow(w)
        expect(asked).toMatchObject({ removeAnyway: true })
        change(script(w)!)
        expect([name, problemOf(await removeAnyway(w, asked))]).toEqual([name, REMOVAL_TARGET_CHANGED])
        expect(deletes(w)).toEqual([])
      }
    })

    test(`${path}: single use, the window that asked, five minutes`, async () => {
      const w = await onPath(path)
      const confirmation = await w.ipc.ask(1)
      expect(problemOf(await w.ipc.remove(confirmation, 2))).toEqual(REMOVE_NOT_CONFIRMED)
      expect(problemOf(await w.ipc.remove(confirmation, 1))).toEqual(REMOVE_NOT_CONFIRMED)
      let clock = 1_000_000
      const timed = windows(w.setup, () => clock)
      const late = await timed.ask()
      clock += 5 * 60 * 1000
      expect(problemOf(await timed.remove(late))).toEqual(REMOVE_NOT_CONFIRMED)
      expect(deletes(w)).toEqual([])
    })
  }
})

// ── R4 ─────────────────────────────────────────────────────────────────────────────────────────
describe('R4: anything this Mac wrote to Cloudflare can be removed from the app', () => {
  const none = (): void => {}
  const locked: SharingSetupStatus = {
    ready: false, storageUnavailable: false, token: { stored: true, acceptedAt: null, problem: null },
    accounts: [{ id: 'acc1', name: 'Personal', workers: true, address: 'https://writeflex-sharing.personal.workers.dev' }],
    account: { id: 'acc1', name: 'Personal' }, address: null, interrupted: true, accountLocked: true, removalPending: false, service: null, setUpAt: null,
  }
  const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

  test('an interrupted set-up that wrote: Settings › Sharing offers Remove, and so does the set-up page\'s locked-account message, with or without a problem shown', () => {
    const settings = text(renderToStaticMarkup(createElement(SharingSettingsPanel, { onFlash: none, onOpenSetup: none, initialStatus: locked })))
    expect(settings).toContain('Set-up did not finish')
    expect(settings).toContain('Remove sharing from this account Set-up already wrote on Personal.')
    expect(settings.match(/Remove sharing from this account/g)).toHaveLength(2) // the panel's title and its button
    for (const setupFailure of [undefined, { problem: KEY_NOT_ADDED }]) {
      const page = renderToStaticMarkup(createElement(SharingSetup, { pieceName: null, onBack: none, onFlash: none, onOpenSettings: none, initial: { status: locked, ...(setupFailure ? { setupFailure } : {}) } }))
      const message = text(page.split('data-testid="sharing-account-locked">')[1]!.split('</section>')[0]!)
      expect(message).toContain('Remove sharing from this account')
    }
    // Nothing written: nothing to remove there, so no Remove.
    const unwritten = text(renderToStaticMarkup(createElement(SharingSettingsPanel, { onFlash: none, onOpenSetup: none, initialStatus: { ...locked, accountLocked: false } })))
    expect(unwritten).not.toContain('Remove sharing from this account')
  })

  test('the removal from an interrupted set-up deletes what it wrote, under R1 to R3', async () => {
    const w = await onPath('installing')
    expect((await w.ipc.question()).confirmation).toMatch(/^[0-9a-f]{64}$/)
    const result = await removeNow(w)
    expect(result.ok).toBe(true)
    expect(script(w)).toBeNull()
    expect(kept(w)).toEqual({ token: false, keys: false, record: null })
  })

  test('an interrupted set-up that only joined (found the service, added nothing yet but its key): the build it found is accounted for', async () => {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared', subdomain: 'shared', script: newScript(1, { ADMIN_SECRET_studiomac: 'the-other-macs-key-abcdef' }) } },
      uploadBuild: 1,
    })
    const w = await onPath('installing', fake)
    expect(ruleOf(w)).toMatchObject({ stage: 'installing', wrote: true, build: 1, sentBuild: null })
    expect((await removeNow(w)).ok).toBe(true)
  })
})

// ── R5 ─────────────────────────────────────────────────────────────────────────────────────────
describe('R5: install success only on proof', () => {
  test('the judgement, from Cloudflare\'s deployments', () => {
    const live = (...ids: Array<[string, number]>) => ({ versions: ids.map(([id, percentage]) => ({ id, percentage })) })
    const u = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32)
    expect(judgeDeployment({ uploaded: u, before: [b], beforeKnown: true, latest: live([u, 100]) })).toBe('proven')
    expect(judgeDeployment({ uploaded: u, before: [b], beforeKnown: true, latest: live([c, 100]) })).toBe('overwritten')
    expect(judgeDeployment({ uploaded: u, before: [], beforeKnown: true, latest: live([c, 100]) })).toBe('overwritten')
    expect(judgeDeployment({ uploaded: u, before: [b], beforeKnown: true, latest: live([b, 100]) })).toBe('pending')
    expect(judgeDeployment({ uploaded: u, before: [], beforeKnown: false, latest: live([c, 100]) })).toBe('pending')
    expect(judgeDeployment({ uploaded: u, before: [b], beforeKnown: true, latest: live([u, 60], [b, 40]) })).toBe('pending')
    expect(judgeDeployment({ uploaded: null, before: [b], beforeKnown: true, latest: live([c, 100]) })).toBe('pending')
    expect(judgeDeployment({ uploaded: u, before: [b], beforeKnown: true, latest: null })).toBe('pending')
  })

  /** Set up on build 1; this Mac then carries build 2 and presses Update; `between` runs right after its upload. */
  async function update(between?: (fake: FakeCloudflare) => void, tweak?: (w: World) => void) {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: null } },
      uploadBuild: 1,
    })
    const first = world({ fake })
    await first.setup.checkToken(TOKEN)
    expect((await first.setup.setUp()).ok).toBe(true)
    fake.uploadBuild = 2
    const w = world({ fake, build: 2, secrets: first.secrets, settingsPath: first.settingsPath })
    if (between) fake.afterOnce('PUT', /\/scripts\/writeflex-sharing$/, () => between(fake))
    tweak?.(w)
    const sent = fake.requests.length
    const result = await createSharingSetup(w.ports).setUp()
    return { w, fake, result, after: () => fake.requests.slice(sent) }
  }
  const noComfort = (result: SharingResult) => expect(JSON.stringify(result)).not.toMatch(/shortly|within a few minutes|links will work/i)

  test('proven: the deployment serving all traffic is the version this upload made', async () => {
    const { w, result } = await update()
    expect(result).toMatchObject({ ok: true, notice: UPDATED_NOTICE })
    expect(ruleOf(w)).toMatchObject({ stage: 'ready', build: 2, sentBuild: null })
  })

  test('overwritten, proven: another upload landed after this one (newer, older, and the build from before)', async () => {
    for (const [theirs, problem] of [[3, OVERWRITTEN_NEWER], [1, OVERWRITTEN_OLDER]] as const) {
      const { w, result } = await update((fake) => uploadFromElsewhere(fake.accounts.acc1.script!, theirs))
      expect(result).toMatchObject({ ok: false, problem })
      expect(ruleOf(w)).toMatchObject({ stage: 'ready', build: 1, sentBuild: 2 })
      noComfort(result)
    }
    const { result } = await update((fake) => { uploadFromElsewhere(fake.accounts.acc1.script!, 3); fake.accounts.acc1.script!.versionAnswer = { status: 500, body: '' } })
    expect(problemOf(result)).toEqual(OVERWRITTEN)
  })

  test('could not confirm: the version from before still serving, no version id in the upload\'s answer, no readable deployments, or the version before unknown', async () => {
    const cases: Array<[string, ((fake: FakeCloudflare) => void) | undefined, ((w: World) => void) | undefined]> = [
      ['the previous version still serving', (fake) => { fake.accounts.acc1.script!.deploymentLag = 1000 }, undefined],
      ['no version id', undefined, (w) => {
        const fetch = w.ports.fetch
        w.ports.fetch = async (input, init) => {
          const answer = await fetch(input, init)
          if (init?.method !== 'PUT') return answer
          const body = await answer.json() as { result: Record<string, unknown> }
          delete body.result.deployment_id
          return new Response(JSON.stringify(body), { status: answer.status })
        }
      }],
      ['deployments unreadable', undefined, (w) => {
        const fetch = w.ports.fetch
        w.ports.fetch = async (input, init) => (String(input).endsWith('/deployments') ? new Response('', { status: 500 }) : fetch(input, init))
      }],
      ['another version, and the one before unknown', (fake) => uploadFromElsewhere(fake.accounts.acc1.script!, 3), (w) => w.fake.failOnce('GET', /\/deployments$/, 500)],
    ]
    for (const [name, between, tweak] of cases) {
      const { w, result, after } = await update(between, tweak)
      expect([name, problemOf(result)]).toEqual([name, UPLOAD_UNCONFIRMED])
      expect(ruleOf(w)).toMatchObject({ stage: 'ready', build: 1, sentBuild: 2 })
      expect(after().some((entry) => entry.method === 'PATCH')).toBe(false)
      noComfort(result)
    }
  })

  test('could not confirm on a first set-up: not set up; Check again finishes it once the service answers as this build', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    const fetch = w.ports.fetch
    w.ports.fetch = async (input, init) => (String(input).endsWith('/deployments') ? new Response('', { status: 500 }) : fetch(input, init))
    const first = await w.setup.setUp()
    expect(problemOf(first)).toEqual(UPLOAD_UNCONFIRMED)
    expect(first.status).toMatchObject({ ready: false, interrupted: true, accountLocked: true })
    w.ports.fetch = fetch
    const again = await w.setup.setUp()
    expect(again).toMatchObject({ ok: true, status: { ready: true } })
    expect(again.ok && again.notice).toBeFalsy() // its own upload, not "already on this account"
    expect(w.fake.requests.filter((entry) => entry.method === 'PUT')).toHaveLength(1)
  })

  test('another Mac\'s upload landing after the proof, while this Mac adds its key: said so, not set up; the key stays listed', async () => {
    for (const [theirs, problem] of [[3, OVERWRITTEN_NEWER], [1, OVERWRITTEN_OLDER]] as const) {
      const w = world({ build: 2 })
      await w.setup.checkToken(TOKEN)
      w.fake.afterOnce('PATCH', /secrets-bulk$/, () => uploadFromElsewhere(w.fake.accounts.acc1.script!, theirs))
      const result = await w.setup.setUp()
      expect([theirs, problemOf(result)]).toEqual([theirs, problem])
      expect(result.status.ready).toBe(false)
      expect(Object.keys(w.fake.accounts.acc1.script!.secrets).some((name) => name.startsWith('ADMIN_SECRET_'))).toBe(true)
    }
    // On Update (1 → 2), a third build landing then is said too. The build from before is not taken as
    // proof (the edge goes on answering it after an upload): README-sharing-service.md, Residuals 6.
    const { result } = await update(undefined, (w) => w.fake.afterOnce('PATCH', /secrets-bulk$/, () => uploadFromElsewhere(w.fake.accounts.acc1.script!, 3)))
    expect(problemOf(result)).toEqual(OVERWRITTEN_NEWER)
    const stale = await update(undefined, (w) => { w.fake.accounts.acc1.script!.staleReads = 5 })
    expect(stale.result).toMatchObject({ ok: true, notice: UPDATED_NOTICE })
  })

  test('a first set-up overwritten by another Mac: said so, not set up', async () => {
    const w = world()
    await w.setup.checkToken(TOKEN)
    w.fake.afterOnce('PUT', /\/scripts\/writeflex-sharing$/, () => uploadFromElsewhere(w.fake.accounts.acc1.script!, 1))
    const result = await w.setup.setUp()
    expect(problemOf(result)).toEqual(OVERWRITTEN_OLDER)
    expect(result.status.ready).toBe(false)
  })
})

// ── The review's reproductions ──────────────────────────────────────────────────────────────────
describe('review reproductions', () => {
  test('S1: the save of `removing` fails: the key and token are NOT cleared and nothing is deleted', async () => {
    const w = await onPath('ready')
    const confirmation = await w.ipc.ask()
    w.ports.record.write = (record) => (record?.stage === 'removing' ? false : w.settings.setSharingRecord(record))
    const result = await w.ipc.remove(confirmation)
    expect(problemOf(result)).toEqual(REMOVAL_NOT_SAVED)
    expect(kept(w)).toMatchObject({ token: true, keys: true, record: { stage: 'ready' } })
    expect(script(w)).not.toBeNull()
  })

  test('S2: the unfinished set-up panel in Settings offers Remove', () => {
    const status: SharingSetupStatus = {
      ready: false, storageUnavailable: false, token: { stored: true, acceptedAt: null, problem: null }, accounts: [],
      account: { id: 'acc1', name: 'Personal' }, address: null, interrupted: true, accountLocked: true, removalPending: false, service: null, setUpAt: null,
    }
    const html = renderToStaticMarkup(createElement(SharingSettingsPanel, { onFlash: () => {}, onOpenSetup: () => {}, initialStatus: status }))
    expect(html).toContain('data-panel="remove"')
    expect(html).toContain('>Remove sharing from this account</button>')
  })

  test('S3: an upload overwritten back to the build from before is not reported as success', async () => {
    const fake = createFakeCloudflare({
      tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
      accounts: { acc1: { name: 'Shared account', subdomain: 'shared', script: newScript(1) } },
      uploadBuild: 2,
    })
    const w = world({ fake, build: 2 })
    await w.setup.checkToken(TOKEN)
    fake.afterOnce('PUT', /\/scripts\/writeflex-sharing$/, () => uploadFromElsewhere(fake.accounts.acc1.script!, 1))
    const result = await w.setup.setUp()
    expect(result.ok).toBe(false)
    expect(problemOf(result)).toEqual(OVERWRITTEN_OLDER)
    expect(result.status.ready).toBe(false)
  })

  test('S4: an account whose workers.dev subdomain changed since set-up: identity reads the current one, and the service is removed', async () => {
    const w = await onPath('ready')
    expect(ruleOf(w).address).toBe('https://writeflex-sharing.example.workers.dev')
    w.fake.accounts.acc1.subdomain = 'renamed'
    const result = await removeNow(w)
    expect(result.ok).toBe(true)
    expect(script(w)).toBeNull()
    const probed = w.fake.requests.filter((entry) => entry.to === 'service').map((entry) => new URL(entry.url).hostname)
    expect(probed.at(-1)).toBe('writeflex-sharing.renamed.workers.dev')
  })

  test('T1: window A\'s confirmation cannot delete account B, set up later by window B', async () => {
    const w = world({ fake: twoAccounts() })
    await w.setup.checkToken(TOKEN)
    await w.setup.chooseAccount('acc1')
    expect((await w.setup.setUp()).ok).toBe(true)
    // Window A shows "Remove sharing from Personal?" and leaves it open.
    const fromA = await w.ipc.ask(1)
    // Meanwhile window B's removal of acc1 goes through (by its own confirmation, without touching A's), and B sets up acc2.
    expect((await w.setup.remove(w.setup.removalTarget()!)).ok).toBe(true)
    expect(w.fake.accounts.acc1.script).toBeNull()
    await w.setup.checkToken(TOKEN)
    await w.setup.chooseAccount('acc2')
    expect((await w.setup.setUp()).ok).toBe(true)
    // Window A now presses Remove sharing: it named acc1, so acc2 is not touched.
    const result = await w.ipc.remove(fromA, 1)
    expect(problemOf(result)).toEqual(REMOVAL_TARGET_CHANGED)
    expect(w.fake.accounts.acc2.script).not.toBeNull()
    expect(deletes(w)).toHaveLength(1)
    expect(result.status).toMatchObject({ ready: true, account: { id: 'acc2' } })
  })

  test('T2: a /version that answers 500, throws, times out or is not JSON is never read as ours', async () => {
    for (const answer of [{ status: 500, body: '' }, { status: 404, body: 'nope' }, { status: 200, body: '{"servic' }, 'network' as const]) {
      const w = await onPath('ready')
      script(w)!.versionAnswer = answer
      const result = await removeNow(w)
      expect(result).toMatchObject({ ok: false, problem: SERVICE_UNCONFIRMED, removeAnyway: true })
      expect(deletes(w)).toEqual([])
    }
    const w = await onPath('ready')
    w.ports.timeouts = { request: 1000, upload: 1000, service: 20 }
    w.ports.serviceFetch = () => new Promise<Response>(() => {})
    const timedOut = await createSharingSetup(w.ports)
    const ipc = windows(timedOut)
    const result = await ipc.remove(await ipc.ask())
    expect(result).toMatchObject({ ok: false, problem: SERVICE_UNCONFIRMED, removeAnyway: true })
    expect(deletes(w)).toEqual([])
  })
})
