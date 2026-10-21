// A set-up of sharing wired to the stand-in Cloudflare (fake-cloudflare.ts), a settings file in a
// scratch folder, in-memory secrets and the real bundle built from sharing-service/; and the IPC that
// issues and takes removal confirmations (sharing-ipc.ts), so removal is driven as the window drives it.
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'bun:test'
import { buildSharingServiceDist } from '../../scripts/lib/sharing-service-dist.ts'
import { readSharingServiceFiles, type ShippedFiles } from '../../src/main/sharing-service-bundle.ts'
import { createSharingSetup, type SharingSetup, type SharingSetupPorts } from '../../src/main/sharing-setup.ts'
import { registerSharingIpc } from '../../src/main/sharing-ipc.ts'
import { SettingsStore } from '../../src/main/settings.ts'
import type { SharingRemovalQuestion, SharingResult } from '../../src/shared/sharing-setup.ts'
import { createFakeCloudflare, type FakeCloudflare } from './fake-cloudflare.ts'
import { memorySecrets } from './memory-secrets.ts'

export const TOKEN = ['fake', 'test', 'token', 'one', 'x'.repeat(20)].join('-')
export const OTHER_TOKEN = ['fake', 'test', 'token', 'two', 'y'.repeat(20)].join('-')
const repo = resolve(import.meta.dir, '..', '..')

let scratch = ''
/** The real bundle built from sharing-service/, its manifest unchanged (build = SHARING_SERVICE_BUILD). */
let shippedReal: ShippedFiles | null = null
/** Build the bundle once per test file (call in beforeAll), and clean up after (afterAll). */
export function buildShipped(): void {
  scratch = mkdtempSync(join(tmpdir(), 'writeflex-sharing-setup-'))
  const dist = join(scratch, 'dist')
  buildSharingServiceDist({ repo, outDir: dist })
  shippedReal = readSharingServiceFiles((name) => { try { return readFileSync(join(dist, name)) } catch { return null } })
}
export function removeShipped(): void { if (scratch) rmSync(scratch, { recursive: true, force: true }) }
export const shipped = (): ShippedFiles => shippedReal!
/** The build the real bundle's manifest records (SHARING_SERVICE_BUILD when it was built). */
const realBuild = (): number => (JSON.parse(shippedReal!.manifest!) as { build: number }).build
/**
 * The same bundle, its manifest saying `build` (the manifest itself is not hashed). The scenario tests
 * use build numbers as labels (set up on 1, this Mac carries 2, another Mac uploads 3), whatever build
 * sharing-service/ is at; the fake answers `/version` with its own `uploadBuild`, not from the bundle.
 */
export const shippedAs = (build: number): ShippedFiles => (build === realBuild() ? shippedReal! : { ...shippedReal!, manifest: JSON.stringify({ ...JSON.parse(shippedReal!.manifest!), build }) })

export type World = ReturnType<typeof world>
export function world(options: { fake?: FakeCloudflare; build?: number; secrets?: ReturnType<typeof memorySecrets>; settingsPath?: string } = {}) {
  const build = options.build ?? 1
  const fake = options.fake ?? createFakeCloudflare({
    tokens: { [TOKEN]: { status: 'active', accounts: ['acc1'], workers: 'edit' } },
    accounts: { acc1: { name: 'Example author · personal account', subdomain: 'example', script: null } },
    uploadBuild: build,
  })
  const secrets = options.secrets ?? memorySecrets()
  const settingsPath = options.settingsPath ?? join(mkdtempSync(join(scratch, 'settings-')), 'settings.json')
  const settings = new SettingsStore(settingsPath)
  let clock = 1_791_965_520_000
  const ports: SharingSetupPorts = {
    secrets: secrets.store,
    record: { read: () => settings.sharingRecord(), write: (record) => settings.setSharingRecord(record) },
    shipped: () => shippedAs(build),
    expectedBuild: build,
    fetch: fake.fetch,
    apiBase: () => 'http://127.0.0.1:9/client/v4',
    serviceFetch: fake.serviceFetch,
    now: () => (clock += 1000),
    wait: async () => { clock += 1000 },
    serviceWaitMs: 10_000,
  }
  const setup = createSharingSetup(ports)
  /** Move the clock on (the own address's day of trust). */
  const tick = (ms: number): void => { clock += ms }
  return { fake, secrets, settings, settingsPath, setup, ports, tick, clock: () => clock, ipc: windows(setup, () => clock) }
}

/** The sharing IPC over `setup`; windows 1 and 2 are WriteFlex's. */
export function windows(setup: SharingSetup, clock: () => number = Date.now) {
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  registerSharingIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, setup, {
    openExternal: () => {}, isAppWindow: (id) => id === 1 || id === 2, now: clock,
  })
  const call = (channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input)
  return {
    /** "Remove sharing from …?" (or Retry) shown in window `sender`: the confirmation main issues for it. */
    ask: async (sender = 1): Promise<string> => {
      const question = await call('sharing:removal-confirmation', sender) as SharingRemovalQuestion
      if (!question.confirmation) throw new Error('Nothing to remove.')
      return question.confirmation
    },
    question: (sender = 1) => call('sharing:removal-confirmation', sender) as Promise<SharingRemovalQuestion>,
    remove: (confirmation: string, sender = 1) => call('sharing:remove', sender, { confirmation }) as Promise<SharingResult>,
  }
}

/** Remove as the window does it: the question shown, then Remove sharing. */
export async function removeNow(w: World): Promise<SharingResult> { return w.ipc.remove(await w.ipc.ask()) }
/** "Remove it anyway" on a removal that stopped to ask. */
export function removeAnyway(w: World, stopped: SharingResult): Promise<SharingResult> {
  if (stopped.ok || !stopped.anywayConfirmation) throw new Error('That removal did not ask.')
  return w.ipc.remove(stopped.anywayConfirmation)
}

/** Every place the token must never be. */
export function expectTokenNowhere(w: World, results: SharingResult[], token = TOKEN): void {
  expect(existsSync(w.settingsPath) ? readFileSync(w.settingsPath, 'utf8') : '').not.toContain(token)
  expect(JSON.stringify(results)).not.toContain(token)
  expect(w.fake.wire('service')).not.toContain(token)
  for (const request of w.fake.requests.filter((entry) => entry.to === 'api')) {
    const { authorization, ...otherHeaders } = request.headers
    if (authorization !== undefined) expect(authorization).toBe(`Bearer ${request.headers.authorization.slice(7)}`)
    expect(request.url).not.toContain(token)
    expect(JSON.stringify(otherHeaders)).not.toContain(token)
    expect(request.body).not.toContain(token)
  }
  // Nothing goes to the service with any credential at all.
  for (const request of w.fake.requests.filter((entry) => entry.to === 'service')) expect(request.headers.authorization).toBeUndefined()
}

export const problemOf = (result: SharingResult) => (result.ok ? null : result.problem)
export const apiCalls = (w: World) => w.fake.requests.filter((entry) => entry.to === 'api').map((entry) => `${entry.method} ${new URL(entry.url).pathname.replace('/client/v4', '')}`)
export const deletes = (w: World) => w.fake.requests.filter((entry) => entry.method === 'DELETE')

/** A stand-in with two accounts the token can install on. */
export const twoAccounts = (): FakeCloudflare => createFakeCloudflare({
  tokens: { [TOKEN]: { status: 'active', accounts: ['acc1', 'acc2'], workers: 'edit' } },
  accounts: {
    acc1: { name: 'Personal', subdomain: 'personal', script: null },
    acc2: { name: 'Department', subdomain: 'department', script: null },
  },
  uploadBuild: 1,
})
