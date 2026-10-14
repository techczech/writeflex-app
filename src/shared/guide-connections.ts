// What it connects to (ADR-0043, ticket 08; mockup-onboarding-hifi-v2 states 13, 15, 16): three rows whose
// state is read from this machine. Each is a pure function over an injected source, so each state is a unit
// test; they only describe, they write nothing. The sources: the agent's provider list (the auth flow's
// `configured` flags), whether Zotero's database is on this Mac (main's probe), the speech voice list.
import type { SpeechVoiceInfo } from '../renderer/src/editor/speech-engine'
import { voiceBadges } from '../renderer/src/editor/speech-engine'

export type ConnectionId = 'model' | 'zotero' | 'voices'
/** `unknown`: the source has not answered yet; the row says so and offers nothing. */
export type ConnectionState = 'on' | 'off' | 'unknown'
export type ConnectionActionId = 'sign-in' | 'get-zotero' | 'voice-settings'
export type ConnectionRow = {
  id: ConnectionId
  /** The topic title, verbatim from the topics file. */
  name: string
  state: ConnectionState
  stateText: string
  /** "Needed for …" */
  need: string
  /** The line under a missing connection: what still works, or the hint for the action. */
  without: string
  action: { id: ConnectionActionId; label: string } | null
}

export const CONNECTION_TEXT = {
  bar: 'What it connects to',
  checking: 'Checking…',
  model: {
    name: 'A model account for the agent.',
    need: 'Needed for the agent and skills',
    without: 'Without it, everything else works.',
    hint: 'Sign in with a ChatGPT plan, or paste a ZAI or Anthropic key.',
    off: 'Not signed in',
    action: 'Sign in…',
  },
  zotero: { name: 'Zotero.', need: 'Needed for Reading Room, citations, highlights', without: 'Without it, everything else works.', on: 'Found on this Mac', off: 'Not found', action: 'Get Zotero' },
  voices: {
    name: 'System voices.',
    need: 'Needed for read aloud quality',
    without: 'Better voices are installed in macOS settings.',
    off: 'Only the default voice',
    action: 'Open voice settings',
    on: (n: number): string => `${n} enhanced ${n === 1 ? 'voice' : 'voices'} installed`,
  },
} as const

const PROVIDER_LABEL: Record<string, string> = { 'openai-codex': 'ChatGPT', anthropic: 'an Anthropic key', zai: 'a ZAI key' }

export type AgentProvider = { id: string; configured: boolean }

/** `providers` null: the auth flow has not listed them yet. */
export function modelAccountRow(providers: readonly AgentProvider[] | null): ConnectionRow {
  const T = CONNECTION_TEXT.model
  const base = { id: 'model', name: T.name, need: T.need } as const
  if (providers === null) return { ...base, state: 'unknown', stateText: CONNECTION_TEXT.checking, without: '', action: null }
  const signedIn = providers.filter((provider) => provider.configured)
  if (signedIn.length === 0) return { ...base, state: 'off', stateText: T.off, without: T.hint, action: { id: 'sign-in', label: T.action } }
  const labels = signedIn.map((provider) => PROVIDER_LABEL[provider.id] ?? provider.id)
  return { ...base, state: 'on', stateText: `Signed in with ${labels.join(' and ')}`, without: '', action: null }
}

/** `found` null: main has not answered yet. */
export function zoteroRow(found: boolean | null): ConnectionRow {
  const T = CONNECTION_TEXT.zotero
  const base = { id: 'zotero', name: T.name, need: T.need } as const
  if (found === null) return { ...base, state: 'unknown', stateText: CONNECTION_TEXT.checking, without: '', action: null }
  return found
    ? { ...base, state: 'on', stateText: T.on, without: '', action: null }
    : { ...base, state: 'off', stateText: T.off, without: T.without, action: { id: 'get-zotero', label: T.action } }
}

/** Enhanced and Premium voices are the ones that count: the default voice is always there. `voices` null: the list has not loaded yet; an empty list is a Mac with no extra voices. */
export function voicesRow(voices: readonly SpeechVoiceInfo[] | null): ConnectionRow {
  const T = CONNECTION_TEXT.voices
  const base = { id: 'voices', name: T.name, need: T.need } as const
  if (voices === null) return { ...base, state: 'unknown', stateText: CONNECTION_TEXT.checking, without: '', action: null }
  const enhanced = voices.filter((voice) => { const badges = voiceBadges(voice); return badges.includes('Premium') || badges.includes('Enhanced') }).length
  return enhanced > 0
    ? { ...base, state: 'on', stateText: T.on(enhanced), without: '', action: null }
    : { ...base, state: 'off', stateText: T.off, without: T.without, action: { id: 'voice-settings', label: T.action } }
}

export type ConnectionSources = { providers: readonly AgentProvider[] | null; zoteroFound: boolean | null; voices: readonly SpeechVoiceInfo[] | null }
export const connectionRows = (sources: ConnectionSources): ConnectionRow[] => [modelAccountRow(sources.providers), zoteroRow(sources.zoteroFound), voicesRow(sources.voices)]
