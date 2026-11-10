/**
 * Folio versions from the command line (Folio versions ticket 03; ADR-0052 § Agent verbs):
 *
 *   folio-versions <folio>        the Folio's versions, newest first, and which a backup leaves out (read)
 *   save-folio-version <folio>    freeze the whole Folio: Index Note, parts in running order, files not
 *                                 in the outline, inserted files (writes the history stores)
 *
 * `<folio>` is the Folio's folder or its Index Note. Like `save-version`, the save is carried out by
 * whoever holds the Collection (the app on request, the command line under the owner lock), through
 * one function over the app's own store code (folio-version-save.ts). It saves the text as it stands
 * ON DISK and settles no change: a Folio with the writer's own waiting changes is refused
 * `version-unsettled` (`needs-writer`). An agent's pending proposals stay pending and are listed.
 */
import { isAbsolute, posix, relative } from 'node:path'
import { listFolioVersions } from '../folio-version-listing'
import { FolioVersionStore, type ListedFolioVersion } from '../folio-versions'
import { compareFolioVersions } from '../folio-version-compare'
import { defaultCompareSources, defaultReaderSources } from '../folio-version-sources'
import { ScratchpadStore } from '../scratchpad-store'
import { WritesPausedError } from '../collection-write-gate'
import { numberedParagraphs, readVersionPart, sendVersionText, VersionSendRefused } from '../folio-version-scratchpad'
import { VERSION_TEXT_SIDES, versionSentText, type VersionTextSide } from '../../shared/folio-version-scratchpad'
import { COMPARE_WORKING, comparingText, stateChipText, type FolioCompareEntry, type FolioCompareResult, NOTHING_CHANGED } from '../../shared/folio-version-compare'
import type { Workspace } from '../workspace'
import { importedText } from '../folio-version-import'
import { AGENT_CANNOT_CONFIRM_MATCH, withdrawnText, REVISION_NOT_FOUND } from '../../shared/folio-version-stage'
import { StageRefused } from '../folio-version-stage'
import type { ImportRefused } from '../../shared/folio-version-import'
import { OUTSIDE_AUTHORS, declaredSource } from './review-format'
import { CliError, type Operation } from './operation'
import { visiblePath } from './paths'
import { applied, writeAccess } from './write-support'

const MARKDOWN = /\.(?:md|markdown|mdx)$/i
const date = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace('T', ' ')

/** The Folio's folder from what was typed: the folder itself, or its Index Note (or any Markdown file in it). */
export function folioFolderOf(ws: Workspace, input: string | undefined): string {
  if (input === undefined || input === '' || input === '.' || input === '/') return ''
  if (MARKDOWN.test(input)) {
    const file = visiblePath(ws, input, { markdown: true })
    const dir = posix.dirname(file)
    return dir === '.' ? '' : dir
  }
  return visiblePath(ws, input, { allowRoot: true })
}

const memberCount = (version: ListedFolioVersion): string => {
  const kept = version.members.filter((member) => member.role !== 'reference').length
  const references = version.members.length - kept
  return `${kept} file${kept === 1 ? '' : 's'}${references ? `, ${references} reference${references === 1 ? '' : 's'}` : ''}`
}

const compareLine = (entry: FolioCompareEntry, result: FolioCompareResult): string => `  ${entry.title}${entry.kind === 'inserted' || entry.kind === 'unlisted' ? `  (${entry.path})` : ''}  ${stateChipText(entry, result)}`

/** The comparison as plain text: what was compared, then each line by its group. */
export function compareFolioText(result: FolioCompareResult): string {
  const group = (title: string, entries: FolioCompareEntry[]): string[] => (entries.length ? [`${title}:`, ...entries.map((entry) => compareLine(entry, result))] : [])
  const { unchanged, changed, onlyFrom, onlyTo, moved } = result.summary
  const head = `${comparingText(result)}${result.same ? ' (the same)' : ''}`
  if (changed + onlyFrom + onlyTo + moved === 0) return `${head}\n${NOTHING_CHANGED}`
  return [
    head,
    `${changed} changed, ${onlyFrom + onlyTo} in only one, ${moved} moved, ${unchanged} unchanged.`,
    ...group('Index Note', [result.index]),
    ...group('Parts', result.parts),
    ...group('Not in the outline', result.unlisted),
    ...group('Inserted files', result.inserted),
  ].join('\n')
}


