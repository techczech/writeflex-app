import { sheetRows } from '../../src/renderer/src/commands/keyboard-sheet'
import { canonicalChord } from '../../src/renderer/src/app/shortcuts'
import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { allBindableCommands, commandLabel, commandRegistry } from '../../src/renderer/src/commands/registry'
import { THEME_COMMANDS } from '../../src/renderer/src/commands/theme-commands'
import { menuCommands } from '../../src/renderer/src/commands/menu-model'
import { conflictingBindableIds, conflictsFor, defaultChords, effectiveChords } from '../../src/renderer/src/commands/chords'
import { buildCommandMenu, MENU_BAR_LABELS, toAccelerator, type CommandMenuItem } from '../../src/shared/command-menu'
import { NATIVE_MENU_COMMANDS, SEED_MENU_COMMANDS } from '../../src/shared/native-menu-commands'
import { buildMenuTemplate } from '../../src/main/menu-template'

const rows = commandRegistry.filter(c => c.surfaces.includes('palette') || c.surfaces.includes('menu'))
const overrides = { 'app.quickOpen': '⌃⌥Q', 'app.search': '' }
// The model is the REAL renderer projection (menuCommands), fed the live state a window would have.
const editorState = EditorState.create({ doc: 'A paragraph' })
const liveRows = (checks: Record<string, boolean> = {}) => rows.map(c => ({ id: c.id, disabled: c.id === 'app.quickOpen' ? true : undefined, checked: checks[c.id] }))
const model = (checks: Record<string, boolean> = { 'view.typewriter': true }) => buildCommandMenu(menuCommands(liveRows(), overrides, editorState, true, checks))
const flatten = (items: CommandMenuItem[]): CommandMenuItem[] => items.flatMap(i => [i, ...flatten(i.submenu ?? [])])

