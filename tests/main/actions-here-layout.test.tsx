import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { livePreview } from '../../src/renderer/src/editor/live-preview'
import { PLACES } from '../../src/renderer/src/commands/command-places'
import { actionLayoutAt, filterActionGroups, hereCount, insertObjectRows, rowCount, type ActionRow } from '../../src/renderer/src/commands/actions-here'
import { COMPOSED_PREFIX, LAYOUTS } from '../../src/renderer/src/commands/actions-layout'
import { placeAt, actionsAt, type Place } from '../../src/renderer/src/commands/place'
import { registryCommand } from '../../src/renderer/src/commands/registry'

// Actions here tickets 01 and 02: the per-place row list equals the final spec with Ask the agent (ticket 03).
const DOC = `---
title: The long way
---

# The long way

## The wall builders

Every wall up here was built by hand, with [[Dry stone]] beside it.

![The ridge](ridge.png)

- first item
- [ ] buy string

> A quoted line.

| Stone | Count |
|-------|-------|
| cope  | 12    |

\`\`\`js
const stones = 12
\`\`\`
`

const stateAt = (needle: string, offset = 1, to?: number): EditorState => {
  const anchor = DOC.indexOf(needle) + offset
  const state = EditorState.create({ doc: DOC, selection: to === undefined ? { anchor } : { anchor, head: anchor + to }, extensions: [markdown({ extensions: markdownDialect() }), livePreview({ assetBaseUrl: () => '' })] })
  ensureSyntaxTree(state, DOC.length, 5_000)
  const parsed = state.update({}).state
  if (syntaxTree(parsed).length < DOC.length) throw new Error('fixture not fully parsed')
  return parsed
}

const INSERT = 'sheet.Editing.12'
const PROSE_ROWS = [INSERT, 'format.menu', 'turn.into', 'move.block', 'block.duplicate', 'block.delete', 'edit.toggleComment', 'agent.askHere', 'readAloud.start']
const LIST_ROWS = [INSERT, 'format.menu', 'turn.into', 'indent.item', 'move.block', 'block.duplicate', 'block.delete', 'edit.toggleComment', 'agent.askHere', 'readAloud.start']
const HEADING_ROWS = [INSERT, 'turn.into', 'move.section', 'fold.current', 'outline.newHeadingBefore', 'outline.newSubheading', 'outline.deleteCurrentSection', 'edit.toggleComment', 'agent.askHere', 'readAloud.start']
const PARAGRAPH_TARGETS = ['outline.makeHeadingAtSurroundingLevel', 'outline.makeHeadingOneLevelDeeper', 'list.bullet', 'list.ordered', 'turn.taskList', 'block.quote', 'turn.codeBlock']
const FOLDER_ROWS = ['folder.newFile', 'folder.newFolder', 'folder.rename', 'folder.reveal', 'folder.helpWithReport', 'folder.trash']

