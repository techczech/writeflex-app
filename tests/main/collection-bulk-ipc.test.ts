import { expect, test } from 'bun:test'

const probe = String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  import { tmpdir } from 'node:os'
  import { EventEmitter } from 'node:events'
  const root = await mkdtemp(join(tmpdir(), 'wf-collection-bulk-ipc-'))
  const handlers = new Map()
  const sent = []
  const kept = []
  let scans = 0
  mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: {}, dialog: {}, shell: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
  }))
  const collection = await import('./src/main/collection.ts')
  const discover = collection.collectionMoveFolderPieces
  mock.module('./src/main/collection.ts', () => ({ ...collection, collectionMoveFolderPieces: async (...args) => { scans++; return discover(...args) } }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const sender = Object.assign(new EventEmitter(), { id: 71, send: (channel, value) => sent.push([channel, value]) })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  state.agent = null
  state.agentReady = null
  registerIpc({ openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} }, { modelDefaults: () => ({}), recents: () => [] }, {})
  const event = { sender }
  const invoke = (name, value) => handlers.get(name)(event, value)
  try {
    await writeFile(join(root, 'a.md'), '# Original A\n')
    await writeFile(join(root, 'b.md'), '---\ntags: alpha, beta\n---\n# Original B\n')
    await invoke('collection:begin-batch')
    await invoke('collection:set-status', { dir: '', path: 'a.md', status: 'editing' })
    await invoke('collection:add-tags', { dir: '', path: 'b.md', tags: ['new'] })
    const nullWrites = (await readFile(join(root, 'a.md'), 'utf8')).includes('status: editing') && (await readFile(join(root, 'b.md'), 'utf8')).includes('new')
    const before = sent.filter(([channel]) => channel === 'collection:changed').length
    await invoke('collection:end-batch')
    const { SnapshotStore } = await import('@bridle/core')
    const store = await SnapshotStore.open({ dir: join(root, '.bridle') })
    for (const entry of await store.entries()) {
      if (entry.kind === 'snapshot') kept.push([state.workspace.relative(entry.file), await store.readSnapshotContent(entry.id)])
    }
    await invoke('collection:begin-batch')
    state.agentReady = Promise.reject(new Error('Choose a model to continue.'))
    state.agentReady.catch(() => {})
    await invoke('collection:set-status', { dir: '', path: 'a.md', status: 'final' })
    await invoke('collection:add-tags', { dir: '', path: 'b.md', tags: ['rejected-ready'] })
    const rejectedWrites = (await readFile(join(root, 'a.md'), 'utf8')).includes('status: final') && (await readFile(join(root, 'b.md'), 'utf8')).includes('rejected-ready')
    await invoke('collection:end-batch')
    const changes = sent.filter(([channel]) => channel === 'collection:changed').length
    const queries = sent.filter(([channel]) => channel === 'collection:query-changed').length
    // Kept bytes really restore the two pre-write documents.
    for (const [path, content] of kept) await state.workspace.saveFile(path, content)
    const restored = await readFile(join(root, 'b.md'), 'utf8')
    await mkdir(join(root, '.archive'))
    let refusedHidden = false
    try { await invoke('file:move', { path: 'a.md', newPath: '.archive/a.md', collectionDir: '' }) }
    catch (error) { refusedHidden = error.message.includes('existing visible folder') }
    state.agentReady = null
    await mkdir(join(root, 'destination'))
    await invoke('collection:begin-batch')
    await invoke('file:move', { path: 'a.md', newPath: 'destination/a.md', collectionDir: '' })
    await invoke('file:move', { path: 'b.md', newPath: 'destination/b.md', collectionDir: '' })
    await invoke('collection:end-batch')
    await invoke('collection:begin-batch')
    sender.emit('did-start-loading')
    const recovered = sent.filter(([channel]) => channel === 'collection:changed').length === changes + 2
    console.log(JSON.stringify({ before, changes, queries, kept, restored, refusedHidden, recovered, nullWrites, rejectedWrites, scans }))
  } finally { await rm(root, { recursive: true, force: true }) }
`

test('bulk IPC keeps per-file checkpoints, coalesces refreshes, rejects hidden moves and recovers after reload', async () => {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`Collection bulk unit probe failed: ${stderr}`)
  expect(JSON.parse(stdout)).toEqual({
    before: 0, changes: 2, queries: 2,
    kept: [['a.md', '# Original A\n'], ['b.md', '---\ntags: alpha, beta\n---\n# Original B\n']],
    restored: '---\ntags: alpha, beta\n---\n# Original B\n',
    refusedHidden: true, recovered: true, nullWrites: true, rejectedWrites: true, scans: 1,
  })
})
