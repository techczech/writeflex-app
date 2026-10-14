import type { Command as EditorViewCommand, EditorView } from '@codemirror/view'
import { setOpenLivePreviewBlock } from './live-preview'
import { buildTable } from './insert-objects'
import { frontmatterSafeInsertPosition } from '../../../shared/object-markup'

/**
 * Inserting a block object into the document, as ONE function.
 *
 * This is EditorPane's own `insertText` lifted out of the component unchanged — including the rule
 * that a block object must land on its own lines, because glued to prose the pipes and fences never
 * parse as a block and the open-editing effect then points at nothing. It moved here so the Insert
 * menu and the registry command below run the SAME code: ticket A1b registers the table verb the
 * action bar draws (ADR-0040), and registering a menu surface must not mean a second implementation
 * of it.
 */
export function insertBlockObject(
  view: EditorView,
  text: string,
  options: { open?: boolean; block?: boolean } = {},
): { from: number; to: number } {
  const selection = view.state.selection.main
  const safeFrom = selection.empty ? frontmatterSafeInsertPosition(view.state.doc.toString(), selection.from) : selection.from
  const safeTo = selection.empty ? safeFrom : selection.to
  let prefix = ''
  let suffix = ''
  if (options.block ?? options.open) {
    const line = view.state.doc.lineAt(safeFrom)
    if (view.state.doc.sliceString(line.from, safeFrom).trim() !== '') prefix = '\n\n'
    if (view.state.doc.sliceString(safeTo, view.state.doc.lineAt(safeTo).to).trim() !== '') suffix = '\n\n'
  }
  const start = safeFrom + prefix.length
  view.dispatch({
    changes: { from: safeFrom, to: safeTo, insert: prefix + text + suffix },
    selection: { anchor: start },
    effects: options.open ? setOpenLivePreviewBlock.of({ from: start, to: start + text.length }) : undefined,
    scrollIntoView: true,
  })
  view.focus()
  return { from: start, to: start + text.length }
}

/** `insert.table` — the drawn table verb, and the Insert menu's Table row, as one command. */
export const insertTable: EditorViewCommand = (view) => {
  insertBlockObject(view, buildTable(), { open: true })
  return true
}
