/**
 * Sol round 4 (2026-10-20), Part B: `./` path links survive the operations around them.
 * - The editor keeps case-distinct path links apart (`[[./A]]` and `[[./a]]` name two files on a case-sensitive disk).
 * - Renaming a folder rewrites the `./` links into it, so the Index Note keeps naming its parts.
 * - Renaming a file keeps a `./` link a path link (`[[./contents/b]]`, not `[[b]]`), so another file's title
 *   cannot block its repair.
 * - "Write it out" on a dead `./` line creates the file the line names, titled by its file name.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { applyFolderRenameRepair, planFolderRenameRepair } from '../../src/main/folder-rename-repair'
import { readFolioPlan } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { repairRename } from '../../src/main/rename-repair'
import { buildWikilinkCandidateIndex, resolveWikilinkTargetFromIndex, type Candidate } from '../../src/main/wikilinks'
import { Workspace } from '../../src/main/workspace'
import { wikilinkRanges } from '../../src/renderer/src/editor/wikilinks'

let root: string
let ws: Workspace
const DIR = 'book'
const INDEX = `${DIR}/_book_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const A = `${DIR}/contents/a.md`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-path-links-r4-'))
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

const piece = (path: string, title: string): Candidate => ({ path, title, basename: path.split('/').at(-1)!.replace(/\.md$/, ''), aliases: [] })

// ---- 1. The editor keeps case-distinct path links apart ----

test('the editor opens each of two case-distinct path links at the file main resolved it to', () => {
  // A case-sensitive workspace: A.md and a.md are two files (built as candidates; the test disk may fold case).
  const index = buildWikilinkCandidateIndex([piece('book/A.md', 'Upper'), piece('book/a.md', 'Lower')])
  const doc = '- [[./A]]\n- [[./a]]\n'
  const resolutions = ['./A', './a'].map((target) => ({ target, display: target, ...resolveWikilinkTargetFromIndex(INDEX, target, index) }))
  expect(resolutions.map((item) => item.to)).toEqual(['book/A.md', 'book/a.md'])
  expect(wikilinkRanges(doc, resolutions).map((link) => link.path)).toEqual(['book/A.md', 'book/a.md'])
  // Name links stay case-insensitive, as before.
  expect(wikilinkRanges('[[upper]]', [{ target: 'Upper', display: 'Upper', to: 'book/A.md' }]).map((link) => link.path)).toEqual(['book/A.md'])
})

// ---- 2. Folder rename ----

test('renaming a folder rewrites the ./ links into it, and the Index Note keeps naming its part', async () => {
  await write(A, '# Same\n\nA.\n')
  await write(`${DIR}/contents/b.md`, '# Same\n\nB.\n')
  await manifestFolio(['a.md', 'b.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/b.md|Bee]] — gloss\n\n`[[./contents/a]]` in code stays.\n')
  await write(`${DIR}/notes/inside.md`, 'Unrelated [[./x]].\n')
  const plan = await planFolderRenameRepair(ws, `${DIR}/contents`, `${DIR}/chapters`)
  await rename(join(root, DIR, 'contents'), join(root, DIR, 'chapters'))
  const result = await applyFolderRenameRepair(plan, ws)
  expect(result).toEqual({ writtenPaths: [INDEX], unrepairedReferences: [] })
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
  expect(result.writtenPaths).toEqual([])
  expect(result.unrepairedReferences).toEqual([expect.stringContaining(`${DIR}/ref.md: [[./contents/a]] was not repaired`)])
  expect(await read(`${DIR}/ref.md`)).toBe('See [[./contents/a]]. Edited meanwhile.\n')
})

const folderRenameProbe = String.raw`
  import { mock } from 'bun:test'
  import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  const root = await mkdtemp(join(tmpdir(), 'writeflex-folder-rename-'))
  const handlers = new Map()
  const sent = []
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) }
  void mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: { write: () => {} }, dialog: {}, ipcMain,
    shell: { openExternal: async () => {}, showItemInFolder: () => {}, trashItem: async () => {} },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  const state = registerWindow({ webContents: { id: 17, send: (channel, payload) => sent.push([channel, payload]) }, on: () => {}, isDestroyed: () => false })
  state.workspace = new Workspace(root)
  registerIpc(
    { openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} },
    { modelDefaults: () => ({}), recents: () => [] },
    {},
  )
  await mkdir(join(root, 'book', 'contents'), { recursive: true })
  await writeFile(join(root, 'book', 'contents', 'a.md'), '# Alpha\n')
  await writeFile(join(root, 'book', '_book_INDEX.md'), '# book\n\n## Running order\n\n- [[./contents/a]]\n')
  const renamed = await handlers.get('folder:rename')({ sender: { id: 17 } }, { path: 'book/contents', newName: 'chapters' })
  console.log(JSON.stringify({
    renamed,
    index: await readFile(join(root, 'book', '_book_INDEX.md'), 'utf8'),
    changedOnDisk: sent.filter(([channel]) => channel === 'file:changed-on-disk').map(([, payload]) => payload),
  }))
`

test('the real folder:rename handler repairs the ./ links into the renamed folder', async () => {
  const child = Bun.spawn([process.execPath, '-e', folderRenameProbe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (exitCode !== 0) throw new Error(`The folder rename probe failed: ${stderr}`)
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!)
  expect(result.renamed).toEqual({ path: 'book/chapters', repair: { writtenPaths: ['book/_book_INDEX.md'], unrepairedReferences: [] } })
  expect(result.index).toBe('# book\n\n## Running order\n\n- [[./chapters/a]]\n')
  expect(result.changedOnDisk).toEqual([['book/_book_INDEX.md']])
})

// ---- 3. File rename keeps the path form ----

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

// ---- 4. Write it out on a dead path line ----

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
