import { Annotation, StateEffect, Transaction, type ChangeSpec, type Extension, type TransactionSpec } from '@codemirror/state'
import { invertedEffects } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { skipWriterReviewTracking } from './writer-review'

export type SuggestionResolutionEffect = {
  id: string
  path: string
  action: 'accept' | 'reject'
  resolved: boolean
  /** Pre-accept file text used to make redo deterministic even if automatic save has not settled. */
  beforeContent?: string
}

export const suggestionResolutionEffect = StateEffect.define<SuggestionResolutionEffect>()
const initialSuggestionResolution = Annotation.define<boolean>()

export function suggestionResolutionSpec(input: {
  id: string
  path: string
  action: 'accept' | 'reject'
  changes?: ChangeSpec | readonly ChangeSpec[]
  beforeContent?: string
  /** Effects that must be born on this same transaction (a Scratchpad put-back anchor). */
  effects?: readonly StateEffect<unknown>[]
}): TransactionSpec {
  return {
    ...(input.changes ? { changes: input.changes } : {}),
    effects: [suggestionResolutionEffect.of({
      id: input.id,
      path: input.path,
      action: input.action,
      resolved: true,
      ...(input.beforeContent !== undefined ? { beforeContent: input.beforeContent } : {}),
    }), ...(input.effects ?? [])],
    annotations: [
      initialSuggestionResolution.of(true),
      skipWriterReviewTracking.of(true),
      Transaction.addToHistory.of(true),
    ],
    userEvent: 'input',
    scrollIntoView: true,
  }
}

export function resolutionEffectFromTransaction(transaction: Transaction): SuggestionResolutionEffect | null {
  return transaction.effects.find((effect) => effect.is(suggestionResolutionEffect))?.value ?? null
}

export function suggestionResolutionHistory(
  onReplay?: (effect: SuggestionResolutionEffect) => void | Promise<void>,
): Extension {
  const inverse = invertedEffects.of((transaction) => transaction.effects
    .filter((effect) => effect.is(suggestionResolutionEffect))
    .map((effect) => suggestionResolutionEffect.of({ ...effect.value, resolved: !effect.value.resolved })))
  if (!onReplay) return inverse
  return [
    inverse,
    EditorView.updateListener.of((update) => {
      for (const transaction of update.transactions) {
        if (transaction.annotation(initialSuggestionResolution)) continue
        const effect = resolutionEffectFromTransaction(transaction)
        if (effect) void onReplay(effect)
      }
    }),
  ]
}
