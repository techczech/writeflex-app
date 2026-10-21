// A stand-in for Cloudflare's API and for the sharing service's `/version`, for the set-up tests
// of sharing. No real Cloudflare call is ever made. It answers the routes the set-up uses in
// Cloudflare's own reply shape ({success, errors:[{code}], result}) with the status codes and error
// numbers Cloudflare documents, and records every request whole (method, address, headers, body) so a
// test can grep the wire for the token.
//
// Versions and deployments as wrangler 4 reads them: an upload (`PUT …/scripts/<name>`) and every
// change of secrets make a new version and deploy it; the upload answers with `deployment_id`, the new
// version's id without hyphens; `GET …/scripts/<name>/deployments` lists `{deployments: [{id, source,
// strategy, versions: [{version_id, percentage}]}]}`, latest first, ids with hyphens. The workers.dev
// switch makes no version.
//
// Used two ways: as a `fetch` (unit tests, `fake.fetch` and `fake.serviceFetch`), and behind a
// loopback HTTP server for the e2e run (`serveFake`), where `/client/v4/...` is the API and
// `/version` is the service.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export type FakeToken = {
  status: 'active' | 'expired' | 'disabled'
  /** The accounts it lists (needs Account Settings · Read). Empty: lists none. */
  accounts: string[]
  /** Workers Scripts on those accounts: edit, read only, or none. */
  workers: 'edit' | 'read' | 'none'
  /** The Zone permissions on the domains of its accounts (none when absent). */
  zone?: { routes: boolean; dns: boolean }
}
/** A domain on an account. `records`: the names that have DNS records already. */
export type FakeZone = { id: string; name: string; status: 'active' | 'pending' | 'moved'; records: string[] }
/** A Worker Custom Domain. `answering` false: attached, and Cloudflare is not serving it yet (no certificate) or no longer. */
export type FakeCustomDomain = { id: string; hostname: string; service: string; zoneId: string; answering: boolean }
export type FakeScript = {
  build: number
  migrationTag: string | null
  workersDev: boolean
  secrets: Record<string, string>
  /** `/version` reads still answering the build from before the last upload. */
  staleReads: number
  previousBuild: number | null
  /** Its `/version` answers as some other service: a Worker of the same name that is not WriteFlex's. */
  foreign?: boolean
  /** The version serving all traffic now (32 hex), and the one before it. */
  version: string
  previousVersion: string | null
  /** Deployment reads still listing the version from before the last change. */
  deploymentLag: number
  /** `/version` answers with this status and body instead (the probe's inconclusive answers). */
  versionAnswer?: { status: number; body: string } | 'network'
}
export type FakeAccount = { name: string; subdomain: string | null; script: FakeScript | null; zones?: FakeZone[]; domains?: FakeCustomDomain[] }
export type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: string; to: 'api' | 'service' }
export type Failure = 'network' | number

export type FakeCloudflare = {
  tokens: Record<string, FakeToken>
  accounts: Record<string, FakeAccount>
  /** The build an upload puts there (the bundle's own build in a real upload). */
  uploadBuild: number
  requests: RecordedRequest[]
  /** Make the next matching request fail once (a dropped connection, or an HTTP status). */
  failOnce(method: string, pathPattern: RegExp, failure: Failure): void
  /** Run `then` right after the next matching request has been answered (another Mac acting in between). */
  afterOnce(method: string, pathPattern: RegExp, then: () => void): void
  /** Hold the next matching request unanswered until the returned function is called (a slow service). */
  holdOnce(method: string, pathPattern: RegExp): () => void
  fetch: typeof fetch
  serviceFetch: typeof fetch
  /** Everything sent, as one text: what a test greps for a secret. */
  wire(to?: 'api' | 'service'): string
  /**
   * The sharing service itself, for every service route but `/version` (publishing). Unset:
   * those routes answer 404, as in the set-up tests. See fake-sharing-service.ts.
   */
  sharingService?: (request: Request) => Promise<Response>
  /** Whether a Custom Domain attached now answers at once (false: Cloudflare is still preparing it). */
  newDomainsAnswer: boolean
  /** The Mac is offline. Every request fails as a dropped connection and none is recorded (none arrived). */
  offline: boolean
}

