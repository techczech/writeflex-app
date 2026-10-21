/**
 * Sol round 6 (2026-10-20):
 * - "Write it out" on a `./` line judges its place in the create's own tick, never makes a folder, writes the file
 *   before the manifest, and takes the file back when the manifest write fails.
 * - Its visibility is judged on the real spelling (`Node_Modules` on a disk that ignores case is `node_modules`).
 * - A folder rename with nothing to repair never waits on the agent's start-up.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
const DIR = 'book'
const INDEX = `${DIR}/_book_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const A = `${DIR}/contents/a.md`
const REFUSAL = 'names a place no part can be written to'

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-path-links-r6-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const read = (rel: string) => readFile(join(root, rel), 'utf8')
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

async function manifestFolio(line: string): Promise<string> {
  const manifest = JSON.stringify({ schema_version: 1, content_root: 'contents', files: [{ path: 'a.md' }] }, null, 2)
  await write(A, '# Alpha\n')
  await write(MANIFEST, manifest)
  await write(INDEX, `# book\n\n## Running order\n\n- [[./contents/a]]\n- [[${line}]]\n`)
  return manifest
}

function materialise(checkpoint: (path: string) => Promise<void> = async () => undefined) {
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: (_state, path) => checkpoint(path),
    notifyCollectionChanged: () => undefined,
    notifyChangedOnDisk: () => undefined,
  })
  return handlers.get('plan:materialise-part')!({ sender: { id: 1 } }, { dir: DIR, index: 1 })
}

// ---- (a) The place is judged at the create, no folder is made, the manifest follows the file ----

test('"Write it out" never makes a folder: a ./ line into a folder that is not there is refused', async () => {
  const manifest = await manifestFolio('./contents/drafts/x')
  await expect(materialise()).rejects.toThrow(`${REFUSAL}: ./contents/drafts/x`)
  expect(existsSync(join(root, DIR, 'contents', 'drafts'))).toBe(false)
  expect(await read(MANIFEST)).toBe(manifest)
})

test('a folder swapped for a link while the write waits on its checkpoint is refused at the create, manifest untouched', async () => {
  await mkdir(join(root, DIR, 'contents', 'bridge'), { recursive: true })
  await mkdir(join(root, 'other'))
  const manifest = await manifestFolio('./contents/bridge/x')
  const swap = async (): Promise<void> => {
    await rm(join(root, DIR, 'contents', 'bridge'), { recursive: true })
    await symlink(join(root, 'other'), join(root, DIR, 'contents', 'bridge'))
  }
  await expect(materialise(swap)).rejects.toThrow(`${REFUSAL}: ./contents/bridge/x`)
  expect(existsSync(join(root, 'other', 'x.md'))).toBe(false)
  expect(await read(MANIFEST)).toBe(manifest)
})

/** The Workspace's create, followed by `after` (another program acting between the create and the manifest write). */
function afterCreate(after: () => Promise<void>): void {
  const create = ws.createFile.bind(ws)
  ws.createFile = async (...args: Parameters<Workspace['createFile']>) => {
    const made = await create(...args)
    await after()
    return made
  }
}

test('when the manifest write fails after the create, the new file is taken back', async () => {
  await manifestFolio('./contents/x')
  const changed = '{ "schema_version": 1, "files": [] }\n'
  afterCreate(() => writeFile(join(root, MANIFEST), changed))
  await expect(materialise()).rejects.toThrow('The Folio manifest changed')
  expect(existsSync(join(root, DIR, 'contents', 'x.md'))).toBe(false)
  expect(await read(MANIFEST)).toBe(changed)
})

test('when the manifest write fails and the new file was replaced meanwhile, it is left in place and named', async () => {
  await manifestFolio('./contents/x')
  afterCreate(async () => {
    await writeFile(join(root, MANIFEST), '{ "schema_version": 1, "files": [] }\n')
    await writeFile(join(root, DIR, 'contents', 'other.md'), 'Not the stub.\n')
    await rename(join(root, DIR, 'contents', 'other.md'), join(root, DIR, 'contents', 'x.md'))
  })
  await expect(materialise()).rejects.toThrow(`The new part ${DIR}/contents/x.md was left in place.`)
  expect(await read(`${DIR}/contents/x.md`)).toBe('Not the stub.\n')
})

