import { EditorSelection, type ChangeSpec, type EditorState, type StateCommand, type Transaction } from '@codemirror/state'
import { isolateHistory } from '@codemirror/commands'
import { getNodeRange } from '@bridle/outline'
import { blocksForSelection, splitLinePrefix } from './block-marks'
import { skipWriterReviewTracking } from './writer-review'
import { frontmatterSafeInsertPosition } from '../../../shared/object-markup'

/**
 * The text commands of the Actions here menu (docs/design/2026-10-11-actions-here-menu): Duplicate
 * block, Delete block at prose, Clear formatting, and the Turn into targets Code block and Table.
 * (Task list lives with the other block marks in block-marks.ts.)
 *
 * Each is ONE transaction, so undo costs one press. Markdown punctuation these commands write is
 * command-owned, so prose review must not re-author it (the same annotation block-marks.ts carries).
 */

// Isolated history: each command is its own undo step, even when two run within the history's grouping delay.
const owned = { annotations: [skipWriterReviewTracking.of(true), isolateHistory.of('full')], userEvent: 'input', scrollIntoView: true } as const

/**
 * The block the caret is in, as the outline sees it: a paragraph or quotation, a list item WITH its
 * children, a fence, a heading with its section. With a selection that spans blocks, from the first
 * block's start to the last block's end. Trailing newlines are not part of it. Null inside the
 * frontmatter or in an empty document.
 */
export function blockSpanAt(state: EditorState): { from: number; to: number } | null {
  const text = state.doc.toString()
  if (text.length === 0) return null
  const { from: selFrom, to: selTo } = state.selection.main
  const safeStart = frontmatterSafeInsertPosition(text, 0)
  const first = getNodeRange(text, Math.max(selFrom, safeStart))
  // A selection that ends at the very start of a line (a triple-click) does not reach into the next block.
  const lastPosition = selTo > selFrom && state.doc.lineAt(selTo).from === selTo ? selTo - 1 : selTo
  const last = getNodeRange(text, Math.max(lastPosition, safeStart))
  const from = first.from
  const to = from + text.slice(from, Math.max(first.to, last.to)).replace(/\n+$/, '').length
  if (from < safeStart || to <= from) return null
  return { from, to }
}

const LIST_ITEM_LINE = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]/

/** Duplicate block (⇧⌘D): a copy directly after the block, the caret in the copy at the same place. */
export const duplicateBlock: StateCommand = ({ state, dispatch }) => {
  const span = blockSpanAt(state)
  if (!span) return false
  const text = state.sliceDoc(span.from, span.to)
  // A list item's copy is its next sibling (one newline); a paragraph's is a block of its own (a blank line).
  const separator = LIST_ITEM_LINE.test(text) ? '\n' : '\n\n'
  const offset = Math.min(Math.max(state.selection.main.head - span.from, 0), text.length)
  dispatch(state.update({
    changes: { from: span.to, insert: separator + text },
    selection: EditorSelection.cursor(span.to + separator.length + offset),
    ...owned,
  }))
  return true
}

/**
 * Delete block at prose: the paragraph, quotation, or list item with its children, and the blank
 * line that separated it, so the neighbours stay as they were. No confirmation: undo restores it.
 */
export const deleteBlock: StateCommand = ({ state, dispatch }) => {
  const span = blockSpanAt(state)
  if (!span) return false
  const length = state.doc.length
  const runBefore = /\n*$/.exec(state.sliceDoc(Math.max(0, span.from - 8), span.from))![0].length
  const runAfter = /^\n*/.exec(state.sliceDoc(span.to, Math.min(length, span.to + 8)))![0].length
  let from = span.from
  let to = span.to
  if (span.from > 0 && runBefore === 1) from -= 1 // directly under the line above: take that newline
  else if (runAfter > 0) to += runAfter // blank-separated: take the gap after it
  else if (runBefore > 0) from -= runBefore // last block: take the gap before it
  dispatch(state.update({ changes: { from, to }, selection: EditorSelection.cursor(from), ...owned, userEvent: 'delete' }))
  return true
}

/** Where a text is protected from clearing: code spans lose only their backticks; link targets and bare URLs are left alone. */
const PROTECTED = /(`[^`\n]+`)|(\]\([^)\n]*\))|(https?:\/\/[^\s)]+)/g

/** `text` without the inline marks this app writes: ** * ~~ == and inline backticks. */
export function clearInlineMarks(text: string): string {
  const strip = (plain: string): string => plain
    .replace(/\*\*|~~|==/g, '')
    // A lone * is a mark unless it stands apart with space on both sides ("2 * 3").
    .replace(/(?<=\S)\*|\*(?=\S)/g, '')
  let out = ''
  let last = 0
  for (const match of text.matchAll(PROTECTED)) {
    out += strip(text.slice(last, match.index))
    out += match[1] ? match[1].slice(1, -1) : match[0]
    last = match.index + match[0].length
  }
  return out + strip(text.slice(last))
}

/** Marks flanking a selection (the selected text sits between ** **) belong to it. */
const MARK_CHARACTERS = new Set(['*', '~', '=', '`'])

/**
 * Clear formatting: strips the inline marks from the selection, or from the whole block when
 * nothing is selected. Block type (heading hashes, list markers, quote levels), links and the words
 * themselves are untouched. Not `outline.makeParagraph`, which removes the block type.
 */
