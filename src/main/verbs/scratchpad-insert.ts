/**
 * The agent's generic Scratchpad insertion verbs (spec §8, ticket 04): `scratchpad.insert` puts a
 * COPY of a retained candidate into a document; `scratchpad.put_back` returns a genuine recorded
 * CUTTING. Both are proposals at every trust level (the policy stages them, like every
 * agent-authored insertion): calling one writes nothing. At Accept the verb carries out only the
 * frozen bound insertion the writer reviewed as a Change (scratchpad-agent-insert.ts) — exact
 * prepared Markdown through the store's checked preparation (retained rich text, pictures/SVG,
 * whole tables, compatible widgets; relative links rebased or refused), revalidated against the
 * candidate, any widget page, the destination and its live owner. A copy retains the candidate
 * and records a historical use; a put-back records its place under the accepting window's live
 * editor holder, or refuses and asks for the document to be opened. References and quoted
 * evidence never travel this generic door: they use scratchpad.cite / link / insert_quote.
 */
import { Type } from 'typebox'
import type { Verb } from './index'
import type { Workspace } from '../workspace'
import type { ScrapStore } from '../scraps'
import type { CapabilityServices } from './verb-support'
import { ScratchpadStore } from '../scratchpad-store'
import { executeBoundInsert, prepareBoundInsert, type ScratchInsertInput, type ScratchpadInsertVerb } from '../scratchpad-agent-insert'
import { visiblePath } from '../cli/paths'
import { fail } from './verb-support'

export function scratchpadInsertVerbs(workspace: Workspace, scraps: ScrapStore | null, services?: CapabilityServices): Verb[] {
  const store = new ScratchpadStore(workspace, scraps)
  const proposal = (verb: Extract<ScratchpadInsertVerb, 'scratchpad.insert' | 'scratchpad.put_back'>, label: string, describe: string): Verb => ({
    id: verb, class: 'content', posture: 'proposal', agentOnly: true, label, risk: 'write', describe,
    parameters: Type.Object({
      id: Type.String({ description: 'The Scratchpad item id, as scratchpad.list gives it' }),
      path: Type.String({ description: 'Relative Markdown file path of the destination document' }),
      insertAfter: Type.String({ description: 'Exact unique existing text the insertion follows as a block; an empty string appends at the end' }),
    }),
    preview: (input: ScratchInsertInput) => `${label} in ${input.path}`,
    validateStage: async (input: ScratchInsertInput) => {
      try {
        await prepareBoundInsert(workspace, store, verb, { ...input, path: visiblePath(workspace, input.path, { markdown: true }) })
        return { decision: 'pass' as const }
      } catch (error) { return { decision: 'deny' as const, reason: { code: 'writeflex-stage-validation', message: (error as Error).message } } }
    },
    touchedPaths: (input: ScratchInsertInput) => [workspace.absolute(input.path)],
    run: async (_ctx, input: ScratchInsertInput) => {
      try {
        const path = visiblePath(workspace, input.path, { markdown: true })
        const bound = await services?.scratchpadBoundInsert?.({ verb, itemId: input.id, destPath: path })
        if (!bound) {
          return fail('This Scratchpad proposal has no reviewed text on record in this session, so nothing was written. Ask the agent to propose it again so it can be reviewed as it stands.')
        }
        const done = await executeBoundInsert(workspace, store, bound, services?.scratchpadHolder?.() ?? null)
        if (done.placement) services?.scratchpadPlacement?.(done.placement)
        return { text: done.text, details: { file: done.file } }
      } catch (error) { return fail((error as Error).message) }
    },
  })
  return [
    proposal('scratchpad.insert', 'propose inserting a Scratchpad item',
      'Propose inserting a COPY of one retained Scratchpad item (text, picture, SVG, a whole table or a compatible widget) into a document, as a block after `insertAfter` (empty: at the end). The exact Markdown is prepared once — relative links are rewritten for the destination folder or the proposal is refused — and the writer reviews exactly those bytes as a Change; nothing is written until they accept, and accepting writes nothing else. The item stays in the Scratchpad for reuse. A reference is cited or linked (scratchpad.cite / scratchpad.link) and quoted evidence goes in only as scratchpad.insert_quote; this verb refuses both kinds.'),
    proposal('scratchpad.put_back', 'propose putting a cutting back',
      'Propose putting ONE genuine Scratchpad cutting (text recorded as cut from a document, not a copy and not anything else) back into a document, as a block after `insertAfter` (empty: at the end). Proposed and reviewed exactly like scratchpad.insert; accepting additionally needs the destination open in WriteFlex, so the returned place is held by that editor — without a live editor the accept refuses and writes nothing. For anything that is not a recorded cutting, use scratchpad.insert.'),
  ]
}
