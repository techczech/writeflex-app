import { expect, test } from 'bun:test'

const probe = String.raw`
  import { mock } from 'bun:test'
  import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'

  const root = await mkdtemp(join(tmpdir(), 'writeflex-main-ipc-'))
  const handlers = new Map()
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  }
  void mock.module('electron', () => ({
    app: {
      getPath: () => root,
      getVersion: () => '0.0.0-test',
      isPackaged: false,
    },
    clipboard: { write: () => {} },
    dialog: {},
    ipcMain,
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))

  const [{ registerIpc, agentFileServices }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'),
    import('./src/main/state.ts'),
    import('./src/main/workspace.ts'),
  ])
  let flushSaved = true
  const flushed = []
  const state = registerWindow({
    webContents: { id: 7, send: (channel, input) => {
      if (channel !== 'folio:flush-requested') return
      flushed.push(input.dir)
      queueMicrotask(() => handlers.get('folio:flush-result')({ sender: { id: 7 } }, { id: input.id, saved: flushSaved }))
    } },
    on: () => {},
    isDestroyed: () => false,
  })
  state.workspace = new Workspace(root)
  state.agentReady = null

  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )

  const fileServices = agentFileServices(state)
  await fileServices.prepareFolioInstructions('report')
  flushSaved = false
  let dirtyInstructionsRefused = false
  try { await fileServices.prepareFolioInstructions('report') } catch (error) { dirtyInstructionsRefused = String(error).includes('Save any open AGENTS.md and CLAUDE.md') }
  const instructionFlushWired = flushed.join('|') === 'report|report' && dirtyInstructionsRefused

  const expectedChannels = [
    'plan:read',
    'plan:adopt-part',
    'plan:insert-part',
    'plan:move-part',
    'plan:remove-part',
    'plan:materialise-part',
  ]
  const planChannelsPresent = expectedChannels.every((channel) => handlers.has(channel))
  let dispatchedWithoutAgent = false
  let previewMatchesMaterialised = false
  let malformedManifestRefused = false
  const insert = handlers.get('plan:insert-part')
  if (insert) {
    const indexPath = join(root, 'report', '_report_INDEX.md')
    await mkdir(join(root, 'report'), { recursive: true })
    await writeFile(indexPath, '# Report\n\n## Running order\n\n- [[Opening]]\n', 'utf8')
    const plan = await insert({ sender: { id: 7 } }, { dir: 'report', at: 1, part: { title: 'Close' } })
    dispatchedWithoutAgent = plan.parts.map((part) => part.title).join('|') === 'Opening|Close'
      && (await readFile(indexPath, 'utf8')).includes('- [[Close]]')
  }
  const previewStub = handlers.get('collection:stub-preview')
  const materialise = handlers.get('plan:materialise-part')
  if (previewStub && materialise) {
    await mkdir(join(root, 'material'), { recursive: true })
    await writeFile(join(root, 'material', '_material_INDEX.md'), '# Material\n\n## Running order\n\n- [[Evidence]] — Exact gloss #appendix\n', 'utf8')
    await writeFile(join(root, 'material', 'source.md'), '# Source\n', 'utf8')
    await writeFile(join(root, 'material', '_report-structure.json'), JSON.stringify({ schema_version: 1, content_root: '', files: [] }), 'utf8')
    const preview = await previewStub({ sender: { id: 7 } }, {
      dir: 'material', path: 'material/01-evidence.md', title: 'Evidence', gist: 'Exact gloss',
      role: 'appendix', bodyLead: 'Exact gloss', from: 'material/source.md',
      titleInFrontmatter: true, suppressBacklink: true,
    })
    const result = await materialise({ sender: { id: 7 } }, { dir: 'material', index: 0 })
    previewMatchesMaterialised = preview.content === await readFile(join(root, result.path), 'utf8')
  }
  const makeFolio = handlers.get('folio:create')
  if (makeFolio) {
    await mkdir(join(root, 'broken'), { recursive: true })
    const malformed = '{ "report_id": "keep", "files": ['
    await writeFile(join(root, 'broken', '_report-structure.json'), malformed, 'utf8')
    try {
      await makeFolio({ sender: { id: 7 } }, { dir: 'broken' })
    } catch (error) {
      malformedManifestRefused = /could not be parsed|malformed|valid JSON/i.test(String(error))
        && await readFile(join(root, 'broken', '_report-structure.json'), 'utf8') === malformed
    }
  }
  await rm(root, { recursive: true, force: true })
  console.log(JSON.stringify({ instructionFlushWired, planChannelsPresent, dispatchedWithoutAgent, previewMatchesMaterialised, malformedManifestRefused }))
`

async function realMainIpcBehaviour(): Promise<{ instructionFlushWired: boolean; planChannelsPresent: boolean; dispatchedWithoutAgent: boolean; previewMatchesMaterialised: boolean; malformedManifestRefused: boolean }> {
  const child = Bun.spawn([process.execPath, '-e', probe], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`The real main IPC behaviour probe failed: ${stderr}`)
  return JSON.parse(stdout) as { planChannelsPresent: boolean; dispatchedWithoutAgent: boolean }
}

test('the real main IPC stubTarget forwards every materialisation field byte-identically', async () => {
  expect(await realMainIpcBehaviour()).toEqual({
    instructionFlushWired: true,
    planChannelsPresent: true,
    dispatchedWithoutAgent: true,
    previewMatchesMaterialised: true,
    malformedManifestRefused: true,
  })
})