export const clearFormatting: StateCommand = ({ state, dispatch }) => {
  const spans: Array<{ from: number; to: number }> = []
  for (const range of state.selection.ranges) {
    if (range.empty) {
      for (const block of blocksForSelection(state.update({ selection: range }).state)) spans.push(block)
      continue
    }
    let { from, to } = range
    const line = state.doc.lineAt(from)
    const lineEnd = state.doc.lineAt(to)
    while (from > line.from && MARK_CHARACTERS.has(state.sliceDoc(from - 1, from))) from -= 1
    while (to < lineEnd.to && MARK_CHARACTERS.has(state.sliceDoc(to, to + 1))) to += 1
    spans.push({ from, to })
  }
  const changes: ChangeSpec[] = []
  const covered = new Set<number>()
  for (const span of spans) {
    for (let n = state.doc.lineAt(span.from).number; n <= state.doc.lineAt(span.to).number; n += 1) {
      const line = state.doc.line(n)
      const from = Math.max(line.from, span.from)
      const to = Math.min(line.to, span.to)
      // At the line's start the block's own prefix (hashes, bullet, quote levels) is not text.
      const prefix = from === line.from ? splitLinePrefix(line.text) : null
      const bodyFrom = prefix ? Math.min(to, line.from + prefix.lead.length + prefix.quote.length + prefix.inner.length + prefix.marker.length) : from
      if (covered.has(bodyFrom)) continue
      covered.add(bodyFrom)
      const before = state.sliceDoc(bodyFrom, to)
      const after = clearInlineMarks(before)
      if (after !== before) changes.push({ from: bodyFrom, to, insert: after })
    }
  }
  if (changes.length === 0) return false
  const changeSet = state.changes(changes)
  dispatch(state.update({ changes: changeSet, selection: state.selection.map(changeSet, 1), ...owned }))
  return true
}

/** A fence longer than any run of backticks inside, so the text goes in unchanged. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((run) => run[0].length))
  return '`'.repeat(longest + 1)
}

/** Turn into Code block: the paragraph, or every paragraph the selection touches, inside a fence; the text is unchanged. */
export const turnIntoCodeBlock: StateCommand = ({ state, dispatch }) => {
  const blocks = blocksForSelection(state)
  if (blocks.length === 0) return false
  const from = blocks[0]!.from
  const to = blocks[blocks.length - 1]!.to
  const text = state.sliceDoc(from, to)
  const fence = fenceFor(text)
  dispatch(state.update({
    changes: { from, to, insert: `${fence}\n${text}\n${fence}` },
    selection: EditorSelection.cursor(from + fence.length + 1),
    ...owned,
  }))
  return true
}

const tableCell = (value: string): string => value.trim().replace(/\|/g, '\\|')
const tableRow = (cells: string[], width: number): string => `| ${Array.from({ length: width }, (_, i) => tableCell(cells[i] ?? '')).join(' | ')} |`

/** The rows of selected lines when every line is tab-separated, else when every line is comma-separated; null otherwise. */
function separatedRows(lines: string[]): string[][] | null {
  for (const separator of ['\t', ',']) {
    if (lines.every((line) => line.includes(separator))) return lines.map((line) => line.split(separator))
  }
  return null
}

/**
 * Turn into Table. A paragraph becomes the first cell of a 2 by 2 pipe table. With a selection,
 * tab- or comma-separated lines become the rows (the first is the header); otherwise the selected
 * text becomes the first cell, as for a paragraph.
 */
export const turnIntoTable: StateCommand = ({ state, dispatch }) => {
  const blocks = blocksForSelection(state)
  if (blocks.length === 0) return false
  const from = blocks[0]!.from
  const to = blocks[blocks.length - 1]!.to
  const selected = !state.selection.main.empty
  const lines = state.sliceDoc(from, to).split('\n').filter((line) => line.trim() !== '')
  let rows: string[][] = [[lines.map((line) => splitLinePrefix(line).body.trim()).join(' ')]]
  if (selected) {
    const separated = separatedRows(lines.map((line) => splitLinePrefix(line).body))
    if (separated) rows = separated
  }
  const width = Math.max(2, ...rows.map((row) => row.length))
  if (rows.length < 2) rows.push([])
  const table = [tableRow(rows[0]!, width), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map((row) => tableRow(row, width))].join('\n')
  dispatch(state.update({ changes: { from, to, insert: table }, selection: EditorSelection.cursor(from), ...owned }))
  return true
}

/**
 * Run two state commands as ONE undo step: the second acts on the document the first left. Used for
 * a quotation's Turn into (make it a plain paragraph, then the paragraph target).
 *
 * Every typed line is a block (ADR-0039), so with the caret in one line of a several-line quotation
 * a command touches that line only. `wholeBlock` first selects the whole block the caret is in, so
 * both commands act on all of its lines; the selection it leaves is the second command's.
 */
export function composeCommands(first: StateCommand, second: StateCommand, options: { wholeBlock?: boolean } = {}): StateCommand {
  return ({ state, dispatch }) => {
    const span = options.wholeBlock ? blockSpanAt(state) : null
    const start = span ? state.update({ selection: EditorSelection.range(span.from, span.to) }).state : state
    let middle: Transaction | null = null
    if (!first({ state: start, dispatch: (tr) => { middle = tr } }) || !middle) return false
    const afterFirst = (middle as Transaction).state
    let end: Transaction | null = null
    if (!second({ state: afterFirst, dispatch: (tr) => { end = tr } }) || !end) return false
    const final = end as Transaction
    dispatch(state.update({
      changes: (middle as Transaction).changes.compose(final.changes),
      selection: final.state.selection,
      ...owned,
    }))
    return true
  }
}
