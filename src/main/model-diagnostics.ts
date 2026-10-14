import type { ModelChoice } from './agent'

/** Stable, secret-free payload for the bounded main-process model diagnostics log. */
export function modelRegistryDiagnostic(
  authFilePath: string,
  catalogue: ModelChoice[],
  models: ModelChoice[],
): Record<string, unknown> {
  const providerIds = [...new Set([...catalogue, ...models].map((model) => model.provider))].sort()
  const providers = Object.fromEntries(providerIds.map((provider) => [provider, {
    catalogue: catalogue.filter((model) => model.provider === provider).length,
    models: models.filter((model) => model.provider === provider).length,
  }]))
  return {
    authFilePath,
    providers,
    openaiCodex: {
      catalogueIds: catalogue.filter((model) => model.provider === 'openai-codex').map((model) => model.id).sort(),
      modelIds: models.filter((model) => model.provider === 'openai-codex').map((model) => model.id).sort(),
    },
  }
}
