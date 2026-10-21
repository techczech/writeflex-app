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

function harness(options: { failCheckpointFor?: (path: string) => boolean; afterCheckpoint?: (path: string) => Promise<void> } = {}) {
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
      await options.afterCheckpoint?.(path)
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

test('the Folio outline IPC seam registers every channel', () => {
  const api = harness()
  expect([...api.handlers.keys()]).toEqual([
    'plan:read', 'plan:adopt-part', 'plan:insert-part', 'plan:move-part', 'plan:remove-part', 'plan:set-part-role',
    'plan:reorder-parts', 'plan:add-parts', 'plan:remove-added',
    'folio:move-piece', 'folio:add-pieces', 'folio:remove-added', 'plan:materialise-part', 'title:fix-part', 'title:fix-folio', 'title:undo', 'plan:set-heading-mode',
  ])
})

test('plan:add-parts, plan:reorder-parts and plan:remove-added run the Folio outline path on an Index-Note-only Folio outline', async () => {
  const index = '# Report\n\n## Running order\n\n- [[ch-3]]\n- [[Idea]]\n'
  await write('report/_report_INDEX.md', index)
  for (const name of ['ch-3', 'ch-1', 'ch-2']) await write(`report/${name}.md`, `# ${name}\n`)
  const api = harness()
  const seen = [{ title: 'ch-3', path: 'report/ch-3.md' }, { title: 'Idea', path: null }]
  const added = await api.invoke('plan:add-parts', { dir: 'report', paths: ['report/ch-2.md', 'report/ch-1.md'], expected: seen }) as { ok: boolean; parts: Array<{ title: string; path: string | null }>; undoToken: string }
  expect(added.ok).toBe(true)
  expect(typeof added.undoToken).toBe('string')
  expect(await read('report/_report_INDEX.md')).toBe(`${index}- [[ch-2]]\n- [[ch-1]]\n`)
  // Unwritten "Idea" keeps position 2; the three files are sorted into positions 1, 3 and 4.
  const sorted = await api.invoke('plan:reorder-parts', { dir: 'report', order: [3, 1, 2, 0], expected: added.parts }) as { ok: boolean; parts: Array<{ title: string; path: string | null }> }
  expect(sorted.ok).toBe(true)
  expect(await read('report/_report_INDEX.md')).toBe('# Report\n\n## Running order\n\n- [[ch-1]]\n- [[Idea]]\n- [[ch-2]]\n- [[ch-3]]\n')
  const back = await api.invoke('plan:reorder-parts', { dir: 'report', order: [3, 1, 2, 0], expected: sorted.parts }) as { ok: boolean; parts: unknown }
  expect(back.ok).toBe(true)
  // Sorted and sorted back: the Index Note holds exactly what the Add left, so its Undo is made.
  const undone = await api.invoke('plan:remove-added', { dir: 'report', token: added.undoToken }) as { ok: boolean }
  expect(undone.ok).toBe(true)
  expect(await read('report/_report_INDEX.md')).toBe(index)
  expect(api.collectionChanges.length).toBeGreaterThan(0)
  await expect(api.invoke('plan:reorder-parts', { dir: 'report', order: ['x'], expected: [] })).rejects.toThrow('Invalid running order.')
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
  await write('report/contents/intro.md', '# Intro\n')
  await write('report/contents/opening.md', '# Opening\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ content_root: 'contents', files: [{ path: 'intro.md' }] }))

  // The Index Note names no part, so the page shows the manifest's order (Intro); Opening is Not in the outline.
  const plan = await harness().invoke('plan:adopt-part', { dir: 'report', unlistedIndex: 0, expected: { title: 'Opening', path: 'report/contents/opening.md' } }) as { parts: Array<{ title: string }> }

  expect(plan.parts.map((part) => part.title)).toEqual(['Intro', 'Opening'])
  expect(await read('report/_report_INDEX.md')).toContain('- [[Intro]]\n- [[Opening]]')
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

test('plan:set-part-role executes the real writer and refuses an unknown role', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n- [[Middle]]\n')
  const plan = await harness().invoke('plan:set-part-role', { dir: 'report', index: 1, role: 'appendix', expected: card('Middle', null) }) as { parts: Array<{ title: string; role: string }> }
  expect(plan.parts.map((part) => part.role)).toEqual(['section', 'appendix'])
  expect(await read('report/_report_INDEX.md')).toContain('- [[Middle]] #appendix')
  await expect(harness().invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'hero', expected: card('Opening', null) })).rejects.toThrow('Invalid Folio outline role.')
  // The card the owner changed must be named.
  await expect(harness().invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'summary' })).rejects.toThrow()
})