/** [place, state, the offered ids in order, the strip's ids]. */
const CASES: Array<[Place, EditorState | null, string[], string[]]> = [
  ['paragraph', stateAt('Every wall', 3), PROSE_ROWS, []],
  ['selection', stateAt('Every wall', 3, 8), [INSERT, 'edit.toggleComment', 'agent.askHere', 'readAloud.start', 'turn.into', 'text.changeCase', 'edit.selectNextOccurrence'], ['edit.bold', 'edit.italic', 'edit.strikethrough', 'edit.mark', 'edit.inlineCode', 'edit.link', 'edit.clearFormatting']],
  ['heading', stateAt('The wall builders', 3), HEADING_ROWS, []],
  ['heading-top', stateAt('The long way', 3, 0).update({ selection: { anchor: DOC.indexOf('# The long way') + 4 } }).state, HEADING_ROWS, []],
  ['list-item', stateAt('first item', 3), LIST_ROWS, []],
  ['task-item', stateAt('buy string', 3), ['edit.toggleCheckbox', ...LIST_ROWS], []],
  ['quotation', stateAt('A quoted line', 3), PROSE_ROWS, []],
  ['table', stateAt('cope', 2), ['block.edit', INSERT, 'table.column', 'turn.into', 'move.block', 'block.copy', 'block.delete', 'agent.askHere'], []],
  ['code-block', stateAt('const stones', 3), ['block.edit', INSERT, 'turn.into', 'move.block', 'block.copy', 'block.delete', 'agent.askHere'], []],
  ['link', stateAt('Dry stone', 3), ['navigation.followWikilink', 'edit.link', INSERT, 'agent.askHere', 'readAloud.start'], []],
  ['image', stateAt('The ridge', 3), ['block.edit', INSERT, 'turn.into', 'move.block', 'block.copy', 'block.delete', 'agent.askHere'], []],
  ['metadata', stateAt('title: The long way', 3), ['metadata.edit', INSERT, 'block.copy', 'block.delete'], []],
  ['empty-document', EditorState.create({ doc: '' }), [INSERT, 'turn.startWith', 'agent.askHere'], []],
  ['file', null, ['file.open', 'file.rename', 'file.move', 'file.duplicate', 'file.pin', 'file.export', 'file.reveal', 'file.copyPath', 'file.trash'], []],
  ['folder', null, ['folder.newFile', 'folder.newFolder', 'folder.rename', 'folder.reveal', 'folder.focus', 'folder.helpWithReport', 'folder.trash'], []],
  ['focused-folder', null, ['folder.newFile', 'folder.newFolder', 'folder.rename', 'folder.reveal', 'folder.clearFocus', 'folder.helpWithReport', 'folder.trash'], []],
  ['outline-row', stateAt('The wall builders', 3), ['outline.selectCurrentSection', 'outline.newHeadingBefore', 'outline.newSubheading', 'level.row', 'move.block', 'outline.collapseAll', 'outline.expandAll', 'outline.showLevels', 'outline.toggleWordCounts', 'outline.deleteCurrentSection'], []],
]

const idsOf = (place: Place, state: EditorState | null): string[] => actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows.map((row) => row.id))

describe('the per-place row list is the drawn list, minus the rows whose command is new', () => {
  test('the cases cover all 17 places and the fixture lands on the place it names', () => {
    expect(CASES.map(([place]) => place).sort()).toEqual([...PLACES].sort())
    for (const [place, state] of CASES) if (state && !['file', 'folder', 'focused-folder', 'outline-row'].includes(place)) expect(placeAt(state), place).toBe(place)
  })

  for (const [place, state, ids, strip] of CASES) {
    test(`${place}: the rows in the drawn order, and the chip counts them (strip cells included)`, () => {
      expect(idsOf(place, state)).toEqual(ids)
      const layout = actionLayoutAt(place, state, {})
      expect(layout.strip.map((cell) => cell.id)).toEqual(strip)
      expect(hereCount(place, state)).toBe(ids.length + strip.length)
      expect(rowCount(layout.groups) + layout.strip.length).toBe(hereCount(place, state))
      // Every row wears an icon (the folder's Help row wears the agent's instead).
      for (const row of [...layout.groups.flatMap((group) => group.rows), ...layout.strip]) expect(row.icon !== undefined || row.agent === true, `${place}: ${row.id}`).toBe(true)
    })
  }

  test('a row never stands for a command the place does not offer: the layout needs actionsAt to offer every id it lists', () => {
    for (const [place, state] of CASES) {
      const offered = new Set(actionsAt(place, state).map((command) => command.id))
      const layout = actionLayoutAt(place, state, {})
      const shown = [...layout.groups.flatMap((group) => group.rows), ...layout.strip]
      const commands = (row: ActionRow): string[] => row.id.startsWith(COMPOSED_PREFIX) ? ['outline.makeParagraph'] : // a quotation's composed target runs makeParagraph first; the paragraph target is declared at paragraph
       row.split ? [row.split.first.id, row.split.second.id] : row.children ? row.children.flatMap((group) => group.rows.filter((kid) => !kid.inert).flatMap(commands)) : row.id === INSERT ? [] : [row.id]
      for (const row of shown) for (const id of commands(row)) expect(offered.has(id), `${place}: ${id}`).toBe(true)
    }
  })

  test('every command a layout row names exists in the registry', () => {
    for (const place of PLACES) {
      for (const item of LAYOUTS[place]) {
        const ids = item.kind === 'row' ? [item.id] : item.kind === 'split' ? [item.first, item.second] : item.kind === 'strip' ? item.cells.map((cell) => cell.id) : item.kind === 'opener' ? item.children.flatMap((kid) => kid.kind === 'row' || kid.kind === 'composed' ? [kid.id] : []) : []
        for (const id of ids) expect(() => registryCommand(id), id).not.toThrow()
      }
    }
  })
})

