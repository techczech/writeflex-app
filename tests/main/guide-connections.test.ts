import { expect, test } from 'bun:test'
import { connectionRows, CONNECTION_TEXT, modelAccountRow, voicesRow, zoteroRow } from '../../src/shared/guide-connections'
import { GUIDE_LINKS, isGuideLink, probeZotero } from '../../src/main/guide-connections'
import type { SpeechVoiceInfo } from '../../src/renderer/src/editor/speech-engine'

// The three What it connects to rows (ticket 08): pure functions over injected sources, one test per state.

const voice = (name: string, isDefault = false): SpeechVoiceInfo => ({ uri: name, name, lang: 'en-GB', isDefault })

test('model account: not signed in offers Sign in… and the hint; nothing else works is said', () => {
  const row = modelAccountRow([{ id: 'openai-codex', configured: false }, { id: 'anthropic', configured: false }, { id: 'zai', configured: false }])
  expect(row).toMatchObject({ id: 'model', state: 'off', stateText: 'Not signed in', need: 'Needed for the agent and skills', action: { id: 'sign-in', label: 'Sign in…' } })
  expect(row.without).toBe('Sign in with a ChatGPT plan, or paste a ZAI or Anthropic key.')
})

test('model account: signed in names the account and offers no action', () => {
  expect(modelAccountRow([{ id: 'openai-codex', configured: true }, { id: 'zai', configured: false }])).toMatchObject({ state: 'on', stateText: 'Signed in with ChatGPT', action: null })
  expect(modelAccountRow([{ id: 'zai', configured: true }, { id: 'anthropic', configured: true }]).stateText).toBe('Signed in with a ZAI key and an Anthropic key')
})

test('model account: providers not listed yet is Checking…, with no action', () => {
  expect(modelAccountRow(null)).toMatchObject({ state: 'unknown', stateText: CONNECTION_TEXT.checking, action: null })
})

test('Zotero: found has no action; not found offers Get Zotero and says everything else works', () => {
  expect(zoteroRow(true)).toMatchObject({ state: 'on', stateText: 'Found on this Mac', action: null })
  expect(zoteroRow(false)).toMatchObject({ state: 'off', stateText: 'Not found', without: 'Without it, everything else works.', action: { id: 'get-zotero', label: 'Get Zotero' } })
  expect(zoteroRow(null).state).toBe('unknown')
})

test('System voices: counts Enhanced and Premium voices only; none means the default voice only, with the route to install more', () => {
  const two = voicesRow([voice('Daniel', true), voice('Ava (Enhanced)'), voice('Zoe (Premium)'), voice('Fred')])
  expect(two).toMatchObject({ state: 'on', stateText: '2 enhanced voices installed', action: null })
  expect(voicesRow([voice('Ava (Enhanced)')]).stateText).toBe('1 enhanced voice installed')
  const none = voicesRow([voice('Daniel', true), voice('Fred')])
  expect(none).toMatchObject({ state: 'off', stateText: 'Only the default voice', without: 'Better voices are installed in macOS settings.', action: { id: 'voice-settings', label: 'Open voice settings' } })
  expect(voicesRow([]).state).toBe('off')
  expect(voicesRow(null).state).toBe('unknown')
})

test('the three rows come in the topics file order and the functions write nothing (sources are frozen)', () => {
  const providers = Object.freeze([Object.freeze({ id: 'openai-codex', configured: true })])
  const voices = Object.freeze([Object.freeze(voice('Ava (Enhanced)'))])
  expect(connectionRows({ providers, zoteroFound: false, voices }).map((row) => [row.id, row.state])).toEqual([['model', 'on'], ['zotero', 'off'], ['voices', 'on']])
})

test('the Zotero probe reads one path and never throws', () => {
  const asked: string[] = []
  expect(probeZotero({ databasePath: () => '/z/zotero.sqlite', exists: (path) => { asked.push(path); return true } })).toBe(true)
  expect(asked).toEqual(['/z/zotero.sqlite'])
  expect(probeZotero({ databasePath: () => '/z/zotero.sqlite', exists: () => false })).toBe(false)
  expect(probeZotero({ databasePath: () => { throw new Error('no preference file') }, exists: () => true })).toBe(false)
})

test('the renderer names a link; main holds the URL, and only two names are known', () => {
  expect(isGuideLink('zotero-download')).toBe(true)
  expect(isGuideLink('voice-settings')).toBe(true)
  expect(isGuideLink('https://example.com')).toBe(false)
  expect(isGuideLink('toString')).toBe(false)
  expect(Object.keys(GUIDE_LINKS)).toHaveLength(2)
})