test('plan:set-part-role refuses when the running order was reordered between display and request; nothing is written', async () => {
  await write('report/One.md', '# One\n')
  await write('report/Two.md', '# Two\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'One.md' }, { path: 'Two.md' }] }, null, 2))
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[One]]\n- [[Two]]\n')
  // The Plan showed [One, Two]; another writer reorders before the request runs.
  const shown = card('One', null, { path: 'report/One.md' })
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Two]]\n- [[One]]\n')
  const indexBefore = await read('report/_report_INDEX.md')
  const manifestBefore = await read(`report/${MANIFEST_NAME}`)
  const api = harness()
  await expect(api.invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'appendix', expected: shown })).rejects.toThrow(/running order changed/i)
  expect(await read('report/_report_INDEX.md')).toBe(indexBefore)
  expect(await read(`report/${MANIFEST_NAME}`)).toBe(manifestBefore)
  expect(api.checkpoints).toEqual([])
  // The card as it now stands is accepted.
  await api.invoke('plan:set-part-role', { dir: 'report', index: 1, role: 'appendix', expected: shown })
  expect(await read('report/_report_INDEX.md')).toContain('- [[One]] #appendix')
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

test('M3: the handler checkpoints the manifest before a Folio outline write changes it', async () => {
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
  const checkpoints = api.checkpoints.length
  const removed = await api.invoke('folio:remove-added', { dir: 'report', token: (added as { undoToken: string }).undoToken })
  expect(removed).toMatchObject({ ok: true, order: ['report/b.md', 'report/a.md'] })
  // The Undo checkpoints both documents before it writes them back, as every Plan write does.
  expect(api.checkpoints.slice(checkpoints).map((item) => item.path).sort()).toEqual(['report/_report-structure.json', 'report/_report_INDEX.md'])
  expect(api.collectionChanges.at(-1)).toContain('report/_report-structure.json')
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
  await expect(api.invoke('folio:remove-added', { dir: 'report', token: 7 })).rejects.toThrow()
  await expect(api.invoke('plan:remove-added', { dir: 'report', token: '' })).rejects.toThrow()
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
  expect(added).toMatchObject({ ok: true, changed: true, order: ['made/b.md', 'made/a.md', 'made/c.md'] })
  const removed = await api.invoke('folio:remove-added', { dir: 'made', token: (added as { undoToken: string }).undoToken })
  expect(removed).toEqual({ ok: true, changed: true, order: ['made/b.md', 'made/a.md'] })
  expect(api.collectionChanges.length).toBe(3)
  expect(JSON.parse(await read(`made/${MANIFEST_NAME}`)).files).toEqual([{ path: 'b.md', role: 'section' }, { path: 'a.md', role: 'section' }])
  await expect(read('made/_made_INDEX.md')).rejects.toThrow()
  // A stale request publishes nothing.
  await api.invoke('folio:move-piece', { dir: 'made', path: 'made/b.md', beforePath: null, expected: ['made/a.md', 'made/b.md'] })
  expect(api.collectionChanges.length).toBe(3)
})

test('plan:set-heading-mode with locate finds the Folio of a part and writes heading: none through the same guard', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  await write('report/opening.md', 'Words with no heading.\n')
  const api = harness()
  await api.invoke('plan:set-heading-mode', { path: 'report/opening.md', mode: 'none', locate: true })
  const text = await read('report/opening.md')
  expect(text).toContain('heading: none')
  expect(text).not.toContain('# ')
  expect(api.checkpoints.map((c) => c.path)).toEqual(['report/opening.md'])
})

test('plan:set-heading-mode with locate refuses a file that is not in any Folio outline', async () => {
  await write('loose/note.md', 'Words.\n')
  await expect(harness().invoke('plan:set-heading-mode', { path: 'loose/note.md', mode: 'none', locate: true })).rejects.toThrow()
  expect(await read('loose/note.md')).toBe('Words.\n')
})

// Merge-main review round 1, P2: the owner route's refusal answers like goal:set's, so the renderer raises the
// changed-on-disk notice for the version on disk; nothing is written.
test('plan:set-heading-mode with a basis the part no longer holds answers refused with the disk text, writing nothing', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  const outside = 'Words rewritten by another program.\n'
  await write('report/opening.md', outside)
  const api = harness()
  const answer = await api.invoke('plan:set-heading-mode', { path: 'report/opening.md', mode: 'none', locate: true, basis: { kind: 'disk', text: 'Words with no heading.\n' } })
  expect(answer).toEqual({ refused: 'disk-changed', path: 'report/opening.md', diskText: outside, message: 'report/opening.md changed on disk, so the editor\'s text was not written over it.' })
  expect(await read('report/opening.md')).toBe(outside)
  expect({ checkpoints: api.checkpoints, diskChanges: api.diskChanges, collectionChanges: api.collectionChanges }).toEqual({ checkpoints: [], diskChanges: [], collectionChanges: [] })
})

