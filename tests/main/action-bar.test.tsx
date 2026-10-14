import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { Bold, Undo2 } from 'lucide-react'
import { EditorSelection, EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ActionBar } from '../../src/renderer/src/components/ActionBar'
import {
  DEFAULT_ACTION_BAR_GROUPS,
  DEFAULT_ACTION_BAR_ITEMS,
  resolveActionBarGroups,
  type ActionBarGroupSpec,
  type RunnableCommand,
} from '../../src/renderer/src/components/action-bar-commands'
import { planGroupOverflow, widthNeeded } from '../../src/renderer/src/components/action-bar-overflow'
import { Toolbar } from '../../src/renderer/src/components/Toolbar'
import { allBindableCommands, commandRegistry, registryCommand } from '../../src/renderer/src/commands/registry'
import { SettingsStore } from '../../src/main/settings'
import { ACTION_BAR_SEPARATOR, ACTION_BAR_VISIBLE_KEY, actionBarVisibleFrom } from '../../src/shared/action-bar-settings'

const stub = (label: string, extra: Partial<RunnableCommand> = {}): RunnableCommand => ({ label, run: () => {}, ...extra })

const allRunnable = (): Map<string, RunnableCommand> =>
  new Map(DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => [entry.commandId, stub(entry.commandId)] as const)))

const toolbar = (props: { actionBarVisible: boolean }) =>
  renderToStaticMarkup(
    <Toolbar
      sidebarOpen
      onToggleSidebar={() => {}}
      panelsOpen
      onTogglePanels={() => {}}
      writerMode="drafting"
      viewMode="clean"
      modeDrawerOpen={false}
      onModeDrawerOpenChange={() => {}}
      onSelectWriterMode={() => {}}
      onSelectViewMode={() => {}}
      readingRoomOpen={false}
      readingRoomShortcut="⌃⌘R"
      onToggleReadingRoom={() => {}}
      onOpenPalette={() => {}}
      actionBarVisible={props.actionBarVisible}
      onToggleActionBar={() => {}}
    />,
  )

// ---- The command set is data -----------------------------------------------------------------

test('the bar is one list of command ids: a drawn verb with no command yet is dropped, not drawn dead', () => {
  const drawn = DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => entry.commandId))
  expect(drawn).toContain('edit.bold')
  // A drawn id the window cannot run is dropped rather than drawn dead. Every drawn default runs
  // today (tests/main/block-marks asserts that), so this claim is about the RULE — which a stored
  // list still needs the day a verb is retired — and not about which ids are missing.
  const runnable = new Map<string, RunnableCommand>([
    ['edit.undo', stub('Undo', { keys: '⌘Z' })],
    ['edit.bold', stub('Bold', { keys: '⌘B' })],
  ])
  const groups = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: false })
  // Two groups survive — history and marks. After A2 a group IS what lies between two separators,
  // so its id is positional; what the bar draws is the claim, and that is asserted next.
  expect(groups.map((group) => group.id)).toEqual(['g1', 'g2'])
  expect(groups.flatMap((group) => group.items.map((item) => item.commandId))).toEqual(['edit.undo', 'edit.bold'])
  expect(groups[0].items[0].keys).toBe('⌘Z')
})

test('a group left with nothing runnable disappears with its separator rather than drawing an empty gap', () => {
  const spec: ActionBarGroupSpec[] = [
    { id: 'one', entries: [{ commandId: 'a', icon: Undo2 }] },
    { id: 'empty', entries: [{ commandId: 'missing', icon: Bold }] },
  ]
  const groups = resolveActionBarGroups(spec, new Map([['a', stub('A')]]), { reviewing: false })
  expect(groups).toHaveLength(1)
  expect(groups.flatMap((group) => group.items.map((item) => item.commandId))).toEqual(['a'])
})

