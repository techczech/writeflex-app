/**
 * Send a copy of text from a saved Folio version to the floating Scratchpad (ADR-0052 § Sending text to the Scratchpad; ADR-0050;
 * Folio versions ticket 10). The ONE route: the window's gutter icon and selection bubble, the Compare take's "keep mine", the command
 * line and the agent's verb all call `sendVersionText`.
 *
 * WHAT IT WRITES. One Scratchpad text item, through the Scratchpad store's own checked writer (`ScratchpadStore.addText`: payload then
 * record, the Collection's write gate, no link followed, a new file never replacing another). Nothing else: no Folio file, no version
 * record, no change in the ledger. Sending is `how: 'copy'`, so nothing from a version is ever a cut, and Undo is the store's
 * `discardCopy`, which the caller already has.
 *
 * WHAT IT TAKES. A Folio, a version id, a part and a range of paragraph NUMBERS (1-based; shared/folio-version-paragraphs.ts). Never
 * text and never provenance: the text is the slice of the version's saved copy that main reads itself (through the shared reader of
 * ticket 07, so a part that has since changed, moved or gone still reads as saved), and `fromVersion` is built here from the version's
 * own record. A window or an agent cannot claim a provenance it does not have. The version must be one of this Folio's own.
 *
 * WHERE IT SAYS IT CAME FROM. `origin.path` is the part's current path when that file is still a Markdown file inside the Folio's
 * folder, else the Index Note's path with the part's title as the heading, so the item always lands in the Folio scope and always
 * passes the store's document-path check. A part that was an inserted file is not sendable (use "Save v1 as a copy…").
 *
 * Electron-free; the store and the readers are passed in.
 */
import { existsSync } from 'node:fs'
import { indexNotePath } from './folio'
import { openVersionMembers, readIncomingSection, type VersionReaderSources } from './folio-version-reader'
import type { ScratchpadStore } from './scratchpad-store'
import { paragraphRangeText, versionParagraphs, type VersionParagraph } from '../shared/folio-version-paragraphs'
import type { FolioContentMember } from '../shared/folio-version-records'
import type { ScratchFromVersion, ScratchItem } from '../shared/scratchpad-items'
import type { VersionTextSide } from '../shared/folio-version-scratchpad'

/** A refusal in plain words. Nothing was written. */
export class VersionSendRefused extends Error {
  override readonly name = 'VersionSendRefused'
}

const NOT_THERE = 'That Folio version, or that part of it, is not there. Nothing was sent.'

/** A part of a saved version, read: its text exactly as saved, and who and what it is. */
export type VersionPartText = {
  version: { id: string; name: string; ts: number }
  side: 'version' | 'theirs'
  /** The label the version recorded (for `theirs`, her heading). */
  path: string
  title: string
  order?: number
  writtenBy: string
  /** The Index Note's path, the Folio's identity in a Scratchpad record. */
  folio: string
  /** Where the text now lives: the part's current Markdown file inside the Folio, or null when it is gone or elsewhere. */
  currentPath: string | null
  /** Whether this is the Index Note. */
  index: boolean
  text: string
  paragraphs: VersionParagraph[]
}

const inFolder = (dir: string, path: string): boolean => (dir === '' ? !path.startsWith('/') : path.startsWith(`${dir}/`))

/**
 * Read one part of a saved version for sending or for the agent to read. `part` is the part's recorded path, or its title when that
 * names exactly one text part of the version. Throws `VersionSendRefused` (nothing written, nothing guessed) when the Folio, the version
 * or the part is not there, the part is an inserted file, or its saved text cannot be read.
 */
