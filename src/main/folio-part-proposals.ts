/**
 * Proposals that give a Folio's parts the title rule (shared/folio-part-title.ts), and the one direct write
 * the Plan's per-part choice makes. Nothing here changes a part's text by itself except `setPartHeadingMode`,
 * which is the owner's own click on the Plan:
 *
 * - A part whose first heading is not its title, or that does not open with a heading (a heading further
 *   down is never its title: `atTopOfBody`), and no `heading: none`: a pending change adds `# Title` at
 *   the top (from frontmatter `title`, else the file name) and sets `title` to match.
 * - A part whose first heading is its title, at any level (`#`, `##`, `###`; letter case, footnote
 *   references and inline markers aside): that is its heading. Nothing is proposed about it: never a lift of
 *   its levels, never removing a repeated title, never a second `# Title`. A frontmatter `title` that differs
 *   from it gets no proposal either: the owner fixes it with the title-conflict buttons (shared/title-conflict.ts).
 *   An undecided "Make the title match the heading" filed before is closed as `superseded`.
 * - Such a part's still-undecided "Add the heading “Title”" of WriteFlex's for that title (filed under the
 *   older rule; accepting it would write the title twice) is closed as `superseded`, through
 *   `ChangeStore.closeMany`, inside the write turn.
 * - A part with `heading: none`: nothing, ever.
 * - A front-matter part (a title page: shared/folio-front-matter.ts): nothing, ever; it has no heading by
 *   design. Its undecided "Add the heading" of WriteFlex's is closed as `superseded`, as a stale add is.
 *
 * Each proposal is a stated range replacement of the part's lines (ADR-0039: the file is never rewritten
 * wholesale), recorded in the change ledger as an agent-provenance `housekeeping` change,
 * exactly the shape Accept already applies from the ledger, filed under WriteFlex's own author
 * (WRITEFLEX_SELF_AUTHOR), which is how the margin knows it (shared/part-title-proposal.ts). A proposal that
 * already sits in the ledger (pending, held, accepted, or rejected by the writer; not one WriteFlex itself
 * closed) is not made again, so opening a Folio again never nags; that check is by path and text, not
 * author, so proposals filed under the older 'WriteFlex Agent' author still count.
 */

import { posix } from 'node:path'
import { orderFor } from './folio'
import { readFolioFrontMatter } from './plan'
import { closedReasonOf, undecided, type Change, type ChangeStore } from './changes'
import { fingerprintOfRead, readDocumentFile } from './guarded-document-read'
import { WRITEFLEX_SELF_AUTHOR } from './versions'
import { ChangedSinceRead, DocumentChangedError, type Workspace } from './workspace'
import { basisAllows, type SaveBasis } from '../shared/save-basis'
import { FRONTMATTER_KEY_VALUE } from '../shared/markdown/frontmatter'
import { layoutOf, withFrontmatterKey, yamlScalar } from '../shared/markdown/frontmatter-edit'
import { partTitleWithHeading, sameTitle, withTopHeading, type PartTitle } from '../shared/folio-part-title'
import { addedHeadingText, isAddHeadingProposal, isMatchTitleProposal, isUnsafeLegacyAddHeading } from '../shared/part-title-proposal'
import type { Unplaceable } from './outside-change'

/** A part over this size is not read for a proposal (the Outline does not read it either). */
const MAX_PART_BYTES = 2 * 1024 * 1024

/** The text without frontmatter `key`; an emptied block goes with it. */
function withoutFrontmatterKey(source: string, key: string): string {
  const layout = layoutOf(source)
  if (!layout) return source
  const index = layout.lines.findIndex((item) => FRONTMATTER_KEY_VALUE.exec(item.text)?.[1] === key)
  if (index < 0) return source
  let last = index
  if ((FRONTMATTER_KEY_VALUE.exec(layout.lines[index].text)?.[2] ?? '').trim() === '') {
    while (last + 1 < layout.lines.length && /^[ \t]*-/.test(layout.lines[last + 1].text)) last += 1
  }
  const from = layout.lines[index].start
  const to = last + 1 < layout.lines.length ? layout.lines[last + 1].start : layout.closeStart
  const without = source.slice(0, from) + source.slice(to)
  const rest = layoutOf(without)
  if (rest && rest.lines.every((item) => item.text.trim() === '')) {
    // Nothing else in the block: the block and one blank line after it go.
    const after = without.slice(rest.end)
    return without.slice(0, rest.bom) + after.replace(/^[ \t]*\r?\n/, '')
  }
  return without
}

