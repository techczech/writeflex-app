/**
 * The agent's optional-source verbs (spec §8, ticket 05): `scratchpad.external_search` reads
 * one ENABLED source (refused in main while its Settings switch is off — no discovery at all
 * happens behind a refused call), and `scratchpad.external_collect` keeps one shown result
 * as a Scratchpad candidate: a pointer plus a small preview, copying nothing. Insertion of a
 * collected candidate travels the existing proposal-bound `scratchpad.insert`, whose Accept
 * alone copies the selected checked bytes into the destination's assets. Results are named
 * by the service's opaque epoch-bound handles; no path, root or provider can be supplied.
 */
import { Type } from 'typebox'
import type { Verb } from './index'
import type { Workspace } from '../workspace'
import type { ScrapStore } from '../scraps'
import { ScratchpadStore } from '../scratchpad-store'
import { scratchpadExternalSources } from '../scratchpad-external'
import { visiblePath } from '../cli/paths'
import { fail } from './verb-support'

export function scratchpadExternalVerbs(workspace: Workspace, scraps: ScrapStore | null): Verb[] {
  const store = new ScratchpadStore(workspace, scraps)
  return [
    {
      id: 'scratchpad.external_search', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'search a connected Scratchpad source',
      describe: 'Search one connected optional source for pictures and widgets: source "talkweaver" browses the vaults the writer chose in Settings (optionally one `vault` id from a previous status, or "all"); source "slidewell" word-searches SlideWell\'s readable catalogue, or with mode "meaning" asks its running local picture service. Both connections are OFF unless the writer enabled them in Settings › Scratchpad; while off this is refused and nothing is searched. An empty query browses newest first. Returns result titles, provenance and opaque result ids for scratchpad.external_collect — never file contents or paths. No writes.',
      parameters: Type.Object({
        source: Type.Union([Type.Literal('talkweaver'), Type.Literal('slidewell')], { description: 'Which connected source to search' }),
        query: Type.String({ description: 'Words to match (empty browses newest first)' }),
        vault: Type.Optional(Type.String({ description: 'TalkWeaver only: one chosen vault id, or "all" (default)' })),
        mode: Type.Optional(Type.Union([Type.Literal('words'), Type.Literal('meaning')], { description: 'SlideWell only: catalogue word search (default) or its running semantic picture service' })),
      }),
      run: async (_ctx, input: { source: 'talkweaver' | 'slidewell'; query: string; vault?: string; mode?: 'words' | 'meaning' }) => {
        try {
          const service = scratchpadExternalSources()
          const status = await service.status(input.source)
          if (status.state === 'off') return fail(`${input.source === 'talkweaver' ? 'TalkWeaver vaults are' : 'SlideWell is'} off in Settings › Scratchpad, so nothing was searched. The writer can turn the connection on there.`)
          if (status.state === 'unavailable') return fail(status.reason ?? 'That source is unavailable right now.')
          const found = await service.search(input.source, {
            query: input.query ?? '',
            ...(input.vault ? { vault: input.vault } : {}),
            ...(input.mode ? { mode: input.mode } : {}),
          })
          const results = found.results.map(({ previewDataUri: _preview, ...result }) => result)
          const vaultLines = input.source === 'talkweaver' && status.vaults
            ? `\nVaults: ${status.vaults.map((vault) => `${vault.name} (${vault.id}${status.chosenVaults?.includes(vault.id) ? ', chosen' : ''})`).join('; ')}.`
            : ''
          const slidewellLine = input.source === 'slidewell'
            ? `\nCatalogue: ${status.catalogue ? 'readable' : 'unreadable'}; semantic picture service: ${status.semantic ? 'running' : 'not running'}.`
            : ''
          return {
            text: `${results.length} result(s) from ${input.source === 'talkweaver' ? 'TalkWeaver vaults' : 'SlideWell'}.${vaultLines}${slidewellLine}${found.note ? `\n${found.note}` : ''}\n${JSON.stringify(results, null, 2)}`,
            details: { results, status, ...(found.note ? { note: found.note } : {}) },
          }
        } catch (error) { return fail((error as Error).message) }
      },
    },
    {
      id: 'scratchpad.external_collect', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'collect a connected-source result to the Scratchpad',
      describe: 'Keep one result of scratchpad.external_search (by its result id) as a Scratchpad candidate belonging to the named document: a pointer to the source asset plus a small preview, with its provenance and the shown version\'s digest recorded. NOTHING is copied into the workspace by collecting, and no source file is written; the file is copied into the document\'s assets only when the candidate is inserted (scratchpad.insert proposes that, and accepting performs the copy). A result whose source bytes changed since the search, or whose connection was turned off since, is refused. Returns the new item id.',
      parameters: Type.Object({
        resultId: Type.String({ description: 'The result id scratchpad.external_search returned' }),
        origin: Type.String({ description: 'Workspace-relative Markdown document this candidate belongs to (must exist in this workspace)' }),
        group: Type.Optional(Type.String({ description: 'Group name to file it under; created if it does not exist' })),
      }),
      preview: () => 'Collect a connected-source result to the Scratchpad',
      touchedPaths: () => [],
      run: async (_ctx, input: { resultId: string; origin: string; group?: string }) => {
        try {
          const origin = visiblePath(workspace, input.origin, { markdown: true })
          if (!(await workspace.listFiles()).some((file) => file.path === origin)) return fail(`Not a document in this workspace: ${input.origin}`)
          const group = input.group?.trim() ? await store.createGroup(input.group) : null
          const item = await scratchpadExternalSources().collect(store, {
            handle: input.resultId, activePath: origin, by: 'agent', ...(group ? { group: group.id } : {}),
          })
          return {
            text: `Collected ${item.id} (“${item.title}”, ${item.external?.provenance ?? ''}) to the Scratchpad for ${origin}. Nothing was copied yet; inserting it copies the file into the document's assets and keeps the source on the item.`,
            details: { item },
          }
        } catch (error) { return fail((error as Error).message) }
      },
    },
  ]
}
