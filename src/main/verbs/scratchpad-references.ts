/**
 * The agent's Reference/Evidence verbs (ticket 03, spec §8): the same canonical-source projection
 * and preparation the panel uses, behind the content-verb postures. Collecting is a direct pointer
 * write; citing, linking and inserting a quote add text to a document, so they are proposals the
 * writer accepts or rejects; attaching evidence is the existing direct evidence operation under its
 * expectation guard. Nothing here reads a live Zotero or archive account: the facts come from the
 * Folio's own evidence records, exactly as the panel's do.
 */
import { Type } from 'typebox'
import type { Verb } from './index'
import type { Workspace } from '../workspace'
import type { ScrapStore } from '../scraps'
import type { CapabilityServices } from './verb-support'
import { ScratchpadStore } from '../scratchpad-store'
import { attachCanonicalReference, collectCanonicalSource, readCanonicalSources } from '../scratchpad-references'
import { executeBoundInsert, prepareBoundInsert, type ScratchpadInsertVerb } from '../scratchpad-agent-insert'
import { evidencePath } from '../folio-evidence'
import { visiblePath } from '../cli/paths'
import { fail } from './verb-support'

type PlaceInput = { id: string; path: string; insertAfter: string }

export function scratchpadReferenceVerbs(workspace: Workspace, scraps: ScrapStore | null, services?: CapabilityServices): Verb[] {
  const store = new ScratchpadStore(workspace, scraps)
  // The three insertion acts are bound proposals (scratchpad-agent-insert.ts): the canonical
  // source is prepared ONCE at staging and frozen beside the Change the writer reviews; Accept
  // revalidates that frozen Markdown against the canonical record, the candidate and the
  // destination, and writes those exact bytes — it never places from a fresh read.
  const proposal = (verb: Extract<ScratchpadInsertVerb, 'scratchpad.cite' | 'scratchpad.link' | 'scratchpad.insert_quote'>, label: string, describe: string): Verb => ({
    id: verb, class: 'content', posture: 'proposal', agentOnly: true, label, risk: 'write', describe,
    parameters: Type.Object({
      id: Type.String({ description: 'The collected Reference/Evidence item id, as scratchpad.list gives it' }),
      path: Type.String({ description: 'Relative Markdown file path of the destination part' }),
      insertAfter: Type.String({ description: 'Exact unique existing text the insertion follows; an empty string appends a quote at the end (cite/link need an anchor)' }),
    }),
    preview: (input: PlaceInput) => `${label} in ${input.path}`,
    validateStage: async (input: PlaceInput) => {
      try {
        await prepareBoundInsert(workspace, store, verb, { ...input, path: visiblePath(workspace, input.path, { markdown: true }) })
        return { decision: 'pass' as const }
      } catch (error) { return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: (error as Error).message } } }
    },
    touchedPaths: (input: PlaceInput) => [workspace.absolute(input.path)],
    run: async (_ctx, input: PlaceInput) => {
      try {
        const path = visiblePath(workspace, input.path, { markdown: true })
        const bound = await services?.scratchpadBoundInsert?.({ verb, itemId: input.id, destPath: path })
        if (!bound) {
          return fail('This Scratchpad proposal has no reviewed text on record in this session, so nothing was written. Ask the agent to propose it again so it can be reviewed as it stands.')
        }
        const done = await executeBoundInsert(workspace, store, bound, services?.scratchpadHolder?.() ?? null)
        return { text: done.text, details: { file: done.file } }
      } catch (error) { return fail((error as Error).message) }
    },
  })
  return [
    {
      id: 'scratchpad.sources', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'list Folio sources for the Scratchpad',
      describe: 'Read the Folio\'s canonical sources and quoted highlights (its evidence records, part sources and citations, including Zotero and archive items) as collectable Reference/Evidence cards with their typed identity and provenance. No writes; the records are projected, never copied.',
      parameters: Type.Object({ path: Type.String({ description: 'A part of the Folio, workspace-relative' }) }),
      run: async (_ctx, input: { path: string }) => {
        try {
          const result = await readCanonicalSources(workspace, store, visiblePath(workspace, input.path, { markdown: true }))
          return { text: JSON.stringify(result, null, 2), details: result }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    {
      id: 'scratchpad.collect', class: 'content', posture: 'direct', agentOnly: true, label: 'collect a source to the Scratchpad', risk: 'write',
      describe: 'Keep a pointer to one canonical Folio source (from scratchpad.sources) as a Reference or Evidence candidate in the Scratchpad. Pointer and preview only: the source record is unchanged and nothing is copied. References join the References group.',
      parameters: Type.Object({
        path: Type.String({ description: 'A part of the Folio the source belongs to, workspace-relative' }),
        sourceId: Type.String({ description: 'The source id, as scratchpad.sources gives it' }),
      }),
      preview: (input: { sourceId: string }) => `Collect ${input.sourceId} to the Scratchpad`,
      touchedPaths: () => [],
      run: async (_ctx, input: { path: string; sourceId: string }) => {
        try {
          const item = await collectCanonicalSource(workspace, store, { activePath: visiblePath(workspace, input.path, { markdown: true }), sourceId: input.sourceId, by: 'agent' })
          return { text: `Collected ${item.title} to the Scratchpad.`, details: { item } }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    proposal('scratchpad.cite', 'propose citing a reference',
      'Propose ONE citation chip for a collected Reference, inline after `insertAfter`. The chip is prepared from the canonical source when the proposal is staged and the writer reviews exactly it as a Change; if the source changes before they accept, the accept refuses rather than cite different words. The item stays in the Scratchpad; nothing is written until the writer accepts.'),
    proposal('scratchpad.link', 'propose linking a reference',
      'Propose ONE ordinary link (or wikilink for a note) to a collected Reference or Evidence source, inline after `insertAfter`. No content is inserted. The link is prepared and reviewed exactly as scratchpad.cite prepares its chip.'),
    proposal('scratchpad.insert_quote', 'propose a quote with citation',
      'Propose inserting a collected Evidence item\'s quoted words as a blockquote with its citation chip, as a block after `insertAfter` (empty: at the end). The quoted words are taken from the canonical evidence record when the proposal is staged and reviewed exactly; if the record changes before Accept, the accept refuses rather than quote different words.'),
    {
      id: 'scratchpad.attach_evidence', class: 'content', posture: 'direct', agentOnly: true, label: 'attach a source as evidence', risk: 'write',
      describe: 'Attach a collected Reference/Evidence item\'s canonical source to the Folio part that owns `path`, through the existing evidence operation (expectation-guarded, with its own Undo token). The part\'s text is untouched. Direct, as the panel\'s Attach to part is.',
      parameters: Type.Object({
        id: Type.String({ description: 'The collected Reference/Evidence item id, as scratchpad.list gives it' }),
        path: Type.String({ description: 'The destination part\'s workspace-relative path' }),
      }),
      preview: (input: { id: string; path: string }) => `Attach ${input.id} as evidence to ${input.path}`,
      touchedPaths: (input: { path: string }) => {
        try {
          const dir = store.folioDirFor(store.documentPath(input.path))
          return dir === null ? [] : [workspace.absolute(evidencePath({ root: workspace.root, folioDir: dir }))]
        } catch { return [] }
      },
      run: async (_ctx, input: { id: string; path: string }) => {
        try {
          const path = visiblePath(workspace, input.path, { markdown: true })
          const result = await attachCanonicalReference(workspace, store, { id: input.id, destination: path }, { session: 'agent-scratchpad' })
          return { text: `Attached ${result.label} to ${result.part} as evidence. The text is unchanged.`, details: result }
        } catch (error) { return fail((error as Error).message) }
      },
    },
  ]
}
