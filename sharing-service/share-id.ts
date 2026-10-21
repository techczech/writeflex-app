// The share id: the secret part of a reader's link (`/s/<share id>`). The
// address is long and unguessable.
//
// 22 characters from the 62 letters and digits, each drawn uniformly from the system's
// cryptographic random source (rejection sampling, so no character is likelier than another):
// 62^22 ≈ 2^130.99 possible ids: just under 131 bits of entropy. A reader who knows one link learns
// nothing about any other.
//
// No imports: the app may read this file too (the reader address it shows is built from the id).
export const SHARE_ID_LENGTH = 22
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const SHARE_ID_SOURCE = `[A-Za-z0-9]{${SHARE_ID_LENGTH}}`
const SHARE_ID = new RegExp(`^${SHARE_ID_SOURCE}$`)
/** log2(62^22), rounded down: what the report and the tests state. */
export const SHARE_ID_ENTROPY_BITS = Math.floor(SHARE_ID_LENGTH * Math.log2(ALPHABET.length))

export function isShareId(value: unknown): value is string {
  return typeof value === 'string' && SHARE_ID.test(value)
}

/**
 * A new share id. `randomBytes` is for tests only. Bytes 248–255 are thrown away (248 = 4 × 62), so
 * every character is one of 62 with equal chance.
 */
export function generateShareId(randomBytes: (length: number) => Uint8Array = (length) => crypto.getRandomValues(new Uint8Array(length))): string {
  let id = ''
  while (id.length < SHARE_ID_LENGTH) {
    for (const byte of randomBytes(32)) {
      if (byte >= 248) continue
      id += ALPHABET[byte % 62]
      if (id.length === SHARE_ID_LENGTH) break
    }
  }
  return id
}
