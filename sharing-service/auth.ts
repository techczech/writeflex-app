// Owner tokens: the author's authority over one share.
//
// Copied from TalkWeaver's worker/auth.ts (owner token for a shared talk): `<base64url JSON>.<HMAC>`,
// HMAC-SHA-256 under the service's own signing key (signing-key.ts), which no computer ever holds.
// The service hands a token out once, when the share is made (`POST /shares`, admin key), and the
// app keeps it in the system keychain. The token is bound to one share id and carries a role of its
// own, so a token for share A never works on share B, and nothing else this service signs can stand
// in for it. No expiry: a share lives as long as the piece.
//
// The reader page never holds a token: nothing in reader-page.ts takes one.

export const OWNER_ROLE = 'share-owner'

export interface OwnerTokenPayload {
  role: typeof OWNER_ROLE
  shareId: string
  iat: number
}

const encoder = new TextEncoder()

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64UrlEncode(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  return atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)))
}

export async function hashSecret(secret: string): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret.trim()))))
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)))
}

export async function createOwnerToken(payload: OwnerTokenPayload, secret: string): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload))
  return `${body}.${await hmac(body, secret)}`
}

/** The payload when `token` is an owner token for `shareId` signed with `secret`; null otherwise. */
export async function verifyOwnerToken(token: string | null, secret: string, shareId: string): Promise<OwnerTokenPayload | null> {
  if (!token) return null
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra !== undefined || !constantTimeEqual(signature, await hmac(body, secret))) return null
  try {
    const payload = JSON.parse(base64UrlDecode(body)) as OwnerTokenPayload
    if (payload.role !== OWNER_ROLE || payload.shareId !== shareId || typeof payload.iat !== 'number') return null
    return payload
  } catch {
    return null
  }
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return difference === 0
}
