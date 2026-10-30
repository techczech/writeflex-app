import { pinnedIndex } from '../helpers/folio-file-identity'
/**
 * Ticket 07 (Folio room, spec § 8 D-ORD-3): the documents out of step.
 * - `exportOrderAgreement`: write-free detection, comparing the running order's written parts with the manifest's
 *   resolved order on the files both hold, and reporting membership beside it.
 * - `alignManifestWithPlan`: the manifest-only repair, refused over any change to either document (I-6).
 * - The crash seam between `commitPlanDocuments`' two writes, and the two failure paths that leave the documents apart.
 * Real files in a temp dir; every refusal is checked to write nothing.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { exportBundle } from '../../src/main/export'
import { MANIFEST_NAME, orderFor } from '../../src/main/folio'
import { exportOrderAgreement, presentInFolio, readExportOrderAgreement } from '../../src/main/folio-order-assessment'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { alignManifestWithPlan, ExportOrderChanged, materialisePart, planCommitCrashSeamForTest, readPlan, readPlanWithManifest, reorderParts } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { planPartKeys } from '../../src/main/plan-running-order'
import { folioRunningOrder } from '../../src/main/sharing-folio'
import { Workspace } from '../../src/main/workspace'
import { EXPORT_ORDER_CHANGED, exportOrderLine, exportOrderNeedsRepair, type ExportOrderCheck, type ExportOrderExpected, type ExportOrderRepairResult } from '../../src/shared/export-order-agreement'

let root: string
let out: string
let ws: Workspace
const DIR = 'paper'
const INDEX = `${DIR}/_paper_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const EVIDENCE = `${DIR}/_paper_EVIDENCE-AND-NOTES.md`
const p = (name: string) => `${DIR}/${name}.md`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-export-order-'))
  out = await mkdtemp(join(tmpdir(), 'wf-export-order-out-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  planCommitCrashSeamForTest.afterIndexSave = null
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

const read = (path: string) => readFile(join(root, path), 'utf8')
const exists = (path: string) => Bun.file(join(root, path)).exists()

const runningOrder = (lines: string[]) => `---\nkind: folio\n---\n# Paper\n\nCover prose.\n\n## Running order\n\n${lines.join('\n')}\n\n## After\n\nTail.\n`

async function folio(index: string, manifest: string[] | null, parts = ['alpha', 'beta', 'gamma']): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  for (const name of parts) await writeFile(join(root, p(name)), `# ${name}\n\nText of ${name}.\n`)
  await writeFile(join(root, INDEX), index)
  if (manifest) await writeManifest(manifest)
  invalidateFolioPlaces(root)
}

async function writeManifest(files: string[], extra: Record<string, unknown> = {}): Promise<void> {
  await writeFile(join(root, MANIFEST), `${JSON.stringify({ schema_version: 1, content_root: '', title: 'Paper', ...extra, files: files.map((path) => ({ path, keep: path })) }, null, 2)}\n`)
  invalidateFolioPlaces(root)
}

const manifestPaths = async (): Promise<string[]> => (JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)

/** Every file under the workspace, with its bytes: what "writes nothing" is checked against. */
async function snapshot(): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files[relative(root, full)] = await readFile(full, 'utf8')
    }
  }
  await walk(root)
  return files
}

async function agreement() {
  invalidateFolioPlaces(root)
  const read = await readExportOrderAgreement(ws, DIR)
  if (!read) throw new Error('no Index Note')
  return read.agreement
}

/** What the sheet's read passes back to the repair: the running order now, and whether a manifest is there now. */
async function keys(): Promise<ExportOrderExpected> {
  const plan = await readPlan(ws, DIR)
  if (!plan) throw new Error('no plan')
  return { parts: planPartKeys(plan), manifestExists: await exists(MANIFEST) }
}

