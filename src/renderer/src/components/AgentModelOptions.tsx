import type { ModelChoice } from '../../../preload'
import { chooseRunnableModel } from '../../../shared/model-fallback'

const PROVIDER_NAMES: Record<string, string> = { 'openai-codex': 'ChatGPT', anthropic: 'Anthropic', zai: 'ZAI' }
export const providerDisplayName = (provider: { id: string }): string => PROVIDER_NAMES[provider.id] ?? provider.id

/** Test and deterministic providers are harnesses, never choices a writer can send live work to. */
export function isLiveModelChoice(model: ModelChoice): boolean {
  return !/^(mock|scripted|deterministic)(?:$|[-_:])/i.test(model.provider)
}

/** Actionable explanation for a selected model that cannot currently run. */
export function unavailableModelTitle(model: ModelChoice, available: ModelChoice[]): string {
  const providerAvailable = available.some((candidate) => candidate.provider === model.provider)
  return providerAvailable
    ? `${model.name} is not in the available model set.`
    : `${providerDisplayName({ id: model.provider })} is signed out.`
}

/**
 * The popover line for a selected model that cannot run (fix 04 follow-up). A signed-in provider
 * that no longer lists the model: "{name} is no longer offered by {provider}." followed by what a
 * new chat would do, mirroring ThreadManager: a listed default, or a same-provider fallback, is named
 * ("New chats will use {name}."); when only another provider could run, new chats ask ("New chats
 * will ask you to choose a model." — decision 2026-10-06, "ask first"). A signed-out provider keeps
 * the existing wording.
 */
export function unavailableModelLine(input: {
  current: { provider: string; id: string }
  currentName: string
  providerSignedIn: boolean
  defaultModel: { provider: string; id: string } | null
  catalogue: ModelChoice[]
  models: ModelChoice[]
}): string {
  if (!input.providerSignedIn) return 'This model is unavailable until its provider is configured in Settings.'
  const providerName = providerDisplayName({ id: input.current.provider })
  const offered = `${input.currentName} is no longer offered by ${providerName}.`
  // Mirror ThreadManager.runnableModel: a listed default stays; an unlisted one falls back to a runnable model.
  const wanted = input.defaultModel ?? input.current
  const resolution = input.catalogue.some((model) => model.provider === wanted.provider && model.id === wanted.id)
    ? { kind: 'run' as const, model: wanted }
    : chooseRunnableModel(wanted, input.models)
  if (resolution.kind === 'ask') return `${offered} New chats will ask you to choose a model.`
  const fallback = resolution
  const name = input.catalogue.find((model) => model.provider === fallback.model.provider && model.id === fallback.model.id)?.name
    ?? fallback.model.id
  return `${offered} New chats will use ${name}.`
}

export function AgentModelOptions({
  current,
  catalogue,
  models,
  configuredProviderIds,
  supportedProviderIds,
  leading,
}: {
  current: { provider: string; id: string } | null
  catalogue: ModelChoice[]
  models: ModelChoice[]
  configuredProviderIds?: readonly string[]
  supportedProviderIds?: readonly string[]
  /** Models listed first, in this order (the "ask first" candidates, OpenAI first); the rest follow
   *  in the usual order. */
  leading?: ReadonlyArray<{ provider: string; id: string }>
}): JSX.Element {
  const currentAvailable = current
    ? models.some((model) => model.provider === current.provider && model.id === current.id)
    : false
  const unavailableCurrent = current && !currentAvailable
    ? catalogue.find((model) => model.provider === current.provider && model.id === current.id)
      ?? { ...current, name: current.id }
    : null
  const availableIds = new Set(models.filter(isLiveModelChoice).map((model) => `${model.provider}::${model.id}`))
  const catalogueChoices = [...catalogue]
    .filter((model) => isLiveModelChoice(model) && (!supportedProviderIds || supportedProviderIds.includes(model.provider)))
    .sort((left, right) => left.provider.localeCompare(right.provider)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id))
  const catalogueIds = new Set(catalogueChoices.map((model) => `${model.provider}::${model.id}`))
  const unordered = [
    ...catalogueChoices,
    ...models.filter((model) => isLiveModelChoice(model)
      && (!supportedProviderIds || supportedProviderIds.includes(model.provider))
      && !catalogueIds.has(`${model.provider}::${model.id}`)),
  ]
  const leadRank = new Map((leading ?? []).map((model, index) => [`${model.provider}::${model.id}`, index]))
  const choices = leadRank.size === 0 ? unordered : [
    ...unordered.filter((model) => leadRank.has(`${model.provider}::${model.id}`))
      .sort((left, right) => leadRank.get(`${left.provider}::${left.id}`)! - leadRank.get(`${right.provider}::${right.id}`)!),
    ...unordered.filter((model) => !leadRank.has(`${model.provider}::${model.id}`)),
  ]

  return (
    <>
      {unavailableCurrent && !catalogueIds.has(`${unavailableCurrent.provider}::${unavailableCurrent.id}`) && (
        <option
          value={`${unavailableCurrent.provider}::${unavailableCurrent.id}`}
          disabled
          title={unavailableModelTitle(unavailableCurrent, models)}
        >
          {unavailableCurrent.name} — unavailable
        </option>
      )}
      {choices.map((model) => {
        const value = `${model.provider}::${model.id}`
        const providerConfigured = configuredProviderIds
          ? configuredProviderIds.includes(model.provider)
          : models.some((candidate) => candidate.provider === model.provider)
        const available = availableIds.has(value) && providerConfigured
        const selected = current?.provider === model.provider && current.id === model.id
        return (
        <option key={value} value={value} disabled={!available} title={available ? undefined : providerConfigured ? unavailableModelTitle(model, models) : `${providerDisplayName({ id: model.provider })} is signed out.`}>
          {providerDisplayName({ id: model.provider })} · {model.name}{available ? '' : selected || providerConfigured ? ' — unavailable' : ' — sign in to use'}
        </option>
        )
      })}
    </>
  )
}
