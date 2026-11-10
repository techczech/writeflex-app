/**
 * The in-app agent's three Folio version verbs (Folio versions ticket 03; ADR-0052 § Agent verbs):
 * `folio.versions` (list, read), `folio.save_version` (save, direct) and `folio.compare_versions` (read). The same operations the
 * command line has as `folio-versions`, `save-folio-version` and `compare-folio-versions`, over the same functions
 * (folio-version-listing.ts, folio-version-save.ts), so the app and an agent cannot disagree.
 *
 * They exist only when the host gives `services.folioVersions` (the app's window does; unit builds
 * without it simply omit them, as the Scratchpad verbs are omitted without a store).
 *
 * The save is `direct`, author recorded as the agent, and it NEVER settles a change: while any part has
 * the writer's own waiting changes it refuses `version-unsettled` and says the writer must save in
 * WriteFlex. An agent's pending proposals stay pending and are listed.
 */
import { Type } from 'typebox'
import type { Verb } from './index'
import type { Workspace } from '../workspace'
import { compareFolioText, folioFolderOf } from '../cli/folio-version-operations'
import { importedText } from '../folio-version-import'
import { StageRefused } from '../folio-version-stage'
import { AGENT_CANNOT_CONFIRM_MATCH, withdrawnText } from '../../shared/folio-version-stage'
import { fail, type CapabilityServices } from './verb-support'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function folioVersionVerbs(workspace: Workspace, services: CapabilityServices | undefined): Verb[] {
  const folio = services?.folioVersions
  if (!folio) return []
  return [
    {
      id: 'folio.versions', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'list Folio versions',
      describe: 'List a Folio\'s saved versions, newest first: each version\'s id, name, author, any note, whether it was sent to someone or withdrawn, and the files it holds (the Index Note, parts in running order, files not in the outline, inserted files, and references). Also says which versions a backup leaves out and why. Reads only. `folio` is the Folio\'s folder or its Index Note.',
      parameters: Type.Object({ folio: Type.String({ description: 'The Folio\'s folder or its Index Note, Collection-relative' }) }),
      run: async (_ctx, input: { folio: string }) => {
        try {
          const listing = await folio.list(folioFolderOf(workspace, input.folio))
          return { text: JSON.stringify(listing, null, 2), details: { listing } }
        } catch (error) { return fail(message(error)) }
      },
    },
    {
      id: 'folio.compare_versions', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'compare Folio versions',
      describe: 'Compare two of a Folio\'s saved versions, or one version with the working draft (`working`, the text on disk now), part by part: for the Index Note, every part, every file not in the outline and every inserted file, whether it is unchanged, changed (words added and removed), only in one of the two, or moved in the running order. An inserted file is compared by the file version each side used. Reads only. `from` and `to` are Folio version ids from `folio.versions`, or `working`.',
      parameters: Type.Object({
        folio: Type.String({ description: 'The Folio\'s folder or its Index Note, Collection-relative' }),
        from: Type.String({ description: 'A Folio version id, or "working"' }),
        to: Type.Optional(Type.String({ description: 'A Folio version id, or "working" (default)' })),
      }),
      run: async (_ctx, input: { folio: string; from: string; to?: string }) => {
        try {
          const comparison = await folio.compare(folioFolderOf(workspace, input.folio), input.from, input.to ?? 'working')
          return { text: compareFolioText(comparison), details: { comparison } }
        } catch (error) { return fail(message(error)) }
      },
    },
    {
      id: 'folio.save_version', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'save a Folio version',
      describe: 'Save a named version of a whole Folio from the text saved on disk: its Index Note, parts in running order, Markdown files not in the outline and the files the text inserts. A file whose text has not changed since its last version is reused. Refuses, writing nothing, with `version-unsettled` while any part has the writer\'s own waiting changes (the writer must save in WriteFlex), and when a file is outside what backup sends. Your own pending proposals stay pending and are listed. `folio` is the Folio\'s folder or its Index Note.',
      parameters: Type.Object({
        folio: Type.String({ description: 'The Folio\'s folder or its Index Note, Collection-relative' }),
        name: Type.String({ description: 'The version\'s name, as it will be listed' }),
        note: Type.Optional(Type.String({ description: 'A note kept with the version' })),
      }),
      touchedPaths: () => [],
      run: async (_ctx, input: { folio: string; name: string; note?: string }) => {
        try {
          const saved = await folio.save({ dir: folioFolderOf(workspace, input.folio), name: input.name, ...(input.note ? { note: input.note } : {}) })
          const kept = saved.record.members.filter((member) => member.role !== 'reference').length
          return { text: `Saved Folio version "${saved.record.name}" (${saved.record.id}): ${kept} files, ${saved.created.length} new file versions, ${saved.reused.length} reused.`, details: { saved } }
        } catch (error) {
          const code = (error as { code?: unknown }).code
          return fail(typeof code === 'string' && code !== 'refused' ? `${message(error)} (${code})` : message(error))
        }
      },
    },
    {
      id: 'folio.import_revision', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'bring in a co-author\'s Word revision as suggestions',
      describe: 'Bring a co-author\'s Word revision (.docx, a file INSIDE the Collection) into a Folio as suggestions. It APPLIES NOTHING: every part stays byte-identical until the writer accepts a change in its margin. It saves the writer\'s current text as a version first, keeps her file with an incoming Folio version, and stages her changes in the matching parts, named as hers. Sections are matched by exact heading; a close match is only a proposal and is reported (`match-needs-confirmation`) and NOT staged: only the writer confirms it, in WriteFlex, and you cannot confirm a match for them (there is no way to pass one; a `matches` field is refused). An ambiguous section is never settled by you either. Refuses with `version-unsettled` while any part has the writer\'s own waiting changes (nothing is written; the writer saves in WriteFlex). Tables and figures are reported, never applied. You cannot accept or decline her changes.',
      parameters: Type.Object({
        folio: Type.String({ description: 'The Folio\'s folder or its Index Note, Collection-relative' }),
        file: Type.String({ description: 'The Word file, by a path inside the Collection' }),
        author: Type.String({ description: 'Who the revision is from, as it will be named' }),
        base: Type.Optional(Type.String({ description: 'The Folio version she started from (default: the one marked as sent to her, else the latest)' })),
      }),
      preview: (input: { file: string; author: string }) => `Bring in ${input.author}\'s revision from ${input.file} as suggestions`,
      // Stages suggestions and writes history records; no document is written.
      touchedPaths: () => [],
      run: async (_ctx, input: { folio: string; file: string; author: string; base?: string }) => {
        // ADR-0052: the agent never confirms a match. The field is not in the schema; one passed anyway is refused, with nothing done.
        if ((input as Record<string, unknown>).matches !== undefined) return fail(AGENT_CANNOT_CONFIRM_MATCH)
        try {
          const answer = await folio.importRevision({ dir: folioFolderOf(workspace, input.folio), file: input.file, from: input.author, ...(input.base ? { base: input.base } : {}) })
          if (answer.status === 'refused') return fail(answer.code === 'version-unsettled' ? `${answer.message} (version-unsettled)` : answer.message)
          return { text: importedText(answer), details: { revision: { id: answer.id, name: answer.name }, report: answer.report, staged: answer.staged } }
        } catch (error) { return fail(message(error)) }
      },
    },
    {
      id: 'folio.withdraw_revision', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'withdraw an incoming revision',
      describe: 'Take back an incoming revision (an id from `folio.versions`): its staged suggestions that still wait are removed from the margins and the revision is marked withdrawn. No part file changes; a suggestion the writer already accepted or declined stays as decided.',
      parameters: Type.Object({ revision: Type.String({ description: 'The incoming revision\'s id, from folio.versions' }) }),
      preview: (input: { revision: string }) => `Withdraw the revision ${input.revision}`,
      touchedPaths: () => [],
      run: async (_ctx, input: { revision: string }) => {
        try {
          const result = await folio.withdrawRevision(input.revision)
          return { text: withdrawnText(result.name, result.taken, result.kept), details: { ...result } }
        } catch (error) { return fail(error instanceof StageRefused ? error.message : message(error)) }
      },
    },
  ]
}
