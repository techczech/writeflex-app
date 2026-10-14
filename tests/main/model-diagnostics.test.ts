import { expect, test } from 'bun:test'
import { modelRegistryDiagnostic } from '../../src/main/model-diagnostics'

test('model diagnostics record per-provider counts, Codex ids and the resolved auth path', () => {
  const catalogue = [
    { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
    { provider: 'openai-codex', id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
    { provider: 'anthropic', id: 'claude-opus', name: 'Claude Opus' },
  ]
  const models = [catalogue[0], catalogue[1]]
  expect(modelRegistryDiagnostic('/resolved/userData/auth.json', catalogue, models)).toEqual({
    authFilePath: '/resolved/userData/auth.json',
    providers: {
      anthropic: { catalogue: 1, models: 0 },
      'openai-codex': { catalogue: 2, models: 2 },
    },
    openaiCodex: {
      catalogueIds: ['gpt-5.5', 'gpt-5.6-sol'],
      modelIds: ['gpt-5.5', 'gpt-5.6-sol'],
    },
  })
})
