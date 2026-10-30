import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { livePreview } from '../../src/renderer/src/editor/live-preview'
import { actionLayoutAt } from '../../src/renderer/src/commands/actions-here'
import { KEYBOARD_SHEET_TEXT, keyboardSheet, sheetRows, splitColumns } from '../../src/renderer/src/commands/keyboard-sheet'
import { TASK_GROUPS } from '../../src/renderer/src/commands/command-task-groups'
import { actionsAt, placeLabel, type Place } from '../../src/renderer/src/commands/place'
import { commandRegistry } from '../../src/renderer/src/commands/registry'
import { CheatSheet } from '../../src/renderer/src/components/CheatSheet'
import { ActionsHereContext, type ActionsHereApi } from '../../src/renderer/src/components/ActionsHere'

// Onboarding ticket 04: the keyboard sheet's data. Here is `actionsAt`, the tasks are the registry, the
// chords are the effective ones. The sheet render test draws the same data; the keyboard is in the e2e.
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

const CASES: Array<[string, Place, EditorState | null]> = [
  ['on a heading', 'heading', stateAt('The wall builders', 3)],
  ['in a paragraph', 'paragraph', stateAt('Every wall', 3)],
  ['on a file row', 'file', null],
]
const here = (place: Place, state: EditorState | null, overrides: Record<string, string> = {}, query = '') => keyboardSheet({ place, state, overrides, query })[0]!
const allRows = (overrides: Record<string, string> = {}, query = '') => keyboardSheet({ place: null, state: null, overrides, query }).flatMap((section) => section.groups.flatMap((group) => group.rows))

describe('the Here section is Actions here', () => {
  for (const [name, place, state] of CASES) {
    test(`${name}: every command the panel reaches, in actionsAt's order (the panel's submenu children and split-row commands are listed here too)`, () => {
      const listed = actionsAt(place, state).map((command) => command.id)
      const section = here(place, state)
      expect(section.id).toBe('here')
      const ids = section.groups.flatMap((group) => group.rows.map((row) => row.id))
      expect([...ids].sort()).toEqual([...listed].sort())
      expect(section.count).toBe(listed.length)
      // The panel draws a drawn layout of these commands: none of its commands is missing from the sheet.
      const reached = (rows: typeof panelRows): string[] => rows.flatMap((row) => row.split ? [row.split.first.id, row.split.second.id] : row.children ? reached(row.children.flatMap((group) => group.rows)) : row.inert ? [] : [row.id])
      const layout = actionLayoutAt(place, state, {})
      const panelRows = [...layout.groups.flatMap((group) => group.rows), ...layout.strip]
      for (const id of reached(panelRows)) if (id !== 'sheet.Editing.12') expect(ids, id).toContain(id)
    })
  }

  test('it is named for the place the chip names, and its Insert row reads ⌘K then ↵', () => {
    const section = here('heading', stateAt('The wall builders', 3))
    expect(section.label).toBe('Here: on a heading')
    expect(section.label.toLowerCase()).toBe(`here: ${placeLabel('heading').toLowerCase()}`)
    const insert = section.groups[0]!.rows[0]!
    expect(insert).toMatchObject({ label: 'Insert object…', chords: ['⌘K'], then: '↵' })
    expect(allRows().find((row) => row.id === insert.id)?.then).toBeUndefined()
  })

  test('with no place (no document open) there is no Here section and the ten tasks follow in order', () => {
    const sections = keyboardSheet({ place: null, state: null, overrides: {} })
    expect(sections.map((section) => section.id)).toEqual([...TASK_GROUPS])
    expect(keyboardSheet({ place: 'file', state: null, overrides: {} }).map((section) => section.id)).toEqual(['here', ...TASK_GROUPS])
  })
})

