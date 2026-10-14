import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bold, Command, Italic, Table, Undo2 } from 'lucide-react'
import {
  DEFAULT_ACTION_BAR_GROUPS,
  DEFAULT_ACTION_BAR_ITEMS,
  flattenActionBarGroups,
  resolveActionBarGroups,
  resolveActionBarItems,
  type RunnableCommand,
} from '../../src/renderer/src/components/action-bar-commands'
import {
  addToBar,
  availableActiveIndex,
  availableRows,
  barRows,
  commandCount,
  configureCommands,
  drawnCommandCount,
  dropIndexFor,
  filterCommands,
  separatorMatchesQuery,
  groupCount,
  insertSeparator,
  moveTo,
  removeFromBar,
  tidySeparators,
  type ConfigureCommand,
} from '../../src/renderer/src/components/action-bar-configure'
import { ActionBarConfigureSheet } from '../../src/renderer/src/components/ActionBarConfigureSheet'
import { allBindableCommands, commandRegistry } from '../../src/renderer/src/commands/registry'
import { SettingsStore } from '../../src/main/settings'
import {
  ACTION_BAR_ITEMS_KEY,
  ACTION_BAR_VISIBLE_KEY,
  ACTION_BAR_SEPARATOR,
  actionBarItemsFrom,
  parseActionBarItems,
  serialiseActionBarItems,
} from '../../src/shared/action-bar-settings'

const SEP = ACTION_BAR_SEPARATOR
const stub = (label: string, extra: Partial<RunnableCommand> = {}): RunnableCommand => ({ label, icon: Bold, run: () => {}, ...extra })
const COMMANDS: ConfigureCommand[] = [
  { id: 'edit.undo', label: 'Undo', keys: '⌘Z', icon: Undo2 },
  { id: 'edit.bold', label: 'Bold', keys: '⌘B', icon: Bold },
  { id: 'edit.italic', label: 'Italic', keys: '⌘I', icon: Italic, keywords: ['emphasis'] },
]

// ---- The stored list is never allowed to break the bar ------------------------------------------

test('rubbish in the settings file never empties the bar: it reads as “never set”', () => {
  const rubbish: unknown[] = [
    undefined,
    null,
    42,
    true,
    '',
    '   ',
    'not json at all',
    '{"edit.bold":true}', // an object, not a list
    '[]', // nothing in it
    '[1, 2, 3]', // nothing that could be a command id
    '["|","|","|"]', // grouping with nothing to group
    '"edit.bold"', // a bare string, not a list
  ]
  for (const stored of rubbish) {
    expect(parseActionBarItems(stored), String(stored)).toBeNull()
    // …and the caller therefore gets the DRAWN DEFAULT rather than an empty row.
    expect(actionBarItemsFrom(stored, DEFAULT_ACTION_BAR_ITEMS), String(stored)).toEqual([...DEFAULT_ACTION_BAR_ITEMS])
  }
})

test('a half-usable stored list keeps what is usable rather than being thrown away whole', () => {
  expect(parseActionBarItems('["edit.bold", 7, null, "", "edit.italic"]')).toEqual(['edit.bold', 'edit.italic'])
  expect(serialiseActionBarItems(['edit.bold', SEP])).toBe('["edit.bold","|"]')
  expect(parseActionBarItems(serialiseActionBarItems([...DEFAULT_ACTION_BAR_ITEMS]))).toEqual([...DEFAULT_ACTION_BAR_ITEMS])
})

test('a stored id this build cannot run is dropped silently — no dead button, no empty group', () => {
  const runnable = new Map<string, RunnableCommand>([
    ['edit.undo', stub('Undo', { keys: '⌘Z' })],
    ['edit.bold', stub('Bold')],
  ])
  const stored = ['edit.undo', 'retired.command', SEP, 'ghost.verb', SEP, 'edit.bold', 'also.gone']
  const groups = resolveActionBarItems(stored, runnable, { reviewing: false })

  expect(groups.flatMap((group) => group.items.map((item) => item.commandId))).toEqual(['edit.undo', 'edit.bold'])
  // The group that held only dead ids does not survive as an empty gap between two hairlines.
  expect(groups).toHaveLength(2)
  expect(groups.every((group) => group.items.length > 0)).toBe(true)
})

