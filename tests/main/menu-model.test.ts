import { shortcutCaptureActive, subscribeShortcutCapture } from '../../src/renderer/src/commands/chords'
import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { readFileSync } from 'node:fs'
import { dispatchMenuCommand, menuChord, menuCommands, sameMenuModel } from '../../src/renderer/src/commands/menu-model'
import { commandRegistry, registryCommand } from '../../src/renderer/src/commands/registry'

test('the renderer projection keeps missing rows disabled and uses the shared effective chord resolver', () => {
  const state = EditorState.create({ doc: 'A paragraph' })
  const commands = menuCommands([{ id: 'app.quickOpen', disabled: true }, { id: 'focus.ruler', checked: true }], { 'app.quickOpen': '⌃Q', 'edit.bold': '' }, state, true)
  expect(commands.filter(c => c.enabled === false).length).toBeGreaterThan(0)
  expect(commands.find(c => c.id === 'app.quickOpen')).toMatchObject({ enabled: false, chord: '⌃Q' })
  expect(commands.find(c => c.id === 'focus.ruler')).toMatchObject({ checked: true, enabled: true })
  expect(commands.find(c => c.id === 'edit.bold')?.chord).toBeUndefined()
  expect(commands.find(c => c.id === 'collection.page.bulk-folio')?.enabled).toBe(false)
  expect(commands.find(c => c.id === 'block.toTable')?.enabled).toBe(false)
  expect(menuCommands([], {}, state, false).find(c => c.id === 'edit.bold')?.enabled).toBe(false)
  expect(commands).toHaveLength(commandRegistry.filter(c => c.surfaces.includes('palette') || c.surfaces.includes('menu')).length)
})

test('dispatch rechecks availability and when against the current editor state before running a palette row', () => {
  const state = EditorState.create({ doc: 'A paragraph' })
  const runs: string[] = []
  const row = { id: 'app.quickOpen', disabled: true }
  const runRow = (r: { id: string }) => runs.push(r.id)
  const runEditor = (c: { id: string }) => runs.push(c.id)
  dispatchMenuCommand(row.id, [row], state, true, runRow, runEditor)
  dispatchMenuCommand('block.toTable', [], state, true, runRow, runEditor)
  dispatchMenuCommand('edit.bold', [], state, false, runRow, runEditor)
  dispatchMenuCommand('unknown', [], state, true, runRow, runEditor)
  expect(runs).toEqual([])
  dispatchMenuCommand(row.id, [{ ...row, disabled: false }], state, true, runRow, runEditor)
  dispatchMenuCommand('edit.bold', [], state, true, runRow, runEditor)
  expect(runs).toEqual(['app.quickOpen', 'edit.bold'])
})

test('adding a Files row action to the palette keeps the default local and honours a user binding', () => {
  const rename = registryCommand('file.rename')
  expect(rename.keys).toBe('F2')
  expect(menuChord(rename, {})).toBeUndefined()
  expect(menuChord(rename, { 'file.rename': '⌃Q' })).toBe('⌃Q')
  expect(menuChord(registryCommand('file.openInDefaultApp'), {})).toBeUndefined()
})

test('history commands stay available for native text inputs without an open document', () => {
  const rows = [{ id: 'edit.undo' }, { id: 'edit.redo' }]
  const commands = menuCommands(rows, {}, undefined, false)
  expect(commands.find(c => c.id === 'edit.undo')?.enabled).toBe(true)
  expect(commands.find(c => c.id === 'edit.redo')?.enabled).toBe(true)
  const runs: string[] = []
  dispatchMenuCommand('edit.undo', rows, undefined, false, row => runs.push(row.id), () => { throw new Error('Expected the shared App history runner') })
  expect(runs).toEqual(['edit.undo'])
})

test('registry command accelerators stay display only during shortcut capture', () => {
  const registrations: boolean[] = []
  const off = subscribeShortcutCapture(() => registrations.push(menuCommands([{ id: 'file.new' }], {}, undefined, false).find(c => c.id === 'file.new')!.nativeAccelerator!))
  try {
    expect(menuCommands([{ id: 'file.new' }], {}, undefined, false).find(c => c.id === 'file.new')?.nativeAccelerator).toBe(false)
    shortcutCaptureActive.current = true
    shortcutCaptureActive.current = false
    expect(registrations).toEqual([false, false])
  } finally { shortcutCaptureActive.current = false; off() }
})

test('live checks and a row label parameter reach the menu model; a toggle shows its own wording', () => {
  const commands = menuCommands([{ id: 'collection.toggleFolderPiece', checked: true, labelName: 'Notes' }, { id: 'tab.pin' }], {}, undefined, false, { 'tab.pin': true })
  expect(commands.find(c => c.id === 'collection.toggleFolderPiece')?.label).toBe('Treat "Notes" as separate pieces')
  expect(commands.find(c => c.id === 'tab.pin')?.label).toBe('Unpin from strip')
})

test('the cheap model comparison notices every field a menu reads and nothing else', () => {
  const base = menuCommands([], {}, undefined, false)
  expect(sameMenuModel(base, menuCommands([], {}, undefined, false))).toBe(true)
  const changed = (patch: object) => base.map((c, i) => i === 5 ? { ...c, ...patch } : c)
  for (const patch of [{ enabled: !base[5].enabled }, { checked: true }, { label: 'other' }, { chord: '⌘9' }, { nativeAccelerator: true }, { id: 'x' }]) expect(sameMenuModel(base, changed(patch)), JSON.stringify(patch)).toBe(false)
  expect(sameMenuModel(base, base.slice(1))).toBe(false)
})

test('a menu or native-key run never touches the palette Recent list', () => {
  const source = readFileSync('src/renderer/src/app/App.tsx', 'utf8')
  const start = source.indexOf('menuDispatchRef.current = id =>')
  const block = source.slice(start, source.indexOf('useEffect(() => window.writeflex.onMenuCommand', start))
  expect(start).toBeGreaterThan(0)
  expect(block).toContain('dispatchMenuCommand(')
  expect(block).not.toContain('recordRecent')
})


test('target commands are retained disabled, then dispatch the supplied active-target runner once', () => {
  for (const id of ['file.rename', 'insert.footnote', 'block.delete', 'table.delete', 'skill.run.review', 'skills.manage', 'skills.openThread']) {
    expect(menuCommands([], {}, undefined, false).find(command => command.id === id)).toMatchObject({ enabled: false })
    const runs: string[] = []
    const row = { id, disabled: true }
    dispatchMenuCommand(id, [row], undefined, false, item => runs.push(item.id), () => {})
    expect(runs).toEqual([])
    row.disabled = false
    dispatchMenuCommand(id, [row], EditorState.create(), true, item => runs.push(item.id), () => {})
    expect(runs).toEqual([id])
  }
})
