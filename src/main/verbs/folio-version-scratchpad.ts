/**
 * The in-app agent's two verbs for sending text from a saved Folio version to the Scratchpad (Folio versions ticket 10; ADR-0052
 * § Agent verbs): `folio.version_part` (read the part as numbered paragraphs) and `scratchpad.send_version_text` (file a range of them
 * as a Scratchpad candidate that says which version it came from). The same operations the command line has as `folio-version-part`
 * and `scratchpad-send-version-text`, over the same functions (folio-version-scratchpad.ts), so the app and an agent cannot disagree.
 *
 * `scratchpad.send_version_text` takes a version REFERENCE, not text: main reads the saved copy and fills in the provenance, so an agent
 * cannot claim a provenance it does not have. It is recorded as the agent's (`by: 'agent'`, "Suggested by the agent"), is a candidate the
 * writer can reject, and changes no document and no version, so its floor is direct.
 */
import { Type } from 'typebox'
import type { Verb } from './index'
import type { Workspace } from '../workspace'
import { ScratchpadStore } from '../scratchpad-store'
import { defaultReaderSources } from '../folio-version-sources'
import { folioFolderOf } from '../cli/folio-version-operations'
import { numberedParagraphs, readVersionPart, sendVersionText } from '../folio-version-scratchpad'
import { VERSION_TEXT_SIDES, versionSentText, type VersionTextSide } from '../../shared/folio-version-scratchpad'
import { fail, type CapabilityServices } from './verb-support'

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const side = Type.Optional(Type.Union(VERSION_TEXT_SIDES.map((value) => Type.Literal(value)), { description: '"version" (default, or "sent": the version\'s own saved text) or "theirs" (the co-author\'s section of an incoming revision; then `part` is her heading)' }))

/** Like the other Folio version verbs, these exist only where the host gives `services.folioVersions` (the app's window does). */
export function folioVersionScratchpadVerbs(workspace: Workspace, services: CapabilityServices | undefined): Verb[] {
  if (!services?.folioVersions) return []
  const store = new ScratchpadStore(workspace, services.scraps ?? null)
  return [
    {
      id: 'folio.version_part', class: 'content', posture: 'direct', risk: 'read', agentOnly: true, label: 'read a part of a Folio version',
      describe: 'Read one part of a Folio\'s saved version exactly as it was saved, as numbered paragraphs ([1], [2], … — a heading, a paragraph, a list, a quote, a code block or a table each count as one). The numbers are what `scratchpad.send_version_text` takes. `folio` is the Folio\'s folder or its Index Note; `version` is an id from `folio.versions`; `part` is the part\'s path as `folio.versions` lists it, or its title. Reads only; refuses with `not-found` for a version or part that is not there.',
      parameters: Type.Object({
        folio: Type.String({ description: 'The Folio\'s folder or its Index Note, Collection-relative' }),
        version: Type.String({ description: 'A Folio version id from folio.versions' }),
        part: Type.String({ description: 'The part\'s path as the version recorded it, or its title' }),
        side,
      }),
      run: async (_ctx, input: { folio: string; version: string; part: string; side?: VersionTextSide }) => {
        try {
          const part = await readVersionPart(defaultReaderSources(workspace), folioFolderOf(workspace, input.folio), input.version, input.part, input.side ?? 'version')
          return { text: numberedParagraphs(part), details: { version: part.version, part: { path: part.path, title: part.title, ...(part.order !== undefined ? { order: part.order } : {}) }, writtenBy: part.writtenBy, paragraphs: part.paragraphs.length } }
        } catch (error) { return fail(message(error)) }
      },
    },
    {
      id: 'scratchpad.send_version_text', class: 'content', posture: 'direct', risk: 'write', agentOnly: true, label: 'send text of a Folio version to the Scratchpad',
      describe: 'File paragraphs of a part of a Folio\'s saved version in the floating Scratchpad as a new candidate, byte for byte, labelled as suggested by the agent and as coming from that version (its name, the part and who wrote it). Name the paragraphs by the numbers `folio.version_part` shows (`from` to `to`, default the whole part). Nothing in the Folio or in any version changes; the writer can reject the candidate. Optionally file it under a group name (created if new). Returns the new item id. Refuses with `not-found` for a version or part that is not there, and with the Scratchpad\'s own words for empty text, text over 4 MiB or a Collection whose writes are paused.',
      parameters: Type.Object({
        folio: Type.String({ description: 'The Folio\'s folder or its Index Note, Collection-relative' }),
        version: Type.String({ description: 'A Folio version id from folio.versions' }),
        part: Type.String({ description: 'The part\'s path as the version recorded it, or its title' }),
        side,
        from: Type.Optional(Type.Integer({ minimum: 1, description: 'First paragraph number (default 1)' })),
        to: Type.Optional(Type.Integer({ minimum: 1, description: 'Last paragraph number (default: the last paragraph)' })),
        group: Type.Optional(Type.String({ description: 'Group name to file it under; created if it does not exist' })),
      }),
      preview: (input: { version: string; part: string }) => `Send text of “${input.part}” in Folio version ${input.version} to the Scratchpad`,
      // The item's payload and record are new files with a fresh id: no existing file is touched.
      touchedPaths: () => [],
      run: async (_ctx, input: { folio: string; version: string; part: string; side?: VersionTextSide; from?: number; to?: number; group?: string }) => {
        try {
          const sent = await sendVersionText(
            { sources: defaultReaderSources(workspace), store },
            { dir: folioFolderOf(workspace, input.folio), id: input.version, path: input.part, side: input.side ?? 'version', ...(input.from !== undefined ? { from: input.from } : {}), ...(input.to !== undefined ? { to: input.to } : {}), ...(input.group?.trim() ? { groupName: input.group } : {}) },
            'agent',
          )
          return { text: `Filed ${sent.item.id} in the Scratchpad. ${versionSentText(sent.from, sent.to)} It is a candidate there, labelled as suggested by the agent.`, details: { item: sent.item } }
        } catch (error) { return fail(message(error)) }
      },
    },
  ]
}