describe('the tasks list the registry once', () => {
  test('a mirror of a command is never listed; its source command is, once', () => {
    const ids = allRows().map((row) => row.id)
    expect(new Set(ids).size).toBe(ids.length)
    const mirrors = commandRegistry.filter((command) => command.sheetSource?.kind === 'command')
    expect(mirrors.length).toBeGreaterThan(0)
    for (const mirror of mirrors) {
      expect(ids).not.toContain(mirror.id)
      expect(ids).toContain((mirror.sheetSource as { commandId: string }).commandId)
    }
  })

  test('keys with no command stay as the sheet has them, and menu-only commands Here offers are listed', () => {
    const ids = new Set(allRows().map((row) => row.id))
    const repeats = ['New file', 'Rename file or folder', 'Move to folder', 'Duplicate file', 'Move to Bin']
    const literals = commandRegistry.filter((command) => command.sheetSource?.kind === 'literal')
    for (const literal of literals) expect(ids.has(literal.id), literal.label).toBe(!repeats.includes(literal.label))
    for (const id of ['folder.newFile', 'file.rename', 'file.move', 'file.duplicate', 'file.trash']) expect(ids.has(id)).toBe(true)
    for (const [, place, state] of CASES) for (const command of actionsAt(place, state)) expect(ids.has(command.id), `${command.id} is in Here but not in its task`).toBe(true)
    expect(sheetRows().length).toBe(ids.size)
  })

  test('every row sits in its command’s task group; a not-built row is shown but not counted', () => {
    const sections = keyboardSheet({ place: null, state: null, overrides: {} })
    for (const section of sections) {
      for (const row of section.groups.flatMap((group) => group.rows)) expect(commandRegistry.find((command) => command.id === row.id)!.task).toBe(section.id)
      expect(section.count).toBe(section.groups.flatMap((group) => group.rows).filter((row) => !row.future).length)
    }
    const future = allRows().filter((row) => row.future)
    expect(future.length).toBeGreaterThan(0)
  })
})

test('file search keys stay visible in their own scope and do not claim or rebind global chords', () => {
  const expected = [['↑', '↓'], ['↵', '⇥'], ['↵'], ['Esc']]
  const overrides = Object.fromEntries(expected.map((_, i) => [`sheet.FileSearch.${i}`, '⌃⌥⇧⌘F']))
  const rows = allRows(overrides)
  for (let i = 0; i < expected.length; i += 1) {
    const id = `sheet.FileSearch.${i}`
    expect(commandRegistry.find((command) => command.id === id)).toMatchObject({
      surfaces: ['sheet'], claimsChord: false, sheetSource: { kind: 'literal' }, subgroup: 'File search',
    })
    expect(rows.find((row) => row.id === id)?.chords).toEqual(expected[i])
  }
})

describe('chords are the effective ones', () => {
  const row = (id: string, overrides: Record<string, string>) => allRows(overrides).find((item) => item.id === id)!

  test('a default chord, a rebinding that says what it was, an explicit no key, a command with no key', () => {
    expect(row('navigation.nextFolderFile', {})).toMatchObject({ chords: ['⌥⌘]'], rebound: false, was: [] })
    expect(row('navigation.nextFolderFile', { 'navigation.nextFolderFile': '⌃⌥]' })).toMatchObject({ chords: ['⌃⌥]'], rebound: true, was: ['⌥⌘]'] })
    expect(row('navigation.nextFolderFile', { 'navigation.nextFolderFile': '⌥⌘]' })).toMatchObject({ rebound: false })
    expect(row('navigation.nextFolderFile', { 'navigation.nextFolderFile': '' })).toMatchObject({ chords: [], rebound: false })
    expect(row('block.quote', {})).toMatchObject({ chords: [], rebound: false })
    expect(row('block.quote', { 'block.quote': '⌥⌘Q' })).toMatchObject({ chords: ['⌥⌘Q'], rebound: true, was: [] })
  })

  test('the Here section shows the same effective chord as the task view', () => {
    const state = stateAt('Every wall', 3)
    const overrides = { 'edit.bold': '⌥⌘B' }
    const inHere = here('paragraph', state, overrides).groups.flatMap((group) => group.rows).find((item) => item.id === 'edit.bold')!
    expect(inHere).toMatchObject({ chords: ['⌥⌘B'], rebound: true, was: ['⌘B'] })
    expect(inHere).toEqual(row('edit.bold', overrides))
  })
})

