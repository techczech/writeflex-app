import { expect, test } from 'bun:test'

// Isolate Electron/Core mocks from the rest of Bun's suite, as in plan-main-ipc-wiring.
const probe = String.raw`
  import { expect, mock } from 'bun:test'
  import { mkdtemp, rm } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const core = await import('@bridle/core')
  const root = await mkdtemp(join(tmpdir(), 'writeflex-model-catalogue-'))
  const handlers = new Map()
  const sent = []
  let listener, last = null, calls = 0, release, forwarded
  const refreshOptions = []
  const choice = { provider: 'openai-codex', id: 'discovered', name: 'Discovered', secretDescriptor: 'main-only' }
  const models = { all: [choice], available: [choice] }
  const service = {
    list: () => models,
    refresh: async () => models,
    lastDiscovery: () => last,
    refreshWithOutcome: () => { throw new Error('picker opens go through refreshModels') },
    // Bridle owns the freshness rule (fix 04); main passes options through and never reads a clock.
    refreshModels: (opts) => { calls++; refreshOptions.push(opts ?? null); return new Promise(resolve => { release = resolve }) },
    onChange: fn => { listener = fn; return () => { listener = undefined } },
  }
  mock.module('@bridle/core', () => ({ ...core, createModelService: () => service,
    createBridle: async opts => { forwarded = opts; throw new Error('captured options') },
  }))
  mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => 'test', isPackaged: false },
    clipboard: {}, dialog: {}, shell: {},
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
  }))
  const { registerIpc } = await import('./src/main/ipc.ts')
  const { registerWindow } = await import('./src/main/state.ts')
  registerWindow({ webContents: { id: 7, send: (channel, payload) => sent.push({ channel, payload }) }, on: () => {}, isDestroyed: () => false })
  const registration = registerIpc({}, { modelDefaults: () => ({}), recents: () => [] }, {})
  await Promise.resolve()
  if (process.argv[1] === 'forward') {
    const { WorkspaceAgent } = await import('./src/main/agent.ts')
    const { Workspace } = await import('./src/main/workspace.ts')
    const auth = core.BridleAuth.inMemory()
    await WorkspaceAgent.create({ workspace: new Workspace(root), appDataDir: root, auth, modelService: service,
      onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
    }).catch(error => { expect(error.message).toBe('captured options') })
    expect(forwarded.modelService).toBe(service)
    expect(forwarded.auth).toBe(auth)
  } else {
    expect(typeof listener).toBe('function')
    for (const discovery of ['succeeded', 'failed', 'skipped']) {
      sent.length = 0
      const reason = discovery === 'failed' ? 'offline' : discovery === 'skipped' ? 'not-signed-in' : undefined
      last = { at: 123, discovery, ...(reason ? { reason } : {}) }
      listener(models, { models, discovery, reason, at: 123 })
      expect(sent).toEqual([{ channel: 'agent:models-changed', payload: {
        catalogue: [{ provider: choice.provider, id: choice.id, name: choice.name }],
        models: [{ provider: choice.provider, id: choice.id, name: choice.name }],
        discovery, ...(reason ? { reason } : {}), at: 123,
        modelsChecked: last,
        modelNotice: discovery === 'failed' ? 'Model refresh failed: offline.' : null,
      } }])
      const initial = await handlers.get('agent:state')({ sender: { id: 7 } })
      expect(initial.modelNotice).toBe(discovery === 'failed' ? 'Model refresh failed: offline.' : null)
      expect(initial.modelsChecked).toEqual(last)
      expect(initial.models).toEqual(sent[0].payload.models)
    }
    const opened = handlers.get('agent:models-picker-opened')
    expect(typeof opened).toBe('function')
    // Every burst of opens asks Bridle once, unforced, even right after a check: Bridle decides freshness.
    for (const recent of [null, { at: Date.now(), discovery: 'succeeded' }]) {
      last = recent
      const before = calls
      const first = opened({ sender: { id: 7 } })
      const second = opened({ sender: { id: 7 } })
      await Promise.resolve()
      expect(calls).toBe(before + 1)
      expect(refreshOptions.at(-1)).toBeNull()
      release({ ...(last ?? { at: 1, discovery: 'succeeded' }), models, throttled: last !== null, reused: false, providers: {} })
      await Promise.all([first, second])
    }
    // "Refresh models" forces the refresh and answers with the diff and the last-checked time.
    const refresh = handlers.get('agent:models-refresh')
    expect(typeof refresh).toBe('function')
    // Only a registered WriteFlex window may trigger discovery; an unknown sender asks no provider.
    const callsBeforeStranger = calls
    await expect(refresh({ sender: { id: 99 } })).rejects.toThrow('No window state for this renderer.')
    await expect(opened({ sender: { id: 99 } })).rejects.toThrow('No window state for this renderer.')
    expect(calls).toBe(callsBeforeStranger)
    const pending = refresh({ sender: { id: 7 } })
    await Promise.resolve()
    expect(refreshOptions.at(-1)).toEqual({ force: true })
    release({ at: 456, discovery: 'succeeded', models, throttled: false, reused: false,
      providers: { 'openai-codex': { provider: 'openai-codex', discovery: 'succeeded', added: ['a', 'b', 'c'], removed: [], checkedAt: 456 } } })
    expect(await pending).toEqual({ status: 'updated', added: ['a', 'b', 'c'], removed: [], checked: { at: 456, discovery: 'succeeded' } })
    const failing = refresh({ sender: { id: 7 } })
    await Promise.resolve()
    release({ at: 789, discovery: 'failed', reason: 'empty-catalogue', models, throttled: false, reused: false,
      providers: { 'openai-codex': { provider: 'openai-codex', discovery: 'failed', reason: 'empty-catalogue', added: [], removed: [], checkedAt: 456 } } })
    expect(await failing).toEqual({ status: 'failed', added: [], removed: [], reason: 'empty-catalogue', checked: { at: 789, discovery: 'failed', reason: 'empty-catalogue' } })
    registration.dispose()
    expect(listener).toBeUndefined()
    expect(handlers.has('agent:models-picker-opened')).toBe(false)
    expect(handlers.has('agent:models-refresh')).toBe(false)
  }
  await rm(root, { recursive: true, force: true })
`

for (const mode of ['events', 'forward']) {
  test(`shared model service ${mode} through real main seams`, async () => {
    const child = Bun.spawn([process.execPath, '-e', probe, mode], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  })
}