/** The Word file named on the command line: a path inside the Collection (an absolute one is made relative), never one outside it. */
function wordFileOf(ws: Workspace, input: string): string {
  const typed = isAbsolute(input) ? relative(ws.root, input) : input
  if (typed === '' || typed.includes('\0')) throw new CliError('Name the Word file (.docx) by a path inside the Collection.', 'usage')
  const verdict = ws.classifyPath(typed, 'file')
  if (verdict === 'outside') throw new CliError(`${input} is outside the Collection. WriteFlex does not open files outside it on request: copy the Word file into the Collection first, then name it there. Nothing was done.`)
  if (verdict === 'hidden') throw new CliError(`${input} is under a dot-folder or an ignored folder, which is not part of the Collection. Nothing was done.`)
  if (!/\.docx$/i.test(typed)) throw new CliError(`${input} is not a .docx file. Nothing was done.`, 'usage')
  return ws.relative(ws.absolute(typed))
}

/** An import's refusal as the command line's error: `version-unsettled` is the writer's to settle first (`needs-writer`); the rest are refusals in their own words. */
function importError(refused: ImportRefused): CliError {
  if (refused.code === 'version-unsettled') return new CliError(refused.message, 'refused', 'version-unsettled')
  if (refused.code === 'collection-closed') return new CliError(refused.message, 'refused', 'collection-closed')
  if (refused.code === 'writes-paused') return new CliError(refused.message, 'refused', 'writes-paused')
  return new CliError(refused.message, 'refused')
}

