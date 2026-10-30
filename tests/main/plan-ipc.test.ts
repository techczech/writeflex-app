import { pinnedIndex } from '../helpers/folio-file-identity'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { readPlan } from '../../src/main/plan'
import { MANIFEST_NAME } from '../../src/main/folio'
import { Workspace } from '../../src/main/workspace'
import { roomStateKey } from '../../src/main/folio-room'
import { mixedFolio } from '../fixtures/folio-room/folio-room-fixtures'

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
  const appState = new Map<string, unknown>()
  const checkpoints: Array<{ path: string; content: string }> = []
  const collectionChanges: string[][] = []
  const diskChanges: string[][] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    identityStore: { folioRoomState: key => appState.get(key), setFolioRoomState: (key, value) => { appState.set(key, value); return true } },
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
  return { handlers, checkpoints, collectionChanges, diskChanges, invoke, appState }
}

test('the Folio outline IPC seam registers every channel', () => {
  const api = harness()
  expect([...api.handlers.keys()]).toEqual([
    'plan:read', 'plan:identity-check', 'plan:open', 'plan:adopt-part', 'plan:insert-part', 'plan:move-part', 'plan:remove-part', 'plan:set-part-role',
    'plan:reorder-parts', 'plan:room-new-card', 'plan:room-remove-card', 'plan:room-map', 'plan:room-authoring', 'plan:export-order', 'plan:align-manifest', 'plan:add-parts', 'plan:remove-added',
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
  expect(await read('report/_report_INDEX.md')).toBe(pinnedIndex(`${index}- [[ch-2]]\n- [[ch-1]]\n`, {"ch-2":"./ch-2.md|ch-2","ch-1":"./ch-1.md|ch-1","ch-3":"./ch-3.md|ch-3"}))
  // Unwritten "Idea" keeps position 2; the three files are sorted into positions 1, 3 and 4.
  const sorted = await api.invoke('plan:reorder-parts', { dir: 'report', order: [3, 1, 2, 0], expected: added.parts }) as { ok: boolean; parts: Array<{ title: string; path: string | null }> }
  expect(sorted.ok).toBe(true)
  expect(await read('report/_report_INDEX.md')).toBe(pinnedIndex('# Report\n\n## Running order\n\n- [[ch-1]]\n- [[Idea]]\n- [[ch-2]]\n- [[ch-3]]\n', {"ch-2":"./ch-2.md|ch-2","ch-1":"./ch-1.md|ch-1","ch-3":"./ch-3.md|ch-3"}))
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
  expect(await read('report/_report_INDEX.md')).toContain(pinnedIndex('- [[Intro]]\n- [[Opening]]', {"Intro":"./contents/intro.md|Intro","Opening":"./contents/opening.md|Opening"}))
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
  // A matching card still needs the explicit order repair before changing this inconsistent Folio.
  const { alignManifestWithPlan, readPlan } = await import('../../src/main/plan')
  const fresh = (await readPlan(ws, 'report'))!
  await alignManifestWithPlan(ws, 'report', { parts: fresh.parts, manifestExists: true })
  await api.invoke('plan:set-part-role', { dir: 'report', index: 1, role: 'appendix', expected: shown })
  expect(await read('report/_report_INDEX.md')).toContain(pinnedIndex('- [[One]] #appendix', {"One":"./One.md|One"}))
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

test('an unresolved idea beside an unbound manifest section remains startable and never guesses membership', async () => {
  const source = '## Running order\n- [[Idea]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/existing.md', '# Chapter\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ files: [{ path: 'existing.md' }] }))
  const api = harness()
  expect((await api.invoke('plan:read', { dir: 'report' }) as { parts: unknown[] }).parts[0]).toMatchObject({ path: null, title: 'Idea' })
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
  expect(await api.invoke('plan:open', { dir: 'report', root })).toEqual({ changed: false })
  expect(await read('report/_report_INDEX.md')).toBe(source)
  expect(api.checkpoints).toEqual([])
  expect((await api.invoke('plan:read', { dir: 'report' }) as { parts: unknown[] }).parts[0]).not.toHaveProperty('resolution')
  const result = await api.invoke('plan:materialise-part', { dir: 'report', index: 0 }) as { path: string }
  expect(result.path).toBe('report/01-idea.md')
  expect(await read('report/existing.md')).toBe('# Chapter\n')
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

// S-m3 (r1 review): the two Folio room channels refuse malformed and out-of-Folio input before any read or write.
async function treeOf(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return (await readdir(join(root, dir), { recursive: true })).map(String).sort()
}
function countReads(): { reads: () => number } {
  let reads = 0
  const readFile = ws.readFile.bind(ws), listFiles = ws.listFiles.bind(ws)
  ws.readFile = ((...args: Parameters<typeof ws.readFile>) => { reads++; return readFile(...args) }) as typeof ws.readFile
  ws.listFiles = ((...args: Parameters<typeof ws.listFiles>) => { reads++; return listFiles(...args) }) as typeof ws.listFiles
  return { reads: () => reads }
}

test('plan:room-map refuses malformed and out-of-Folio input before any read or write', async () => {
  await mixedFolio(root)
  await write('other/_other_INDEX.md', '# Other\n\n## Running order\n\n- [[One]]\n')
  const api = harness()
  const counter = countReads()
  const before = await treeOf('')
  const stateKey = roomStateKey(ws, 'mixed')
  const node = { id: 'n1', type: 'text', text: 'Idea', x: 0, y: 0, width: 200, height: 60 }
  for (const input of [
    null, 'mixed', { dir: 'mixed', stateKey, ops: [] },
    { dir: 'mixed', stateKey, session: '', ops: [{ kind: 'addNode', node }] },
    { dir: 'mixed', stateKey, session: 'x'.repeat(129), ops: [{ kind: 'addNode', node }] },
    { dir: 'mixed', stateKey: 'stale', session: 's', ops: [{ kind: 'addNode', node }] },
    { dir: 'other', stateKey, session: 's', ops: [{ kind: 'addNode', node }] },
    { dir: '../outside', stateKey, session: 's', ops: [{ kind: 'addNode', node }] },
    { dir: join(root, 'mixed'), stateKey, session: 's', ops: [{ kind: 'addNode', node }] },
    { dir: 7, stateKey, session: 's', ops: [{ kind: 'addNode', node }] },
    { dir: 'mixed', stateKey, session: 's', ops: 'addNode' },
    { dir: 'mixed', stateKey, session: 's', ops: [{ kind: 'deleteEverything' }] },
    { dir: 'mixed', stateKey, session: 's', ops: [{ kind: 'addNode', node: { ...node, x: Number.NaN } }] },
  ]) await expect(api.invoke('plan:room-map', input), JSON.stringify(input)).rejects.toThrow()
  expect(counter.reads()).toBe(0)
  expect(api.checkpoints).toEqual([])
  expect(api.collectionChanges).toEqual([])
  expect(await treeOf('')).toEqual(before)
})

test('plan:room-authoring refuses malformed and out-of-Folio input before any read or write', async () => {
  await mixedFolio(root)
  await write('plain/note.md', '# Plain\n')
  const api = harness()
  const counter = countReads()
  const before = await treeOf('')
  const stateKey = roomStateKey(ws, 'mixed')
  const notes = { kind: 'notes', part: 'Intro', expect: null, value: 'Notes.\n\n' }
  const card = { title: 'Intro', path: 'mixed/intro.md' }
  for (const input of [
    null, { dir: 'mixed' }, { dir: 'mixed', request: null }, { dir: 'mixed', request: 'evidence' }, { dir: 'mixed', request: { op: 'nope' } },
    { dir: 'mixed', request: { op: 'evidence', stateKey, session: 's', ops: 'notes' } },
    { dir: 'mixed', request: { op: 'evidence', stateKey, session: 's', ops: [] } },
    { dir: 'mixed', request: { op: 'evidence', stateKey, session: 's', ops: [{ ...notes, kind: 'rewrite' }] } },
    { dir: 'mixed', request: { op: 'evidence', stateKey, session: 's', ops: [{ ...notes, value: 7 }] } },
    { dir: 'mixed', request: { op: 'evidence', stateKey, session: '', ops: [notes] } },
    { dir: 'mixed', request: { op: 'evidence', stateKey, session: 'x'.repeat(129), ops: [notes] } },
    { dir: 'mixed', request: { op: 'evidence', stateKey: 7, session: 's', ops: [notes] } },
    { dir: 'mixed', request: { op: 'attachEvidence', part: 'Intro', stateKey, session: 's', source: { kind: 'file' } } },
    { dir: 'mixed', request: { op: 'remove', indices: [1], expected: [{ title: 7 }] } },
    { dir: 'mixed', request: { op: 'labels', basis: 7, change: { op: 'add', name: 'X' } } },
    { dir: 'mixed', request: { op: 'labels', basis: null, change: { op: 'drop' } } },
    { dir: 'mixed', request: { op: 'line', index: 1, expected: card, change: { gloss: 'x', path: 'y' } } },
    { dir: 'mixed', request: { op: 'status', index: 1.5, expected: card, status: 'draft' } },
    { dir: 'mixed', request: { op: 'clearFlag', index: 1, expected: card, from: 0, fingerprint: 'short' } },
    { dir: '../outside', request: { op: 'evidence', stateKey, session: 's', ops: [notes] } },
    { dir: join(root, 'mixed'), request: { op: 'evidence', stateKey, session: 's', ops: [notes] } },
  ]) await expect(api.invoke('plan:room-authoring', input), JSON.stringify(input)).rejects.toThrow()
  expect(counter.reads()).toBe(0)
  // A request for another Folio's room (its state key) is refused by the owner check, before the evidence file is read.
  expect(await api.invoke('plan:room-authoring', { dir: 'plain', request: { op: 'evidence', stateKey, session: 's', ops: [notes] } })).toMatchObject({ ok: false })
  expect(counter.reads()).toBe(0)
  // A plain folder is not a Folio: refused before any write.
  expect(await api.invoke('plan:room-authoring', { dir: 'plain', request: { op: 'evidence', stateKey: roomStateKey(ws, 'plain'), session: 's', ops: [notes] } })).toMatchObject({ ok: false })
  expect(api.checkpoints).toEqual([])
  expect(api.collectionChanges).toEqual([])
  expect(await treeOf('')).toEqual(before)
})


test('Put back uses the selected file identity when its display title changes after the read', async () => {
  await write('report/one.md', '# One\n')
  await write('report/two.md', '# Old title\n')
  await write('report/_report_INDEX.md', '## Running order\n- [[One]]\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ files: [{ path: 'one.md' }] }))
  await write('report/two.md', '# New title\n\nKeep this text.\n')
  const result = await harness().invoke('plan:adopt-part', { dir: 'report', unlistedIndex: 0, expected: { title: 'Old title', path: 'report/two.md' } }) as { parts: Array<{ path: string }> }
  expect(result.parts.map(part => part.path)).toEqual(['report/one.md', 'report/two.md'])
  expect(await read('report/two.md')).toBe('# New title\n\nKeep this text.\n')
})


test('author open pins proven links in one Index write, preserves every surrounding byte and records Undo', async () => {
  const index = 'report/_report_INDEX.md'
  const source = '# Paper\r\n\r\n## Running order\r\n\r\n  7. [[Opening|My alias]] — Words #draft\r\n<!-- keep -->\r\n* [[Same]] #appendix\r\n- [[Idea]]\r\n\r\n## Notes\r\nKeep exactly.\r\n'
  await write(index, source)
  await write('report/a.md', '# Opening\n')
  await write('report/b.md', '# Same\n')
  await write('report/c.md', '# Same\n')
  const api = harness()
  expect(await api.invoke('plan:read', { dir: 'report' })).not.toBeNull()
  expect(await read(index)).toBe(source)
  const writes: string[] = []
  ws.onDocumentWritten = path => writes.push(path)
  const opened = await api.invoke('plan:open', { dir: 'report', root }) as { changed: boolean; undoToken: string }
  expect(opened.changed).toBe(true)
  expect(await read(index)).toBe(source.replace('[[Opening|My alias]]', '[[./a.md|My alias]]'))
  expect(writes).toEqual([index])
  expect(api.checkpoints).toEqual([{ path: index, content: source }])
  expect(api.diskChanges).toContainEqual([index])
  expect((await api.invoke('plan:open', { dir: 'report', root }) as { changed: boolean }).changed).toBe(false)
  expect(writes).toEqual([index])
  expect((await api.invoke('plan:remove-added', { dir: 'report', token: opened.undoToken }) as { ok: boolean }).ok).toBe(true)
  expect(await read(index)).toBe(source)
  expect((await api.invoke('plan:read', { dir: 'report' }))).not.toBeNull()
  expect(await read(index)).toBe(source)
})

test('author-open pinning refuses stale Index bytes and another workspace without overwriting text', async () => {
  const index = 'report/_report_INDEX.md'
  await write(index, '## Running order\n- [[Opening]]\n')
  await write('report/a.md', '# Opening\n')
  const api = harness({ afterCheckpoint: async path => { if (path === index) await write(index, '## Running order\n- [[Opening]]\nOwner text.\n') } })
  await expect(api.invoke('plan:open', { dir: 'report', root: root + '-elsewhere' })).rejects.toThrow('Collection changed')
  await expect(api.invoke('plan:open', { dir: 'report', root })).rejects.toThrow('changed')
  expect(await read(index)).toContain('Owner text.')
  expect(api.diskChanges).toEqual([])
})

for (const manifest of [false, true]) test(`author-open file identity survives a cold read after external retitling (${manifest ? 'manifest' : 'Index only'})`, async () => {
  const source = '## Running order\n- [[Opening]] — Keep this. #summary\n- [[Idea]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Opening\n')
  if (manifest) await write(`report/${MANIFEST_NAME}`, JSON.stringify({ files: [{ path: 'a.md' }] }))
  const api = harness()
  expect(await api.invoke('plan:open', { dir: 'report', root })).toMatchObject({ changed: true })
  const pinned = await read('report/_report_INDEX.md')
  expect(pinned).toBe(source.replace('[[Opening]]', '[[./a.md|Opening]]'))
  await write('report/a.md', '# Changed | # title\n\nAuthor text.\n')
  const cold = await readPlan(new Workspace(root), 'report')
  expect(cold!.parts.map(p => p.path)).toEqual(['report/a.md', null])
  expect(cold!.parts[0].title).toBe('Changed | # title')
  expect(cold!.parts[1].resolution).toBeUndefined()
  expect(await read('report/_report_INDEX.md')).toBe(pinned)
})

test('author open never pins an ambiguous line using an earlier live proof', async () => {
  const source = '## Running order\n- [[Opening]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Opening\n')
  const api = harness()
  await api.invoke('plan:read', { dir: 'report' })
  await write('report/b.md', '# Opening\n')
  expect(await api.invoke('plan:open', { dir: 'report', root })).toEqual({ changed: false })
  expect(await read('report/_report_INDEX.md')).toBe(source)
  expect(api.checkpoints).toEqual([])
})

test('the first manifest-only page move creates the Index Note holding file targets', async () => {
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] }))
  await write('report/a.md', '# Alpha\n')
  await write('report/b.md', '# Beta\n')
  // This harness reads existing checkpoint bytes; use the writer directly to checkpoint absence.
  const { movePart } = await import('../../src/main/plan')
  const checkpoints: string[] = []
  const moved = await movePart(ws, 'report', 0, 1, { beforeIndexWrite: async path => { checkpoints.push(path) } })
  expect(moved.parts.map(p => p.path)).toEqual(['report/b.md', 'report/a.md'])
  expect(checkpoints).toEqual(['report/_report_INDEX.md'])
  expect(await read('report/_report_INDEX.md')).toContain('[[./b.md|Beta]]')
})

for (const operation of ['open', 'move'] as const) test(`${operation}: a pinned chapter never captures an idea after a retitle`, async () => {
  const source = '## Running order\n- [[./a.md|Chapter]]\n- [[Method]]\n- [[Other]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Method\n')
  await write('report/b.md', '# Other\n')
  const api = harness()
  if (operation === 'open') await api.invoke('plan:open', { dir: 'report', root })
  else { const { movePart } = await import('../../src/main/plan'); await movePart(ws, 'report', 0, 2) }
  const text = await read('report/_report_INDEX.md')
  expect(text).toContain('- [[Method]]')
  expect((text.match(/\[\[\.\/a.md/g) ?? []).length).toBe(1)
  const plan = (await readPlan(ws, 'report'))!
  expect(plan.parts.find(part => part.title === 'Method' && part.path === null)).toBeDefined()
})

test('all pinning rules: duplicate resolutions, notes, research, outside content root and unsafe filenames remain untouched', async () => {
  const source = '## Running order\n- [[Same|First]]\n- [[Same|Second]]\n- [[Notes]]\n- [[Study]]\n- [[Unsafe]]\n- [[Good#Sec]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Same\n')
  await write('report/notes.md', '# Notes\n')
  await write('report/research/study.md', '# Study\n')
  await write('report/x#1.md', '# Unsafe\n')
  await write('report/good.md', '# Good\n')
  const api = harness()
  await api.invoke('plan:open', { dir: 'report', root })
  expect(await read('report/_report_INDEX.md')).toBe(source.replace('[[Good#Sec]]', '[[./good.md#Sec|Good]]'))
  expect((await readPlan(ws, 'report'))!.parts.find(part => part.title === 'Notes')!.path).toBe('report/notes.md')
  // Conventional notes files and support folders stay outside chapter pinning.
  await write('report/notes/not-a-chapter.md', '# In notes\n')
  await write('report/_report_INDEX.md', '## Running order\n- [[./notes/not-a-chapter.md|Keep]]\n')
  expect(await api.invoke('plan:identity-check', { dir: 'report', root, force: true })).toBe(false)
})

test('opening attempt persists across Undo and a new handler registration; explicit command may rerun', async () => {
  await write('report/_report_INDEX.md', '## Running order\n- [[Opening]]\n')
  await write('report/a.md', '# Opening\n')
  const state = new Map<string, unknown>()
  const handlers = () => {
    const registered = new Map<string, PlanIpcHandler>()
    registerPlanIpcHandlers({ handle: (channel, handler) => registered.set(channel, handler) }, {
      stateForSender: () => ws, requireWorkspace: ws => ws,
      identityStore: { folioRoomState: key => state.get(key), setFolioRoomState: (key, value) => { state.set(key, value); return true } },
      checkpointFile: async () => {}, notifyCollectionChanged: () => {}, notifyChangedOnDisk: () => {},
    })
    return (channel: string, input: unknown) => registered.get(channel)!({ sender: { id: 1 } }, input)
  }
  const invoke = handlers()
  expect(await invoke('plan:identity-check', { dir: 'report', root })).toBe(true)
  const opened = await invoke('plan:open', { dir: 'report', root }) as { undoToken: string }
  expect((await invoke('plan:remove-added', { dir: 'report', token: opened.undoToken }) as { ok: boolean }).ok).toBe(true)
  const restarted = handlers()
  expect(await restarted('plan:identity-check', { dir: 'report', root })).toBe(false)
  expect(await restarted('plan:open', { dir: 'report', root })).toEqual({ changed: false })
  expect(await restarted('plan:identity-check', { dir: 'report', root, force: true })).toBe(true)
  expect(await restarted('plan:open', { dir: 'report', root, force: true })).toMatchObject({ changed: true })
})

test('N3: an unresolved line beside a missing manifest file reads as before and stays startable', async () => {
  const source = '## Running order\n- [[Idea]]\n'
  await write('report/_report_INDEX.md', source)
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ files: [{ path: 'gone.md' }] }))
  const api = harness()
  expect((await api.invoke('plan:read', { dir: 'report' }) as { parts: unknown[] }).parts[0]).toMatchObject({ path: null, title: 'Idea' })
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
  expect(await read('report/_report_INDEX.md')).toBe(source)
  expect((await api.invoke('plan:materialise-part', { dir: 'report', index: 0 }) as { path: string }).path).toBe('report/01-idea.md')
})

