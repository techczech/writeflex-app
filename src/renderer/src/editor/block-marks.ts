import { EditorSelection, type ChangeDesc, type ChangeSpec, type EditorState, type StateCommand } from '@codemirror/state'
import { blockRangesOf, type ParagraphRange } from './focus-modes'
import { skipWriterReviewTracking } from './writer-review'

/**
 * The drawn BLOCK verbs of the action bar (ADR-0040,
 * docs/design/2026-08-28-quality-of-life-0-21/action-bar-hifi-v1.html): bullet list, ordered list,
 * blockquote and the pilcrow's "plain paragraph".
 *
 * Three rules hold all of them together:
 *
 *  - **One definition of a block.** "The block I am in" is ADR-0039's rule and nothing else, read
 *    through `blockRangesOf` in focus-modes.ts. This file never re-decides where a block starts.
 *  - **Only the prefix is rewritten.** Every change replaces the run of indent / `>` / marker at the
 *    START of a line and nothing after it, so prose the writer did not select is never touched, and
 *    the whole command is ONE transaction — one undo step back to the exact prior bytes.
 *  - **A toggle is symmetrical.** Applying a toggle to text that lacks its mark and applying it
 *    again returns the original bytes exactly; applying it to text that HAS the mark strips it, and
 *    applying it again puts the canonical mark back.
 *  - **The caret stays in the WORDS.** A mark is punctuation the command owns, so no verb ever
 *    leaves the caret inside or in front of a marker it just wrote. See
 *    `selectionAfterPrefixChanges`.
 */

/** A line split into the prefix run this file owns and the body it must never touch. */
type LinePrefix = {
  /** Whitespace before any `>` quote markers. */
  lead: string
  /** The `>` levels, each with the space that follows it. */
  quote: string
  /** Whitespace between the last `>` and the block marker. */
  inner: string
  /** The list bullet, ordered number or heading hashes, with its trailing space. */
  marker: string
  kind: 'bullet' | 'ordered' | 'heading' | 'none'
  /** Everything after the prefix. Never rewritten. */
  body: string
}