/**
 * What the title rule would make of a part's text, or null when the part is already as the rule wants it
 * (or must not be touched: `heading: none`). The pure core of every proposal. A first heading that is the
 * title, at any level, is the part's own heading: its level is the writer's, and a title written twice is
 * the writer's too. WriteFlex never proposes moving a heading's level or removing a heading (the export
 * leaves out the title it prints itself: `withoutOwnHeading`).
 */
export type PartTitleFix = { next: string; summary: string }

export function partTitleFix(source: string, path: string): PartTitleFix | null {
  return fixFor(source, partTitleWithHeading(source, path).named)
}

function fixFor(source: string, named: PartTitle): PartTitleFix | null {
  if (named.mode === 'none') return null
  // A part with its own heading: nothing is proposed. A title that differs from it is fixed by the owner's
  // own click (the title-conflict buttons, shared/title-conflict.ts), not by a waiting change.
  if (named.mode === 'own') return null
  const title = named.title
  const withTitle = named.frontmatterTitle === null ? withFrontmatterKey(source, 'title', yamlScalar(title)) : source
  if (withTitle === null) return null
  const next = withTopHeading(withTitle, title)
  // A title that would not read back as one top heading (a line break, a fence) or a top setext heading: nothing is proposed.
  if (next === null) return null
  return {
    next,
    summary: named.frontmatterTitle === null ? `Add the heading “${title}” and a matching title` : `Add the heading “${title}”`,
  }
}

const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text: string, at: number): number => { const n = text.indexOf('\n', at); return n === -1 ? text.length : n }

export type PartTitleReplacement = { oldText: string; newText: string; anchor: { from: number; to: number } }

