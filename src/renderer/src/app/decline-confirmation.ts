import type { Change } from '../../../preload'
import { declineQuestion, runTargets, type DeclineQuestion } from './margin-bulk'
import { buildMarginModel, type MarginFilter, type MarginModel } from './margin-model'
import type { ReviewActions } from './review-actions'

export type DeclineContext = Readonly<{
  workspace: string | null
  piece: string | null
  collection: string | null
}>

export type DeclineRequest = Readonly<{
  context: DeclineContext
  ids: readonly string[]
  mode: 'run' | 'filtered'
  question: DeclineQuestion
}>

type DeclineInput = {
  context: DeclineContext
  changes: readonly Change[]
  shown: MarginModel | undefined
  picked: ReadonlySet<string>
  filter: MarginFilter | undefined
}

const sameContext = (a: DeclineContext, b: DeclineContext): boolean =>
  a.workspace === b.workspace && a.piece === b.piece && a.collection === b.collection

/** A confirmation grants one attempt over the eligible members of this question's captured targets. */
export function createDeclineConfirmation() {
  let pending: DeclineRequest | null = null
  return {
    request({ context, changes, shown, picked, filter }: DeclineInput): DeclineRequest | null {
      const mode = shown ? 'filtered' : 'run'
      const ids = shown
        ? runTargets(shown, picked, filter, 'decline').declinable
        : changes.filter((change) => change.status === 'pending').map((change) => change.id)
      if (ids.length === 0) return null
      const model = shown ?? buildMarginModel({
        changes: [...changes],
        document: '',
        view: 'margin',
        showOwnEdits: true,
        showQuietFixes: true,
      })
      pending = { context: { ...context }, ids, mode, question: declineQuestion(model, ids) }
      return pending
    },
    cancel(request?: DeclineRequest): boolean {
      if (!pending || (request && request !== pending)) return false
      pending = null
      return true
    },
    retire(context: DeclineContext): DeclineRequest | null {
      if (!pending || sameContext(pending.context, context)) return null
      const retired = pending
      pending = null
      return retired
    },
    resolve(
      request: DeclineRequest,
      context: DeclineContext,
      changes: readonly Change[],
      { discardRun, rejectMany }: Pick<ReviewActions, 'discardRun' | 'rejectMany'>,
    ): Promise<void> | null {
      if (pending !== request) return null
      pending = null
      if (!sameContext(request.context, context)) return null

      const eligible = new Set(changes.filter((change) =>
        change.status === 'pending' || (request.mode === 'filtered' && change.status === 'held'),
      ).map((change) => change.id))
      const ids = request.ids.filter((id) => eligible.has(id))
      return request.mode === 'run' ? discardRun(ids) : rejectMany(ids)
    },
  }
}
