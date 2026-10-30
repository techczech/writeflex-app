import { pinnedIndex } from '../helpers/folio-file-identity'
/**
 * Ticket 06 (Folio room): two optional parameters on the Plan's document commit, each with today's behaviour when absent.
 * A. `createManifest` on the order writes (`reorderParts` via `plan:reorder-parts`, `movePart`, `insertPart`; spec D-ORD-2):
 *    a Folio with an Index Note and no manifest gets its manifest in the same commit, and export and sharing follow it.
 * B. `renumber` on `commitPlanDocuments` / `saveIndex` (spec D-LINE-2): false keeps every ordered marker as written.
 * Real files in a temp dir; each refusal is checked to write nothing.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBundle } from '../../src/main/export'
import { MANIFEST_NAME, orderFor } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { commitPlanLinesForTest, insertPart, movePart, readFolioPlan, readPlan, reorderParts } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { planPartKeys, reorderPlanParts } from '../../src/main/plan-running-order'
import { folioRunningOrder } from '../../src/main/sharing-folio'
import { Workspace } from '../../src/main/workspace'

let root: string
let out: string
let ws: Workspace
const DIR = 'paper'
const INDEX = `${DIR}/_paper_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const PARTS = ['alpha', 'beta', 'gamma', 'notes']
const p = (name: string) => `${DIR}/${name}.md`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-plan-options-'))
  out = await mkdtemp(join(tmpdir(), 'wf-plan-options-out-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

const read = (path: string) => readFile(join(root, path), 'utf8')
const exists = (path: string) => Bun.file(join(root, path)).exists()

/** F-INDEX-ONLY: an Index Note with a running order (three written parts, one unwritten) and no manifest; `notes` is not in the outline. */
const INDEX_ONLY = '---\nkind: folio\n---\n# Paper\n\nCover prose.\n\n## Running order\n\n- [[alpha]] — the opening\n- [[beta]]\n- [[Unwritten idea]]\n- [[gamma]] #appendix\n\n## After\n\nTail.\n'

async function indexOnlyFolio(index = INDEX_ONLY): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  for (const name of PARTS) await writeFile(join(root, p(name)), `---\nextra: ${name}\n---\n# ${name}\n\nText of ${name}.\n`)
  await writeFile(join(root, INDEX), index)
  invalidateFolioPlaces(root)
}

async function withManifest(files: string[]): Promise<void> {
  await writeFile(join(root, MANIFEST), `${JSON.stringify({ schema_version: 1, content_root: '', title: 'Paper', files: files.map((name) => ({ path: `${name}.md`, keep: name })) }, null, 2)}\n`)
  invalidateFolioPlaces(root)
}

async function partBytes(): Promise<string[]> {
  return Promise.all(PARTS.map((name) => read(p(name))))
}

async function folderListing(): Promise<string[]> {
  return (await readdir(join(root, DIR))).sort()
}

async function keys() {
  const plan = await readPlan(ws, DIR)
  if (!plan) throw new Error('no plan')
  return planPartKeys(plan)
}

/** The part headings of the HTML export, in the order the page holds them. */
async function exportedOrder(): Promise<string[]> {
  const target = join(out, `export-${Date.now()}-${Math.random()}.html`)
  await exportBundle(ws, { dir: DIR, format: 'html', target })
  const page = await readFile(target, 'utf8')
  return [...page.matchAll(/Text of (\w+)\./g)].map((match) => match[1])
}

async function sharedOrder(): Promise<string[]> {
  return ((await folioRunningOrder(root, DIR)) ?? []).map((entry) => entry.path)
}

function harness() {
  const handlers = new Map<string, PlanIpcHandler>()
  const checkpoints: string[] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { checkpoints.push(path) },
    notifyCollectionChanged: () => {},
    notifyChangedOnDisk: () => {},
  })
  const invoke = async (channel: string, input: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler({ sender: { id: 7 } }, input)
  }
  return { invoke, checkpoints }
}