/** The part texts of the HTML export, in the order the page holds them. */
async function exportedOrder(): Promise<string[]> {
  const target = join(out, `export-${Date.now()}-${Math.random()}.html`)
  await exportBundle(ws, { dir: DIR, format: 'html', target })
  const page = await readFile(target, 'utf8')
  return [...page.matchAll(/Text of (\w+)\./g)].map((match) => match[1])
}

function harness() {
  const handlers = new Map<string, PlanIpcHandler>()
  const checkpoints: string[] = []
  const changed: string[][] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { checkpoints.push(path) },
    notifyCollectionChanged: (_state, paths) => { changed.push(paths) },
    notifyChangedOnDisk: () => {},
  })
  const invoke = async (channel: string, input: unknown) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler({ sender: { id: 7 } }, input)
  }
  return { invoke, checkpoints, changed }
}

/** Run `act` with every save of `path` replaced by `replace`. */
function onSaveOf(path: string, replace: (original: Workspace['saveFileWithoutReadBack'], content: string, options: Parameters<Workspace['saveFileWithoutReadBack']>[2], call: number) => Promise<void>): () => void {
  const original = ws.saveFileWithoutReadBack.bind(ws)
  let call = 0
  ws.saveFileWithoutReadBack = (async (target: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (target === path) return replace(original, content, options, call++)
    return original(target, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  return () => { ws.saveFileWithoutReadBack = original }
}

// exportOrderAgreement: the comparison

test('D-ORD-3 example: Index B, A; manifest A, B, C (C not in the outline) → orderDiffers on the common files, C reported beside it', async () => {
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md', 'gamma.md'])
  const result = await agreement()
  expect(result).toEqual({
    kind: 'disagree',
    orderDiffers: { index: [p('beta'), p('alpha')], manifest: [p('alpha'), p('beta')] },
    notInExport: [],
    notInRunningOrder: [p('gamma')],
  })
  expect(exportOrderNeedsRepair(result)).toBe(true)
  expect(exportOrderLine(result, 'unreadable')).toEqual({ lines: ['The export order does not match the running order'], repair: true })
})

test('an extra entry on either side never hides a wrong order; membership alone (manifest extra) shows no line', async () => {
  // An Index-only part (gamma) and a wrong order of alpha and beta: both reported.
  await folio(runningOrder(['- [[beta]]', '- [[gamma]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
  const both = await agreement()
  expect(both).toEqual({ kind: 'disagree', orderDiffers: { index: [p('beta'), p('alpha')], manifest: [p('alpha'), p('beta')] }, notInExport: [p('gamma')], notInRunningOrder: [] })
  expect(exportOrderLine(both, '')?.lines).toEqual(['The export order does not match the running order', '1 part is not in the export'])
  // The same order on the common files, a manifest entry no line names: reported, but no line (Not in the outline shows it).
  await writeFile(join(root, INDEX), runningOrder(['- [[alpha]]', '- [[beta]]']))
  await writeManifest(['alpha.md', 'gamma.md', 'beta.md'])
  const extra = await agreement()
  expect(extra).toEqual({ kind: 'disagree', notInExport: [], notInRunningOrder: [p('gamma')] })
  expect(exportOrderNeedsRepair(extra)).toBe(false)
  expect(exportOrderLine(extra, '')).toBeNull()
})

test('a mixed written/unwritten order whose written projections agree → no line; disagree → line', async () => {
  await folio(runningOrder(['- [[Unwritten idea]]', '- [[alpha]]', '- [[Another idea]]', '- [[beta]]', '- [[gamma]]']), ['alpha.md', 'beta.md', 'gamma.md'])
  expect(await agreement()).toEqual({ kind: 'agree' })
  await writeFile(join(root, INDEX), runningOrder(['- [[Unwritten idea]]', '- [[gamma]]', '- [[Another idea]]', '- [[beta]]', '- [[alpha]]']))
  const result = await agreement()
  expect(result.kind).toBe('disagree')
  expect(exportOrderNeedsRepair(result)).toBe(true)
  if (result.kind === 'disagree') expect(result.orderDiffers).toEqual({ index: ['gamma', 'beta', 'alpha'].map(p), manifest: ['alpha', 'beta', 'gamma'].map(p) })
})

test('missing files, agent instructions and room support entries in the manifest are skipped, as export skips them', async () => {
  await folio(runningOrder(['- [[alpha]]', '- [[beta]]']), null)
  await writeFile(join(root, `${DIR}/AGENTS.md`), '# Agents\n')
  await writeFile(join(root, EVIDENCE), '# Evidence\n')
  await writeManifest(['alpha.md', 'gone.md', 'AGENTS.md', '_paper_EVIDENCE-AND-NOTES.md', 'beta.md'])
  expect(await agreement()).toEqual({ kind: 'agree' })
})

test('no manifest → no-manifest; an unparsable manifest, unreadable entries, a refused content_root or an entry leaving the Folio → unreadable', async () => {
  await folio(runningOrder(['- [[alpha]]', '- [[beta]]']), null)
  expect(await agreement()).toEqual({ kind: 'no-manifest' })
  const unreadable = async (text: string) => {
    await writeFile(join(root, MANIFEST), text)
    return agreement()
  }
  expect(await unreadable('{ not json')).toEqual({ kind: 'unreadable' })
  expect(await unreadable(JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'alpha.md' }, 7] }))).toEqual({ kind: 'unreadable' })
  expect(await unreadable(JSON.stringify({ schema_version: 1, content_root: '../elsewhere', files: [{ path: 'alpha.md' }] }))).toEqual({ kind: 'unreadable' })
  expect(await unreadable(JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'alpha.md' }, { path: '../outside.md' }] }))).toEqual({ kind: 'unreadable' })
  const line = exportOrderLine({ kind: 'unreadable' }, 'The manifest message.')
  expect(line).toEqual({ lines: ['The manifest message.'], repair: false })
})

