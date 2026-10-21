// The sharing set-up test world (sharing-world.ts) with sharing set up and the real sharing service behind
// the stand-in Cloudflare, plus the publisher over a scratch Workspace. Nothing
// leaves the process: requests go to the fake's fetch, which hands them to the service in memory.
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect } from 'bun:test'
import * as serviceModule from '../../sharing-service/index.ts'
import { createServiceClient } from '../../src/main/sharing-client.ts'
import { createSharingPublisher, type SharingPublisherPorts } from '../../src/main/sharing-publisher.ts'
import { createSharingSetup, type SharingSetup } from '../../src/main/sharing-setup.ts'
import { renderPieceForSharing } from '../../src/main/sharing-render.ts'
import { renderFolioLink } from '../../src/main/sharing-folio.ts'
import { TOKEN, world } from './sharing-world.ts'
import { attachSharingService } from './fake-sharing-service.ts'
import type { FakeCloudflare } from './fake-cloudflare.ts'
import { fakeService, type ServiceModule } from './sharing-service-runtime.ts'

export async function publishWorld(options: { files?: Record<string, string>; render?: SharingPublisherPorts['render']; renderFolio?: SharingPublisherPorts['renderFolio']; fake?: FakeCloudflare; ports?: Partial<SharingPublisherPorts> } = {}) {
  const w = world(options.fake ? { fake: options.fake } : {})
  expect((await w.setup.checkToken(TOKEN)).ok).toBe(true)
  expect((await w.setup.chooseAccount('acc1')).ok).toBe(true)
  expect((await w.setup.setUp()).ok).toBe(true)
  const svc = fakeService(serviceModule as unknown as ServiceModule)
  attachSharingService(w.fake, serviceModule as unknown as ServiceModule, svc)
  const root = mkdtempSync(join(tmpdir(), 'writeflex-share-ws-'))
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const [path, text] of Object.entries(options.files ?? {})) write(path, text)
  let saved: unknown = []
  const changes = { count: 0 }
  /** `fail`: settings.json cannot be written (the write answers false); `drop`: it answers true but keeps nothing. */
  const recordWrites = { fail: false, drop: false }
  /**
   * A dropped request: with `at` set, the service request of that index (counted from 0 since `count`
   * was last set to 0) fails as a dropped connection, `before` the service gets it or `after` it has
   * acted (its answer lost on the way back).
   */
  const fault: { at: number | null; mode: 'before' | 'after'; count: number } = { at: null, mode: 'before', count: 0 }
  /** This Mac offline: every service request fails as a dropped connection until it is back. */
  const net = { offline: false }
  const serviceFetch: typeof fetch = async (input, init) => {
    if (net.offline) throw new TypeError('fetch failed')
    const index = fault.count
    fault.count += 1
    if (fault.at !== index) return w.fake.serviceFetch(input, init)
    if (fault.mode === 'after') await w.fake.serviceFetch(input, init)
    throw new TypeError('fetch failed')
  }
  /** The set-up the publisher asks; `restart` replaces it with a new one over the same settings.json and Keychain. */
  let setup: SharingSetup = w.setup
  /** A publisher over the same settings.json and Keychain: what the app builds when it starts again. */
  const newPublisher = () => createSharingPublisher({
    records: {
      read: () => saved,
      write: (value) => {
        if (recordWrites.fail) return false
        if (!recordWrites.drop) saved = JSON.parse(JSON.stringify(value))
        return true
      },
    },
    secrets: w.secrets.store,
    access: () => setup.serviceAccess(),
    client: createServiceClient({ fetch: serviceFetch, wait: async () => {} }),
    render: options.render ?? ((r, path, imagePath) => renderPieceForSharing(r, path, imagePath)),
    renderFolio: options.renderFolio ?? ((r, dir, imagePath, kept) => renderFolioLink(r, dir, imagePath, kept)),
    debounceMs: 5,
    timeZone: () => 'Europe/London',
    changed: () => { changes.count += 1 },
    ...options.ports,
  })
  const publisher = newPublisher()
  const base = w.setup.serviceAccess()!.base
  /** Requests the service got after set-up, other than `/version`. */
  const serviceCalls = () => w.fake.requests.filter((entry) => entry.to === 'service' && new URL(entry.url).pathname !== '/version')
  const publishes = () => serviceCalls().filter((entry) => entry.method === 'PUT' && entry.url.endsWith('/page')).map((entry) => ({ shareId: new URL(entry.url).pathname.split('/')[2], body: JSON.parse(entry.body) as Record<string, unknown> & { kind: string; title: string; chips: Array<{ label: string; value: string }>; parts: Array<{ title: string; html: string; missing?: boolean; headings: Array<{ id: string; text: string }> }>; images: string[]; comments: boolean; revision: number } }))
  /** What a reader gets at the link (the service's own answer). */
  const readerPage = async (shareId: string) => {
    const response = await w.fake.serviceFetch(`${base}/s/${shareId}`)
    return { status: response.status, text: await response.text() }
  }
  /** WriteFlex starting again: a new set-up and a new publisher, nothing carried over but settings.json and the Keychain. */
  const restart = () => {
    setup = createSharingSetup(w.ports)
    return { setup, publisher: newPublisher() }
  }
  return { ...w, svc, root, write, net, publisher, newPublisher, restart, fault, saved: () => saved, recordWrites, changes, serviceCalls, publishes, readerPage }
}
