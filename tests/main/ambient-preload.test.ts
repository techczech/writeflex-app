import { expect, test } from 'bun:test'

test('typed ambient preload publishes the whole snapshot through ambient:set', async () => {
  const probe = String.raw`
    import { mock } from 'bun:test'
    let api; const calls = []
    mock.module('electron', () => ({ clipboard: { readText: () => '' }, webUtils: { getPathForFile: () => '' }, contextBridge: { exposeInMainWorld: (_, value) => { api = value } }, ipcRenderer: { invoke: async (...args) => { calls.push(args) }, on() {}, removeListener() {} } }))
    mock.module('@bridle/electron/preload', () => ({ createAuthTransport: () => ({}) }))
    await import('./src/preload/index.ts')
    const snapshot = { workspaceRoot: '/writing', activeFile: null, mode: null, selection: null, process: null, recency: {} }
    await api.setAmbient(snapshot)
    console.log(JSON.stringify(calls))
  `
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(err).toBe(''); expect(code).toBe(0)
  expect(JSON.parse(out)).toEqual([['ambient:set', { workspaceRoot: '/writing', activeFile: null, mode: null, selection: null, process: null, recency: {} }]])
})