test('the pure comparison needs no disk: the same Plan and manifest give the same answer from a given listing', async () => {
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
  const read = await readPlanWithManifest(ws, DIR)
  const present = await presentInFolio(ws, DIR)
  const answer = exportOrderAgreement(read!.plan, read!.loaded.manifest, present, read!.loaded.manifestExists)
  expect(answer).toEqual({ kind: 'disagree', orderDiffers: { index: [p('beta'), p('alpha')], manifest: [p('alpha'), p('beta')] }, notInExport: [], notInRunningOrder: [] })
  // With beta's file gone from the listing, the manifest's entry is skipped as export skips it: only alpha is common,
  // so the order agrees, and beta, still a written part to the Plan, is reported as not in the export.
  const without = new Set([...present].filter((path) => path !== p('beta')))
  expect(exportOrderAgreement(read!.plan, read!.loaded.manifest, without, read!.loaded.manifestExists)).toEqual({ kind: 'disagree', notInExport: [p('beta')], notInRunningOrder: [] })
})

// T-ORD: the crash between the two writes, detected write-free, repaired manifest-only

test('T-ORD: an interrupted commit (crash after the Index Note save) → the sheets\' line; opening writes nothing; the repair yields agree, the Index Note byte-identical', async () => {
  await folio(runningOrder(['1. [[alpha]]', '1. [[beta]]', '1. [[gamma]]']), ['alpha.md', 'beta.md', 'gamma.md'])
  planCommitCrashSeamForTest.afterIndexSave = () => { throw new Error('crash') }
  await expect(reorderParts(ws, DIR, [2, 0, 1])).rejects.toThrow('crash')
  planCommitCrashSeamForTest.afterIndexSave = null
  // The crash left the Index Note ahead: gamma, alpha, beta; the manifest still alpha, beta, gamma.
  const ahead = await read(INDEX)
  expect(ahead).toContain(pinnedIndex('1. [[gamma]]\n2. [[alpha]]\n3. [[beta]]', {"gamma":"./gamma.md|gamma","alpha":"./alpha.md|alpha","beta":"./beta.md|beta"}))
  expect(await manifestPaths()).toEqual(['alpha.md', 'beta.md', 'gamma.md'])

  const api = harness()
  const before = await snapshot()
  const check = await api.invoke('plan:export-order', { dir: DIR }) as ExportOrderCheck
  expect(check.agreement.kind).toBe('disagree')
  expect(exportOrderLine(check.agreement, check.unreadableMessage)?.lines).toEqual(['The export order does not match the running order'])
  // Opening the sheet (the read) wrote nothing (I-4).
  expect(await snapshot()).toEqual(before)
  expect(api.checkpoints).toEqual([])

  const repaired = await api.invoke('plan:align-manifest', { dir: DIR, expected: check.expected }) as ExportOrderRepairResult
  expect(repaired).toEqual({ ok: true, changed: true, pieces: 3 })
  expect(await agreement()).toEqual({ kind: 'agree' })
  expect(await read(INDEX)).toBe(ahead)
  // Only the manifest's order changed; every entry keeps its other values.
  expect(JSON.parse(await read(MANIFEST))).toEqual({ schema_version: 1, content_root: '', title: 'Paper', files: ['gamma.md', 'alpha.md', 'beta.md'].map((path) => ({ path, keep: path })) })
  expect(api.checkpoints).toEqual([MANIFEST])
  expect(api.changed).toEqual([[MANIFEST]])
  expect(await exportedOrder()).toEqual(['gamma', 'alpha', 'beta'])
  expect(((await folioRunningOrder(root, DIR)) ?? []).map((entry) => entry.path)).toEqual(['gamma', 'alpha', 'beta'].map(p))
})