test('Reviewing keeps the bar’s shape and dims the writing verbs rather than dropping them', () => {
  const drafting = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, allRunnable(), { reviewing: false })
  const reviewing = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, allRunnable(), { reviewing: true })

  // Same groups, same buttons, same order: muscle memory survives the mode.
  expect(reviewing.map((group) => group.id)).toEqual(drafting.map((group) => group.id))
  expect(reviewing.flatMap((group) => group.items.map((item) => item.commandId)))
    .toEqual(drafting.flatMap((group) => group.items.map((item) => item.commandId)))

  const dimmed = reviewing.flatMap((group) => group.items.filter((item) => item.dimmed).map((item) => item.commandId))
  expect(dimmed).toContain('edit.bold')
  expect(dimmed).toContain('outline.makeHeadingLevel2')
  expect(dimmed).not.toContain('edit.undo')
  expect(dimmed).not.toContain('readAloud.start')
  expect(drafting.some((group) => group.items.some((item) => item.dimmed))).toBe(false)
})

test('no review-navigation group by default — the belt already owns ‹ › and the count (ADR-0026)', () => {
  const ids = DEFAULT_ACTION_BAR_GROUPS.flatMap((group) => group.entries.map((entry) => entry.commandId))
  for (const id of ['review.nextChange', 'review.previousChange', 'review.acceptAndNext', 'writer.acceptSession']) {
    expect(ids).not.toContain(id)
  }
})

test('every verb the bar draws can be looked up in the ⌘/ cheat sheet', () => {
  // A writer who sees a button on the bar and wants to know what it is looks it up in ⌘/. A verb
  // reaches that sheet either by carrying the 'sheet' surface itself or through a sheet row that
  // names it as its source (Bold, Italic and Link are listed that way, inside the Editing block).
  // The live pass of 2026-09-12 found `insert.table` drawn on the bar and absent from the sheet.
  const inSheet = new Set(
    commandRegistry
      .filter((command) => command.surfaces.includes('sheet'))
      .flatMap((command) => [command.id, ...(command.sheetSource?.kind === 'command' ? [command.sheetSource.commandId] : [])]),
  )
  const registered = new Set(commandRegistry.map((command) => command.id))
  const drawn = DEFAULT_ACTION_BAR_ITEMS.filter((item) => item !== ACTION_BAR_SEPARATOR)
  // Every drawn id is a registered command, so every one of them must be lookupable.
  expect(drawn.filter((id) => !registered.has(id) && !['edit.undo', 'edit.redo', 'readAloud.start'].includes(id))).toEqual([])
  expect(drawn.filter((id) => registered.has(id) && !inSheet.has(id))).toEqual([])
  for (const id of ['insert.table', 'edit.strikethrough', 'edit.bold', 'list.bullet', 'outline.makeParagraph', 'edit.toggleComment']) {
    expect(inSheet.has(id), id).toBe(true)
  }
  // The table verb keeps the Insert menu it was built for — the sheet is an addition, not a move.
  expect(commandRegistry.find((command) => command.id === 'insert.table')?.surfaces).toEqual(['palette', 'menu', 'sheet'])
})

test('a command the window cannot run right now is shown dimmed rather than hidden', () => {
  const runnable = new Map<string, RunnableCommand>([['edit.undo', stub('Undo', { disabled: true })]])
  const [group] = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: false })
  expect(group.items[0].dimmed).toBe(true)
})

// ---- Whole-group overflow ---------------------------------------------------------------------