const SCRIPT_NAME = 'writeflex-sharing'
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const ok = (result: unknown): Response => json(200, { success: true, errors: [], messages: [], result })
const error = (status: number, code: number, message: string): Response => json(status, { success: false, errors: [{ code, message }], messages: [], result: null })

let versions = 0
let domainIds = 0
/** A new version id, as Cloudflare's: 32 hex digits. */
export const newVersionId = (): string => (versions += 1).toString(16).padStart(8, '0') + 'feedfacecafe0000beef' + (versions % 4096).toString(16).padStart(4, '0')
const hyphened = (id: string): string => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`

export function newScript(build: number, secrets: Record<string, string> = {}): FakeScript {
  return { build, migrationTag: 'v1', workersDev: true, secrets: { ...secrets }, staleReads: 0, previousBuild: null, version: newVersionId(), previousVersion: null, deploymentLag: 0 }
}

/** A new version deployed on `script` (an upload or a secret change). */
export function deployNewVersion(script: FakeScript): string {
  script.previousVersion = script.version
  script.version = newVersionId()
  return script.version
}

/** Another Mac's upload landing on the account: a new version answering as `build`. */
export function uploadFromElsewhere(script: FakeScript, build: number): void {
  script.previousBuild = script.build
  script.build = build
  deployNewVersion(script)
}

export function createFakeCloudflare(setup: { tokens: Record<string, FakeToken>; accounts: Record<string, FakeAccount>; uploadBuild: number }): FakeCloudflare {
  const failures: Array<{ method: string; path: RegExp; failure: Failure }> = []
  const afters: Array<{ method: string; path: RegExp; then: () => void }> = []
  const holds: Array<{ method: string; path: RegExp; until: Promise<void> }> = []
  const requests: RecordedRequest[] = []
  const fake: FakeCloudflare = {
    tokens: setup.tokens,
    accounts: setup.accounts,
    uploadBuild: setup.uploadBuild,
    requests,
    newDomainsAnswer: true,
    offline: false,
    failOnce(method, path, failure) { failures.push({ method, path, failure }) },
    afterOnce(method, path, then) { afters.push({ method, path, then }) },
    holdOnce(method, path) {
      let release = (): void => {}
      holds.push({ method, path, until: new Promise<void>((done) => { release = done }) })
      return () => release()
    },
    fetch: (input, init) => handle(new Request(input as string, init), 'api'),
    serviceFetch: (input, init) => handle(new Request(input as string, init), 'service'),
    wire: (to) => requests.filter((entry) => !to || entry.to === to).map((entry) => `${entry.method} ${entry.url}\n${JSON.stringify(entry.headers)}\n${entry.body}`).join('\n\n'),
  }

  async function handle(request: Request, to: 'api' | 'service'): Promise<Response> {
    if (fake.offline) throw new TypeError('fetch failed')
    const headers: Record<string, string> = {}
    request.headers.forEach((value, name) => { headers[name] = value })
    const body = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.clone().text()
    requests.push({ method: request.method, url: request.url, headers, body, to })
    const url = new URL(request.url)
    const hold = holds.findIndex((entry) => entry.method === request.method && entry.path.test(url.pathname))
    if (hold !== -1) await holds.splice(hold, 1)[0].until
    const failure = failures.findIndex((entry) => entry.method === request.method && entry.path.test(url.pathname))
    if (failure !== -1) {
      const [{ failure: what }] = failures.splice(failure, 1)
      if (what === 'network') throw new TypeError('fetch failed')
      return error(what, 10013, 'injected failure')
    }
    // An own address reaches the service only while its Custom Domain is attached to it and answering.
    if (to === 'service' && url.pathname !== '/version' && !/\.workers\.dev$/.test(url.hostname) && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      const domain = Object.values(fake.accounts).flatMap((entry) => entry.domains ?? []).find((entry) => entry.hostname === url.hostname)
      if (!domain || !domain.answering) throw new TypeError('fetch failed')
      if (domain.service !== SCRIPT_NAME) return new Response('another site', { status: 200 })
    }
    const answer = to === 'service'
      ? (url.pathname !== '/version' && fake.sharingService ? await fake.sharingService(request) : service(url))
      : await api(request, url)
    const after = afters.findIndex((entry) => entry.method === request.method && entry.path.test(url.pathname))
    if (after !== -1) afters.splice(after, 1)[0].then()
    return answer
  }

  function service(url: URL): Response {
    if (url.pathname !== '/version') return new Response('not found', { status: 404 })
    const sub = /^writeflex-sharing\.([a-z0-9-]+)\.workers\.dev$/.exec(url.hostname)?.[1]
    // An own address: answered by the Worker its Custom Domain names, once Cloudflare serves it.
    const custom = !sub && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost'
    if (custom) {
      const owner = Object.values(fake.accounts).find((entry) => entry.domains?.some((domain) => domain.hostname === url.hostname))
      const domain = owner?.domains?.find((entry) => entry.hostname === url.hostname)
      if (!owner || !domain || !domain.answering) throw new TypeError('fetch failed')
      if (domain.service !== SCRIPT_NAME || !owner.script) return new Response('another site', { status: 200 })
      return json(200, { service: SCRIPT_NAME, build: owner.script.build })
    }
    const account = Object.values(fake.accounts).find((entry) => entry.script && (sub ? entry.subdomain === sub : true))
    const script = account?.script
    if (!script || !script.workersDev) return new Response('There is nothing here yet', { status: 404 })
    if (script.versionAnswer === 'network') throw new TypeError('fetch failed')
    if (script.versionAnswer) return new Response(script.versionAnswer.body, { status: script.versionAnswer.status })
    if (script.foreign) return json(200, { service: 'someone-elses-worker', build: 7 })
    if (script.staleReads > 0 && script.previousBuild !== null) {
      script.staleReads -= 1
      return json(200, { service: SCRIPT_NAME, build: script.previousBuild })
    }
    return json(200, { service: SCRIPT_NAME, build: script.build })
  }

  async function api(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/client\/v4/, '')
    const bearer = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1] ?? ''
    const token = fake.tokens[bearer]
    if (path === '/user/tokens/verify') {
      if (!token) return error(401, 1000, 'Invalid API Token')
      return ok({ id: 'token-id', status: token.status })
    }
    if (!token || token.status !== 'active') return error(401, 10000, 'Authentication error')
    if (path === '/accounts') {
      const page = Number(url.searchParams.get('page') ?? '1')
      const listed = page === 1 ? token.accounts.filter((id) => fake.accounts[id]).map((id) => ({ id, name: fake.accounts[id].name })) : []
      return ok(listed)
    }
    const own = await ownAddressRoutes(request, url, path, token)
    if (own) return own
    const match = /^\/accounts\/([^/]+)\/workers\/(subdomain|services\/[^/]+|scripts\/[^/]+(?:\/subdomain|\/secrets-bulk|\/secrets|\/deployments)?)$/.exec(path)
    if (!match) return error(404, 7003, 'Could not route to this path')
    const [, accountId, rest] = match
    const account = fake.accounts[accountId]
    if (!account || !token.accounts.includes(accountId) || token.workers === 'none') return error(403, 10000, 'Authentication error')
    const writing = request.method !== 'GET'
    if (writing && token.workers !== 'edit') return error(403, 10000, 'Authentication error')
    if (rest === 'subdomain') {
      if (!account.subdomain) return error(404, 10007, 'This account does not have a workers.dev subdomain')
      return ok({ subdomain: account.subdomain })
    }
    const script = account.script
    if (rest.startsWith('services/')) {
      if (!script || rest !== `services/${SCRIPT_NAME}`) return error(404, 10090, 'Service not found')
      return ok({ id: SCRIPT_NAME, default_environment: { environment: 'production', script: { migration_tag: script.migrationTag } } })
    }
    const scriptName = rest.split('/')[1]
    const sub = rest.split('/')[2]
    if (scriptName !== SCRIPT_NAME) return error(404, 10007, 'Worker not found')
    if (!sub && request.method === 'PUT') {
      if (url.searchParams.get('bindings_inherit') !== 'strict') return error(400, 10021, 'bindings_inherit must be strict in this fake')
      const form = await request.formData()
      const metadata = JSON.parse(String(form.get('metadata'))) as { main_module?: string; migrations?: { old_tag?: string; new_tag: string } }
      if (!metadata.main_module || !form.get(metadata.main_module)) return error(400, 10021, 'No main module')
      const migrations = metadata.migrations
      if (script) {
        if (migrations && migrations.old_tag !== (script.migrationTag ?? undefined)) return error(400, 10079, 'Migration tag mismatch')
        script.previousBuild = script.build
        script.build = fake.uploadBuild
        if (migrations) script.migrationTag = migrations.new_tag
        deployNewVersion(script)
      } else {
        if (!migrations || migrations.old_tag !== undefined) return error(400, 10074, 'A new script needs its migrations')
        account.script = { ...newScript(fake.uploadBuild), migrationTag: migrations.new_tag, workersDev: false }
      }
      return ok({ id: SCRIPT_NAME, etag: 'e'.repeat(64), deployment_id: account.script!.version, startup_time_ms: 7, has_modules: true })
    }
    if (!script) return error(404, 10007, 'Worker not found')
    if (!sub && request.method === 'DELETE') {
      if (url.searchParams.get('force') !== 'true') return error(400, 10064, 'Durable Objects need force')
      account.script = null
      return ok(null)
    }
    if (sub === 'subdomain' && request.method === 'POST') {
      script.workersDev = (await request.json() as { enabled?: boolean }).enabled === true
      return ok({ enabled: script.workersDev })
    }
    if (sub === 'secrets-bulk' && request.method === 'PATCH') {
      if (request.headers.get('content-type') !== 'application/merge-patch+json') return error(400, 10021, 'merge-patch expected')
      const patch = await request.json() as { secrets?: Record<string, { text: string } | null> }
      for (const [name, value] of Object.entries(patch.secrets ?? {})) {
        if (value === null) delete script.secrets[name]
        else script.secrets[name] = value.text
      }
      // A secret change makes a new version and deploys it.
      deployNewVersion(script)
      return ok(null)
    }
    if (sub === 'deployments' && request.method === 'GET') {
      const serving = script.deploymentLag > 0 && script.previousVersion ? script.previousVersion : script.version
      if (script.deploymentLag > 0) script.deploymentLag -= 1
      return ok({ deployments: [{ id: hyphened(newVersionId()), source: 'api', strategy: 'percentage', created_on: '2026-10-15T09:00:00Z', annotations: {}, versions: [{ version_id: hyphened(serving), percentage: 100 }] }] })
    }
    if (sub === 'secrets' && request.method === 'GET') return ok(Object.keys(script.secrets).map((name) => ({ name, type: 'secret_text' })))
    return error(405, 10405, 'Method not allowed')
  }

  /** `/zones`, `/zones/<id>/dns_records`, `/accounts/<id>/workers/domains[/<id>]`; null for any other path. */
  async function ownAddressRoutes(request: Request, url: URL, path: string, token: FakeToken): Promise<Response | null> {
    const reachable = token.accounts.filter((id) => fake.accounts[id])
    const zonePermission = token.zone?.routes === true || token.zone?.dns === true
    if (path === '/zones' && request.method === 'GET') {
      if (!zonePermission) return ok([])
      const name = url.searchParams.get('name')
      const account = url.searchParams.get('account.id')
      const status = url.searchParams.get('status')
      const listed = reachable.flatMap((id) => (fake.accounts[id].zones ?? []).map((zone) => ({ id: zone.id, name: zone.name, status: zone.status, account: { id, name: fake.accounts[id].name } })))
        .filter((zone) => (!name || zone.name === name) && (!account || zone.account.id === account) && (!status || zone.status === status))
      return ok(Number(url.searchParams.get('page') ?? '1') > 1 ? [] : listed)
    }
    const records = /^\/zones\/([^/]+)\/dns_records$/.exec(path)
    if (records && request.method === 'GET') {
      const zone = reachable.flatMap((id) => fake.accounts[id].zones ?? []).find((entry) => entry.id === records[1])
      if (!zone || !token.zone?.dns) return error(403, 10000, 'Authentication error')
      const name = url.searchParams.get('name')
      const domains = Object.values(fake.accounts).flatMap((entry) => entry.domains ?? []).filter((domain) => domain.zoneId === zone.id).map((domain) => domain.hostname)
      return ok([...zone.records, ...domains].filter((entry) => !name || entry === name).map((entry, index) => ({ id: `rec${index}`, name: entry, type: 'A' })))
    }
    const domains = /^\/accounts\/([^/]+)\/workers\/domains(?:\/([^/]+))?$/.exec(path)
    if (!domains) return null
    const [, accountId, domainId] = domains
    const account = fake.accounts[accountId]
    if (!account || !token.accounts.includes(accountId) || token.workers === 'none') return error(403, 10000, 'Authentication error')
    account.domains ??= []
    if (request.method === 'GET' && !domainId) {
      const hostname = url.searchParams.get('hostname')
      return ok(account.domains.filter((entry) => !hostname || entry.hostname === hostname).map((entry) => ({ id: entry.id, hostname: entry.hostname, service: entry.service, zone_id: entry.zoneId, environment: 'production' })))
    }
    if (request.method === 'PUT' && !domainId) {
      if (token.workers !== 'edit' || !token.zone?.routes || !token.zone?.dns) return error(403, 10000, 'Authentication error')
      const body = await request.json() as { hostname?: string; service?: string; zone_id?: string; environment?: string }
      const zone = (account.zones ?? []).find((entry) => entry.id === body.zone_id)
      if (!zone || typeof body.hostname !== 'string' || !body.hostname.endsWith(`.${zone.name}`) || body.environment !== 'production' || typeof body.service !== 'string') return error(400, 100100, 'Invalid domain')
      const hostname = body.hostname
      if (zone.records.includes(hostname)) return error(409, 100117, 'Hostname already has externally managed DNS records')
      const taken = Object.values(fake.accounts).flatMap((entry) => entry.domains ?? []).find((entry) => entry.hostname === hostname)
      if (taken && taken.service !== body.service) return error(409, 100116, 'Hostname is attached to another Worker')
      if (taken) return ok({ id: taken.id, hostname, service: taken.service, zone_id: zone.id, environment: 'production' })
      const made: FakeCustomDomain = { id: `dom${(domainIds += 1)}`, hostname, service: body.service, zoneId: zone.id, answering: fake.newDomainsAnswer }
      account.domains.push(made)
      return ok({ id: made.id, hostname, service: made.service, zone_id: zone.id, environment: 'production' })
    }
    if (request.method === 'DELETE' && domainId) {
      if (token.workers !== 'edit' || !token.zone?.routes) return error(403, 10000, 'Authentication error')
      const at = account.domains.findIndex((entry) => entry.id === domainId)
      if (at === -1) return error(404, 100114, 'Domain not found')
      account.domains.splice(at, 1)
      return ok(null)
    }
    return error(405, 10405, 'Method not allowed')
  }

  return fake
}

/**
 * The fake behind a loopback server (e2e): `/client/v4/...` is the API, `/version` the service.
 * Answers on 127.0.0.1 only.
 */
export async function serveFake(fake: FakeCloudflare): Promise<{ apiBase: string; serviceOrigin: string; close: () => Promise<void> }> {
  let port = 0
  const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
    const chunks: Buffer[] = []
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
    incoming.on('end', () => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string' && name !== 'host' && name !== 'content-length' && name !== 'connection') headers.set(name, value)
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      // With the port: a reader page opened in a browser sends its own origin, which the
      // service compares with the request's; without the port they would never match.
      const address = `http://127.0.0.1:${port}${incoming.url ?? '/'}`
      const init: RequestInit = { method: incoming.method, headers, ...(body && incoming.method !== 'GET' ? { body } : {}) }
      const answer = (incoming.url ?? '').startsWith('/client/v4') ? fake.fetch(address, init) : fake.serviceFetch(address, init)
      answer.then(async (response) => {
        const headers: Record<string, string> = {}
        response.headers.forEach((value, name) => { headers[name] = value })
        outgoing.writeHead(response.status, { ...headers, 'content-type': response.headers.get('content-type') ?? 'text/plain' })
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      }, () => { incoming.socket.destroy() })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  return {
    apiBase: `http://127.0.0.1:${port}/client/v4`,
    serviceOrigin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
