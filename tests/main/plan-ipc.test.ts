import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { MANIFEST_NAME } from '../../src/main/folio'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-ipc-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

async function read(rel: string): Promise<string> {
  return readFile(join(root, rel), 'utf8')
}

function harness(options: { failCheckpointFor?: (path: string) => boolean } = {}) {
  const handlers = new Map<string, PlanIpcHandler>()
  const checkpoints: Array<{ path: string; content: string }> = []
  const collectionChanges: string[][] = []
  const diskChanges: string[][] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => {
      if (options.failCheckpointFor?.(path)) throw new Error(`injected checkpoint failure: ${path}`)
      checkpoints.push({ path, content: await read(path) })
    },
    notifyCollectionChanged: (_state, paths) => collectionChanges.push(paths),
    notifyChangedOnDisk: (_state, paths) => diskChanges.push(paths),
  })
  const invoke = async (channel: string, input: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler({ sender: { id: 7 } }, input)
  }
  return { handlers, checkpoints, collectionChanges, diskChanges, invoke }
}

test('the Plan IPC seam registers every channel', () => {
  const api = harness()
  expect([...api.handlers.keys()]).toEqual([
    'plan:read', 'plan:adopt-part', 'plan:insert-part', 'plan:move-part', 'plan:remove-part',
    'folio:move-piece', 'folio:add-pieces', 'folio:remove-added', 'plan:materialise-part',
  ])
})

test('plan:read executes the real reader', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  await write('report/opening.md', '# Opening\n')
  const plan = await harness().invoke('plan:read', { dir: 'report' }) as { parts: Array<{ title: string }> }
  expect(plan.parts.map((part) => part.title)).toEqual(['Opening'])
})

test('plan:insert-part executes the real writer', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  const plan = await harness().invoke('plan:insert-part', { dir: 'report', at: 1, part: { title: 'Middle' } }) as { parts: Array<{ title: string }> }
  expect(plan.parts.map((part) => part.title)).toEqual(['Opening', 'Middle'])
})

test('plan:adopt-part executes the real writer', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n')
  await write('report/contents/opening.md', '# Opening\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ content_root: 'contents', files: [{ path: 'opening.md' }] }))

  const plan = await harness().invoke('plan:adopt-part', { dir: 'report', unlistedIndex: 0 }) as { parts: Array<{ title: string }> }

  expect(plan.parts.map((part) => part.title)).toEqual(['Opening'])
  expect(await read('report/_report_INDEX.md')).toContain('- [[Opening]]')
})

test('plan:move-part executes the real writer', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Middle]]\n')
  const plan = await harness().invoke('plan:move-part', { dir: 'report', from: 1, to: 0 }) as { parts: Array<{ title: string }> }
  expect(plan.parts.map((part) => part.title)).toEqual(['Middle', 'Opening'])
})

test('plan:remove-part executes the real writer', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Middle]]\n')
  const plan = await harness().invoke('plan:remove-part', { dir: 'report', index: 0 }) as { parts: Array<{ title: string }> }
  expect(plan.parts.map((part) => part.title)).toEqual(['Middle'])
})

test('plan:materialise-part executes the real writer', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Middle]]\n')
  const result = await harness().invoke('plan:materialise-part', { dir: 'report', index: 0 }) as { path: string }
  expect(result.path).toBe('report/01-middle.md')
})

test('the handler checkpoints prior Index Note bytes and raises its changed-on-disk signal', async () => {
  const indexPath = 'report/_report_INDEX.md'
  const before = '# Report\n\n## Running order\n\n- [[Opening]]\n'
  await write(indexPath, before)
  const api = harness()

  await api.invoke('plan:insert-part', { dir: 'report', at: 1, part: { title: 'Close' } })

  expect({ checkpoints: api.checkpoints, diskChanges: api.diskChanges, collectionChanges: api.collectionChanges.at(-1) }).toEqual({
    checkpoints: [{ path: indexPath, content: before }],
    diskChanges: [[indexPath]],
    collectionChanges: [indexPath, `report/${MANIFEST_NAME}`],
  })
})

