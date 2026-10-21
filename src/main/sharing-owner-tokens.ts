// Each link's owner token, in the secrets store (slot `sharing-links`, Keychain), never in a record, a
// view, a log or an error (sharing ticket 03; split from sharing-publisher.ts in ticket 04).
//
// No Electron import.
import type { SecretsStore } from './secrets-store'

const TOKENS_FORMAT = 1

export function ownerTokens(secrets: SecretsStore) {
  function tokens(): Record<string, string> {
    const text = secrets.read('sharing-links')
    if (text === null) return {}
    const parsed = JSON.parse(text) as { format?: unknown; tokens?: unknown }
    if (parsed?.format !== TOKENS_FORMAT || !parsed.tokens || typeof parsed.tokens !== 'object') throw new Error('tokens-unreadable')
    return Object.fromEntries(Object.entries(parsed.tokens as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
  function tokenFor(shareId: string): string | null {
    try { return tokens()[shareId] ?? null } catch { return null }
  }
  /** The links that have a token; null when the store cannot be read just now (a Keychain failure), never "none". */
  function heldTokenIds(): string[] | null {
    try { return Object.keys(tokens()) } catch { return null }
  }
  function forgetToken(shareId: string): void {
    try {
      const { [shareId]: _gone, ...rest } = tokens()
      secrets.write('sharing-links', JSON.stringify({ format: TOKENS_FORMAT, tokens: rest }))
    } catch { /* the link is down at the service; a key left behind opens nothing */ }
  }
  function keepToken(shareId: string, token: string): boolean {
    try {
      secrets.write('sharing-links', JSON.stringify({ format: TOKENS_FORMAT, tokens: { ...tokens(), [shareId]: token } }))
      return tokenFor(shareId) === token
    } catch { return false }
  }
  return { tokenFor, heldTokenIds, forgetToken, keepToken }
}