test('groups fold whole, right to left, and the … is only reserved when something is inside it', () => {
  // Four groups whose cumulative widths (separators included) are 100, 220, 340, 460.
  const input = { prefixWidths: [100, 220, 340, 460], overflowChunk: 40, tailChunk: 30 }
  expect(widthNeeded({ ...input, available: 600 }, 4)).toBe(490) // no … reserved when all four fit
  expect(widthNeeded({ ...input, available: 600 }, 3)).toBe(410) // … reserved as soon as one folds
  expect(planGroupOverflow({ ...input, available: 600 })).toEqual({ visible: 4, overflowing: 0 })
  expect(planGroupOverflow({ ...input, available: 490 })).toEqual({ visible: 4, overflowing: 0 })
  expect(planGroupOverflow({ ...input, available: 489 })).toEqual({ visible: 3, overflowing: 1 })
  expect(planGroupOverflow({ ...input, available: 410 })).toEqual({ visible: 3, overflowing: 1 })
  expect(planGroupOverflow({ ...input, available: 409 })).toEqual({ visible: 2, overflowing: 2 })
  expect(planGroupOverflow({ ...input, available: 290 })).toEqual({ visible: 2, overflowing: 2 })
  expect(planGroupOverflow({ ...input, available: 289 })).toEqual({ visible: 1, overflowing: 3 })
  expect(planGroupOverflow({ ...input, available: 170 })).toEqual({ visible: 1, overflowing: 3 })
  expect(planGroupOverflow({ ...input, available: 169 })).toEqual({ visible: 0, overflowing: 4 })
  // Never a partial group: the plan is always a count of WHOLE leading groups.
  for (const available of [600, 489, 400, 300, 200, 120, 60]) {
    const plan = planGroupOverflow({ ...input, available })
    expect(Number.isInteger(plan.visible)).toBe(true)
    expect(plan.visible + plan.overflowing).toBe(4)
  }
})

test('before the first measurement the bar shows everything rather than flashing an empty row', () => {
  expect(planGroupOverflow({ available: 0, prefixWidths: [100, 200], overflowChunk: 40, tailChunk: 30 })).toEqual({ visible: 2, overflowing: 0 })
})

test('the bar renders its groups and carries no fold chevron of its own', () => {
  const groups = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, allRunnable(), { reviewing: false })
  const html = renderToStaticMarkup(<ActionBar groups={groups} />)
  expect(html).toContain('role="toolbar"')
  expect(html).toContain('aria-label="Action bar"')
  expect(html.match(/data-group="/g)?.length).toBe(DEFAULT_ACTION_BAR_GROUPS.length)
  // The one and only toggle lives on the shelf: no chevron, no collapse control, on the bar itself.
  expect(html).not.toContain('aria-label="Collapse the action bar"')
  expect(html).not.toContain('chevron')
  // A2 owns the configure sheet; until it is passed in, the control is absent rather than dead.
  expect(html).not.toContain('Configure the action bar')
  expect(renderToStaticMarkup(<ActionBar groups={groups} onConfigure={() => {}} />)).toContain('Configure the action bar')
})

// ---- The one way back in -----------------------------------------------------------------------

test('the toolbar carries one action-bar toggle beside the palette and panels buttons', () => {
  const shown = toolbar({ actionBarVisible: true })
  const hidden = toolbar({ actionBarVisible: false })
  expect(shown.match(/aria-label="Show\/Hide the action bar"/g)?.length).toBe(1)
  // The same aria-pressed contract as its siblings, and the title says which way it goes.
  expect(shown).toContain('aria-pressed="true" title="Hide the action bar"')
  expect(hidden).toContain('aria-pressed="false" title="Show the action bar"')
  // Its siblings are untouched: the ADR-0026 shelf still carries exactly its own five chords.
  expect(shown.match(/class="chord"/g)?.length).toBe(5)
  expect(shown.indexOf('Show/Hide the action bar')).toBeGreaterThan(shown.indexOf('aria-label="Command palette"'))
  expect(shown.indexOf('Show/Hide the action bar')).toBeLessThan(shown.indexOf('aria-label="Toggle panels"'))
})

test('the toggle is a registered, rebindable, cheat-sheet-documented command with an App runner', () => {
  const command = commandRegistry.find((entry) => entry.id === 'view.actionBar')
  expect(command).toMatchObject({ label: 'Show/Hide the action bar', group: 'View', surfaces: ['palette', 'sheet'] })
  // Keyless by the pre-v1 ruling — palette-listed and assignable, never an unfindable keydown.
  expect(command?.keys).toBeUndefined()
  expect(allBindableCommands().some((entry) => entry.id === 'view.actionBar')).toBe(true)
  const app = readFileSync(new URL('../../src/renderer/src/app/App.tsx', import.meta.url), 'utf8')
  expect(app).toContain('id: ACTION_BAR_COMMAND.id')
  // The bar's buttons come from the same rows the palette runs, so the two cannot disagree.
  expect(app).toContain('resolveActionBarItems(actionBarItems, runnable')
  // Hidden is ABSENCE: the shell renders the bar only when the setting says so, and reads that
  // setting from the app-level store rather than from any per-window state.
  expect(app).toContain('{actionBarVisible && <ActionBar groups={actionBarGroups} onConfigure=')
  expect(app).toContain('actionBarVisibleFrom(settingValues[ACTION_BAR_VISIBLE_KEY])')
})

test('undo and redo stop being unfindable keydowns and become real commands', () => {
  for (const [id, label, keys] of [['edit.undo', 'Undo', 'Mod-z'], ['edit.redo', 'Redo', 'Shift-Mod-z']]) {
    const command = commandRegistry.find((entry) => entry.id === id)
    expect(command).toMatchObject({ label, keys, surfaces: ['palette', 'sheet'] })
    expect(command?.run).toBeFunction()
    expect(allBindableCommands().some((entry) => entry.id === id)).toBe(true)
  }
})

// ---- Where the state lives ---------------------------------------------------------------------

test('visibility is one global setting, remembered across restarts', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'writeflex-action-bar-settings-')), 'settings.json')
  const store = new SettingsStore(file)
  // Never touched is not "hidden": the shipped default applies until the writer decides.
  expect(store.get(ACTION_BAR_VISIBLE_KEY)).toBeNull()
  expect(store.actionBarVisible()).toBe(true)

  store.set(ACTION_BAR_VISIBLE_KEY, false, 'Action bar')
  expect(store.actionBarVisible()).toBe(false)

  // A second store over the same file is the next launch — and the next window.
  expect(new SettingsStore(file).actionBarVisible()).toBe(false)
  const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { values: Record<string, unknown> }
  expect(onDisk.values[ACTION_BAR_VISIBLE_KEY]).toBe(false)
  // One key for the app: nothing window-scoped, so two windows cannot disagree.
  expect(Object.keys(onDisk.values).filter((key) => key.includes('actionBar'))).toEqual([ACTION_BAR_VISIBLE_KEY])
})

