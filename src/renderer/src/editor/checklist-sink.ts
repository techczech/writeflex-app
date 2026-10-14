import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { LIST_MARKER_SOURCE } from '../../../shared/markdown/fancy-lists'
import { mayBeChecklistNote, summariseTasks } from '../../../shared/markdown/task-lines'
import { toPlain } from '../../../shared/markdown/to-plain'
import { listLineStyle, measurePrefix } from './list-typography'
import { taskBoxElement } from './task-boxes'
import { TASK_BOX_ADVANCE_EM, taskBoxOnLine, taskBoxesDrawn } from './task-items'
import { editorViewModeOf } from './view-mode'
import { writerReviewModeOf } from './writer-review'

/**
 * A checklist note's done items sink (docs/design/2026-09-27-checkbox-lists/mockup/hifi-direction-1.html,
 * frame 7). In a note that is mostly boxes (shared/markdown/task-lines.ts `summariseTasks`), each
 * top-level list the cursor is NOT in shows its open items first and its ticked items below a quiet
 * "Done · n" divider. On screen only: the ticked lines are hidden where they stand and drawn again
 * under the divider by a block widget, so the document — and the file — keep the writer's order
 * (ADR-0039: decoration, never a rewrite). With the cursor in the list it shows in file order, so what
 * is edited is what is on disk.
 *
 * A box in the Done section ticks its own line (task-boxes.ts reads `data-task-line`); a click on a
 * done item's words puts the caret at the end of that line, which brings the list back to file order.
 * Not in Raw (boxes are not drawn) and not in Reviewing, where a tick is a tracked change and stays
 * beside its note on its own line.
 */

/** One line of a sunk item as the Done section draws it. */
export type SunkRow = { line: number; text: string; box: { checked: boolean; hideTo: number; from: number } | null }
/** A ticked top-level item: its first line (the box a click ticks) and every non-blank line it spans. */
export type SunkItem = { line: number; rows: SunkRow[] }
/** One list's sinking: the ranges hidden in place (whole lines) and the items drawn under the divider. */
export type SinkPlan = { list: { from: number; to: number }; hidden: Array<{ from: number; to: number }>; done: SunkItem[] }

const LIST_ROW = new RegExp(`^([ \\t]*)(${LIST_MARKER_SOURCE})([ \\t]+)`)

/** Whether the document is a checklist note: the cheap gate first, the parse only when it may be. */
export function isChecklistDocument(state: EditorState): boolean {
  const text = state.doc.toString()
  return mayBeChecklistNote(text) && summariseTasks(text).isChecklistNote
}

function sinkingDrawn(state: EditorState): boolean {
  return taskBoxesDrawn(state) && writerReviewModeOf(state) !== 'reviewing'
}

function topLevelLists(state: EditorState): SyntaxNode[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state)
  const lists: SyntaxNode[] = []
  for (let node = tree.topNode.firstChild; node; node = node.nextSibling) {
    if (node.name === 'BulletList' || node.name === 'OrderedList') lists.push(node)
  }
  return lists
}

/** First and last line numbers a list item spans (its `to` may sit at the next line's start). */
function itemLines(state: EditorState, item: SyntaxNode): { first: number; last: number } {
  const first = state.doc.lineAt(item.from).number
  const last = state.doc.lineAt(Math.max(item.from, item.to - 1)).number
  return { first, last }
}

/**
 * The sinking of every top-level list in `state` — pure over state, so tests read it without a DOM.
 * Empty when the note is not a checklist note (`checklist`), when boxes are not drawn, in Reviewing,
 * and for a list that holds the cursor or has nothing ticked.
 */
