import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { applyWidgetPlan, planWidgetInsert, widgetEmbedLine, type WidgetInsertPlan } from '../../../shared/widget-insert'

/**
 * Insert widget… and the drop of an HTML file (interactive-widgets-in-documents, ticket 05). The only
 * thing written is the embed line, through one editor transaction, so Undo takes it back. The line,
 * its blank lines and where it lands are decided by shared/widget-insert.ts.
 */
export function insertWidgetLine(view: EditorView, rawPath: string, at: number = view.state.selection.main.head): WidgetInsertPlan {
  const plan = planWidgetInsert(view.state.doc.toString(), at, widgetEmbedLine(rawPath))
  view.dispatch({
    changes: { from: plan.from, to: plan.to, insert: plan.insert },
    selection: { anchor: plan.caret + widgetEmbedLine(rawPath).length },
    scrollIntoView: true,
    userEvent: 'input',
  })
  view.focus()
  return plan
}

/**
 * The text position a drop at the pointer means: the start of the line under it in the line's upper half, its end in
 * the lower half, so a drop on a paragraph's upper half goes before it and on its lower half after it.
 */
export function widgetDropPoint(view: EditorView, x: number, y: number): number | null {
  const at = view.posAtCoords({ x, y })
  if (at === null) return null
  const block = view.lineBlockAt(at)
  const top = view.documentTop + block.top
  return y < top + block.height / 2 ? block.from : block.to
}

/** Where a drop at `at` would land: the plan's position, for the indicator. */
export const widgetDropPosition = (view: EditorView, at: number): number => planWidgetInsert(view.state.doc.toString(), at, '[Simulation: x]').from

/** `applyWidgetPlan` re-exported for callers that only hold a text. */
export { applyWidgetPlan }

/** The drop line of the drawing (state 14): an accent rule with a pill reading "Drop to insert a widget". */
export const DROP_LABEL = 'Drop to insert a widget'

class DropLineWidget extends WidgetType {
  eq(): boolean { return true }
  toDOM(): HTMLElement {
    const line = document.createElement('div')
    line.className = 'wf-drop-line'
    line.setAttribute('data-testid', 'widget-drop-line')
    const dot = document.createElement('i')
    const label = document.createElement('span')
    label.textContent = DROP_LABEL
    line.append(dot, label)
    return line
  }
  ignoreEvent(): boolean { return true }
}

export const setWidgetDrop = StateEffect.define<number | null>()

const dropField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWidgetDrop)) {
        if (effect.value === null) return Decoration.none
        const at = Math.min(effect.value, transaction.state.doc.length)
        // At a line's start (or on a blank line) the rule goes above it; at the end of a text line, below it.
        const line = transaction.state.doc.lineAt(at)
        const below = at === line.to && line.to > line.from
        return Decoration.set([Decoration.widget({ widget: new DropLineWidget(), block: true, side: below ? 1 : -1 }).range(below ? line.to : line.from)])
      }
    }
    return transaction.docChanged ? Decoration.none : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

export const widgetDropIndicator = (): Extension => [dropField]
