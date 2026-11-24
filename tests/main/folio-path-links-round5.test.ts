/**
 * Sol round 5 (2026-10-20): the folder-rename repair and "Write it out" write only what the reader will read back.
 * - A repaired `./` link is written only when the link as written parses to the moved file (`chap#ters` is not an anchor).
 * - A repair is written only when the file it names is still where the plan put it.
 * - "Write it out" never creates a file through a link on the way, nor in a folder the listing hides.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { renameFolder } from '../../src/main/rename-doors'
import { renameDoorWorld } from '../helpers/rename-door-world'
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
    expect(await applyFolderRenameRepair(plan, ws)).toEqual({ writtenPaths: [INDEX], unrepairedReferences: [], receipts: [expect.objectContaining({ path: INDEX })] })
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

test('two folder renames asked for one after another leave the Index Note naming the file where it ends up', async () => {
  const world = await renameDoorWorld()
  await world.write('book/contents/a.md', '# Alpha\n')
  await world.write('book/_book_INDEX.md', '# book\n\n- [[./contents/a]]\n')
  // The second rename is asked for while the first is still under way.
  const first = renameFolder(world.deps, 'book/contents', 'chapters')
  await new Promise((resolve) => setImmediate(resolve))
  const second = renameFolder(world.deps, 'book/chapters', 'final')
  const results = await Promise.all([first, second])
  expect(await world.read('book/_book_INDEX.md')).toBe('# book\n\n- [[./final/a]]\n')
  expect(results.map((item) => item.path)).toEqual(['book/chapters', 'book/final'])
})

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
