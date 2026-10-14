import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgentModelOptions } from '../../src/renderer/src/components/AgentModelOptions'

type Choice = { provider: string; id: string; name: string }

function renderOptions({
  current,
  catalogue,
  available,
  configuredProviderIds,
  leading,
}: {
  current: { provider: string; id: string } | null
  catalogue: Choice[]
  available: Choice[]
  configuredProviderIds?: string[]
  leading?: Array<{ provider: string; id: string }>
}): Array<{ value: string | null; text: string; disabled: boolean; title: string | null }> {
  const html = renderToStaticMarkup(
    <select aria-label="Model for this chat" value={current ? `${current.provider}::${current.id}` : ''} readOnly>
      {!current && <option value="">No model</option>}
      <AgentModelOptions current={current} catalogue={catalogue} models={available} configuredProviderIds={configuredProviderIds} {...(leading ? { leading } : {})} />
    </select>,
  )

  return [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((match) => ({
    value: match[1].match(/value="([^"]*)"/)?.[1] ?? null,
    text: match[2],
    disabled: match[1].includes('disabled=""'),
    title: match[1].match(/title="([^"]*)"/)?.[1] ?? null,
  }))
}

test('the chat picker renders the registry, greys unconfigured providers, and excludes harness lanes', () => {
  const available = [
    { provider: 'xai', id: 'grok-4', name: 'Grok 4' },
    { provider: 'zai', id: 'glm-4.7', name: 'GLM-4.7' },
    { provider: 'anthropic', id: 'claude-opus', name: 'Claude Opus' },
    { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
  ]
  const stale = { provider: 'xiaomi', id: 'mimo-retired', name: 'MiMo Retired' }
  const catalogue = [
    stale,
    ...available,
    { provider: 'google', id: 'gemini-pro', name: 'Gemini Pro' },
    { provider: 'mock', id: 'deterministic', name: 'Deterministic harness' },
  ]

  const options = renderOptions({
    current: { provider: stale.provider, id: stale.id },
    catalogue,
    available,
  })

  expect(options).toContainEqual({
    value: 'xiaomi::mimo-retired',
    text: 'xiaomi · MiMo Retired — unavailable',
    disabled: true,
    title: 'xiaomi is signed out.',
  })
  expect(options).toContainEqual({
    value: 'google::gemini-pro',
    text: 'google · Gemini Pro — sign in to use',
    disabled: true,
    title: 'google is signed out.',
  })
  expect(options).toContainEqual({ value: 'anthropic::claude-opus', text: 'Anthropic · Claude Opus', disabled: false, title: null })
  expect(options).not.toContainEqual(expect.objectContaining({ value: 'mock::deterministic' }))
})

test('the chat picker disables the current model when no credential-filtered models are available', () => {
  expect(renderOptions({
    current: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    catalogue: [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
    available: [],
  })).toEqual([{
    value: 'openai-codex::gpt-5.6-sol',
    text: 'ChatGPT · GPT-5.6 Sol — unavailable',
    disabled: true,
    title: 'ChatGPT is signed out.',
  }])
})

test('auth state disables cached registry models immediately after provider sign-out', () => {
  const model = { provider: 'zai', id: 'glm-4.7', name: 'GLM-4.7' }
  expect(renderOptions({
    current: null,
    catalogue: [model],
    available: [model],
    configuredProviderIds: [],
  })).toContainEqual({
    value: 'zai::glm-4.7',
    text: 'ZAI · GLM-4.7 — sign in to use',
    disabled: true,
    title: 'ZAI is signed out.',
  })
})

test('the chat picker renders No model when no model is current or available', () => {
  expect(renderOptions({ current: null, catalogue: [], available: [] })).toEqual([{
    value: '',
    text: 'No model',
    disabled: false,
    title: null,
  }])
})

test('the chat picker keeps an available current model enabled without unavailable copy', () => {
  const current = { provider: 'anthropic', id: 'claude-opus', name: 'Claude Opus' }
  expect(renderOptions({
    current: { provider: current.provider, id: current.id },
    catalogue: [current],
    available: [current],
  })).toEqual([{
    value: 'anthropic::claude-opus',
    text: 'Anthropic · Claude Opus',
    disabled: false,
    title: null,
  }])
})

test('the chat picker falls back to the raw id when the unavailable current model is absent from the catalogue', () => {
  expect(renderOptions({
    current: { provider: 'retired-provider', id: 'raw-retired-id' },
    catalogue: [],
    available: [],
  })).toEqual([{
    value: 'retired-provider::raw-retired-id',
    text: 'raw-retired-id — unavailable',
    disabled: true,
    title: 'retired-provider is signed out.',
  }])
})

// "Ask first" (fix 04, 2026-10-06): a chat waiting for a model lists the offered models first, in the
// given OpenAI-first order; the rest keep their usual order behind them.
test('a waiting chat lists the offered models first, OpenAI first', () => {
  const catalogue = [
    { provider: 'anthropic', id: 'claude-x', name: 'Claude X' },
    { provider: 'openai', id: 'gpt-api', name: 'GPT API' },
    { provider: 'zai', id: 'glm-x', name: 'GLM X' },
  ]
  const options = renderOptions({
    current: { provider: 'openai-codex', id: 'gpt-5.5' },
    catalogue,
    available: catalogue,
    configuredProviderIds: ['anthropic', 'openai', 'zai'],
    leading: [{ provider: 'openai', id: 'gpt-api' }, { provider: 'anthropic', id: 'claude-x' }],
  })
  expect(options.map((option) => option.value)).toEqual([
    'openai-codex::gpt-5.5', 'openai::gpt-api', 'anthropic::claude-x', 'zai::glm-x',
  ])
  expect(options[0]).toMatchObject({ disabled: true, text: 'gpt-5.5 — unavailable' })
})
