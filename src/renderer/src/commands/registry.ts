import { COLLECTION_PAGE_COMMANDS } from '../components/collection-page-commands'
import { commandAnnotations, type CommandAnnotation } from './registry-annotations'
import { TASK_GROUPS, taskGroupOf, type TaskGroup } from './command-task-groups'
import { placesOf, type PlaceDeclaration } from './command-places'
import { THEME_COMMANDS } from './theme-commands'
import { REFRESH_MODELS_COMMAND } from './model-refresh-command'
import type { EditorState, StateCommand } from '@codemirror/state'
import { canMaterialiseAtCaret } from '../editor/wikilinks'
import type { Command as EditorViewCommand } from '@codemirror/view'
import { redo, selectDocEnd, selectDocStart, selectLineBoundaryLeft, selectLineBoundaryRight, undo } from '@codemirror/commands'
import {
  deleteCurrentSection,
  indentListItem,
  jumpToNextHeading,
  jumpToPreviousHeading,
  makeHeadingAtLevel,
  makeHeadingAtSurroundingLevel,
  makeHeadingOneLevelDeeper,
  outdentListItem,
  selectCurrentSection,
} from '@app-patterns/outline'
import { demoteLine, demoteSubtree, moveBlockDownPicked, moveBlockUpPicked, moveSubtreeDownPicked, moveSubtreeUpPicked, newHeadingCommand, promoteLine, promoteSubtree } from '../editor/outline-selection'
import {
  canConvertBlockToCode,
  canConvertBlockToText,
  canConvertCodeToObjectKind,
  canConvertOutlineToMindMap,
  convertBlockToCode,
  convertBlockToText,
  convertCodeToObject,
  convertOutlineToMindMap,
  paletteCommands as editorCommands,
  turnIntoCommands,
  toggleStrikethrough,
} from '../editor/commands'
import { makePlainParagraph, toggleBlockquote, toggleBulletList, toggleOrderedList } from '../editor/block-marks'
import { insertTable } from '../editor/insert-block-object'
import { TABLE_COMMAND_LABELS } from './table-command-labels'
import { setViewModeCommand } from '../editor/view-mode'
import { toggleCheckbox } from '../editor/task-boxes'
import { indentLetteredListItem, outdentLetteredListItem, setListType } from '../editor/list-types'
import type { ListType } from '../editor/list-lines'

/** Tab / Shift-Tab: lettered and roman items nest in list-types.ts; the rest go on to Bridle. */
const indentAnyListItem: StateCommand = (target) => indentLetteredListItem(target) || indentListItem(target)
const outdentAnyListItem: StateCommand = (target) => outdentLetteredListItem(target) || outdentListItem(target)

/** The List type family, in the drawn order (frame 6). The action bar's list menu reads the ids. */
export const LIST_TYPE_COMMANDS: ReadonlyArray<{ id: string; label: string; keywords: string[]; target: ListType }> = [
  { id: 'list.type.lettered', label: 'List type: a. b. c.', keywords: ['lettered', 'alphabetical', 'letters'], target: 'lower-alpha' },
  { id: 'list.type.roman', label: 'List type: i. ii. iii.', keywords: ['roman', 'numerals'], target: 'lower-roman' },
  { id: 'list.type.numbered', label: 'List type: 1. 2. 3.', keywords: ['numbered', 'ordered', 'numbers'], target: 'decimal' },
  { id: 'list.type.bullet', label: 'List type: bullet', keywords: ['bullet', 'unordered'], target: 'bullet' },
  { id: 'list.type.checkboxes', label: 'List type: checkboxes', keywords: ['checkbox', 'task', 'todo', 'checklist'], target: 'checkboxes' },
]

export const COMMAND_GROUPS = [
  'Writing',
  'Reviewing',
  'Read aloud',
  'Navigation',
  'Files and versions',
  'Collections',
  'Capture and ideas',
  'Reading room',
  'Agent',
  'Skills',
  'View',
  'App',
] as const
export type CommandGroup = typeof COMMAND_GROUPS[number]
export type CommandSurface = 'palette' | 'sheet' | 'menu'
export type SheetSource = { kind: 'command'; commandId: string } | { kind: 'literal' }
type CommandDefinition = { id: string; label: string; keywords?: string[]; hint?: string; leadsFor?: string[]; keys?: string | string[]; group: CommandGroup; surfaces: CommandSurface[]; when?: (state: EditorState) => boolean; run?: StateCommand | EditorViewCommand; future?: 'ship2' | 'build'; sheetColumn?: 0 | 1 | 2; claimsChord?: boolean; sheetSource?: SheetSource }

/** `group` (the old twelve) is internal ordering data only; every list the writer sees uses `task`. */
/** `places` is where Actions here offers the command (command-places.ts); a sheet row that mirrors a
 *  command carries its source command's declaration and is never listed beside it. */
export type Command = CommandDefinition & CommandAnnotation & { task: TaskGroup; subgroup: string; places: PlaceDeclaration }

type SheetSeed =
  | { kind: 'command'; commandId: string; label: string; group?: CommandGroup; sheetColumn?: 0 | 1 | 2; future?: 'ship2' | 'build' }
  | { kind: 'literal'; label: string; keys?: string | string[]; group?: CommandGroup; sheetColumn?: 0 | 1 | 2; future?: 'ship2' | 'build' }
  | { kind: 'inline'; command: CommandDefinition }

/** A seed the BLOCK owns — the two that can be regrouped. An inline command carries its own group. */
type SheetRowSeed = Exclude<SheetSeed, { kind: 'inline' }>

const sheetCommand = (commandId: string, label: string, future?: 'ship2' | 'build'): SheetRowSeed =>
  ({ kind: 'command', commandId, label, ...(future ? { future } : {}) })

/**
 * A real registry command standing WHERE IT BELONGS in a cheat-sheet block, rather than a mirror row
 * of one. It takes its own id, so a command placed among the block's rows renumbers none of them —
 * sheet-row ids carry the content-verb annotations, and a renumbering would silently re-point them.
 */
const sheetInline = (command: CommandDefinition): SheetSeed => ({ kind: 'inline', command })

const sheetLiteral = (label: string, keys?: string | string[], future?: 'ship2' | 'build'): SheetRowSeed =>
  ({ kind: 'literal', label, ...(keys ? { keys } : {}), ...(future ? { future } : {}) })

const inSheetGroup = (group: CommandGroup, row: SheetRowSeed): SheetRowSeed => ({ ...row, group })
const inSheetGroupAt = (group: CommandGroup, sheetColumn: 0 | 1 | 2, row: SheetRowSeed): SheetRowSeed => ({ ...row, group, sheetColumn })

const sheet = (idNamespace: string, group: CommandGroup, column: 0 | 1 | 2, rows: SheetSeed[]): CommandDefinition[] => {
  // Only the block's OWN rows consume a number; an inline command brings its own id. That is what
  // lets a command be placed beside its siblings without renumbering the rows below it.
  let position = 0
  return rows.map((row) => {
    if (row.kind === 'inline') return row.command
    const index = position
    position += 1
    return {
      // The namespace is deliberately independent from the user-facing group. Sheet-row ids are
      // persisted command ids too, so regrouping must not rename them.
      id: `sheet.${idNamespace}.${index}`,
      label: row.label,
      ...(row.kind === 'literal' && row.keys ? { keys: row.keys } : {}),
      group: row.group ?? group,
      surfaces: ['sheet'] as CommandSurface[],
      sheetColumn: row.sheetColumn ?? column,
      claimsChord: false,
      sheetSource: (row.kind === 'command' ? { kind: 'command', commandId: row.commandId } : { kind: 'literal' }) as SheetSource,
      ...(row.future ? { future: row.future } : {}),
    }
  })
}

/**
 * Strikethrough is on Bold and Italic's OWN inline-marker path (editor/commands.ts), so it is read
 * where a reader looks for it: inside the cheat sheet's Editing block, between Italic and Link,
 * rather than at the tail of the structural commands. It is the real command, inlined into the
 * block (`sheetInline`), not a mirror row — one id, one row, rebindable like its siblings. Keyless
 * by the ADR-0040 ticket A1b ruling: this repo assigns chords in one app-wide sweep before release.
 */
const STRIKETHROUGH_COMMAND: CommandDefinition = { id: 'edit.strikethrough', label: 'Strikethrough', keywords: ['strike', 'strikethrough', 'delete'], group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: toggleStrikethrough }

