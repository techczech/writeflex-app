// Admin keys: one per computer, copied from TalkWeaver's worker/admin-keys.ts.
//
// The service accepts an admin bearer that equals the value of a secret named
// `ADMIN_SECRET_<computer id>`. WriteFlex makes the key when a Mac sets up sharing, adds
// it to the Worker as a secret and keeps it in that Mac's keychain. An admin key can make a share
// (`POST /shares`); it cannot publish to or turn off a share, which takes that share's owner token.
//
// Unlike TalkWeaver there is no legacy `ADMIN_SECRET`: no sharing service predates per-computer keys.
//
// Computer id alphabet: lower-case ASCII letters and digits, 1 to 64 characters. Only a binding
// whose value is a string with something in it besides white space counts; Durable Object
// namespaces never do.
//
// Comparison: the SHA-256 digest of the bearer against the digest of EVERY candidate, each with a
// constant-time equality, with no exit that depends on which candidate matched or whether one did.
import { constantTimeEqual, hashSecret } from './auth.ts'

export const ADMIN_SECRET_PREFIX = 'ADMIN_SECRET_'
const COMPUTER_ID = /^[a-z0-9]{1,64}$/

/** The computer a binding name belongs to, or null when the name is not an admin key's. */
export function computerIdForSecretName(name: string): string | null {
  if (!name.startsWith(ADMIN_SECRET_PREFIX)) return null
  const id = name.slice(ADMIN_SECRET_PREFIX.length)
  return COMPUTER_ID.test(id) ? id : null
}

function adminKeys(env: object): { computerId: string; value: string }[] {
  const keys: { computerId: string; value: string }[] = []
  for (const name of Object.keys(env).sort()) {
    const computerId = computerIdForSecretName(name)
    if (computerId === null) continue
    const value = (env as Record<string, unknown>)[name]
    if (typeof value !== 'string' || value.trim().length === 0) continue
    keys.push({ computerId, value })
  }
  return keys
}

/** The bearer of an `Authorization: Bearer <value>` header, trimmed; null when there is none. */
export function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (header === null) return null
  const match = /^Bearer\s+(.*)$/is.exec(header)
  const value = match ? match[1].trim() : ''
  return value.length > 0 ? value : null
}

/** The computer whose admin key the bearer is, or null. Every candidate is hashed and compared. */
export async function matchAdminKey(presentedBearer: string | null, env: object): Promise<string | null> {
  if (typeof presentedBearer !== 'string' || presentedBearer.trim().length === 0) return null
  const presented = await hashSecret(presentedBearer)
  let matched: string | null = null
  for (const key of adminKeys(env)) {
    const equal = constantTimeEqual(presented, await hashSecret(key.value))
    if (equal && matched === null) matched = key.computerId
  }
  return matched
}