/** `source` → `next` as one replacement of whole lines near the top, unique in `source` so Accept can find it. */
export function replacementFor(source: string, next: string): PartTitleReplacement | null {
  if (source === next) return null
  let head = 0
  while (head < source.length && head < next.length && source[head] === next[head]) head += 1
  let tail = 0
  while (tail < source.length - head && tail < next.length - head && source[source.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1
  let from = lineStart(source, head)
  const to = Math.max(lineEnd(source, source.length - tail), from)
  const unique = (start: number): PartTitleReplacement | null => {
    const oldText = source.slice(start, to)
    if (oldText === '') return null
    const newText = next.slice(start, next.length - (source.length - to))
    return source.indexOf(oldText) === source.lastIndexOf(oldText) ? { oldText, newText, anchor: { from: start, to } } : null
  }
  return unique(from) ?? unique(0) ?? (source === '' ? { oldText: '', newText: next, anchor: { from: 0, to: 0 } } : { oldText: source, newText: next, anchor: { from: 0, to: source.length } })
}

export type PartTitleProposals = { proposed: number; flagged: number; withdrawn: number }

const NOTHING: PartTitleProposals = { proposed: 0, flagged: 0, withdrawn: 0 }

/**
 * Stage the title proposals for every part of the Folio at `dir` (its running order, or the fallback order
 * of a Folio with no manifest). Returns how many were newly recorded, how many parts the rule would change
 * (`flagged`, whether or not their proposal was already in the ledger), and how many stale add-a-heading
 * proposals were closed as superseded. Never writes a part; its only ledger writes are `add` and `closeMany`.
 * Each part is read, judged, closed and filed inside one turn of the Collection's write lock
 * (`ws.exclusiveAll`, as the ledger's own doors), so an Accept never lands between the read and the filing.
 */
export async function proposePartTitles(ws: Workspace, changes: ChangeStore, dir: string): Promise<PartTitleProposals> {
  const parts = [...new Set(await orderFor(ws, dir))]
  const frontMatter = await readFolioFrontMatter(ws, dir).catch(() => new Set<string>())
  const total = { ...NOTHING }
  // The retired kind is closed from the records, not from the running order: a part taken out of it since
  // its proposal was filed keeps no open "Make the title match the heading" either.
  total.withdrawn += await ws.exclusiveAll(() => closeRetiredTitleMatches(changes, dir, parts))
  for (const path of parts) {
    const one = await ws.exclusiveAll(() => (frontMatter.has(path) ? closeFrontMatterAdds(changes, path) : proposeForPart(ws, changes, path)))
    total.proposed += one.proposed
    total.flagged += one.flagged
    total.withdrawn += one.withdrawn
  }
  return total
}

async function proposeForPart(ws: Workspace, changes: ChangeStore, path: string): Promise<PartTitleProposals> {
  let source: string
  try {
    const file = await ws.readFile(path)
    if (file.content.length > MAX_PART_BYTES) return NOTHING
    source = file.content
  } catch { return NOTHING }
  const { named, heading } = partTitleWithHeading(source, path)
  const known = await changes.list({ path })
  // The part already has its title as a heading: an undecided add-a-heading of WriteFlex's for that title
  // (filed under the older rule, which did not see a lower-level title) would write it twice.
  const withdrawn = named.mode === 'own' && heading ? await closeStaleAdds(changes, known, heading.text) : 0
  const fix = fixFor(source, named)
  const replacement = fix ? replacementFor(source, fix.next) : null
  // A part with no title heading: every undecided add-a-heading of WriteFlex's that is not exactly what the
  // rule proposes now (filed by an older version, over older text, or with a title that is no longer safe) is
  // closed, so it can never be accepted.
  const obsolete = named.mode === 'missing' ? await closeObsoleteAdds(changes, known, replacement) : 0
  if (!fix) return { ...NOTHING, withdrawn: withdrawn + obsolete }
  if (!replacement) return { ...NOTHING, flagged: 1, withdrawn: withdrawn + obsolete }
  // The same text already in the ledger, by any author (older ledgers), and not closed by WriteFlex itself:
  // nothing new to file. A record WriteFlex closed does not count, so the change can be filed again.
  if (known.some((change) => change.provenance === 'agent' && closedReasonOf(change) === null
    && change.oldText === replacement.oldText && change.newText === replacement.newText)) return { proposed: 0, flagged: 1, withdrawn: withdrawn + obsolete }
  await changes.add({
    path,
    provenance: 'agent',
    editClass: replacement.oldText === '' ? 'insert' : 'housekeeping',
    category: 'structure',
    summary: fix.summary,
    oldText: replacement.oldText,
    newText: replacement.newText,
    anchor: replacement.anchor,
    ...(replacement.oldText === '' ? { insertAfter: '' } : {}),
    isCorrection: false,
    // The tag the margin reads (shared/part-title-proposal.ts); nothing else files under this author.
    author: WRITEFLEX_SELF_AUTHOR,
  })
  return { proposed: 1, flagged: 1, withdrawn: withdrawn + obsolete }
}

/** Close, as `superseded`, every undecided add-a-heading of WriteFlex's among `known` whose stored text is not
 *  `current` (the replacement the rule proposes now; null: none); returns how many closed. */
async function closeObsoleteAdds(changes: ChangeStore, known: Change[], current: PartTitleReplacement | null): Promise<number> {
  const stale = known.filter((change) => isAddHeadingProposal(change) && undecided(change)
    && !(current && change.oldText === current.oldText && change.newText === current.newText))
  if (stale.length === 0) return 0
  return (await changes.closeMany(stale.map((change) => ({
    id: change.id,
    code: 'superseded' as const,
    reason: 'Closed by WriteFlex: this part or its title has changed since this heading was proposed, so it is no longer what WriteFlex would add.',
  })))).length
}

export const ADD_HEADING_NO_LONGER_SAFE = 'WriteFlex no longer proposes this heading: the part already has one, has changed, or its title cannot be written as one heading line. Nothing was written.'

/**
 * The Accept-time check of an add-a-heading change of WriteFlex's: it is applied only when the text it would
 * leave is exactly what the title rule proposes for the part now (`partTitleFix`), so one left behind after the
 * part got its heading another way, or with a title no longer safe, never writes. A 'WriteFlex Agent' change
 * with the add-a-heading summary (older versions' author) is refused only when unsafe (`isUnsafeLegacyAddHeading`:
 * a line break in the title, or a new code-fence line). Any other change: null.
 */
export function addHeadingAcceptRefusal(change: Change, content: string, next: string): Unplaceable | null {
  // Filed by a version before WriteFlex had its own author: refused only when it would write a line break or
  // a code fence from an unchecked title; otherwise applied as before (it may be an ordinary agent edit).
  if (isUnsafeLegacyAddHeading(change)) return { reason: ADD_HEADING_NO_LONGER_SAFE, code: 'superseded' }
  if (!isAddHeadingProposal(change)) return null
  const fix = partTitleFix(content, change.path)
  return fix && fix.next === next ? null : { reason: ADD_HEADING_NO_LONGER_SAFE, code: 'superseded' }
}

/** Close, as `superseded` through the ledger's own door, every undecided add-a-heading of WriteFlex's among
 *  `known` that adds `title`, which the part already has as a heading; returns how many closed. */
async function closeStaleAdds(changes: ChangeStore, known: Change[], title: string): Promise<number> {
  return closeAdds(changes, known, (adds) => sameTitle(adds, title),
    `Closed by WriteFlex: this part already has the heading “${title}”, so adding it would write the title twice.`)
}

/** A front-matter part: every undecided add-a-heading of WriteFlex's for it is closed as `superseded`; nothing is filed. */
async function closeFrontMatterAdds(changes: ChangeStore, path: string): Promise<PartTitleProposals> {
  const withdrawn = await closeAdds(changes, await changes.list({ path }), () => true,
    'Closed by WriteFlex: this part is front matter (a title page), which has no heading by design; its title comes from its frontmatter.')
  return { ...NOTHING, withdrawn }
}

async function closeAdds(changes: ChangeStore, known: Change[], matches: (adds: string) => boolean, reason: string): Promise<number> {
  const stale = known.filter((change) => {
    const adds = addedHeadingText(change)
    return adds !== null && undecided(change) && matches(adds)
  })
  if (stale.length === 0) return 0
  return (await changes.closeMany(stale.map((change) => ({ id: change.id, code: 'superseded' as const, reason })))).length
}

/** Close, as `superseded`, every undecided "Make the title match the heading" of WriteFlex's in the Folio's
 *  change records: any file under the Folio's folder `dir` ('' = the workspace root), or one of its `parts`,
 *  whether or not it is still in the running order. That kind is retired (the title-conflict buttons fix it
 *  in one click). Returns how many closed. */
async function closeRetiredTitleMatches(changes: ChangeStore, dir: string, parts: readonly string[]): Promise<number> {
  const listed = new Set(parts)
  const ofFolio = (path: string): boolean => dir === '' || path.startsWith(`${dir}/`) || listed.has(path)
  const retired = (await changes.list()).filter((change) => ofFolio(change.path) && isMatchTitleProposal(change) && undecided(change))
  if (retired.length === 0) return 0
  return (await changes.closeMany(retired.map((change) => ({
    id: change.id,
    code: 'superseded' as const,
    reason: 'Closed by WriteFlex: when the title and the heading differ, the Folio outline, the Outline and the document now offer “Use heading as title” and “Use title as heading”.',
  })))).length
}

/** The part changed between reading it and writing its heading choice; nothing was written. */
export class PartChangedError extends Error {
  override readonly name = 'PartChangedError'
  /** `diskText`: what was on disk when the refusal was made (null: no file there), when the refusing check
   *  read it; the owner route raises the changed-on-disk notice for exactly that version. */
  constructor(readonly path: string, readonly diskText?: string | null) {
    super(`${path} changed while its heading choice was being saved, so nothing was written. Choose again.`)
  }
}

/**
 * The Plan's choice per part: "No heading in the text" writes `heading: none` into the part's frontmatter,
 * "Has its own heading" removes it. The owner's own click, so it is written directly (the caller takes the
 * checkpoint first); the part's text is otherwise untouched. Returns the paths written (none when already so).
 */
export async function setPartHeadingMode(
  ws: Workspace,
  path: string,
  mode: 'own' | 'none',
  beforeWrite?: (path: string) => Promise<void>,
  /** The version the open document's buffer is based on (the save fix's owner route, as goal:set): nothing is
   *  written unless the part read is that version. Absent: the part is not open in the editor. */
  basis?: SaveBasis,
): Promise<string[]> {
  if (posix.extname(path).toLowerCase() === '' || path.includes('..')) throw new Error('That is not a part of this Folio.')
  // The read is outside the write turn, so the save carries the fingerprint of the bytes `next` was worked out
  // from: an editor save in between makes it refuse, writing nothing, instead of putting back the stale text.
  const read = await readDocumentFile(ws, path)
  const { content } = read
  if (basis !== undefined && !basisAllows(basis, content)) throw new PartChangedError(path, content)
  const next = mode === 'none' ? withFrontmatterKey(content, 'heading', 'none') : withoutFrontmatterKey(content, 'heading')
  if (next === null) throw new Error('This part already says how it handles its heading in a form WriteFlex will not edit. Change it in the file.')
  if (next === content) return []
  await beforeWrite?.(path)
  try {
    // Only over the text read (R5): compared before and in the rename tick, as well as by the fingerprint.
    await ws.saveFileOverRead(path, next, content, { documentOnly: true, expect: { fingerprint: fingerprintOfRead(read) } })
  } catch (error) {
    if (error instanceof ChangedSinceRead) throw new PartChangedError(path, error.diskText)
    if (error instanceof DocumentChangedError) throw new PartChangedError(path)
    throw error
  }
  return [path]
}
