// Pictures from other sites, fetched from this Mac for a shared copy (sharing ticket 03; spec section 8,
// review round 1 finding 1). A piece is untrusted input (an agent may have written it), so a picture
// address must never let it reach this Mac or its private network:
//
//   - only `http:` and `https:`, no user name or password in the address;
//   - names that only mean something nearby are refused without a lookup: no dot (`intranet`),
//     `localhost`, `.local`, `.internal`, `.localhost`, `.home.arpa`;
//   - the name is looked up ONCE and every address it gives must be public: not loopback, private
//     (RFC 1918, CGNAT 100.64/10, IPv6 ULA fc00::/7), link-local (169.254/16 with the cloud metadata
//     address, fe80::/10), unspecified, multicast, reserved or documentation ranges, and no IPv6 form
//     that carries a refused IPv4 address;
//   - the connection goes to the address that was checked (pinned: the host is the address, the name
//     travels only as the Host header and the TLS server name, so the certificate is still checked
//     against the name), so no second lookup can swap it;
//   - redirects are followed by hand, at most MAX_REDIRECTS, each target checked the same way;
//   - bounded in time (REMOTE_PICTURE_MS for the whole chain) and size (the service's size for one
//     picture); no cookie, no credential.
//
// A refused address throws RemotePictureRefused, so the rendering can tell the writer in plain words
// that the picture went out as its description (sharing-render.ts). A picture that simply cannot be had
// answers null.
//
// No Electron import. The lookup and the pinned request are ports, so tests use neither DNS nor the
// network (the real ones are `lookupHost` and `pinnedGet`).
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'

/** Fetch a picture from another site: its bytes, or null; throws RemotePictureRefused for a refused address. */
export type RemotePictureFetch = (url: string) => Promise<Uint8Array | null>

/** The address points at this Mac or its local network (or is not a web address a reader could load). */
export class RemotePictureRefused extends Error {
  constructor() { super('A picture address that points at this Mac or its network was not fetched.') }
}

export type ResolvedAddress = { address: string; family: 4 | 6 }
/** Every address a name looks up to (one lookup). */
export type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>
export type PinnedResponse = { status: number; location: string | null; body: AsyncIterable<Uint8Array>; cancel(): void }
/** One GET of `url`, connecting to `pinned` (never looking the name up again). */
export type PinnedGet = (url: URL, pinned: ResolvedAddress, signal: AbortSignal) => Promise<PinnedResponse>

/** How long fetching one picture (its whole redirect chain) may take. */
export const REMOTE_PICTURE_MS = 15_000
export const MAX_REDIRECTS = 3

// ── Which addresses are public ──────────────────────────────────────────────────────────────────

function ipv4Number(ip: string): number {
  return ip.split('.').reduce((sum, part) => sum * 256 + Number(part), 0)
}
const V4_REFUSED: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]
function isPublicIpv4(ip: string): boolean {
  const value = ipv4Number(ip)
  return !V4_REFUSED.some(([base, bits]) => {
    const size = 2 ** (32 - bits)
    const start = ipv4Number(base)
    return value >= start && value < start + size
  })
}

