// Sharing ticket 04 (orchestrator ruling round 1, R-H): the agent's rename tells the publisher the move
// before any save signal names either path, as the app's own rename and the command line do. The real
// ipc.ts agent file services (electron stubbed in a child process) and the real `housekeeping.rename_file`
// capability; the publisher's two subscriptions record the order they are told in.
import { expect, test } from 'bun:test'

const probe = String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, rm, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-agent-rename-share-'))
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} },
    dialog: {},
    ipcMain: { handle: () => {}, removeHandler: () => {} },
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [ipc, { registerWindow }, { Workspace }, { buildWriteFlexManifest }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'), import('./src/main/capabilities.ts'),
  ])
  try {
    const state = registerWindow({ webContents: { id: 31, send: () => {} }, on: () => {}, isDestroyed: () => false })
    state.workspace = new Workspace(root)
    await writeFile(join(root, 'old.md'), 'Body.\n')
    await writeFile(join(root, 'ref.md'), 'See [[old]].\n')
    const order = []
    ipc.onDocumentsMoved((where, from, to) => order.push(['moved', where === root, from, to]))
    ipc.onDocumentsChanged((where, paths) => order.push(['changed', where === root, ...paths]))
    const rename = buildWriteFlexManifest(state.workspace, undefined, ipc.agentFileServices(state)).capabilities.find((capability) => capability.name === 'housekeeping.rename_file')
    const input = { path: 'old.md', newPath: 'new.md' }
    const resolvedTouchedPaths = Object.freeze(await rename.touchedPaths(input))
    const result = await rename.execute(input, {
      trigger: { id: 't', source: 'user', trust: 'interactive' },
      sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {}, resolvedTouchedPaths,
    })
    console.log(JSON.stringify({ isError: result.isError === true, order }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
`

test('an agent rename tells the publisher the move before any save signal (R-H)', async () => {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`The agent rename probe failed: ${stderr}`)
  const { isError, order } = JSON.parse(stdout.trim().split('\n').at(-1)!) as { isError: boolean; order: unknown[][] }
  expect(isError).toBe(false)
  expect(order[0]).toEqual(['moved', true, 'old.md', 'new.md'])
  // The repair's save signal comes after, naming the file it rewrote.
  expect(order.slice(1)).toContainEqual(['changed', true, 'ref.md'])
})
