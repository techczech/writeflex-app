import type { Change, ProseEditInput, ProseMoveInput, Suggestion } from '../../../preload'
import { minimiseProposedReplacement } from '../../../main/proposed-replacement'

export function findLiveSuggestionForChange(
  changes: Change[],
  suggestions: Suggestion[],
  id: string,
): Suggestion | undefined {
  const c = changes.find((x) => x.id === id)
  if (!c) return undefined
  if (c.editClass === 'move') {
    const candidates = suggestions.filter((s) => {
      if (s.capabilityName !== 'prose.move') return false
      const input = s.input as ProseMoveInput
      return input.path === c.path && input.text === c.oldText
    })
    // Move text alone can collide across different destinations. Ambiguous matches defer to the exact
    // main-process changeId -> suggestionId resolver; the open buffer just skips optimistic reconciliation.
    return candidates.length === 1 ? candidates[0] : undefined
  }
  return suggestions.find((s) => {
    if (s.capabilityName !== 'prose.edit') return false
    const input = s.input as ProseEditInput
    if (input.path !== c.path) return false
    // Older ledger records retain the full proposal; new records share the store's minimisation.
    if (input.oldText === c.oldText && input.newText === c.newText) return true
    const minimal = minimiseProposedReplacement({
      ...input, provenance: 'agent', editClass: c.editClass, isCorrection: false,
    })
    return minimal !== null && minimal.oldText === c.oldText && minimal.newText === c.newText
  })
}
