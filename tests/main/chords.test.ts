import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildEditorChordKeymap,
  chordDisplayForLog,
  chordToCmKey,
  conflictingBindableIds,
  conflictsFor,
  defaultChords,
  effectiveChords,
  parseOverrides,
  resolveChord,
  sheetChordClaims,
  splitChord,
} from '../../src/renderer/src/commands/chords'
import { keyboardSheet } from '../../src/renderer/src/commands/keyboard-sheet'
import { TASK_GROUPS } from '../../src/renderer/src/commands/command-task-groups'
import { allBindableCommands, cheatSheetColumns, COMMAND_GROUPS, commandRegistry, LEDGER_EXCLUDED } from '../../src/renderer/src/commands/registry'
import { backspaceChord, eventToChord, type ShortcutLike } from '../../src/renderer/src/app/shortcuts'
import { CheatSheet } from '../../src/renderer/src/components/CheatSheet'

// Round A T6 (ADR-0028): the chord-resolution layer. Defaults stay registry `keys`; overrides are
// one JSON-string setting; '' = explicitly unassigned. Everything compares display chords (⌃⌥⇧⌘X).

const key = (partial: Partial<ShortcutLike>): ShortcutLike => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  key: '',
  code: '',
  ...partial,
})

const KNOWN_OS_RESERVED = new Set(['⌃⌘Q', '⌘Space', '⌃↑', '⌃↓', '⌃←', '⌃→', '⌘Tab', '⌘H', '⌘M'])

const COMMAND_BACKED_SHEET_ROWS = new Map([
  ['Pin to strip / Unpin from strip', 'tab.pin'],
  ['Quick-open file or folder', 'app.quickOpen'],
  ['Next open tab', 'navigation.nextTab'],
  ['Previous open tab', 'navigation.previousTab'],
  ['Next file in folder', 'navigation.nextFolderFile'],
  ['Previous file in folder', 'navigation.previousFolderFile'],
  ['Open Files pane', 'view.files'],
  ['Open tabs', 'view.openTabs'],
  ['Open Outline tab', 'view.outline'],
  ['Open Search tab', 'app.search'],
  ['Select all text (keep metadata)', 'edit.selectBodyExceptMetadata'],
  ['Bold', 'edit.bold'],
  ['Italic', 'edit.italic'],
  ['Link', 'edit.link'],
  ['Toggle comment', 'edit.toggleComment'],
  ['Mark ==text==', 'edit.mark'],
  ['Select next occurrence', 'edit.selectNextOccurrence'],
  ['Duplicate block', 'block.duplicate'],
  ['Join lines', 'edit.joinLines'],
  ['Distraction-free', 'view.distractionFree'],
  ['Typewriter mode', 'view.typewriter'],
  ['Focus and readability…', 'focus.open'],
  ['Fade other paragraphs', 'focus.fade'],
  ['Highlight sentence', 'focus.sentence'],
  ['Segment focus', 'focus.segment'],
  ['Sentence breakup', 'focus.breakup'],
  ['Anchored reading', 'focus.anchored'],
  ['Command palette', 'app.commandPalette'],
  ['Open Agent tab', 'app.agent'],
  ['Scratchpad', 'app.scratchpad'],
  ['Focus the review margin', 'review.focusMargin'],
  ['Accept all / selected', 'review.acceptAll'],
  ['Decline all / selected', 'review.declineAll'],
  ['Send review back', 'review.sendBack'],
  ['Open Versions tab', 'app.versions'],
  ['Hide strikes', 'view.hideStrikes'],
  ['Hide inserts', 'view.hideInserts'],
  ['Save version', 'file.nameVersion'],
  ['Settings', 'app.settings'],
] as const)