/** An IPv6 address as eight 16-bit numbers (a trailing dotted IPv4 part included), or null. */
function ipv6Words(ip: string): number[] | null {
  let text = ip.toLowerCase().split('%')[0]
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null
    const v = ipv4Number(dotted[1])
    text = `${text.slice(0, -dotted[1].length)}${(v >>> 16).toString(16)}:${(v & 0xffff).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((word) => parseInt(word, 16)))
  const head = parse(halves[0])
  const tail = halves.length === 2 ? parse(halves[1]) : []
  const words = halves.length === 2 ? [...head, ...Array(8 - head.length - tail.length).fill(0), ...tail] : head
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff) ? words : null
}
const v4Of = (high: number, low: number): string => [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.')

function isPublicIpv6(ip: string): boolean {
  const w = ipv6Words(ip)
  if (!w) return false
  const zeroUpTo = (count: number): boolean => w.slice(0, count).every((word) => word === 0)
  if (zeroUpTo(8)) return false // :: unspecified
  if (zeroUpTo(7) && w[7] === 1) return false // ::1 loopback
  if (zeroUpTo(5) && w[5] === 0xffff) return isPublicIpv4(v4Of(w[6], w[7])) // ::ffff:a.b.c.d mapped
  if (zeroUpTo(6)) return false // ::a.b.c.d compatible (deprecated)
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 0x0001) return false // 64:ff9b:1::/48 local-use NAT64 (RFC 8215): a network's own translator
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((word) => word === 0)) return isPublicIpv4(v4Of(w[6], w[7])) // NAT64
  if (w[0] === 0x2002) return isPublicIpv4(v4Of(w[1], w[2])) // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return false // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return false // fe80::/10 link-local
  if ((w[0] & 0xffc0) === 0xfec0) return false // fec0::/10 site-local (deprecated)
  if ((w[0] & 0xff00) === 0xff00) return false // ff00::/8 multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false // documentation
  if (w[0] === 0x0100 && w.slice(1, 4).every((word) => word === 0)) return false // discard
  if (w[0] === 0x2001 && w[1] < 0x0200) return false // 2001::/23 IETF protocol assignments (Teredo included)
  return true
}

/** True only for an address on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip.split('%')[0])
  if (family === 4) return isPublicIpv4(ip)
  if (family === 6) return isPublicIpv6(ip)
  return false
}

/** True for a name that can only mean something nearby (refused without a lookup). */
export function isLocalHostName(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/\.+$/, '')
  if (name === '' || !name.includes('.')) return true
  return name === 'localhost' || /\.(local|internal|localhost|home\.arpa|localdomain|lan|intranet|corp)$/.test(name)
}

// ── The fetch ───────────────────────────────────────────────────────────────────────────────────

/** The URL's host without IPv6 brackets. */
const bareHost = (url: URL): string => url.hostname.replace(/^\[(.*)\]$/, '$1')

/**
 * `promise`, or null once `signal` aborts, whichever comes first. Node cannot cancel a `lookup`: the
 * abandoned promise settles later and its answer is dropped, which is harmless (nothing waits on it,
 * and a rejection is caught here).
 */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) { promise.catch(() => {}); return Promise.resolve(null) }
  return new Promise<T | null>((done, fail) => {
    const onAbort = (): void => done(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); done(value) },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); fail(error) },
    )
  })
}

/**
 * The address to connect to for `url`, checked; throws RemotePictureRefused. Null when `signal`
 * aborts first: the name lookup counts against the picture's one deadline, shared by every redirect hop.
 */
async function checkedAddress(url: URL, resolveHost: ResolveHost, signal: AbortSignal): Promise<ResolvedAddress | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RemotePictureRefused()
  if (url.username || url.password) throw new RemotePictureRefused()
  const host = bareHost(url)
  const literal = isIP(host)
  if (literal) {
    if (!isPublicAddress(host)) throw new RemotePictureRefused()
    return { address: host, family: literal as 4 | 6 }
  }
  if (isLocalHostName(host)) throw new RemotePictureRefused()
  const addresses = await untilAborted(resolveHost(host), signal)
  if (addresses === null) return null
  if (addresses.length === 0) throw new RemotePictureRefused()
  // Every address the name gives must be public: a name that also points inward is refused whole.
  if (addresses.some((entry) => !isPublicAddress(entry.address))) throw new RemotePictureRefused()
  return addresses[0]
}

export function safeRemotePictureFetch(ports: { resolveHost: ResolveHost; get: PinnedGet; timeoutMs?: number }): RemotePictureFetch {
  return async (address) => {
    let url: URL
    try { url = new URL(address) } catch { return null }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ports.timeoutMs ?? REMOTE_PICTURE_MS)
    ;(timer as { unref?: () => void }).unref?.()
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const pinned = await checkedAddress(url, ports.resolveHost, controller.signal)
        if (!pinned) return null
        let response: PinnedResponse
        try { response = await ports.get(url, pinned, controller.signal) } catch { return null }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          response.cancel()
          if (!response.location) return null
          try { url = new URL(response.location, url) } catch { return null }
          continue
        }
        if (response.status < 200 || response.status > 299) { response.cancel(); return null }
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for await (const chunk of response.body) {
            size += chunk.byteLength
            if (size > SHARE_LIMITS.imageBytes) { response.cancel(); return null }
            chunks.push(chunk)
          }
        } catch { return null }
        const bytes = new Uint8Array(size)
        let at = 0
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength }
        return bytes
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The real lookup: every address the system gives for the name, once. */
export const lookupHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }))

/**
 * The real GET, pinned: the socket connects to `pinned.address` (no lookup happens, the host is an
 * address); the name goes only in the Host header and, for https, as the TLS server name, which is
 * also what the certificate is checked against. No cookie, no credential, no connection reuse.
 */
export const pinnedGet: PinnedGet = (url, pinned, signal) => new Promise((resolve, reject) => {
  const host = bareHost(url)
  const secure = url.protocol === 'https:'
  const request = (secure ? httpsRequest : httpRequest)({
    host: pinned.address,
    family: pinned.family,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers: { host: url.host, accept: 'image/*' },
    agent: false,
    signal,
    ...(secure && !isIP(host) ? { servername: host } : {}),
  }, (response: IncomingMessage) => {
    const location = response.headers.location
    resolve({
      status: response.statusCode ?? 0,
      location: typeof location === 'string' ? location : null,
      body: response as AsyncIterable<Uint8Array>,
      cancel: () => { response.destroy() },
    })
  })
  request.on('error', reject)
  request.end()
})
