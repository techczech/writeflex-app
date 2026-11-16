// The main-process half of the registry-generated menu: what receiveCommandMenu accepts, which window's
// model may rebuild the bar, and what a click does when the focused window has published nothing.
// Runs menu.ts in a child process with a minimal electron stand-in (the repo's probe pattern).
import { expect, test } from 'bun:test'

const probe = String.raw`
  import { mock } from 'bun:test'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
  let focused = null
  let setCalls = 0
  let minimised = false
  mock.module('electron', () => ({
    ...electronMainStandIn,
    BrowserWindow: { getFocusedWindow: () => focused, getAllWindows: () => [] },
    Menu: { setApplicationMenu: () => { setCalls++ }, buildFromTemplate: template => template },
    dialog: {},
  }))
  const [menu, { registerWindow }] = await Promise.all([import('./src/main/menu.ts'), import('./src/main/state.ts')])
  const makeWindow = id => {
    const sent = []
    const listeners = {}
    const ignored = []
    const contents = { id, setIgnoreMenuShortcuts: value => ignored.push(value), send: (channel, value) => sent.push([channel, value]), on: (event, listener) => { listeners[event] = listener }, once: () => {} }
    const window = { webContents: contents, on: () => {}, isDestroyed: () => false, isFullScreen: () => false, isMinimized: () => minimised }
    registerWindow(window)
    return { window, contents, sent, listeners, ignored }
  }
  const entry = (id, extra = {}) => ({ id, label: id, task: 'Write', subgroup: 'Format', enabled: true, ...extra })
  const created = []
  const manager = { createWindow: () => created.push('window'), openFolder: async () => {}, openFile: async () => {} }
  let recentRoots = []
  const settings = { pinned: () => [], recents: () => recentRoots.map(root => ({ root })) }
  const ids = items => items.flatMap(item => [item.id, ...ids(item.submenu ?? [])]).filter(Boolean)
  const a = makeWindow(1)
  const b = makeWindow(2)
  const out = {}
  const attempt = (name, commands) => { try { menu.receiveCommandMenu(a.contents, commands); out[name] = 'accepted' } catch (error) { out[name] = 'refused' } }
  menu.buildAppMenu(manager, settings)

  attempt('longLabel', [entry('edit.bold', { label: 'x'.repeat(201) })])
  attempt('edgeLabel', [entry('edit.bold', { label: 'x'.repeat(200) })])
  attempt('foreignNative', [entry('edit.bold', { nativeAccelerator: true })])
  attempt('realNative', [entry('file.new', { nativeAccelerator: true })])
  focused = a.window
  menu.receiveCommandMenu(a.contents, [entry('edit.bold'), entry('not.a.command'), entry('edit.italic')])
  out.liveIds = ids(menu.buildAppMenu(manager, settings)).filter(id => id.startsWith('edit.') || id.startsWith('not.'))

  // Rebuilds: only a change of the focused window's model rebuilds the bar.
  setCalls = 0
  menu.receiveCommandMenu(b.contents, [entry('edit.bold')])
  out.backgroundRebuilds = setCalls
  menu.receiveCommandMenu(a.contents, [entry('edit.bold')])
  out.focusedRebuilds = setCalls
  menu.receiveCommandMenu(a.contents, [entry('edit.bold')])
  menu.updateCollectionMenu()
  out.unchangedRebuilds = setCalls - out.focusedRebuilds

  menu.receiveCommandMenu(a.contents, [entry('edit.bold', { chord: '⌘B' }), entry('view.proseIncrease', { chord: '⌘+' })])
  const input = extra => ({ type: 'keyDown', key: 'b', code: 'KeyB', meta: true, control: false, alt: false, shift: false, ...extra })
  a.listeners['before-input-event']({}, input({}))
  a.listeners['before-input-event']({}, input({ key: 'q', code: 'KeyQ' }))
  a.listeners['before-input-event']({}, input({ key: '+', code: 'Equal', shift: true }))
  out.ignored = a.ignored
  menu.receiveCommandMenu(a.contents, [entry('edit.selectBodyExceptMetadata', { chord: '⌘A' }), entry('edit.redo', { chord: '⇧⌘Z' }), entry('review.switchMarginView', { chord: '⇧⌥⌘V' })], 'plain-text-field')
  for (const extra of [{ key: 'a', code: 'KeyA' }, { key: 'z', code: 'KeyZ', shift: true }, { key: 'v', code: 'KeyV', shift: true, alt: true }]) a.listeners['before-input-event']({}, input(extra))
  out.plainRoleIgnored = a.ignored.slice(-3)
  menu.receiveCommandMenu(a.contents, [entry('edit.selectBodyExceptMetadata', { chord: '⌘A' }), entry('edit.redo', { chord: '⇧⌘Z' }), entry('review.switchMarginView', { chord: '⇧⌥⌘V' })], 'editor')
  for (const extra of [{ key: 'a', code: 'KeyA' }, { key: 'z', code: 'KeyZ', shift: true }, { key: 'v', code: 'KeyV', shift: true, alt: true }]) a.listeners['before-input-event']({}, input(extra))
  out.editorRoleIgnored = a.ignored.slice(-3)
  // A rebind changes which input bypasses native menu dispatch.
  menu.receiveCommandMenu(a.contents, [entry('edit.bold', { chord: '⌃⌥B' })])
  a.listeners['before-input-event']({}, input({}))
  a.listeners['before-input-event']({}, input({ meta: false, control: true, alt: true }))
  out.reboundIgnored = a.ignored.slice(-2)

  recentRoots = ['/Work/Notes']
  const recentA = menu.buildAppMenu(manager, settings)
  recentRoots = ['/Home/Notes']
  const recentB = menu.buildAppMenu(manager, settings)
  out.recentPathRebuild = recentA !== recentB
  // The test model needs the Open Recent command to inspect the dynamic submenu.
  menu.receiveCommandMenu(a.contents, [entry('app.openRecent')])
  recentRoots = ['/Work/Notes', '/Home/Notes']
  const recentTree = menu.buildAppMenu(manager, settings)
  out.recentLabels = recentTree.flatMap(item => item.submenu ?? []).find(item => item.id === 'app.openRecent')?.submenu?.map(item => item.label)
  menu.receiveCommandMenu(a.contents, [entry('edit.bold', { chord: '⌃⌥B' })])

  // A click with no model for the focused window does only what main can do alone.
  focused = b.window
  menu.receiveCommandMenu(b.contents, [])
  menu.runMenuClick('file.checkpoint', manager)
  menu.runMenuClick('window.new', manager)
  out.noModelSent = b.sent
  focused = a.window
  menu.runMenuClick('edit.bold', manager)
  out.withModelSent = a.sent
  focused = null
  minimised = true
  const flatNoFocus = items => items.flatMap(item => [item, ...flatNoFocus(item.submenu ?? [])])
  out.noFocus = Object.fromEntries(flatNoFocus(menu.buildAppMenu(manager, settings)).filter(item => item.id).map(item => [item.id, item.enabled]))
  const before = a.sent.length
  menu.runMenuClick('edit.bold', manager)
  out.noFocusSends = a.sent.length - before
  focused = a.window
  minimised = false
  // Before any model exists the bar still offers the native commands, enabled for an existing window.
  menu.receiveCommandMenu(a.contents, [])
  menu.receiveCommandMenu(b.contents, [])
  const seeded = menu.buildAppMenu(manager, settings)
  const flat = items => items.flatMap(item => [item, ...flat(item.submenu ?? [])])
  out.seed = Object.fromEntries(flat(seeded).filter(item => ['file.new', 'window.new', 'app.open', 'file.checkpoint', 'tab.close', 'view.developerTools'].includes(item.id)).map(item => [item.id, item.enabled]))
  out.noModelCreated = created.length
  console.log(JSON.stringify(out))
`

