// The e2e write hooks (held, failed or interleaved writes) are unreachable in a packaged build, whatever
// the environment says (save fix, parcel 1 review S1; parcel 3 for the renderer's hooks).
// docs/plans/saving-over-an-outside-change/document-owner-plan.md
import { expect, test } from 'bun:test'
import {
  E2E_WRITE_HOOKS_ARGUMENT,
  e2eWriteHooksAllowed,
  e2eWriteHooksArguments,
  e2eWriteHooksFromProcess,
} from '../../src/shared/e2e-write-hooks'

const E2E = { WRITEFLEX_E2E: '1' }

test('main allows the write hooks only in an unpackaged build run with WRITEFLEX_E2E=1', () => {
  expect(e2eWriteHooksAllowed(E2E, false)).toBe(true)
  expect(e2eWriteHooksAllowed(E2E, true)).toBe(false)
  expect(e2eWriteHooksAllowed({}, false)).toBe(false)
  expect(e2eWriteHooksAllowed({ WRITEFLEX_E2E: '0' }, false)).toBe(false)
})

test('a packaged window is given no write-hooks argument', () => {
  expect(e2eWriteHooksArguments(E2E, false)).toEqual([E2E_WRITE_HOOKS_ARGUMENT])
  expect(e2eWriteHooksArguments(E2E, true)).toEqual([])
  expect(e2eWriteHooksArguments({}, false)).toEqual([])
})

test('the preload reads the hooks from main\'s argument, never from the environment alone', () => {
  expect(e2eWriteHooksFromProcess(['electron', E2E_WRITE_HOOKS_ARGUMENT], E2E)).toBe(true)
  expect(e2eWriteHooksFromProcess(['electron'], E2E)).toBe(false)
  expect(e2eWriteHooksFromProcess(['electron', E2E_WRITE_HOOKS_ARGUMENT], {})).toBe(false)
})

// The preload as the renderer sees it: `e2eWriteHooks` follows main's argument.
const preloadProbe = (withArgument: boolean): string => String.raw`
  import { mock } from 'bun:test'
  let exposed
  void mock.module('electron', () => ({
    clipboard: { readText: () => '' }, webUtils: { getPathForFile: () => '' },
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } },
    ipcRenderer: { invoke: async () => null, on: () => {}, removeListener: () => {} },
  }))
  void mock.module('@bridle/electron/preload', () => ({ createAuthTransport: () => ({}) }))
  process.env.WRITEFLEX_E2E = '1'
  ${withArgument ? `process.argv.push('${E2E_WRITE_HOOKS_ARGUMENT}')` : ''}
  await import('./src/preload/index.ts')
  console.log(JSON.stringify({ e2eEnabled: exposed.e2eEnabled, e2eWriteHooks: exposed.e2eWriteHooks }))
`

const runProbe = async (source: string, env: Record<string, string> = {}): Promise<Record<string, unknown>> => {
  const child = Bun.spawn([process.execPath, '-e', source], {
    cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env },
  })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`probe failed: ${stderr}`)
  return JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>
}

test('the preload exposes the write hooks only when main passed the argument', async () => {
  expect(await runProbe(preloadProbe(true))).toEqual({ e2eEnabled: true, e2eWriteHooks: true })
  expect(await runProbe(preloadProbe(false))).toEqual({ e2eEnabled: true, e2eWriteHooks: false })
}, 30_000)

// Main's own hook, through the real file:save handler: another program's write between the save and its
// readback (WRITEFLEX_E2E_SAVE_OUTSIDE_WRITE) happens in an unpackaged e2e run and never in a packaged one,
// and a malformed value never stops registration (review S2: parsed when a save asks).
const saveProbe = (isPackaged: boolean): string => String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-e2e-hooks-'))
  process.resourcesPath = root // a packaged main reads its sound pack from here; nothing is read in this probe
  const handlers = new Map()
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: ${isPackaged} },
    clipboard: { write: () => {} }, ipcMain,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({ webContents: { id: 31, send: () => {} }, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  await writeFile(join(root, 'note.md'), 'Seen.\n')
  const saved = await handlers.get('file:save')({ sender: { id: 31 } }, { path: 'note.md', content: 'Mine.\n', basis: { kind: 'disk', text: 'Seen.\n' } })
  console.log(JSON.stringify({ written: saved.written, readback: saved.content, disk: await readFile(join(root, 'note.md'), 'utf8') }))
`

const OUTSIDE_WRITE = { WRITEFLEX_E2E: '1', WRITEFLEX_E2E_SAVE_OUTSIDE_WRITE: JSON.stringify({ 'note.md': 'Outside.\n' }) }

test('file:save\'s outside-write hook runs in an unpackaged e2e run and never in a packaged build (review S1)', async () => {
  expect(await runProbe(saveProbe(false), OUTSIDE_WRITE)).toEqual({ written: 'Mine.\n', readback: 'Outside.\n', disk: 'Outside.\n' })
  expect(await runProbe(saveProbe(true), OUTSIDE_WRITE)).toEqual({ written: 'Mine.\n', readback: 'Mine.\n', disk: 'Mine.\n' })
}, 30_000)

test('a malformed outside-write value does not stop a packaged build registering or saving (review S2)', async () => {
  expect(await runProbe(saveProbe(true), { WRITEFLEX_E2E: '1', WRITEFLEX_E2E_SAVE_OUTSIDE_WRITE: '{not json' }))
    .toEqual({ written: 'Mine.\n', readback: 'Mine.\n', disk: 'Mine.\n' })
}, 30_000)
