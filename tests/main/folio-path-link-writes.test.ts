import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { applyFolderRenameRepair, planFolderRenameRepair } from '../../src/main/folder-rename-repair'
import { readFolioPlan } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { renameFolder } from '../../src/main/rename-doors'
import { repairRename } from '../../src/main/rename-repair'
import { formatFolderRenameRepairMessage } from '../../src/shared/rename-repair-message'
import { Workspace } from '../../src/main/workspace'
import { renameDoorWorld } from '../helpers/rename-door-world'

let root: string
let ws: Workspace
const DIR = 'book'
const INDEX = `${DIR}/_book_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const A = `${DIR}/contents/a.md`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-path-link-writes-'))
  ws = new Workspace(root)
  fresh()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const fresh = (): void => { invalidateFolioPlaces(root); invalidateFolioOrderFacts(root) }
const read = (rel: string) => readFile(join(root, rel), 'utf8')
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

async function manifestFolio(files: string[], index: string): Promise<void> {
  await write(MANIFEST, JSON.stringify({ schema_version: 1, content_root: 'contents', files: files.map((path) => ({ path })) }, null, 2))
  await write(INDEX, index)
}

function harness(checkpoint: (path: string) => Promise<void> = async () => undefined) {
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: (_state, path) => checkpoint(path),
    notifyCollectionChanged: () => undefined,
    notifyChangedOnDisk: () => undefined,
  })
  return (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
}

// Renaming folders and files

test('renaming a folder rewrites the ./ links into it, and the Index Note keeps naming its part', async () => {
  await write(A, '# Same\n\nA.\n')
  await write(`${DIR}/contents/b.md`, '# Same\n\nB.\n')
  await manifestFolio(['a.md', 'b.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/b.md|Bee]] — gloss\n\n`[[./contents/a]]` in code stays.\n')
  await write(`${DIR}/notes/inside.md`, 'Unrelated [[./x]].\n')
  const plan = await planFolderRenameRepair(ws, `${DIR}/contents`, `${DIR}/chapters`)
  await rename(join(root, DIR, 'contents'), join(root, DIR, 'chapters'))
  const result = await applyFolderRenameRepair(plan, ws)
  expect(result).toEqual({ writtenPaths: [INDEX], unrepairedReferences: [], receipts: [expect.objectContaining({ path: INDEX })] })
  expect(await read(INDEX)).toBe('# book\n\n## Running order\n\n- [[./chapters/a]]\n- [[./chapters/b.md|Bee]] — gloss\n\n`[[./contents/a]]` in code stays.\n')
  fresh()
  // The manifest's content root is not this repair's to change: the line resolves by its path.
  const outline = await readFolioPlan(ws, DIR)
  expect(outline?.parts.map((part) => part.path)).toEqual([`${DIR}/chapters/a.md`, `${DIR}/chapters/b.md`])
})

test('a folder rename repair leaves a note changed since the plan as it is and reports its links', async () => {
  await write(A, '# Alpha\n')
  await write(`${DIR}/ref.md`, 'See [[./contents/a]].\n')
  const plan = await planFolderRenameRepair(ws, `${DIR}/contents`, `${DIR}/chapters`)
  await rename(join(root, DIR, 'contents'), join(root, DIR, 'chapters'))
  await write(`${DIR}/ref.md`, 'See [[./contents/a]]. Edited meanwhile.\n')
  const result = await applyFolderRenameRepair(plan, ws)
  const message = formatFolderRenameRepairMessage('Renamed folder to chapters', result)
  expect(message).toContain(`${DIR}/ref.md`)
  expect(message).toContain('was not repaired')
  expect(result.writtenPaths).toEqual([])
  expect(result.unrepairedReferences).toEqual([expect.stringContaining(`${DIR}/ref.md: [[./contents/a]] was not repaired`)])
  expect(await read(`${DIR}/ref.md`)).toBe('See [[./contents/a]]. Edited meanwhile.\n')
})

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

test('a folder rename with nothing to repair never waits on the agent; one with a repair checkpoints on it', async () => {
  const world = await renameDoorWorld()
  const timeout = (ms: number) => new Promise((resolve) => setTimeout(() => resolve('timed out'), ms))
  await mkdir(join(world.root, 'empty'), { recursive: true })
  await world.write('book/contents/a.md', '# Alpha\n')
  await world.write('book/_book_INDEX.md', '# book\n\n- [[./contents/a]]\n')

  // An agent that never finishes starting: a rename with nothing to repair does not wait for it.
  world.setAgent(new Promise(() => {}))
  const plain = await Promise.race([renameFolder(world.deps, 'empty', 'still-empty'), timeout(5000)])

  // An agent that finishes starting a little later: a rename with a repair waits for it and checkpoints the note.
  world.setAgent(new Promise((resolve) => setTimeout(() => resolve(world.recordingAgent), 200)))
  const repaired = await Promise.race([renameFolder(world.deps, 'book/contents', 'chapters'), timeout(10000)])
  expect(plain).toEqual({ path: 'still-empty', repair: { writtenPaths: [], unrepairedReferences: [], receipts: [] } })
  expect(repaired).toEqual({ path: 'book/chapters', repair: { writtenPaths: [INDEX], unrepairedReferences: [], receipts: [expect.objectContaining({ path: INDEX })] } })
  expect(world.checkpoints).toEqual([INDEX])
  expect(world.changedOnDisk).toEqual([[INDEX]])
  expect(await world.read(INDEX)).toBe('# book\n\n- [[./chapters/a]]\n')

  // An agent whose start-up failed: the folder moves and each repair write is refused, the note left as it was.
  const failed = Promise.reject(new Error('Choose a model to continue.'))
  failed.catch(() => {})
  world.setAgent(failed)
  const refused = await renameFolder(world.deps, 'book/chapters', 'final')
  expect(refused.path).toBe('book/final')
  expect(refused.repair.writtenPaths).toEqual([])
  expect(refused.repair.unrepairedReferences).toEqual([expect.stringContaining('[[./chapters/a]]')])
  expect(await world.read(INDEX)).toBe('# book\n\n- [[./chapters/a]]\n')
})

test('renaming a file rewrites a ./ link as the new path, never as the bare file name', async () => {
  await write(A, '# Alpha\n')
  await write(`${DIR}/ref.md`, 'See [[./contents/a#Part|the part]] and [[./contents/a.md]].\n')
  await rename(join(root, A), join(root, DIR, 'contents', 'b.md'))
  const result = await repairRename(ws, A, `${DIR}/contents/b.md`)
  expect(result.unrepairedReferences).toEqual([])
  expect(await read(`${DIR}/ref.md`)).toBe('See [[./contents/b#Part|the part]] and [[./contents/b.md]].\n')
})

test('a ./ link is repaired by its path even when another file is titled as the new file name', async () => {
  await write(A, '# Alpha\n')
  await write(`${DIR}/other.md`, '# b\n')
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n')
  await rename(join(root, A), join(root, DIR, 'contents', 'b.md'))
  const result = await repairRename(ws, A, `${DIR}/contents/b.md`)
  expect(result.unrepairedReferences).toEqual([])
  expect(await read(INDEX)).toBe('# book\n\n## Running order\n\n- [[./contents/b]]\n')
  fresh()
  expect((await readFolioPlan(ws, DIR))?.parts.map((part) => part.path)).toEqual([`${DIR}/contents/b.md`])
})

// Materialising a part from a path link

test('"Write it out" on a dead ./ line creates the file the line names, titled by its file name', async () => {
  await write(A, '# Alpha\n')
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/x]] — the missing one\n')
  const invoke = harness()
  const result = await invoke('plan:materialise-part', { dir: DIR, index: 1 }) as { path: string; plan: { parts: Array<{ path: string | null }> } }
  expect(result.path).toBe(`${DIR}/contents/x.md`)
  expect(existsSync(join(root, DIR, 'contents', '01-contents-x.md'))).toBe(false)
  const created = await read(`${DIR}/contents/x.md`)
  expect(created).toContain('title: "x"')
  expect(created).not.toContain('./contents/x')
  fresh()
  expect((await readFolioPlan(ws, DIR))?.parts.map((part) => part.path)).toEqual([A, `${DIR}/contents/x.md`])
})

test('"Write it out" on a dead ./ line whose title another file shares still writes the named file', async () => {
  await write(A, '# x\n')
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/x]]\n')
  const result = await harness()('plan:materialise-part', { dir: DIR, index: 1 }) as { path: string }
  expect(result.path).toBe(`${DIR}/contents/x.md`)
  fresh()
  expect((await readFolioPlan(ws, DIR))?.parts.map((part) => part.path)).toEqual([A, `${DIR}/contents/x.md`])
})

test('"Write it out" refuses a ./ line whose folder is a link to a folder outside the Folio', async () => {
  await write(A, '# Alpha\n')
  await mkdir(join(root, 'other'))
  await symlink(join(root, 'other'), join(root, DIR, 'bridge'))
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./bridge/x]]\n')
  await expect(harness()('plan:materialise-part', { dir: DIR, index: 1 })).rejects.toThrow('names a place no part can be written to: ./bridge/x')
  expect(existsSync(join(root, 'other', 'x.md'))).toBe(false)
  expect(existsSync(join(root, DIR, 'bridge', 'x.md'))).toBe(false)
})

for (const folder of ['.bridle', 'node_modules']) {
  test(`"Write it out" refuses a ./ line in ${folder}, a folder the listing never shows`, async () => {
    await write(A, '# Alpha\n')
    await manifestFolio(['a.md'], `# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./${folder}/x]]\n`)
    await expect(harness()('plan:materialise-part', { dir: DIR, index: 1 })).rejects.toThrow(`names a place no part can be written to: ./${folder}/x`)
    expect(existsSync(join(root, DIR, folder, 'x.md'))).toBe(false)
  })
}

