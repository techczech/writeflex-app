import { RangeSetBuilder } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { LIST_MARKER_SOURCE } from '../../../shared/markdown/fancy-lists'
import { TASK_BOX_ADVANCE_EM, taskBoxOnLine, taskBoxesDrawn } from './task-items'
import { editorViewModeOf } from './view-mode'
import { writerReviewModeOf } from './writer-review'

/**
 * ONE indent step for block prefixes in the editor (decision 2026-09-12, docs/design/2026-09-12-list-markers):
 * the blockquote's 18px gutter (theme.ts `.wf-quote-line`) is the step, and a list uses the same
 * step per nesting level — level one sits one step in, like quoted text, so a list is visibly a
 * block set off from the prose rather than a bare hyphen flush with the paragraph edge. Wrapped
 * lines hang under the item's text, never under the marker. The marker glyphs (`-`, `*`, `+`,
 * `1.`, and the lettered and roman `a.`, `iv)`) stay in the document and recede to --ink-3
 * through the theme's processingInstruction tag; this module only positions the line (ADR-0039: decoration, never a rewrite). On a task line whose
 * `[ ]` is drawn as a box (task-boxes.ts) the hang is the marker plus the box's own advance, so the
 * wrap still starts under the words.
 */
export const BLOCK_INDENT_STEP_PX = 18
/** Per-level list indent — the same step as the blockquote gutter. */
export const LIST_NESTING_PX = BLOCK_INDENT_STEP_PX

export type ListLineIndent = { nestingPx: number; leadingColumns: number; markerColumns: number }
/** Pixel offsets applied by the visible `wf-list-line` decoration. */
export type ListLineStyle = { paddingLeftPx: number; textIndentPx: number }

// Any list marker, lettered and roman included (fancy-lists.ts). A letter run is only a candidate
// (`etc.` at a line start is prose), so the decoration asks the syntax tree before drawing one.
const listPrefix = new RegExp(`^([ \\t]*)(?:(${LIST_MARKER_SOURCE})([ \\t]+))((?:\\[[ xX]\\][ \\t]+)?)`)
const LETTER_MARKER = /^[A-Za-z]/

/** A letter-run marker is a list marker only where the parser made it one (a `ListMark`). */
function realMarker(view: EditorView, lineFrom: number, text: string): boolean {
  const match = listPrefix.exec(text)
  if (!match || !LETTER_MARKER.test(match[2])) return true
  return syntaxTree(view.state).resolveInner(lineFrom + match[1].length, 1).name === 'ListMark'
}

function indentationColumns(indent: string): number {
  let columns = 0
  for (const character of indent) columns += character === '\t' ? 4 - (columns % 4) : 1
  return columns
}

/** Parse only real item lines. Continuation lines inherit layout naturally and get no decoration. */
export function listLineIndent(line: string): ListLineIndent | null {
  const match = listPrefix.exec(line)
  if (!match) return null
  const indentColumns = indentationColumns(match[1])
  // Level one is already one step in (the quote's gutter); each two source columns add another.
  const nestingPx = (Math.floor(indentColumns / 2) + 1) * LIST_NESTING_PX
  const markerColumns = match[2].length + match[3].length + match[4].length
  return { nestingPx, leadingColumns: indentColumns, markerColumns }
}

function bulletPrefix(line: string): string {
  const match = listPrefix.exec(line)
  return match ? `${match[2]}${match[3]}` : ''
}

function markerPrefix(line: string): string {
  const match = listPrefix.exec(line)
  return match ? `${match[2]}${match[3]}${match[4]}` : ''
}

function leadingWhitespace(line: string): string {
  return listPrefix.exec(line)?.[1] ?? ''
}

/**
 * Compute a list line's visible offsets without requiring a DOM-backed EditorView. `taskBoxPx` is
 * the drawn box's advance when the line's `[ ]` is shown as a box; it then stands in for the
 * bracket text, which the box replaces.
 */
export function listLineStyle(line: string, measure: (prefix: string) => number, taskBoxPx: number | null = null): ListLineStyle | null {
  const indent = listLineIndent(line)
  if (!indent) return null
  const markerPx = taskBoxPx === null ? measure(markerPrefix(line)) : measure(bulletPrefix(line)) + taskBoxPx
  const leadingPx = measure(leadingWhitespace(line))
  return {
    paddingLeftPx: indent.nestingPx + markerPx,
    textIndentPx: -(leadingPx + markerPx),
  }
}

/** The rendered width of a line prefix in the editor's prose font (a canvas measure, no layout). */
export function measurePrefix(view: EditorView, prefix: string): number {
  const canvas = view.dom.ownerDocument.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return prefix.length * view.defaultCharacterWidth
  const style = getComputedStyle(view.contentDOM)
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  return context.measureText(prefix).width
}

function listDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const seen = new Set<number>()
  const boxes = taskBoxesDrawn(view.state)
  const boxPx = boxes ? TASK_BOX_ADVANCE_EM * parseFloat(getComputedStyle(view.contentDOM).fontSize) : 0
  for (const range of view.visibleRanges) {
    const first = view.state.doc.lineAt(range.from).number
    const last = view.state.doc.lineAt(range.to).number
    for (let lineNumber = first; lineNumber <= last; lineNumber += 1) {
      if (seen.has(lineNumber)) continue
      seen.add(lineNumber)
      const line = view.state.doc.line(lineNumber)
      if (!realMarker(view, line.from, line.text)) continue
      const box = boxes && taskBoxOnLine(view.state, line, false)
      const style = listLineStyle(line.text, (prefix) => measurePrefix(view, prefix), box ? boxPx : null)
      if (!style) continue
      builder.add(line.from, line.from, Decoration.line({
        class: 'wf-list-line',
        // Source indentation remains in the document. Cancel its glyph width on the first visual
        // row so the marker itself advances by exactly the rendered 22px-per-level scale.
        attributes: { style: `padding-left:${style.paddingLeftPx}px;text-indent:${style.textIndentPx}px` },
      }))
    }
  }
  return builder.finish()
}

/** Always-on line typography; deliberately separate from the StateField-owned block pipeline. */
export const listTypography = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = listDecorations(view) }
  update(update: ViewUpdate): void {
    if (
      update.docChanged || update.viewportChanged || update.geometryChanged ||
      editorViewModeOf(update.state) !== editorViewModeOf(update.startState) ||
      writerReviewModeOf(update.state) !== writerReviewModeOf(update.startState) ||
      syntaxTree(update.state) !== syntaxTree(update.startState)
    ) this.decorations = listDecorations(update.view)
  }
}, { decorations: (plugin) => plugin.decorations })
