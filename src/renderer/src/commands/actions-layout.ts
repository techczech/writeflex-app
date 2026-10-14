// Actions here: the drawn layout of every place (docs/design/2026-10-11-actions-here-menu/actions-here-final-spec.md).
// This is DATA: for each place, the rows in the drawn order, with the icon and the label each row
// wears. `actions-here.ts` turns it into panel rows, keeping a row only while `actionsAt(place, state)`
// offers its command there, so a row never appears for a command that cannot run (rule 4 of place.ts).
//
// Kinds of item:
//   row     one command, one row.
//   opener  a row with no command of its own (Format, Turn into…, Column…): it swaps the panel to a
//           child list. It is presentation only, so it has no registry id; its `id` is the layout key.
//   split   one row, two commands, two key caps (Move block, Indent / outdent, Raise / lower).
//   strip   the Format icon strip above the filter (the selection place only).
//   sep     a thin separator. Leading, trailing and doubled separators are dropped after availability.
import {
  ArrowUpDown, Bold, CaseSensitive, ChevronsDownUp, ClipboardCopy, Columns2, Copy, ExternalLink, Eye, FileText, FilePlus, FolderInput, FolderOpen, FolderPlus, Focus,
  Hash, Heading as HeadingIcon, Highlighter, IndentDecrease, IndentIncrease, Italic, Link as LinkIcon, List, ListChecks, ListOrdered, ListPlus, ListTree, MessageSquare, Network, PencilLine,
  Pilcrow, Pin, Replace, SquareCheck, SquarePen, SquarePlus, Strikethrough, TextQuote, TextSelect, Trash2, Type, Upload, Volume2, Workflow, Code, Table as TableIcon, Sparkles, CopyPlus, RemoveFormatting,
  type LucideIcon,
} from 'lucide-react'
import { INSERT_OBJECT_ROW } from './command-places'
import type { Place } from './place'
import { askLabelAt } from './ask-context'

export type ChildItem =
  | { kind: 'row'; id: string; icon: LucideIcon; label: string }
  /** A quotation's Turn into target: runs `outline.makeParagraph`, then the paragraph target `id`, as one undo step. */
  | { kind: 'composed'; id: string; icon: LucideIcon; label: string }
  /** The thing the block already is: drawn with a quiet tag, never a row, never counted. */
  | { kind: 'now'; label: string; icon: LucideIcon; tag: string }
  | { kind: 'sep' }

export type LayoutItem =
  | { kind: 'row'; id: string; icon: LucideIcon; label: string }
  | { kind: 'opener'; id: string; icon: LucideIcon; label: string; children: ChildItem[] }
  | { kind: 'split'; id: string; icon: LucideIcon; label: string; first: string; second: string }
  | { kind: 'strip'; caption: string; cells: Array<{ id: string; icon: LucideIcon; label: string }> }
  | { kind: 'sep' }

const SEP: LayoutItem = { kind: 'sep' }
const row = (id: string, icon: LucideIcon, label: string): LayoutItem => ({ kind: 'row', id, icon, label })
const child = (id: string, icon: LucideIcon, label: string): ChildItem => ({ kind: 'row', id, icon, label })
const composed = (id: string, icon: LucideIcon, label: string): ChildItem => ({ kind: 'composed', id, icon, label })
/** The id a composed Turn into row wears (its own, so it can sit beside the plain target without clashing). */
export const COMPOSED_PREFIX = 'quotation.turn:'
const split = (id: string, icon: LucideIcon, label: string, first: string, second: string): LayoutItem => ({ kind: 'split', id, icon, label, first, second })
const opener = (id: string, icon: LucideIcon, label: string, children: ChildItem[]): LayoutItem => ({ kind: 'opener', id, icon, label, children })

const INSERT = row(INSERT_OBJECT_ROW, SquarePlus, 'Insert object…')
const COMMENT = row('edit.toggleComment', MessageSquare, 'Comment')
const ask = (place: Place): LayoutItem => row('agent.askHere', Sparkles, askLabelAt(place))
const readAloud = (label: string): LayoutItem => row('readAloud.start', Volume2, label)
const MOVE_BLOCK = split('move.block', ArrowUpDown, 'Move block', 'outline.moveBlockUp', 'outline.moveBlockDown')

