// Updating in place (ADR-0054): the update download's own network session (electron-updater's `electron-updater`
// partition) reaches only the public internet over HTTPS. The feed names files on github.com only (update-channels.ts);
// GitHub then redirects to its file host. A redirect anywhere else that is plain http, this Mac or the local network
// (by address or by a local name) is refused before Chromium connects. This is the narrow part of TalkWeaver's
// local-address filter that the update download needs; WriteFlex has no general filter to reuse.
//
// Not closed here: a public name that resolves to a local address (the name is not looked up). The chain of
// redirects is GitHub's, and a file that arrives anyway must still match the feed's SHA-512 and size and, on a Mac,
// carry WriteFlex's Developer ID signature before anything is installed.
import { isIP } from 'node:net'

/** The host as Chromium reads it, lower-cased; IPv6 without brackets. */
function hostOf(url: URL): string {
  const host = url.hostname.toLowerCase()
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * The host as it is classified: lower-case, with the trailing dots of a fully qualified name removed. `localhost.`,
 * an mDNS name ending in `.local.` and `127.0.0.1.` name the same places as without the dot, and DNS resolves them the same way.
 */
export function canonicalHost(host: string): string {
  return host.toLowerCase().replace(/\.+$/, '')
}

/** An address on this Mac or a local network, or a name that only means one there. Anything unreadable counts as local. */
export function isLocalHost(spelled: string): boolean {
  const host = canonicalHost(spelled)
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true
  if (!host.includes('.') && isIP(host) === 0) return true // a single-label name: the local network's
  const kind = isIP(host)
  if (kind === 4) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
  }
  if (kind === 6) {
    if (host === '::' || host === '::1') return true
    const first = host.split(':')[0]
    if (/^f[cd]/.test(first) || /^fe[89ab]/.test(first) || /^ff/.test(first)) return true
    // An IPv6 address carrying an IPv4 one (mapped, compatible, NAT64, 6to4): refused rather than unpacked.
    if (host.includes('.') || host.startsWith('::ffff:') || host.startsWith('64:ff9b:') || host.startsWith('2002:')) return true
    return false
  }
  return false
}

/** Whether the update download may make this request. */
export function updateRequestAllowed(address: string): boolean {
  let url: URL
  try { url = new URL(address) } catch { return false }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false
  return !isLocalHost(hostOf(url))
}

type WebRequestSession = {
  webRequest: { onBeforeRequest(listener: (details: { url: string }, callback: (response: { cancel?: boolean }) => void) => void): void }
}

/** Puts the rule on the session before its first use. */
export function installUpdateDownloadFilter(session: WebRequestSession, log: (message: string) => void): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = updateRequestAllowed(details.url)
    if (!allowed) log(`refused an update download request to ${(() => { try { return new URL(details.url).host } catch { return 'an unreadable address' } })()}`)
    callback({ cancel: !allowed })
  })
}