test('main validates the published menu, rebuilds only for the focused window, and handles clicks with no model', async () => {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`The menu probe failed: ${stderr}`)
  const out = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(out.ignored.slice(0, 3)).toEqual([true, false, true])
  expect(out.reboundIgnored).toEqual([false, true])
  expect(out.recentPathRebuild).toBe(true)
  expect(out.recentLabels).toEqual(['Notes — Work', 'Notes — Home'])
  expect(out.longLabel).toBe('refused')
  expect(out.edgeLabel).toBe('accepted')
  expect(out.foreignNative).toBe('refused')
  expect(out.realNative).toBe('accepted')
  // Ids that are not registry commands never reach the bar.
  expect(out.liveIds).toEqual(['edit.bold', 'edit.italic'])
  expect(out.unchangedRebuilds).toBe(0)
  expect(out.plainRoleIgnored).toEqual([false, false, false])
  expect(out.editorRoleIgnored).toEqual([true, true, true])
  expect(out.noFocus['edit.bold']).toBe(false)
  expect(out.noFocusSends).toBe(0)
  expect(out.backgroundRebuilds).toBe(0)
  expect(out.focusedRebuilds).toBe(1)
  // A click with no model still reaches the window for the operations main owns (Checkpoint is native-keyed), and New Window needs no window.
  expect(out.noModelSent).toEqual([['menu:action', 'save']])
  expect(out.seed).toEqual({ 'file.new': true, 'window.new': true, 'app.open': true, 'file.checkpoint': true, 'tab.close': true, 'view.developerTools': true })
  expect(out.noModelCreated).toBe(1)
  expect(out.withModelSent).toEqual([['menu:command', 'edit.bold']])
})