/** The ids the strip and Format children share, in the drawn order. */
const FORMAT_CELLS = [
  { id: 'edit.bold', icon: Bold, label: 'Bold' },
  { id: 'edit.italic', icon: Italic, label: 'Italic' },
  { id: 'edit.strikethrough', icon: Strikethrough, label: 'Strikethrough' },
  { id: 'edit.mark', icon: Highlighter, label: 'Mark' },
  { id: 'edit.inlineCode', icon: Code, label: 'Inline code' },
  { id: 'edit.link', icon: LinkIcon, label: 'Link' },
  { id: 'edit.clearFormatting', icon: RemoveFormatting, label: 'Clear formatting' },
]
const FORMAT = opener('format.menu', Type, 'Format', FORMAT_CELLS.map((cell) => child(cell.id, cell.icon, cell.label)))

/** The targets of a paragraph or a selection, in the drawn order (Paragraph itself is the "now" marker or absent). */
const PARAGRAPH_TARGETS = [
  child('outline.makeHeadingAtSurroundingLevel', HeadingIcon, 'Heading'),
  child('outline.makeHeadingOneLevelDeeper', IndentIncrease, 'Heading, one deeper'),
  child('list.bullet', List, 'Bullet list'),
  child('list.ordered', ListOrdered, 'Numbered list'),
  child('turn.taskList', ListChecks, 'Task list'),
  child('block.quote', TextQuote, 'Quotation'),
  child('turn.codeBlock', Code, 'Code block'),
]
const turnInto = (children: ChildItem[]): LayoutItem => opener('turn.into', Replace, 'Turn into…', children)

const TURN_INTO: Partial<Record<Place, LayoutItem>> = {
  paragraph: turnInto([{ kind: 'now', label: 'Paragraph', icon: Pilcrow, tag: 'now' }, ...PARAGRAPH_TARGETS]),
  // Mind map is not drawn here; it is kept so the conversion a selection could always run stays one step away.
  selection: turnInto([...PARAGRAPH_TARGETS, child('outline.toMindMap', Network, 'Mind map')]),
  quotation: turnInto([
    child('outline.makeParagraph', Pilcrow, 'Paragraph'),
    composed('outline.makeHeadingAtSurroundingLevel', HeadingIcon, 'Heading'),
    composed('list.bullet', List, 'Bullet list'),
    composed('list.ordered', ListOrdered, 'Numbered list'),
    composed('turn.taskList', ListChecks, 'Task list'),
    composed('turn.codeBlock', Code, 'Code block'),
    { kind: 'now', label: 'Quotation', icon: TextQuote, tag: 'now' },
  ]),
  heading: turnInto([child('outline.makeParagraph', Pilcrow, 'Paragraph'), child('heading.decrease', IndentDecrease, 'Raise the level'), child('heading.increase', IndentIncrease, 'Lower the level')]),
  'list-item': turnInto([child('outline.makeParagraph', Pilcrow, 'Paragraph'), child('list.type.bullet', List, 'Bullet list'), child('list.type.numbered', ListOrdered, 'Numbered list'), child('list.type.checkboxes', ListChecks, 'Task list'), child('list.type.lettered', ListOrdered, 'Lettered list (a. b. c.)'), child('list.type.roman', ListOrdered, 'Roman list (i. ii. iii.)'), child('outline.toMindMap', Network, 'Mind map')]),
  table: turnInto([child('block.toText', FileText, 'Text'), child('block.toCode', Code, 'Code block')]),
  'code-block': turnInto([child('block.toText', FileText, 'Text'), child('block.toCode', Code, 'Code block'), child('block.toMermaid', Workflow, 'Flow diagram'), child('block.toMarkmap', Network, 'Mind map'), child('block.toTable', TableIcon, 'Table')]),
}
TURN_INTO['heading-top'] = TURN_INTO.heading
TURN_INTO['task-item'] = TURN_INTO['list-item']
TURN_INTO.image = TURN_INTO.table

const COLUMN = opener('table.column', Columns2, 'Column', [
  child('table.insertLeft', Columns2, 'Insert column left'),
  child('table.insertRight', Columns2, 'Insert column right'),
  child('table.delete', Trash2, 'Delete column…'),
  { kind: 'sep' },
  child('table.alignLeft', TextSelect, 'Align left'),
  child('table.alignCentre', TextSelect, 'Align centre'),
  child('table.alignRight', TextSelect, 'Align right'),
])

