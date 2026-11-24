import { afterEach, expect, test } from 'bun:test'
import { e2eHidden, focusAnyWindow, focusWindow, openMain } from '../../src/main/window-presentation'

const original = process.env.WRITEFLEX_E2E
afterEach(() => {
  if (original === undefined) delete process.env.WRITEFLEX_E2E
  else process.env.WRITEFLEX_E2E = original
})

function fakeWindow({ destroyed = false, minimized = false } = {}) {
  const calls: string[] = []
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => { calls.push('isMinimized'); return minimized },
    show: () => { calls.push('show') },
    focus: () => { calls.push('focus') },
    restore: () => { calls.push('restore') },
  }
}

for (const flag of [undefined, '', '0', 'false', 'true', '1']) {
  test(`hidden mode requires WRITEFLEX_E2E=1, given ${JSON.stringify(flag)}`, () => {
    expect(e2eHidden(flag === undefined ? {} : { WRITEFLEX_E2E: flag })).toBe(flag === '1')
  })
}

for (const hidden of [false, true]) {
  test(`Settings openMain ${hidden ? 'stays hidden' : 'shows and focuses'} at invocation time`, () => {
    process.env.WRITEFLEX_E2E = hidden ? '1' : '0'
    const window = fakeWindow()
    openMain(window)
    expect(window.calls).toEqual(hidden ? [] : ['show', 'focus'])
  })

  test(`native focus ${hidden ? 'is suppressed' : 'is preserved'}`, () => {
    process.env.WRITEFLEX_E2E = hidden ? '1' : '0'
    const window = fakeWindow()
    focusWindow(window)
    expect(window.calls).toEqual(hidden ? [] : ['focus'])
  })

  for (const minimized of [false, true]) {
    test(`second-instance focusAnyWindow: hidden=${hidden}, minimised=${minimized}`, () => {
      process.env.WRITEFLEX_E2E = hidden ? '1' : '0'
      const window = fakeWindow({ minimized })
      focusAnyWindow([window, fakeWindow()])
      expect(window.calls).toEqual(hidden ? [] : ['isMinimized', ...(minimized ? ['restore'] : []), 'focus'])
    })
  }
}

test('destroyed windows and an empty window list cause no presentation calls', () => {
  process.env.WRITEFLEX_E2E = '0'
  const window = fakeWindow({ destroyed: true })
  openMain(window)
  focusWindow(window)
  focusAnyWindow([window])
  focusAnyWindow([])
  expect(window.calls).toEqual([])
})

// The real Settings adapter is loaded with Electron and the Bridle frame faked in an
// isolated unit-test child, so no app or native window can be created.
test('Settings frame openMain uses the guard and still dispatches editor commands', async () => {
  const probe = String.raw`
    import { mock } from 'bun:test'
    import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
    mock.module('electron', () => ({
      ...electronMainStandIn,
      app: { isPackaged: false }, dialog: {}, shell: {},
      ipcMain: { handle() {}, removeHandler() {} },
    }))
    let options
    mock.module('@app-patterns/settings-electron/main', () => ({
      installSettingsWith(_deps, opts) { options = opts; return {} },
    }))
    const { installSettingsHost } = await import('./src/main/settings-host.ts')
    const results = []
    for (const hidden of [false, true]) {
      process.env.WRITEFLEX_E2E = hidden ? '1' : '0'
      const calls = []
      const window = {
        isDestroyed: () => false,
        show: () => calls.push('show'), focus: () => calls.push('focus'),
        webContents: { send: (...args) => calls.push(args) },
      }
      installSettingsHost({
        shared: { store: { view: () => ({ settings: {} }) }, onStoreChanged() {} },
        slots: {}, mainWindow: () => window, runMain() {}, recentItems: () => [], log() {},
      })
      options.openMain()
      options.sendCommand('edit.bold')
      results.push({ showOnReady: options.window.showOnReady, calls })
    }
    console.log(JSON.stringify(results))
  `
  const child = Bun.spawn([process.execPath, '-e', probe], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(`Settings host unit probe failed: ${stderr}`)
  expect(JSON.parse(stdout.trim())).toEqual([
    { showOnReady: true, calls: ['show', 'focus', ['menu:command', 'edit.bold']] },
    { showOnReady: false, calls: [['menu:command', 'edit.bold']] },
  ])
}, 20_000)
