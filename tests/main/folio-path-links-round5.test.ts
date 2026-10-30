/**
 * Sol round 5 (2026-10-20): the folder-rename repair and "Write it out" write only what the reader will read back.
 * - A repaired `./` link is written only when the link as written parses to the moved file (`chap#ters` is not an anchor).
 * - A repair is written only when the file it names is still where the plan put it.
 * - "Write it out" never creates a file through a link on the way, nor in a folder the listing hides.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { applyFolderRenameRepair, planFolderRenameRepair } from '../../src/main/folder-rename-repair'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
const DIR = 'book'
const INDEX = `${DIR}/_book_INDEX.md`
const A = `${DIR}/contents/a.md`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-path-links-r5-'))
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

async function manifestFolio(files: string[], index: string): Promise<void> {
  await write(`${DIR}/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: 'contents', files: files.map((path) => ({ path })) }, null, 2))
  await write(INDEX, index)
}

function harness() {
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async () => undefined,
    notifyCollectionChanged: () => undefined,
    notifyChangedOnDisk: () => undefined,
  })
  return (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
}

// ---- 1. A folder name the reader takes apart is not written into a link ----

for (const name of ['chap#ters', 'chap|ters', 'chap]]ters', 'chap]ters']) {
  test(`renaming a folder to ${name} escapes its ./ links and preserves their file identity`, async () => {
    await write(A, '# Alpha\n')
    await write(`${DIR}/chap.md`, '# Chap\n') // what `[[./chap#ters/a]]` would open
    await write(INDEX, '# book\n\n- [[./contents/a]]\n')
    const plan = await planFolderRenameRepair(ws, `${DIR}/contents`, `${DIR}/${name}`)
    expect(plan.writes).toHaveLength(1)
    expect(plan.unrepairedReferences).toEqual([])
    await rename(join(root, DIR, 'contents'), join(root, DIR, name))
    expect(await applyFolderRenameRepair(plan, ws)).toEqual({ writtenPaths: [INDEX], unrepairedReferences: [] })
    const escaped = name.replace(/[%#|\[\]]/g, char => encodeURIComponent(char))
    expect(await read(INDEX)).toBe(`# book\n\n- [[./${escaped}/a]]\n`)
  })
}

// ---- 2. A repair is written only while its file is where the plan put it ----

test('a folder repair whose folder moved on again before the write is not written, and is reported', async () => {
  await write(A, '# Alpha\n')
  await write(INDEX, '# book\n\n- [[./contents/a]]\n')
  const plan = await planFolderRenameRepair(ws, `${DIR}/contents`, `${DIR}/chapters`)
  await rename(join(root, DIR, 'contents'), join(root, DIR, 'chapters'))
  // While the repair waits on its checkpoint, the folder is renamed again.
  const result = await applyFolderRenameRepair(plan, ws, async () => {
    await rename(join(root, DIR, 'chapters'), join(root, DIR, 'final'))
  })
  expect(result.writtenPaths).toEqual([])
  expect(result.unrepairedReferences).toEqual([expect.stringContaining(`${INDEX}: [[./contents/a]] was not repaired: ${DIR}/chapters/a.md is no longer there`)])
  expect(await read(INDEX)).toBe('# book\n\n- [[./contents/a]]\n')
})

const interleavedRenameProbe = String.raw`
  import { mock } from 'bun:test'
  import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-folder-rename-r5-'))
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
  await mkdir(join(root, 'book', 'contents'), { recursive: true })
  await writeFile(join(root, 'book', 'contents', 'a.md'), '# Alpha\n')
  await writeFile(join(root, 'book', '_book_INDEX.md'), '# book\n\n- [[./contents/a]]\n')
  const rename = handlers.get('folder:rename')
  // The second rename is asked for while the first is still under way.
  const first = rename({ sender: { id: 17 } }, { path: 'book/contents', newName: 'chapters' })
  await new Promise((resolve) => setImmediate(resolve))
  const second = rename({ sender: { id: 17 } }, { path: 'book/chapters', newName: 'final' })
  const results = await Promise.all([first, second])
  console.log(JSON.stringify({ results, index: await readFile(join(root, 'book', '_book_INDEX.md'), 'utf8') }))
`

test('two folder renames asked for one after another leave the Index Note naming the file where it ends up', async () => {
  const child = Bun.spawn([process.execPath, '-e', interleavedRenameProbe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`The folder rename probe failed: ${stderr}`)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.index).toBe('# book\n\n- [[./final/a]]\n')
  expect(result.results.map((item: { path: string }) => item.path)).toEqual(['book/chapters', 'book/final'])
}, 60_000)

// ---- 3. "Write it out" never writes through a link on the way ----

test('"Write it out" refuses a ./ line whose folder is a link to a folder outside the Folio', async () => {
  await write(A, '# Alpha\n')
  await mkdir(join(root, 'other'))
  await symlink(join(root, 'other'), join(root, DIR, 'bridge'))
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./bridge/x]]\n')
  await expect(harness()('plan:materialise-part', { dir: DIR, index: 1 })).rejects.toThrow('names a place no part can be written to: ./bridge/x')
  expect(existsSync(join(root, 'other', 'x.md'))).toBe(false)
  expect(existsSync(join(root, DIR, 'bridge', 'x.md'))).toBe(false)
})

// ---- 4. "Write it out" never writes into a folder the listing hides ----

for (const folder of ['.bridle', 'node_modules']) {
  test(`"Write it out" refuses a ./ line in ${folder}, a folder the listing never shows`, async () => {
    await write(A, '# Alpha\n')
    await manifestFolio(['a.md'], `# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./${folder}/x]]\n`)
    await expect(harness()('plan:materialise-part', { dir: DIR, index: 1 })).rejects.toThrow(`names a place no part can be written to: ./${folder}/x`)
    expect(existsSync(join(root, DIR, folder, 'x.md'))).toBe(false)
  })
}