test('a stored non-boolean never breaks the bar', () => {
  expect(actionBarVisibleFrom('yes')).toBe(true)
  expect(actionBarVisibleFrom(undefined)).toBe(true)
  expect(actionBarVisibleFrom(false)).toBe(false)
})

test('every window hears a settings change, so a second window cannot disagree with the first', () => {
  const ipc = readFileSync(new URL('../../src/main/ipc.ts', import.meta.url), 'utf8')
  // The write fans out to every open window, carrying what the store holds AFTER the write.
  expect(ipc).toMatch(/const broadcastSettingChange = \(key: string\): void => \{\s*for \(const state of allStates\(\)\) sendSafe\(state, 'settings:changed', \{ key, value: settings\.get\(key\) \}\)/)
  const setHandler = ipc.slice(ipc.indexOf("ipcMain.handle('settings:set'"), ipc.indexOf("ipcMain.handle('settings:changelog'"))
  expect(setHandler).toContain('broadcastSettingChange(input.key)')
  const revertHandler = ipc.slice(ipc.indexOf("ipcMain.handle('settings:revert'"), ipc.indexOf("ipcMain.handle('export-presets:get'"))
  expect(revertHandler).toContain('broadcastSettingChange(entry.key)')

  const preload = readFileSync(new URL('../../src/preload/index.ts', import.meta.url), 'utf8')
  expect(preload).toContain("multiplexIpcChannel<{ key: string; value: SettingValue | null }>(ipcRenderer, 'settings:changed')")
  expect(preload).toContain('onSettingChanged: subscribeSettingChanged,')

  const hook = readFileSync(new URL('../../src/renderer/src/hooks/useSettings.ts', import.meta.url), 'utf8')
  expect(hook).toContain('window.writeflex.onSettingChanged(')
  expect(hook).toContain('applyRef.current(key, value)')
})

test('distraction-free hides the bar with the rest of the chrome, and hidden has no style of its own', async () => {
  const css = await Bun.file(new URL('../../src/renderer/src/styles/app.css', import.meta.url)).text()
  expect(css).toContain('.window.df .toolbar,.window.df .actionbar,.window.df .statusbar{display:none}')
  expect(css).toMatch(/\.actionbar\{[^}]*height:30px/)
  // No hidden/collapsed variant exists to reserve a lip: hidden is absence, not a class.
  expect(css).not.toMatch(/\.actionbar\.(hidden|collapsed|folded)/)
})

// ---- the sixteenth button ------------------------------------------------------------------------

/**
 * THE BAR'S SIXTEENTH BUTTON, 2026-09-12. The drawing's aside group carries a message square
 * labelled "Add a comment". It named `comment.add`, which no build ever had, so the resolver
 * dropped it and the bar drew fifteen buttons over a drawing of sixteen.
 *
 * The owner ruled it is the note WriteFlex already has: `edit.toggleComment` — the `// ` line note
 * left out of the word count and stripped on export. Not an anchored comment on a span of words;
 * that is its own feature, its own id and its own design round.
 *
 * This presses the BUTTON — the resolved bar item's own `run`, the same closure the writer's click
 * fires — rather than the command it should be pointed at, because the defect was the wiring.
 */
test('the aside group’s message square runs the line note, and pressing it twice restores the bytes', () => {
  const DOC = 'The river rose overnight.\nIt took the low field first.'
  let state = EditorState.create({ doc: DOC, selection: EditorSelection.cursor(3) })
  const view = {
    get state() { return state },
    dispatch: (spec: Parameters<EditorView['dispatch']>[0]) =>
      { state = state.update(spec as Parameters<EditorState['update']>[0]).state },
    focus: () => {},
  } as unknown as EditorView

  // The app's own command surface, resolved the way App resolves it — no stub of the drawn ids.
  const runnable = new Map<string, RunnableCommand>(
    allBindableCommands().map((command): [string, RunnableCommand] => [
      command.id,
      { label: command.label, icon: Bold, run: () => { registryCommand(command.id).run?.(view as never) } },
    ]),
  )
  const items = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: false })
    .flatMap((group) => group.items)
  const button = items.find((item) => item.commandId === 'edit.toggleComment')
  expect(button, 'the drawn message square must resolve to a button').toBeDefined()

  button!.run()
  expect(state.doc.toString()).toBe('// The river rose overnight.\nIt took the low field first.')
  button!.run()
  expect(state.doc.toString()).toBe(DOC) // the exact prior bytes
})