test("every command-backed cheat-sheet row displays its command's effective chord", () => {
  // The sheet lists a command once, at its own row; a `sheet.*` mirror of it is never listed beside it
  // (keyboard-sheet.ts, rule 2), so the mirror's label is read at the source command's row.
  const probeChord = '⌃⌥⇧⌘F'
  const directSheetCommands = commandRegistry.filter((entry) => entry.surfaces.includes('sheet') && !entry.id.startsWith('sheet.'))
  const overrides: Record<string, string> = Object.fromEntries([
    ...[...COMMAND_BACKED_SHEET_ROWS.values()].map((id) => [id, probeChord] as const),
    ...directSheetCommands.map((command) => [command.id, probeChord] as const),
  ])
  overrides['view.typewriter'] = '⇧⌘T'
  const listed = new Map(keyboardSheet({ place: null, state: null, overrides }).flatMap((section) => section.groups.flatMap((group) => group.rows)).map((row) => [row.id, row]))

  for (const [label, commandId] of COMMAND_BACKED_SHEET_ROWS) {
    const sheetRow = commandRegistry.find((entry) => entry.id.startsWith('sheet.') && entry.label === label)
    expect(sheetRow?.sheetSource).toEqual({ kind: 'command', commandId })
    expect(listed.has(sheetRow!.id), `${label} is listed beside its command`).toBe(false)
    const command = commandRegistry.find((entry) => entry.id === commandId)
    expect(command, `missing documented command: ${commandId}`).toBeDefined()
    const effectiveChord = overrides[commandId]!
    expect(effectiveChords(command!, overrides)).toEqual([effectiveChord])
    expect(listed.get(commandId)?.chords, `${label} disagrees with ${commandId}`).toEqual([effectiveChord])
  }

  for (const command of directSheetCommands) {
    expect(effectiveChords(command, overrides)).toEqual([probeChord])
    expect(listed.get(command.id)?.chords, `${command.label} disagrees with ${command.id}`).toEqual([probeChord])
  }

  for (const row of commandRegistry.filter((entry) => entry.id.startsWith('sheet.') && !COMMAND_BACKED_SHEET_ROWS.has(entry.label))) {
    expect(row.sheetSource, `${row.label} must be explicitly literal`).toEqual({ kind: 'literal' })
  }
})

test('the cheat sheet groups commands in the stable user-task order', () => {
  const sections = keyboardSheet({ place: null, state: null, overrides: {} })
  expect(sections.map((section) => section.id)).toEqual([...TASK_GROUPS])
  expect(sections.find((section) => section.id === 'Listen')!.groups.flatMap((group) => group.rows.map((row) => row.label))).toContain('Next sentence')
  // The rail names the ten tasks, in order, each once; the chosen section's groups are its sub-groups.
  const html = renderToStaticMarkup(createElement(CheatSheet, { overrides: {}, startOn: 'Listen', onClose: () => {} }))
  const rail = TASK_GROUPS.map((title) => html.indexOf(`<span class="grow">${title}</span>`))
  expect(rail.every((at) => at >= 0)).toBe(true)
  expect([...rail].sort((x, y) => x - y)).toEqual(rail)
  expect(html).toMatch(/<h3>[^<]+<span>\d+<\/span><\/h3>[\s\S]*?Next sentence/)
  for (const old of COMMAND_GROUPS.filter((name) => !(TASK_GROUPS as readonly string[]).includes(name))) expect(html).not.toContain(`data-section="${old}"`)

  // Reading column 1, then 2, then 3 gives the ten task groups in order, each once.
  const positions = cheatSheetColumns.flat().map((group) => TASK_GROUPS.indexOf(group.title))
  expect(positions).toEqual([...TASK_GROUPS.keys()])
})

test('resolver precedence: override beats default beats nothing; empty string unassigns', () => {
  // view.typewriter carries the ⌘T default (registry `Mod-t`).
  expect(resolveChord('view.typewriter', {})).toBe('⌘T')
  expect(resolveChord('view.typewriter', { 'view.typewriter': '⌃⌥T' })).toBe('⌃⌥T')
  expect(resolveChord('view.typewriter', { 'view.typewriter': '' })).toBeNull()
  // focus.fade ships keyless (the pre-v1 ruling): null until assigned.
  expect(resolveChord('focus.fade', {})).toBeNull()
  expect(resolveChord('focus.fade', { 'focus.fade': '⌃⌥⌘F' })).toBe('⌃⌥⌘F')
  expect(resolveChord('no.such.command', {})).toBeNull()
})

test('the Accept and next default chord reaches the app dispatcher from a real Enter key event', () => {
  const chord = eventToChord(key({ metaKey: true, altKey: true, key: 'Enter', code: 'Enter' }), 'mac')
  expect(chord).toBe('⌥⌘↵')
  expect(chord).toBe(resolveChord('review.acceptAndNext', {}))
})