test('N6 accepted limit: an unrecorded retitle can make an idea title resolve before first linking', async () => {
  const source = '## Running order\n- [[Chapter]]\n- [[Method]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Method\n')
  const api = harness()
  const plan = await api.invoke('plan:read', { dir: 'report' }) as { parts: Array<{ path: string | null }> }
  expect(plan.parts.map(part => part.path)).toEqual([null, 'report/a.md'])
  await api.invoke('plan:open', { dir: 'report', root })
  expect(await read('report/_report_INDEX.md')).toBe(source.replace('[[Method]]', '[[./a.md|Method]]'))
})

test('automatic linking refuses missing app state instead of falling back to process memory', async () => {
  const source = '## Running order\n- [[Opening]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Opening\n')
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ws, requireWorkspace: ws => ws,
    checkpointFile: async () => {}, notifyCollectionChanged: () => {}, notifyChangedOnDisk: () => {},
  })
  await expect(handlers.get('plan:open')!({ sender: { id: 1 } }, { dir: 'report', root })).rejects.toThrow('app state is unavailable')
  expect(await read('report/_report_INDEX.md')).toBe(source)
})

for (const retitled of [false, true]) test(`N2: opening never pairs a hand-reordered Index with manifest positions (${retitled})`, async () => {
  const source = '# Paper\r\n## Running order\r\n- [[Beta]] — second file first\r\n- [[Alpha]]\r\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', retitled ? '# Changed A\n' : '# Alpha\n')
  await write('report/b.md', retitled ? '# Changed B\n' : '# Beta\n')
  const manifest = JSON.stringify({ files: [{ path: 'a.md' }, { path: 'b.md' }] })
  await write(`report/${MANIFEST_NAME}`, manifest)
  const api = harness()
  expect((await api.invoke('plan:read', { dir: 'report' }) as { parts: Array<{ path: string | null }> }).parts.map(part => part.path)).toEqual(retitled ? [null, null] : ['report/b.md', 'report/a.md'])
  await api.invoke('plan:open', { dir: 'report', root })
  expect(await read('report/_report_INDEX.md')).toBe(retitled ? source : source.replace('[[Beta]]', '[[./b.md|Beta]]').replace('[[Alpha]]', '[[./a.md|Alpha]]'))
  expect(await read(`report/${MANIFEST_NAME}`)).toBe(manifest)
})