test('M3: the handler checkpoints the manifest before a Plan write changes it', async () => {
  const indexPath = 'report/_report_INDEX.md'
  const indexBefore = '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Close]]\n'
  const manifestPath = `report/${MANIFEST_NAME}`
  const manifestBefore = `${JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: [
      { path: '01-opening.md' },
      { path: '02-close.md' },
    ],
  }, null, 2)}\n`
  await write(indexPath, indexBefore)
  await write('report/contents/01-opening.md', '# Opening\n')
  await write('report/contents/02-close.md', '# Close\n')
  await write(manifestPath, manifestBefore)
  const api = harness()

  await api.invoke('plan:move-part', { dir: 'report', from: 1, to: 0 })

  expect(api.checkpoints).toEqual([
    { path: indexPath, content: indexBefore },
    { path: manifestPath, content: manifestBefore },
  ])
})

test('materialise publishes the manifest and created file without writing unlisted parts into the Index Note', async () => {
  const indexPath = 'report/_report_INDEX.md'
  const before = '# Report\n\n## Running order\n\n- [[Intended]]\n'
  await write(indexPath, before)
  await write('report/contents/existing.md', '# Existing\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({
    schema_version: 2,
    report_id: 'ai-2026-strategic-impact-agents-funding',
    title_matter: { subtitle: 'Offline copy' },
    vignettes: Array.from({ length: 14 }, (_, index) => `vignettes/${index + 1}.md`),
    content_root: 'contents',
    files: [{ id: 'existing', path: 'existing.md', role: 'appendix', annotatable: true, strip_title_matter: true }],
  }, null, 2))
  const api = harness()

  const result = await api.invoke('plan:materialise-part', { dir: 'report', index: 0 }) as { path: string }

  expect({
    firstCheckpoint: api.checkpoints[0],
    checkpointPaths: api.checkpoints.map((checkpoint) => checkpoint.path),
    diskChanges: api.diskChanges,
    collectionChanges: api.collectionChanges,
    indexUnchanged: await read(indexPath) === before,
  }).toEqual({
    firstCheckpoint: { path: `report/${MANIFEST_NAME}`, content: expect.any(String) },
    checkpointPaths: [`report/${MANIFEST_NAME}`, result.path],
    diskChanges: [[indexPath]],
    collectionChanges: [[indexPath, result.path, `report/${MANIFEST_NAME}`]],
    indexUnchanged: true,
  })
})

test('S2: a failed checkpoint after materialisation cannot turn the completed write into a reported failure', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Middle]]\n')
  const api = harness({ failCheckpointFor: (path) => path === 'report/01-middle.md' })

  const result = await api.invoke('plan:materialise-part', { dir: 'report', index: 0 }) as { path: string }

  expect(result.path).toBe('report/01-middle.md')
  expect(await read(result.path)).toContain('# Middle')
  expect(api.collectionChanges.at(-1)).toEqual([
    'report/_report_INDEX.md',
    result.path,
    `report/${MANIFEST_NAME}`,
  ])
})

const FOLIO_MANIFEST = '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md" },\n    { "path": "b.md" }\n  ]\n}\n'

async function folioFixture(): Promise<void> {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n')
  await write('report/a.md', '# Alpha\n')
  await write('report/b.md', '# Beta\n')
  await write('report/c.md', '# Gamma\n')
  await write('report/_report-structure.json', FOLIO_MANIFEST)
}