test('override map round-trips through its JSON-string setting and rejects malformed input', () => {
  const overrides = { 'focus.fade': '⌃⌥⌘F', 'view.typewriter': '' }
  expect(parseOverrides(JSON.stringify(overrides))).toEqual(overrides)
  expect(parseOverrides(undefined)).toEqual({})
  expect(parseOverrides('')).toEqual({})
  expect(parseOverrides('not json')).toEqual({})
  expect(parseOverrides('[1,2]')).toEqual({})
  expect(parseOverrides(JSON.stringify({ ok: '⌘K', bad: 7 }))).toEqual({ ok: '⌘K' })
})

test('conflict detection sees dispatchable defaults and overrides but ignores documentation rows', () => {
  // The generated cheat-sheet Typewriter row documents ⌘T without claiming it.
  const taken = conflictsFor('⌘T', 'focus.fade', {})
  expect(taken).toEqual(['Toggle Typewriter Mode'])
  // An override claim conflicts too…
  expect(conflictsFor('⌃⌥⌘F', 'focus.segment', { 'focus.fade': '⌃⌥⌘F' })).toEqual(['Fade other paragraphs'])
  // …and an unassigned-by-override chord stops conflicting.
  expect(conflictsFor('⌘T', 'focus.fade', { 'view.typewriter': '' }).includes('Toggle Typewriter Mode')).toBe(false)
  // A free chord conflicts with nothing; the command's own claim is never a self-conflict.
  expect(conflictsFor('⌃⌥⌘9', 'focus.fade', {})).toEqual([])
  expect(conflictsFor('⌘T', 'view.typewriter', {})).toEqual([])
  // Move-it-here targets are the BINDABLE claimants only (sheet rows are documentation).
  expect(conflictingBindableIds('⌘T', 'focus.fade', {})).toEqual(['view.typewriter'])
})

test('Reading Room uses free registered chords', () => {
  expect(conflictsFor('⌃⌘R', 'readingRoom.toggle', {})).toEqual([])
  expect(conflictsFor('⌃⌘H', 'readingRoom.highlights', {})).toEqual([])
})

test('Rail defaults avoid the locked mockup placeholders and remain collision-free', () => {
  expect(resolveChord('collection.toggleRail', {})).toBe('⌃⌘L')
  expect(resolveChord('collection.insertAsQuery', {})).toBe('⌃⌥⌘Q')
  expect(conflictsFor('⌃⌘L', 'collection.toggleRail', {})).toEqual([])
  expect(conflictsFor('⌃⌥⌘Q', 'collection.insertAsQuery', {})).toEqual([])
  expect(resolveChord('collection.toggleRail', {})).not.toBe('⌥⌘R')
  expect(resolveChord('collection.insertAsQuery', {})).not.toBe('⌘Q')
})

test('no registry default claims a known macOS-owned chord', () => {
  for (const command of commandRegistry) {
    for (const chord of defaultChords(command)) expect(KNOWN_OS_RESERVED.has(chord), command.id).toBe(false)
  }
})

test('eventToChord normalises letters, digits, F-keys, punctuation and modifier combos', () => {
  expect(eventToChord(key({ metaKey: true, code: 'KeyT', key: 't' }), 'mac')).toBe('⌘T')
  expect(eventToChord(key({ metaKey: true, altKey: true, ctrlKey: true, shiftKey: true, code: 'KeyF', key: 'F' }), 'mac')).toBe('⌃⌥⇧⌘F')
  expect(eventToChord(key({ metaKey: true, shiftKey: true, code: 'Digit2', key: '@' }), 'mac')).toBe('⇧⌘2')
  // Option remaps the produced character; the physical code still resolves (the ⌥⌘R lesson).
  expect(eventToChord(key({ metaKey: true, altKey: true, code: 'BracketLeft', key: '„' }), 'mac')).toBe('⌥⌘[')
  expect(eventToChord(key({ metaKey: true, ctrlKey: true, code: 'Tab', key: 'Tab' }), 'mac')).toBe('⌃⌘⇥')
  expect(eventToChord(key({ metaKey: true, ctrlKey: true, shiftKey: true, code: 'Tab', key: 'Tab' }), 'mac')).toBe('⌃⇧⌘⇥')
  expect(eventToChord(key({ code: 'F2', key: 'F2' }), 'mac')).toBe('F2')
  expect(eventToChord(key({ shiftKey: true, code: 'F3', key: 'F3' }), 'mac')).toBe('⇧F3')
  // Typing is never a chord: bare or shift-only letters/digits, and pure modifier presses.
  expect(eventToChord(key({ code: 'KeyA', key: 'a' }), 'mac')).toBeNull()
  expect(eventToChord(key({ shiftKey: true, code: 'KeyA', key: 'A' }), 'mac')).toBeNull()
  expect(eventToChord(key({ metaKey: true, code: 'MetaLeft', key: 'Meta' }), 'mac')).toBeNull()
  expect(eventToChord(key({ metaKey: true, code: 'Escape', key: 'Escape' }), 'mac')).toBeNull()
  // Off macOS, Ctrl plays the command role so stored chords keep matching.
  expect(eventToChord(key({ ctrlKey: true, code: 'KeyT', key: 't' }), 'other')).toBe('⌘T')
})