test('the repair keeps repeated `1.` markers: the Index Note is not written at all', async () => {
  const index = runningOrder(['1. [[beta]]', '1. [[alpha]] — the opening', '1. [[Unwritten idea]]', '1. [[gamma]] #appendix'])
  await folio(index, ['alpha.md', 'beta.md', 'gamma.md'])
  const written = await alignManifestWithPlan(ws, DIR, await keys())
  expect(written).not.toBeNull()
  expect(await read(INDEX)).toBe(index)
  expect(await exists(`${INDEX}.writeflex-backup`)).toBe(false)
  expect(await manifestPaths()).toEqual(['beta.md', 'alpha.md', 'gamma.md'])
  expect(await agreement()).toEqual({ kind: 'agree' })
  // The manifest's pristine copy is kept, as before every manifest overwrite.
  expect(await exists(`${MANIFEST}.writeflex-backup`)).toBe(true)
  // Asked again: nothing to do, nothing written.
  const manifest = await read(MANIFEST)
  expect(await alignManifestWithPlan(ws, DIR, await keys())).toBeNull()
  expect(await read(MANIFEST)).toBe(manifest)
})

test('the repair keeps parts not in the outline, hidden entries and room support entries where the manifest has them', async () => {
  await folio(runningOrder(['- [[gamma]]', '- [[alpha]]']), null, ['alpha', 'beta', 'gamma'])
  await writeFile(join(root, EVIDENCE), '# Evidence\n')
  await writeFile(join(root, `${DIR}/_cover.md`), '# Cover\n')
  await writeManifest(['_cover.md', 'alpha.md', '_paper_EVIDENCE-AND-NOTES.md', 'beta.md', 'gamma.md'])
  expect(await agreement()).toMatchObject({ kind: 'disagree', notInRunningOrder: [p('_cover'), p('beta')] })
  await alignManifestWithPlan(ws, DIR, await keys())
  // The parts' slots take the running order; the cover and beta keep theirs; the support entry stays after alpha, the entry it followed (keepEntriesAsAuthored).
  expect(await manifestPaths()).toEqual(['_cover.md', 'gamma.md', 'beta.md', 'alpha.md', '_paper_EVIDENCE-AND-NOTES.md'])
  const after = await agreement()
  expect(after.kind === 'disagree' && after.orderDiffers).toBeFalsy()
  expect(exportOrderNeedsRepair(after)).toBe(false)
})

