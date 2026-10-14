import { isolateHistory } from '@codemirror/commands'
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { Prec, RangeSetBuilder, type EditorState, type Extension, type StateCommand, type Transaction, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { LIST_MARKER_SOURCE } from '../../../shared/markdown/fancy-lists'
import { inlineChangeRanges } from './inline-changes'
import { TASK_BOX_GAP_EM, TASK_BOX_LEAD_EM, TASK_BOX_SIZE_EM, openBracketBeforeClose, taskBoxOnLine, taskBoxesDrawn, taskBoxesIn, type TaskBox } from './task-items'
import { editorViewModeOf } from './view-mode'
import { writerReviewModeOf } from './writer-review'

/**
 * Checkboxes in the editor (docs/design/2026-09-27-checkbox-lists/mockup/hifi-direction-1.html,
 * frames 1–4). The typed list marker stays in muted ink (list-typography.ts); the `[ ]` / `[x]` after
 * it is drawn as a small box. Ticked lines keep full ink — only the box changes.
 *
 * Every write here is ONE character, space ↔ `x`, as its own undo step (ADR-0039: the rest of the
 * line is never rewritten). In Reviewing the writer-review filter turns that character into a
 * tracked writer change like any other edit, and the box carries the writer-change ring.
 */

/** The one-character tick for `box`: its own undo event, never merged with typing around it. */
export function toggleTaskBoxSpec(box: TaskBox): TransactionSpec {
  return {
    changes: { from: box.tick, to: box.tick + 1, insert: box.checked ? ' ' : 'x' },
    annotations: isolateHistory.of('full'),
    userEvent: 'input.checkbox',
  }
}

/** The tick for the box on the line holding `pos` (a click), or null when that line has none. */
export function toggleCheckboxAt(state: EditorState, pos: number): TransactionSpec | null {
  if (state.readOnly) return null
  const box = taskBoxOnLine(state, state.doc.lineAt(pos))
  return box ? toggleTaskBoxSpec(box) : null
}

/**
 * Toggle checkbox (registry `edit.toggleCheckbox`): ticks the box on the main cursor's line. Declines
 * off a box line, and on a line holding a pending agent change, so the same chord still reaches the
 * other context commands that share it (⌘↵ accepts the change at the cursor).
 */
export const toggleCheckbox: StateCommand = ({ state, dispatch }) => {
  const line = state.doc.lineAt(state.selection.main.head)
  if (inlineChangeRanges(state).some((range) => range.from <= line.to && range.to >= line.from)) return false
  const spec = toggleCheckboxAt(state, line.from)
  if (!spec) return false
  dispatch(state.update(spec))
  return true
}

/**
 * `]` after a list marker and `[` (or `[ `) makes a box as the bracket closes: `- []` and `- [ ]`
 * both become `- [ ] ` with the caret after the box. Covers the `]` smart pairs already inserted
 * (typing it steps over) and a `]` typed by hand.
 */
export function closeTaskBracket(state: EditorState, from: number, to: number, text: string): TransactionSpec | null {
  if (text !== ']' || from !== to || state.readOnly) return null
  const open = openBracketBeforeClose(state, from)
  if (open === null) return null
  const end = state.doc.sliceString(from, from + 1) === ']' ? from + 1 : from
  const following = state.doc.sliceString(end, end + 1)
  const spaced = following === ' ' || following === '\t'
  return {
    changes: { from: open, to: end, insert: spaced ? '[ ]' : '[ ] ' },
    selection: { anchor: open + 4 },
    userEvent: 'input.type',
    scrollIntoView: true,
  }
}

const MARKER_ONLY = new RegExp(`^[ \\t]*(?:${LIST_MARKER_SOURCE})[ \\t]+$`)

/**
 * Return on a box line starts a new unticked box, after any marker (lang-markdown continues `- [ ]`
 * but drops the box after `1.`). An EMPTY box line follows today's list rule exactly: it is read as
 * the empty item it is, so the first Return loosens the list (keeping the box) and the next ends it.
 */
export const continueTaskList: StateCommand = ({ state, dispatch }) => {
  const { main } = state.selection
  if (state.readOnly || state.selection.ranges.length !== 1 || !main.empty) return false
  const line = state.doc.lineAt(main.head)
  const box = taskBoxOnLine(state, line)
  if (!box || main.head < box.hideTo) return false
  const empty = box.hideTo === line.to
  const strip = { changes: { from: box.from, to: line.to }, selection: { anchor: box.from } }
  const base = empty ? state.update(strip).state : state
  let continued: Transaction | null = null
  if (!insertNewlineContinueMarkup({ state: base, dispatch: (tr) => { continued = tr } }) || !continued) return false
  const next = continued as Transaction
  const at = next.state.selection.main.head
  const newLine = next.state.doc.lineAt(at)
  const before = newLine.text.slice(0, at - newLine.from)
  const needsBox = MARKER_ONLY.test(before) && !/^\[[ xX]\]/.test(newLine.text.slice(at - newLine.from))
  dispatch(state.update(
    ...(empty ? [{ changes: strip.changes }] : []),
    { changes: next.changes, selection: next.selection, scrollIntoView: true, userEvent: 'input', sequential: true },
    ...(needsBox ? [{ changes: { from: at, insert: '[ ] ' }, selection: { anchor: at + 4 }, sequential: true }] : []),
  ))
  return true
}

const CHECK_PATH = 'M3 6.4 5.2 8.6 9.2 3.8'

/** The drawn box element. A box drawn away from its line (a checklist note's Done section,
 *  checklist-sink.ts) carries `data-task-line`, the 1-based line whose box a click ticks. */
export function taskBoxElement(doc: Document, state: { checked: boolean; focused?: boolean; changed?: boolean; line?: number }): HTMLElement {
  const box = doc.createElement('span')
  box.className = ['wf-task-box', state.checked && 'is-checked', state.focused && 'is-focused', state.changed && 'is-changed'].filter(Boolean).join(' ')
  box.setAttribute('role', 'checkbox')
  box.setAttribute('aria-checked', String(state.checked))
  box.setAttribute('aria-label', state.checked ? 'Ticked' : 'Not ticked')
  if (state.line !== undefined) box.dataset.taskLine = String(state.line)
  if (state.checked) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 12 12')
    svg.setAttribute('aria-hidden', 'true')
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', CHECK_PATH)
    svg.append(path)
    box.append(svg)
  }
  return box
}

class TaskBoxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly focused: boolean, readonly changed: boolean) { super() }
  eq(other: TaskBoxWidget): boolean {
    return other.checked === this.checked && other.focused === this.focused && other.changed === this.changed
  }
  toDOM(view: EditorView): HTMLElement {
    return taskBoxElement(view.dom.ownerDocument, { checked: this.checked, focused: this.focused, changed: this.changed })
  }
  /** The box is a control: its mousedown reaches the click handler below instead of placing a caret. */
  ignoreEvent(): boolean { return false }
}

/** Reviewing's note beside a changed box (frame 4): "ticked by you, 10:42". */
class TickNoteWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly createdAt: number) { super() }
  eq(other: TickNoteWidget): boolean { return other.checked === this.checked && other.createdAt === this.createdAt }
  toDOM(view: EditorView): HTMLElement {
    const note = view.dom.ownerDocument.createElement('span')
    note.className = 'wf-task-change'
    note.textContent = tickNote(this.checked, this.createdAt)
    return note
  }
}

export function tickNote(checked: boolean, createdAt: number): string {
  const time = new Date(createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return `${checked ? 'ticked' : 'unticked'} by you, ${time}`
}

type BoxDecorations = { decorations: DecorationSet; atomic: DecorationSet }

/**
 * The decoration seam: which ranges become boxes, which box carries the keyboard ring (the one
 * Toggle checkbox will tick), and where Reviewing's tick notes go. Pure over state + focus, so it is
 * testable without a DOM.
 */
export function taskBoxDecorations(state: EditorState, ranges: readonly { from: number; to: number }[], hasFocus: boolean): BoxDecorations {
  if (!taskBoxesDrawn(state)) return { decorations: Decoration.none, atomic: Decoration.none }
  const focusLine = hasFocus ? state.doc.lineAt(state.selection.main.head).number : -1
  const all = new RangeSetBuilder<Decoration>()
  const atomic = new RangeSetBuilder<Decoration>()
  const seen = new Set<number>()
  for (const range of ranges) {
    for (const box of taskBoxesIn(state, range.from, range.to, false)) {
      if (seen.has(box.line.number)) continue
      seen.add(box.line.number)
      const replace = Decoration.replace({ widget: new TaskBoxWidget(box.checked, box.line.number === focusLine, box.change !== null) })
      all.add(box.from, box.hideTo, replace)
      atomic.add(box.from, box.hideTo, replace)
      if (box.change) all.add(box.line.to, box.line.to, Decoration.widget({ widget: new TickNoteWidget(box.checked, box.change.createdAt), side: 1 }))
    }
  }
  return { decorations: all.finish(), atomic: atomic.finish() }
}

function needsRebuild(update: ViewUpdate): boolean {
  return update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged ||
    syntaxTree(update.state) !== syntaxTree(update.startState) ||
    editorViewModeOf(update.state) !== editorViewModeOf(update.startState) ||
    writerReviewModeOf(update.state) !== writerReviewModeOf(update.startState) ||
    update.transactions.some((tr) => tr.effects.length > 0)
}

const taskBoxPlugin = ViewPlugin.fromClass(class {
  boxes: BoxDecorations
  constructor(view: EditorView) { this.boxes = taskBoxDecorations(view.state, view.visibleRanges, view.hasFocus) }
  update(update: ViewUpdate): void {
    if (needsRebuild(update)) this.boxes = taskBoxDecorations(update.state, update.view.visibleRanges, update.view.hasFocus)
  }
}, {
  decorations: (plugin) => plugin.boxes.decorations,
  provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.boxes.atomic ?? Decoration.none),
})

