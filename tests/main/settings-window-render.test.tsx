import { expect, mock, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// @bridle/electron is file-linked with per-file symlinks, so its renderer hook
// would pull bridle's OWN react instance into this test (hooks dispatcher crash
// under renderToStaticMarkup). The static-markup tests don't exercise auth, so
// substitute an inert controller wired to THIS process's react-free state.
void mock.module('@bridle/electron/renderer', () => ({
  useIpcAuthFlow: () => ({
    state: { phase: 'idle' },
    providers: [],
    login: async () => {},
    respond: () => false,
    setApiKey: () => {},
    logout: () => {},
    cancel: () => {},
  }),
}))

import { ModelSettingsRow, SettingsWindow } from '../../src/renderer/src/components/SettingsWindow'
import type { SettingsChangeEntry, SettingsRecord } from '../../src/preload'
import type { SpeechVoiceInfo } from '../../src/renderer/src/editor/speech-engine'

// SettingsWindow reads window.writeflex.auth at RENDER time (the useIpcAuthFlow
// argument) since the Bridle auth migration; renderToStaticMarkup skips effects,
// so an inert transport stub is all the render path needs.
;(globalThis as { window?: unknown }).window = {
  writeflex: {
    auth: {
      providers: async () => [],
      login: async () => {},
      cancel: async () => {},
      respond: async () => false,
      setApiKey: async () => [],
      logout: async () => [],
      subscribe: () => () => {},
    },
    getAgentState: async () => ({ models: [], model: null }),
    onAgentReady: () => () => {},
  },
}

const SPEECH_VOICES: SpeechVoiceInfo[] = [
  { uri: 'alice', name: 'Alice', lang: 'en-GB', isDefault: false },
  { uri: 'samantha', name: 'Samantha', lang: 'en-US', isDefault: true },
  { uri: 'zoe', name: 'Zoe (Enhanced)', lang: 'en-GB', isDefault: false },
  { uri: 'ava', name: 'Ava (Premium)', lang: 'en-US', isDefault: false },
]

function renderSettings(
  values: SettingsRecord = {},
  changelog: SettingsChangeEntry[] = [],
  initialSection?: string,
  getStarted?: { removed: boolean; canRestore: boolean },
): string {
  return renderToStaticMarkup(
    <SettingsWindow
      values={values}
      changelog={changelog}
      voices={SPEECH_VOICES}
      selectedVoiceURI={typeof values['readAloud.voiceURI'] === 'string' ? values['readAloud.voiceURI'] : null}
      initialSection={initialSection}
      onSet={() => {}}
      onRevert={() => {}}
      typewriterOn={false}
      workspaceName="Notes"
      onFlash={() => {}}
      onClose={() => {}}
      getStarted={getStarted}
    />,
  )
}

test('Settings → Get started, as drawn in state 32: the row, its two buttons after removal, and its place in the list', () => {
  const section = (html: string): string => html.slice(html.indexOf('id="sec-get-started"'), html.indexOf('id="sec-shortcuts"'))
  const removed = section(renderSettings({}, [], undefined, { removed: true, canRestore: true }))
  expect(removed).toContain('<h3>Get started</h3>')
  expect(removed).toContain('<span class="lbl">Get started</span><small>The example was removed</small>')
  expect(removed).toMatch(/data-action="restore-example">Show the example on the start screen again<\/button><button type="button" class="btn" data-action="open-guide">Open the Guide<\/button>/)
  // While the example is shown there is nothing to bring back: the Guide button alone, and no "removed" line.
  const shown = section(renderSettings({}, [], undefined, { removed: false, canRestore: false }))
  expect(shown).not.toContain('The example was removed')
  expect(shown).not.toContain('Show the example on the start screen again')
  expect(shown).toContain('Open the Guide')
  // A first run that never finished can be brought back too, without saying it was removed.
  const unfinished = section(renderSettings({}, [], undefined, { removed: false, canRestore: true }))
  expect(unfinished).not.toContain('The example was removed')
  expect(unfinished).toContain('Show the example on the start screen again')
  // Between Changelog and Shortcuts in the list on the left.
  const nav = renderSettings()
  expect(nav.indexOf('>Changelog<')).toBeLessThan(nav.indexOf('>Get started<'))
  expect(nav.indexOf('>Get started<')).toBeLessThan(nav.indexOf('>Shortcuts<'))
  expect(section(nav)).not.toMatch(/hide/i)
})

test('Read aloud settings show featured voices first, hide the rest, and expose the full speed range directly', () => {
  const html = renderSettings()

  expect(html).toContain('id="sec-read-aloud"')
  expect(html).toContain('>Read aloud</')
  expect(html).toContain('Ava (Premium)')
  expect(html).toContain('Zoe (Enhanced)')
  expect(html).toContain('Samantha')
  expect(html).not.toContain('>Alice</span>')
  expect(html).toContain('Premium')
  expect(html).toContain('Enhanced')
  expect(html).toContain('Default')
  expect(html).toContain('Show all voices')
  expect(html).toContain('aria-label="Default speed"')
  expect(html).toContain('<option value="1.0" selected="">1.0×</option>')
  expect(html).toContain('aria-label="Reading scroll"')
  expect(html).toContain('<option value="typewriter" selected="">Typewriter</option>')
  expect(html).toContain('<option value="page">Page</option>')

  const speedSelect = html.match(/<select aria-label="Default speed"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? ''
  expect(speedSelect.match(/<option/g)?.length).toBe(21)
  expect(speedSelect).toContain('<option value="0.5">0.5×</option>')
  expect(speedSelect).toContain('<option value="2.5">2.5×</option>')
})

test('Read aloud can be the initial Settings section when opened from the transport bar', () => {
  const html = renderSettings({}, [], 'sec-read-aloud')
  expect(html).toMatch(/aria-current="true"[^>]*>[\s\S]*?Read aloud<\/button>/)
})

test('the shortcut ledger groups commands in the stable user-task order', () => {
  const html = renderSettings({}, [], 'sec-shortcuts')
  const heading = (name: string): number => html.indexOf(`<h4 class="kl-group-title">${name}</h4>`)
  const listen = heading('Listen')
  const review = heading('Review and versions')

  expect(heading('Write')).toBeGreaterThanOrEqual(0)
  expect(listen).toBeGreaterThan(heading('Stay focused'))
  expect(review).toBeGreaterThan(listen)
  expect(html.slice(listen, review)).toContain('Next sentence')
  // Only task groups head the ledger: none of the old twelve names survives as a heading.
  const headings = [...html.matchAll(/<h4 class="kl-group-title">([^<]*)<\/h4>/g)].map((match) => match[1])
  const order = ['Write', 'Shape the document', 'Stay focused', 'Listen', 'Review and versions', 'Find and manage files', 'Collect and plan', 'Work with the agent', 'Share and export', 'Set up WriteFlex']
  expect(headings.every((name) => order.includes(name!))).toBe(true)
  expect(headings.map((name) => order.indexOf(name!))).toEqual([...headings.map((name) => order.indexOf(name!))].sort((a, b) => a - b))
})

test('voice and default-speed changes use readable changelog values with per-entry Reset', () => {
  const html = renderSettings(
    { 'readAloud.voiceURI': 'ava', 'readAloud.rate': 1.6 },
    [
      {
        key: 'readAloud.rate',
        label: 'Default speed',
        old: null,
        new: 1.6,
        at: Date.now(),
      },
      {
        key: 'readAloud.voiceURI',
        label: 'Voice',
        old: null,
        new: 'ava',
        at: Date.now(),
      },
    ],
  )

  expect(html).toContain('<span class="log-old">1.0×</span> → <span class="log-new">1.6×</span>')
  expect(html).toContain('<span class="log-old">System default</span> → <span class="log-new">Ava (Premium)</span>')
  expect(html).toContain('Reset Default speed to 1.0×')
  expect(html).toContain('Reset Voice to System default')
})

test('reading-scroll changes use Typewriter as the default and have a readable per-entry Reset', () => {
  const html = renderSettings(
    { 'readAloud.scrollMode': 'page' },
    [{
      key: 'readAloud.scrollMode',
      label: 'Reading scroll',
      old: null,
      new: 'page',
      at: Date.now(),
    }],
  )

  expect(html).toContain('<span class="log-old">Typewriter</span> → <span class="log-new">Page</span>')
  expect(html).toContain('Reset Reading scroll to Typewriter')
})

test('browser-link setting is visible and defaults on unless explicitly disabled', () => {
  const defaultHtml = renderSettings()
  expect(defaultHtml).toContain('Open files from browser links')
  expect(defaultHtml).toMatch(/aria-label="Open files from browser links" checked=""/)

  const disabledHtml = renderSettings({ 'integration.browserLinks': false })
  expect(disabledHtml).toContain('aria-label="Open files from browser links"')
  expect(disabledHtml).not.toMatch(/aria-label="Open files from browser links" checked=""/)
})

test('browser-link changes use the existing changelog row with a per-entry Reset', () => {
  const html = renderSettings(
    { 'integration.browserLinks': false },
    [{
      key: 'integration.browserLinks',
      label: 'Open files from browser links',
      old: null,
      new: false,
      at: Date.now(),
    }],
  )
  expect(html).toContain('Reset Open files from browser links to On')
})

test('external-change watching is searchable, defaults on, and has changelog Reset support', () => {
  const defaultHtml = renderSettings()
  expect(defaultHtml).toContain('Watch for external changes')
  expect(defaultHtml).toMatch(/aria-label="Watch for external changes" checked=""/)

  const disabledHtml = renderSettings(
    { 'workspace.watchExternalChanges': false },
    [{
      key: 'workspace.watchExternalChanges',
      label: 'Watch for external changes',
      old: null,
      new: false,
      at: Date.now(),
    }],
  )
  expect(disabledHtml).not.toMatch(/aria-label="Watch for external changes" checked=""/)
  expect(disabledHtml).toContain('Reset Watch for external changes to On')
})

test('an unconfigured selected OAuth model warns in amber, named from the static catalogue, without resetting the selection', () => {
  const html = renderToStaticMarkup(
    <ModelSettingsRow
      selectedModel="openai-codex::gpt-5.5"
      models={[]}
      catalogue={[{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }]}
      providers={[{ id: 'openai-codex', configured: false, authLanes: ['oauth'] }]}
      onChange={() => {}}
      onStartLogin={() => {}}
      onSetKeyEntry={() => {}}
    />,
  )

  expect(html).toContain('crow amber-model')
  expect(html).toContain('GPT-5.5 — ChatGPT is signed out, so this model can&#x27;t run.')
  expect(html).toContain('>Sign in</button>')
  expect(html).toMatch(/<option value="openai-codex::gpt-5\.5" selected="">GPT-5\.5<\/option>/)
})

test('a configured selected model keeps the healthy row unchanged', () => {
  const html = renderToStaticMarkup(
    <ModelSettingsRow
      selectedModel="openai-codex::gpt-5.5"
      models={[{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }]}
      catalogue={[{ provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' }]}
      providers={[{ id: 'openai-codex', configured: true, authLanes: ['oauth'] }]}
      onChange={() => {}}
      onStartLogin={() => {}}
      onSetKeyEntry={() => {}}
    />,
  )

  expect(html).toContain('Used for suggestions and housekeeping')
  expect(html).not.toContain('amber-model')
  expect(html).not.toContain('>Sign in</button>')
})

test('Account & Model includes a searchable default reasoning row using Bridle vocabulary', () => {
  const html = renderSettings({ 'agent.thinkingLevel': 'high' })
  expect(html).toContain('Default reasoning level')
  expect(html).toContain('aria-label="Default reasoning level"')
  for (const level of ['minimal', 'low', 'medium', 'high']) expect(html).toContain(`value="${level}"`)
  expect(html).not.toContain('Maximum')
})

test('Settings never claims that model defaults come from another tool', () => {
  const html = renderSettings()
  expect(html).not.toContain('~/.codex')
  expect(html).not.toContain('Codex configuration')
})

test('an unconfigured key-only model names the missing key and offers Add key', () => {
  const html = renderToStaticMarkup(
    <ModelSettingsRow
      selectedModel="zai::glm-4.7"
      models={[]}
      catalogue={[{ provider: 'zai', id: 'glm-4.7', name: 'GLM-4.7' }]}
      providers={[{ id: 'zai', configured: false, authLanes: ['apikey'] }]}
      onChange={() => {}}
      onStartLogin={() => {}}
      onSetKeyEntry={() => {}}
    />,
  )

  expect(html).toContain('GLM-4.7 — ZAI has no key, so this model can&#x27;t run.')
  expect(html).toContain('>Add key</button>')
  expect(html).not.toContain('>Sign in</button>')
})

test('a selected model missing from the catalogue remains visible by its raw id', () => {
  const html = renderToStaticMarkup(
    <ModelSettingsRow
      selectedModel="openai-codex::retired-model"
      models={[]}
      catalogue={[]}
      providers={[{ id: 'openai-codex', configured: false, authLanes: ['oauth'] }]}
      onChange={() => {}}
      onStartLogin={() => {}}
      onSetKeyEntry={() => {}}
    />,
  )

  expect(html).toContain("retired-model — ChatGPT is signed out, so this model can&#x27;t run.")
  expect(html).toMatch(/<option value="openai-codex::retired-model" selected="">retired-model<\/option>/)
})

test('the picker lists ONLY runnable models; a signed-out selection survives as a named amber synthetic', () => {
  const html = renderToStaticMarkup(
    <ModelSettingsRow
      selectedModel="openai-codex::gpt-5.5"
      models={[{ provider: 'zai', id: 'glm-4.7', name: 'GLM-4.7' }]}
      catalogue={[
        { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
        { provider: 'openai-codex', id: 'gpt-5.4', name: 'GPT-5.4' },
        { provider: 'zai', id: 'glm-4.7', name: 'GLM-4.7' },
      ]}
      providers={[
        { id: 'openai-codex', configured: false, authLanes: ['oauth'] },
        { id: 'zai', configured: true, authLanes: ['apikey'] },
      ]}
      onChange={() => {}}
      onStartLogin={() => {}}
      onSetKeyEntry={() => {}}
    />,
  )
  // usability review verdict (skills-recheck-071): options = what the user can RUN (zai here) plus the
  // stored signed-out selection as a NAMED synthetic — never other phantom catalogue entries.
  expect(html).toMatch(/<option value="openai-codex::gpt-5\.5" selected="">GPT-5\.5<\/option>/)
  expect(html).toContain('<option value="zai::glm-4.7">GLM-4.7</option>')
  expect(html).not.toContain('GPT-5.4')
  expect(html).toContain('crow amber-model')
})

test('the fixed line has presets in Settings → Editor, with Custom showing the dragged percentage', () => {
  const unset = renderSettings()
  expect(unset).toContain('aria-label="Fixed line position"')
  expect(unset).toMatch(/aria-pressed="true"[^>]*>Top third</)
  expect(unset).toContain('>Middle<')
  expect(unset).toContain('>Lower third<')

  const dragged = renderSettings({ 'editor.fixedLine': 0.31 })
  expect(dragged).toContain('>Custom 31%<')
  expect(dragged).toMatch(/aria-pressed="true"[^>]*>Custom 31%</)

  const lower = renderSettings({ 'editor.fixedLine': 0.67 })
  expect(lower).toMatch(/aria-pressed="true"[^>]*>Lower third</)
})

test('a fixed-line change reads in the changelog with its preset name and a Reset to Top third', () => {
  const html = renderSettings(
    { 'editor.fixedLine': 0.5 },
    [{ key: 'editor.fixedLine', label: 'Fixed line position', old: null, new: 0.5, at: Date.now() }],
  )
  expect(html).toContain('<span class="log-old">Top third</span> → <span class="log-new">Middle</span>')
  expect(html).toContain('Reset Fixed line position to Top third')
})

test('Settings → Editor has the read-aloud highlight swatches, Strength and a preview that follows the choice and theme', () => {
  const unset = renderSettings()
  expect(unset).toContain('aria-label="Read-aloud highlight colour"')
  for (const label of ['Terracotta', 'Amber', 'Green', 'Blue', 'Lilac', 'Grey', 'Custom…']) expect(unset).toContain(label)
  expect(unset).toMatch(/data-colour="terracotta"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-colour="terracotta"/)
  expect(unset).toMatch(/aria-pressed="true"[^>]*>Medium</)
  expect(unset).toContain('data-testid="read-aloud-highlight-preview"')
  expect(unset).toContain('--ra-word:rgba(196, 98, 66, 0.38)')

  const blueStrongDark = renderSettings({ 'readAloud.colour': 'blue', 'readAloud.strength': 'strong', 'appearance.theme': 'dark' })
  expect(blueStrongDark).toMatch(/aria-pressed="true"[^>]*>Strong</)
  expect(blueStrongDark).toContain('--ra-hue:rgb(92 150 255)')
  expect(blueStrongDark).toContain('cheekbone')

  const custom = renderSettings({ 'readAloud.colour': '#40a080' })
  expect(custom).toMatch(/data-colour="custom"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-colour="custom"/)
  expect(custom).toContain('--ra-hue:rgb(64 160 128)')
})

test('a highlight change reads in the changelog with the colour name and a Reset to Terracotta', () => {
  const html = renderSettings(
    { 'readAloud.colour': 'blue' },
    [{ key: 'readAloud.colour', label: 'Read-aloud highlight', old: null, new: 'blue', at: Date.now() }],
  )
  expect(html).toContain('<span class="log-old">Terracotta</span> → <span class="log-new">Blue</span>')
  expect(html).toContain('Reset Read-aloud highlight to Terracotta')
})

test('"Show where I am in the status bar" defaults on, reads as drawn, is searchable and can be reset', () => {
  const defaultHtml = renderSettings()
  expect(defaultHtml).toContain('<span class="lbl">Show where I am in the status bar</span>')
  expect(defaultHtml).toMatch(/aria-label="Show where I am in the status bar" checked=""/)
  // The second line is what the chip reads on a heading (state 32), from the live command list.
  expect(defaultHtml).toMatch(/<small>On a heading · \d+ actions ⌘K<\/small>/)
  // The row lives in Settings → Get started (state 32), and nowhere else.
  const getStarted = defaultHtml.slice(defaultHtml.indexOf('id="sec-get-started"'), defaultHtml.indexOf('id="sec-shortcuts"'))
  expect(getStarted).toContain('Show where I am in the status bar')
  expect(defaultHtml.split('<span class="lbl">Show where I am in the status bar</span>')).toHaveLength(2)
  const appearance = defaultHtml.slice(defaultHtml.indexOf('id="sec-appearance"'), defaultHtml.indexOf('id="sec-action-bar"'))
  expect(appearance).not.toContain('Show where I am in the status bar')

  const offHtml = renderSettings(
    { 'statusBar.showPlace': false },
    [{ key: 'statusBar.showPlace', label: 'Show where I am in the status bar', old: null, new: false, at: Date.now() }],
  )
  expect(offHtml).not.toMatch(/aria-label="Show where I am in the status bar" checked=""/)
  expect(offHtml).toContain('Reset Show where I am in the status bar to On')
})