test('a Folio with no manifest: the repair creates it in the running order (create allowed)', async () => {
  await folio(runningOrder(['- [[gamma]]', '- [[Unwritten idea]]', '- [[alpha]]']), null, ['alpha', 'beta', 'gamma'])
  expect(await agreement()).toEqual({ kind: 'no-manifest' })
  await alignManifestWithPlan(ws, DIR, await keys())
  // The written parts in running order, then the folder's other part where export had it.
  expect(await manifestPaths()).toEqual(['gamma.md', 'alpha.md', 'beta.md'])
  expect(await orderFor(ws, DIR)).toEqual(['gamma', 'alpha', 'beta'].map(p))
})

// Refusals: nothing written

test('an Index Note change landing between prepare and commit (in the rename tick) → refused, nothing written', async () => {
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
  const manifest = await read(MANIFEST)
  const theirs = runningOrder(['- [[alpha]]', '- [[beta]]', '- [[New line]]'])
  const restore = onSaveOf(MANIFEST, async (original, content, options) => {
    await writeFile(join(root, INDEX), theirs)
    return original(MANIFEST, content, options)
  })
  const outcome = await harness().invoke('plan:align-manifest', { dir: DIR, expected: await keys() }) as ExportOrderRepairResult
  restore()
  expect(outcome).toEqual({ ok: false, message: EXPORT_ORDER_CHANGED })
  expect(await read(MANIFEST)).toBe(manifest)
  expect(await read(INDEX)).toBe(theirs)
  expect((await readdir(join(root, DIR))).filter((name) => name.endsWith('.tmp'))).toEqual([])
  // The pristine copy this attempt took before staging is taken away again: a refusal leaves no file behind.
  expect(await exists(`${MANIFEST}.writeflex-backup`)).toBe(false)
})

test('a refusal in the rename tick keeps a pristine copy that was already there, byte for byte', async () => {
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
  await writeFile(join(root, `${MANIFEST}.writeflex-backup`), 'the earliest copy\n')
  const restore = onSaveOf(MANIFEST, async (original, content, options) => {
    await writeFile(join(root, INDEX), runningOrder(['- [[alpha]]', '- [[beta]]']))
    return original(MANIFEST, content, options)
  })
  await expect(alignManifestWithPlan(ws, DIR, await keys())).rejects.toBeInstanceOf(ExportOrderChanged)
  restore()
  expect(await read(`${MANIFEST}.writeflex-backup`)).toBe('the earliest copy\n')
})

test('a manifest deleted, or created, since the sheet read it → refused with the same sentence, nothing written', async () => {
  // Deleted after the read: the repair must not recreate it.
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
  const api = harness()
  const check = await api.invoke('plan:export-order', { dir: DIR }) as ExportOrderCheck
  expect(check.expected.manifestExists).toBe(true)
  await rm(join(root, MANIFEST))
  invalidateFolioPlaces(root)
  const before = await snapshot()
  expect(await api.invoke('plan:align-manifest', { dir: DIR, expected: check.expected })).toEqual({ ok: false, message: EXPORT_ORDER_CHANGED })
  expect(await snapshot()).toEqual(before)
  expect(await exists(MANIFEST)).toBe(false)

  // Created after a read that found none: the repair must not overwrite it.
  const none = await api.invoke('plan:export-order', { dir: DIR }) as ExportOrderCheck
  expect(none.expected.manifestExists).toBe(false)
  await writeManifest(['alpha.md', 'beta.md'])
  const theirs = await snapshot()
  expect(await api.invoke('plan:align-manifest', { dir: DIR, expected: none.expected })).toEqual({ ok: false, message: EXPORT_ORDER_CHANGED })
  expect(await snapshot()).toEqual(theirs)
  expect(api.checkpoints).toEqual([])
})