test('display chords convert to CodeMirror key specs', () => {
  expect(splitChord('⌃⌥⇧⌘F')).toEqual({ mods: ['⌃', '⌥', '⇧', '⌘'], key: 'F' })
  expect(chordToCmKey('⌘T')).toBe('Mod-t')
  expect(chordToCmKey('⌃⌥⇧⌘F')).toBe('Ctrl-Alt-Shift-Mod-f')
  expect(chordToCmKey('⌃⌘]')).toBe('Ctrl-Mod-]')
  expect(chordToCmKey('⇧⌘2')).toBe('Shift-Mod-2')
  expect(chordToCmKey('F2')).toBe('F2')
})

test('listening arrow chords normalise from physical key events', () => {
  expect(eventToChord(key({ ctrlKey: true, altKey: true, code: 'ArrowLeft', key: 'ArrowLeft' }), 'mac')).toBe('⌃⌥←')
  expect(eventToChord(key({ ctrlKey: true, altKey: true, code: 'ArrowRight', key: 'ArrowRight' }), 'mac')).toBe('⌃⌥→')
  expect(eventToChord(key({ ctrlKey: true, altKey: true, code: 'ArrowUp', key: 'ArrowUp' }), 'mac')).toBe('⌃⌥↑')
  expect(eventToChord(key({ ctrlKey: true, altKey: true, code: 'ArrowDown', key: 'ArrowDown' }), 'mac')).toBe('⌃⌥↓')
})

test('every listening default is collision-free through the shared conflict detector', () => {
  const defaults = new Map([
    ['readAloud.pauseResume', '⌃⌥R'],
    ['readAloud.stop', '⌃⌥⇧R'],
    ['readAloud.nextSentence', '⌃⌥→'],
    ['readAloud.previousSentence', '⌃⌥←'],
    ['readAloud.nextParagraph', '⌃⌥↓'],
    ['readAloud.previousParagraph', '⌃⌥↑'],
    ['readAloud.faster', '⌃⌥.'],
    ['readAloud.slower', '⌃⌥,'],
    ['readAloud.returnToReading', '⌃⌥J'],
    ['readAloud.chooseVoice', '⌃⌥V'],
  ])
  for (const [id, chord] of defaults) expect(conflictsFor(chord, id, {}), `${id}: ${chord}`).toEqual([])
})

test('the editor chord keymap follows the resolver: defaults bind, overrides move, app-owned ids stay out', () => {
  const defaults = buildEditorChordKeymap({})
  const byKey = new Map(defaults.map((binding) => [binding.key, binding]))
  expect(byKey.has('Mod-b')).toBe(true) // edit.bold default
  expect(byKey.has('Ctrl-Mod-]')).toBe(true) // next-heading primary
  expect(byKey.has('Alt-Mod-ArrowUp')).toBe(true) // move-block-up primary (ticket 16: ⌥⌘↑)
  expect(byKey.has('Ctrl-Mod-ArrowUp')).toBe(false) // freed: rendered-block navigation is App-dispatched
  expect(byKey.has('Shift-Mod-ArrowLeft')).toBe(true) // standard line-boundary selection
  expect(byKey.has('Mod-t')).toBe(false) // view.typewriter is App-dispatched — exactly once rule

  const moved = buildEditorChordKeymap({ 'edit.bold': '⌃⌥⌘B' })
  const movedKeys = moved.map((binding) => binding.key)
  expect(movedKeys).toContain('Ctrl-Alt-Mod-b')
  expect(movedKeys).not.toContain('Mod-b') // the default retires WITH the override — never both

  const unassigned = buildEditorChordKeymap({ 'edit.bold': '' })
  expect(unassigned.map((binding) => binding.key)).not.toContain('Mod-b')
})