test('the bar draws all sixteen drawn buttons against the app’s own commands', () => {
  const runnable = new Map<string, RunnableCommand>(
    allBindableCommands().map((command): [string, RunnableCommand] => [command.id, stub(command.label)]),
  )
  const groups = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: false })
  expect(groups.map((group) => group.items.length)).toEqual([2, 4, 4, 4, 2])
  expect(groups.reduce((total, group) => total + group.items.length, 0)).toBe(16)
})

test('the numbered-list button carries the List type choices, resolved against the app’s own commands', () => {
  const ran: string[] = []
  const runnable = new Map<string, RunnableCommand>(
    allBindableCommands().map((command): [string, RunnableCommand] => [command.id, { ...stub(command.label), run: () => { ran.push(command.id) } }]),
  )
  const items = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: false }).flatMap((group) => group.items)
  const numbered = items.find((item) => item.commandId === 'list.ordered')!
  expect(numbered.menu?.label).toBe('List type')
  expect(numbered.menu?.items.map((item) => item.label)).toEqual([
    'List type: a. b. c.', 'List type: i. ii. iii.', 'List type: 1. 2. 3.', 'List type: bullet', 'List type: checkboxes',
  ])
  numbered.menu!.items[1].run()
  expect(ran).toEqual(['list.type.roman'])
  // Only that button has a menu, and in Reviewing the choices dim with it.
  expect(items.filter((item) => item.menu).map((item) => item.commandId)).toEqual(['list.ordered'])
  const reviewing = resolveActionBarGroups(DEFAULT_ACTION_BAR_GROUPS, runnable, { reviewing: true }).flatMap((group) => group.items)
  expect(reviewing.find((item) => item.commandId === 'list.ordered')!.menu!.items.every((item) => item.dimmed)).toBe(true)
})