test('an Index Note change during preparation, or after the checkpoint, → refused, nothing written', async () => {
  const theirs = runningOrder(['- [[alpha]]', '- [[beta]]'])
  const moments = {
    preparation: () => {
      const original = ws.listFiles.bind(ws)
      let done = false
      ws.listFiles = (async (...args: Parameters<typeof original>) => {
        if (!done) { done = true; await writeFile(join(root, INDEX), theirs) }
        return original(...args)
      }) as typeof ws.listFiles
      return () => { ws.listFiles = original }
    },
    checkpoint: () => () => {},
  }
  for (const [name, inject] of Object.entries(moments)) {
    await rm(join(root, DIR), { recursive: true, force: true })
    await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
    const manifest = await read(MANIFEST)
    const expected = await keys()
    const restore = inject()
    const options = name === 'checkpoint' ? { beforeManifestWrite: async () => { await writeFile(join(root, INDEX), theirs) } } : {}
    await expect(alignManifestWithPlan(ws, DIR, expected, options)).rejects.toBeInstanceOf(ExportOrderChanged)
    restore()
    expect(await read(MANIFEST)).toBe(manifest)
    expect(await read(INDEX)).toBe(theirs)
    expect(await exists(`${MANIFEST}.writeflex-backup`)).toBe(false)
  }
})

