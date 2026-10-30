import { StateEffect, StateField } from '@codemirror/state'
import type { MetadataProposal } from '../app/metadata-proposal'

/**
 * The metadata fields a waiting edit would change, for the metadata panel (the frontmatter widget,
 * live-preview-widgets.ts): the margin pushes them with its marks (ReviewMargin), and the panel marks each
 * field "Proposed by <source>: old → new". Display only: nothing here decides or writes anything.
 */
export const setMetadataProposals = StateEffect.define<MetadataProposal[]>()

export const metadataProposalsField = StateField.define<MetadataProposal[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setMetadataProposals)) return effect.value
    return value
  },
})

export function sameMetadataProposals(a: readonly MetadataProposal[], b: readonly MetadataProposal[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.key === b[i].key && p.before === b[i].before && p.after === b[i].after && p.by === b[i].by)
}