describe('the label map', () => {
  const labels = (place: Place, state: EditorState | null): Record<string, string> => Object.fromEntries(actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows).map((row) => [row.id, row.label]))

  test('shortened labels replace the registry’s, per place', () => {
    expect(labels('paragraph', stateAt('Every wall', 3))).toMatchObject({ 'edit.toggleComment': 'Comment', 'readAloud.start': 'Read aloud from here', 'move.block': 'Move block' })
    expect(labels('selection', stateAt('Every wall', 3, 8))).toMatchObject({ 'readAloud.start': 'Read aloud' })
    expect(labels('table', stateAt('cope', 2))).toMatchObject({ 'block.edit': 'Edit table', 'block.delete': 'Delete table' })
    expect(labels('image', stateAt('The ridge', 3))).toMatchObject({ 'block.edit': 'Edit image' })
    expect(labels('code-block', stateAt('const stones', 3))).toMatchObject({ 'block.edit': 'Edit', 'block.delete': 'Delete block' })
    expect(labels('metadata', stateAt('title: The long way', 3))).toMatchObject({ 'metadata.edit': 'Edit metadata', 'block.delete': 'Delete metadata' })
    expect(labels('heading', stateAt('The wall builders', 3))).toMatchObject({ 'fold.current': 'Fold section', 'outline.newHeadingBefore': 'New heading before this', 'outline.deleteCurrentSection': 'Delete section', 'move.section': 'Move section' })
    expect(labels('focused-folder', null)).toMatchObject({ 'folder.clearFocus': 'Clear focus' })
  })

  test('the registry label stays searchable although the row shows the short one', () => {
    const rows = filterActionGroups(actionLayoutAt('heading', stateAt('The wall builders', 3), {}).groups, 'toggle comment', []).flatMap((group) => group.rows)
    expect(rows.map((row) => row.id)).toEqual(['edit.toggleComment'])
    expect(rows[0]!.label).toBe('Comment')
  })
})

describe('split rows', () => {
  const move = (): ActionRow => actionLayoutAt('paragraph', stateAt('Every wall', 3), {}).groups.flatMap((group) => group.rows).find((row) => row.id === 'move.block')!

  test('one row, two commands, each with its own key cap', () => {
    expect(move().split).toEqual({ first: { id: 'outline.moveBlockUp', label: 'Move this block up', chords: ['⌥⌘↑'] }, second: { id: 'outline.moveBlockDown', label: 'Move this block down', chords: ['⌥⌘↓'] } })
  })

  test('a rebinding shows on the cap', () => {
    const row = actionLayoutAt('paragraph', stateAt('Every wall', 3), { 'outline.moveBlockDown': '⌃⌘J' }).groups.flatMap((group) => group.rows).find((item) => item.id === 'move.block')!
    expect(row.split!.second.chords).toEqual(['⌃⌘J'])
  })

  test('the four patterns exist: Move block, Move section, Indent / outdent, Raise / lower', () => {
    const all = new Set(CASES.flatMap(([place, state]) => actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows).filter((row) => row.split).map((row) => row.id)))
    expect([...all].sort()).toEqual(['indent.item', 'level.row', 'move.block', 'move.section'])
  })
})

