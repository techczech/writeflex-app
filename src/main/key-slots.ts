// Accounts and keys in the Settings window, over the sign-ins and keys WriteFlex already keeps
// (userData/auth.json through BridleAuth, the agent's own credential store). The window sees each slot
// as connected or missing only: no value, no last four characters, no account label, and nothing a
// provider says. A key is handed to BridleAuth and never logged, returned or stored in the settings file.
//
// ChatGPT is a sign-in (an `account` slot): it cannot take a typed key; signing in runs on the Sign in
// page, and Sign out (remove) logs out. The Anthropic and Z.ai slots take API keys.
import { checkSecret, SLOT_MESSAGES, type SecretSlots, type SlotDef, type SlotInfo, type SlotResult } from '@app-patterns/settings-electron'
import { ACCOUNT_SLOTS, SLOT_PROVIDERS, schema } from '../shared/settings-schema'

/** The part of BridleAuth the slots use (status, setApiKey, logout); tests pass a fake. */
export interface AuthLike {
  status(providerId: string): { configured: boolean }
  setApiKey(providerId: string, key: string): void
  logout(providerId: string): void
}

const DEFS: Readonly<Record<string, SlotDef>> = {
  'accounts.anthropic': { id: 'accounts.anthropic', label: 'Anthropic API key', check: (v) => (v.startsWith('sk-ant-') ? null : 'shape'), shapeHint: 'Anthropic keys start with sk-ant-' },
  'accounts.zai': { id: 'accounts.zai', label: 'Z.ai API key' },
}

export class AuthKeySlots implements SecretSlots {
  readonly shapeHints: ReadonlyMap<string, string> = new Map(
    Object.values(DEFS).flatMap((d) => (d.shapeHint ? [[d.id, d.shapeHint] as [string, string]] : [])),
  )

  constructor(private readonly auth: AuthLike, private readonly changed: () => void = () => {}) {}

  list(): SlotInfo[] {
    return Object.keys(SLOT_PROVIDERS).map((id) => {
      const label = schema.def(id)?.label ?? id
      try {
        return { id, label, status: this.auth.status(SLOT_PROVIDERS[id]!).configured ? 'connected' : 'missing' }
      } catch {
        return { id, label, status: 'problem', detail: SLOT_MESSAGES.unreadable }
      }
    })
  }

  set(id: string, value: string): SlotResult {
    const provider = SLOT_PROVIDERS[id]
    const def = DEFS[id]
    if (!provider || !def || ACCOUNT_SLOTS.has(id)) return { ok: false, error: SLOT_MESSAGES.unknown }
    const checked = checkSecret(value, def)
    if (!checked.ok) return checked
    try {
      this.auth.setApiKey(provider, checked.value)
    } catch {
      return { ok: false, error: SLOT_MESSAGES.write }
    }
    this.changed()
    return { ok: true }
  }

  remove(id: string): SlotResult {
    const provider = SLOT_PROVIDERS[id]
    if (!provider) return { ok: false, error: SLOT_MESSAGES.unknown }
    try {
      this.auth.logout(provider)
    } catch {
      return { ok: false, error: SLOT_MESSAGES.remove }
    }
    this.changed()
    return { ok: true }
  }
}
