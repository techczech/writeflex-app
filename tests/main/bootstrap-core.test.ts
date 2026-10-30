import { expect, test } from 'bun:test'
import { packagedSmokeRequested } from '../../src/main/packaged-smoke'
import {
  installSmokeDialogGuard, installSmokeFatalHandlers, isSmokeMode, loadMain, MAIN_LOAD_FAILED_MARKER, SMOKE_DIALOG_MARKER,
  type BootstrapDependencies,
} from '../../src/main/bootstrap-core'

const SMOKE = { WRITEFLEX_E2E: '1', WRITEFLEX_E2E_SMOKE: '1' }

function harness(env: Record<string, string>, isPackaged: boolean, importer: () => Promise<unknown>) {
  const calls = { boxes: [] as string[], exits: [] as number[], stderr: '' }
  const dependencies: BootstrapDependencies = {
    env, importer, isPackaged,
    exit: (code) => { calls.exits.push(code) },
    showErrorBox: (title, content) => { calls.boxes.push(`${title}: ${content}`) },
    writeStderr: (text) => { calls.stderr += text },
  }
  return { calls, dependencies }
}
const failing = () => Promise.reject(new Error("Cannot find package '@readflex/x' (ERR_MODULE_NOT_FOUND)"))

test('smoke mode: load failure prints the marker, exits 1, shows no dialog', async () => {
  const { calls, dependencies } = harness(SMOKE, true, failing)
  await loadMain(dependencies)
  expect(calls.stderr).toContain(MAIN_LOAD_FAILED_MARKER)
  expect(calls.stderr).toContain('ERR_MODULE_NOT_FOUND')
  expect(calls.exits).toEqual([1])
  expect(calls.boxes).toEqual([])
})

test('normal mode: load failure shows an error box and exits 1', async () => {
  const { calls, dependencies } = harness({}, true, failing)
  await loadMain(dependencies)
  expect(calls.boxes[0]).toContain('WriteFlex could not start')
  expect(calls.stderr).toBe('')
  expect(calls.exits).toEqual([1])
})

test('an unpackaged e2e launch is protected: marker and exit, no dialog', async () => {
  const { calls, dependencies } = harness({ WRITEFLEX_E2E: '1' }, false, failing)
  await loadMain(dependencies)
  expect(calls.stderr).toContain(MAIN_LOAD_FAILED_MARKER)
  expect(calls.boxes).toEqual([])
  expect(calls.exits).toEqual([1])
})

test('a plain unpackaged dev run with no variables is unchanged: error box', async () => {
  expect(isSmokeMode({}, false)).toBe(false)
  const { calls, dependencies } = harness({}, false, failing)
  await loadMain(dependencies)
  expect(calls.boxes).toHaveLength(1)
  expect(calls.stderr).toBe('')
})

test('a successful load does nothing', async () => {
  const { calls, dependencies } = harness(SMOKE, true, () => Promise.resolve({}))
  await loadMain(dependencies)
  expect(calls.exits).toEqual([])
})

test('smoke fatal handlers print the marker and exit; they are not installed otherwise', () => {
  const listeners: Record<string, (e: unknown) => void> = {}
  const emitter = { on: (event: string, l: (e: unknown) => void) => { listeners[event] = l } }
  installSmokeFatalHandlers(emitter, harness({}, true, failing).dependencies)
  expect(Object.keys(listeners)).toEqual([])
  const on = harness(SMOKE, true, failing)
  installSmokeFatalHandlers(emitter, on.dependencies)
  listeners.unhandledRejection!(new Error('boom'))
  expect(on.calls.stderr).toContain(MAIN_LOAD_FAILED_MARKER)
  expect(on.calls.exits).toEqual([1])
})

test('smoke dialog guard: any dialog call prints a marker and exits; off in normal mode', async () => {
  const original = () => 'real'
  const normal = { showMessageBox: original }
  installSmokeDialogGuard(normal, harness({}, true, failing).dependencies)
  expect(normal.showMessageBox).toBe(original)
  const guarded: Record<string, unknown> = { showMessageBox: original }
  const on = harness(SMOKE, true, failing)
  installSmokeDialogGuard(guarded, on.dependencies)
  await (guarded.showMessageBox as () => Promise<unknown>)()
  ;(guarded.showErrorBox as () => void)()
  expect(on.calls.stderr).toContain(SMOKE_DIALOG_MARKER)
  expect(on.calls.exits).toEqual([1, 1])
})

test('every packaged smoke is an automated launch (the bootstrap condition covers packaged-smoke.ts)', () => {
  for (const env of [{}, { WRITEFLEX_E2E: '1' }, { WRITEFLEX_E2E_SMOKE: '1' }, SMOKE, { WRITEFLEX_E2E: '0', WRITEFLEX_E2E_SMOKE: '1' }]) {
    if (packagedSmokeRequested(env)) expect(isSmokeMode(env, true)).toBe(true)
  }
  expect(isSmokeMode({ WRITEFLEX_E2E_SMOKE: '1' }, true)).toBe(false)
})