test('plan:set-heading-mode with a basis answers refused with the disk text when the part changes during the write', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  const seen = 'Words with no heading.\n'
  await write('report/opening.md', seen)
  const outside = 'Words rewritten by another program.\n'
  const api = harness({ afterCheckpoint: async (path) => { await write(path, outside) } })
  const answer = await api.invoke('plan:set-heading-mode', { path: 'report/opening.md', mode: 'none', locate: true, basis: { kind: 'disk', text: seen } }) as { refused?: string; diskText?: string | null }
  expect({ refused: answer.refused, diskText: answer.diskText }).toEqual({ refused: 'disk-changed', diskText: outside })
  expect(await read('report/opening.md')).toBe(outside)
  expect(api.diskChanges).toEqual([])
})

test('plan:set-heading-mode without a basis still throws when the part changes during the write', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  await write('report/opening.md', 'Words with no heading.\n')
  const outside = 'Words rewritten by another program.\n'
  const api = harness({ afterCheckpoint: async (path) => { await write(path, outside) } })
  await expect(api.invoke('plan:set-heading-mode', { path: 'report/opening.md', mode: 'none', locate: true })).rejects.toThrow('changed while its heading choice was being saved, so nothing was written')
  expect(await read('report/opening.md')).toBe(outside)
})

// Review round 2 (Sol): Put back and the role menu name the row the owner saw, checked under the Folio's lock.

const card = (title: string, gloss: string | null, extra: { path?: string | null; role?: string; tags?: string[] } = {}) => (
  { title, path: extra.path ?? null, gloss, role: extra.role ?? 'section', tags: extra.tags ?? [] }
)

test('round 2 P1: Put back names the file shown; a file listed meanwhile ahead of it is refused, nothing is written', async () => {
  await write('report/a.md', '# Alpha\n')
  await write('report/deep/z.md', '# Zulu\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }] }, null, 2))
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Alpha]]\n')
  const api = harness()
  const shown = await api.invoke('plan:read', { dir: 'report' }) as { unlisted: Array<{ title: string; path: string }> }
  expect(shown.unlisted.map((part) => part.path)).toEqual(['report/deep/z.md'])
  const zulu = { title: shown.unlisted[0].title, path: shown.unlisted[0].path }
  // Another writer adds deep/b.md before the request runs: index 0 is now Beta.
  await write('report/deep/b.md', '# Beta\n')
  const indexBefore = await read('report/_report_INDEX.md')
  const manifestBefore = await read(`report/${MANIFEST_NAME}`)
  await expect(api.invoke('plan:adopt-part', { dir: 'report', unlistedIndex: 0, expected: zulu })).rejects.toThrow(/look again/i)
  expect(await read('report/_report_INDEX.md')).toBe(indexBefore)
  expect(await read(`report/${MANIFEST_NAME}`)).toBe(manifestBefore)
  expect(api.checkpoints).toEqual([])
  // A request that names no file is invalid.
  await expect(api.invoke('plan:adopt-part', { dir: 'report', unlistedIndex: 0 })).rejects.toThrow('Invalid Folio outline adoption.')
  // The row as it now stands is put back: Zulu, not Beta.
  const after = await api.invoke('plan:adopt-part', { dir: 'report', unlistedIndex: 1, expected: zulu }) as { parts: Array<{ path: string | null }> }
  expect(after.parts.map((part) => part.path)).toEqual(['report/a.md', 'report/deep/z.md'])
})

test('round 2 P2: the role menu tells apart unwritten cards with one title by their gloss; a swap is refused', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Idea]] — First idea\n- [[Idea]] — Second idea\n')
  const shown = card('Idea', 'First idea')
  // Another writer swaps the two cards before the request runs.
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Idea]] — Second idea\n- [[Idea]] — First idea\n')
  const before = await read('report/_report_INDEX.md')
  const api = harness()
  await expect(api.invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'appendix', expected: shown })).rejects.toThrow(/running order changed/i)
  expect(await read('report/_report_INDEX.md')).toBe(before)
  await api.invoke('plan:set-part-role', { dir: 'report', index: 1, role: 'appendix', expected: shown })
  expect(await read('report/_report_INDEX.md')).toBe('# Report\n\n## Running order\n\n- [[Idea]] — Second idea\n- [[Idea]] — First idea #appendix\n')
})

test('round 2 P2: a card that reads exactly like another is refused as ambiguous; a card naming only title and file is invalid', async () => {
  const index = '# Report\n\n## Running order\n\n- [[Idea]] — Same\n- [[Idea]] — Same\n'
  await write('report/_report_INDEX.md', index)
  const api = harness()
  await expect(api.invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'appendix', expected: card('Idea', 'Same') })).rejects.toThrow(/read the same/i)
  expect(await read('report/_report_INDEX.md')).toBe(index)
  await expect(api.invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'appendix', expected: { title: 'Idea', path: null } })).rejects.toThrow('Invalid Folio outline role.')
})