test('the final dispatchable cheat-sheet set has zero chord collisions', () => {
  for (const [chord, labels] of sheetChordClaims({})) {
    expect(labels.size, `${chord}: ${[...labels].join(', ')}`).toBe(1)
  }
})

test('every bindable command is palette-surfaced and the excluded context keys stay out of the ledger', () => {
  const bindable = allBindableCommands()
  expect(bindable.length).toBeGreaterThan(30)
  for (const command of bindable) {
    expect(command.surfaces).toContain('palette')
    expect(LEDGER_EXCLUDED.has(command.id)).toBe(false)
  }
  const ids = new Set(bindable.map((command) => command.id))
  for (const excluded of ['app.shortcuts', 'app.settings', 'idea.materialise', 'navigation.followWikilink']) {
    expect(ids.has(excluded)).toBe(false)
  }
  // The Round A commands are all assignable.
  for (const id of ['focus.open', 'focus.fade', 'focus.anchored', 'sounds.typing', 'sounds.ambient', 'goal.set']) {
    expect(ids.has(id)).toBe(true)
  }
})

test('effectiveChords + defaultChords normalise CM specs to display chords', () => {
  const typewriter = commandRegistry.find((command) => command.id === 'view.typewriter')!
  expect(defaultChords(typewriter)).toEqual(['⌘T'])
  expect(effectiveChords(typewriter, {})).toEqual(['⌘T'])
  expect(effectiveChords(typewriter, { 'view.typewriter': '⌃⌥T' })).toEqual(['⌃⌥T'])
  expect(effectiveChords(typewriter, { 'view.typewriter': '' })).toEqual([])
})

test('sheet claims move with an override (the collision seam) and log copy names the live chord', () => {
  const base = sheetChordClaims({})
  expect(base.get('⇧⌘B')).toEqual(new Set(['Open Board']))
  const moved = sheetChordClaims({ 'collection.openBoard': '⌃⌥⌘B' })
  expect(moved.get('⇧⌘B')).toBeUndefined()
  expect(moved.get('⌃⌥⌘B')).toEqual(new Set(['Open Board']))

  expect(chordDisplayForLog(JSON.stringify({ 'focus.fade': '⌃⌥⌘F' }), 'Shortcut: Fade other paragraphs')).toBe('⌃⌥⌘F')
  expect(chordDisplayForLog(null, 'Shortcut: Fade other paragraphs')).toBe('Not assigned')
  expect(chordDisplayForLog(null, 'Shortcut: Toggle Typewriter Mode')).toBe('⌘T')
  expect(chordDisplayForLog(JSON.stringify({ 'view.typewriter': '' }), 'Shortcut: Toggle Typewriter Mode')).toBe('Not assigned')
})

// Review margin ticket 04: ⇧⌘⌫ (Decline all) reaches the app table through backspaceChord; eventToChord still gives no ⌫ chord.
test('a modified Backspace is a chord only through backspaceChord', () => {
  const key = (over: Record<string, boolean>) => ({ key: 'Backspace', code: 'Backspace', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...over })
  expect(eventToChord(key({ metaKey: true, shiftKey: true }) as never, 'mac')).toBeNull()
  expect(backspaceChord(key({ metaKey: true, shiftKey: true }) as never, 'mac')).toBe('⇧⌘⌫')
  expect(backspaceChord(key({ metaKey: true }) as never, 'mac')).toBe('⌘⌫')
  expect(backspaceChord(key({ shiftKey: true }) as never, 'mac')).toBeNull()
  expect(backspaceChord({ ...key({ metaKey: true }), code: 'KeyA', key: 'a' } as never, 'mac')).toBeNull()
  expect(backspaceChord(key({ ctrlKey: true, shiftKey: true }) as never, 'other')).toBe('⇧⌘⌫')
})