const REFUSAL = 'names a place no part can be written to'

async function folioWithMissingPart(line: string): Promise<string> {
  const manifest = JSON.stringify({ schema_version: 1, content_root: 'contents', files: [{ path: 'a.md' }] }, null, 2)
  await write(A, '# Alpha\n')
  await write(MANIFEST, manifest)
  await write(INDEX, `# book\n\n## Running order\n\n- [[./contents/a]]\n- [[${line}]]\n`)
  return manifest
}

function materialise(checkpoint?: (path: string) => Promise<void>) {
  return harness(checkpoint)('plan:materialise-part', { dir: DIR, index: 1 })
}

test('"Write it out" never makes a folder: a ./ line into a folder that is not there is refused', async () => {
  const manifest = await folioWithMissingPart('./contents/drafts/x')
  await expect(materialise()).rejects.toThrow(`${REFUSAL}: ./contents/drafts/x`)
  expect(existsSync(join(root, DIR, 'contents', 'drafts'))).toBe(false)
  expect(await read(MANIFEST)).toBe(manifest)
})

test('a folder swapped for a link while the write waits on its checkpoint is refused at the create, manifest untouched', async () => {
  await mkdir(join(root, DIR, 'contents', 'bridge'), { recursive: true })
  await mkdir(join(root, 'other'))
  const manifest = await folioWithMissingPart('./contents/bridge/x')
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
  await folioWithMissingPart('./contents/x')
  const changed = '{ "schema_version": 1, "files": [] }\n'
  afterCreate(() => writeFile(join(root, MANIFEST), changed))
  await expect(materialise()).rejects.toThrow('The Folio manifest changed')
  expect(existsSync(join(root, DIR, 'contents', 'x.md'))).toBe(false)
  expect(await read(MANIFEST)).toBe(changed)
})