export const FOLIO_VERSION_OPERATIONS: Operation[] = [
  {
    name: 'folio-versions', group: 'Review and versions', behaviour: 'direct',
    summary: 'List a Folio\'s saved versions, newest first, with the files each holds and any a backup leaves out.',
    args: [{ name: 'folio', type: 'string', positional: true, description: 'The Folio\'s folder or its Index Note (default: the Collection root).' }],
    run: async (ctx, args) => {
      const dir = folioFolderOf(ctx.workspace, args.folio === undefined ? undefined : String(args.folio))
      try {
        const listing = await listFolioVersions(ctx.workspace, new FolioVersionStore(ctx.workspace), dir)
        const lines = listing.versions.map((v) => `${date(v.ts)}  ${v.name}  (${v.author.name})  ${memberCount(v)}${v.sentTo ? `  sent to ${v.sentTo}` : ''}${v.withdrawn ? '  withdrawn' : ''}  ${v.id}`)
        const left = listing.backup.state === 'ok'
          ? listing.backup.leftOut.map((entry) => `Not in the backup: ${entry.reason}`)
          : ['Which of these a backup leaves out could not be worked out: ' + listing.backup.reason]
        return { data: listing, text: [...(lines.length ? lines : ['No Folio versions.']), ...(listing.versions.length ? left : [])].join('\n') }
      } catch (error) {
        throw new CliError(error instanceof Error ? error.message : String(error), 'failed')
      }
    },
  },
  {
    name: 'save-folio-version', group: 'Review and versions', behaviour: 'direct', writes: true,
    summary: 'Save a named version of a whole Folio: its Index Note, parts in running order, files not in the outline and inserted files, from the text saved on disk.',
    args: [
      { name: 'folio', type: 'string', required: true, positional: true, description: 'The Folio\'s folder or its Index Note.' },
      { name: 'name', type: 'string', required: true, description: 'The Folio version\'s name, as it will be listed.' },
      { name: 'note', type: 'string', description: 'A note kept with the version.' },
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const dir = folioFolderOf(ctx.workspace, String(args.folio))
      const name = String(args.name).trim()
      if (name === '') throw new CliError('Give the Folio version a name with --name "...".', 'usage')
      const note = args.note === undefined ? '' : String(args.note).trim()
      const saved = await access.saveFolioVersion({ dir, name, ...(note ? { note } : {}) })
      const kept = saved.record.members.filter((member) => member.role !== 'reference').length
      return applied(
        [
          `Saved Folio version "${saved.record.name}" (${saved.record.id}): ${kept} file${kept === 1 ? '' : 's'}, ${saved.created.length} new file version${saved.created.length === 1 ? '' : 's'}, ${saved.reused.length} reused.`,
          ...saved.waiting.map((w) => `Left out, still waiting in ${w.path}: ${w.pending} pending proposal${w.pending === 1 ? '' : 's'}${w.held ? `, ${w.held} held` : ''}.`),
          ...saved.notSaved.map((n) => n.why),
        ].join('\n'),
        { folio: dir, version: saved.record, created: saved.created, reused: saved.reused, waiting: saved.waiting, notSaved: saved.notSaved },
      )
    },
  },
  {
    name: 'compare-folio-versions', group: 'Review and versions', behaviour: 'direct',
    summary: 'Compare two Folio versions, or a Folio version with the text now on disk, part by part: unchanged, changed (words added and removed), only in one, or moved; files not in the outline and inserted files (by their file version) in the same list.',
    args: [
      { name: 'folio', type: 'string', required: true, positional: true, description: 'The Folio\'s folder or its Index Note.' },
      { name: 'from', type: 'string', required: true, positional: true, description: 'A Folio version id from "writeflex folio-versions", or "working" for the text on disk now.' },
      { name: 'to', type: 'string', positional: true, description: 'The Folio version to compare with (default: "working").' },
    ],
    run: async (ctx, args) => {
      const dir = folioFolderOf(ctx.workspace, String(args.folio))
      const from = String(args.from).trim()
      const to = args.to === undefined ? COMPARE_WORKING : String(args.to).trim()
      if (from === '' || to === '') throw new CliError('Name the Folio versions to compare by their ids ("writeflex folio-versions" lists them).', 'usage')
      try {
        const result = await compareFolioVersions(defaultCompareSources(ctx.workspace), dir, from, to)
        return { data: result, text: compareFolioText(result) }
      } catch (error) {
        if (error instanceof CliError) throw error
        throw new CliError(error instanceof Error ? error.message : String(error), 'failed')
      }
    },
  },
  {
    name: 'import-revision', group: 'Review and versions', behaviour: 'direct', writes: true,
    summary: 'Bring a co-author\'s Word revision into a Folio as suggestions: saves the writer\'s text as a version, keeps her file, and stages her changes in the margins of the matching parts. Applies nothing.',
    details: 'A proposal: every part stays byte-identical until the writer accepts a change in its margin. The Word file must be inside the Collection (copy it in first). Sections are matched by exact heading; a close match is only a proposal and the writer confirms it: it is reported as match-needs-confirmation and left unstaged until the writer confirms it in WriteFlex: no option here confirms a match, and --match is refused. An ambiguous section is never settled here. Refused with needs-writer while any part has changes of the writer\'s own waiting. Tables and figures are reported, never applied. WriteFlex has to have the Collection open.',
    args: [
      { name: 'folio', type: 'string', required: true, positional: true, description: 'The Folio\'s folder or its Index Note.' },
      { name: 'file', type: 'string', required: true, positional: true, description: 'The Word file (.docx), by a path inside the Collection.' },
      { name: 'author', type: 'string', required: true, description: 'Who the revision is from, as it will be named ("Sam Rowe").' },
      { name: 'base', type: 'string', description: 'The Folio version she started from (default: the one marked as sent to her, else the latest). Ids are listed by "writeflex folio-versions".' },
      { name: 'match', type: 'string', repeatable: true, description: 'Refused. An agent cannot confirm a match; only the writer can, in WriteFlex.' },
      { name: 'source', type: 'string', description: 'Who is asking (claude-code or codex); the Versions tab says who brought the revision in.' },
    ],
    run: async (ctx, args) => {
      if (args.match !== undefined) throw new CliError(AGENT_CANNOT_CONFIRM_MATCH, 'usage')
      const access = writeAccess(ctx)
      const dir = folioFolderOf(access.workspace, String(args.folio))
      const file = wordFileOf(access.workspace, String(args.file))
      const from = String(args.author)
      const by = OUTSIDE_AUTHORS[declaredSource(args.source)].name
      const answer = await access.importRevision({ dir, file, from, ...(typeof args.base === 'string' && args.base.trim() !== '' ? { base: args.base.trim() } : {}), by })
      if (answer.status === 'refused') throw importError(answer)
      const { report, staged } = answer
      return applied(importedText(answer), {
        folio: dir, revision: { id: answer.id, name: answer.name }, safety: { id: answer.safetyId, name: answer.safetyName },
        matched: report.matched, close: report.close, new: report.new, removed: report.removed, moved: report.moved, assetNotes: report.assetNotes, ambiguous: report.ambiguous, counts: report.counts,
        staged: { changes: staged.changes, parts: staged.parts, sectionsChanged: staged.sectionsChanged, changesStaged: staged.staged, notStaged: staged.notStaged },
      })
    },
  },
  {
    name: 'withdraw-revision', group: 'Review and versions', behaviour: 'direct', writes: true,
    summary: 'Take back an incoming revision: its staged suggestions that are still waiting are removed from the margins and the revision is marked withdrawn. No part file changes.',
    details: 'Changes the writer already accepted or declined stay as decided. WriteFlex has to have the Collection open.',
    args: [{ name: 'revision', type: 'string', required: true, positional: true, description: 'The incoming revision\'s id (fv_…), as "writeflex folio-versions" lists it.' }],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      try {
        const result = await access.withdrawRevision(String(args.revision).trim())
        return applied(withdrawnText(result.name, result.taken, result.kept), { revision: { id: result.id, name: result.name, from: result.from }, taken: result.taken, kept: result.kept })
      } catch (error) {
        if (error instanceof StageRefused) throw new CliError(error.code === 'not-found' ? REVISION_NOT_FOUND : error.message, 'refused')
        throw error
      }
    },
  },
  {
    name: 'folio-version-part', group: 'Review and versions', behaviour: 'direct',
    summary: 'Read one part of a Folio version exactly as it was saved, as numbered paragraphs ([1], [2], …): the numbers that scratchpad-send-version-text takes.',
    args: [
      { name: 'folio', type: 'string', required: true, positional: true, description: 'The Folio\'s folder or its Index Note.' },
      { name: 'version', type: 'string', required: true, positional: true, description: 'A Folio version id from "writeflex folio-versions".' },
      { name: 'part', type: 'string', required: true, positional: true, description: 'The part\'s path as "writeflex folio-versions" lists it, or its title.' },
      { name: 'side', type: 'string', description: 'sent (default: the version\'s own saved text) or theirs (the co-author\'s section of an incoming revision; then the part is her heading).' },
    ],
    run: async (ctx, args) => {
      const dir = folioFolderOf(ctx.workspace, String(args.folio))
      const side = sideOf(args.side)
      try {
        const part = await readVersionPart(defaultReaderSources(ctx.workspace), dir, String(args.version).trim(), String(args.part), side)
        return {
          data: { folio: dir, version: part.version, side: part.side, part: { path: part.path, title: part.title, ...(part.order !== undefined ? { order: part.order } : {}) }, writtenBy: part.writtenBy, paragraphs: part.paragraphs.map((p) => ({ n: p.n, markdown: part.text.slice(p.from, p.to) })) },
          text: numberedParagraphs(part),
        }
      } catch (error) {
        if (error instanceof VersionSendRefused) throw new CliError(error.message, 'refused')
        throw new CliError(error instanceof Error ? error.message : String(error), 'failed')
      }
    },
  },
  {
    name: 'scratchpad-send-version-text', group: 'Collect and plan', behaviour: 'direct', writes: true,
    summary: 'File paragraphs of a part of a Folio version in the Scratchpad as a new candidate that says which version it came from (the version, the part, who wrote it), labelled as suggested by the agent. Changes no document and no version.',
    args: [
      { name: 'folio', type: 'string', required: true, positional: true, description: 'The Folio\'s folder or its Index Note.' },
      { name: 'version', type: 'string', required: true, positional: true, description: 'A Folio version id from "writeflex folio-versions".' },
      { name: 'part', type: 'string', required: true, positional: true, description: 'The part\'s path as "writeflex folio-versions" lists it, or its title.' },
      { name: 'side', type: 'string', description: 'sent (default) or theirs; see folio-version-part.' },
      { name: 'from', type: 'integer', description: 'First paragraph number from "writeflex folio-version-part" (default 1).' },
      { name: 'to', type: 'integer', description: 'Last paragraph number (default: the last paragraph).' },
      { name: 'group', type: 'string', description: 'Group name to file it under; created if it does not exist.' },
    ],
    run: async (ctx, args) => {
      const access = writeAccess(ctx)
      const dir = folioFolderOf(access.workspace, String(args.folio))
      const store = new ScratchpadStore(access.workspace, null)
      try {
        const sent = await sendVersionText(
          { sources: defaultReaderSources(access.workspace), store },
          { dir, id: String(args.version).trim(), path: String(args.part), side: sideOf(args.side), ...(typeof args.from === 'number' ? { from: args.from } : {}), ...(typeof args.to === 'number' ? { to: args.to } : {}), ...(typeof args.group === 'string' && args.group.trim() !== '' ? { groupName: args.group } : {}) },
          'agent',
        )
        return applied(`Filed ${sent.item.id} in the Scratchpad. ${versionSentText(sent.from, sent.to)} It is a candidate there, labelled as suggested by the agent.`, { item: sent.item }, null)
      } catch (error) {
        if (error instanceof WritesPausedError) throw new CliError(error.message, 'refused', 'writes-paused')
        // A refusal of the version text or of the Scratchpad's own (nothing to keep, too large, no such group) is said in its own words.
        throw new CliError(error instanceof Error ? error.message : String(error), 'refused')
      }
    },
  },
]

function sideOf(value: unknown): VersionTextSide {
  if (value === undefined) return 'version'
  if (typeof value === 'string' && (VERSION_TEXT_SIDES as readonly string[]).includes(value)) return value as VersionTextSide
  throw new CliError('--side takes sent or theirs.', 'usage')
}