test('when another editor saves into the new file before its read-back and the manifest write fails, the edit survives', async () => {
  await manifestFolio('./contents/x')
  const edited = '# x\n\nThe writer started here.\n'
  const readFileOriginal = ws.readFile.bind(ws)
  let saved = false
  ws.readFile = async (...args: Parameters<Workspace['readFile']>) => {
    if (!saved && args[0] === `${DIR}/contents/x.md`) {
      saved = true
      await writeFile(join(root, DIR, 'contents', 'x.md'), edited) // in place: the same file, the writer's text
      await writeFile(join(root, MANIFEST), '{ "schema_version": 1, "files": [] }\n')
    }
    return readFileOriginal(...args)
  }
  await expect(materialise()).rejects.toThrow(`The new part ${DIR}/contents/x.md was left in place.`)
  expect(await read(`${DIR}/contents/x.md`)).toBe(edited)
})

// ---- (b) Visibility on the real spelling ----

test('"Write it out" refuses ./Node_Modules/x where the disk holds the hidden node_modules', async () => {
  await mkdir(join(root, DIR, 'node_modules'), { recursive: true })
  if (!existsSync(join(root, DIR, 'NODE_MODULES'))) return // a disk that keeps case apart: two folders, nothing to judge
  await mkdir(join(root, DIR, 'contents', 'node_modules'), { recursive: true })
  await manifestFolio('./contents/Node_Modules/x')
  await expect(materialise()).rejects.toThrow(`${REFUSAL}: ./contents/Node_Modules/x`)
  expect(existsSync(join(root, DIR, 'contents', 'node_modules', 'x.md'))).toBe(false)
})

// ---- (c) A folder rename waits on the agent only when it has something to repair ----

const renameProbe = String.raw`
  import { mock } from 'bun:test'
  import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-folder-rename-r6-'))
  const handlers = new Map()
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} }, dialog: {}, ipcMain,
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({ webContents: { id: 17, send: () => {} }, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  const rename = (path, newName) => handlers.get('folder:rename')({ sender: { id: 17 } }, { path, newName })
  const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve('timed out'), ms))
  await mkdir(join(root, 'empty'), { recursive: true })
  await mkdir(join(root, 'book', 'contents'), { recursive: true })
  await writeFile(join(root, 'book', 'contents', 'a.md'), '# Alpha\n')
  await writeFile(join(root, 'book', '_book_INDEX.md'), '# book\n\n- [[./contents/a]]\n')

  // An agent that never finishes starting: a rename with nothing to repair does not wait for it.
  state.agentReady = new Promise(() => {})
  const plain = await Promise.race([rename('empty', 'still-empty'), timeout(5000)])

  // An agent that finishes starting a little later: a rename with a repair waits for it and checkpoints the note.
  const checkpointed = []
  const agent = { checkpointFile: async (path) => { checkpointed.push(path) } }
  state.agentReady = new Promise((resolve) => setTimeout(() => resolve(agent), 200))
  const repaired = await Promise.race([rename('book/contents', 'chapters'), timeout(10000)])
  console.log(JSON.stringify({ plain, repaired, checkpointed, index: await readFile(join(root, 'book', '_book_INDEX.md'), 'utf8') }))
  process.exit(0)
`

test('a folder rename with nothing to repair never waits on the agent; one with a repair checkpoints on it', async () => {
  const child = Bun.spawn([process.execPath, '-e', renameProbe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`The folder rename probe failed: ${stderr}`)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.plain).toEqual({ path: 'still-empty', repair: { writtenPaths: [], unrepairedReferences: [] } })
  expect(result.repaired).toEqual({ path: 'book/chapters', repair: { writtenPaths: [INDEX], unrepairedReferences: [] } })
  expect(result.checkpointed).toEqual([INDEX])
  expect(result.index).toBe('# book\n\n- [[./chapters/a]]\n')
}, 60_000)