export function checklistSinkPlan(state: EditorState, checklist = isChecklistDocument(state)): SinkPlan[] {
  if (!checklist || !sinkingDrawn(state)) return []
  const plans: SinkPlan[] = []
  for (const list of topLevelLists(state)) {
    if (state.selection.ranges.some((range) => range.from <= list.to && range.to >= list.from)) continue
    const items: SyntaxNode[] = []
    for (let child = list.firstChild; child; child = child.nextSibling) if (child.name === 'ListItem') items.push(child)
    const spans = items.map((item) => itemLines(state, item))
    const done = items.map((item, index) => {
      const box = taskBoxOnLine(state, state.doc.line(spans[index].first), false)
      return box !== null && box.checked && box.change === null
    })
    if (!done.includes(true)) continue
    const hidden: Array<{ from: number; to: number }> = []
    const sunk: SunkItem[] = []
    spans.forEach((span, index) => {
      if (!done[index]) return
      // Take the blank lines between this item and the one before (or, for the first item, the one
      // after) with it, so a loose list does not leave a double gap where the item stood.
      const firstLine = index > 0 ? spans[index - 1].last + 1 : span.first
      const lastLine = index === 0 && spans.length > 1 ? spans[1].first - 1 : span.last
      const from = state.doc.line(Math.min(firstLine, span.first)).from
      const to = state.doc.line(Math.max(lastLine, span.last)).to
      const previous = hidden[hidden.length - 1]
      if (previous && from <= previous.to + 1) previous.to = Math.max(previous.to, to)
      else hidden.push({ from, to })
      const rows: SunkRow[] = []
      for (let number = span.first; number <= span.last; number += 1) {
        const line = state.doc.line(number)
        if (line.text.trim() === '') continue
        const box = taskBoxOnLine(state, line, false)
        rows.push({ line: number, text: line.text, box: box ? { checked: box.checked, from: box.from - line.from, hideTo: box.hideTo - line.from } : null })
      }
      sunk.push({ line: span.first, rows })
    })
    plans.push({ list: { from: list.from, to: state.doc.lineAt(Math.max(list.from, list.to - 1)).to }, hidden, done: sunk })
  }
  return plans
}

class DoneSectionWidget extends WidgetType {
  constructor(readonly done: SunkItem[], readonly plain: boolean) { super() }
  eq(other: DoneSectionWidget): boolean {
    return other.plain === this.plain && JSON.stringify(other.done) === JSON.stringify(this.done)
  }
  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument
    const section = doc.createElement('div')
    section.className = 'wf-task-sunk'
    section.setAttribute('role', 'group')
    section.setAttribute('aria-label', `Done, ${this.done.length} ${this.done.length === 1 ? 'item' : 'items'}`)
    const divider = doc.createElement('div')
    divider.className = 'wf-task-done-divider'
    divider.append(`Done · ${this.done.length}`)
    const rule = doc.createElement('span')
    rule.className = 'wf-task-done-rule'
    divider.append(rule)
    section.append(divider)
    const boxPx = TASK_BOX_ADVANCE_EM * parseFloat(getComputedStyle(view.contentDOM).fontSize || '16')
    const measure = (prefix: string): number => measurePrefix(view, prefix)
    for (const item of this.done) {
      let hang = 0
      for (const row of item.rows) {
        const element = doc.createElement('div')
        element.className = 'wf-task-sunk-line'
        element.dataset.line = String(row.line)
        const style = listLineStyle(row.text, measure, row.box ? boxPx : null)
        const marker = LIST_ROW.exec(row.text)
        if (style && marker) {
          hang = style.paddingLeftPx
          element.style.paddingLeft = `${style.paddingLeftPx}px`
          element.style.textIndent = `${style.textIndentPx}px`
          element.append(marker[1])
          const mark = doc.createElement('span')
          mark.className = 'wf-task-sunk-mark'
          mark.textContent = marker[2]
          element.append(mark, marker[3])
          const words = row.box ? row.text.slice(row.box.hideTo) : row.text.slice(marker[0].length)
          if (row.box) element.append(taskBoxElement(doc, { checked: row.box.checked, line: row.line }))
          element.append(this.words(words))
        } else {
          // A continuation line hangs under its item's words.
          element.style.paddingLeft = `${hang}px`
          element.append(this.words(row.text.trim()))
        }
        section.append(element)
      }
    }
    return section
  }
  /** Clean shows the words as read (no `**`, link targets); Markup shows them as typed. */
  words(text: string): string {
    if (!this.plain) return text
    return toPlain(text).trim() || text
  }
  /** The section's boxes tick and its lines take the caret: the editor's own handlers must see it. */
  ignoreEvent(): boolean { return false }
}