test('when the manifest write fails and the new file was replaced meanwhile, it is left in place and named', async () => {
  await folioWithMissingPart('./contents/x')
  afterCreate(async () => {
    await writeFile(join(root, MANIFEST), '{ "schema_version": 1, "files": [] }\n')
    await writeFile(join(root, DIR, 'contents', 'other.md'), 'Not the stub.\n')
    await rename(join(root, DIR, 'contents', 'other.md'), join(root, DIR, 'contents', 'x.md'))
  })
  await expect(materialise()).rejects.toThrow(`The new part ${DIR}/contents/x.md was left in place.`)
  expect(await read(`${DIR}/contents/x.md`)).toBe('Not the stub.\n')
})

test('when another editor saves into the new file before its read-back and the manifest write fails, the edit survives', async () => {
  await folioWithMissingPart('./contents/x')
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

test('"Write it out" refuses ./Node_Modules/x where the disk holds the hidden node_modules', async () => {
  await mkdir(join(root, DIR, 'node_modules'), { recursive: true })
  if (!existsSync(join(root, DIR, 'NODE_MODULES'))) return // a disk that keeps case apart: two folders, nothing to judge
  await mkdir(join(root, DIR, 'contents', 'node_modules'), { recursive: true })
  await folioWithMissingPart('./contents/Node_Modules/x')
  await expect(materialise()).rejects.toThrow(`${REFUSAL}: ./contents/Node_Modules/x`)
  expect(existsSync(join(root, DIR, 'contents', 'node_modules', 'x.md'))).toBe(false)
})