test('one command is one button, whatever the stored list says', () => {
  const runnable = new Map<string, RunnableCommand>([['edit.bold', stub('Bold')]])
  const groups = resolveActionBarItems(['edit.bold', SEP, 'edit.bold'], runnable, { reviewing: false })
  expect(groups.flatMap((group) => group.items.map((item) => item.commandId))).toEqual(['edit.bold'])
})

test('a command the writer dragged on wears the palette’s own icon, and dims only when the app says so', () => {
  const runnable = new Map<string, RunnableCommand>([
    ['insert.image', stub('Insert an image', { icon: Italic })],
    ['insert.table', stub('Insert a table', { disabled: true })],
  ])
  const groups = resolveActionBarItems(['insert.image', 'insert.table'], runnable, { reviewing: true })
  const items = groups.flatMap((group) => group.items)
  // Not in the drawn default, so Reviewing does not dim it — only the app's own `disabled` does.
  expect(items.map((item) => [item.commandId, item.dimmed])).toEqual([['insert.image', false], ['insert.table', true]])
  // insert.image is not a drawn default, so it keeps the icon the palette listed it with; the table
  // IS drawn, so the drawing's glyph wins over the palette's.
  expect(items[0].icon).toBe(Italic)
  expect(items[1].icon).toBe(Table)
})

test('the sheet draws the BAR’S icons: one resolution, so a row and the button it configures cannot differ', () => {
  // The palette gives a command with no icon of its own a generic glyph (App: COMMAND_ICONS[id] ?? Command).
  // Before this was collapsed, the sheet drew that placeholder for eleven of the default bar's verbs
  // while the bar beside it drew Undo, Redo, H1, H2, H3, ¶, both lists, the quote and the table.
  const ids = DEFAULT_ACTION_BAR_ITEMS.filter((item) => item !== SEP)
  const palette = ids.map((id) => ({ id, label: id, icon: Command }))
  const rows = configureCommands(palette)
  const runnable = new Map<string, RunnableCommand>(palette.map((row) => [row.id, { label: row.label, icon: row.icon, run: () => {} }]))
  const drawn = resolveActionBarItems(DEFAULT_ACTION_BAR_ITEMS, runnable, { reviewing: false }).flatMap((group) => group.items)

  expect(drawn).toHaveLength(ids.length)
  for (const item of drawn) {
    expect(rows.find((row) => row.id === item.commandId)!.icon, item.commandId).toBe(item.icon)
  }
  // And neither surface is left holding the placeholder: every drawn default has a real glyph.
  expect(rows.filter((row) => row.icon === Command).map((row) => row.id)).toEqual([])
  expect(rows.find((row) => row.id === 'insert.table')!.icon).toBe(Table)

  // A command that is NOT on the drawn default keeps the palette's own icon in both surfaces.
  expect(configureCommands([{ id: 'app.settings', label: 'Open Settings…', icon: Command }])[0].icon).toBe(Command)
})

test('App builds the sheet’s list through that one resolution rather than mapping the palette itself', () => {
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url).pathname, 'utf8')
  expect(app).toContain('configureCommands(paletteCommandList)')
})

// ---- The default set stays DATA, in one place ---------------------------------------------------