const CHANGE_CASE = opener('text.changeCase', CaseSensitive, 'Change case…', [
  child('text.upperCase', CaseSensitive, 'UPPER CASE'),
  child('text.lowerCase', CaseSensitive, 'lower case'),
  child('text.titleCase', CaseSensitive, 'Title Case'),
])

const START_WITH = opener('turn.startWith', Replace, 'Start with…', [
  ...[1, 2, 3, 4, 5, 6].map((level) => child(`outline.makeHeadingLevel${level}`, HeadingIcon, `Heading ${level}`)),
  child('list.bullet', List, 'Bullet list'),
  child('list.ordered', ListOrdered, 'Numbered list'),
])

const SHOW_LEVELS = opener('outline.showLevels', Hash, 'Show levels', [
  ...[1, 2, 3, 4, 5, 6].map((level) => child(`outline.showLevel${level}`, Hash, `Level ${level}`)),
  child('outline.showAllLevels', Hash, 'All levels'),
])

const DUPLICATE_BLOCK = row('block.duplicate', CopyPlus, 'Duplicate block')
const DELETE_BLOCK = row('block.delete', Trash2, 'Delete block')

const PROSE_ROWS = (turn: LayoutItem | undefined, place: Place): LayoutItem[] => [
  INSERT, FORMAT, ...(turn ? [turn] : []), SEP,
  MOVE_BLOCK, DUPLICATE_BLOCK, DELETE_BLOCK, SEP,
  COMMENT, ask(place), readAloud('Read aloud from here'),
]

const HEADING_ROWS = (turn: LayoutItem | undefined, place: Place): LayoutItem[] => [
  INSERT, ...(turn ? [turn] : []), SEP,
  split('move.section', ArrowUpDown, 'Move section', 'outline.moveSubtreeUp', 'outline.moveSubtreeDown'),
  row('fold.current', ChevronsDownUp, 'Fold section'),
  row('outline.newHeadingBefore', ListPlus, 'New heading before this'),
  row('outline.newSubheading', ListPlus, 'New subheading under this'),
  row('outline.deleteCurrentSection', Trash2, 'Delete section'), SEP,
  COMMENT, ask(place), readAloud('Read aloud from here'),
]

const LIST_ROWS = (turn: LayoutItem | undefined, place: Place): LayoutItem[] => [
  INSERT, FORMAT, ...(turn ? [turn] : []),
  split('indent.item', IndentIncrease, 'Indent / outdent', 'outline.indentListItem', 'outline.outdentListItem'), SEP,
  MOVE_BLOCK, DUPLICATE_BLOCK, DELETE_BLOCK, SEP,
  COMMENT, ask(place), readAloud('Read aloud from here'),
]

const FOLDER_ROWS: LayoutItem[] = [
  row('folder.newFile', FilePlus, 'New file here'),
  row('folder.newFolder', FolderPlus, 'New subfolder…'), SEP,
  row('folder.rename', PencilLine, 'Rename folder'),
  row('folder.reveal', FolderOpen, 'Reveal in Finder'),
  row('folder.focus', Focus, 'Focus on this folder'),
  row('folder.clearFocus', Eye, 'Clear focus'), SEP,
  row('folder.helpWithReport', Sparkles, 'Help with this report'), SEP,
  row('folder.trash', Trash2, 'Delete folder…'),
]

const objectRows = (editLabel: string, deleteLabel: string, turn: LayoutItem | undefined, place: Place): LayoutItem[] => [
  row('block.edit', SquarePen, editLabel), INSERT, ...(turn ? [turn] : []), SEP,
  MOVE_BLOCK,
  row('block.copy', Copy, 'Copy source'),
  row('block.delete', Trash2, deleteLabel), SEP,
  ask(place),
]