function sinkDecorations(state: EditorState, checklist: boolean): DecorationSet {
  const plans = checklistSinkPlan(state, checklist)
  if (plans.length === 0) return Decoration.none
  const plain = editorViewModeOf(state) === 'clean'
  const ranges: Range<Decoration>[] = []
  for (const plan of plans) {
    const widget = new DoneSectionWidget(plan.done, plain)
    const last = plan.hidden[plan.hidden.length - 1]
    for (const range of plan.hidden) {
      // The last hidden run at the list's end carries the section in its place; otherwise the
      // section follows the list's last line.
      const carries = range === last && range.to === plan.list.to
      ranges.push(Decoration.replace({ block: true, ...(carries ? { widget } : {}) }).range(range.from, range.to))
    }
    if (last.to !== plan.list.to) ranges.push(Decoration.widget({ widget, block: true, side: 1 }).range(plan.list.to))
  }
  return Decoration.set(ranges, true)
}

type SinkState = { checklist: boolean; deco: DecorationSet }

const checklistSinkField = StateField.define<SinkState>({
  create(state) {
    const checklist = isChecklistDocument(state)
    return { checklist, deco: sinkDecorations(state, checklist) }
  },
  update(value, tr) {
    const checklist = tr.docChanged ? isChecklistDocument(tr.state) : value.checklist
    if (!checklist) return value.deco === Decoration.none && !value.checklist ? value : { checklist, deco: Decoration.none }
    // The cursor, the view mode, Reviewing and the parser's progress all arrive as selection or effects.
    if (tr.docChanged || tr.selection || tr.effects.length > 0 || !value.checklist) return { checklist, deco: sinkDecorations(tr.state, checklist) }
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

const checklistSinkTheme = EditorView.baseTheme({
  '.wf-task-sunk': { paddingBottom: '0.1em' },
  '.wf-task-done-divider': {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    margin: '0.6em 0 0.25em 18px',
    fontFamily: 'var(--ui)',
    fontSize: '0.62em',
    fontWeight: '650',
    letterSpacing: '.06em',
    textTransform: 'uppercase',
    color: 'var(--ink-4)',
    textIndent: '0',
    userSelect: 'none',
  },
  '.wf-task-done-rule': { flex: '1', height: '1px', background: 'var(--line-soft)' },
  '.wf-task-sunk-line': { opacity: '.62', paddingRight: '2px', cursor: 'text' },
  '.wf-task-sunk-mark': { color: 'var(--ink-3)' },
})

/** The Done section's clicks: a box ticks (task-boxes.ts), words take the caret to their line. */
const doneSectionClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as Element | null
    if (!target?.closest?.('.wf-task-sunk') || event.button !== 0) return false
    if (target.closest('.wf-task-box')) return false
    event.preventDefault()
    const row = target.closest<HTMLElement>('.wf-task-sunk-line')
    const number = Number(row?.dataset.line)
    if (Number.isInteger(number) && number >= 1 && number <= view.state.doc.lines) {
      view.dispatch({ selection: { anchor: view.state.doc.line(number).to }, scrollIntoView: true, userEvent: 'select.pointer' })
      view.focus()
    }
    return true
  },
})

/** The whole layer: the field that sinks, its look, and its clicks. */
export const checklistSink: Extension = [checklistSinkField, checklistSinkTheme, doneSectionClicks]