/** Run `act` with every save of `path` replaced by `replace` (then nothing else is changed by this hook). */
function onSaveOf(path: string, replace: (original: Workspace['saveFileWithoutReadBack'], content: string, options: Parameters<Workspace['saveFileWithoutReadBack']>[2]) => Promise<void>): () => void {
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (target: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (target === path) return replace(original, content, options)
    return original(target, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  return () => { ws.saveFileWithoutReadBack = original }
}

// A. createManifest

test('F-INDEX-ONLY: a reorder through plan:reorder-parts with createManifest creates the manifest in the new order, and export and sharing follow it (RW-4)', async () => {
  await indexOnlyFolio()
  const parts = await partBytes()
  // Before: no manifest, so export and sharing follow file names.
  expect(await sharedOrder()).toEqual(PARTS.map(p))
  const expected = await keys()
  // gamma, Unwritten idea, alpha, beta
  const result = await harness().invoke('plan:reorder-parts', { dir: DIR, order: [3, 2, 0, 1], expected, createManifest: true }) as { ok: boolean }
  expect(result.ok).toBe(true)
  // Only the running-order lines moved; every other Index Note byte is kept.
  expect(await read(INDEX)).toBe(pinnedIndex(INDEX_ONLY.replace(
    '- [[alpha]] — the opening\n- [[beta]]\n- [[Unwritten idea]]\n- [[gamma]] #appendix\n',
    '- [[gamma]] #appendix\n- [[Unwritten idea]]\n- [[alpha]] — the opening\n- [[beta]]\n',
  ), {"gamma":"./gamma.md|gamma","alpha":"./alpha.md|alpha","beta":"./beta.md|beta"}))
  // The written parts in the new order, then the part not in the outline where export had it: nothing leaves the export.
  const manifest = JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string; role?: string }> }
  expect(manifest.files.map((file) => file.path)).toEqual(['gamma.md', 'alpha.md', 'beta.md', 'notes.md'])
  expect(await partBytes()).toEqual(parts)
  expect(await orderFor(ws, DIR)).toEqual(['gamma', 'alpha', 'beta', 'notes'].map(p))
  expect(await exportedOrder()).toEqual(['gamma', 'alpha', 'beta', 'notes'])
  expect(await sharedOrder()).toEqual(['gamma', 'alpha', 'beta', 'notes'].map(p))
  // The next reorder follows the manifest that now exists, as every Plan write does.
  const again = await reorderPlanParts(ws, DIR, { order: [2, 1, 0, 3], expected: await keys() }, { createManifest: true })
  expect(again.result.ok).toBe(true)
  expect(await exportedOrder()).toEqual(['alpha', 'gamma', 'beta', 'notes'])
})

test('the same reorder without createManifest writes no manifest (today), and export keeps the file-name order', async () => {
  await indexOnlyFolio()
  const result = await harness().invoke('plan:reorder-parts', { dir: DIR, order: [3, 2, 0, 1], expected: await keys() }) as { ok: boolean }
  expect(result.ok).toBe(true)
  expect(await exists(MANIFEST)).toBe(false)
  expect(await sharedOrder()).toEqual(PARTS.map(p))
  // createManifest: false is the same as absent.
  const off = await reorderPlanParts(ws, DIR, { order: [2, 3, 1, 0], expected: await keys() }, { createManifest: false })
  expect(off.result.ok).toBe(true)
  expect(await exists(MANIFEST)).toBe(false)
})