const sheetCommands: CommandDefinition[] = [
  ...sheet('Files', 'Files and versions', 0, [sheetLiteral('Open folder or file', '⌘O'), sheetLiteral('Checkpoint (save is automatic)', '⌘S'), sheetLiteral('New file', '⌘N'), sheetLiteral('New folder', '⌃⌘N'), sheetLiteral('New window', '⌥⌘N'), sheetLiteral('File menu (sidebar row)', '⌘K'), sheetLiteral('Rename file or folder', 'F2'), sheetLiteral('Move to folder', 'M'), sheetLiteral('Duplicate file', '⌘D'), sheetLiteral('Move to Bin', '⌘⌫'), sheetLiteral('Close tab', '⌘W'), sheetCommand('tab.pin', 'Pin to strip / Unpin from strip')]),
  ...sheet('Navigation', 'Navigation', 0, [sheetCommand('app.quickOpen', 'Quick-open file or folder'), sheetLiteral('Find in file', '⌘F'), sheetLiteral('Filter the Files pane', '⌘F'), sheetLiteral('Next / previous match', ['⌘G', '⇧⌘G']), sheetLiteral('Show replace', '⌥⌘F'), sheetLiteral('Cycle tabs', '⌃⇥'), sheetCommand('navigation.nextTab', 'Next open tab'), sheetCommand('navigation.previousTab', 'Previous open tab'), sheetCommand('navigation.nextFolderFile', 'Next file in folder'), sheetCommand('navigation.previousFolderFile', 'Previous file in folder'), sheetLiteral('Focus editor', '⌘1'), sheetCommand('view.files', 'Open Files pane'), sheetCommand('view.openTabs', 'Open tabs'), sheetLiteral('Back / forward along link trail', ['⌃⌘←', '⌃⌘→']), sheetCommand('view.outline', 'Open Outline tab'), sheetCommand('app.search', 'Open Search tab'), sheetCommand('view.toggleLeftPane', 'Show/hide left sidebar'), sheetLiteral('Bookmark here', '⌘F2', 'ship2'), sheetLiteral('Next / previous bookmark', ['F3', '⇧F3'], 'ship2'), sheetLiteral('Jump to last change', '⌘4', 'ship2'), sheetLiteral('Outline row menu (outline row)', '⌘K')]),
  ...sheet('Editing', 'Writing', 1, [sheetCommand('edit.selectBodyExceptMetadata', 'Select all text (keep metadata)'), sheetCommand('edit.bold', 'Bold'), sheetCommand('edit.italic', 'Italic'), sheetInline(STRIKETHROUGH_COMMAND), sheetCommand('edit.link', 'Link'), sheetLiteral('Move line up / down', ['⌥↑', '⌥↓']), sheetLiteral('Collapse selection', '⌘5', 'ship2'), sheetCommand('edit.toggleComment', 'Toggle comment'), sheetCommand('edit.mark', 'Mark ==text=='), sheetCommand('edit.selectNextOccurrence', 'Select next occurrence'), sheetCommand('block.duplicate', 'Duplicate block'), sheetCommand('edit.joinLines', 'Join lines'), sheetLiteral('Drafting / Reviewing mode', '⌥⌘M'), sheetLiteral('Insert object', '⌘K'), sheetLiteral('Edit block / done', ['↵', '⌘↵']), sheetLiteral('Browse table cells', 'Esc'), sheetLiteral('Move table row / column', '⇧⌘arrows'), sheetLiteral('Next / previous block', ['⌃⌘↓', '⌃⌘↑'])]),
  // Skills took ⌥⌘1/2/3 on 2026-07-19 (OPEN-QUESTIONS #2; usability review confirm pending).
  // Round A focus modes ship UNASSIGNED : default chords arrive in the pre-v1
  // keyboard consolidation sweep, not per round. Assignable in Settings → Shortcuts (Task 6).
  ...sheet('Focus', 'Writing', 1, [sheetCommand('view.distractionFree', 'Distraction-free'), sheetCommand('view.typewriter', 'Typewriter mode'), sheetCommand('focus.open', 'Focus and readability…'), sheetCommand('focus.fade', 'Fade other paragraphs'), sheetCommand('focus.sentence', 'Highlight sentence'), sheetCommand('focus.segment', 'Segment focus'), sheetCommand('focus.breakup', 'Sentence breakup'), sheetCommand('focus.anchored', 'Anchored reading')]),
  ...sheet('Agent & Scratchpad', 'Agent', 2, [
    sheetCommand('app.commandPalette', 'Command palette'),
    sheetCommand('app.agent', 'Open Agent tab'),
    sheetCommand('app.scratchpad', 'Scratchpad'),
    sheetLiteral('Cut to a scrap', '⌘⇧X'),
    inSheetGroup('Reviewing', sheetLiteral('Accept change (at cursor)', '⌘⏎')),
    inSheetGroup('Reviewing', sheetLiteral('Reject change (at cursor)', '⇧⌘⏎')),
    inSheetGroup('Reviewing', sheetLiteral('Revise change', '⌘R')),
    sheetLiteral('Undo agent turn', '⌘⇧Z'),
    inSheetGroup('Reviewing', sheetCommand('review.focusMargin', 'Focus the review margin')),
    inSheetGroupAt('Files and versions', 0, sheetCommand('app.versions', 'Open Versions tab')),
    sheetCommand('view.toggleRightPane', 'Show/hide right pane'),
    inSheetGroup('Reviewing', sheetCommand('view.hideStrikes', 'Hide strikes')),
    inSheetGroup('Reviewing', sheetCommand('view.hideInserts', 'Hide inserts')),
    inSheetGroupAt('Files and versions', 0, sheetCommand('file.nameVersion', 'Save version')),
    inSheetGroupAt('Files and versions', 0, sheetLiteral('Compare versions', '⌥⌘C')),
    inSheetGroupAt('Files and versions', 0, sheetLiteral('Swap compare direction', '⌥⌘S')),
    inSheetGroupAt('Files and versions', 0, sheetLiteral('Back to editing from Compare', 'Esc')),
    inSheetGroupAt('Files and versions', 0, sheetLiteral('Return from version view', 'Esc')),
    inSheetGroup('Reviewing', sheetCommand('review.acceptAll', 'Accept all / selected')),
    inSheetGroup('Reviewing', sheetCommand('review.declineAll', 'Decline all / selected')),
    inSheetGroup('Reviewing', sheetCommand('review.sendBack', 'Send review back')),
    sheetLiteral('Use a proposed running order (card focused)', '⌘↵'),
    sheetLiteral('Move a row in a proposed order', ['⌥↑', '⌥↓']),
    // Appended at the end so the numbered ids of the rows above stay put.
    inSheetGroup('Reviewing', sheetLiteral('Accept · Decline · Reply (margin card focused)', ['A', 'D', 'R'])),
    inSheetGroup('Reviewing', sheetLiteral('Hold both · Send original · No heading (margin card focused)', ['H', 'S', 'N'])),
    inSheetGroup('Reviewing', sheetLiteral('Copy wording · Dismiss (edit that could not be applied)', ['C', '⌫'])),
    inSheetGroup('Reviewing', sheetLiteral('Reopen / Return to review (settled card)', 'O')),
    inSheetGroup('Reviewing', sheetLiteral('Show in text (margin card focused)', '↵')),
    inSheetGroup('Reviewing', sheetLiteral('Pick a card for a bulk action (margin card focused)', 'Space')),
    inSheetGroup('Reviewing', sheetLiteral('Close popover, composer, card, then Settled today / My edits', 'Esc')),
  ]),
  ...sheet('History recovery', 'Files and versions', 0, [sheetLiteral('Attach waiting history here (button focused)', '↵')]),
  ...sheet('View', 'View', 2, [sheetLiteral('Prose size', ['⌘+', '⌘−']), sheetLiteral('Column width', ['⌥⌘+', '⌥⌘−']), sheetLiteral('Reset zoom', '⌥⌘0'), sheetLiteral('Open mode drawer', '⌥⌘R')]),
  ...sheet('App', 'App', 2, [sheetCommand('app.settings', 'Settings'), sheetLiteral('Open Library', '⇧⌘L', 'ship2')]),
]

const menuCommands: CommandDefinition[] = [
  ['file.open','Open','↵','Files and versions'],['file.rename','Rename','F2','Files and versions'],['file.move','Move to folder…','M','Files and versions'],['file.duplicate','Duplicate','⌘D','Files and versions'],['file.pin','Pin favourite',undefined,'Files and versions'],['file.export','Export…',undefined,'Files and versions'],['file.reveal','Reveal in Finder',undefined,'Files and versions'],['file.copyPath','Copy file path',undefined,'Files and versions'],['file.trash','Move to Bin…','⌘⌫','Files and versions'],
  ['folder.newFile','New file here','⌘N','Files and versions'],['folder.newFolder','New subfolder…',undefined,'Files and versions'],['folder.rename','Rename folder','F2','Files and versions'],['folder.reveal','Reveal in Finder',undefined,'Files and versions'],['folder.trash','Delete folder…',undefined,'Files and versions'],['folder.focus','Focus',undefined,'Navigation'],['folder.clearFocus','Clear focus',undefined,'Navigation'],['folder.helpWithReport','Help with this report',undefined,'Skills'],
  ['insert.reference','Reference…',undefined,'Capture and ideas'],['insert.metadata','Metadata',undefined,'Writing'],['insert.image','Image…',undefined,'Writing'],['insert.widget','Insert widget…',undefined,'Writing',{ surfaces: ['palette', 'menu'], keywords: ['widget', 'simulation', 'interactive', 'embed', 'html', 'insert'] }],['insert.code','Code block',undefined,'Writing'],['insert.mermaid','Flow diagram',undefined,'Writing'],['insert.markmap','Mind map',undefined,'Writing'],['insert.svg','SVG',undefined,'Writing'],['insert.divider','Divider',undefined,'Writing'],['insert.footnote','Footnote',undefined,'Writing'],
  ['block.edit','Edit','↵','Writing'],['block.copy','Copy source',undefined,'Writing'],['block.delete','Delete block…',undefined,'Writing'],
  ['table.alignLeft',TABLE_COMMAND_LABELS.alignLeft,undefined,'Writing'],['table.alignCentre',TABLE_COMMAND_LABELS.alignCentre,undefined,'Writing'],['table.alignRight',TABLE_COMMAND_LABELS.alignRight,undefined,'Writing'],['table.insertLeft',TABLE_COMMAND_LABELS.insertLeft,undefined,'Writing'],['table.insertRight',TABLE_COMMAND_LABELS.insertRight,undefined,'Writing'],['table.delete',TABLE_COMMAND_LABELS.delete,undefined,'Writing'],
].map(([id,label,keys,group,extra]) => ({ id: id as string, label: label as string, ...(keys ? { keys: keys as string } : {}), group: group as CommandGroup, surfaces: ['menu'] as CommandSurface[], ...(extra as Partial<CommandDefinition> | undefined) }))

