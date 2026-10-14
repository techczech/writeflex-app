// Place: what the caret or the selected row is on (ADR-0043; terms in CONTEXT.md). The status-bar
// chip names it; Actions here (⌘K) and the keyboard sheet's "Here" section list its commands.
//
// THE RULES
//
// 1. ONE ANSWER. For any editor state, with or without a focused pane row, `placeAt` returns exactly
//    one place. The first rule below that matches decides:
//      a. A row of the Files pane or the Outline that has the keyboard gives the row's place (a file,
//         a folder, an outline row), whatever the caret is on in the editor.
//      b. A document with no text is an empty document.
//      c. A selection that is not empty is its own place and wins over whatever it sits in.
//      d. The caret inside the metadata block at the top of the file is in the metadata.
//      e. INNERMOST CONSTRUCT FIRST. The caret inside a link is on the link, wherever the link is: in
//         a paragraph, a heading, a table cell, or a list item inside a quotation. A paragraph that
//         is nothing but a picture is an image; a picture in running text belongs to its paragraph.
//         Touching either end of the link counts as on it, as it does for Follow link.
//      f. Otherwise the line's nearest enclosing block decides, innermost first: a fenced code block,
//         a table, a heading, a task item, a list item, a quotation. So a list item inside a
//         quotation is a list item, a quotation inside a list item is a quotation, and a heading
//         inside a quotation is a heading. Anything else is a paragraph: a blank line, a divider, an
//         HTML block, an indented code block, a footnote definition.
//    The drawing (state 18) shows the caret on plain heading text reading "On a heading". No drawn
//    state has a heading that contains a link, so rule e applies there too: on the link it reads
//    "On a link", anywhere else on the line "On a heading".
//    A level-1 heading is its own place with the same label, because it cannot be raised (the
//    drawing: "Place depends on the heading's level"). The folder the Files pane is focused on is
//    its own place with the label "On a folder", because it offers Clear focus instead of Focus.
//
// 2. PURE AND CHEAP. `placeAt` reads the editor state and the row it is handed: no DOM, no async, no
//    I/O. It runs on every selection change, so it resolves the syntax node at the caret and at the
//    end of the caret's line and walks only their ancestors; it never iterates the tree and never
//    reads the whole document. The metadata check reads at most METADATA_SCAN_LINES lines and only
//    when the file opens with `---`. Where the parser has not yet reached the caret's line the block
//    is read from the line's own text. tests/main/place.test.ts bounds the work on a 5,000-line file.
//
// 3. THE PLACE LIST IS SMALL AND CLOSED. It is PLACES in command-places.ts; a place is added only
//    where the commands genuinely differ.
//
// 4. EVERY COMMAND DECLARES where it is offered (command-places.ts). A command's `when` stays its
//    enablement: a command listed at a place is offered there only while its `when` holds.
//
// 5. THE COUNT IS THE LIST. `actionsAt(place, state)` is the one list: the chip shows its length,
//    Actions here and the keyboard sheet render its rows. A sheet row that mirrors a command is
//    never listed beside it, and a row marked not built yet is never listed. The order is the
//    drawing's and is written on `actionsAmong`.
//
// KNOWN BEHAVIOUR, for a later ticket to decide: the chip keeps naming the last place when the
// keyboard leaves the editor and the two panes (for example into the agent box, a dialog or the
// status bar). `placeAt` is only asked about the editor and pane rows; hooks/usePlace.ts leaves the
// reading as it was for anything else.
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'
import { DELETING_COMMANDS, DRAWN_ORDER, EVERYWHERE, INSERT_GROUP, INSERT_OBJECT_ROW, NOT_BY_PLACE, PLACE_LABELS, offeredAt, type Place, type PlaceDeclaration } from './command-places'
import { SUBGROUP_ORDER, TASK_GROUPS, type TaskGroup } from './command-task-groups'
import { commandRegistry, type Command } from './registry'

export { PLACES, PLACE_LABELS, type Place } from './command-places'

/** The row that has the keyboard in the Files pane or the Outline; null while the editor has it. */
export type PaneRow =
  | { kind: 'file' }
  | { kind: 'folder'; focused?: boolean }
  | { kind: 'outline-row' }

/** The metadata block is searched for its closing fence no further than this many lines. */
export const METADATA_SCAN_LINES = 200

/** A document this short is read to see whether it holds any text at all; a longer one is not empty. */
const EMPTY_DOCUMENT_SCAN = 256

/** No construct of this dialect nests deeper than this around one line; the walk stops here regardless. */
const MAX_ANCESTORS = 64