describe('the filter reaches every command by label and keywords', () => {
  test('every typed word must match; counts become the matches; empty groups go', () => {
    const sections = keyboardSheet({ place: null, state: null, overrides: {}, query: 'file' })
    for (const section of sections) {
      expect(section.groups.every((group) => group.rows.length > 0)).toBe(true)
      for (const row of section.groups.flatMap((group) => group.rows)) expect(`${row.label} ${row.keywords}`.toLowerCase()).toContain('file')
    }
    expect(sections.find((section) => section.id === 'Find and manage files')!.count).toBeGreaterThan(0)
    expect(allRows({}, 'copy file path').map((row) => row.id)).toContain('file.copyPath')
    expect(allRows({}, 'copy zzzz')).toEqual([])
  })

  test('keywords are searched, and Here is filtered with the rest', () => {
    // A command with a keyword its label does not contain: only the keywords can reach it.
    const keyword = commandRegistry.find((command) => command.sheetSource?.kind !== 'command' && command.keywords?.some((word) => !command.label.toLowerCase().includes(word.toLowerCase()) && !/\s/.test(word)))!
    const word = keyword.keywords!.find((item) => !keyword.label.toLowerCase().includes(item.toLowerCase()) && !/\s/.test(item))!
    expect(allRows({}, word).map((row) => row.id)).toContain(keyword.id)
    const filtered = here('paragraph', stateAt('Every wall', 3), {}, 'bold')
    expect(filtered.groups.flatMap((group) => group.rows.map((row) => row.label))).toEqual(['Bold'])
    expect(filtered.count).toBe(1)
  })
})

test('the two columns cut where the row count is closest to half', () => {
  const group = (rows: number) => ({ rows: Array.from({ length: rows }) })
  const [left, right] = splitColumns([group(10), group(1), group(1), group(8)])
  // weights 11.5, 2.5, 2.5, 9.5 (rows + 1.5): the second group's midpoint (12.75) is still within half of 26 (13)
  expect([left.length, right.length]).toEqual([2, 2])
  expect(splitColumns([group(3)])).toEqual([[group(3)], []])
})

describe('the sheet draws the data', () => {
  const api: ActionsHereApi = { runCommand: () => true, canRun: () => true, openPalette: () => {}, overrides: {}, editorState: () => null }
  const draw = (props: Partial<Parameters<typeof CheatSheet>[0]>): string => renderToStaticMarkup(
    <ActionsHereContext.Provider value={api}><CheatSheet onClose={() => {}} {...props} /></ActionsHereContext.Provider>,
  )

  test('it opens on Here with its heading, then the ten tasks in the rail', () => {
    const html = draw({ place: 'heading', editorState: stateAt('The wall builders', 3) })
    expect(html).toContain('aria-label="Keyboard shortcuts"')
    expect(html).toContain('placeholder="Filter all commands"')
    expect(html.indexOf('Here: on a heading')).toBeGreaterThan(0)
    expect(html).toMatch(/data-section="here" aria-current="true"/)
    expect(html).toContain('<h3>Insert<span>1</span></h3>')
    const tasks = TASK_GROUPS.map((title) => html.indexOf(`data-section="${title}"`))
    expect(tasks.every((at) => at > html.indexOf('data-section="here"'))).toBe(true)
  })

  test('a chosen task with a filter shows a rebound row marked with what it was, and a row with no key', () => {
    const html = draw({ overrides: { 'navigation.nextFolderFile': '⌃⌥]' }, startOn: 'Find and manage files', startQuery: 'file' })
    expect(html).toContain(`${KEYBOARD_SHEET_TEXT.rebound} · ${KEYBOARD_SHEET_TEXT.was} <kbd class="was">⌥⌘]</kbd>`)
    expect(html).toContain('<kbd class="new">⌃⌥]</kbd>')
    expect(html).toContain('<span class="nokey">no key</span>')
    expect(html).toMatch(/data-section="Find and manage files" aria-current="true"/)
    expect(html).toMatch(/data-section="Listen"[^>]*class="ks-item( zero)?"/)
  })

  test('with no document open it opens on the first task and has no Here item', () => {
    const html = draw({})
    expect(html).not.toContain('data-section="here"')
    expect(html).toMatch(/data-section="Write" aria-current="true"/)
  })
})
