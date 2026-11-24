/**
 * The one test that boots the real IPC layer for the rename doors: each channel reaches rename-doors.ts, and the
 * Collection's multi-select move (collection:begin-batch, one file:move per document, collection:end-batch) keeps
 * the links between documents moved together. Everything else about the doors is tested in-process
 * (rename-doors.test.ts).
 */
import { expect, test } from 'bun:test'

const probe = String.raw`
  import { mock } from 'bun:test'
  import { electronMainStandIn, settingsForIpcTest } from './tests/helpers/electron-main-stand-in.ts'
  import { EventEmitter } from 'node:events'
  import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-rename-doors-ipc-'))
  const handlers = new Map()
  const sent = []
  const checkpoints = []
  let failCheckpoint = false
  void mock.module('electron', () => ({
    ...electronMainStandIn,
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} }, dialog: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) },
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const sender = Object.assign(new EventEmitter(), { id: 17, send: (channel, payload) => sent.push([channel, payload]) })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  state.agentReady = Promise.resolve({ checkpointFile: async (path) => {
    checkpoints.push(path)
    if (failCheckpoint) throw new Error('injected repair checkpoint failure')
  } })
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    await settingsForIpcTest(root),
    {},
  )
  const invoke = (channel, input) => handlers.get(channel)({ sender }, input)
  const read = (rel) => readFile(join(root, rel), 'utf8')
  try {
    await mkdir(join(root, 'archive'), { recursive: true })
    await writeFile(join(root, 'old.md'), 'Body.\n')
    await writeFile(join(root, 'ref.md'), 'See [[old]].\n')
    const preview = await invoke('file:rename-repair-paths', { path: 'old.md', newName: 'new.md' })
    const renamed = await invoke('file:rename', { path: 'old.md', newPath: preview.newPath })
    const movedToFolder = await invoke('file:move', { path: 'new.md', newPath: 'archive/new.md' })
    const movedToRoot = await invoke('file:move', { path: 'archive/new.md', newPath: 'back.md' })
    // A checkpoint that fails: the rename is made and the repair comes back as a warning.
    failCheckpoint = true
    await writeFile(join(root, 'broken-old.md'), 'Body.\n')
    await writeFile(join(root, 'broken-ref.md'), 'See [[broken-old]].\n')
    const broken = await invoke('file:rename', { path: 'broken-old.md', newPath: 'broken-new.md' })
    failCheckpoint = false
    // A window with no agent: the folder rename repairs its running-order link without a checkpoint.
    state.agent = null
    state.agentReady = null
    await mkdir(join(root, 'book', 'contents'), { recursive: true })
    await writeFile(join(root, 'book', 'contents', 'a.md'), '# Alpha\n')
    await writeFile(join(root, 'book', '_book_INDEX.md'), '# book\n\n## Running order\n\n- [[./contents/a]]\n')
    const folder = await invoke('folder:rename', { path: 'book/contents', newName: 'chapters' })
    const doors = {
      preview, renamed: renamed.file.path, movedToFolder: movedToFolder.file.path, movedToRoot: movedToRoot.file.path,
      broken: { path: broken.file.path, repair: broken.repair, ref: await read('broken-ref.md'), target: await read('broken-new.md') },
      folder, ref: await read('ref.md'), index: await read('book/_book_INDEX.md'), checkpoints: [...checkpoints],
      changedOnDisk: sent.filter(([channel]) => channel === 'file:changed-on-disk').map(([, paths]) => paths),
    }

    // The Collection's multi-select move: two documents that link to each other moved into one folder.
    await mkdir(join(root, 'dest'), { recursive: true })
    await writeFile(join(root, 'a.md'), 'See [b](b.md#top).\n')
    await writeFile(join(root, 'b.md'), '# Top\n\nBack to [a](./a.md).\n')
    await invoke('collection:begin-batch')
    for (const path of ['a.md', 'b.md']) await invoke('file:move', { path, newPath: 'dest/' + path, collectionDir: '' })
    await invoke('collection:end-batch')
    const batch = { a: await read('dest/a.md'), b: await read('dest/b.md') }
    console.log(JSON.stringify({ doors, batch }))
  } finally { await rm(root, { recursive: true, force: true }) }
`

let pending: Promise<{ doors: Record<string, unknown>; batch: { a: string; b: string } }> | undefined
const run = () => pending ??= (async () => {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`The rename doors IPC probe failed: ${stderr}`)
  return JSON.parse(stdout.trim().split('\n').at(-1)!)
})()

test('file:rename, file:move (to a folder and to the root) and folder:rename reach the rename doors, with and without an agent', async () => {
  const { doors } = await run()
  expect(doors).toEqual({
    preview: { newPath: 'new.md', repairPaths: ['ref.md'] },
    renamed: 'new.md',
    movedToFolder: 'archive/new.md',
    movedToRoot: 'back.md',
    broken: {
      path: 'broken-new.md',
      repair: {
        writtenPaths: [],
        unrepairedReferences: ['broken-ref.md: [[broken-old]]'],
        issues: [
          { kind: 'reference', text: 'broken-ref.md: [[broken-old]]' },
          { kind: 'file', text: 'broken-ref.md' },
          { kind: 'reason', text: expect.stringContaining('injected repair checkpoint failure') },
        ],
      },
      ref: 'See [[broken-old]].\n',
      target: 'Body.\n',
    },
    folder: { path: 'book/chapters', repair: { writtenPaths: ['book/_book_INDEX.md'], unrepairedReferences: [], receipts: [expect.objectContaining({ path: 'book/_book_INDEX.md' })] } },
    ref: 'See [[back]].\n',
    index: '# book\n\n## Running order\n\n- [[./chapters/a]]\n',
    // The move into archive/ leaves [[new]] naming the same file: nothing to repair, nothing checkpointed. The
    // failed checkpoint is tried once; the folder rename with no agent checkpoints nothing.
    checkpoints: ['ref.md', 'ref.md', 'broken-ref.md'],
    changedOnDisk: [['ref.md'], ['ref.md'], ['book/_book_INDEX.md']],
  })
}, 60_000)

test('documents moved together in one Collection batch keep their links to each other', async () => {
  const { batch } = await run()
  expect(batch).toEqual({ a: 'See [b](b.md#top).\n', b: '# Top\n\nBack to [a](./a.md).\n' })
}, 60_000)
