/**
 * The receipt main's preserve operation returns (src/main/preserve-version.ts) and the check a writer
 * makes before it replaces anything: a copy is stored, and its sha256 is the sha256 of the UTF-8 bytes
 * of exactly the text the writer means. Pure apart from Web Crypto (renderer and main both have it).
 */

/** Where the version is kept: a snapshot in History (the Collection's snapshot store, needs the agent), or,
 *  in a synced Collection, a replica version (main/replica-versions.ts; needs no agent). */
export type PreserveReceipt = { store: 'history' | 'replica-versions'; entryId: string; sha256: string }

export type PreserveResult =
  | { kept: true; receipt: PreserveReceipt }
  /** `mismatch`: the file no longer holds that text; `unavailable`: no History to keep it in. Nothing kept. */
  | { kept: false; refused: 'mismatch' | 'unavailable' }

/** sha256 of the UTF-8 bytes of `text`, as lower-case hex. */
export async function sha256OfText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The receipt in `result` when it is one for exactly `text`; null otherwise (no receipt, or another hash). */
export async function receiptFor(result: unknown, text: string): Promise<PreserveReceipt | null> {
  if (!result || typeof result !== 'object' || (result as { kept?: unknown }).kept !== true) return null
  const receipt = (result as { receipt?: unknown }).receipt as PreserveReceipt | undefined
  if (!receipt || typeof receipt !== 'object' || typeof receipt.sha256 !== 'string') return null
  if (receipt.store !== 'history' && receipt.store !== 'replica-versions') return null
  return receipt.sha256 === await sha256OfText(text) ? receipt : null
}
