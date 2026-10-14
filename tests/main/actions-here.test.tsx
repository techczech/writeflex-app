import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { livePreview } from '../../src/renderer/src/editor/live-preview'
import { ACTIONS_HERE_TEXT, DIAGRAM_ROWS, INSERT_OBJECT_IDS, actionGroupsAt, actionLayoutAt, filterActionGroups, hereCount, insertObjectRows, rowCount } from '../../src/renderer/src/commands/actions-here'
import { actionsAt, placeAt, type Place } from '../../src/renderer/src/commands/place'
import { ActionsHere, ActionsHereContext, panelRowCount, type ActionsHereApi } from '../../src/renderer/src/components/ActionsHere'
import { renderedRows } from '../helpers/actions-here-render'

const DOC = `# The long way

## The wall builders

Every wall up here was built by hand, stone by stone, without mortar.

- first item
`

const stateAt = (needle: string, offset = 1): EditorState => {
  const state = EditorState.create({ doc: DOC, selection: { anchor: DOC.indexOf(needle) + offset }, extensions: [markdown({ extensions: markdownDialect() }), livePreview({ assetBaseUrl: () => '' })] })
  ensureSyntaxTree(state, DOC.length, 5_000)
  const parsed = state.update({}).state
  if (syntaxTree(parsed).length < DOC.length) throw new Error('fixture not fully parsed')
  return parsed
}

const api = (state: EditorState | null, overrides: Record<string, string> = {}): ActionsHereApi => ({ runCommand: () => true, openPalette: () => {}, overrides, editorState: () => state })
const renderPanel = (place: Place, state: EditorState | null, overrides: Record<string, string> = {}): string => renderToStaticMarkup(
  <ActionsHereContext.Provider value={api(state, overrides)}>
    <ActionsHere x={0} y={0} place={place} onClose={() => {}} />
  </ActionsHereContext.Provider>,
)

const CASES: Array<[string, Place, EditorState | null]> = [
  ['on a heading', 'heading', stateAt('The wall builders', 3)],
  ['in a paragraph', 'paragraph', stateAt('Every wall', 3)],
  ['on a file row', 'file', null],
  ['on a folder row', 'folder', null],
  ['on an outline row', 'outline-row', stateAt('The wall builders', 3)],
]

describe('the panel draws the layout, and the chip counts its rows', () => {
  for (const [name, place, state] of CASES) {
    test(`${name}: the rendered rows are the layout's rows, and the chip's number is theirs`, () => {
      const layout = actionLayoutAt(place, state, {})
      const listed = layout.groups.flatMap((group) => group.rows.filter((row) => !row.inert).map((row) => row.id))
      expect(renderedRows(renderPanel(place, state)).map((row) => row.id)).toEqual(listed)
      expect(panelRowCount(place, state, {})).toBe(listed.length + layout.strip.length)
      expect(hereCount(place, state)).toBe(panelRowCount(place, state, {}))
      // Everything on show is something actionsAt offers here (the panel adds no command of its own).
      const offered = new Set(actionsAt(place, state).map((command) => command.id))
      for (const row of layout.groups.flatMap((group) => group.rows)) if (!row.split && !row.children) expect(offered.has(row.id), row.id).toBe(true)
    })
  }

  test('Insert object is the first row on a text place and opens the object list; a file has none', () => {
    const groups = actionGroupsAt('paragraph', stateAt('Every wall', 3), {})
    expect(groups[0].rows[0]).toMatchObject({ label: 'Insert object…', opens: 'insert', chords: [] })
    expect(actionGroupsAt('file', null, {}).some((group) => group.rows.some((row) => row.id === 'sheet.Editing.12'))).toBe(false)
  })

  test('groups are separated by a thin rule, not headed: a heading has three, a file four', () => {
    expect(actionGroupsAt('heading', stateAt('The wall builders', 3), {}).map((group) => group.rows.length)).toEqual([2, 5, 3])
    expect(actionGroupsAt('file', null, {}).map((group) => group.rows.length)).toEqual([1, 3, 4, 1])
    const html = renderPanel('file', null)
    expect(html).not.toContain('class="ak-g"')
    expect(html.match(/class="ak-sep"/g)).toHaveLength(3)
  })
})

