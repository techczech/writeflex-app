import React from 'react'
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptyState, formatValue, type SettingsState } from '@app-patterns/settings'
import { SettingsWindow } from '@app-patterns/settings-react'
import { registry, MENUS } from '../../src/shared/bridle-commands'
import { ModelChoices, VoiceChoices } from '../../src/renderer/src/settings-pages'
import { settingsDisplaySchema, settingsShortcutDisplay } from '../../src/renderer/src/settings-display'
import { APP_KEYS_SETTING } from '../../src/shared/keymap-overrides'
import { currentPages } from '../../src/renderer/src/settings-current-pages'
const noop = () => {}
const voices = [
  { uri: 'ordinary', name: 'A plain voice', lang: 'en-GB', isDefault: false },
  { uri: 'default', name: 'System choice', lang: 'en-GB', isDefault: true },
  { uri: 'enhanced', name: 'Zoe (Enhanced)', lang: 'en-GB', isDefault: false },
]
test('J: model picker lists the runnable inventory and retains a missing selection by raw id', () => {
  const html = renderToStaticMarkup(<ModelChoices selected="missing::old-id" onChoose={noop} models={[{ provider: 'anthropic', id: 'ready', name: 'Runnable model' }]} />)
  expect(html).toContain('Runnable model (Anthropic)')
  expect(html).toContain('value="missing::old-id" selected=""')
  expect(html).toContain('missing::old-id</option>')
  expect((html.match(/<option/g) ?? []).length).toBe(2)
})
test('J/H: zero runnable models still display the missing saved model', () => {
  const html = renderToStaticMarkup(<ModelChoices selected="missing::old-id" onChoose={noop} models={[]} />)
  expect(html).toContain('missing::old-id</option>')
  expect(html).toContain('selected=""')
})
test('J: featured voices precede ordinary voices', () => {
  const html = renderToStaticMarkup(<VoiceChoices voices={voices} stored="default" onChoose={noop} />)
  expect(html.indexOf('Zoe (Enhanced)')).toBeLessThan(html.indexOf('System choice'))
  expect(html.indexOf('System choice')).toBeLessThan(html.indexOf('A plain voice'))
  expect(html).toContain('value="default" selected=""')
})
test('H: an unavailable voice has an explicit selected fallback, never System voice', () => {
  const html = renderToStaticMarkup(<VoiceChoices voices={voices} stored="missing-voice" onChoose={noop} />)
  expect(html).toContain('value="missing-voice" selected=""')
  expect(html).toContain('missing-voice (unavailable)')
  expect(html).not.toContain('value="" selected=""')
})
test('J: fixed-line presets and custom fractions keep readable choice labels', () => {
  const state = { ...emptyState('writeflex'), settings: { 'editor.fixedLine': 0.42 } }
  const schema = settingsDisplaySchema(state, voices)
  const def = schema.def('editor.fixedLine')!
  expect(def.options?.map(o => o.value)).toEqual([0.33, 0.5, 0.67, 0.42])
  expect(formatValue(def, 0.33)).toBe('Top third')
  expect(formatValue(def, 0.5)).toBe('Middle')
  expect(formatValue(def, 0.67)).toBe('Lower third')
  expect(formatValue(def, 0.42)).toMatch(/42/)
})
test('J: the shared Changes renderer uses readable voice, highlight and fixed-line labels', () => {
  const state: SettingsState = { ...emptyState('writeflex'), settings: {}, changes: [
    { id: 'v', key: 'readAloud.voiceURI', from: '', to: 'enhanced', at: 3, who: { kind: 'you' } },
    { id: 'c', key: 'readAloud.colour', from: 'terracotta', to: 'blue', at: 2, who: { kind: 'you' } },
    { id: 'f', key: 'editor.fixedLine', from: 0.33, to: 0.5, at: 1, who: { kind: 'you' } },
  ] }
  const schema = settingsDisplaySchema(state, voices)
  const actions = Object.fromEntries(['set', 'rebind', 'rebindMany', 'reset', 'resetSection', 'resetAll', 'resetEntry', 'undoBatch', 'exportSettings', 'importPick', 'applyImport', 'putSecret', 'removeSecret'].map(key => [key, () => ({ ok: true })])) as any
  const html = renderToStaticMarkup(<SettingsWindow schema={schema} state={state} appInfo={{ name: 'WriteFlex', version: 'test', cli: 'writeflex' }} registry={registry} menus={MENUS} actions={actions} initial={{ section: 'changes' }} />)
  for (const label of ['System voice', 'Zoe (Enhanced)', 'terracotta', 'blue', 'Top third', 'Middle']) expect(html).toContain(label)
})
test('J: retained custom Settings pages include Backup context and current update controls', () => {
  const view = { state: emptyState('writeflex') } as any
  const pages = currentPages(view, noop)
  expect(pages.map(page => page.id)).toEqual(['updates', 'backup', 'sharing', 'scratchpad', 'command-line'])
  const html = renderToStaticMarkup(<>{pages.find(page => page.id === 'backup')!.render()}</>)
  expect(html).toContain('Vault:')
  expect(html).toContain('Open a vault, then reopen Settings to change its backup.')
})