/** The drawn rows of each place, in order. */
export const LAYOUTS: Readonly<Record<Place, readonly LayoutItem[]>> = {
  paragraph: PROSE_ROWS(TURN_INTO.paragraph, 'paragraph'),
  selection: [
    { kind: 'strip', caption: 'Format', cells: FORMAT_CELLS },
    INSERT, SEP,
    COMMENT, ask('selection'), readAloud('Read aloud'), SEP,
    TURN_INTO.selection!, CHANGE_CASE, row('edit.selectNextOccurrence', TextSelect, 'Select next occurrence'),
  ],
  heading: HEADING_ROWS(TURN_INTO.heading, 'heading'),
  'heading-top': HEADING_ROWS(TURN_INTO['heading-top'], 'heading-top'),
  'list-item': LIST_ROWS(TURN_INTO['list-item'], 'list-item'),
  'task-item': [row('edit.toggleCheckbox', SquareCheck, 'Toggle checkbox'), ...LIST_ROWS(TURN_INTO['task-item'], 'task-item')],
  quotation: PROSE_ROWS(TURN_INTO.quotation, 'quotation'),
  table: [
    row('block.edit', SquarePen, 'Edit table'), INSERT, SEP,
    COLUMN, TURN_INTO.table!, SEP,
    MOVE_BLOCK,
    row('block.copy', Copy, 'Copy source'),
    row('block.delete', Trash2, 'Delete table'), SEP,
    ask('table'),
  ],
  'code-block': objectRows('Edit', 'Delete block', TURN_INTO['code-block'], 'code-block'),
  link: [
    row('navigation.followWikilink', ExternalLink, 'Follow link'),
    row('edit.link', LinkIcon, 'Edit link…'),
    row('idea.materialise', FilePlus, 'Create this note'), SEP,
    INSERT, SEP,
    ask('link'), readAloud('Read aloud from here'),
  ],
  image: objectRows('Edit image', 'Delete block', TURN_INTO.image, 'image'),
  metadata: [
    row('metadata.edit', SquarePen, 'Edit metadata'), INSERT, SEP,
    row('block.copy', Copy, 'Copy source'),
    row('block.delete', Trash2, 'Delete metadata'),
  ],
  'empty-document': [INSERT, START_WITH, SEP, ask('empty-document')],
  file: [
    row('file.open', FileText, 'Open'), SEP,
    row('file.rename', PencilLine, 'Rename'),
    row('file.move', FolderInput, 'Move to folder…'),
    row('file.duplicate', Copy, 'Duplicate'), SEP,
    row('file.pin', Pin, 'Pin favourite'),
    row('file.export', Upload, 'Export…'),
    row('file.reveal', FolderOpen, 'Reveal in Finder'),
    row('file.copyPath', ClipboardCopy, 'Copy file path'), SEP,
    row('file.trash', Trash2, 'Move to Bin…'),
  ],
  folder: FOLDER_ROWS,
  'focused-folder': FOLDER_ROWS,
  'outline-row': [
    row('outline.selectCurrentSection', TextSelect, 'Select this section'), SEP,
    row('outline.newHeadingBefore', ListPlus, 'New heading before this section'),
    row('outline.newSubheading', ListPlus, 'New subheading under this section'),
    split('level.row', IndentDecrease, 'Raise / lower the level', 'heading.decrease', 'heading.increase'),
    MOVE_BLOCK, SEP,
    row('outline.collapseAll', ChevronsDownUp, 'Collapse all'),
    row('outline.expandAll', ListTree, 'Expand all'),
    SHOW_LEVELS,
    row('outline.toggleWordCounts', Hash, 'Word counts'), SEP,
    row('outline.deleteCurrentSection', Trash2, 'Delete section'),
  ],
}

/** Every label the drawn menu shows, openers and split rows included (a lesson may name a row by what the menu calls it). */
export const MENU_LABELS: ReadonlySet<string> = new Set(Object.values(LAYOUTS).flatMap((items) => items.flatMap((item): string[] => {
  if (item.kind === 'row' || item.kind === 'split') return [item.label]
  if (item.kind === 'opener') return [item.label, ...item.children.flatMap((kid) => kid.kind === 'row' || kid.kind === 'composed' ? [kid.label] : [])]
  if (item.kind === 'strip') return item.cells.map((cell) => cell.label)
  return []
})))

/** The labels the menu gives one command, per place (a command may read differently where it is offered). */
export function menuLabelsOf(commandId: string): string[] {
  const labels = new Set<string>()
  for (const items of Object.values(LAYOUTS)) {
    for (const item of items) {
      if (item.kind === 'row' && item.id === commandId) labels.add(item.label)
      else if (item.kind === 'strip') item.cells.filter((cell) => cell.id === commandId).forEach((cell) => labels.add(cell.label))
      else if (item.kind === 'opener') item.children.forEach((kid) => { if ((kid.kind === 'row' || kid.kind === 'composed') && kid.id === commandId) labels.add(kid.label) })
    }
  }
  return [...labels]
}