test('a manifest change in the rename tick, or a running order that is no longer `expected` → refused with the same sentence, nothing written', async () => {
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md'])
  const theirs = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'beta.md' }] }, null, 2)}\n`
  const restore = onSaveOf(MANIFEST, async (original, content, options) => {
    await writeFile(join(root, MANIFEST), theirs)
    return original(MANIFEST, content, options)
  })
  await expect(alignManifestWithPlan(ws, DIR, await keys())).rejects.toThrow(EXPORT_ORDER_CHANGED)
  restore()
  expect(await read(MANIFEST)).toBe(theirs)
  expect(await exists(`${MANIFEST}.writeflex-backup`)).toBe(false)

  await writeManifest(['alpha.md', 'beta.md'])
  const manifest = await read(MANIFEST)
  const stale = [{ title: 'alpha', path: p('alpha') }, { title: 'beta', path: p('beta') }]
  const outcome = await harness().invoke('plan:align-manifest', { dir: DIR, expected: { parts: stale, manifestExists: true } }) as ExportOrderRepairResult
  expect(outcome).toEqual({ ok: false, message: EXPORT_ORDER_CHANGED })
  expect(await read(MANIFEST)).toBe(manifest)
})

test('an unreadable manifest is never repaired: refused in plain words, nothing written', async () => {
  await folio(runningOrder(['- [[beta]]', '- [[alpha]]']), null)
  await writeFile(join(root, MANIFEST), '{ not json')
  const outcome = await harness().invoke('plan:align-manifest', { dir: DIR, expected: await keys() }) as ExportOrderRepairResult
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.message).not.toContain(root)
  expect(await read(MANIFEST)).toBe('{ not json')
})

test('the IPC refuses a malformed running order before anything is read', async () => {
  await folio(runningOrder(['- [[alpha]]']), ['alpha.md'])
  const api = harness()
  await expect(api.invoke('plan:align-manifest', { dir: DIR, expected: [{ title: 1 }] })).rejects.toThrow('Invalid running order.')
  await expect(api.invoke('plan:align-manifest', { dir: DIR, expected: { parts: [{ title: 1 }], manifestExists: true } })).rejects.toThrow('Invalid running order.')
  // The manifest's presence as the read saw it is required: without it the repair could recreate a deleted manifest.
  await expect(api.invoke('plan:align-manifest', { dir: DIR, expected: { parts: await keys().then((k) => k.parts) } })).rejects.toThrow('Invalid running order.')
  await expect(api.invoke('plan:align-manifest', { dir: '../x', expected: { parts: [], manifestExists: true } })).rejects.toThrow()
  // A folder with no Index Note: no running order, so no line.
  await rm(join(root, INDEX))
  invalidateFolioPlaces(root)
  expect(await api.invoke('plan:export-order', { dir: DIR })).toBeNull()
})

// The two other paths that leave the documents apart: each ends in a state the line shows and the repair fixes

test('a manifest write failure whose Index Note restore also fails → detected, and the repair fixes it', async () => {
  await folio(runningOrder(['- [[alpha]]', '- [[beta]]', '- [[gamma]]']), ['alpha.md', 'beta.md', 'gamma.md'])
  const restoreManifest = onSaveOf(MANIFEST, async () => { throw new Error('EACCES: manifest') })
  const restoreIndex = onSaveOf(INDEX, async (original, content, options, call) => {
    if (call > 0) throw new Error('EACCES: put back')
    return original(INDEX, content, options)
  })
  await expect(reorderParts(ws, DIR, [1, 2, 0])).rejects.toThrow('could not be put back')
  restoreIndex()
  restoreManifest()
  const ahead = await read(INDEX)
  expect(ahead).toContain(pinnedIndex('- [[beta]]\n- [[gamma]]\n- [[alpha]]', {"beta":"./beta.md|beta","gamma":"./gamma.md|gamma","alpha":"./alpha.md|alpha"}))
  expect(exportOrderNeedsRepair(await agreement())).toBe(true)
  await alignManifestWithPlan(ws, DIR, await keys())
  expect(await agreement()).toEqual({ kind: 'agree' })
  expect(await read(INDEX)).toBe(ahead)
  expect(await exportedOrder()).toEqual(['beta', 'gamma', 'alpha'])
})

test('Start this part with a manifest write failure whose clean-up also fails → "1 part is not in the export", and the repair fixes it', async () => {
  await folio(runningOrder(['- [[alpha]]', '- [[New part]]', '- [[beta]]']), ['alpha.md', 'beta.md'], ['alpha', 'beta'])
  const restoreManifest = onSaveOf(MANIFEST, async () => { throw new Error('EACCES: manifest') })
  const remove = ws.removeFileOverRead.bind(ws)
  ws.removeFileOverRead = (() => { throw new Error('EACCES: remove') }) as typeof ws.removeFileOverRead
  await expect(materialisePart(ws, DIR, 1)).rejects.toThrow('was left in place')
  ws.removeFileOverRead = remove
  restoreManifest()
  const index = await read(INDEX)
  const result = await agreement()
  expect(result).toEqual({ kind: 'disagree', notInExport: [p('02-new-part')], notInRunningOrder: [] })
  expect(exportOrderLine(result, '')?.lines).toEqual(['1 part is not in the export'])
  await alignManifestWithPlan(ws, DIR, await keys())
  expect(await agreement()).toEqual({ kind: 'agree' })
  expect(await read(INDEX)).toBe(index)
  expect(await manifestPaths()).toEqual(['alpha.md', '02-new-part.md', 'beta.md'])
})

// Export anyway

test('Export anyway exports in the manifest\'s order and writes nothing in the workspace', async () => {
  await folio(runningOrder(['- [[gamma]]', '- [[beta]]', '- [[alpha]]']), ['alpha.md', 'beta.md', 'gamma.md'])
  expect(exportOrderNeedsRepair(await agreement())).toBe(true)
  const before = await snapshot()
  expect(await exportedOrder()).toEqual(['alpha', 'beta', 'gamma'])
  expect(await snapshot()).toEqual(before)
})

// Rung 2: commitPlanDocuments without the seam is today's

test('with the crash seam unset, a reorder commits both documents as today', async () => {
  await folio(runningOrder(['- [[alpha]]', '- [[beta]]']), ['alpha.md', 'beta.md'])
  await reorderParts(ws, DIR, [1, 0])
  expect(await manifestPaths()).toEqual(['beta.md', 'alpha.md'])
  expect(await agreement()).toEqual({ kind: 'agree' })
})