test('N7: Notes, Sources and Archive chapters retain read membership while pinning skips them', async () => {
  const source = '## Running order\n- [[Notes]]\n- [[Sources]]\n- [[Archive]]\n'
  await write('report/_report_INDEX.md', source)
  for (const name of ['Notes', 'Sources', 'Archive']) await write(`report/${name}.md`, `# ${name}\n`)
  const api = harness()
  expect((await api.invoke('plan:read', { dir: 'report' }) as { parts: Array<{ path: string }> }).parts.map(part => part.path)).toEqual(['report/Notes.md', 'report/Sources.md', 'report/Archive.md'])
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
  expect(await read('report/_report_INDEX.md')).toBe(source)
})

test('N5: transient linking failure and empty preflight never consume the automatic opportunity', async () => {
  const source = '## Running order\n- [[Opening]]\n'
  await write('report/_report_INDEX.md', source)
  let fail = true
  const api = harness({ failCheckpointFor: () => fail })
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
  await write('report/a.md', '# Opening\n')
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(true)
  await expect(api.invoke('plan:open', { dir: 'report', root })).rejects.toThrow('checkpoint')
  expect(await read('report/_report_INDEX.md')).toBe(source)
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(true)
  fail = false
  expect(await api.invoke('plan:open', { dir: 'report', root })).toMatchObject({ changed: true })
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
})

