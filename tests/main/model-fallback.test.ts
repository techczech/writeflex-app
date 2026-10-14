import { expect, test } from 'bun:test'
import { chooseRunnableModel, crossProviderCandidates, modelChoiceNotice, modelReplacedNotice } from '../../src/shared/model-fallback'

// Fix 04, decision 2026-10-06 , "ask first": automatic fallback stays within the provider
// the chat or default was on. Other providers' models are only offered, OpenAI first.
const codexSol = { provider: 'openai-codex', id: 'gpt-5.6-sol' }
const codexLuna = { provider: 'openai-codex', id: 'gpt-5.6-luna' }
const openai = { provider: 'openai', id: 'gpt-api' }
const claude = { provider: 'anthropic', id: 'claude-x' }
const zai = { provider: 'zai', id: 'glm-x' }
const wanted = { provider: 'openai-codex', id: 'gpt-5.5' }

test('1. the wanted model runs when it can', () => {
  expect(chooseRunnableModel(codexSol, [claude, codexSol])).toEqual({ kind: 'run', model: codexSol, replaced: false })
})

test('2. otherwise the same provider\'s first runnable model', () => {
  expect(chooseRunnableModel(wanted, [claude, codexLuna, codexSol])).toEqual({ kind: 'run', model: codexLuna, replaced: true })
})

test('3. otherwise no automatic choice: ask, with the other providers OpenAI first', () => {
  // Anthropic and OpenAI both signed in, the wanted Codex model gone: nothing is chosen; OpenAI leads.
  expect(chooseRunnableModel(wanted, [claude, openai])).toEqual({ kind: 'ask', wanted, candidates: [openai, claude] })
  // review finding earlier probe: Codex signed out, Anthropic signed in: still asks, never switches.
  expect(chooseRunnableModel(wanted, [claude])).toEqual({ kind: 'ask', wanted, candidates: [claude] })
  expect(chooseRunnableModel(wanted, [])).toEqual({ kind: 'ask', wanted, candidates: [] })
})

test('the candidates put openai-codex, then openai, then the rest in list order', () => {
  const gone = { provider: 'zai', id: 'gone' }
  expect(crossProviderCandidates(gone, [claude, zai, openai, codexSol, codexLuna]))
    .toEqual([codexSol, codexLuna, openai, claude])
  expect(crossProviderCandidates({ provider: 'anthropic', id: 'gone' }, [zai, claude, openai])).toEqual([openai, zai])
})

test('the notices', () => {
  expect(modelReplacedNotice(wanted, codexSol)).toBe('openai-codex/gpt-5.5 is no longer available. This chat now uses openai-codex/gpt-5.6-sol.')
  expect(modelChoiceNotice(wanted)).toBe('openai-codex/gpt-5.5 is no longer available and openai-codex offers no other model you can use. Choose a model to continue.')
})

test('the popover names only a same-provider fallback; otherwise new chats ask', async () => {
  const { unavailableModelLine } = await import('../../src/renderer/src/components/AgentModelOptions')
  const catalogue = [{ provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }, { provider: 'anthropic', id: 'claude-x', name: 'Claude X' }]
  const base = { current: { provider: 'openai-codex', id: 'gpt-5.5' }, currentName: 'gpt-5.5', catalogue, models: catalogue }
  // Default gone, same provider has review finding: named.
  expect(unavailableModelLine({ ...base, providerSignedIn: true, defaultModel: { provider: 'openai-codex', id: 'gpt-5.5' } }))
    .toBe('gpt-5.5 is no longer offered by ChatGPT. New chats will use GPT-5.6 Sol.')
  // A listed default is what new chats use.
  expect(unavailableModelLine({ ...base, providerSignedIn: true, defaultModel: { provider: 'anthropic', id: 'claude-x' } }))
    .toBe('gpt-5.5 is no longer offered by ChatGPT. New chats will use Claude X.')
  // Default gone and only another provider can run: new chats ask.
  const onlyClaude = [{ provider: 'anthropic', id: 'claude-x', name: 'Claude X' }]
  expect(unavailableModelLine({ ...base, catalogue: onlyClaude, models: onlyClaude, providerSignedIn: true, defaultModel: { provider: 'openai-codex', id: 'gpt-5.5' } }))
    .toBe('gpt-5.5 is no longer offered by ChatGPT. New chats will ask you to choose a model.')
  // Signed-out providers keep the existing wording.
  expect(unavailableModelLine({ ...base, providerSignedIn: false, defaultModel: null }))
    .toBe('This model is unavailable until its provider is configured in Settings.')
})