export async function readVersionPart(sources: VersionReaderSources, dir: string, versionId: string, part: string, side: VersionTextSide = 'version'): Promise<VersionPartText> {
  if (typeof versionId !== 'string' || typeof part !== 'string' || part === '' || part.length > 1000) throw new VersionSendRefused(NOT_THERE)
  const opened = await openVersionMembers(sources, dir, versionId)
  if (!opened) throw new VersionSendRefused(NOT_THERE)
  const { version } = opened
  const folio = indexNotePath(sources.workspace, dir)
  const head = { version: { id: version.id, name: version.name, ts: version.ts }, folio }
  if (side === 'theirs') {
    if (!version.incoming) throw new VersionSendRefused('That version holds no co-author’s revision, so there is no co-author’s text to send. Nothing was sent.')
    const section = await readIncomingSection(sources, dir, versionId, part)
    if (!section) throw new VersionSendRefused(NOT_THERE)
    const current = section.part !== undefined ? currentTextPath(sources, dir, section.part) : null
    return { ...head, side: 'theirs', path: section.heading, title: section.heading, writtenBy: version.incoming.author, currentPath: current, index: false, text: section.text, paragraphs: versionParagraphs(section.text) }
  }
  const texts = opened.members.filter((member) => member.role !== 'inserted')
  const byPath = texts.filter((member) => member.path === part)
  const chosen: FolioContentMember[] = byPath.length > 0 ? byPath : texts.filter((member) => member.title === part)
  if (chosen.length === 0) {
    if (opened.members.some((member) => member.role === 'inserted' && member.path === part)) throw new VersionSendRefused('That is an inserted file, not text. Save its version as a copy instead. Nothing was sent.')
    throw new VersionSendRefused(NOT_THERE)
  }
  if (chosen.length > 1) throw new VersionSendRefused('More than one part has that title in this version. Name the part by its path. Nothing was sent.')
  const member = chosen[0]!
  const bytes = await opened.bytesOf(member)
  if (bytes === null) throw new VersionSendRefused('The saved text of that part is no longer in the history, so nothing was sent.')
  const text = bytes.toString('utf8')
  const isIndex = member.role === 'index'
  const moved = opened.facts.get(member.versionId)?.path
  return {
    ...head, side: 'version', path: member.path, title: member.title ?? member.path.split('/').pop()!.replace(/\.(md|markdown|mdx)$/i, ''),
    ...(member.order !== undefined ? { order: member.order } : {}), writtenBy: version.author.name,
    currentPath: isIndex ? folio : currentTextPath(sources, dir, moved ?? member.path), index: isIndex, text, paragraphs: versionParagraphs(text),
  }
}

/** `path` when it is a Markdown file that exists inside the Folio's folder now; else null. */
function currentTextPath(sources: Pick<VersionReaderSources, 'workspace'>, dir: string, path: string): string | null {
  if (!/\.(md|markdown|mdx)$/i.test(path) || !inFolder(dir, path)) return null
  try { return existsSync(sources.workspace.absolute(path)) ? path : null } catch { return null }
}

/** The part's text as numbered paragraphs, for the agent to read and name a range from. */
export function numberedParagraphs(part: VersionPartText): string {
  if (part.paragraphs.length === 0) return `“${part.title}” has no text in “${part.version.name}”.`
  return part.paragraphs.map((p) => `[${p.n}] ${part.text.slice(p.from, p.to)}`).join('\n\n')
}

/** `from` and `to` are paragraph numbers (1-based, inclusive); both absent means the whole part. */
export type VersionSendRequest = { dir: string; id: string; path: string; side: VersionTextSide; from?: number; to?: number; group?: string | null; /** A group to file under, made only if the send goes ahead (the store makes it with the item). */ groupName?: string }
export type VersionSent = { item: ScratchItem; part: VersionPartText; from: number; to: number; markdown: string }

/**
 * Send paragraphs `from` to `to` of a part of a saved version to the Scratchpad as a new text item that says where it came from.
 * Throws `VersionSendRefused` for a range that is not in the part, and passes the store's own refusals on in its words (nothing to
 * keep, too large, writes paused). Nothing is written unless the item is: a `groupName` is made by the store together with the item,
 * after the Folio, version, part, range and text have all been checked, so a refused send leaves no new group behind.
 */
export async function sendVersionText(deps: { sources: VersionReaderSources; store: ScratchpadStore }, request: VersionSendRequest, by: 'writer' | 'agent'): Promise<VersionSent> {
  const part = await readVersionPart(deps.sources, request.dir, request.id, request.path, request.side)
  const from = request.from ?? 1
  const to = request.to ?? Math.max(1, part.paragraphs.length)
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) throw new VersionSendRefused('Name the paragraphs by number, the first no later than the last. Nothing was sent.')
  // A part with no paragraphs at all is sent as nothing, so the store gives its own "Nothing to keep." in its own words.
  const markdown = part.paragraphs.length === 0 ? '' : sliceOf(part, from, to)
  const origin = part.currentPath ?? part.folio
  const fromVersion: ScratchFromVersion = {
    folio: part.folio, versionId: part.version.id, versionName: part.version.name,
    part: { path: part.path, title: part.title, ...(part.order !== undefined ? { order: part.order } : {}) },
    side: request.side === 'sent' ? 'sent' : part.side, writtenBy: part.writtenBy, at: part.version.ts,
  }
  const item = await deps.store.addText({
    origin, markdown, how: 'copy', by, heading: part.currentPath === null && !part.index ? part.title : null,
    ...(request.group ? { group: request.group } : request.groupName ? { groupName: request.groupName } : {}), fromVersion,
  })
  return { item, part, from, to, markdown }
}

function sliceOf(part: VersionPartText, from: number, to: number): string {
  const last = part.paragraphs.length
  if (to > last) throw new VersionSendRefused(`${paragraphRangeText(from, to)} ${to === from ? 'is' : 'are'} not in “${part.title}”, which has ${last} paragraph${last === 1 ? '' : 's'}. Nothing was sent.`)
  return part.text.slice(part.paragraphs[from - 1]!.from, part.paragraphs[to - 1]!.to)
}
