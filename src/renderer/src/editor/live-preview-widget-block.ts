import { WidgetType, type EditorView } from '@codemirror/view'
import { embedLine } from '../../../shared/markdown/embed-line'
import { createWidgetBlock, type WidgetBlock } from '../widgets/widget-block'

/**
 * The editor's widget block (interactive-widgets-in-documents, ticket 03): a block widget placed
 * AFTER the embed line's own line, so the line stays real, editable text (hidden by a line class until
 * the cursor is on it) and the running frame is never rebuilt when the cursor comes or goes. All the
 * behaviour is in widgets/widget-block.ts; this class is the seam to CodeMirror.
 */
const blocks = new WeakMap<HTMLElement, WidgetBlock>()

export class WidgetBlockWidget extends WidgetType {
  constructor(readonly source: string, readonly path: string, readonly documentPath: string) { super() }
  eq(other: WidgetType): boolean {
    return other instanceof WidgetBlockWidget && other.source === this.source && other.path === this.path && other.documentPath === this.documentPath
  }
  toDOM(view: EditorView): HTMLElement {
    const block = createWidgetBlock({
      documentPath: this.documentPath,
      rawPath: this.path,
      source: this.source,
      returnFocus: () => view.focus(),
      onCaptionPress: () => {
        const pos = view.posAtDOM(block.dom)
        // The widget sits at the end of its embed line: land on that line.
        const line = view.state.doc.lineAt(Math.min(pos, view.state.doc.length))
        const target = embedLine(line.text) ? line : view.state.doc.lineAt(Math.max(0, pos - 1))
        view.dispatch({ selection: { anchor: target.to } })
        view.focus()
      },
    })
    // The slot carries the spacing as padding: CodeMirror measures a block widget's box without its margin.
    const slot = document.createElement('div')
    slot.className = 'wf-widget-slot'
    slot.append(block.dom)
    blocks.set(slot, block)
    return slot
  }
  destroy(dom: HTMLElement): void {
    blocks.get(dom)?.dispose()
    blocks.delete(dom)
  }
  get estimatedHeight(): number { return 380 }
  // The widget and its bar handle their own events; the editor keeps out of them.
  ignoreEvent(): boolean { return true }
}
