/**
 * How a change WriteFlex itself filed for a Folio part's title is recognised (main/folio-part-proposals.ts).
 * Those changes, and only those, carry the author `WRITEFLEX_SELF_AUTHOR_NAME`. No other writer of the ledger
 * can produce it: the in-app agent bridge always files under WRITEFLEX_AGENT_AUTHOR ('WriteFlex Agent'), the
 * command line's outside Changes take their author from the closed source list (Claude Code, Codex, Outside
 * agent) together with an outside source, and the renderer's `changes:add` door refuses this author
 * (main/ipc.ts). Recognition is that author plus the shape those proposals always have (agent provenance, the
 * `structure` category, no outside source); the summary text is not trusted for it.
 *
 * Ledgers written before this author existed hold proposals under 'WriteFlex Agent': those show as ordinary
 * agent changes (label "Agent", no "No heading in the text" item). They can still be accepted or rejected; an
 * unsafe add-a-heading one among them is refused at Accept (`isUnsafeLegacyAddHeading`).
 */

type ProposalShape = {
  provenance: string
  category?: string | null
  summary: string
  author?: { name: string }
  outsideSource?: unknown
}

/** The author name only main/folio-part-proposals.ts files changes under. */
export const WRITEFLEX_SELF_AUTHOR_NAME = 'WriteFlex'

/** The add-a-heading kind's own summary (set by folio-part-proposals.ts; read only after the author has matched). */
const ADDS_HEADING = /^Add the heading “/
const ADDED_HEADING_TEXT = /^Add the heading “(.*)”(?: and a matching title)?$/s

/** A part-title proposal of either kind (adds a heading, or makes the title match the heading). */
export function isPartTitleProposal(change: ProposalShape): boolean {
  return change.provenance === 'agent'
    && change.category === 'structure'
    && change.author?.name === WRITEFLEX_SELF_AUTHOR_NAME
    && change.outsideSource === undefined
}

/** The kind that adds a `# Title` line: the only one that can be answered with "No heading in the text". */
export function isAddHeadingProposal(change: ProposalShape): boolean {
  return isPartTitleProposal(change) && ADDS_HEADING.test(change.summary)
}

/** The author every part-title proposal was filed under before WriteFlex had its own (WRITEFLEX_AGENT_AUTHOR,
 *  main/versions.ts). The in-app agent bridge still files under it, so neither the author nor the summary
 *  proves a change is an older add-a-heading: such changes are never closed by shape, only checked at Accept. */
const LEGACY_AUTHOR_NAME = 'WriteFlex Agent'

/** A line break of any kind a heading line must not hold. */
const LINE_BREAK = /[\r\n\u2028\u2029]/
/** A line that opens (or closes) a code fence. */
const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,})/
const fenceLines = (text: string | null | undefined): number =>
  (text ?? '').split(/\r\n|\n|\r|\u2028|\u2029/).filter((line) => FENCE_LINE.test(line)).length

/**
 * A 'WriteFlex Agent' change whose summary reads "Add the heading “X”" that must not be applied: older
 * versions put the title in unchecked, so X with a line break, or a new text that adds a code-fence line the
 * old text did not have, would write an injected block. Any other 'WriteFlex Agent' change, including an
 * ordinary agent edit with such a summary, applies as before (main/folio-part-proposals.ts
 * `addHeadingAcceptRefusal`).
 */
export function isUnsafeLegacyAddHeading(change: ProposalShape & { oldText?: string | null; newText?: string | null }): boolean {
  if (change.author?.name !== LEGACY_AUTHOR_NAME) return false
  const title = ADDED_HEADING_TEXT.exec(change.summary)?.[1]
  if (title === undefined) return false
  return LINE_BREAK.test(title) || fenceLines(change.newText) > fenceLines(change.oldText)
}

/** The retired kind (title-conflict buttons, 2026-10-19): "Make the title match the heading “X”". No longer
 *  filed; an undecided one is closed as superseded (main/folio-part-proposals.ts). */
const MATCHES_TITLE = /^Make the title match the heading “/

export function isMatchTitleProposal(change: ProposalShape): boolean {
  return isPartTitleProposal(change) && MATCHES_TITLE.test(change.summary)
}

/** The heading text an add-a-heading proposal adds (`# T`), read from its own summary; null for any other change. */
export function addedHeadingText(change: ProposalShape): string | null {
  if (!isAddHeadingProposal(change)) return null
  return ADDED_HEADING_TEXT.exec(change.summary)?.[1] ?? null
}
