import { expect, test } from 'bun:test'

const probe = String.raw`
  import { mock } from 'bun:test'
  import { electronMainStandIn, settingsForIpcTest } from './tests/helpers/electron-main-stand-in.ts'
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
    ...electronMainStandIn,
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
  registerIpc({ openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} }, await settingsForIpcTest(root), {})
  const { addCollectionTagsFlushed, runCollectionBatch } = await import('./src/renderer/src/app/collection-bulk.ts')
  const { createDocumentOwner } = await import('./src/renderer/src/app/document-owner.ts')
  const { createUnsavedRegistry } = await import('./src/renderer/src/app/unsaved-registry.ts')
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
    await writeFile(join(root, 'c.md'), '# Original C\n')
    let buffer = '# Original D\n'
    await writeFile(join(root, 'd.md'), buffer)
    const owner = createDocumentOwner({
      buffer: path => path === 'd.md' ? buffer : null,
      notice: () => undefined,
      registry: createUnsavedRegistry(),
      write: (path, text, basis) => state.workspace.saveFileOver(path, text, basis),
      replaceBuffer: (_path, text) => { buffer = text },
      forgetBuffer: () => {},
      dirtyChanged: () => {},
      setReadOnly: () => {},
      report: { slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {}, saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {} },
    })
    owner.activated('d.md', buffer, () => buffer)

    const readC = Promise.withResolvers()
    const resumeC = Promise.withResolvers()
    const readD = Promise.withResolvers()
    const resumeD = Promise.withResolvers()
    const readFileFromWorkspace = state.workspace.readFile.bind(state.workspace)
    state.workspace.readFile = async path => {
      const source = await readFileFromWorkspace(path)
      if (path === 'c.md') {
        readC.resolve()
        await resumeC.promise
      } else if (path === 'd.md') {
        readD.resolve()
        await resumeD.promise
      }
      return source
    }

    let written
    const addTags = async (dir, path, tags) => {
      const saved = await invoke('collection:add-tags', { dir, path, tags })
      if (path === 'd.md') written = saved.written
      return saved
    }
    await invoke('collection:begin-batch')
    const batch = runCollectionBatch(['c.md', 'd.md'], path =>
      addCollectionTagsFlushed(owner, addTags, '', path, ['batch-tag']))
    await readC.promise
    try {
      await writeFile(join(root, 'c.md'), '# Newer C\n')
    } finally {
      resumeC.resolve()
    }

    await readD.promise
    try {
      buffer += '\nTyped during tagging.\n'
      owner.edited('d.md', buffer)
    } finally {
      resumeD.resolve()
    }
    const partial = await batch
    await invoke('collection:end-batch')
    const refusedText = await readFile(join(root, 'c.md'), 'utf8')
    const succeededText = await readFile(join(root, 'd.md'), 'utf8')
    console.log(JSON.stringify({ before, changes, queries, kept, restored, refusedHidden, recovered, nullWrites, rejectedWrites, scans,
      partial, refusedText, succeededText, written, buffer, saved: owner.isSaved('d.md') }))
  } finally { await rm(root, { recursive: true, force: true }) }
`

test('bulk IPC keeps per-file checkpoints, coalesces refreshes, rejects hidden moves and recovers after reload', async () => {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`Collection bulk unit probe failed: ${stderr}`)
  const { partial, refusedText, succeededText, written, buffer, saved, ...original } = JSON.parse(stdout)
  expect(original).toEqual({
    before: 0, changes: 2, queries: 2,
    kept: [['a.md', '# Original A\n'], ['b.md', '---\ntags: alpha, beta\n---\n# Original B\n']],
    restored: '---\ntags: alpha, beta\n---\n# Original B\n',
    refusedHidden: true, recovered: true, nullWrites: true, rejectedWrites: true, scans: 1,
  })
  expect(partial).toEqual({
    succeeded: ['d.md'],
    failed: ['c.md'],
    message: 'Changed 1 of 2. c.md was not changed: This document changed on disk. Review the disk changes, then try adding the tags again.',
  })
  expect(refusedText).toBe('# Newer C\n')
  expect(succeededText).toContain('batch-tag')
  expect(succeededText).toEndWith('# Original D\n')
  expect(written).toBe(succeededText)
  expect(buffer).toBe('# Original D\n\nTyped during tagging.\n')
  expect(saved).toBe(false)
})