const taskBoxTheme = EditorView.baseTheme({
  '.wf-task-box': {
    display: 'inline-block',
    position: 'relative',
    boxSizing: 'border-box',
    width: `${TASK_BOX_SIZE_EM}em`,
    height: `${TASK_BOX_SIZE_EM}em`,
    marginLeft: `${TASK_BOX_LEAD_EM}em`,
    marginRight: `${TASK_BOX_GAP_EM}em`,
    verticalAlign: '-0.13em',
    border: '1.5px solid var(--ink-3)',
    borderRadius: '3.5px',
    // The list line's negative text-indent (the hanging wrap) must not reach inside the box.
    textIndent: '0',
    cursor: 'pointer',
    transition: 'border-color .12s ease, box-shadow .12s ease',
  },
  '.wf-task-box:hover': { borderColor: 'var(--accent)' },
  '.wf-task-box.is-checked': { backgroundColor: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' },
  '.wf-task-box.is-focused': { boxShadow: '0 0 0 3px var(--accent-soft)' },
  '.wf-task-box.is-changed': { outline: '2px solid color-mix(in srgb, var(--you) 40%, transparent)', outlineOffset: '1px' },
  '.wf-task-box svg': { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' },
  '.wf-task-box path': { fill: 'none', stroke: 'currentColor', strokeWidth: '1.9', strokeLinecap: 'round', strokeLinejoin: 'round' },
  '.wf-task-change': { fontFamily: 'var(--ui)', fontSize: '0.58em', color: 'var(--you)', marginLeft: '0.7em', whiteSpace: 'nowrap', textIndent: '0' },
})

/** The whole checkbox layer: boxes, clicks, the typed-box rule and Return on a box line. */
export const taskBoxes: Extension = [
  taskBoxPlugin,
  taskBoxTheme,
  EditorView.domEventHandlers({
    mousedown(event, view) {
      const box = (event.target as Element | null)?.closest?.('.wf-task-box')
      if (!box || event.button !== 0) return false
      event.preventDefault() // a click ticks; the caret stays where the writer left it
      // A box drawn in a checklist note's Done section names its line; any other box sits on it.
      const line = Number((box as HTMLElement).dataset?.taskLine)
      const at = Number.isInteger(line) && line >= 1 && line <= view.state.doc.lines ? view.state.doc.line(line).from : view.posAtDOM(box)
      const spec = toggleCheckboxAt(view.state, at)
      if (spec) view.dispatch(spec)
      return true
    },
  }),
  Prec.high(EditorView.inputHandler.of((view, from, to, text) => {
    if (view.composing) return false
    const spec = closeTaskBracket(view.state, from, to, text)
    if (!spec) return false
    view.dispatch(spec)
    return true
  })),
  Prec.high(keymap.of([{ key: 'Enter', run: continueTaskList }])),
]