test('the default list is the A1 array read a different way, not a second copy of it', () => {
  expect(DEFAULT_ACTION_BAR_ITEMS).toEqual(flattenActionBarGroups(DEFAULT_ACTION_BAR_GROUPS))
  // Separators stand exactly between the groups: one boundary per gap, none at either end.
  expect(DEFAULT_ACTION_BAR_ITEMS.filter((item) => item === SEP)).toHaveLength(DEFAULT_ACTION_BAR_GROUPS.length - 1)
  expect(DEFAULT_ACTION_BAR_ITEMS.at(0)).not.toBe(SEP)
  expect(DEFAULT_ACTION_BAR_ITEMS.at(-1)).not.toBe(SEP)

  // Both entry points resolve through ONE code path, so the drawn default and a stored list can
  // never be governed by different rules.
  const runnable = new Map<string, RunnableCommand>(
    DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => [entry.commandId, stub(entry.commandId)] as const)),
  )
  const fromSpec = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: false })
  const fromItems = resolveActionBarItems(DEFAULT_ACTION_BAR_ITEMS, runnable, { reviewing: false })
  expect(fromItems.map((group) => group.items.map((item) => item.commandId)))
    .toEqual(fromSpec.map((group) => group.items.map((item) => item.commandId)))
})

test('the settings layer holds no command ids of its own — there is one default list, in one place', () => {
  const shared = readFileSync(new URL('../../src/shared/action-bar-settings.ts', import.meta.url), 'utf8')
  const code = shared.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const id of DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => entry.commandId))) {
    expect(code, id).not.toContain(id)
  }
  expect(code).not.toContain('DEFAULT_ACTION_BAR')
})

// ---- The model behind both the drag and the keyboard --------------------------------------------

test('adding places a command after the chosen row, and never twice', () => {
  expect(addToBar(['a', 'b'], 'c', 1)).toEqual(['a', 'c', 'b'])
  expect(addToBar(['a', 'b'], 'c', 99)).toEqual(['a', 'b', 'c'])
  // Already there: the "add" is a MOVE, because one command is one button.
  expect(addToBar(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'c', 'b'])
  expect(addToBar(['a'], SEP, 1)).toEqual(['a', SEP])
})

test('separators bound groups: no leading one, never two in a row, a trailing one draws nothing', () => {
  expect(insertSeparator(['a', 'b'], 0)).toEqual(['a', 'b']) // a boundary before everything is not one
  expect(insertSeparator(['a', SEP, 'b'], 1)).toEqual(['a', SEP, 'b'])
  expect(insertSeparator(['a', SEP, 'b'], 2)).toEqual(['a', SEP, 'b'])
  expect(insertSeparator(['a', 'b'], 1)).toEqual(['a', SEP, 'b'])
  // A trailing one is kept — it is the group the writer is about to build — and the bar draws
  // nothing for it until a command arrives after it.
  expect(insertSeparator(['a'], 1)).toEqual(['a', SEP])
  const groups = resolveActionBarItems(['a', SEP], new Map([['a', stub('A')]]), { reviewing: false })
  expect(groups).toHaveLength(1)
  expect(tidySeparators([SEP, 'a', SEP, SEP, 'b'])).toEqual(['a', SEP, 'b'])
})

test('the bar cannot be emptied, because an empty list would resurrect the default', () => {
  expect(removeFromBar(['edit.bold'], 0)).toEqual(['edit.bold'])
  expect(removeFromBar(['edit.bold', SEP], 1)).toEqual(['edit.bold']) // grouping may always go
  expect(removeFromBar(['a', 'b'], 0)).toEqual(['b'])
  // Removing the last command of a group leaves the boundary standing as the group about to be
  // rebuilt; the bar draws nothing for it (see the separator test above).
  expect(removeFromBar(['a', SEP, 'b'], 2)).toEqual(['a', SEP])
  expect(removeFromBar([SEP, 'a', 'b'], 2)).toEqual(['a']) // a leading one never survives
})