test('pinned unaliased links count as linked without an inventory or a new label', async () => {
  await write('report/a.md', '# Heading\n')
  const api = harness()
  let inventories = 0
  const list = ws.listFiles.bind(ws)
  ws.listFiles = async () => { inventories++; return list() }
  for (const link of ['[[./a.md]]', '[[./a.md#Sec]]', '[[./a.md|Alias]]']) {
    const source = `## Running order\n- ${link}\n`
    await write('report/_report_INDEX.md', source)
    expect(await api.invoke('plan:identity-check', { dir: 'report', root, force: true })).toBe(false)
    expect(await read('report/_report_INDEX.md')).toBe(source)
  }
  expect(inventories).toBe(0)
})

test('N5: Undo Turn back never re-arms a marked Folio', async () => {
  const source = '## Running order\n- [[Opening]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Opening\n')
  await write(`report/${MANIFEST_NAME}`, JSON.stringify({ files: [{ path: 'a.md' }] }))
  const api = harness()
  const opened = await api.invoke('plan:open', { dir: 'report', root }) as { undoToken: string }
  await api.invoke('plan:remove-added', { dir: 'report', token: opened.undoToken })
  const { turnBackIntoCollection, restoreTurnedBackFolio } = await import('../../src/main/folio-conversion')
  await turnBackIntoCollection(ws, 'report')
  expect(await restoreTurnedBackFolio(ws, 'report')).not.toBeNull()
  expect(await read('report/_report_INDEX.md')).toBe(source)
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
})