// A task item's checkbox belongs to its bullet: "- [ ] " is one marker, so turning a task into a paragraph or another list leaves no stray "[ ] ".
const BULLET = /^([-+*])([ \t]+)(?:\[[ xX]\][ \t]+)?/
const ORDERED = /^(\d{1,9}[.)])([ \t]+)/
const HEADING = /^(#{1,6})([ \t]+|$)/

export function splitLinePrefix(line: string): LinePrefix {
  const lead = /^[ \t]*/.exec(line)![0]
  let rest = line.slice(lead.length)
  let quote = ''
  for (;;) {
    const level = /^>[ \t]?/.exec(rest)
    if (!level) break
    quote += level[0]
    rest = rest.slice(level[0].length)
  }
  const inner = /^[ \t]*/.exec(rest)![0]
  rest = rest.slice(inner.length)

  const bullet = BULLET.exec(rest)
  if (bullet) return { lead, quote, inner, marker: bullet[0], kind: 'bullet', body: rest.slice(bullet[0].length) }
  const ordered = ORDERED.exec(rest)
  if (ordered) return { lead, quote, inner, marker: ordered[0], kind: 'ordered', body: rest.slice(ordered[0].length) }
  const heading = HEADING.exec(rest)
  if (heading) return { lead, quote, inner, marker: heading[0], kind: 'heading', body: rest.slice(heading[0].length) }
  return { lead, quote, inner, marker: '', kind: 'none', body: rest }
}

/** The prefix as it stands — the exact span a change may replace. */
const prefixOf = (split: LinePrefix): string => split.lead + split.quote + split.inner + split.marker

/**
 * The blocks the selection touches, by ADR-0039's rule.
 *
 * A caret on a BLANK line has no block — `blockRangesOf` yields none there, and that is the rule,
 * not an oversight. Rather than leave the drawn button dead where a writer most often reaches for
 * it (an empty line, about to start a list), the caret's own line stands in for the missing block.
 * That is a fallback for "no block", not a second answer to "where does a block start".
 */
export function blocksForSelection(state: EditorState): ParagraphRange[] {
  const blocks = blockRangesOf(state.doc.toString())
  const touched: ParagraphRange[] = []
  for (const range of state.selection.ranges) {
    if (range.empty) {
      const block = blocks.find((candidate) => range.head >= candidate.from && range.head <= candidate.to)
      const line = state.doc.lineAt(range.head)
      touched.push(block ?? { from: line.from, to: line.to })
      continue
    }
    for (const block of blocks) {
      if (block.from < range.to && block.to > range.from) touched.push(block)
    }
  }
  const seen = new Set<number>()
  return touched
    .filter((block) => (seen.has(block.from) ? false : (seen.add(block.from), true)))
    .sort((a, b) => a.from - b.from)
}

/** The line numbers a block covers (a block is one typed line, plus any list continuation lines). */
function linesOf(state: EditorState, block: ParagraphRange): number[] {
  const first = state.doc.lineAt(block.from).number
  const last = state.doc.lineAt(block.to).number
  const numbers: number[] = []
  for (let n = first; n <= last; n += 1) numbers.push(n)
  return numbers
}

/**
 * Where the selection belongs once the prefixes have been rewritten.
 *
 * CodeMirror maps the selection through a change on its own, but an insertion that begins EXACTLY
 * at a caret is ambiguous — the caret can end up on either side of the inserted text — and the
 * default answer is the near side. That is the 2026-09-12 defect: pressing the numbered-list button
 * on an empty line wrote `1. ` and left the caret in front of it, so the writer's next keystroke
 * landed before the marker (`dsds1.`).
 *
 * A `ChangeSpec` has no association to set: in CodeMirror association is chosen where a position is
 * MAPPED, not where a change is described. So the transaction states its selection outright and
 * maps each endpoint with the association that keeps it in the writer's words:
 *
 *  - a **caret** maps to the FAR side of inserted marker text (assoc 1), so an empty block leaves
 *    the caret ready to type the item, and a caret that sat before the first character of a line
 *    ends up after the marker rather than in front of it. A caret already in the words is past the
 *    rewritten span and simply shifts with it; a caret inside a marker that was stripped lands at
 *    the start of the words, never at some column the writer did not ask for;
 *  - a **real selection** maps its start to the far side and its end to the NEAR side, so it goes
 *    on covering the same text instead of swallowing the punctuation added around it. This is what
 *    CodeMirror's own mapping does for a non-empty range today; it is stated here anyway so the
 *    whole rule reads in one place rather than half of it living in a library default.
 *
 * The selection rides in the SAME transaction as the changes, so it is part of the one history
 * event: undo still costs exactly one press and a selection move is never its own step.
 */
function selectionAfterPrefixChanges(state: EditorState, changes: ChangeDesc): EditorSelection {
  const ranges = state.selection.ranges.map((range) => {
    if (range.empty) return EditorSelection.cursor(changes.mapPos(range.head, 1))
    const from = changes.mapPos(range.from, 1)
    const to = changes.mapPos(range.to, -1)
    // Both ends can collapse onto the same point when everything between them was a marker.
    if (from >= to) return EditorSelection.cursor(Math.min(from, to))
    return range.anchor <= range.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
  })
  return EditorSelection.create(ranges, state.selection.mainIndex)
}

/** Dispatch one transaction for a set of prefix rewrites. Returns false when nothing would change. */
function applyPrefixChanges(
  { state, dispatch }: Parameters<StateCommand>[0],
  rewrite: (split: LinePrefix, context: { line: number; firstOfBlock: boolean; ordinal: number }) => string,
): boolean {
  const blocks = blocksForSelection(state)
  if (blocks.length === 0) return false
  const changes: ChangeSpec[] = []
  blocks.forEach((block, index) => {
    const lines = linesOf(state, block)
    for (const number of lines) {
      const line = state.doc.line(number)
      const split = splitLinePrefix(line.text)
      const before = prefixOf(split)
      const after = rewrite(split, { line: number, firstOfBlock: number === lines[0], ordinal: index + 1 })
      if (after === before) continue
      changes.push({ from: line.from, to: line.from + before.length, insert: after })
    }
  })
  if (changes.length === 0) return false
  const changeSet = state.changes(changes)
  // One transaction: one history event, so undo restores the exact prior bytes in a single step.
  dispatch(state.update({
    changes: changeSet,
    // The caret is the writer's, not the marker's — see selectionAfterPrefixChanges.
    selection: selectionAfterPrefixChanges(state, changeSet),
    // Block markers are command-owned Markdown punctuation, exactly like the `**` of ⌘B — prose
    // review must not re-author them (editor/commands.ts carries the same annotation and the reason).
    annotations: skipWriterReviewTracking.of(true),
    userEvent: 'input',
    scrollIntoView: true,
  }))
  return true
}

/** The first line of each selected block — the line that carries a list marker or heading hashes. */
function firstLineSplits(state: EditorState): LinePrefix[] {
  return blocksForSelection(state).map((block) => splitLinePrefix(state.doc.lineAt(block.from).text))
}

/** A list toggle: on when EVERY selected block already leads with that marker kind. */
function listCommand(kind: 'bullet' | 'ordered', markerFor: (ordinal: number) => string): StateCommand {
  return (target) => {
    const splits = firstLineSplits(target.state)
    const active = splits.length > 0 && splits.every((split) => split.kind === kind)
    return applyPrefixChanges(target, (split, context) => {
      if (!context.firstOfBlock) return prefixOf(split)
      // Adding replaces whatever block marker the line carried (a heading, the other list kind), so
      // "make this a bullet" never leaves `- # Heading` behind. The quote level is left alone: a
      // list inside a quote is real nesting, not a competing mark.
      const marker = active ? '' : markerFor(context.ordinal)
      return split.lead + split.quote + split.inner + marker
    })
  }
}

/** Bullet list — the drawn `list` verb. */
export const toggleBulletList = listCommand('bullet', () => '- ')

/** Ordered list — numbered across the selected blocks in document order. */
export const toggleOrderedList = listCommand('ordered', (ordinal) => `${ordinal}. `)

/**
 * Task list — the Turn into target. NOT a toggle: every selected block becomes one unticked task
 * (`- [ ] text`), replacing a heading's hashes or another list's marker; a block that is already a
 * task keeps its tick. A selection spanning paragraphs gives one task per paragraph.
 */
export const makeTaskList: StateCommand = (target) =>
  applyPrefixChanges(target, (split, context) => {
    if (!context.firstOfBlock) return prefixOf(split)
    const alreadyTask = split.kind === 'bullet' && /\[[ xX]\]/.test(split.marker)
    return split.lead + split.quote + split.inner + (alreadyTask ? split.marker : '- [ ] ')
  })

/**
 * Blockquote — one `>` level on every line of every selected block (a quote marker is per LINE in
 * Markdown, so a list-continuation block must carry it on both of its lines or it stops being one
 * quote). Nesting is preserved: quoting a bullet keeps the bullet.
 */
export const toggleBlockquote: StateCommand = (target) => {
  const splits = firstLineSplits(target.state)
  const active = splits.length > 0 && splits.every((split) => split.quote !== '')
  return applyPrefixChanges(target, (split) => {
    if (active) {
      const level = /^>[ \t]?/.exec(split.quote)
      const quote = level ? split.quote.slice(level[0].length) : split.quote
      return split.lead + quote + split.inner + split.marker
    }
    return `${split.lead}> ${split.quote}${split.inner}${split.marker}`
  })
}

/**
 * Plain paragraph — the drawing's pilcrow. NOT a toggle: it strips every block mark from the
 * selected blocks (heading hashes, list markers, quote levels) and applying it again changes
 * nothing. Indentation survives, because indentation is the writer's, not a mark.
 */
export const makePlainParagraph: StateCommand = (target) =>
  applyPrefixChanges(target, (split) => split.lead)