test('movePart and insertPart with createManifest create the manifest on F-INDEX-ONLY; without it they create none', async () => {
  await indexOnlyFolio()
  await movePart(ws, DIR, 3, 0)
  expect(await exists(MANIFEST)).toBe(false)
  await insertPart(ws, DIR, 1, { title: 'Another idea' })
  expect(await exists(MANIFEST)).toBe(false)
  const listing = await folderListing()

  await movePart(ws, DIR, 1, 0, { createManifest: true })
  expect((JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['gamma.md', 'alpha.md', 'beta.md', 'notes.md'])
  // One new file (the manifest) plus the Index Note backup this write made; no part was created or removed.
  expect(await folderListing()).toEqual([...listing, MANIFEST_NAME].sort())

  await rm(join(root, MANIFEST))
  invalidateFolioPlaces(root)
  await insertPart(ws, DIR, 0, { title: 'First idea' }, { createManifest: true })
  expect((await readPlan(ws, DIR))!.parts[0].title).toBe('First idea')
  expect((JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['gamma.md', 'alpha.md', 'beta.md', 'notes.md'])
})

test('a Folio that already has a manifest is written byte for byte as without createManifest', async () => {
  const run = async (options: { createManifest?: boolean }) => {
    await rm(join(root, DIR), { recursive: true, force: true })
    await indexOnlyFolio()
    await withManifest(['alpha', 'beta', 'gamma', 'notes'])
    await reorderParts(ws, DIR, [3, 2, 0, 1], options)
    await movePart(ws, DIR, 0, 2, options)
    await insertPart(ws, DIR, 1, { title: 'New card' }, options)
    return [await read(INDEX), await read(MANIFEST)]
  }
  const without = await run({})
  const withOption = await run({ createManifest: true })
  expect(withOption).toEqual(without)
  // The manifest's other keys and per-entry values are kept.
  expect(JSON.parse(without[1]).title).toBe('Paper')
  expect((JSON.parse(without[1]) as { files: Array<{ keep: string }> }).files.map((file) => file.keep)).toEqual(['alpha', 'gamma', 'beta', 'notes'])
})

test('a running order with no written part still creates the manifest when asked: it lists the folder\'s other file (review r1)', async () => {
  await mkdir(join(root, DIR), { recursive: true })
  await writeFile(join(root, p('stray')), '# stray\n')
  await writeFile(join(root, INDEX), '# Paper\n\n## Running order\n\n- [[One idea]]\n- [[Two idea]]\n')
  invalidateFolioPlaces(root)
  await reorderParts(ws, DIR, [1, 0], { createManifest: true })
  expect(await read(INDEX)).toBe('# Paper\n\n## Running order\n\n- [[Two idea]]\n- [[One idea]]\n')
  expect((JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['stray.md'])
})

test('a running order with no written part and no other file creates no manifest: nothing to order', async () => {
  await mkdir(join(root, DIR), { recursive: true })
  await writeFile(join(root, INDEX), '# Paper\n\n## Running order\n\n- [[One idea]]\n- [[Two idea]]\n')
  invalidateFolioPlaces(root)
  await reorderParts(ws, DIR, [1, 0], { createManifest: true })
  expect(await read(INDEX)).toBe('# Paper\n\n## Running order\n\n- [[Two idea]]\n- [[One idea]]\n')
  expect(await exists(MANIFEST)).toBe(false)
})

/** An Index Note whose running order (beta, alpha, …) is not the file-name order, as a numbered list a write would renumber. */
const OUT_OF_NAME_ORDER = '# Paper\n\n## Running order\n\n1. [[beta]]\n3. [[alpha]] — the opening\n7. [[Unwritten idea]]\n9. [[gamma]]\n'

test('an unchanged order with createManifest still creates the manifest in the running order; the Index Note is not written (review r1 MAJOR)', async () => {
  await indexOnlyFolio(OUT_OF_NAME_ORDER)
  expect(await exportedOrder()).toEqual(['alpha', 'beta', 'gamma', 'notes'])
  const expected = await keys()
  const api = harness()
  const result = await api.invoke('plan:reorder-parts', { dir: DIR, order: [0, 1, 2, 3], expected, createManifest: true }) as { ok: boolean; changed?: boolean }
  expect(result).toMatchObject({ ok: true, changed: true })
  expect((JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['beta.md', 'alpha.md', 'gamma.md', 'notes.md'])
  // The Index Note keeps every byte (its sparse numbers too), and no Index Note backup was made: it was not written.
  expect(await read(INDEX)).toBe(OUT_OF_NAME_ORDER)
  expect(await exists(`${INDEX}.writeflex-backup`)).toBe(false)
  expect(await exportedOrder()).toEqual(['beta', 'alpha', 'gamma', 'notes'])
  expect(await sharedOrder()).toEqual(['beta', 'alpha', 'gamma', 'notes'].map(p))
  // Asked again, with the manifest now there: nothing to do.
  const manifest = await read(MANIFEST)
  const again = await reorderPlanParts(ws, DIR, { order: [0, 1, 2, 3], expected: await keys() }, { createManifest: true })
  expect(again.result).toMatchObject({ ok: true, changed: false })
  expect(await read(MANIFEST)).toBe(manifest)
})

test('an unchanged order with createManifest is refused as stale when the Index Note changes while the manifest is made: no manifest (review r2 MAJOR)', async () => {
  const BETA_ALPHA = '# Paper\n\n## Running order\n\n- [[beta]]\n- [[alpha]]\n'
  const ALPHA_BETA = '# Paper\n\n## Running order\n\n- [[alpha]]\n- [[beta]]\n'
  // Two moments: during preparation (the folder listing the manifest is made from), and in the rename's own tick.
  const during = {
    preparation: () => {
      const original = ws.listFiles.bind(ws)
      let done = false
      ws.listFiles = (async (...args: Parameters<typeof original>) => {
        if (!done) { done = true; await writeFile(join(root, INDEX), ALPHA_BETA) }
        return original(...args)
      }) as typeof ws.listFiles
      return () => { ws.listFiles = original }
    },
    commit: () => onSaveOf(MANIFEST, async (original, content, options) => {
      await writeFile(join(root, INDEX), ALPHA_BETA)
      return original(MANIFEST, content, options)
    }),
  }
  for (const inject of [during.preparation, during.commit]) {
    await rm(join(root, DIR), { recursive: true, force: true })
    await indexOnlyFolio(BETA_ALPHA)
    const expected = await keys()
    const restore = inject()
    const outcome = await reorderPlanParts(ws, DIR, { order: [0, 1], expected }, { createManifest: true })
    restore()
    expect(outcome.result).toMatchObject({ ok: false, stale: true })
    expect(await exists(MANIFEST)).toBe(false)
    expect(await read(INDEX)).toBe(ALPHA_BETA)
    expect((await readdir(join(root, DIR))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  }
})

test('an unchanged order without createManifest stays a no-op, and a stale one with it writes nothing', async () => {
  await indexOnlyFolio(OUT_OF_NAME_ORDER)
  const expected = await keys()
  for (const options of [{}, { createManifest: false }]) {
    const outcome = await reorderPlanParts(ws, DIR, { order: [0, 1, 2, 3], expected }, options)
    expect(outcome.result).toMatchObject({ ok: true, changed: false })
  }
  expect(await exists(MANIFEST)).toBe(false)
  expect(await read(INDEX)).toBe(OUT_OF_NAME_ORDER)
  const changed = OUT_OF_NAME_ORDER.replace('7. [[Unwritten idea]]\n', '')
  await writeFile(join(root, INDEX), changed)
  invalidateFolioPlaces(root)
  const outcome = await reorderPlanParts(ws, DIR, { order: [0, 1, 2, 3], expected }, { createManifest: true })
  expect(outcome.result).toMatchObject({ ok: false, stale: true })
  expect(await exists(MANIFEST)).toBe(false)
  expect(await read(INDEX)).toBe(changed)
})

test('a manifest write failure during a createManifest write puts the Index Note back, leaves no manifest, and says nothing was changed', async () => {
  await indexOnlyFolio()
  const expected = await keys()
  let indexWhenManifestFailed = ''
  const restore = onSaveOf(MANIFEST, async () => {
    indexWhenManifestFailed = await read(INDEX)
    throw new Error(`EACCES: permission denied, open '${join(root, MANIFEST)}'`)
  })
  const outcome = await reorderPlanParts(ws, DIR, { order: [3, 2, 0, 1], expected }, { createManifest: true })
  restore()
  expect(outcome.result.ok).toBe(false)
  if (!outcome.result.ok) {
    expect(outcome.result.message).toContain('the Index Note was put back as it was. Nothing was changed.')
    expect(outcome.result.message).not.toContain(root)
  }
  // The Index Note had really been written before the manifest failed.
  expect(indexWhenManifestFailed).toContain(pinnedIndex('- [[gamma]] #appendix\n- [[Unwritten idea]]', {"gamma":"./gamma.md|gamma"}))
  expect(await read(INDEX)).toBe(INDEX_ONLY)
  expect(await exists(MANIFEST)).toBe(false)
  expect(await exists(`${MANIFEST}.writeflex-backup`)).toBe(false)
})

test('a manifest that appears while a createManifest write runs is never overwritten: refused, Index Note put back (I-6)', async () => {
  await indexOnlyFolio()
  const theirs = '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [{ "path": "notes.md" }]\n}\n'
  const restore = onSaveOf(MANIFEST, async (original, content, options) => {
    // Another program writes the manifest after this write's first comparison and before its rename.
    await writeFile(join(root, MANIFEST), theirs)
    return original(MANIFEST, content, options)
  })
  await expect(reorderParts(ws, DIR, [3, 2, 0, 1], { createManifest: true })).rejects.toThrow('Nothing was changed.')
  restore()
  expect(await read(MANIFEST)).toBe(theirs)
  expect(await read(INDEX)).toBe(INDEX_ONLY)
})

test('a stale reorder with createManifest is refused before anything is written', async () => {
  await indexOnlyFolio()
  const expected = await keys()
  // Another writer changed the running order after the caller read it.
  const changed = INDEX_ONLY.replace('- [[beta]]\n', '')
  await writeFile(join(root, INDEX), changed)
  invalidateFolioPlaces(root)
  const outcome = await reorderPlanParts(ws, DIR, { order: [3, 2, 0, 1], expected }, { createManifest: true })
  expect(outcome.result).toMatchObject({ ok: false, stale: true })
  expect(await read(INDEX)).toBe(changed)
  expect(await exists(MANIFEST)).toBe(false)
  expect(await exists(`${INDEX}.writeflex-backup`)).toBe(false)
})

test('the Plan IPC accepts createManifest only as a boolean, on reorder, move and insert', async () => {
  await indexOnlyFolio()
  const api = harness()
  const expected = await keys()
  await expect(api.invoke('plan:reorder-parts', { dir: DIR, order: [3, 2, 0, 1], expected, createManifest: 'yes' })).rejects.toThrow('Invalid running order.')
  await expect(api.invoke('plan:move-part', { dir: DIR, from: 0, to: 1, createManifest: 1 })).rejects.toThrow('Invalid Folio outline move.')
  await expect(api.invoke('plan:insert-part', { dir: DIR, at: 0, part: { title: 'X' }, createManifest: {} })).rejects.toThrow('Invalid Folio outline insertion.')
  expect(await read(INDEX)).toBe(INDEX_ONLY)
  expect(await exists(MANIFEST)).toBe(false)
  await api.invoke('plan:move-part', { dir: DIR, from: 3, to: 0, createManifest: true })
  expect((JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['gamma.md', 'alpha.md', 'beta.md', 'notes.md'])
  await rm(join(root, MANIFEST))
  invalidateFolioPlaces(root)
  await api.invoke('plan:insert-part', { dir: DIR, at: 4, part: { title: 'Last idea' }, createManifest: true })
  expect(await exists(MANIFEST)).toBe(true)
})

test('reading the Plan of F-INDEX-ONLY writes nothing (I-4)', async () => {
  await indexOnlyFolio()
  const listing = await folderListing()
  await readPlan(ws, DIR)
  await readFolioPlan(ws, DIR)
  await harness().invoke('plan:read', { dir: DIR })
  expect(await folderListing()).toEqual(listing)
  expect(await read(INDEX)).toBe(INDEX_ONLY)
})

// B. renumber

/** F-FORMS: BOM, CRLF, repeated `1.` markers, an alias, a gloss, a foreign section and a code block holding `- [[x]]`. */
const REPEATED = '﻿---\r\nkind: folio\r\n---\r\n# Paper\r\n\r\n## Running order\r\n\r\n1. [[alpha|The opening]] — first\r\n1. [[beta]]\r\n1. [[gamma]] #appendix\r\n\r\n## Foreign\r\n\r\n```\r\n- [[x]]\r\n```\r\n'
const SPARSE = '# Paper\n\n## Running order\n\n1. [[alpha]]\n3. [[beta]] - a gloss\n7. [[gamma]]\n\nAfter the list.\n'

/** Append a tag to the second line only. */
const tagSecond = (text: string, index: number) => (index === 1 ? `${text} #draft` : text)

test('F-FORMS: an Index Note save with renumber false keeps repeated `1.` markers, and changes only the edited line', async () => {
  await indexOnlyFolio(REPEATED)
  await commitPlanLinesForTest(ws, DIR, tagSecond, { renumber: false })
  expect(await read(INDEX)).toBe(pinnedIndex(REPEATED.replace('1. [[beta]]\r\n', '1. [[beta]] #draft\r\n'), {"beta":"./beta.md|beta","alpha|The opening":"./alpha.md|The opening","gamma":"./gamma.md|gamma"}))
})

test('F-FORMS: an Index Note save with renumber false keeps `1. 3. 7.` byte for byte', async () => {
  await indexOnlyFolio(SPARSE)
  await commitPlanLinesForTest(ws, DIR, tagSecond, { renumber: false })
  expect(await read(INDEX)).toBe(pinnedIndex(SPARSE.replace('3. [[beta]] - a gloss\n', '3. [[beta]] - a gloss #draft\n'), {"beta":"./beta.md|beta","alpha":"./alpha.md|alpha","gamma":"./gamma.md|gamma"}))
})

test('F-FORMS: with the default the same save renumbers 1, 2, 3 as today', async () => {
  await indexOnlyFolio(REPEATED)
  await commitPlanLinesForTest(ws, DIR, tagSecond)
  expect(await read(INDEX)).toBe(pinnedIndex(REPEATED
    .replace('1. [[beta]]\r\n', '2. [[beta]] #draft\r\n')
    .replace('1. [[gamma]]', '3. [[gamma]]'), {"alpha|The opening":"./alpha.md|The opening","beta":"./beta.md|beta","gamma":"./gamma.md|gamma"}))
  await rm(join(root, DIR), { recursive: true, force: true })
  await indexOnlyFolio(SPARSE)
  await commitPlanLinesForTest(ws, DIR, (text) => text, { renumber: true })
  expect(await read(INDEX)).toBe(pinnedIndex(SPARSE.replace('3. [[beta]]', '2. [[beta]]').replace('7. [[gamma]]', '3. [[gamma]]'), {"beta":"./beta.md|beta","gamma":"./gamma.md|gamma","alpha":"./alpha.md|alpha"}))
})

test('renumber false still commits only over the bytes it read: a changed Index Note is refused and kept', async () => {
  await indexOnlyFolio(SPARSE)
  const theirs = SPARSE.replace('After the list.', 'Someone else wrote this.')
  const restore = onSaveOf(INDEX, async (original, content, options) => {
    await writeFile(join(root, INDEX), theirs)
    return original(INDEX, content, options)
  })
  await expect(commitPlanLinesForTest(ws, DIR, tagSecond, { renumber: false })).rejects.toThrow('The Index Note changed while the Folio outline was being updated.')
  restore()
  expect(await read(INDEX)).toBe(theirs)
  expect(await exists(MANIFEST)).toBe(false)
})

/** The real preload's plan API with `ipcRenderer.invoke` recorded: what each call sends to main. */
const preloadProbe = String.raw`
  import { mock } from 'bun:test'
  let exposed
  const sent = []
  void mock.module('electron', () => ({
    clipboard: { readText: () => '' }, webUtils: { getPathForFile: () => '' },
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } },
    ipcRenderer: { invoke: async (channel, payload) => { sent.push({ channel, payload }); return null }, on: () => {}, removeListener: () => {} },
  }))
  void mock.module('@bridle/electron/preload', () => ({ createAuthTransport: () => ({}) }))
  await import('./src/preload/index.ts')
  await exposed.plan.insertPart('paper', 0, { title: 'X' }, { createManifest: 'false' })
  await exposed.plan.movePart('paper', 0, 1, { createManifest: 'false' })
  await exposed.plan.reorderParts('paper', [0], [], { createManifest: 'false' })
  await exposed.plan.reorderParts('paper', [0], [], {})
  await exposed.plan.movePart('paper', 0, 1, { createManifest: true })
  console.log(JSON.stringify(sent))
`

test('the preload passes createManifest through as given, so main refuses a non-boolean (review r1 Standards)', async () => {
  const child = Bun.spawn([process.execPath, '-e', preloadProbe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(stderr).toBe('')
  expect(exitCode).toBe(0)
  const sent = JSON.parse(stdout.trim().split('\n').pop() as string) as Array<{ channel: string; payload: Record<string, unknown> }>
  expect(sent.map((call) => call.payload.createManifest)).toEqual(['false', 'false', 'false', undefined, true])
  expect('createManifest' in sent[3].payload).toBe(false)
  await indexOnlyFolio()
  const api = harness()
  const expected = await keys()
  const [insert, move, reorder] = sent
  await expect(api.invoke(insert.channel, { ...insert.payload, dir: DIR })).rejects.toThrow('Invalid Folio outline insertion.')
  await expect(api.invoke(move.channel, { ...move.payload, dir: DIR, from: 3, to: 0 })).rejects.toThrow('Invalid Folio outline move.')
  await expect(api.invoke(reorder.channel, { ...reorder.payload, dir: DIR, order: [3, 2, 0, 1], expected })).rejects.toThrow('Invalid running order.')
  expect(await read(INDEX)).toBe(INDEX_ONLY)
  expect(await exists(MANIFEST)).toBe(false)
})