type Probe = { place: Place; nodesVisited: number }

const ROW_PLACES: Readonly<Record<PaneRow['kind'], Place>> = { file: 'file', folder: 'folder', 'outline-row': 'outline-row' }

const BLOCK_PLACES: Readonly<Record<string, Place>> = {
  FencedCode: 'code-block',
  Table: 'table',
  ATXHeading1: 'heading-top',
  SetextHeading1: 'heading-top',
  ATXHeading2: 'heading',
  ATXHeading3: 'heading',
  ATXHeading4: 'heading',
  ATXHeading5: 'heading',
  ATXHeading6: 'heading',
  SetextHeading2: 'heading',
  Task: 'task-item',
  ListItem: 'list-item',
  Blockquote: 'quotation',
}

/** Where the search for a link at the caret stops: the block the caret's text belongs to. */
const INLINE_BOUNDARIES = new Set(['Document', 'Paragraph', 'TableCell', 'Task', 'ListItem', 'Blockquote', 'FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', ...Object.keys(BLOCK_PLACES)])

function inMetadata(state: EditorState, head: number): boolean {
  const { doc } = state
  if (doc.lines < 2 || doc.line(1).text !== '---') return false
  const last = Math.min(doc.lines, METADATA_SCAN_LINES)
  for (let number = 2; number <= last; number += 1) {
    const line = doc.line(number)
    if (line.text === '---') return head <= line.to
  }
  return false
}

/** A paragraph that holds one picture and nothing else: the app's image object. */
function isLoneImage(state: EditorState, image: SyntaxNode): boolean {
  const paragraph = image.parent
  if (!paragraph || paragraph.name !== 'Paragraph') return false
  return state.doc.sliceString(paragraph.from, image.from).trim() === '' && state.doc.sliceString(image.to, paragraph.to).trim() === ''
}

/** The block a line is, read from its own text: used only where the parser has not reached it. */
function blockFromLineText(text: string): Place {
  const body = text.replace(/^\s{0,3}/, '')
  if (/^#(?:\s|$)/.test(body)) return 'heading-top'
  if (/^#{2,6}(?:\s|$)/.test(body)) return 'heading'
  if (/^(?:[-*+]|\d+[.)])\s+\[[ xX]\]\s/.test(body)) return 'task-item'
  if (/^(?:[-*+]|\d+[.)]|[A-Za-z]{1,4}[.)])\s/.test(body)) return 'list-item'
  if (body.startsWith('>')) return 'quotation'
  if (body.startsWith('|')) return 'table'
  return 'paragraph'
}

/** The place of a pane row. `placeAt` answers with it whenever a row has the keyboard; it needs no document. */
export const placeOfRow = (row: PaneRow): Place => row.kind === 'folder' && row.focused ? 'focused-folder' : ROW_PLACES[row.kind]

/** `placeAt` with the number of syntax nodes it looked at, so a test can bound the work. */
export function probePlace(state: EditorState, row: PaneRow | null = null): Probe {
  if (row) return { place: placeOfRow(row), nodesVisited: 0 }
  const { doc } = state
  const selection = state.selection.main
  if (doc.length === 0 || (doc.length <= EMPTY_DOCUMENT_SCAN && doc.sliceString(0).trim() === '')) return { place: 'empty-document', nodesVisited: 0 }
  if (!selection.empty) return { place: 'selection', nodesVisited: 0 }
  const head = selection.head
  if (inMetadata(state, head)) return { place: 'metadata', nodesVisited: 0 }

  const line = doc.lineAt(head)
  const tree = syntaxTree(state)
  if (tree.length < line.to) return { place: blockFromLineText(line.text), nodesVisited: 0 }
  let nodesVisited = 0

  // Rule e: a link or a lone image at the caret, looked for on both sides of it.
  for (const side of [-1, 1] as const) {
    let steps = 0
    for (let node: SyntaxNode | null = tree.resolveInner(head, side); node && !INLINE_BOUNDARIES.has(node.name) && steps < MAX_ANCESTORS; node = node.parent, steps += 1) {
      nodesVisited += 1
      if (node.name === 'Image') {
        if (isLoneImage(state, node)) return { place: 'image', nodesVisited }
        break
      }
      if (node.name === 'Link' || node.name === 'Autolink' || (node.name === 'URL' && node.parent?.name !== 'Image')) return { place: 'link', nodesVisited }
    }
  }

  // Rule f: the nearest enclosing block of the line, read from the end of its text so a caret at
  // either end of the line, or in its leading marks, gets the same answer as one in the middle.
  const textEnd = line.from + line.text.trimEnd().length
  let steps = 0
  for (let node: SyntaxNode | null = tree.resolveInner(textEnd, -1); node && steps < MAX_ANCESTORS; node = node.parent, steps += 1) {
    nodesVisited += 1
    const place = BLOCK_PLACES[node.name]
    if (!place) continue
    // A blank line belongs to a code block that contains it and to nothing else.
    if (textEnd === line.from && place !== 'code-block') continue
    // GFM takes a prose line that touches a table as one more row; the app does not (live-preview.ts).
    if (place === 'table' && !line.text.includes('|')) return { place: 'paragraph', nodesVisited }
    return { place, nodesVisited }
  }
  return { place: 'paragraph', nodesVisited }
}

