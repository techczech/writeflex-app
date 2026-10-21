import { expect, test } from 'bun:test'
import { cheatSheetColumns, commandRegistry, registryCommand } from '../../src/renderer/src/commands/registry'
import { conflictsFor, defaultChords } from '../../src/renderer/src/commands/chords'
import { buildCommandPaletteSections } from '../../src/renderer/src/components/CommandPalette'

// Ticket 09: every chord of the README key table is a registered command with a palette entry and a place on the
// keyboard sheet, and none collides with another command.
const CHORDS: Record<string, string> = {
  'review.nextChange': '⌥⌘G',
  'review.previousChange': '⇧⌥⌘G',
  'review.switchMarginView': '⇧⌥⌘V',
  'review.nextPieceWaiting': '⌃⌥⌘G',
  'review.toggleMargin': '⇧⌥⌘M',
  'review.focusMargin': '⇧⌘C',
  'review.showAll': '⌃⌥⌘1',
  'review.showComments': '⌃⌥⌘2',
  'review.showEdits': '⌃⌥⌘3',
  'review.acceptAll': '⇧⌘A',
  'review.declineAll': '⇧⌘⌫',
  'review.sendBack': '⇧⌘R',
  'review.acceptAndNext': '⌥⌘↵',
}

test('each key-table chord is the default of its command, which is in the palette and on the sheet', () => {
  const sheetIds = new Set(cheatSheetColumns.flat().flatMap((group) => group.rows.map((row) => row.id)))
  for (const [id, chord] of Object.entries(CHORDS)) {
    const command = registryCommand(id)
    expect(defaultChords(command), id).toEqual([chord])
    expect(command.surfaces, id).toContain('palette')
    expect(sheetIds.has(id) || cheatSheetColumns.flat().some((g) => g.rows.some((r) => r.sheetSource?.kind === 'command' && r.sheetSource.commandId === id)), id).toBe(true)
  }
})

test('no key-table chord is claimed by any other command', () => {
  for (const [id, chord] of Object.entries(CHORDS)) expect(conflictsFor(chord, id, {}), `${id} ${chord}`).toEqual([])
  const claimed = commandRegistry.filter((c) => c.claimsChord !== false).flatMap((c) => defaultChords(c))
  for (const chord of Object.values(CHORDS)) expect(claimed.filter((c) => c === chord), chord).toHaveLength(1)
})

test('the Reviewing group of the sheet lists the card letters, Show in text, Space and the Esc order', () => {
  const rows = cheatSheetColumns.flat().find((group) => group.title === 'Review and versions')!.rows
  const labels = rows.map((row) => row.label).join('\n')
  for (const part of ['Accept · Decline · Reply', 'Hold both', 'Copy wording', 'Reopen', 'Show in text', 'Pick a card', 'Close popover, composer, card']) expect(labels, part).toContain(part)
})

test('typing "review" in the palette lists Settled today, My edits and Show quiet fixes first, each with its hint', () => {
  const rows = ['review.settledToday', 'review.myEdits', 'review.showQuietFixes'].map((id) => registryCommand(id))
  for (const row of rows) { expect(row.hint, row.id).toBeTruthy(); expect(row.leadsFor, row.id).toContain('review') }
  expect(registryCommand('review.settledToday').hint).toBe('Reopen anything settled today')
  const commands = [...commandRegistry.filter((c) => c.surfaces.includes('palette')).map((c) => ({ id: c.id, label: c.label, group: c.task, subgroup: c.subgroup, keywords: c.keywords, hint: c.hint, leadsFor: c.leadsFor, icon: (() => null) as never, run: () => {} }))]
  const sections = buildCommandPaletteSections({ mode: 'commands', query: 'review', files: [], folders: [], commands, skills: [], activeFile: null, recentIds: [], checklistProgress: undefined } as never)
  const ids = sections[0].items.slice(0, 3).map((item) => (item.kind === 'command' ? item.command.id : item.kind))
  expect(ids).toEqual(['review.settledToday', 'review.myEdits', 'review.showQuietFixes'])
})
