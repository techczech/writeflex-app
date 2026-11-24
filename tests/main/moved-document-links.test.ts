import { expect, test } from 'bun:test'
const probe = String.raw`
  import { mock } from 'bun:test'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
  import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  const root = await mkdtemp(join(tmpdir(), 'writeflex-rename-door-'))
  const handlers = new Map()
  const sent = []
  const checkpoints = []
  const checkpointStates = []
  let failCheckpoint = false
  let saveFailure = 'none'
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  }
  void mock.module('electron', () => ({
    ...electronMainStandIn,
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} },
    dialog: {},
    ipcMain,
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({
    webContents: { id: 17, send: (channel, payload) => sent.push([channel, payload]) },
    on: () => {}, isDestroyed: () => false,
  })
  state.workspace = new Workspace(root)
  const realSaveFile = state.workspace.saveFile.bind(state.workspace)
  state.workspace.saveFile = async (path, content, options) => {
    if (saveFailure === 'write' && path === 'write-ref.md' && content.includes('[[write-new]]')) {
      throw new Error('injected repair write failure')
    }
    if (saveFailure === 'rollback') {
      if (path === 'b-ref.md' && content.includes('[[rollback-new]]')) {
        await realSaveFile('a-ref.md', 'See [[rollback-new]].\nA concurrent paragraph survives.\n')
        throw new Error('injected repair write failure')
      }
    }
    return realSaveFile(path, content, options)
  }
  state.agentReady = Promise.resolve({
    checkpointFile: async (path) => {
      checkpoints.push(path)
      if (failCheckpoint) checkpointStates.push({
        oldExists: await Bun.file(join(root, 'broken-old.md')).exists(),
        newExists: await Bun.file(join(root, 'broken-new.md')).exists(),
      })
      if (failCheckpoint) throw new Error('injected repair checkpoint failure')
    },
  })
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  const rename = handlers.get('file:rename')
  const move = handlers.get('file:move')
  const planRename = handlers.get('file:rename-repair-paths')

  try {
    await mkdir(join(root, 'papers/chapters'), { recursive: true })
    await mkdir(join(root, 'assets'), { recursive: true })
    await mkdir(join(root, 'archive'), { recursive: true })
    await writeFile(join(root, 'assets/pic.png'), 'image')
    await writeFile(join(root, 'assets/pic one.png'), 'image')
    await writeFile(join(root, 'assets/data.pdf'), 'asset')
    await writeFile(join(root, 'target.md'), 'target')
    const source = '![Picture](../../assets/pic.png "Title")\n[Document](../../target.md#part)\n[Asset](../../assets/data.pdf?download=1)\n![Root](/assets/pic.png)\n[Absolute](file:///tmp/a.png)\n[URL](https://example.org/pic.png)\n[Anchor](#part)\n[Broken](../../missing.png)\n[Folder](../../assets/)\n[Outside](../../../outside.png)\n![Encoded](<../../assets/pic%20one.png?raw=1#view> "Keep title")\n![Reference][picture]\n\n[picture]: ../../assets/pic.png "Keep reference title"\n'
    await writeFile(join(root, 'papers/chapters/draft.md'), source)
    const movedResult = await move({ sender: { id: 17 } }, { path: 'papers/chapters/draft.md', newPath: 'archive/draft.md' })
    const file = await readFile(join(root, 'archive/draft.md'), 'utf8')
    await mkdir(join(root, 'special#name'), { recursive: true })
    await writeFile(join(root, 'special#name/local.png'), 'image')
    await writeFile(join(root, 'special#name/doc.md'), '![Local](local.png)')
    await move({ sender: { id: 17 } }, { path: 'special#name/doc.md', newPath: 'archive/special.md' })
    const special = await readFile(join(root, 'archive/special.md'), 'utf8')
    await writeFile(join(root, 'papers/chapters/folder.md'), source.replaceAll('../../assets/', '../../papers/assets/'))
    await mkdir(join(root, 'papers/assets'), { recursive: true })
    await writeFile(join(root, 'papers/assets/pic.png'), 'image')
    await writeFile(join(root, 'papers/assets/data.pdf'), 'asset')
    await handlers.get('folder:rename')({ sender: { id: 17 } }, { path: 'papers', newName: 'renamed' })
    const folder = await readFile(join(root, 'renamed/chapters/folder.md'), 'utf8')
    console.log(JSON.stringify({ file, folder, source, special, notices: movedResult.repair.unrepairedReferences }))
  } finally { await rm(root, { recursive: true, force: true }) }
`
async function probeResult() {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code) throw new Error(err)
  return JSON.parse(out.trim().split('\n').at(-1)!)
}
let pending: ReturnType<typeof probeResult> | undefined
const run = () => pending ??= probeResult()
for (const [label, old, replacement] of [
  ['image', '../../assets/pic.png', '../assets/pic.png'],
  ['document', '../../target.md#part', '../target.md#part'],
  ['asset', '../../assets/data.pdf?download=1', '../assets/data.pdf?download=1'],
]) test(`real file:move preserves outgoing ${label} target`, async () => {
  const { file } = await run()
  expect(file).toContain(replacement)
  expect(file).not.toContain(old)
})
test('real folder:rename preserves outgoing relative targets', async () => {
  const { folder } = await run()
  expect(folder).toContain('![Picture](../assets/pic.png')
  expect(folder).toContain('../../target.md#part')
  expect(folder).toContain('[Asset](../assets/data.pdf?download=1)')
})
test('real move leaves root, absolute and broken links untouched', async () => {
  const { file } = await run()
  expect(file).toContain('![Root](/assets/pic.png)')
  expect(file).toContain('[Absolute](file:///tmp/a.png)')
  expect(file).toContain('[Broken](../../missing.png)')
  expect(file).toContain('[URL](https://example.org/pic.png)')
  expect(file).toContain('[Anchor](#part)')
})

test('real move preserves URL spelling, titles, suffixes and reference definitions', async () => {
  const { file, special } = await run()
  expect(special).toBe('![Local](../special%23name/local.png)')
  expect(file).toContain('![Encoded](<../assets/pic%20one.png?raw=1#view> "Keep title")')
  expect(file).toContain('[picture]: ../assets/pic.png "Keep reference title"')
  expect(file).toContain('![Picture](../assets/pic.png "Title")')
})

test('real move names folder and outside-vault links left unchanged when their resolution changes', async () => {
  const { file, notices } = await run()
  expect(file).toContain('[Folder](../../assets/)')
  expect(file).toContain('[Outside](../../../outside.png)')
  expect(notices.join(' ')).toContain('archive/draft.md: ../../assets/ was left unchanged')
  expect(notices.join(' ')).toContain('archive/draft.md: ../../../outside.png was left unchanged')
})