/** The one Place for an editor state; a focused row of the Files pane or the Outline takes precedence. */
export const placeAt = (state: EditorState, row: PaneRow | null = null): Place => probePlace(state, row).place

/** What the chip, the panel and the sheet call a place. */
export const placeLabel = (place: Place): string => PLACE_LABELS[place]

type Listable = Pick<Command, 'id' | 'task' | 'subgroup' | 'places' | 'when' | 'future' | 'sheetSource'>

/** The group a row is listed under: "Insert" for the Insert row, otherwise the command's task group. */
export const actionGroupOf = (command: Pick<Command, 'id' | 'task'>): string => command.id === INSERT_OBJECT_ROW ? INSERT_GROUP : command.task

/**
 * The commands among `commands` that are offered at `place`, in the order every list shows them
 * (the drawing, states 18, 19 and 22):
 *   1. the Insert row first, a group of its own;
 *   2. then the task groups, the one with the most rows at this place first; equal groups keep the
 *      order of the ten;
 *   3. inside a group, the rows the drawing shows at this place in the drawn order (DRAWN_ORDER),
 *      then the rest: sub-group order (SUBGROUP_ORDER, else the order the group's own commands
 *      first name it), then the order given, with a command that deletes or removes last.
 * `state` is the editor state the commands' `when` is asked about; with none (no document open) a
 * command that has a `when` is not offered.
 */
export function actionsAmong<T extends Listable>(commands: readonly T[], place: Place, state: EditorState | null): T[] {
  const subgroups = new Map<TaskGroup, string[]>(TASK_GROUPS.map((task) => [task, [...(SUBGROUP_ORDER[task] ?? [])]]))
  for (const ownRows of [true, false]) {
    for (const command of commands) {
      if (ownRows && command.sheetSource) continue
      const seen = subgroups.get(command.task)!
      if (!seen.includes(command.subgroup)) seen.push(command.subgroup)
    }
  }
  const offered = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => offeredAt(command.places, place)
      && command.sheetSource?.kind !== 'command'
      && !command.future
      && (!command.when || (state !== null && command.when(state))))
  const groupSize = new Map<TaskGroup, number>()
  for (const { command } of offered) if (command.id !== INSERT_OBJECT_ROW) groupSize.set(command.task, (groupSize.get(command.task) ?? 0) + 1)
  const drawn = DRAWN_ORDER[place] ?? []
  const drawnRank = (id: string): number => { const rank = drawn.indexOf(id); return rank < 0 ? drawn.length : rank }
  const insertFirst = (id: string): number => id === INSERT_OBJECT_ROW ? 0 : 1
  const deletesLast = (id: string): number => !drawn.includes(id) && DELETING_COMMANDS.has(id) ? 1 : 0
  return offered
    .sort((a, b) => insertFirst(a.command.id) - insertFirst(b.command.id)
      || groupSize.get(b.command.task)! - groupSize.get(a.command.task)!
      || TASK_GROUPS.indexOf(a.command.task) - TASK_GROUPS.indexOf(b.command.task)
      || drawnRank(a.command.id) - drawnRank(b.command.id)
      || deletesLast(a.command.id) - deletesLast(b.command.id)
      || subgroups.get(a.command.task)!.indexOf(a.command.subgroup) - subgroups.get(b.command.task)!.indexOf(b.command.subgroup)
      || a.index - b.index)
    .map(({ command }) => command)
}

/** The commands offered at a place, in order: the chip's count, Actions here and the sheet's "Here" section. */
export const actionsAt = (place: Place, state: EditorState | null): Command[] => actionsAmong(commandRegistry, place, state)

/** How a declaration reads in a report: its places, or the kind. */
export const describePlaces = (declaration: PlaceDeclaration): string =>
  declaration === EVERYWHERE ? 'everywhere' : declaration === NOT_BY_PLACE ? 'not offered by place' : declaration.join(', ')
