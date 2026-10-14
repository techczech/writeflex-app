import { expect, test } from 'bun:test'
import { allBindableCommands, allCommands, cheatSheetColumns } from '../../src/renderer/src/commands/registry'

const LISTENING_DEFAULTS = new Map([
  ['readAloud.start', undefined],
  ['readAloud.pauseResume', '⌃⌥R'],
  ['readAloud.stop', '⌃⌥⇧R'],
  ['readAloud.faster', '⌃⌥.'],
  ['readAloud.slower', '⌃⌥,'],
  ['readAloud.nextSentence', '⌃⌥→'],
  ['readAloud.previousSentence', '⌃⌥←'],
  ['readAloud.nextParagraph', '⌃⌥↓'],
  ['readAloud.previousParagraph', '⌃⌥↑'],
  ['readAloud.returnToReading', '⌃⌥J'],
  ['readAloud.chooseVoice', '⌃⌥V'],
])

test('listening commands use the resolved default family while explicit Read aloud stays keyless', () => {
  for (const [id, keys] of LISTENING_DEFAULTS) {
    const command = allCommands().find((entry) => entry.id === id)
    expect(command, `missing command: ${id}`).toBeDefined()
    expect(command!.keys).toBe(keys)
  }
})

test('every listening command is bindable and generated into the cheat sheet from its registry row', () => {
  const commands = allCommands().filter((command) => command.id.startsWith('readAloud.'))
  expect(commands.map((command) => command.label)).toEqual([
    'Read aloud',
    'Read aloud — start, pause, or carry on',
    'Stop reading',
    'Read faster',
    'Read slower',
    'Next sentence',
    'Previous sentence',
    'Next paragraph',
    'Previous paragraph',
    'Return to the reading',
    'Read aloud settings…',
  ])
  for (const command of commands) {
    expect(command.task).toBe('Listen')
    expect(command.surfaces).toContain('palette')
    expect(command.surfaces).toContain('sheet')
  }

  const bindableIds = new Set(allBindableCommands().map((command) => command.id))
  expect([...LISTENING_DEFAULTS.keys()].every((id) => bindableIds.has(id))).toBe(true)

  const sheetIds = cheatSheetColumns.flatMap((column) => column.flatMap((group) => group.rows.map((row) => row.id)))
  for (const id of LISTENING_DEFAULTS.keys()) {
    expect(sheetIds.filter((sheetId) => sheetId === id), `${id} must be generated exactly once`).toEqual([id])
  }
})

test('Folder Piece shape can be flipped from the command palette', () => {
  const command = allCommands().find((entry) => entry.id === 'collection.toggleFolderPiece')
  expect(command).toMatchObject({
    label: 'Treat folder as one piece / many pieces',
    group: 'Collections',
  })
  expect(command?.surfaces).toContain('palette')
  expect(command?.keys).toBeUndefined()
})

test('Files filtering is palette-listed, rebindable, keyless, and has a declared contextual sheet row', () => {
  const command = allCommands().find((entry) => entry.id === 'files.filter')
  expect(command).toMatchObject({ label: 'Filter files…', surfaces: ['palette'] })
  expect(command?.keys).toBeUndefined()
  expect(allBindableCommands().some((entry) => entry.id === 'files.filter')).toBe(true)

  const contextRows = cheatSheetColumns.flatMap((column) => column.flatMap((group) => group.rows))
    .filter((row) => row.label === 'Filter the Files pane')
  expect(contextRows).toHaveLength(1)
  expect(contextRows[0].keys).toBe('⌘F')
  expect(contextRows[0].sheetSource).toEqual({ kind: 'literal' })
  expect(contextRows[0].claimsChord).toBe(false)
})