test('J: highlight changes keep readable preset/hex text and preserve custom-colour editing', () => {
  const def = settingsDisplaySchema(emptyState('writeflex'), []).def('readAloud.colour')!
  expect(def.type).toBe('text')
  expect(formatValue(def, 'blue')).toBe('blue')
  expect(formatValue(def, '#c46242')).toBe('#c46242')
})

test('follow-up: Shortcuts displays migrated bare/scoped keys with row resets and Reset all even without shared keys', () => {
  const state = { ...emptyState('writeflex'), settings: { [APP_KEYS_SETTING]: JSON.stringify({ 'view.typewriter': 'X', 'plan.addPart': 'Y', 'plan.adoptPart': '' }) } }
  const display = settingsShortcutDisplay(state)
  const html = renderToStaticMarkup(<SettingsWindow schema={settingsDisplaySchema(state, [])} {...display} appInfo={{ name: 'WriteFlex', version: 'test' }} actions={{} as any} initial={{ section: 'shortcuts' }} />)
  for (const [id, chord] of [['view.typewriter', 'X'], ['plan.add-part', 'Y'], ['plan.adopt-part', 'None']]) {
    const marker = `data-command="${id}"`
    expect(html.indexOf(marker)).toBeGreaterThan(-1)
    const row = html.slice(html.indexOf(marker) + marker.length).split('data-command=')[0]
    expect(row).toContain('Changed')
    expect(row).toContain('>Reset</button>')
    expect(row).toContain(`>${chord}<`)
  }
  expect(html).toContain('Reset all')
  expect(html).toContain('3 changed')
  expect(state.keys).toEqual({}) // display projection never becomes persisted state
})

test('follow-up: choice options exclude historical custom fractions and unavailable voices', () => {
  const state: SettingsState = { ...emptyState('writeflex'), settings: { 'editor.fixedLine': 0.43, 'readAloud.voiceURI': 'current-missing' }, changes: [
    { id: 'f', key: 'editor.fixedLine', from: 0.42, to: 0.43, at: 1, who: { kind: 'you' } },
    { id: 'v', key: 'readAloud.voiceURI', from: 'old-missing', to: 'current-missing', at: 1, who: { kind: 'you' } },
  ] }
  const display = settingsDisplaySchema(state, voices)
  expect(display.def('editor.fixedLine')!.options?.map(o => o.value)).toEqual([0.33, 0.5, 0.67, 0.43])
  expect(display.def('readAloud.voiceURI')!.options?.map(o => o.value)).toEqual(['', 'enhanced', 'default', 'ordinary', 'current-missing'])
  const reset = settingsDisplaySchema({ ...state, settings: {} }, voices)
  expect(reset.def('editor.fixedLine')!.options?.map(o => o.value)).toEqual([0.33, 0.5, 0.67])
  expect(reset.def('readAloud.voiceURI')!.options?.map(o => o.value)).toEqual(['', 'enhanced', 'default', 'ordinary'])
})

test('follow-up: shortcut display preserves shared-key precedence and the recorder validation rules', () => {
  const state = { ...emptyState('writeflex'), settings: { [APP_KEYS_SETTING]: JSON.stringify({ 'view.typewriter': 'X' }) }, keys: { 'view.typewriter': '⌘⌥T' } }
  const display = settingsShortcutDisplay(state)
  expect(display.state.keys['view.typewriter']).toBe('⌘⌥T')
  const resolved = display.registry.resolveBindings(display.state.keys)
  expect(resolved.bindings['view.typewriter']).toBe('⌘⌥T')
  expect(display.registry.checkRebind(resolved.bindings, 'view.typewriter', 'Y').kind).toBe('bare')
  expect(display.registry.resolveBindings({ 'view.typewriter': 'Y' }).rejected).toHaveLength(1)
  expect(registry.resolveBindings({ 'view.typewriter': 'X' }).rejected).toHaveLength(1)
})