describe('chords are the effective ones', () => {
  const chordsOf = (id: string, overrides: Record<string, string>): string[] => actionGroupsAt('paragraph', stateAt('Every wall', 3), overrides).flatMap((group) => group.rows).find((row) => row.id === id)!.chords

  test('a default chord, a rebinding, an explicit no key', () => {
    expect(chordsOf('edit.toggleComment', {})).toEqual(['⌥⌘/'])
    expect(chordsOf('edit.toggleComment', { 'edit.toggleComment': '⌥⌘B' })).toEqual(['⌥⌘B'])
    expect(chordsOf('edit.toggleComment', { 'edit.toggleComment': '' })).toEqual([])
  })

  test('a command with no default chord shows none, and a rebound one shows its new chord', () => {
    expect(chordsOf('readAloud.start', {})).toEqual([])
    expect(chordsOf('readAloud.start', { 'readAloud.start': '⌃⌘Q' })).toEqual(['⌃⌘Q'])
  })

  test('the rendered panel shows the rebound chord and not the default', () => {
    const html = renderPanel('paragraph', stateAt('Every wall', 3), { 'edit.toggleComment': '⌥⌘B' })
    const bold = renderedRows(html).find((row) => row.id === 'edit.toggleComment')!
    expect(bold.chords).toEqual(['⌥⌘B'])
    const hidden = renderedRows(renderPanel('paragraph', stateAt('Every wall', 3), { 'edit.toggleComment': '' })).find((row) => row.id === 'edit.toggleComment')!
    expect(hidden.chords).toEqual([])
  })

  test('the All commands row shows the palette chord, and its rebinding', () => {
    expect(renderPanel('file', null)).toContain('<kbd>⇧⌘P</kbd>')
    expect(renderPanel('file', null, { 'app.commandPalette': '⌥⌘P' })).toContain('<kbd>⌥⌘P</kbd>')
  })
})

describe('filtering', () => {
  const heading = actionGroupsAt('heading', stateAt('The wall builders', 3), {})
  const objects = insertObjectRows({})

  test('nothing typed keeps every group', () => {
    expect(rowCount(filterActionGroups(heading, '', objects))).toBe(rowCount(heading))
    expect(rowCount(filterActionGroups(heading, '   ', objects))).toBe(rowCount(heading))
  })

  test('a typed word reaches a row by its label', () => {
    const rows = filterActionGroups(heading, 'fold', objects).flatMap((group) => group.rows)
    expect(rows.map((row) => row.id)).toEqual(['fold.current'])
  })

  test('and by its keywords, which are not drawn', () => {
    // "Make this a plain paragraph" is also found as "clear formatting".
    const rows = filterActionGroups(heading, 'clear formatting', objects).flatMap((group) => group.rows)
    expect(rows.map((row) => row.id)).toEqual(['outline.makeParagraph'])
    expect(rows[0].label).not.toMatch(/clear/i)
    expect(rows[0].label).toBe('Paragraph')
  })

  test('every typed word has to match', () => {
    expect(filterActionGroups(heading, 'move block', objects).flatMap((group) => group.rows).every((row) => /move/i.test(row.label) && /block/i.test(row.label))).toBe(true)
    expect(filterActionGroups(heading, 'fold zebra', objects)).toEqual([])
  })

  test('a filter that matches nothing here leaves no group, and the line says so', () => {
    expect(filterActionGroups(heading, 'export', objects)).toEqual([])
    expect(ACTIONS_HERE_TEXT.none('export')).toBe('No “export” action here')
  })

  test('while a filter is typed the Insert row is followed by the objects that match; on a file nothing reaches them', () => {
    const table = filterActionGroups(heading, 'table', objects)
    expect(table[0].rows.map((row) => row.id)).toContain('insert.table')
    expect(filterActionGroups(actionGroupsAt('file', null, {}), 'table', objects)).toEqual([])
  })

  test('the object list is the drawn ten plus Widget… after Image…, in order, each with its icon, and Flow diagram opens the five diagrams', () => {
    expect(objects.map((row) => row.label)).toEqual(['Table', 'Image…', 'Widget…', 'Code block', 'Flow diagram', 'Mind map', 'SVG', 'Divider', 'Footnote', 'Metadata', 'Reference…'])
    expect(objects.map((row) => row.id)).toEqual([...INSERT_OBJECT_IDS])
    expect(objects.every((row) => row.icon !== undefined)).toBe(true)
    expect(new Set(objects.map((row) => row.icon)).size).toBe(objects.length)
    expect(objects.find((row) => row.id === 'insert.mermaid')?.opens).toBe('diagram')
    expect(DIAGRAM_ROWS.map((row) => row.label)).toEqual(['Flowchart →', 'Flowchart ↓', 'Sequence', 'State', 'Pie'])
  })
})

describe('the place decides', () => {
  test('the same document gives different panels at a heading and in a paragraph', () => {
    const heading = actionGroupsAt(placeAt(stateAt('The wall builders', 3)), stateAt('The wall builders', 3), {}).flatMap((group) => group.rows.map((row) => row.id))
    const paragraph = actionGroupsAt(placeAt(stateAt('Every wall', 3)), stateAt('Every wall', 3), {}).flatMap((group) => group.rows.map((row) => row.id))
    expect(heading).toContain('fold.current')
    expect(paragraph).not.toContain('fold.current')
  })
})