test('every registry command appears once or declares a nonempty noMenu reason', () => {
  const all = flatten(model())
  for (const row of commandRegistry) {
    if (row.noMenu !== undefined) {
      expect(row.noMenu.trim().length).toBeGreaterThan(0)
      expect(row.noMenu, row.id).toMatch(/^(Cheat-sheet mirror of .+; the source command owns the menu item\.|Cheat-sheet documentation of a contextual gesture; no standalone command runner\.|Contextual keyboard action owned by this surface; no standalone app command runner\.|Same action as [\w.-]+ in .+)$/)
      if (row.noMenu.startsWith('Same action as ')) {
        const [, source, location] = row.noMenu.match(/^Same action as (\S+) in (.+)$/)!
        const pathTo = (items: CommandMenuItem[], parents: string[] = []): string | undefined => {
          for (const item of items) {
            if (item.id === source) return parents.join(' > ')
            const found = item.submenu && pathTo(item.submenu, [...parents, item.label!])
            if (found !== undefined) return found
          }
        }
        expect(pathTo(model()), source).toBe(location)
      }
    }
    else expect(all.filter(i => i.id === row.id), row.id).toHaveLength(1)
  }
})
test('command items retain registry labels and effective chords, availability and toggle state', () => {
  const items = flatten(model()).filter(i => i.id)
  expect(items.length).toBeGreaterThan(300)
  for (const item of items) {
    const command = rows.find(c => c.id === item.id)
    expect(command, item.id).toBeDefined()
    // Every item carries the registry entry's own label (a family's short label is a tail of it); toggles
    // not switched on keep the neutral registry name.
    expect(item.sourceLabel, item.id).toBe(command!.label)
    if (!command!.id.startsWith('exportPresets.') && !MENU_BAR_LABELS[item.id!]) expect(command!.label.endsWith(item.label!), item.id).toBe(true)
    // The accelerator is the registry's effective chord (user override applied), including contextual keys.
    const chord = command!.keysPlaceBound || command!.claimsChord === false || command!.id === 'skills.openThread' ? undefined : effectiveChords(command!, overrides).find(k => toAccelerator(k) !== undefined)
    expect(item.accelerator, item.id).toBe(toAccelerator(chord))
  }
  const by = (id: string) => flatten(model()).find(i => i.id === id)
  expect(by('app.quickOpen')?.accelerator).toBe('Ctrl+Alt+Q')
  expect(by('app.search')?.accelerator).toBeUndefined()
  expect(by('readAloud.nextSentence')?.accelerator).toBe('Ctrl+Alt+Right')
  expect(by('app.quickOpen')?.enabled).toBe(false)
  expect(by('view.typewriter')?.checked).toBe(true)
})
test('a toggle names what running it will do, from one registry resolver shared with the palette', () => {
  const label = (id: string, checked: boolean, name?: string) => commandLabel(commandRegistry.find(c => c.id === id)!, { checked, name })
  expect([label('readingRoom.toggle', false), label('readingRoom.toggle', true)]).toEqual(['Open Reading Room', 'Close Reading Room'])
  expect([label('review.showQuietFixes', false), label('review.showQuietFixes', true)]).toEqual(['Show quiet fixes', 'Hide quiet fixes'])
  expect([label('tab.pin', false), label('tab.pin', true)]).toEqual(['Pin to strip', 'Unpin from strip'])
  expect([label('collection.toggleCounted', false), label('collection.toggleCounted', true)]).toEqual(['Count toward diary', 'Stop counting toward diary'])
  expect([label('collection.toggleFolderPiece', false, 'Notes'), label('collection.toggleFolderPiece', true, 'Notes')]).toEqual(['Treat "Notes" as one piece', 'Treat "Notes" as separate pieces'])
  // The menu uses the same words, and the tick stands down where the name already says it.
  const menu = flatten(buildCommandMenu(menuCommands(liveRows(), {}, editorState, true, { 'readingRoom.toggle': true, 'tab.pin': false })))
  expect(menu.find(i => i.id === 'readingRoom.toggle')).toMatchObject({ label: 'Close Reading Room', checked: undefined })
  expect(menu.find(i => i.id === 'tab.pin')?.label).toBe('Pin to strip')
  // Unknown state keeps the neutral registry name.
  expect(menu.find(i => i.id === 'review.showQuietFixes')?.label).toBe('Show quiet fixes')
})
test('Edit holds only history and the native text roles; no sub-group is split across two menus', () => {
  const tree = model()
  const edit = tree.find(i => i.menu === 'edit')!
  expect(flatten(edit.submenu!).map(i => i.id).filter(Boolean)).toEqual(['edit.undo', 'edit.redo'])
  expect(flatten(tree.find(i => i.menu === 'write')!.submenu!).map(i => i.id)).toEqual(expect.arrayContaining(['edit.bold', 'edit.italic', 'edit.toggleComment']))
  const seen = new Map<string, string>()
  for (const menu of tree) {
    for (const group of (menu.submenu ?? []).filter(i => i.submenu)) {
      const earlier = seen.get(group.label!)
      expect(earlier === undefined || earlier === menu.label, `${group.label} appears under ${earlier} and ${menu.label}`).toBe(true)
      seen.set(group.label!, menu.label!)
    }
  }
  // And by registry sub-group, outside Collect (which regroups on purpose).
  const menuOf = new Map<string, string>()
  for (const menu of tree) for (const item of flatten(menu.submenu ?? [])) if (item.id) menuOf.set(item.id, menu.label!)
  const homes = new Map<string, Set<string>>()
  for (const c of rows) {
    const home = menuOf.get(c.id)
    if (!home || home === 'Collect' || home === 'File' || home === 'WriteFlex' || home === 'Help' || home === 'Edit') continue
    homes.set(c.subgroup, (homes.get(c.subgroup) ?? new Set()).add(home))
  }
  for (const [group, menus] of homes) expect([...menus], group).toHaveLength(1)
})
test('fixed frame places settings and help commands and keeps native edit roles', () => {
  const tree = model()
  expect(tree.map(i => i.label)).toEqual(['WriteFlex', 'File', 'Edit', 'Write', 'Structure', 'Review', 'Collect', 'Agent', 'Share', 'View', 'Window', 'Help'])
  expect(flatten(tree[0].submenu!).find(i => i.id === 'app.settings')?.accelerator).toBe('CmdOrCtrl+,')
  expect(flatten(tree.at(-1)!.submenu!).map(i => i.id)).toEqual(expect.arrayContaining(['guide.open', 'app.shortcuts', 'app.commandPalette', 'app.actionsHere']))
  const template = buildMenuTemplate(tree, () => {}, [], 'plain-text-field')
  expect(template.find(i => i.label === 'Window')?.role).toBe('windowMenu')
  const edit = template[2].submenu as import('electron').MenuItemConstructorOptions[]
  expect(edit.slice(0, 2).map(i => i.id)).toEqual(['edit.undo', 'edit.redo'])
  expect(edit.slice(2).map(i => i.role).filter(Boolean)).toEqual(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
  // About keeps Electron's own About panel: a role, and no click that would open Settings instead.
  const about = (template[0].submenu as import('electron').MenuItemConstructorOptions[]).find(i => i.id === 'app.about')!
  expect(about.role).toBe('about')
  expect(about.click).toBeUndefined()
  expect(about.label).toBe(commandRegistry.find(c => c.id === 'app.about')!.label)
  expect(edit.map(i => i.role)).toEqual(expect.arrayContaining(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']))
})
test('menu adapter has no handwritten command labels or chords', () => {
  for (const path of ['src/main/menu.ts', 'src/main/menu-template.ts']) {
    const source = readFileSync(path, 'utf8')
    expect(source).not.toMatch(/label:\s*['"`]/)
    expect(source).not.toMatch(/accelerator:\s*['"`]/)
  }
})
test('appRows supplies behaviour only and every literal id resolves', () => {
  const source = readFileSync('src/renderer/src/app/App.tsx', 'utf8')
  const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const constants = new Map([...source.matchAll(/const (\w+_COMMAND) = registryCommand\('([^']+)'\)/g)].map(match => [match[1], match[2]]))
  let found = false
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'appRows') {
      found = true
      const check = (n: ts.Node): void => {
        if (ts.isObjectLiteralExpression(n) && n.properties.some(p => p.name?.getText(ast) === 'id')) {
          for (const p of n.properties) expect(['id', 'run', 'disabled', 'disabledReason', 'checked', 'labelName']).toContain(p.name?.getText(ast))
          const id = n.properties.find(p => p.name?.getText(ast) === 'id')!
          if (ts.isShorthandPropertyAssignment(id)) {
            // The theme rows take their id from the declared theme command family.
            const mapper = n.parent.parent
            expect(ts.isArrowFunction(mapper) && ts.isCallExpression(mapper.parent) && mapper.parent.expression.getText(ast)).toBe('THEME_COMMANDS.map')
            for (const theme of THEME_COMMANDS) expect(commandRegistry.some(c => c.id === theme.id), theme.id).toBe(true)
            return
          }
          if (!ts.isPropertyAssignment(id)) throw new Error(`Unresolved palette row id: ${id.getText(ast)}`)
          const identity = id.initializer
          if (ts.isStringLiteral(identity)) expect(commandRegistry.some(c => c.id === identity.text), identity.text).toBe(true)
          else if (ts.isPropertyAccessExpression(identity)) {
            const owner = identity.expression.getText(ast)
            if (owner === 'command') {
              for (const command of NATIVE_MENU_COMMANDS) expect(commandRegistry.some(c => c.id === command.id)).toBe(true)
            } else {
              const resolved = constants.get(owner)
              expect(resolved, `${owner} comes from registryCommand`).toBeDefined()
              expect(commandRegistry.some(c => c.id === resolved)).toBe(true)
            }
          } else if (ts.isTemplateExpression(identity)) {
            const prefix = identity.head.text
            expect(commandRegistry.some(c => c.id.startsWith(prefix)), prefix).toBe(true)
          } else throw new Error(`Unresolved palette row id: ${identity.getText(ast)}`)
        }
        ts.forEachChild(n, check)
      }
      check(node.initializer!)
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  expect(found).toBe(true)
})

test('family items use short labels and Collect has the four required submenus', () => {
  const tree = model()
  expect(tree.find(i => i.label === 'Collect')!.submenu!.map(i => i.label)).toEqual(expect.arrayContaining(['Collections', 'Folio', 'Sources and Reading Room', 'Ideas']))
  const all = flatten(tree)
  for (const [id, label] of [['outline.showLevel3', '1 to 3'], ['list.type.bullet', 'bullet'], ['lineFocus.size3', '3 lines'], ['folio.room.cards', 'Cards'], ['exportPresets.apply', 'Apply'], ['exportPresets.saveAs', 'Save as…']]) {
    expect(all.find(i => i.id === id)?.label).toBe(label)
  }
  for (const item of all.filter(i => i.id && !i.id.startsWith('exportPresets.'))) expect((MENU_BAR_LABELS[item.id!] ?? item.sourceLabel!).endsWith(item.label!)).toBe(true)
  expect(() => buildCommandMenu([{ id: 'bad', label: 'bad', task: 'Write', subgroup: 'Edit', enabled: true, noMenu: ' ' }])).toThrow('Empty noMenu reason')
})

test('the adapter dispatches ids once, respects key ownership, and keeps recent roots dynamic', () => {
  const run: string[] = []
  const command: CommandMenuItem = { id: 'app.quickOpen', label: 'from registry', accelerator: 'Ctrl+Q', enabled: false }
  const native: CommandMenuItem = { ...command, id: 'file.new', nativeAccelerator: true }
  const template = buildMenuTemplate([{ label: 'File', submenu: [command, native, { ...command, id: 'app.openRecent' }] }], id => run.push(id), [{ label: '/chosen/root' }])
  const items = template[0].submenu as import('electron').MenuItemConstructorOptions[]
  expect(items[0].registerAccelerator).toBe(false)
  expect(items[0].enabled).toBe(false)
  expect(items[1].registerAccelerator).toBe(true)
  items[1].click!({} as never, null as never, {} as never)
  expect(run).toEqual(['file.new'])
  expect(items[2].submenu).toEqual([{ label: '/chosen/root' }])
})

test('newly registered menu commands keep their exact shipped keys and are bindable', () => {
  const shipped: Record<string, string | undefined> = {
    'file.new': '⌘N', 'folder.new': '⌃⌘N', 'window.new': '⌥⌘N', 'app.open': '⌘O',
    'app.openRecent': undefined, 'file.checkpoint': '⌘S', 'tab.close': '⌘W',
    'view.proseIncrease': '⌘+', 'view.proseDecrease': '⌘-', 'view.proseReset': '⌥⌘0',
    'view.columnIncrease': '⌥⌘+', 'view.columnDecrease': '⌥⌘-',
    'view.developerTools': '⇧⌥⌘I', 'view.fullScreen': undefined,
  }
  const bindable = new Set(allBindableCommands().map(c => c.id))
  const listedInSheet = new Set(sheetRows().map(c => c.id))
  for (const [id, chord] of Object.entries(shipped)) {
    const command = commandRegistry.find(c => c.id === id)!
    expect(command.surfaces).toContain('palette')
    expect(listedInSheet.has(id), `${id} is in the actual shortcut sheet`).toBe(true)
    expect(bindable.has(id), id).toBe(true)
    expect(defaultChords(command).map(canonicalChord), id).toEqual(chord ? [canonicalChord(chord)] : [])
  }
  for (const [id, chord] of [['view.proseIncrease', '⌘='], ['view.proseIncrease', '⇧⌘='], ['view.columnIncrease', '⌥⇧⌘='], ['view.proseDecrease', '⇧⌘-'], ['view.columnDecrease', '⌥⇧⌘-']]) {
    expect(conflictingBindableIds(chord, 'app.openRecent', {}), chord).toContain(id)
    expect(conflictingBindableIds(chord, 'app.openRecent', { [id]: '' }), chord).not.toContain(id)
  }
  expect(conflictsFor('⌥⇧⌘I', 'app.openRecent', {})).toContain('Toggle Developer Tools')
  expect(flatten(model()).find(c => c.id === 'view.proseDecrease')?.accelerator).toBe('CmdOrCtrl+-')
  expect(flatten(model()).find(c => c.id === 'view.columnDecrease')?.accelerator).toBe('Alt+CmdOrCtrl+-')
})

test('the pre-model seed menu agrees with the registry on id, label, task and sub-group', () => {
  for (const seed of SEED_MENU_COMMANDS) {
    const command = commandRegistry.find(c => c.id === seed.id)
    expect(command).toBeDefined()
    expect(seed.label).toBe(commandLabel(command!))
    expect(seed.task).toBe(command!.task)
    expect(seed.subgroup).toBe(command!.subgroup)
  }
})

test('all displayed chords follow effective bindings before and after rebinding', () => {
  for (const overrides of [{}, { 'app.quickOpen': '⌃⌥Q', 'folio.room.cards': '⌃⌥C', 'plan.adoptPart': '⌃⌥A' }, { 'app.quickOpen': '' }]) {
    const items = flatten(buildCommandMenu(menuCommands(liveRows(), overrides, editorState, true)))
    for (const command of rows) {
      if (command.noMenu !== undefined) continue
      expect(items.find(i => i.id === command.id)?.accelerator, command.id).toBe(toAccelerator(command.keysPlaceBound || command.claimsChord === false || command.id === 'skills.openThread' ? undefined : effectiveChords(command, overrides).find(k => toAccelerator(k) !== undefined)))
    }
  }
})
test('no command id appears twice anywhere in the menu bar', () => {
  const ids = flatten(model()).flatMap(item => item.id ? [item.id] : [])
  expect(new Set(ids).size).toBe(ids.length)
})

test('registry command accelerators are display only', () => {
  const template = buildMenuTemplate(model(), () => {}, [])
  const walk = (items: import('electron').MenuItemConstructorOptions[]): void => {
    for (const item of items) {
      if (item.id && item.accelerator) expect(item.registerAccelerator, item.id).toBe(false)
      if (Array.isArray(item.submenu)) walk(item.submenu)
    }
  }
  walk(template)
})


test('no chord appears on two menu items and no plain or place-bound key is an accelerator', () => {
  const items = flatten(buildCommandMenu(menuCommands(liveRows(), {}, editorState, true)))
  const seen = new Map<string, string>()
  for (const item of items) {
    if (!item.accelerator) continue
    const identity = item.accelerator.split('+').sort().join('+')
    expect(seen.get(identity), `${item.id} duplicates ${seen.get(item.accelerator)}`).toBeUndefined()
    seen.set(identity, item.id!)
    const command = commandRegistry.find(c => c.id === item.id)!
    expect(command.keysPlaceBound, item.id).not.toBe(true)
    expect(item.accelerator, item.id).toMatch(/(?:CmdOrCtrl|Ctrl|Alt)\+/)
  }
  for (const id of ['file.duplicate', 'folder.newFile', 'plan.moveUp', 'folio.room.cards', 'block.edit', 'skills.openThread', 'outline.indentListItem', 'outline.outdentListItem', 'idea.insertWikilink']) {
    expect(items.find(c => c.id === id), id).toBeDefined()
    expect(items.find(c => c.id === id)?.accelerator, id).toBeUndefined()
  }
})

test('invalid and unmodified accelerator strings never reach Electron', () => {
  for (const chord of ['F2', '↵', '⇥', '⇧⇥', 'Esc', 'M', '[[', '⌘[[', '⌘NotAKey', '⌘', '⇧A']) expect(toAccelerator(chord), chord).toBeUndefined()
  expect(toAccelerator('⌘A')).toBe('CmdOrCtrl+A')
})


test('conflicting stored overrides never advertise the same chord on two commands', () => {
  const items = flatten(buildCommandMenu(menuCommands(liveRows(), { 'edit.bold': '⌥⇧⌘I', 'edit.italic': '⇧⌥⌘I' }, editorState, true)))
  expect(items.find(item => item.id === 'edit.bold')?.accelerator).toBeUndefined()
  expect(items.find(item => item.id === 'edit.italic')?.accelerator).toBeUndefined()
})


test('a checkbox click retains its live check until the renderer publishes a changed model', () => {
  const runs: string[] = []
  const template = buildMenuTemplate([{ menu: 'view', submenu: [{ id: 'view.typewriter', checked: false }] }], id => runs.push(id), [])
  const item = (template[0].submenu as import('electron').MenuItemConstructorOptions[])[0]
  const toggled = { checked: true } as import('electron').MenuItem
  item.click!(toggled, null as never, {} as never)
  expect(toggled.checked).toBe(false)
  expect(runs).toEqual(['view.typewriter'])
})


test('native Edit roles yield their displayed chord to a rebound editor command', () => {
  const tree = buildCommandMenu(menuCommands(liveRows(), { 'edit.bold': '⌘X' }, editorState, true))
  const template = buildMenuTemplate(tree, () => {}, [], 'editor')
  const edit = template.find(item => item.label === 'Edit')!.submenu as import('electron').MenuItemConstructorOptions[]
  expect(edit.find(item => item.label === 'Cut')?.accelerator).toBe('')
  const plain = buildMenuTemplate(tree, () => {}, [], 'plain-text-field')
  const plainEdit = plain.find(item => item.label === 'Edit')!.submenu as import('electron').MenuItemConstructorOptions[]
  expect(plainEdit.find(item => item.role === 'cut')?.accelerator).toBeUndefined()
})


test('history and text roles belong only to plain text fields in all three focus states', () => {
  for (const focus of ['editor', 'plain-text-field', 'other'] as const) {
    const template = buildMenuTemplate(model(), () => {}, [], focus)
    const edit = template.find(item => item.label === 'Edit')!.submenu as import('electron').MenuItemConstructorOptions[]
    for (const id of ['edit.undo', 'edit.redo']) {
      const item = edit.find(item => item.id === id)!
      expect(item.role, `${focus}: ${id}`).toBe(focus === 'plain-text-field' ? id.slice(5) as 'undo' | 'redo' : undefined)
      if (focus !== 'plain-text-field') expect(item.click).toBeFunction()
    }
    for (const label of ['Cut', 'Copy', 'Paste', 'Paste and Match Style', 'Delete', 'Select All']) {
      const item = edit.find(item => item.label === label)!
      expect(Boolean(item.role), `${focus}: ${label}`).toBe(focus === 'plain-text-field')
      if (focus !== 'plain-text-field') {
        const calls: string[] = []
        const webContents = Object.fromEntries(['cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'].map(action => [action, () => calls.push(action)]))
        item.click!({} as never, { webContents } as never, {} as never)
        expect(calls, `${focus}: ${label}`).toHaveLength(1)
      }
    }
  }
})

test('no two enabled siblings share a menu-bar label', () => {
  const walk = (items: CommandMenuItem[]) => {
    const labels = items.filter(item => item.enabled !== false && item.label).map(item => item.label)
    expect(new Set(labels).size, labels.join(', ')).toBe(labels.length)
    for (const item of items) if (item.submenu) walk(item.submenu)
  }
  // Make every runnable row available, including editor commands.
  const tree = buildCommandMenu(menuCommands(liveRows(), {}, editorState, true))
  walk(tree)
  const allEnabled = (items: CommandMenuItem[]): CommandMenuItem[] => items.map(item => ({ ...item, enabled: true, ...(item.submenu ? { submenu: allEnabled(item.submenu) } : {}) }))
  walk(allEnabled(tree))
  for (const [id, label] of Object.entries(MENU_BAR_LABELS)) {
    expect(flatten(tree).find(item => item.id === id)?.label, id).toBe(label)
    expect(commandRegistry.find(command => command.id === id)?.label, id).not.toBe(label)
  }
})

test('keyless plan commands stay place-bound when rebound', () => {
  const command = commandRegistry.find(command => command.id === 'plan.addAllFromFolder')!
  expect(command.keys).toBeUndefined()
  expect(command.keysPlaceBound).toBe(true)
  const items = flatten(buildCommandMenu(menuCommands(liveRows(), { [command.id]: '⌃⌥Q' }, editorState, true)))
  expect(items.find(item => item.id === command.id)?.accelerator).toBeUndefined()
})
