/**
 * The widgets of a document, in document order (interactive-widgets-in-documents, ticket 01).
 *
 * There is no second classifier here: the widgets ARE the model's widget blocks (model.ts), so the
 * agent verb and the emitters can never disagree about what is a widget. A widget is identified by
 * its 1-based ordinal in that order; the model reads a prepared source (frontmatter, comments and
 * footnote definitions removed), so no file line number is claimed.
 *
 * Pure: no DOM, no fs.
 */
import { readDocument } from './model'
import { embedLine, type EmbedLine } from './embed-line'

export { embedLine, type EmbedLine }
export type WidgetEntry = EmbedLine & { ordinal: number; source: string }

export function scanWidgets(markdown: string): WidgetEntry[] {
  const found: WidgetEntry[] = []
  for (const block of readDocument(markdown).blocks) {
    if (block.kind !== 'widget') continue
    found.push({ ordinal: found.length + 1, source: block.source, path: block.path, ...(block.refusal ? { refusal: block.refusal } : {}) })
  }
  return found
}
