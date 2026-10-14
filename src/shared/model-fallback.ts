/**
 * Which model a chat runs when the wanted one is not listed (fix 04). Since Bridle 0.14.0 a
 * successful live discovery is the provider's whole list, so a model such as openai-codex/gpt-5.5
 * can drop out. This is WriteFlex's model policy over Bridle's list, so it lives here; Bridle only
 * says what is listed and what is signed in. Pure: main (thread boot) and the renderer (the picker)
 * both import it.
 *
 * Automatic fallback stays within the provider the chat
 * (or the default) was on. A switch to another provider sends the next message, and any document
 * text the agent reads, to a company not chosen for that chat — so WriteFlex never makes that switch
 * itself. It offers the other providers' models, OpenAI first, and the user picks.
 */

export type ModelRef = { provider: string; id: string }

/** `run`: start on `model` (`replaced` when it is not the wanted one; always the same provider).
 *  `ask`: no same-provider model can run; the user must choose among `candidates`. */
export type ModelResolution =
  | { kind: 'run'; model: ModelRef; replaced: boolean }
  | { kind: 'ask'; wanted: ModelRef; candidates: ModelRef[] }

/** Default provider order prioritises OpenAI. */
export const PREFERRED_PROVIDERS = ['openai-codex', 'openai'] as const

const same = (left: ModelRef, right: ModelRef): boolean => left.provider === right.provider && left.id === right.id
const ref = (model: ModelRef): ModelRef => ({ provider: model.provider, id: model.id })

/**
 * Other providers' runnable models to offer, OpenAI first (openai-codex, then openai), then the rest
 * in list order. `available` is Bridle's list filtered to signed-in providers.
 */
export function crossProviderCandidates(wanted: ModelRef, available: readonly ModelRef[]): ModelRef[] {
  const others = available.filter((model) => model.provider !== wanted.provider)
  const rank = (provider: string): number => {
    const index = (PREFERRED_PROVIDERS as readonly string[]).indexOf(provider)
    return index === -1 ? PREFERRED_PROVIDERS.length : index
  }
  // Stable: models keep their list order within a rank.
  return others.map((model, index) => ({ model, index }))
    .sort((left, right) => rank(left.model.provider) - rank(right.model.provider) || left.index - right.index)
    .map(({ model }) => ref(model))
}

/**
 * 1. `wanted` itself, when it can run (listed, provider signed in);
 * 2. the same provider's first runnable model;
 * 3. otherwise no automatic choice: `ask`, with the cross-provider candidates (possibly none).
 */
export function chooseRunnableModel(wanted: ModelRef, available: readonly ModelRef[]): ModelResolution {
  if (available.some((model) => same(model, wanted))) return { kind: 'run', model: ref(wanted), replaced: false }
  const sameProvider = available.find((model) => model.provider === wanted.provider)
  if (sameProvider) return { kind: 'run', model: ref(sameProvider), replaced: true }
  return { kind: 'ask', wanted: ref(wanted), candidates: crossProviderCandidates(wanted, available) }
}

/** The existing one-time notice for a same-provider replacement. */
export function modelReplacedNotice(wanted: ModelRef, used: ModelRef): string {
  return `${wanted.provider}/${wanted.id} is no longer available. This chat now uses ${used.provider}/${used.id}.`
}

/** The notice when no same-provider model can run and the user must choose. */
export function modelChoiceNotice(wanted: ModelRef): string {
  return `${wanted.provider}/${wanted.id} is no longer available and ${wanted.provider} offers no other model you can use. Choose a model to continue.`
}