describe('submenus', () => {
  const opener = (place: Place, state: EditorState | null, id: string): ActionRow => actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows).find((row) => row.id === id)!
  const kids = (row: ActionRow): string[] => (row.children ?? []).flatMap((group) => group.rows.filter((kid) => !kid.inert).map((kid) => kid.id))

  test('Format has the seven commands; Turn into differs by place', () => {
    expect(kids(opener('paragraph', stateAt('Every wall', 3), 'format.menu'))).toEqual(['edit.bold', 'edit.italic', 'edit.strikethrough', 'edit.mark', 'edit.inlineCode', 'edit.link', 'edit.clearFormatting'])
    expect(kids(opener('selection', stateAt('Every wall', 3, 8), 'turn.into'))).toEqual(PARAGRAPH_TARGETS) // Mind map joins only while the selection is an outline (its `when`)
    expect(kids(opener('paragraph', stateAt('Every wall', 3), 'turn.into'))).toEqual(PARAGRAPH_TARGETS)
    expect(kids(opener('heading', stateAt('The wall builders', 3), 'turn.into'))).toEqual(['outline.makeParagraph', 'heading.decrease', 'heading.increase'])
    expect(kids(opener('heading-top', CASES.find(([place]) => place === 'heading-top')![1], 'turn.into'))).toEqual(['outline.makeParagraph', 'heading.increase'])
    expect(kids(opener('list-item', stateAt('first item', 3), 'turn.into'))).toEqual(['outline.makeParagraph', 'list.type.bullet', 'list.type.numbered', 'list.type.checkboxes', 'list.type.lettered', 'list.type.roman', 'outline.toMindMap'])
    expect(kids(opener('table', stateAt('cope', 2), 'table.column'))).toEqual(['table.insertLeft', 'table.insertRight', 'table.delete', 'table.alignLeft', 'table.alignCentre', 'table.alignRight'])
    expect(kids(opener('outline-row', stateAt('The wall builders', 3), 'outline.showLevels'))).toEqual(['outline.showLevel1', 'outline.showLevel2', 'outline.showLevel3', 'outline.showLevel4', 'outline.showLevel5', 'outline.showLevel6', 'outline.showAllLevels'])
    expect(kids(opener('empty-document', EditorState.create({ doc: '' }), 'turn.startWith'))).toEqual(['outline.makeHeadingLevel1', 'outline.makeHeadingLevel2', 'outline.makeHeadingLevel3', 'outline.makeHeadingLevel4', 'outline.makeHeadingLevel5', 'outline.makeHeadingLevel6', 'list.bullet', 'list.ordered'])
  })

  test('the block’s own type is drawn as a tagged marker, never a row and never counted', () => {
    const turn = opener('paragraph', stateAt('Every wall', 3), 'turn.into')
    const now = turn.children!.flatMap((group) => group.rows).find((kid) => kid.inert)!
    expect(now).toMatchObject({ label: 'Paragraph', tag: 'now' })
    expect(rowCount(turn.children!)).toBe(7)
  })

  test('a filter term finds a command inside a submenu, as a row of its own', () => {
    const groups = actionLayoutAt('paragraph', stateAt('Every wall', 3), {}).groups
    expect(filterActionGroups(groups, 'strike', []).flatMap((group) => group.rows.map((row) => row.id))).toEqual(['edit.strikethrough'])
    expect(filterActionGroups(groups, 'numbered', []).flatMap((group) => group.rows.map((row) => row.id))).toEqual(['list.ordered'])
    const selection = actionLayoutAt('selection', stateAt('Every wall', 3, 8), {})
    expect(filterActionGroups(selection.groups, 'upper', []).flatMap((group) => group.rows.map((row) => row.id))).toEqual(['text.upperCase'])
    const outline = actionLayoutAt('outline-row', stateAt('The wall builders', 3), {})
    expect(filterActionGroups(outline.groups, 'level 3', []).flatMap((group) => group.rows.map((row) => row.id))).toContain('outline.showLevel3')
    expect(filterActionGroups(actionLayoutAt('table', stateAt('cope', 2), {}).groups, 'align right', []).flatMap((group) => group.rows.map((row) => row.id))).toEqual(['table.alignRight'])
  })

  test('the strip’s cells are found by filter as rows, and Insert object is followed by the objects that match', () => {
    const selection = actionLayoutAt('selection', stateAt('Every wall', 3, 8), {})
    const withStrip = [...selection.groups, { name: '', rows: selection.strip }]
    expect(filterActionGroups(withStrip, 'bold', []).flatMap((group) => group.rows.map((row) => row.id))).toEqual(['edit.bold'])
    const hits = filterActionGroups(selection.groups, 'table', insertObjectRows({})).flatMap((group) => group.rows.map((row) => row.id))
    expect(hits).toContain('insert.table')
  })

  test('openers are not rows of the place and have no command of their own', () => {
    for (const [place, state] of CASES) {
      const rows = actionLayoutAt(place, state, {}).groups.flatMap((group) => group.rows)
      for (const row of rows.filter((item) => item.opens === 'menu')) expect(row.children!.length).toBeGreaterThan(0)
    }
    expect(hereCount('paragraph', stateAt('Every wall', 3))).toBe(9)
  })
})