test('the DEFAULT bar cannot be emptied one button at a time: the rule counts what is drawn', () => {
  // Counting stored ids let a writer take every DRAWN button off, one by one, and end at a blank
  // strip with no way to tell whether the user had broken the app: the rule was still counting an id that
  // drew nothing. It now asks the question the header asks — how many buttons are DRAWN.
  //
  // All sixteen drawn defaults run today, so the undrawable id here is a RETIRED verb: a writer's
  // stored list outlives the commands a build removes, which is the case the rule must survive.
  const stored: readonly string[] = [...DEFAULT_ACTION_BAR_ITEMS, 'edit.retiredVerb']
  const drawable = new Map<string, ConfigureCommand>(
    DEFAULT_ACTION_BAR_ITEMS
      .filter((item) => item !== SEP)
      .map((id) => [id, { id, label: id, icon: Bold }]),
  )
  expect(commandCount(stored)).toBe(17)
  expect(drawnCommandCount(barRows(stored, drawable))).toBe(16)

  let items: readonly string[] = stored
  let refused = 0
  // Take the first drawn button off, over and over, exactly as the sheet's ← / ⌫ does.
  for (let attempt = 0; attempt < 40 && refused === 0; attempt += 1) {
    const drawn = barRows(items, drawable).filter((row) => row.kind === 'command')
    if (drawn.length === 0) break
    const next = removeFromBar(items, drawn[0].index, drawable)
    if (next.length === items.length) refused += 1 // the sheet reads a refusal exactly this way
    else items = next
  }

  // The bar still draws a button, and the writer was told why rather than left with a blank strip.
  expect(refused).toBe(1)
  expect(drawnCommandCount(barRows(items, drawable))).toBe(1)
  // The id that fools the rule is still in storage — the rule simply no longer counts it.
  expect(items).toContain('edit.retiredVerb')
  expect(commandCount(items)).toBe(2)
})

test('the empty rule reads the drawn bar when it is given the commands, and the list when it is not', () => {
  const drawable = new Map<string, ConfigureCommand>([['edit.bold', { id: 'edit.bold', label: 'Bold', icon: Bold }]])
  // One drawn button and one undrawable id: taking the button off would leave nothing to see.
  expect(removeFromBar(['edit.bold', 'edit.retiredVerb'], 0, drawable)).toEqual(['edit.bold', 'edit.retiredVerb'])
  // The undrawable id itself may always go — removing it changes nothing the writer can see.
  expect(removeFromBar(['edit.bold', 'edit.retiredVerb'], 1, drawable)).toEqual(['edit.bold'])
  // A caller with no command map can only mean the stored list, and keeps the old reading.
  expect(removeFromBar(['edit.bold', 'edit.retiredVerb'], 0)).toEqual(['edit.retiredVerb'])
})