test('folio:move-piece, folio:add-pieces and folio:remove-added run the real writers, checkpoint first and publish', async () => {
  await folioFixture()
  const api = harness()
  const moved = await api.invoke('folio:move-piece', { dir: 'report', path: 'report/b.md', beforePath: 'report/a.md', expected: ['report/a.md', 'report/b.md'] })
  expect(moved).toMatchObject({ ok: true, order: ['report/b.md', 'report/a.md'] })
  expect(api.checkpoints.map((item) => item.path).sort()).toEqual(['report/_report-structure.json', 'report/_report_INDEX.md'])
  expect(api.collectionChanges.at(-1)).toContain('report/_report-structure.json')
  const added = await api.invoke('folio:add-pieces', { dir: 'report', paths: ['report/c.md'], expected: ['report/b.md', 'report/a.md'] })
  expect(added).toMatchObject({ ok: true, order: ['report/b.md', 'report/a.md', 'report/c.md'] })
  const removed = await api.invoke('folio:remove-added', { dir: 'report', paths: ['report/c.md'], expected: ['report/b.md', 'report/a.md', 'report/c.md'] })
  expect(removed).toMatchObject({ ok: true, order: ['report/b.md', 'report/a.md'] })
})

test('a refused folio change publishes nothing and checkpoints nothing', async () => {
  await folioFixture()
  const api = harness()
  const refused = await api.invoke('folio:move-piece', { dir: 'report', path: 'report/b.md', beforePath: 'report/a.md', expected: ['report/b.md', 'report/a.md'] })
  expect(refused).toMatchObject({ ok: false, stale: true })
  expect(api.checkpoints).toEqual([])
  expect(api.collectionChanges).toEqual([])
})

test('the folio channels refuse malformed input', async () => {
  const api = harness()
  await expect(api.invoke('folio:move-piece', { dir: 'report', path: 3, beforePath: null, expected: [] })).rejects.toThrow()
  await expect(api.invoke('folio:move-piece', { dir: 'report', path: 'a.md', beforePath: undefined, expected: [] })).rejects.toThrow()
  await expect(api.invoke('folio:add-pieces', { dir: 'report', paths: 'a.md', expected: [] })).rejects.toThrow()
  await expect(api.invoke('folio:remove-added', { dir: 'report', paths: ['a.md'], expected: [1] })).rejects.toThrow()
})

test('a Folio with a manifest and no Index Note: the folio channels checkpoint and write the manifest only, and publish the collection change', async () => {
  const manifest = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md', role: 'section' }, { path: 'b.md', role: 'section' }] }, null, 2)}\n`
  await write(`made/${MANIFEST_NAME}`, manifest)
  await write('made/a.md', '# Alpha\n')
  await write('made/b.md', '# Beta\n')
  await write('made/c.md', '# Gamma\n')
  const api = harness()
  const moved = await api.invoke('folio:move-piece', { dir: 'made', path: 'made/b.md', beforePath: 'made/a.md', expected: ['made/a.md', 'made/b.md'] })
  expect(moved).toEqual({ ok: true, changed: true, order: ['made/b.md', 'made/a.md'] })
  expect(api.checkpoints).toEqual([{ path: `made/${MANIFEST_NAME}`, content: manifest }])
  expect(api.collectionChanges).toEqual([[`made/${MANIFEST_NAME}`]])
  expect(api.diskChanges).toEqual([])
  const added = await api.invoke('folio:add-pieces', { dir: 'made', paths: ['made/c.md'], expected: ['made/b.md', 'made/a.md'] })
  expect(added).toEqual({ ok: true, changed: true, order: ['made/b.md', 'made/a.md', 'made/c.md'] })
  const removed = await api.invoke('folio:remove-added', { dir: 'made', paths: ['made/c.md'], expected: ['made/b.md', 'made/a.md', 'made/c.md'] })
  expect(removed).toEqual({ ok: true, changed: true, order: ['made/b.md', 'made/a.md'] })
  expect(api.collectionChanges.length).toBe(3)
  expect(JSON.parse(await read(`made/${MANIFEST_NAME}`)).files).toEqual([{ path: 'b.md', role: 'section' }, { path: 'a.md', role: 'section' }])
  await expect(read('made/_made_INDEX.md')).rejects.toThrow()
  // A stale request publishes nothing.
  await api.invoke('folio:move-piece', { dir: 'made', path: 'made/b.md', beforePath: null, expected: ['made/a.md', 'made/b.md'] })
  expect(api.collectionChanges.length).toBe(3)
})