test('unaliased labels stay consistent with the parser while canonical path links keep their exact bytes', async () => {
  const { parsePlanLine } = await import('../../src/shared/plan-line')
  const source = '## Running order\n- [[Literal%23]]\n- [[./b.md]]\n'
  await write('report/_report_INDEX.md', source)
  await write('report/a.md', '# Literal%23\n')
  await write('report/b.md', '# Other heading\n')
  await harness().invoke('plan:open', { dir: 'report', root })
  const written = await read('report/_report_INDEX.md')
  expect(parsePlanLine(written.split('\n')[1])!.title).toBe(parsePlanLine(source.split('\n')[1])!.title)
  expect(written).toContain('- [[./b.md]]\n')
})

test('N5: an empty preflight records nothing; a completed no-op linking records completion', async () => {
  await write('report/_report_INDEX.md', '## Running order\n- [[./a.md]]\n')
  await write('report/a.md', '# A\n')
  const api = harness()
  expect(await api.invoke('plan:identity-check', { dir: 'report', root })).toBe(false)
  expect(api.appState.size).toBe(0)
  expect(await api.invoke('plan:open', { dir: 'report', root })).toEqual({ changed: false })
  expect(api.appState.get(roomStateKey(ws, 'report'))).toMatchObject({ identityLinksAttempted: true })
  expect(api.checkpoints).toEqual([])
})


test('section role IPC notifies the changed part as well as the Index Note', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  await write('report/opening.md', '# Opening\n')
  const plan = (await readPlan(ws, 'report'))!
  const api = harness()
  await api.invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'section-page', expected: plan.parts[0] })
  expect(api.diskChanges.flat()).toContain('report/opening.md')
  expect(api.diskChanges.flat()).toContain(plan.indexPath)
})

test('forward section role IPC writes through the pinned Folio workspace', async () => {
  await write('report/_report_INDEX.md', '# Report\n\n## Running order\n\n- [[Opening]]\n')
  await write('report/opening.md', '# Opening\n')
  const plan = (await readPlan(ws, 'report'))!
  const save = ws.saveFileWithoutReadBack.bind(ws)
  const pins: unknown[] = []
  ws.saveFileWithoutReadBack = async (path, text, options) => { if (path === 'report/opening.md') pins.push(options?.inFolder); return save(path, text, options) }
  await harness().invoke('plan:set-part-role', { dir: 'report', index: 0, role: 'section-page', expected: plan.parts[0] })
  expect(pins).toHaveLength(1)
  expect(pins[0]).toMatchObject({ real: join(await import('node:fs/promises').then(fs => fs.realpath(root)), 'report') })
})