const commandDefinitions: CommandDefinition[] = [
  ...sheetCommands,
  { id: 'skill.run.copy-edit', label: 'Run Copy-edit on the document', keys: '⌥⌘1', group: 'Skills', surfaces: ['sheet'], sheetColumn: 2 },
  { id: 'skill.run.review', label: 'Run Review on the document', keys: '⌥⌘2', group: 'Skills', surfaces: ['sheet'], sheetColumn: 2 },
  { id: 'skill.run.clean-up', label: 'Run Clean-up on the document', keys: '⌥⌘3', group: 'Skills', surfaces: ['sheet'], sheetColumn: 2 },
  // Ticket 10: the report skill on the focused folder (the Plan pane and folder menu name their own).
  { id: 'skill.run.report-structure', label: 'Help with this report', group: 'Skills', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'skills.openThread', label: 'Open a skill thread', keys: ['⇧⌥⌘1', '⇧⌥⌘2', '⇧⌥⌘3'], group: 'Skills', surfaces: ['sheet'], sheetColumn: 2 },
  { id: 'threads.new', label: 'Start a new conversation', group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'threads.switcher', label: 'Show conversations', keys: '⌃⌘T', group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'threads.closeCurrent', label: 'Close the current conversation', group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'agent.manageAccounts', label: 'Manage assistant accounts', group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'skills.manage', label: 'Manage skills…', group: 'Skills', surfaces: ['sheet'], sheetColumn: 2 },
  ...editorCommands.map((command) => {
    const isFoldCommand = command.id.startsWith('fold.') || command.id === 'edit.flagSelection' || command.id === 'edit.clearFlag'
    return {
      ...command,
      group: 'Writing' as const,
      surfaces: (isFoldCommand ? ['palette', 'sheet'] : ['palette']) as CommandSurface[],
      ...(isFoldCommand ? { sheetColumn: 1 as const } : {}),
    }
  }),
  { id: 'metadata.show', label: 'Show metadata', group: 'Writing', surfaces: ['palette'] },
  { id: 'metadata.collapse', label: 'Collapse metadata', group: 'Writing', surfaces: ['palette'] },
  { id: 'metadata.edit', label: 'Edit metadata', group: 'Writing', surfaces: ['palette'] },
  { id: 'navigation.nextTab', label: 'Next open tab', keys: '⇧⌘]', group: 'Navigation', surfaces: ['palette'] },
  { id: 'navigation.previousTab', label: 'Previous open tab', keys: '⇧⌘[', group: 'Navigation', surfaces: ['palette'] },
  { id: 'navigation.nextPanelTab', label: 'Next panel tab', keys: '⌃⌘⇥', group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'navigation.previousPanelTab', label: 'Previous panel tab', keys: '⌃⇧⌘⇥', group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'navigation.nextFolderFile', label: 'Next file in folder', keys: '⌥⌘]', group: 'Navigation', surfaces: ['palette'] },
  { id: 'navigation.previousFolderFile', label: 'Previous file in folder', keys: '⌥⌘[', group: 'Navigation', surfaces: ['palette'] },
  { id: 'view.openTabs', label: 'Open tabs', keys: '⌘2', group: 'Navigation', surfaces: ['palette'] },
  // Ticket 16 (2026-10-06): ⌥⌘↑↓←→ became the structure family shared with TalkWeaver, so the two
  // displaced raw handlers become named, rebindable commands on the freed ⌃⌘ arrows. Collision-ladder
  // log: next/previous block ⌥⌘↓/⌥⌘↑ (taken by move block) -> ⌃⌘↓/⌃⌘↑ (freed in the same change);
  // link trail back/forward ⌥⌘←/⌥⌘→ (taken by raise/lower level) -> ⌃⌘←/⌃⌘→ (freed in the same change).
  { id: 'navigation.nextBlock', label: 'Next rendered block', keys: '⌃⌘↓', group: 'Navigation', surfaces: ['palette'] },
  { id: 'navigation.previousBlock', label: 'Previous rendered block', keys: '⌃⌘↑', group: 'Navigation', surfaces: ['palette'] },
  { id: 'navigation.linkTrailBack', label: 'Back along link trail', keys: '⌃⌘←', group: 'Navigation', surfaces: ['palette'] },
  { id: 'navigation.linkTrailForward', label: 'Forward along link trail', keys: '⌃⌘→', group: 'Navigation', surfaces: ['palette'] },
  { id: 'tab.pin', label: 'Pin to strip / Unpin from strip', keys: '⌥⌘P', group: 'Navigation', surfaces: ['palette'] },
  // Focus a folder (ticket 03): a view state that narrows the tree and scopes search. Keyless, like
  // every new command: chords are assigned in the one app-wide sweep before release.
  { id: 'view.focusFolder', label: 'Focus on the open file’s Collection', keywords: ['focus', 'folder', 'folio', 'collection', 'narrow', 'scope', 'project', 'tree'], group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'view.clearFolderFocus', label: 'Clear folder focus', keywords: ['focus', 'folder', 'whole archive', 'everywhere', 'unfocus'], group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'files.filter', label: 'Filter files…', group: 'Navigation', surfaces: ['palette'] },
  { id: 'sheet.FileSearch.0', label: 'Move through file search suggestions', keys: ['↑', '↓'], group: 'Navigation', surfaces: ['sheet'], claimsChord: false, sheetSource: { kind: 'literal' } },
  { id: 'sheet.FileSearch.1', label: 'Complete a file search prefix or folder', keys: ['↵', '⇥'], group: 'Navigation', surfaces: ['sheet'], claimsChord: false, sheetSource: { kind: 'literal' } },
  { id: 'sheet.FileSearch.2', label: 'Open the first file search result', keys: '↵', group: 'Navigation', surfaces: ['sheet'], claimsChord: false, sheetSource: { kind: 'literal' } },
  { id: 'sheet.FileSearch.3', label: 'Clear file search / close the empty search box', keys: 'Esc', group: 'Navigation', surfaces: ['sheet'], claimsChord: false, sheetSource: { kind: 'literal' } },
  { id: 'writer.newSession', label: 'Start a new review session', group: 'Reviewing', surfaces: ['palette'] },
  // Diary Session Starter (0.18): one free default outside the estate-reserved map; End and target
  // adjustment are live-gated by App while an explicit session runs.
  { id: 'session.start', label: 'Start a focused writing session…', keys: '⌃⌥⌘S', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'session.end', label: 'End focused writing session', group: 'Writing', surfaces: ['palette'] },
  { id: 'session.adjustTarget', label: 'Adjust writing-session target…', group: 'Writing', surfaces: ['palette'] },
  // Round A goals (Task 5, ADR-0019): the writer states an intent; the command writes `goal:`/`due:`
  // into the active document's frontmatter. Keyless by the pre-v1 ruling; the Goal Gauge opens it too.
  { id: 'goal.set', label: 'Set writing goal…', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  // Round B copy (T5, PRD §2): three commands, three flavours. "Copy as rich text" writes RTF, HTML
  // and plain text TOGETHER — one flavour is exactly what fails in Teams and Word. The scope is the
  // selection if there is one, otherwise the whole document; there is no scope dialog and no second
  // command. Keyless by the pre-v1 ruling; App supplies the runs (the goal.set pattern).
  { id: 'copy.rich', label: 'Copy as rich text', group: 'Files and versions', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'copy.markdown', label: 'Copy as Markdown', group: 'Files and versions', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'copy.plain', label: 'Copy as plain text', group: 'Files and versions', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'file.clearDocument', label: 'Clear document…', group: 'Files and versions', surfaces: ['palette'] },
  // Round B export (T6/T7, ADR-0029): the Export sheet — format, and inside a Collection the scope.
  // Keyless by the same pre-v1 ruling; App supplies the run. Copy never opens the sheet.
  { id: 'export.document', label: 'Export…', keys: '⌥⌘E', group: 'Files and versions', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'exportPresets.apply', label: 'Apply export preset', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.update', label: 'Update export preset', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.saveAs', label: 'Save export preset as…', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.manage', label: 'Manage export presets', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.rename', label: 'Rename export preset', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.delete', label: 'Delete export preset', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.moveUp', label: 'Move export preset up', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'exportPresets.moveDown', label: 'Move export preset down', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'writer.acceptSession', label: 'Accept session', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'change.revertToActive', label: 'Return change to review', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'change.sendOriginalToScratchpad', label: 'Send original to Scratchpad', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'review.nextChange', label: 'Next change', keys: '⌥⌘G', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'review.previousChange', label: 'Previous change', keys: '⇧⌥⌘G', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'review.showAll', label: 'Show all in the margin', keys: '⌃⌥⌘1', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2, keywords: ['review', 'margin', 'filter', 'all', 'comments', 'edits'] },
  { id: 'review.showComments', label: 'Show comments only', keys: '⌃⌥⌘2', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2, keywords: ['review', 'margin', 'filter', 'comments', 'notes'] },
  { id: 'review.showEdits', label: 'Show edits only', keys: '⌃⌥⌘3', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2, keywords: ['review', 'margin', 'filter', 'edits', 'changes'] },
  { id: 'review.nextPieceWaiting', label: 'Next piece with items waiting', keys: '⌃⌥⌘G', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2, keywords: ['review', 'margin', 'other pieces', 'waiting'] },
  { id: 'review.switchMarginView', label: 'Switch Margin / Inline', keys: '⇧⌥⌘V', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2, keywords: ['review', 'margin', 'under', 'inline', 'cards', 'view'] },
  { id: 'review.toggleMargin', label: 'Show or hide the margin', keys: '⇧⌥⌘M', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2, keywords: ['review', 'margin', 'hide', 'show', 'cards'] },
  { id: 'review.settledToday', label: 'Settled today', hint: 'Reopen anything settled today', leadsFor: ['review'], group: 'Reviewing', surfaces: ['palette'], keywords: ['review', 'settled', 'reopen', 'return to review', 'accepted', 'declined', 'today'] },
  { id: 'review.myEdits', label: 'My edits', hint: 'Your recorded edits in this piece', leadsFor: ['review'], group: 'Reviewing', surfaces: ['palette'], keywords: ['review', 'mine', 'yours', 'recorded', 'accept session'] },
  { id: 'review.showQuietFixes', label: 'Show quiet fixes', hint: 'Small fixes applied without a card', leadsFor: ['review'], group: 'Reviewing', surfaces: ['palette'], keywords: ['review', 'quiet', 'typo', 'copy', 'fixes', 'hide'] },
  { id: 'review.acceptAndNext', label: 'Accept and next', keys: '⌥⌘↵', group: 'Reviewing', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'view.toggleLeftPane', label: 'Show/hide left sidebar', keys: '⌘[', group: 'View', surfaces: ['palette'] },
  { id: 'view.toggleRightPane', label: 'Show/hide right pane', keys: '⌘]', group: 'View', surfaces: ['palette'] },
  { id: 'view.distractionFree', label: 'View: Distraction-free', keys: '⌥⌘D', group: 'Writing', surfaces: ['palette'] },
  // The action bar (ADR-0040). The bar's ONE way back in is the toolbar's panel-top toggle plus
  // this command — no fold chevron on the bar itself. Keyless by the pre-v1 ruling and by the
  // drawing, which shows the toggle carrying no chord glyph where its siblings show ⌘[ and ⌘];
  // the app-wide sweep assigns a default before release, and it is assignable today.
  { id: 'view.actionBar', label: 'Show/Hide the action bar', group: 'View', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Configuring the bar is HALF the feature, not a nice-to-have (ADR-0040), so it is a command in
  // its own right rather than a button only a mouse can find: the sheet is reachable from the
  // palette, from Settings → Action bar, and from the bar's own control. Keyless, like its sibling.
  { id: 'view.configureActionBar', label: 'Configure the action bar…', group: 'View', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Undo and redo have always been CodeMirror history keys with no command behind them — findable
  // only by already knowing ⌘Z. The action bar's first group needs them as real commands, and
  // ADR-0011 wants them registered regardless: palette-listed, cheat-sheet documented, rebindable.
  { id: 'edit.undo', label: 'Undo', keys: 'Mod-z', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: undo },
  { id: 'edit.redo', label: 'Redo', keys: 'Shift-Mod-z', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: redo },
  // Round A (ADR-0028): "Focus and readability…" opens the transient Focus Picker; each mode is ALSO its own direct
  // command (palette + assignable chord) whose run toggles it — re-invoking the active mode = Off.
  // All keyless by ruling; App supplies the runs (the view.distractionFree pattern).
  { id: 'focus.open', label: 'Focus and readability…', group: 'Writing', surfaces: ['palette'] },
  { id: 'focus.fade', label: 'Fade other paragraphs', group: 'Writing', surfaces: ['palette'] },
  { id: 'focus.sentence', label: 'Highlight sentence', group: 'Writing', surfaces: ['palette'] },
  { id: 'focus.segment', label: 'Segment focus', group: 'Writing', surfaces: ['palette'] },
  { id: 'focus.breakup', label: 'Sentence breakup', group: 'Writing', surfaces: ['palette'] },
  { id: 'focus.anchored', label: 'Anchored reading', group: 'Writing', surfaces: ['palette'] },
  // Line focus and Ruler (2026-10-07): overlays beside the exclusive modes, palette-only and keyless.
  { id: 'focus.lineFocus', label: 'Focus: Line focus', group: 'Writing', surfaces: ['palette'] },
  { id: 'focus.ruler', label: 'Focus: Ruler', group: 'Writing', surfaces: ['palette'] },
  { id: 'lineFocus.size1', label: 'Line focus: 1 line', group: 'Writing', surfaces: ['palette'] },
  { id: 'lineFocus.size3', label: 'Line focus: 3 lines', group: 'Writing', surfaces: ['palette'] },
  { id: 'lineFocus.size5', label: 'Line focus: 5 lines', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.covers.thin', label: 'Ruler: thin rule', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.covers.1', label: 'Ruler: 1 line', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.covers.3', label: 'Ruler: 3 lines', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.covers.5', label: 'Ruler: 5 lines', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.covers.below', label: 'Ruler: all below', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.opacity.lighter', label: 'Ruler opacity: lighter', group: 'Writing', surfaces: ['palette'] },
  { id: 'ruler.opacity.darker', label: 'Ruler opacity: darker', group: 'Writing', surfaces: ['palette'] },
  { id: 'lineOverlay.followByHand', label: 'Line focus / Ruler: follow by hand', group: 'Writing', surfaces: ['palette'] },
  { id: 'lineOverlay.followTypewriter', label: 'Line focus / Ruler: follow typewriter', group: 'Writing', surfaces: ['palette'] },
  // Read-aloud keyboard amendment (ADR-0037): one registry row owns each palette, ledger and sheet
  // entry. The explicit Read aloud command stays keyless; pauseResume owns the single transport key.
  { id: 'readAloud.start', label: 'Read aloud', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.pauseResume', label: 'Read aloud — start, pause, or carry on', keys: '⌃⌥R', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.stop', label: 'Stop reading', keys: '⌃⌥⇧R', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.faster', label: 'Read faster', keys: '⌃⌥.', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.slower', label: 'Read slower', keys: '⌃⌥,', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.nextSentence', label: 'Next sentence', keywords: ['read aloud', 'speech', 'skip', 'jump'], keys: '⌃⌥→', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.previousSentence', label: 'Previous sentence', keywords: ['read aloud', 'speech', 'skip', 'jump'], keys: '⌃⌥←', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.nextParagraph', label: 'Next paragraph', keywords: ['read aloud', 'speech', 'skip', 'jump'], keys: '⌃⌥↓', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.previousParagraph', label: 'Previous paragraph', keywords: ['read aloud', 'speech', 'skip', 'jump'], keys: '⌃⌥↑', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.returnToReading', label: 'Return to the reading', keys: '⌃⌥J', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'readAloud.chooseVoice', label: 'Read aloud settings…', keys: '⌃⌥V', group: 'Read aloud', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  // Fixed line (2026-10-06, read-aloud word and line): palette-only, keyless; one height shared by
  // read-aloud and typewriter mode. The marker and Settings → Editor set the same setting.
  // Read-aloud highlight colour (2026-10-07, ticket 08): one palette-only, keyless row per preset;
  // Settings → Editor also offers Custom… and the Strength control.
  ...(['terracotta', 'amber', 'green', 'blue', 'lilac', 'grey'] as const).map((preset) => ({
    id: `readAloudHighlight.${preset}`,
    label: `Read-aloud highlight: ${preset}`,
    keywords: ['read aloud', 'colour', 'color', 'highlight', 'wash', 'sentence'],
    group: 'Read aloud' as const,
    surfaces: ['palette' as const],
  })),
  { id: 'fixedLine.topThird', label: 'Fixed line: top third', keywords: ['typewriter', 'read aloud', 'line position', 'height'], group: 'View', surfaces: ['palette'] },
  { id: 'fixedLine.middle', label: 'Fixed line: middle', keywords: ['typewriter', 'read aloud', 'line position', 'height', 'centre'], group: 'View', surfaces: ['palette'] },
  { id: 'fixedLine.lowerThird', label: 'Fixed line: lower third', keywords: ['typewriter', 'read aloud', 'line position', 'height'], group: 'View', surfaces: ['palette'] },
  { id: 'outline.moveBlockUp', label: 'Move this block up', keys: '⌥⌘↑', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: moveBlockUpPicked },
  { id: 'outline.moveBlockDown', label: 'Move this block down', keys: '⌥⌘↓', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: moveBlockDownPicked },
  { id: 'outline.moveSubtreeUp', label: 'Move this with everything under it up', keys: '⇧⌥⌘↑', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: moveSubtreeUpPicked },
  { id: 'outline.moveSubtreeDown', label: 'Move this with everything under it down', keys: '⇧⌥⌘↓', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: moveSubtreeDownPicked },
  { id: 'heading.decrease', label: 'Raise the level of this line', keys: '⌥⌘←', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: promoteLine },
  { id: 'heading.increase', label: 'Lower the level of this line', keys: '⌥⌘→', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: demoteLine },
  { id: 'outline.raiseSubtreeLevel', label: 'Raise the level with everything under it', keys: '⇧⌥⌘←', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: promoteSubtree },
  { id: 'outline.lowerSubtreeLevel', label: 'Lower the level with everything under it', keys: '⇧⌥⌘→', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: demoteSubtree },
  // Outline extras (ticket 17): the right-click menu's items are all commands. Promote, Demote, Move,
  // Select section text and Delete section are the commands above; these are the rest. The four that
  // change what the outline panel shows are dispatched by App (no run).
  { id: 'outline.newHeadingBefore', label: 'New heading before this section', group: 'Writing', surfaces: ['palette'], run: newHeadingCommand('before') },
  { id: 'outline.newSubheading', label: 'New subheading under this section', group: 'Writing', surfaces: ['palette'], run: newHeadingCommand('sub') },
  // Outline keyboard: ⌘K on a focused outline row opens that row's menu (a contextual meaning, like ⌘K in the Files
  // tree and in the editor, so it is documented as a sheet literal rather than claimed as a chord). This is the
  // same menu from the palette, for the row the outline has focused or the cursor's section.
  { id: 'outline.rowMenu', label: 'Outline: Open the menu for this row', keywords: ['outline', 'context menu', 'row menu', 'section'], group: 'Navigation', surfaces: ['palette'] },
  { id: 'outline.expandAll', label: 'Outline: Expand all', group: 'Navigation', surfaces: ['palette'] },
  { id: 'outline.collapseAll', label: 'Outline: Collapse all', group: 'Navigation', surfaces: ['palette'] },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ id: `outline.showLevel${level}`, label: `Outline: Show levels 1 to ${level}`, group: 'Navigation' as const, surfaces: ['palette'] as CommandSurface[] })),
  { id: 'outline.showAllLevels', label: 'Outline: Show all levels', group: 'Navigation', surfaces: ['palette'] },
  { id: 'outline.toggleWordCounts', label: 'Outline: Show / hide word counts', group: 'Navigation', surfaces: ['palette'] },
  { id: 'outline.makeHeadingAtSurroundingLevel', label: 'Make this line a heading at the surrounding level', keys: '⌃⌘M', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: makeHeadingAtSurroundingLevel },
  { id: 'outline.makeHeadingOneLevelDeeper', label: 'Make this line a heading one level deeper', keys: '⌃⇧⌘M', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: makeHeadingOneLevelDeeper },
  { id: 'outline.previousHeading', label: 'Previous heading', keys: '⌃⌘[', group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0, run: jumpToPreviousHeading },
  { id: 'outline.nextHeading', label: 'Next heading', keys: '⌃⌘]', group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0, run: jumpToNextHeading },
  { id: 'outline.deleteCurrentSection', label: 'Delete this section', keys: '⌃⌘⌫', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: deleteCurrentSection },
  { id: 'outline.selectCurrentSection', label: 'Select this section', keys: '⌃⌘A', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: selectCurrentSection },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({ id: `outline.makeHeadingLevel${level}`, label: `Insert heading, level ${level}`, keys: `⌃⌘${level}`, group: 'Writing' as const, surfaces: ['palette', 'sheet'] as CommandSurface[], sheetColumn: 1 as const, run: makeHeadingAtLevel(level) })),
  { id: 'outline.indentListItem', label: 'Indent list item with children', keys: '⇥', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: indentAnyListItem },
  { id: 'outline.outdentListItem', label: 'Outdent list item with children', keys: '⇧⇥', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: outdentAnyListItem },
  { id: 'selection.lineStart', label: 'Select to the start of the line', keys: '⇧⌘←', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: selectLineBoundaryLeft },
  { id: 'selection.lineEnd', label: 'Select to the end of the line', keys: '⇧⌘→', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: selectLineBoundaryRight },
  { id: 'selection.documentStart', label: 'Select to the start of the document', keys: '⇧⌘↑', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: selectDocStart },
  { id: 'selection.documentEnd', label: 'Select to the end of the document', keys: '⇧⌘↓', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: selectDocEnd },
  // Round A sounds (Task 4): palette + cheat-sheet toggles, keyless by the same pre-v1 ruling.
  // Channel state lives in Settings → Sounds; App supplies the runs (the focus.* pattern).
  { id: 'sounds.typing', label: 'Toggle typing sounds', group: 'App', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'sounds.ambient', label: 'Toggle ambient sound', group: 'App', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Theme (2026-09-13): palette-only, keyless; App supplies the runs via theme-commands.ts.
  ...THEME_COMMANDS.map((command): CommandDefinition => ({ id: command.id, label: command.label, keywords: [...command.keywords], group: 'App', surfaces: ['palette'] })),
  { id: 'collection.openBoard', label: 'Open Board', keys: '⇧⌘B', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // Folder dashboard button (2026-10-14): palette-only, keyless; opens the page that lists a folder's pieces.
  { id: 'collection.openDashboard', label: 'Open Folder dashboard', group: 'Collections', surfaces: ['palette'] },
  // Vaults ticket 03: palette-only, keyless; opens the preview sheet. Disabled with "already a vault" on a vault.
  // Record browser (standard widgets, ticket 04b): palette-only and keyless. New opens the Source and preview tab
  // for the open document; Edit opens it on the made widget under the caret; Undo takes back the last step.
  { id: 'widget.newRecordBrowser', label: 'New record browser…', keywords: ['widget', 'csv', 'json', 'records', 'browse', 'data', 'table', 'source', 'insert'], group: 'Writing', surfaces: ['palette'] },
  { id: 'widget.editRecordBrowser', label: 'Edit record browser…', keywords: ['widget', 'csv', 'json', 'records', 'mapping', 'source', 'preview', 'settings'], group: 'Writing', surfaces: ['palette'] },
  { id: 'widget.undoStep', label: 'Undo last widget step', keywords: ['widget', 'undo', 'record browser', 'remove', 'take back'], group: 'Writing', surfaces: ['palette'] },
  { id: 'vault.make', label: 'Make this folder a vault…', group: 'Collections', surfaces: ['palette'] },
  // Vaults ticket 06: palette-only, keyless. The switcher menu (same as clicking the sidebar's root name),
  // and the vault sidebar's two view choices as toggles that show On / Off; both disabled on a plain folder.
  { id: 'vault.switch', label: 'Switch vault…', group: 'Collections', surfaces: ['palette'], keywords: ['vault', 'folder', 'switch', 'open', 'change'] },
  { id: 'vault.writingOnly', label: 'Writing only', group: 'Collections', surfaces: ['palette'], keywords: ['vault', 'filter', 'hide', 'all files', 'sidebar'] },
  { id: 'vault.showTitles', label: 'Show titles in sidebar', group: 'Collections', surfaces: ['palette'], keywords: ['vault', 'titles', 'file names', 'sidebar'] },
  // Offcuts on the Board (scraps ticket 02): keyless and palette-listed, acting on the Board's selection.
  { id: 'board.makeIdeaFromOffcut', label: 'Make idea from offcut', group: 'Collections', surfaces: ['palette'] },
  { id: 'board.toggleOffcuts', label: 'Show / Hide offcuts', group: 'Collections', surfaces: ['palette'] },
  { id: 'board.undoMaterialStep', label: 'Undo last offcut, scrap or source step', group: 'Collections', surfaces: ['palette'] },
  // The Sources rail (scraps ticket 03): keyless and palette-listed. Attach acts on the selected source,
  // then on the selected card while that source is carried.
  { id: 'board.moveColumnLeft', label: 'Move column left', group: 'Collections', surfaces: ['palette'] },
  { id: 'board.moveColumnRight', label: 'Move column right', group: 'Collections', surfaces: ['palette'] },
  { id: 'collection.newDocument', label: 'New document', group: 'Collections', surfaces: ['palette'] },
  ...COLLECTION_PAGE_COMMANDS.map(([name, label]): CommandDefinition => ({ id: `collection.page.${name}`, label, group: 'Collections', surfaces: ['palette', 'menu'] })),
  { id: 'collection.startFolio', label: 'Start a Folio outline', group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.turnBack', label: 'Turn back into a collection', group: 'Collections', surfaces: ['palette'] },
  { id: 'board.toggleSources', label: 'Show / Hide sources', group: 'Collections', surfaces: ['palette'] },
  { id: 'board.attachSource', label: 'Attach source…', group: 'Collections', surfaces: ['palette'] },
  // List this piece's sources (scraps ticket 04): on the open piece, or the Board's selected card.
  { id: 'piece.listSources', label: 'List this piece\'s sources', keywords: ['sources', 'cited', 'citations', 'references'], group: 'Collections', surfaces: ['palette'] },
  // Capture to research (knowledge step two, 2026-10-20): palette-only, keyless; opens the sheet that files one unit through `scout capture`.
  { id: 'research.capture', label: 'Capture to research…', keywords: ['research', 'evidence', 'table', 'snippet', 'file', 'save', 'scout'], group: 'Capture and ideas', surfaces: ['palette'] },
  { id: 'plan.open', label: 'Open Folio outline', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // Previous / next piece of the Folio the open file belongs to (the order of its running order, not the
  // folder's). Keyless on purpose: ⌥⌘] and ⌥⌘[ keep their folder-order meaning.
  // Open Folio (ticket C): the Folio page's big button. ⌘↵ is the page's own key (a full overlay over the editor, where
  // ⌘↵ toggles a checkbox / accepts a change), so it documents the chord on the sheet without claiming it.
  { id: 'folio.linkFiles', label: "Link this Folio's chapters to their files", keywords: ['folio', 'chapter', 'file', 'identity', 'links'], group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.open', label: 'Open Folio', keys: '⌘↵', keywords: ['folio', 'outline', 'open at', 'first part'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0, claimsChord: false },
  // ⇧⌘↵ on the Folio's page opens the Open at… menu (FolioOpenButton.tsx); the page owns the chord, so it only documents it here.
  { id: 'folio.openAt', label: 'Open Folio at another part', keys: '⇧⌘↵', keywords: ['folio', 'open at', 'part', 'menu'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'folio.previousPiece', label: 'Previous piece in Folio', group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.nextPiece', label: 'Next piece in Folio', group: 'Collections', surfaces: ['palette'] },
  // Running order from the Outline (2026-10-14): palette-only, keyless, Collections.
  { id: 'folio.movePieceUp', label: 'Move piece up in running order', group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.movePieceDown', label: 'Move piece down in running order', group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.addToRunningOrder', label: 'Add to the running order', group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.addAllToRunningOrder', label: 'Add all to the running order', group: 'Collections', surfaces: ['palette'] },
  { id: 'folio.undoLastChange', label: 'Undo last running-order or section move', group: 'Collections', surfaces: ['palette'] },
  // The Folio room's view switch (ticket 09). ⌥1 is free in the registry and the universal keymap (ADR-0011 reserves only ⌘⇧P, ⌘⇧K, ⌘K, ⌘P, ⌘F, ⌘⇧F, ⌘, and ⌘/). ⌥2 to ⌥5 are held for Outline, Map, Flags and Text when those views are built.
  // Ticket 10: Outline, Text and the Split toggle. ⌥2 and ⌥5 are the drawn placeholders, free in the registry and in ADR-0011's reserved set; ⌥3 and ⌥4 stay held for Map and Flags. Split had no key in the drawing: ⌥S is free (chords go by physical key, so it does not type ß).
  // The Folio workspace's tabs (ADR-0049, layout 1A), in tab order: ⌥1 Outline … ⌥7 Files, Outline the default. ⌥1-⌥7 were the room's
  // six view keys in another order (Cards ⌥1, Outline ⌥2, Map ⌥3, Flags ⌥4, Text ⌥5, Evidence ⌥6): the ids stay, the keys follow the tabs.
  // ADR-0011 (universal keymap) reserves only ⌘-chords, so ⌥1-⌥7 and ⌥⌘I clash with nothing in it; the one clash is Electron's own
  // View > Toggle Developer Tools (⌥⌘I), which main/menu.ts moves to ⇧⌥⌘I so the inspector key reaches the renderer.
  { id: 'folio.room.outline', label: 'Folio workspace: Outline', keys: '⌥1', keywords: ['folio', 'workspace', 'room', 'view', 'tab', 'outline', 'headings', 'table', 'rows'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.text', label: 'Folio workspace: Text', keys: '⌥2', keywords: ['folio', 'workspace', 'room', 'view', 'tab', 'text', 'part', 'editor'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.cards', label: 'Folio workspace: Cards', keys: '⌥3', keywords: ['folio', 'workspace', 'room', 'view', 'tab', 'cards', 'board', 'status'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.map', label: 'Folio workspace: Map', keys: '⌥4', keywords: ['folio', 'workspace', 'tab', 'map', 'canvas', 'path'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.flags', label: 'Folio workspace: Flags', keys: '⌥5', keywords: ['folio', 'workspace', 'tab', 'flags', 'citation', 'rewrite'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.evidence', label: 'Folio workspace: Evidence', keys: '⌥6', keywords: ['folio', 'workspace', 'tab', 'evidence', 'sources'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.files', label: 'Folio workspace: Files', keys: '⌥7', keywords: ['folio', 'workspace', 'tab', 'files', 'folder', 'collection', 'list'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.split', label: 'Folio workspace: Text beside the cards', keys: '⌥S', keywords: ['folio', 'room', 'split', 'text', 'beside', 'cards'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.inspector', label: 'Folio workspace: Show or hide the inspector', keys: '⌥⌘I', keywords: ['folio', 'workspace', 'inspector', 'sidebar', 'binder', 'details'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'folio.room.toggleHeadings', label: 'Expand or collapse a part’s headings (disclosure focused)', keys: ['↵', 'Space'], keywords: ['folio', 'outline', 'headings'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'folio.room.openHeading', label: 'Open a focused Outline heading in the Text tab', keys: '↵', keywords: ['folio', 'outline', 'heading', 'text'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'folio.room.openSelected', label: 'Open the selected part in the Text tab', keys: '⇧↵', keywords: ['folio', 'workspace', 'open', 'text', 'part'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'folio.room.laneLeft', label: 'Move the card to the lane on the left', keys: '⌥←', keywords: ['folio', 'workspace', 'board', 'lane', 'status', 'card'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'folio.room.laneRight', label: 'Move the card to the lane on the right', keys: '⌥→', keywords: ['folio', 'workspace', 'board', 'lane', 'status', 'card'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'folio.room.removeKey', label: 'Move the selected part to the Folio bin', keys: 'Delete', keywords: ['folio', 'workspace', 'delete', 'remove', 'bin', 'part'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  { id: 'plan.addPart', label: 'Add a Folio outline part', keys: 'N', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.adoptPart', label: 'Add existing part to Folio outline', keys: 'A', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.adoptAsFrontMatter', label: 'Add existing part to Folio outline as front matter', keys: 'F', keywords: ['title page', 'cover', 'front matter'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.addAllFromFolder', label: 'Add all from this folder to the Folio outline', keywords: ['chapters', 'unlisted', 'running order'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.sortByChapter', label: 'Sort the Folio outline by chapter number', keywords: ['order', 'chapters', 'numeric'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.moveUp', label: 'Move Folio outline part up', keys: '⌥↑', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.moveDown', label: 'Move Folio outline part down', keys: '⌥↓', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.materialise', label: 'Open or write Folio outline part', keys: '↵', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'plan.removePart', label: 'Remove part from Folio outline', keys: '⌘⌫', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // Role (0.26 ticket 7): R moves focus to the selected part's role menu; its own arrows and Enter then choose.
  { id: 'plan.role', label: 'Choose the role of a part', keys: 'R', keywords: ['role', 'front matter', 'summary', 'section'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // The Folio outline's Details card (0.26 ticket 4): title, standfirst and the Folio's other details, in the Index Note header.
  // The 2026-10-19 Folio page (0.26): the agent instructions pill's three writes, the front-matter slot's Choose a file, and the closable Not in the outline. Palette-only, keyless.
  { id: 'plan.writeAgentInstructions', label: 'Write the agent instructions (AGENTS.md and CLAUDE.md)', keywords: ['folio', 'agents', 'claude', 'instructions', 'write both'], group: 'Collections', surfaces: ['palette'] },
  { id: 'plan.writeAgentsFile', label: 'Write AGENTS.md only', keywords: ['folio', 'agents', 'instructions'], group: 'Collections', surfaces: ['palette'] },
  { id: 'plan.writeClaudeFile', label: 'Write CLAUDE.md only', keywords: ['folio', 'claude', 'instructions'], group: 'Collections', surfaces: ['palette'] },
  { id: 'plan.chooseFrontMatter', label: 'Choose a file as front matter', keywords: ['folio', 'front matter', 'title page', 'cover'], group: 'Collections', surfaces: ['palette'] },
  { id: 'plan.toggleNotInOutline', label: 'Show or hide the files not in the outline', keywords: ['folio', 'unlisted', 'loose files', 'not in the outline'], group: 'Collections', surfaces: ['palette'] },
  { id: 'plan.details', label: 'Go to the Details', keys: 'D', keywords: ['title', 'standfirst', 'author', 'date', 'status', 'audience', 'language', 'cover'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // Title-conflict buttons (2026-10-19, shared/title-conflict.ts): the frontmatter title and the heading
  // disagree. On the Plan they act on the selected part, elsewhere on the open document (its bar above the text).
  { id: 'title.useHeadingAsTitle', label: 'Use heading as title', keywords: ['title', 'frontmatter', 'differs', 'conflict', 'match'], keys: ['⌃⌥⌘H', 'H'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'title.useTitleAsHeading', label: 'Use title as heading', keywords: ['title', 'heading', 'differs', 'conflict', 'match'], keys: ['⌃⌥⌘T', 'T'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'title.useHeadingsAsTitlesAll', label: 'Use headings as titles for all parts', keywords: ['title', 'frontmatter', 'differs', 'conflict', 'all', 'Folio outline'], keys: ['⌃⌥⇧⌘H', '⇧H'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'title.useTitlesAsHeadingsAll', label: 'Use titles as headings for all parts', keywords: ['title', 'heading', 'differs', 'conflict', 'all', 'Folio outline'], keys: ['⌃⌥⇧⌘T', '⇧T'], group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'title.dismissConflictBar', label: 'Hide the title-differs bar for this document', keywords: ['title', 'dismiss', 'bar'], keys: '⌃⌥⌘X', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'title.undoLastChange', label: 'Undo last title change', keywords: ['title', 'heading', 'undo'], keys: '⌃⌥⌘Z', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // The Not in the outline section (0.26 ticket 7): Enter on a selected file there opens it. ↵ is the running order's own key too, so this row only documents it.
  { id: 'plan.openFile', label: 'Open the file', keys: '↵', keywords: ['not in the outline', 'unlisted', 'open'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 0, claimsChord: false },
  // The Details card and its pickers (0.26 tickets 4 and 5). Each key belongs to the card's own fields, so these rows document them.
  { id: 'plan.details.nextField', label: 'Next field', keys: '⇥', keywords: ['details', 'tab'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 1, claimsChord: false },
  { id: 'plan.details.openPicker', label: 'Open a picker', keys: ['↓', 'Space'], keywords: ['details', 'status', 'date', 'author', 'audience', 'language'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 1, claimsChord: false },
  { id: 'plan.details.choose', label: 'Choose in a picker', keys: ['↑', '↓', '↵'], keywords: ['details', 'picker'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 1, claimsChord: false },
  { id: 'plan.details.calendar', label: 'Move in the calendar', keys: ['←', '→', '⇞', '⇟'], keywords: ['details', 'date', 'calendar', 'day', 'week', 'month'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 1, claimsChord: false },
  { id: 'plan.details.today', label: 'Calendar: today', keys: 'T', keywords: ['details', 'date', 'calendar'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 1, claimsChord: false },
  { id: 'plan.details.undo', label: 'Undo the last change in the Details', keys: '⌘Z', keywords: ['details', 'undo'], group: 'Collections', surfaces: ['sheet'], sheetColumn: 1, claimsChord: false },
  // Parcel 3 (ADR-0023/0036): the Rail is summoned, never resident. The mockup's ⌥⌘R and ⌘Q
  // placeholders are occupied, so these free defaults are recorded here for the pre-release sweep.
  { id: 'collection.toggleRail', label: 'Summon Rail', keys: '⌃⌘L', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'collection.focusRail', label: 'Focus rail', group: 'Collections', surfaces: ['palette'] },
  { id: 'collection.insertAsQuery', label: 'Insert as query', keys: '⌃⌥⌘Q', group: 'Collections', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  // Palette-only by design: this rare shape correction deliberately has no default chord; the
  // pre-v1 shortcut sweep can see that decision through `keys: undefined` in the registry.
  { id: 'collection.toggleFolderPiece', label: 'Treat folder as one piece / many pieces', group: 'Collections', surfaces: ['palette'] },
  { id: 'collection.toggleCounted', label: 'Count toward diary / Stop counting toward diary', group: 'Collections', surfaces: ['palette'] },
  { id: 'statusbar.disclosure', label: 'Show status details', keys: '⌃⌘I', group: 'View', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'idea.capture', label: 'Capture an idea', keys: '⇧⌘N', group: 'Capture and ideas', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'idea.materialise', label: 'Materialise dead wikilink', keys: '⌘↵', group: 'Capture and ideas', surfaces: ['palette', 'sheet'], sheetColumn: 1, when: canMaterialiseAtCaret },
  { id: 'navigation.followWikilink', label: 'Follow wikilink', keys: '⌥↵', group: 'Capture and ideas', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  { id: 'idea.insertWikilink', label: 'Insert wikilink', keys: '[[', group: 'Capture and ideas', surfaces: ['sheet'], sheetColumn: 1 },
  { id: 'view.hideStrikes', label: 'Hide strikes', group: 'Reviewing', surfaces: ['palette'] },
  { id: 'view.hideInserts', label: 'Hide inserts', group: 'Reviewing', surfaces: ['palette'] },
  { id: 'readingRoom.toggle', label: 'Open Reading Room', keys: '⌃⌘R', group: 'Reading room', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'readingRoom.document', label: 'Reading Room: Document view', group: 'Reading room', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // ⇧⌘H was assigned in T6 for a view that did not exist yet; building it proved macOS swallows that
  // chord above the web contents (a correctly-armed probe saw NOTHING reach the renderer). Moved into the
  // Room's own ⌃⌘ family, which is demonstrably deliverable: ⌃⌘R Room, ⌃⌘S Shelf, ⌃⌘H Highlights.
  { id: 'readingRoom.highlights', label: 'Reading Room: Highlights view', keys: '⌃⌘H', group: 'Reading room', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Keyless by design: every command is palette-listed and rebindable, while the app-wide reserved
  // keymap stays untouched. App disables the run when there is no drainable work.
  { id: 'readingRoom.syncHighlights', label: 'Sync highlights to Zotero', group: 'Reading room', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // The Shelf is the Reading Room's entry state (ReadFlex ADR-0025). The locked mockup's cheat sheet
  // proposed ⌘⇧O, which Open Outline has held since 0.6 — so, by the ADR-0019 standing rule, the
  // Shelf takes a free chord in the Room's own ⌃⌘ family (⌃⌘R Room, ⌃⌘S Shelf) and carries on.
  { id: 'readingRoom.searchShelf', label: 'Search the Shelf', keys: '⌃⌘S', group: 'Reading room', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Citing an item you have no PDF of is the commonest citation case (ADR-0009), so this is reachable
  // without opening any document: the Shelf becomes a picker and the chip lands at the caret.
  { id: 'citation.insertReference', label: 'Insert reference…', group: 'Capture and ideas', surfaces: ['palette', 'sheet'], sheetColumn: 1 },
  // App-shell commands whose runs live in App (palette appRows), registered here so the chord
  // resolver and the Keycap Ledger see ONE command surface (Round A T6, ADR-0028). Their keys are
  // the existing renderer-owned chords; every key already has a cheat-sheet row.
  { id: 'view.files', label: 'Open Files', keys: '⇧⌘E', group: 'Navigation', surfaces: ['palette'] },
  { id: 'app.quickOpen', label: 'Quick Open…', keys: '⇧⌘K', group: 'Navigation', surfaces: ['palette'] },
  { id: 'app.commandPalette', label: 'Command Palette…', keys: '⇧⌘P', group: 'App', surfaces: ['palette'] },
  { id: 'view.outline', label: 'Open Outline', keywords: ['focus outline', 'outline focus', 'headings', 'sections'], keys: '⇧⌘O', group: 'Navigation', surfaces: ['palette'] },
  { id: 'app.search', label: 'Search Workspace…', keys: '⇧⌘F', group: 'Navigation', surfaces: ['palette'] },
  // Archive search dock for indexed writing and highlights.
  // ⌃⌘F sits in the ⌃⌘ structure family; the View menu's Full Screen gives the chord up (menu.ts).
  { id: 'archive.search', label: 'Search the archive…', keywords: ['scout', 'quote', 'cite', 'writing', 'tweets', 'highlights'], keys: '⌃⌘F', group: 'Navigation', surfaces: ['palette', 'sheet'], sheetColumn: 0 },
  { id: 'file.nameVersion', label: 'Save Version…', keys: '⇧⌘S', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'app.agent', label: 'Open Agent', keys: '⌘J', group: 'Agent', surfaces: ['palette'] },
  // Actions here ticket 03: quotes what is here into the composer, unsent. Keyless; App supplies the run (the app.agent pattern).
  { id: 'agent.askHere', label: 'Ask the agent about this…', keywords: ['ask', 'agent', 'question', 'quote', 'explain'], group: 'Agent', surfaces: ['palette'] },
  { id: 'agent.switchModel', label: 'Switch the model for this chat', group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'agent.setMode', label: 'Set assistant mode', keywords: ['suggest', 'work', 'read only', 'permissions'], group: 'Agent', surfaces: ['palette'] },
  { id: 'agent.setThinking', label: 'Set the reasoning level for this chat', group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Fix 04 (2026-10-06): palette-only, keyless; App supplies the run via model-refresh-command.ts.
  { id: REFRESH_MODELS_COMMAND.id, label: REFRESH_MODELS_COMMAND.label, keywords: [...REFRESH_MODELS_COMMAND.keywords], group: 'Agent', surfaces: ['palette'] },
  { id: 'app.scratchpad', label: 'Open Scratchpad', keys: '⇧⌘J', group: 'Agent', surfaces: ['palette'] },
  // Floating Scratchpad (ADR-0050): keyless palette entries; App supplies the runs. ⌘⇧X stays the editor
  // binding listed in the sheet, so Cut to Scratchpad carries no second chord here.
  { id: 'scratchpad.sendCopy', label: 'Send a copy to Scratchpad', keywords: ['scrap', 'keep', 'set aside', 'copy', 'section'], group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'scratchpad.cut', label: 'Cut to Scratchpad', keywords: ['scrap', 'cut', 'set aside', 'move'], group: 'Agent', surfaces: ['palette'] },
  { id: 'scratchpad.insertCopy', label: 'Insert a copy from the Scratchpad', keywords: ['scrap', 'reuse', 'paste', 'insert'], group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  // Ticket 04: the rest of the panel's own actions, keyless like their siblings (palette-listed and
  // rebindable; the pre-v1 sweep assigns chords). The four content verbs are also in the cheat sheet;
  // preview, mark done and search are palette-only like other keyless panel grammar (Enter opens a
  // preview, ⌫ rejects): seven more sheet rows would tower the sheet's third column past its guard.
  // Each opens the Scratchpad first and acts on its selection or ticks; a refusal is said, never silent.
  { id: 'scratchpad.putBack', label: 'Put back the selected Scratchpad item', keywords: ['scrap', 'cutting', 'return', 'move', 'insert'], group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'scratchpad.compare', label: 'Compare the ticked Scratchpad items side by side', keywords: ['compare', 'side by side', 'candidates', 'versions'], group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'scratchpad.preview', label: 'Open the big preview of the selected Scratchpad item', keywords: ['preview', 'read', 'big', 'open'], group: 'Agent', surfaces: ['palette'] },
  { id: 'scratchpad.reject', label: 'Reject the selected Scratchpad items', keywords: ['reject', 'set aside', 'remove', 'triage'], group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'scratchpad.moveBack', label: 'Move the selected Scratchpad items back to Candidates', keywords: ['move back', 'restore', 'recover', 'rejected'], group: 'Agent', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'scratchpad.markDone', label: 'Mark the selected Scratchpad item done or not done', keywords: ['done', 'mark', 'tick off'], group: 'Agent', surfaces: ['palette'] },
  { id: 'scratchpad.focusSearch', label: 'Search the Scratchpad', keywords: ['search', 'find', 'filter', 'scrap'], group: 'Agent', surfaces: ['palette'] },
  // ⇧⌘C focuses the review margin head (0.23); the Review tab is gone.
  { id: 'review.focusMargin', label: 'Focus the review margin', keys: '⇧⌘C', group: 'Reviewing', surfaces: ['palette'] },
  { id: 'review.acceptAll', label: 'Accept all shown, or the selected', keys: '⇧⌘A', group: 'Reviewing', surfaces: ['palette'], keywords: ['accept', 'all', 'selected', 'filter', 'margin'] },
  { id: 'review.declineAll', label: 'Decline all shown, or the selected', keys: '⇧⌘⌫', group: 'Reviewing', surfaces: ['palette'], keywords: ['decline', 'reject', 'discard', 'all', 'selected', 'filter', 'margin'] },
  { id: 'review.sendBack', label: 'Send the review back to the agent', keys: '⇧⌘R', group: 'Reviewing', surfaces: ['palette'], keywords: ['send', 'back', 'agent', 'notes', 'revise'] },
  { id: 'review.acceptAllFromSource', label: 'Accept all from one agent…', group: 'Reviewing', surfaces: ['palette'], keywords: ['accept', 'all', 'outside', 'agent', 'source', 'claude', 'codex', 'collection'] },
  { id: 'review.declineAllFromSource', label: 'Decline all from one agent…', group: 'Reviewing', surfaces: ['palette'], keywords: ['decline', 'reject', 'all', 'outside', 'agent', 'source', 'claude', 'codex', 'collection'] },
  { id: 'app.versions', label: 'Open Versions', keys: '⌘3', group: 'Files and versions', surfaces: ['palette'] },
  { id: 'app.settings', label: 'Open Settings…', keys: '⌘,', group: 'App', surfaces: ['palette'] },
  { id: 'app.about', label: 'About WriteFlex', group: 'App', surfaces: ['palette'] },
  // Get started (ADR-0043, ticket 10): the two buttons of Settings → Get started, as commands.
  { id: 'guide.open', label: 'Open the Guide', group: 'App', surfaces: ['palette'] },
  // Sharing (0.24 ticket 02): the set-up steps, also reached from Settings › Sharing.
  { id: 'sharing.setUp', label: 'Set up sharing', keywords: ['share', 'link', 'cloudflare', 'token'], group: 'App', surfaces: ['palette'] },
  // Sharing (0.24 ticket 03): the Sharing page of the open piece, also the title bar's Shared mark.
  { id: 'sharing.share', label: 'Share this piece…', keys: '⌥⌘S', keywords: ['share', 'link', 'publish', 'sharing', 'reader'], group: 'App', surfaces: ['palette'] },
  // Sharing (0.24 ticket 10): the collection's Shares list, also the collection row's Shares button.
  { id: 'sharing.sharesList', label: 'Shares list for this collection', keywords: ['share', 'links', 'shared', 'sharing', 'opened', 'turn off'], group: 'App', surfaces: ['palette'] },
  { id: 'example.restore', label: 'Show the example on the start screen again', group: 'App', surfaces: ['palette'] },
  { id: 'workspace.pin', label: 'Pin this workspace', group: 'App', surfaces: ['palette'] },
  { id: 'workspace.unpin', label: 'Unpin this workspace', group: 'App', surfaces: ['palette'] },
  { id: 'app.shortcuts', label: 'Keyboard Shortcuts', keys: ['?', 'Mod-/', 'Mod-Shift-/'], group: 'App', surfaces: ['palette', 'sheet'], sheetColumn: 2 },
  { id: 'view.clean', label: 'View: Clean', group: 'View', surfaces: ['palette', 'sheet'], sheetColumn: 2, run: setViewModeCommand('clean') },
  { id: 'view.markup', label: 'View: Show markup', group: 'View', surfaces: ['palette', 'sheet'], sheetColumn: 2, run: setViewModeCommand('markup') },
  { id: 'view.raw', label: 'View: Show raw', group: 'View', surfaces: ['palette', 'sheet'], sheetColumn: 2, run: setViewModeCommand('raw') },
  { id: 'block.toText', label: 'Convert to text', group: 'Writing', surfaces: ['palette', 'menu'], when: canConvertBlockToText, run: convertBlockToText },
  { id: 'block.toCode', label: 'Convert to code block', group: 'Writing', surfaces: ['palette', 'menu'], when: canConvertBlockToCode, run: convertBlockToCode },
  { id: 'block.toMermaid', label: 'Convert to flow diagram object', group: 'Writing', surfaces: ['palette', 'menu'], when: (state) => canConvertCodeToObjectKind(state, 'mermaid'), run: convertCodeToObject },
  { id: 'block.toMarkmap', label: 'Convert to mind map object', group: 'Writing', surfaces: ['palette', 'menu'], when: (state) => canConvertCodeToObjectKind(state, 'markmap'), run: convertCodeToObject },
  { id: 'block.toTable', label: 'Convert to table object', group: 'Writing', surfaces: ['palette', 'menu'], when: (state) => canConvertCodeToObjectKind(state, 'table'), run: convertCodeToObject },
  { id: 'outline.toMindMap', label: 'Convert to mind map', group: 'Writing', surfaces: ['palette', 'menu'], when: canConvertOutlineToMindMap, run: convertOutlineToMindMap },
  // The action bar's drawn verbs that had no command until ADR-0040 ticket A1b. Every one is
  // registered, palette-listed, cheat-sheet-listed and rebindable, and every one ships KEYLESS:
  // this repo assigns chords in one app-wide sweep before release, never per command.
  // The sixth, Strikethrough, is registered above, inside the cheat sheet's Editing block, beside
  // Bold and Italic — the same command, read where a reader looks for it.
  { id: 'list.bullet', label: 'Bullet list', keywords: ['list', 'bullet', 'unordered'], group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: toggleBulletList },
  // Checkboxes (docs/design/2026-09-27-checkbox-lists): ticks the box on the cursor's line, one
  // character, one undo step. ⌘↵ is a PLACEHOLDER default the locked design names, subject to the
  // app-wide keymap sweep. It is a context key like the other ⌘↵ rows (block done, accept change,
  // materialise), so it claims no chord: the command declines off a box line and the key falls
  // through to them. Rebindable in the Keycap Ledger like every palette command.
  { id: 'edit.toggleCheckbox', label: 'Toggle checkbox', keywords: ['checkbox', 'task', 'tick', 'todo', 'done'], keys: '⌘↵', group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, claimsChord: false, run: toggleCheckbox },
  { id: 'list.ordered', label: 'Numbered list', keywords: ['list', 'ordered', 'numbered'], group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: toggleOrderedList },
  // List type (docs/design/2026-09-27-checkbox-lists, frame 6): one family that changes the list the
  // cursor is in — only its markers, renumbered, every [x] kept, one undo. Keyless like the other
  // block verbs; the action bar's list menu runs the same five (components/action-bar-commands.ts).
  ...LIST_TYPE_COMMANDS.map(({ id, label, keywords, target }) => ({ id, label, keywords: ['list type', 'list', ...keywords], group: 'Writing' as const, surfaces: ['palette', 'sheet'] as CommandSurface[], sheetColumn: 1 as const, run: setListType(target) })),
  { id: 'block.quote', label: 'Blockquote', keywords: ['quote', 'blockquote'], group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: toggleBlockquote },
  { id: 'outline.makeParagraph', label: 'Make this a plain paragraph', keywords: ['paragraph', 'plain', 'clear formatting'], group: 'Writing', surfaces: ['palette', 'sheet'], sheetColumn: 1, run: makePlainParagraph },
  // Table insertion is NOT rebuilt here: this is the Insert menu's own code, registered
  // (editor/insert-block-object.ts), so the menu row and the bar button are one verb. It keeps its
  // Insert-menu surface AND takes the cheat sheet's: it is drawn on the action bar, and a writer who
  // sees a button there must be able to look it up in ⌘/ like every other verb on that bar.
  { id: 'insert.table', label: 'Table', keywords: ['table', 'insert'], group: 'Writing', surfaces: ['palette', 'menu', 'sheet'], sheetColumn: 1, run: insertTable },
  ...turnIntoCommands.map((command) => ({ ...command, group: 'Writing' as const, surfaces: ['palette'] as CommandSurface[] })),
  ...menuCommands,
]

export const commandRegistry: Command[] = commandDefinitions.map((command) => ({
  ...command,
  ...commandAnnotations[command.id],
  ...taskGroupOf(command.id),
  places: placesOf(command.sheetSource?.kind === 'command' ? command.sheetSource.commandId : command.id),
}))

/**
 * Commands the Keycap Ledger does NOT offer for rebinding (Round A T6): their chords are
 * context-scoped or typing-adjacent, where a naive rebind would fight the editor's own grammar —
 * `?`/⌘/ (typing-safe cheat-sheet keys), ⌘↵ and ⌥↵ (in-editor block/wikilink context keys), and
 * ⌘, (the macOS-sacred Settings key, which must keep raising Settings to reach the ledger at all).
 */
export const LEDGER_EXCLUDED = new Set(['app.shortcuts', 'app.settings', 'idea.materialise', 'navigation.followWikilink'])

/** Every command a chord can be assigned to: the palette surface minus the context-scoped set.
 *  Palette-surfaced is the honest boundary — every row here is actually invocable (registry `run`
 *  or an App-side runner), where sheet-only rows are documentation of structural/context keys. */
export const allBindableCommands = (): Command[] =>
  commandRegistry.filter((command) => command.surfaces.includes('palette') && !LEDGER_EXCLUDED.has(command.id))

/** Complete registry read for unit tests and registry-backed surfaces that need no filtering. */
export const allCommands = (): Command[] => commandRegistry

export const registryCommand = (id: string): Command => {
  const command = commandRegistry.find((entry) => entry.id === id)
  if (!command) throw new Error(`Missing command registry entry: ${id}`)
  return command
}

/** Group any registry-backed command list by task group, in the ten-group order. Empty groups vanish. */
export const commandsByTaskGroup = <T extends Pick<Command, 'task'>>(commands: readonly T[]): Array<{ title: TaskGroup; rows: T[] }> =>
  TASK_GROUPS
    .map((title) => ({ title, rows: commands.filter((command) => command.task === title) }))
    .filter((group) => group.rows.length > 0)

/**
 * Lay task groups into the sheet's columns: consecutive groups in the ten-group order, cut where the
 * tallest column is shortest (a group header counts as two rows). Reading down column 1, then 2,
 * then 3 is therefore always the task-group order.
 */
export const layoutSheetColumns = <T extends Pick<Command, 'task'>>(commands: readonly T[], columns = 3): Array<Array<{ title: TaskGroup; rows: T[] }>> => {
  const groups = commandsByTaskGroup(commands)
  const weight = (list: typeof groups): number => list.reduce((sum, group) => sum + group.rows.length + 2, 0)
  let best: typeof groups[] = [groups]
  let bestHeight = Infinity
  const search = (start: number, left: number, chosen: typeof groups[]): void => {
    if (left === 1) {
      const all = [...chosen, groups.slice(start)]
      const height = Math.max(...all.map(weight))
      if (height < bestHeight) { bestHeight = height; best = all }
      return
    }
    for (let cut = start; cut <= groups.length; cut += 1) search(cut, left - 1, [...chosen, groups.slice(start, cut)])
  }
  search(0, columns, [])
  return best
}

export const cheatSheetColumns = layoutSheetColumns(commandRegistry.filter((command) => command.surfaces.includes('sheet')))