test('moving a row lands it where it was dropped, and tidies what it left behind', () => {
  expect(moveTo(['a', 'b', 'c'], 0, 3)).toEqual(['b', 'c', 'a'])
  // Dropping onto a row FURTHER DOWN lands above that row, not one place past it: the target is a
  // position in the list as the writer sees it, before their own row is lifted out of it.
  expect(moveTo(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'a', 'c'])
  expect(moveTo(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  expect(moveTo(['a', SEP, 'b'], 2, 0)).toEqual(['b', 'a', SEP])
  expect(moveTo([SEP, 'a', 'b'], 2, 0)).toEqual(['b', SEP, 'a']) // a boundary that gained a left side stays
  expect(moveTo([SEP, 'a', 'b'], 1, 3)).toEqual(['b', 'a']) // one left with nothing to its left goes
  expect(moveTo(['a', 'b'], 5, 0)).toEqual(['a', 'b'])
})

test('the header counts the bar the writer can SEE, not the ids in storage', () => {
  // A stored id with no command draws nothing, so a list of three ids can be a bar of two. The
  // header read the LIST — "16 on the bar" over a bar of 15 — until it was made to count the rows
  // the sheet itself drew: one count, from the rows, rather than a second pass over the list.
  const items = ['edit.undo', SEP, 'edit.bold', 'edit.retiredVerb']
  const markup = renderToStaticMarkup(
    <ActionBarConfigureSheet items={items} commands={COMMANDS} onChange={() => {}} onReset={() => {}} onClose={() => {}} />,
  )
  expect(markup).toContain('3 commands available · 2 on the bar · 2 groups')
  // The stored list still has three ids in it — that is what the header must NOT report.
  expect(commandCount(items)).toBe(3)
  expect(drawnCommandCount(barRows(items, new Map(COMMANDS.map((entry) => [entry.id, entry]))))).toBe(2)

  // The GROUPS half of the same line has the same two readings: a stored run whose every id is
  // undrawable is a group in the list and nothing on the bar.
  const hollow = ['edit.undo', SEP, 'edit.retiredVerb']
  const second = renderToStaticMarkup(
    <ActionBarConfigureSheet items={hollow} commands={COMMANDS} onChange={() => {}} onReset={() => {}} onClose={() => {}} />,
  )
  expect(second).toContain('3 commands available · 1 on the bar · 1 groups')
  expect(groupCount(hollow)).toBe(2)
})

test('the counts in the sheet’s header describe the bar, not the list', () => {
  expect(commandCount(['a', SEP, 'b', 'b'])).toBe(2)
  expect(groupCount(['a', SEP, 'b'])).toBe(2)
  expect(groupCount(['a', SEP])).toBe(1) // the group being built is not a group yet
  expect(groupCount([SEP, 'a', SEP, SEP, 'b'])).toBe(2) // a boundary bounding nothing is not a group
  expect(groupCount([])).toBe(0)
})

test('the two lists: the bar in order, and every command with its place marked', () => {
  const byId = new Map(COMMANDS.map((entry) => [entry.id, entry]))
  const rows = barRows(['edit.undo', SEP, 'gone.away', 'edit.bold'], byId)
  expect(rows.map((row) => (row.kind === 'separator' ? SEP : row.commandId))).toEqual(['edit.undo', SEP, 'edit.bold'])
  // Row positions index the STORED list, so an edit lands where the writer is looking even though
  // the dead id between them is not drawn.
  expect(rows.map((row) => row.index)).toEqual([0, 1, 3])

  const available = availableRows(COMMANDS, ['edit.bold'])
  expect(available[0].kind).toBe('separator') // pinned: a draggable item needs somewhere to drag FROM
  expect(available.slice(1).map((row) => (row.kind === 'command' ? [row.commandId, row.onBar] : null)))
    .toEqual([['edit.undo', false], ['edit.bold', true], ['edit.italic', false]])
})

// ---- What a search is FOR ----------------------------------------------------------------------

test('a search lists only what it matched: the pinned separator is not a match for “typewriter”', () => {
  // Unfiltered, the separator is the list's first row — it has to be reachable and draggable.
  expect(availableRows(COMMANDS, [], '')[0].kind).toBe('separator')
  expect(availableRows(COMMANDS, [])[0].kind).toBe('separator')

  // Searched for, it is a row like any other: present when the writer named it, absent otherwise.
  expect(separatorMatchesQuery('sep')).toBe(true)
  expect(separatorMatchesQuery('GROUP')).toBe(true)
  expect(separatorMatchesQuery('divider')).toBe(true)
  expect(separatorMatchesQuery('typewriter')).toBe(false)
  expect(separatorMatchesQuery('bol')).toBe(false)
  // A bare substring is not a name: "o" lives inside both "group" and "boundary" and must not
  // summon a separator to the top of a seven-command answer.
  expect(separatorMatchesQuery('o')).toBe(false)
  expect(separatorMatchesQuery('ary')).toBe(false)

  const searched = availableRows(filterCommands(COMMANDS, 'bol'), [], 'bol')
  expect(searched.map((row) => (row.kind === 'separator' ? SEP : row.commandId))).toEqual(['edit.bold'])
})

test('the active row of the left list is the TOP MATCH — never the separator, unless it was searched for', () => {
  // THE DEFECT, 2026-09-12: with the separator pinned at 0 and the active row always 0, a writer
  // who searched and pressed Enter got a separator on the bar instead of what they searched for.
  const unfiltered = availableRows(COMMANDS, [], '')
  expect(availableActiveIndex(unfiltered)).toBe(1)
  expect(unfiltered[availableActiveIndex(unfiltered)]).toMatchObject({ kind: 'command', commandId: 'edit.undo' })
  // Still reachable: it is one ↑ above the default, which is what "pinned above" means.
  expect(unfiltered[availableActiveIndex(unfiltered) - 1].kind).toBe('separator')

  const searched = availableRows(filterCommands(COMMANDS, 'emphasis'), [], 'emphasis')
  expect(searched[availableActiveIndex(searched)]).toMatchObject({ kind: 'command', commandId: 'edit.italic' })

  // A list with a separator in it but commands too still opens on the first COMMAND.
  const mixed = availableRows(filterCommands(COMMANDS, 'bol'), [], '')
  expect(mixed[0].kind).toBe('separator')
  expect(mixed[availableActiveIndex(mixed)]).toMatchObject({ kind: 'command', commandId: 'edit.bold' })

  // Named directly, the separator IS the top match — the writer asked for it.
  const named = availableRows(filterCommands(COMMANDS, 'separator'), [], 'separator')
  expect(named[availableActiveIndex(named)].kind).toBe('separator')

  // A search that matches nothing has no active row to add, and Enter must find nothing there.
  const empty = availableRows(filterCommands(COMMANDS, 'typewriter'), [], 'typewriter')
  expect(empty).toHaveLength(0)
  expect(empty[availableActiveIndex(empty)]).toBeUndefined()
})

test('search reaches label, id and the palette’s own keywords', () => {
  expect(filterCommands(COMMANDS, 'bol').map((entry) => entry.id)).toEqual(['edit.bold'])
  expect(filterCommands(COMMANDS, 'EDIT.').map((entry) => entry.id)).toEqual(['edit.undo', 'edit.bold', 'edit.italic'])
  expect(filterCommands(COMMANDS, 'emphasis').map((entry) => entry.id)).toEqual(['edit.italic'])
  expect(filterCommands(COMMANDS, '   ')).toHaveLength(COMMANDS.length)
  expect(filterCommands(COMMANDS, 'nothing here')).toHaveLength(0)
})

test('a drop lands above the row it was released over, and past the last row appends', () => {
  const rects = [{ top: 0, height: 20 }, { top: 20, height: 20 }, { top: 40, height: 20 }]
  expect(dropIndexFor(rects, 5)).toBe(0)
  expect(dropIndexFor(rects, 15)).toBe(1)
  expect(dropIndexFor(rects, 35)).toBe(2)
  expect(dropIndexFor(rects, 99)).toBe(3)
})

// ---- The drawn sheet ----------------------------------------------------------------------------

test('the sheet is the drawing: two lists, a search field over the left one, a middle column', () => {
  const markup = renderToStaticMarkup(
    <ActionBarConfigureSheet
      items={['edit.undo', SEP, 'edit.bold']}
      commands={COMMANDS}
      onChange={() => {}}
      onReset={() => {}}
      onClose={() => {}}
    />,
  )
  expect(markup).toContain('>Every command<')
  expect(markup).toContain('>On the bar — in this order<')
  expect(markup).toContain('aria-label="Search commands"')
  expect(markup).toContain('aria-label="Put the selected command on the bar"')
  expect(markup).toContain('aria-label="Take the selected command off the bar"')
  expect(markup).toContain('aria-label="Add a separator"')
  expect(markup).toContain('Reset to the default set')
  // The header counts, as the drawing shows them.
  expect(markup).toContain('3 commands available · 2 on the bar · 2 groups')
  // Separators are ITEMS: one in the bar list, one pinned at the top of the left list to drag from.
  expect(markup.match(/aria-label="— separator —"/g)?.length).toBe(2)
  // Each row carries its chord, the drawing's em dash standing in for "none".
  expect(markup).toContain('⌘Z')
  expect(markup).toContain('class="abcfg-row picked"')
  // Both lists are listboxes with a roving tab stop — one Tab stop each, arrows inside.
  expect(markup.match(/role="listbox"/g)?.length).toBe(2)
  expect(markup.match(/role="option"/g)?.length).toBe(3 + COMMANDS.length + 1)
  expect(markup.match(/tabindex="0"/g)?.length).toBe(2)
})

// ---- Where it is reached from, and where the state lives ----------------------------------------

test('the sheet is reached from the bar’s own control AND from Settings → Action bar', () => {
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  // A1 left the bar's configure control behind one prop; this is it.
  expect(app).toContain('onConfigure={() => setConfigureActionBarOpen(true)}')
  expect(app).toContain('<ActionBarConfigureSheet')
  expect(app).toContain('onConfigureActionBar={() => setConfigureActionBarOpen(true)}')
  // The sheet is rendered AFTER the Settings window, so opening it from inside Settings puts it on
  // top rather than behind.
  expect(app.indexOf('<ActionBarConfigureSheet')).toBeGreaterThan(app.indexOf('<SettingsWindow'))
  // While it is up it owns the keyboard, like every other sheet.
  expect(app).toContain('|| configureActionBarOpen')

  const settings = readFileSync(new URL('../../src/renderer/src/components/SettingsWindow.tsx', import.meta.url), 'utf8')
  expect(settings).toContain("{ id: 'sec-action-bar', title: 'Action bar', icon: PanelTop }")
  expect(settings).toContain('onClick={onConfigureActionBar}')
  // The Settings switch writes the SAME global boolean the toolbar toggle does — no second setting.
  expect(settings).toContain('onSet(ACTION_BAR_VISIBLE_KEY, e.target.checked, ACTION_BAR_VISIBLE_LABEL)')
})

test('configuring the bar is a registered, palette-listed, rebindable command', () => {
  const entry = commandRegistry.find((row) => row.id === 'view.configureActionBar')
  expect(entry).toMatchObject({ label: 'Configure the action bar…', group: 'View', surfaces: ['palette', 'sheet'] })
  expect(entry?.keys).toBeUndefined() // keyless for the app-wide sweep, never unfindable
  expect(allBindableCommands().some((row) => row.id === 'view.configureActionBar')).toBe(true)
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  expect(app).toContain('id: CONFIGURE_ACTION_BAR_COMMAND.id')
})

test('the ordered list persists beside the visibility boolean, in the same app-level file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'writeflex-action-bar-items-')), 'settings.json')
  const store = new SettingsStore(file)
  expect(store.get(ACTION_BAR_ITEMS_KEY)).toBeNull() // untouched: the drawn default applies

  store.set(ACTION_BAR_VISIBLE_KEY, false, 'Action bar')
  store.set(ACTION_BAR_ITEMS_KEY, serialiseActionBarItems(['edit.bold', SEP, 'edit.undo']), 'Action bar commands')

  // The next launch — and the next window — reads both from the same file.
  const reopened = new SettingsStore(file)
  expect(reopened.actionBarVisible()).toBe(false)
  expect(actionBarItemsFrom(reopened.get(ACTION_BAR_ITEMS_KEY), DEFAULT_ACTION_BAR_ITEMS)).toEqual(['edit.bold', SEP, 'edit.undo'])

  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { values: Record<string, unknown> }
  expect(Object.keys(onDisk.values).filter((key) => key.includes('actionBar')).sort())
    .toEqual([ACTION_BAR_ITEMS_KEY, ACTION_BAR_VISIBLE_KEY].sort())
  // One app-level key, nothing window-scoped: two windows cannot disagree about what is on the bar.
  expect(Object.keys(onDisk.values).some((key) => /window|per-window/i.test(key))).toBe(false)
})

test('the list rides the settings:changed broadcast A1 built, so a second window redraws with it', () => {
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  // Read from the SAME settingValues record the broadcast updates — not from a private copy.
  expect(app).toContain('actionBarItemsFrom(settingValues[ACTION_BAR_ITEMS_KEY], DEFAULT_ACTION_BAR_ITEMS)')
  expect(app).toContain('setSetting(ACTION_BAR_ITEMS_KEY, serialiseActionBarItems(items), ACTION_BAR_ITEMS_LABEL')
  // Reset UNSETS the key rather than writing a copy of the default, so the default stays one array.
  expect(app).toContain('setSetting(ACTION_BAR_ITEMS_KEY, null, ACTION_BAR_ITEMS_LABEL')
})

test('the sheet needs no drag-and-drop dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
  for (const name of names) expect(name, name).not.toMatch(/dnd|drag|sortable/i)
})
