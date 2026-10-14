const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function safeCodePoint(value: number): string {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '�'
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name: string) => ENTITIES[name.toLowerCase()] ?? match)
}

export function extractTitle(html: string): string | null {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
  if (!raw) return null
  const title = decodeEntities(raw).replace(/\s+/g, ' ').trim().slice(0, 200)
  return title || null
}

const PRIVATE_HOST =
  /^(localhost|.+\.local|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*\]?|\[?fe80:.*\]?)$/i

function isBlockedHost(hostname: string): boolean {
  return PRIVATE_HOST.test(hostname)
}

/**
 * Re-validates a `Location` header against the same scheme/host rules applied to the initial URL.
 * A server could otherwise redirect a first, allowed hop to an internal address (SSRF); every hop
 * must be checked independently, not just the URL the caller originally supplied. Returns null for
 * a malformed location, a non-http(s) scheme, or a blocked (private/link-local/.local) host.
 */
export function validateRedirectTarget(location: string, current: URL): URL | null {
  // Reject malformed percent-encoding up front: the WHATWG URL parser resolves almost anything
  // against a base (it just percent-encodes stray `%` into a same-origin path), so a garbage
  // header would otherwise silently become a "valid" same-origin redirect instead of being refused.
  try { decodeURIComponent(location) } catch { return null }
  let next: URL
  try { next = new URL(location, current) } catch { return null }
  if (next.protocol !== 'http:' && next.protocol !== 'https:') return null
  if (isBlockedHost(next.hostname)) return null
  return next
}

export async function fetchLinkTitle(url: string, timeoutMs = 5000): Promise<string | null> {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (isBlockedHost(parsed.hostname)) return null
  try {
    let current = parsed
    for (let hop = 0; hop < 4; hop += 1) {
      const response = await fetch(current, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
        headers: { accept: 'text/html', 'user-agent': 'WriteFlex/0.2 (link title fetch)' }
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) return null
        const next = validateRedirectTarget(location, current)
        if (!next) return null
        current = next
        continue
      }
      if (!response.ok) return null
      const type = response.headers.get('content-type') ?? ''
      if (!type.includes('text/html') && !type.includes('application/xhtml')) return null
      return extractTitle(await response.text())
    }
    return null
  } catch {
    return null
  }
}
