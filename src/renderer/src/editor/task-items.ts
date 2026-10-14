import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import type { EditorState, Line } from '@codemirror/state'
import { LIST_MARKER_SOURCE } from '../../../shared/markdown/fancy-lists'
import { editorViewModeOf } from './view-mode'
import { visibleWriterMarks } from './writer-review'

/**
 * Task-item recognition for the editor (checkbox lists, docs/design/2026-09-27-checkbox-lists,
 * direction 1). A task item is a real list item — its marker is a lezer `ListMark`, so a `- [ ]` inside
 * a code fence is text — whose marker is followed by `[ ]`, `[x]` or `[X]` and whitespace (the GFM
 * rule the exporters parse with, shared/markdown/dialect.ts).
 *
 * In Reviewing a tick is a tracked writer change: the buffer holds the struck old character beside
 * the inserted one (`[ x]`, ' ' marked old). The box state is the bracket read WITHOUT the struck
 * characters, which is exactly what the file will hold (documentTextForPersistence).
 *
 * Pure over EditorState: the drawing layer (task-boxes.ts) and the list indent (list-typography.ts)
 * both read it, so the box and the hanging wrap can never disagree about which lines have a box.
 */
export type TaskBox = {
  /** The `[`. */
  from: number
  /** Just after the `]`. */
  to: number
  /** End of the whitespace after the `]` — the drawn box stands for `from..hideTo`. */
  hideTo: number
  /** The one character a tick rewrites (space ↔ `x`). */
  tick: number
  checked: boolean
  /** The pending writer change inside the brackets (Reviewing only), with its time. */
  change: { createdAt: number } | null
}

/** The drawn box, the air before it (after the marker's own space) and its gap to the words, in em of the prose size (task-boxes.ts draws it). The
 *  hanging wrap (list-typography.ts) advances by their sum in place of the bracket text. */
export const TASK_BOX_LEAD_EM = 0.18
export const TASK_BOX_SIZE_EM = 0.85
export const TASK_BOX_GAP_EM = 0.5
export const TASK_BOX_ADVANCE_EM = TASK_BOX_LEAD_EM + TASK_BOX_SIZE_EM + TASK_BOX_GAP_EM

// Any list marker, lettered and roman included (fancy-lists.ts); isListMark decides it is real.
const TASK_LINE = new RegExp(`^([ \\t]*)(${LIST_MARKER_SOURCE})([ \\t]+)\\[([ xX]{1,3})\\]([ \\t]+)`)
const LIST_MARKER_BEFORE_BRACKET = new RegExp(`^([ \\t]*)(${LIST_MARKER_SOURCE})[ \\t]+\\[( ?)$`)

/** Boxes are drawn in Clean and Markup; Raw shows the brackets as typed. */
export function taskBoxesDrawn(state: EditorState): boolean {
  return editorViewModeOf(state) !== 'raw'
}

/** `parse` lets a command finish parsing up to the line; drawing reads the tree as it stands and
 *  redraws when the parser catches up, so a long document never stalls a frame. */
function isListMark(state: EditorState, pos: number, upto: number, parse = true): boolean {
  const tree = (parse ? ensureSyntaxTree(state, upto, 50) : null) ?? syntaxTree(state)
  return tree.resolveInner(pos, 1).name === 'ListMark'
}

/** The task box on `line`, or null for a plain item, prose, or list-looking text in code. */
export function taskBoxOnLine(state: EditorState, line: Line, parse = true): TaskBox | null {
  const match = TASK_LINE.exec(line.text)
  if (!match) return null
  const markerPos = line.from + match[1].length
  if (!isListMark(state, markerPos, line.to, parse)) return null
  const from = markerPos + match[2].length + match[3].length
  const to = from + match[4].length + 2
  const marks = visibleWriterMarks(state).filter((mark) => mark.from < to && mark.to > from)
  const struck = (pos: number): boolean => marks.some((mark) => mark.role === 'old' && pos >= mark.from && pos < mark.to)
  const live: number[] = []
  for (let pos = from + 1; pos < to - 1; pos += 1) if (!struck(pos)) live.push(pos)
  if (live.length !== 1) return null
  const tick = live[0]
  const checked = state.doc.sliceString(tick, tick + 1) !== ' '
  const change = marks.length > 0 ? { createdAt: Math.max(...marks.map((mark) => mark.createdAt)) } : null
  return { from, to, hideTo: to + match[5].length, tick, checked, change }
}

/** Every task box on the lines touching `from..to`, in document order. */
export function taskBoxesIn(state: EditorState, from: number, to: number, parse = true): Array<TaskBox & { line: Line }> {
  const boxes: Array<TaskBox & { line: Line }> = []
  for (let number = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number; number <= last; number += 1) {
    const line = state.doc.line(number)
    const box = taskBoxOnLine(state, line, parse)
    if (box) boxes.push({ ...box, line })
  }
  return boxes
}

/**
 * The typed-box rule: `]` typed after `- [` or `- [ ` (any list marker) closes a box. Returns the
 * start of the `[` when `pos` is such a place, else null. The auto-closed `]` smart pairs leave
 * behind is the caller's concern.
 */
export function openBracketBeforeClose(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos)
  const match = LIST_MARKER_BEFORE_BRACKET.exec(line.text.slice(0, pos - line.from))
  if (!match) return null
  if (!isListMark(state, line.from + match[1].length, line.to)) return null
  return pos - 1 - match[3].length
}
