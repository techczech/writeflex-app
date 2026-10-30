import { pinnedIndex } from '../helpers/folio-file-identity'
/**
 * Folio room ticket 11 (spec-folio-room-data-model § 8 D-ORD-1/2, § 9 D-WRITE-1, § 2 D-PART-2, § 12, § 13 RW-4, T-ORD,
 * T-CLASH, T-CONTAIN): the room's reorder, New card and their Undo, through the Plan IPC (`plan:reorder-parts` with
 * `room: true`, `plan:room-new-card`, `plan:room-remove-card`) and `plan:align-manifest`, each written through the
 * room's pinned view (`FolioWorkspace`).
 *
 * A drag of a card, a drag of an Outline row and ⌥↑↓ all ask the same thing of main: one whole-order call whose
 * `order` is `moveOrder(count, from, to)`; the three are exercised here as their permutations, and on screen by the
 * hidden e2e spec. Real files in a temp dir; every refusal is checked to write nothing (the whole tree compared).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { exportBundle } from '../../src/main/export'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { reorderRoomParts } from '../../src/main/folio-room-writes'
import { FOLIO_REFUSAL, FolioWorkspace } from '../../src/main/folio-workspace'
import { readFolioPlan, readPlan } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { planPartKeys } from '../../src/main/plan-running-order'
import { folioRunningOrder } from '../../src/main/sharing-folio'
import { Workspace } from '../../src/main/workspace'
import { inverseOrder } from '../../src/shared/folio-chapter-order'
import type { ExportOrderRepairResult } from '../../src/shared/export-order-agreement'
import { MANIFEST_CREATED, NEW_CARD_INDEX_NOTE, NEW_CARD_RESERVED, clashRefusal, manifestCreatedSentence, moveOrder, newCardClashRefusal, newCardFileRefusal, newCardLooseRefusal, withManifestNote, type RoomCardResult, type RoomOrderResult } from '../../src/shared/folio-room-order'
import type { PlanPartKey } from '../../src/shared/folio-running-order'
import { clashFolio, formsFolio, indexOnlyFolio, manifestOnlyFolio, noRunningOrderFolio, pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'

let root: string
let out: string
let ws: Workspace

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-room-order-')))
  out = await mkdtemp(join(tmpdir(), 'wf-room-order-out-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const exists = (rel: string): Promise<boolean> => lstat(join(root, rel)).then(() => true, () => false)

/** Every entry under `dir`, never following a link: path → file text, `link → target` or `folder`. */
async function tree(dir = root): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name)
      const key = relative(dir, path)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) found[key] = `link → ${await readlink(path)}`
      else if (stat.isDirectory()) { found[key] = 'folder'; await walk(path) }
      else found[key] = await readFile(path, 'utf8')
    }
  }
  await walk(dir)
  return found
}

/** The room support files (spec § 1): they must be byte-identical after every order write (RW-4). */
async function supportFiles(dir: string): Promise<void> {
  const name = dir.split('/').at(-1)
  await writeFile(join(root, dir, `_${name}_EVIDENCE-AND-NOTES.md`), '# Evidence and notes\n\n## [[Summary]]\n\n### Evidence\n\n- [Scores](research/scores.json)\n')
  await writeFile(join(root, dir, `_${name}_MAP.canvas`), '{\n\t"nodes": [],\n\t"edges": []\n}\r\n')
}

function harness(onCheckpoint: (path: string) => Promise<void> = async () => {}) {
  const handlers = new Map<string, PlanIpcHandler>()
  const checkpoints: string[] = []
  const changed: string[][] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { checkpoints.push(path); await onCheckpoint(path) },
    notifyCollectionChanged: (_state, paths) => { changed.push(paths) },
    notifyChangedOnDisk: () => {},
  })
  const invoke = async <T>(channel: string, input: unknown): Promise<T> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return await handler({ sender: { id: 7 } }, input) as T
  }
  return { invoke, checkpoints, changed }
}

async function keysOf(dir: string): Promise<PlanPartKey[]> {
  const plan = await readFolioPlan(ws, dir)
  if (!plan) throw new Error('no plan')
  return planPartKeys(plan)
}

/** A room reorder that moves the part at `from` to `to`, over the running order as the room shows it. */
async function roomMove(dir: string, from: number, to: number, expected?: PlanPartKey[], h = harness()): Promise<RoomOrderResult> {
  const seen = expected ?? await keysOf(dir)
  const order = moveOrder(seen.length, from, to)
  if (!order) throw new Error('no move')
  return h.invoke<RoomOrderResult>('plan:reorder-parts', { dir, order, expected: seen, room: true })
}

/** The written parts' bodies in the order the HTML export holds them, by a word each body carries. */
async function exportedOrder(dir: string, words: Record<string, string>): Promise<string[]> {
  const target = join(out, `export-${Date.now()}-${Math.random()}.html`)
  await exportBundle(ws, { dir, format: 'html', target })
  const page = await readFile(target, 'utf8')
  return Object.entries(words).map(([name, word]) => [name, page.indexOf(word)] as const).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]).map(([name]) => name)
}
const sharedOrder = async (dir: string): Promise<string[]> => ((await folioRunningOrder(root, dir)) ?? []).map((entry) => entry.path)

// ---- RW-4 ----------------------------------------------------------------------------------------------------------

test('RW-4 F-PANGRAM: a room reorder moves only the running-order lines, changes the manifest order, keeps part, evidence and map files byte-identical, and export and sharing follow', async () => {
  const folio = await pangramFolio(root, 'paper')
  await supportFiles('paper')
  const before = await tree()
  const index = await read(folio.indexPath as string)
  const h = harness()
  const result = await roomMove('paper', 1, 0, undefined, h) // Details before Summary: a card drag, a row drag or ⌥↑
  expect(result).toMatchObject({ ok: true, changed: true })
  expect(result.manifestCreated).toBeUndefined()
  expect(await read(folio.indexPath as string)).toBe(pinnedIndex(index.replace(
    '- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n- [[Details]]\n',
    '- [[Details]]\n- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n',
  ), {"Details":"./contents/02-report.md|Details","Summary":"./contents/01-summary.md|Summary"}))
  const manifest = JSON.parse(await read('paper/_report-structure.json')) as { files: Array<{ path: string; role?: string }>; title_matter: string }
  expect(manifest.files).toEqual([{ path: 'contents/02-report.md', role: 'report-body' }, { path: 'contents/01-summary.md', role: 'summary' }])
  expect(manifest.title_matter).toBe('contents/00-frontmatter.md')
  const after = await tree()
  const changedFiles = Object.keys(after).filter((key) => after[key] !== before[key])
  // The Index Note, the manifest and their pristine copies: nothing else.
  expect(changedFiles.sort()).toEqual(['paper/_paper_INDEX.md', 'paper/_paper_INDEX.md.writeflex-backup', 'paper/_paper_INDEX.md.writeflex-backup.json', 'paper/_report-structure.json', 'paper/_report-structure.json.writeflex-backup', 'paper/_report-structure.json.writeflex-backup.json'])
  expect(await exportedOrder('paper', { Summary: 'Findings in one place', Details: 'Details body text' })).toEqual(['Details', 'Summary'])
  expect(await sharedOrder('paper')).toEqual(['paper/contents/02-report.md', 'paper/contents/01-summary.md'])
  // The views are told: the Index Note and the manifest.
  expect(h.changed.flat()).toEqual(expect.arrayContaining(['paper/_paper_INDEX.md', 'paper/_report-structure.json']))
  // Checkpoints before each write (the history step), as every Plan write takes them.
  expect(h.checkpoints).toEqual(expect.arrayContaining(['paper/_paper_INDEX.md', 'paper/_report-structure.json']))
})

test('RW-4 F-FORMS: only the running-order lines move and ordered markers are renumbered; CRLF, BOM, the starred line, foreign sections and the code block are kept; the manifest is created', async () => {
  const folio = await formsFolio(root, 'forms')
  const index = await read(folio.indexPath as string)
  const parts = await Promise.all(folio.writtenPaths.map(read))
  const result = await roomMove('forms', 4, 0) // Epsilon to the top
  expect(result).toMatchObject({ ok: true, changed: true, manifestCreated: true })
  const written = await read(folio.indexPath as string)
  const block = (text: string): string[] => text.split('\r\n').filter((line) => /^(\d+\.|\*) \[\[/.test(line))
  const rest = (text: string): string[] => text.split('\r\n').filter((line) => !/^(\d+\.|\*) \[\[/.test(line))
  expect(rest(written)).toEqual(rest(index))
  expect(written.startsWith('﻿')).toBe(true)
  expect(block(written)).toEqual([
    '1. [[./epsilon.md|Epsilon]]', '2. [[./alpha.md|Alpha]] — First - with a dash.', '3. [[./beta.md|the second]] — Second.', '4. [[./gamma.md|Gamma]]', '5. [[./delta.md|Delta]] #section', '* [[Zeta]] — Starred.',
  ])
  expect(await Promise.all(folio.writtenPaths.map(read))).toEqual(parts)
  const manifest = JSON.parse(await read('forms/_report-structure.json')) as { files: Array<{ path: string }> }
  expect(manifest.files.map((file) => file.path)).toEqual(['epsilon.md', 'alpha.md', 'beta.md', 'gamma.md', 'delta.md'])
  expect(await sharedOrder('forms')).toEqual(['epsilon', 'alpha', 'beta', 'gamma', 'delta'].map((name) => `forms/${name}.md`))
})

test('RW-4 F-INDEX-ONLY: the first room reorder creates the manifest in the new order and says so; export and sharing follow; the next reorder does not say it again', async () => {
  const folio = await indexOnlyFolio(root, 'index-only')
  await supportFiles('index-only')
  const support = [await read('index-only/_index-only_EVIDENCE-AND-NOTES.md'), await read('index-only/_index-only_MAP.canvas')]
  // Before: no manifest, so export and sharing follow file names.
  expect(await exists('index-only/_report-structure.json')).toBe(false)
  const first = await roomMove('index-only', 1, 0) // Two, One, Three
  expect(first).toMatchObject({ ok: true, changed: true, manifestCreated: true })
  expect(MANIFEST_CREATED).toBe('This Folio now has a manifest, so export and sharing follow its running order.')
  const manifest = JSON.parse(await read('index-only/_report-structure.json')) as { files: Array<{ path: string }> }
  expect(manifest.files.map((file) => file.path)).toEqual(['two.md', 'one.md'])
  expect(await exportedOrder('index-only', { One: 'One two three.', Two: 'Two words.' })).toEqual(['Two', 'One'])
  expect(await sharedOrder('index-only')).toEqual(['index-only/two.md', 'index-only/one.md'])
  expect(await Promise.all(folio.writtenPaths.map(read))).toEqual(['# One\n\nOne two three.\n', '# Two\n\nTwo words.\n'])
  expect([await read('index-only/_index-only_EVIDENCE-AND-NOTES.md'), await read('index-only/_index-only_MAP.canvas')]).toEqual(support)
  const second = await roomMove('index-only', 0, 1)
  expect(second).toMatchObject({ ok: true, changed: true })
  expect(second.manifestCreated).toBeUndefined()
  expect(await sharedOrder('index-only')).toEqual(['index-only/one.md', 'index-only/two.md'])
})

test('F-MANIFEST-ONLY: a room reorder takes the manifest-only branch: the manifest changes and no Index Note is made', async () => {
  await manifestOnlyFolio(root, 'mo')
  const result = await roomMove('mo', 1, 0)
  expect(result).toMatchObject({ ok: true, changed: true })
  expect(result.manifestCreated).toBeUndefined()
  expect((await readdir(join(root, 'mo'))).filter((name) => name.endsWith('_INDEX.md'))).toEqual([])
  const manifest = JSON.parse(await read('mo/_report-structure.json')) as { files: Array<{ path: string }> }
  expect(manifest.files.map((file) => file.path)).toEqual(['contents/02-beta.md', 'contents/01-alpha.md'])
})

// ---- T-ORD ---------------------------------------------------------------------------------------------------------

test('T-ORD: a stale order is refused as stale and nothing is written; the next read shows the order on disk', async () => {
  await pangramFolio(root, 'paper')
  const shown = await keysOf('paper')
  // Another writer swapped the two lines after the room read them.
  const index = await read('paper/_paper_INDEX.md')
  await writeFile(join(root, 'paper/_paper_INDEX.md'), index.replace('- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n- [[Details]]\n', '- [[Details]]\n- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n'))
  const before = await tree()
  const result = await roomMove('paper', 1, 0, shown)
  expect(result).toMatchObject({ ok: false, stale: true })
  expect(await tree()).toEqual(before)
  expect((await keysOf('paper')).map((part) => part.title)).toEqual(['Details', 'Summary'])
})

test('T-ORD: an external edit to the Index Note\'s cover prose after the room read it does not stop the reorder, and the edit is kept', async () => {
  await pangramFolio(root, 'paper')
  const shown = await keysOf('paper')
  const index = await read('paper/_paper_INDEX.md')
  const edited = index.replace('# Synthetic report\n', '# Synthetic report\n\nA cover line written in another editor.\n')
  await writeFile(join(root, 'paper/_paper_INDEX.md'), edited)
  const result = await roomMove('paper', 1, 0, shown)
  expect(result).toMatchObject({ ok: true, changed: true })
  const written = await read('paper/_paper_INDEX.md')
  expect(written).toContain('A cover line written in another editor.')
  expect(written.indexOf('[[./contents/02-report.md|Details]]')).toBeLessThan(written.indexOf('[[./contents/01-summary.md|Summary]]'))
})

test('T-ORD: Undo (the plan-reorder step: the inverse order over the order the write left) puts the order back; after a later reorder it is refused and writes nothing', async () => {
  await formsFolio(root, 'forms')
  const shown = await keysOf('forms')
  const h = harness()
  const order = moveOrder(shown.length, 2, 0) as number[]
  const done = await h.invoke<RoomOrderResult>('plan:reorder-parts', { dir: 'forms', order, expected: shown, room: true })
  if (!done.ok) throw new Error(done.message)
  const undo = { dir: 'forms', order: inverseOrder(order), expected: done.parts, room: true }
  const undone = await h.invoke<RoomOrderResult>('plan:reorder-parts', undo)
  expect(undone).toMatchObject({ ok: true, changed: true })
  expect(await keysOf('forms')).toEqual(shown)
  // Again: a reorder, then a later reorder, then the first one's Undo.
  const again = await h.invoke<RoomOrderResult>('plan:reorder-parts', { dir: 'forms', order, expected: shown, room: true })
  if (!again.ok) throw new Error(again.message)
  const later = await roomMove('forms', 5, 0)
  expect(later.ok).toBe(true)
  const before = await tree()
  const stale = await h.invoke<RoomOrderResult>('plan:reorder-parts', { dir: 'forms', order: inverseOrder(order), expected: again.parts, room: true })
  expect(stale).toMatchObject({ ok: false, stale: true })
  expect(await tree()).toEqual(before)
})

test('T-ORD: a malformed room flag is refused before anything is read', async () => {
  await pangramFolio(root, 'paper')
  const before = await tree()
  await expect(harness().invoke('plan:reorder-parts', { dir: 'paper', order: [1, 0], expected: await keysOf('paper'), room: 'yes' })).rejects.toThrow('Invalid running order.')
  expect(await tree()).toEqual(before)
})

// ---- T-CLASH -------------------------------------------------------------------------------------------------------

test('T-CLASH F-CLASH: a reorder and an Undo are refused while two lines share a title, writing nothing; renaming one clears it', async () => {
  await clashFolio(root, 'clash')
  const shown = await keysOf('clash')
  const before = await tree()
  const moved = await roomMove('clash', 0, 2, shown)
  expect(moved).toEqual({ ok: false, stale: false, message: clashRefusal('Results') })
  // An Undo step is the same call over the order a write left: refused the same way.
  const undo = await harness().invoke<RoomOrderResult>('plan:reorder-parts', { dir: 'clash', order: [1, 0, 2, 3], expected: shown, room: true })
  expect(undo).toEqual({ ok: false, stale: false, message: clashRefusal('Results') })
  expect(await tree()).toEqual(before)
  // Rename one of each pair (in the Index Note, as another editor or the inspector would): the reorder goes through.
  const index = await read('clash/_clash_INDEX.md')
  await writeFile(join(root, 'clash/_clash_INDEX.md'), index.replace('- [[Results]] — Second gloss.', '- [[Results in detail]] — Second gloss.').replace('- [[Same]] — One.', '- [[./same-a.md|Same]] — One.').replace('- [[Same]] — Two.', '- [[./same-b.md|Same again]] — Two.'))
  const renamed = await keysOf('clash')
  expect(renamed.map((part) => part.title)).not.toContain(undefined)
  const after = await roomMove('clash', 1, 0, renamed)
  expect(after).toMatchObject({ ok: true, changed: true })
  expect((await keysOf('clash')).map((part) => part.title).slice(0, 2)).toEqual([renamed[1].title, renamed[0].title])
})

test('T-CLASH: the clash is judged by the Plan\'s title key, case and Unicode form folded', async () => {
  await clashFolio(root, 'clash')
  await writeFile(join(root, 'clash/_clash_INDEX.md'), '# Clash\n\n## Running order\n\n- [[Café]]\n- [[CAFÉ]]\n- [[Other]]\n')
  const before = await tree()
  const result = await roomMove('clash', 2, 0)
  expect(result).toMatchObject({ ok: false, stale: false })
  expect(await tree()).toEqual(before)
})

// ---- New card ------------------------------------------------------------------------------------------------------

test('New card: adds one unwritten plan line at the end of the Index Note and nothing else; it reads as an unwritten part', async () => {
  const folio = await pangramFolio(root, 'paper')
  await supportFiles('paper')
  const before = await tree()
  const index = await read(folio.indexPath as string)
  const h = harness()
  const result = await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: '  Data privacy and approvals ', expected: await keysOf('paper') })
  expect(result).toMatchObject({ ok: true, index: 2 })
  if (!result.ok) throw new Error(result.message)
  expect(result.manifestCreated).toBeUndefined()
  expect(result.parts.at(-1)).toEqual({ title: 'Data privacy and approvals', path: null })
  expect(await read(folio.indexPath as string)).toBe(pinnedIndex(`${index}- [[Data privacy and approvals]]\n`, {"Summary":"./contents/01-summary.md|Summary","Details":"./contents/02-report.md|Details"}))
  const after = await tree()
  const changedFiles = Object.keys(after).filter((key) => after[key] !== before[key])
  // The Index Note and the Plan's pristine copies (taken before every Plan write); no part file, and the manifest's bytes are as they were.
  expect(changedFiles.sort()).toEqual(['paper/_paper_INDEX.md', 'paper/_paper_INDEX.md.writeflex-backup', 'paper/_paper_INDEX.md.writeflex-backup.json', 'paper/_report-structure.json.writeflex-backup', 'paper/_report-structure.json.writeflex-backup.json'])
  expect(after['paper/_report-structure.json']).toBe(before['paper/_report-structure.json'])
  const plan = await readPlan(ws, 'paper')
  expect(plan?.parts.at(-1)).toMatchObject({ title: 'Data privacy and approvals', path: null })
})

test('New card: a title that clashes with a part (case and form folded), an empty title and an unwritable one are each refused and write nothing', async () => {
  await pangramFolio(root, 'paper')
  const before = await tree()
  const h = harness()
  const expected = await keysOf('paper')
  expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'details', expected })).toEqual({ ok: false, stale: false, message: newCardClashRefusal('details') })
  expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: '   ', expected })).toMatchObject({ ok: false, stale: false })
  expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'A #tag', expected })).toMatchObject({ ok: false, stale: false })
  expect(await tree()).toEqual(before)
})

test('New card: refused as stale when the running order changed after the room read it (also when the new line would clash with a line added meanwhile)', async () => {
  await pangramFolio(root, 'paper')
  const shown = await keysOf('paper')
  const index = await read('paper/_paper_INDEX.md')
  await writeFile(join(root, 'paper/_paper_INDEX.md'), `${index}- [[Methods]]\n`)
  const before = await tree()
  const result = await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'Methods', expected: shown })
  expect(result).toMatchObject({ ok: false, stale: true })
  expect(await tree()).toEqual(before)
})

test('New card on F-INDEX-ONLY creates the manifest and says so; a manifest-only Folio stays manifest-only', async () => {
  await indexOnlyFolio(root, 'index-only')
  const made = await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'Four', expected: await keysOf('index-only') })
  expect(made).toMatchObject({ ok: true, manifestCreated: true })
  expect(await exists('index-only/_report-structure.json')).toBe(true)

  await manifestOnlyFolio(root, 'mo')
  const manifest = await read('mo/_report-structure.json')
  const added = await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'mo', title: 'Gamma', expected: await keysOf('mo') })
  expect(added).toMatchObject({ ok: false, message: expect.stringContaining('manifest only') })
  expect(await exists('mo/_mo_INDEX.md')).toBe(false)
  expect(await read('mo/_report-structure.json')).toBe(manifest)
})

test('New card Undo: takes the line out again while the order is the one New card left; refused after another change, writing nothing', async () => {
  await pangramFolio(root, 'paper')
  const index = await read('paper/_paper_INDEX.md')
  const h = harness()
  const made = await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'Methods', expected: await keysOf('paper') })
  if (!made.ok) throw new Error(made.message)
  const undone = await h.invoke<RoomOrderResult>('plan:room-remove-card', { dir: 'paper', index: made.index, title: 'Methods', expected: made.parts })
  expect(undone).toMatchObject({ ok: true, changed: true })
  expect(await read('paper/_paper_INDEX.md')).toBe(pinnedIndex(index, {"Summary":"./contents/01-summary.md|Summary","Details":"./contents/02-report.md|Details"}))

  const again = await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'Methods', expected: await keysOf('paper') })
  if (!again.ok) throw new Error(again.message)
  const later = await roomMove('paper', 2, 0)
  expect(later.ok).toBe(true)
  const before = await tree()
  const stale = await h.invoke<RoomOrderResult>('plan:room-remove-card', { dir: 'paper', index: again.index, title: 'Methods', expected: again.parts })
  expect(stale).toMatchObject({ ok: false, stale: true })
  expect(await tree()).toEqual(before)
  // An Undo naming a card that is not the unwritten line it says is refused before anything is read.
  const wrong = await h.invoke<RoomOrderResult>('plan:room-remove-card', { dir: 'paper', index: 1, title: 'Methods', expected: await keysOf('paper') })
  expect(wrong).toMatchObject({ ok: false, stale: true })
  expect(await tree()).toEqual(before)
})

// ---- New card names a file already in the Folio (review S-1, S-5) -------------------------------------------------

/** F-INDEX-ONLY with a loose file under Not in the outline: `extra.md`, titled "Extra" (the reviewer's probe). */
async function indexOnlyWithLoose(): Promise<void> {
  await indexOnlyFolio(root, 'index-only')
  await writeFile(join(root, 'index-only/extra.md'), '# Extra\n\nExtra words.\n')
}

test('S-1 New card: a title that is a file under Not in the outline (its title or its file name) is refused in plain words and writes nothing', async () => {
  await indexOnlyWithLoose()
  await writeFile(join(root, 'index-only/field-notes.md'), '# Notes from the field\n\nNotes.\n')
  const before = await tree()
  const h = harness()
  const expected = await keysOf('index-only')
  const refused = await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'Extra', expected })
  expect(refused).toEqual({ ok: false, stale: false, message: newCardLooseRefusal('extra.md') })
  expect(newCardLooseRefusal('extra.md')).toBe('A file called extra.md is already in this Folio under Not in the outline. Drag it into the order instead of making a new card.')
  expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'notes from the FIELD', expected })).toEqual({ ok: false, stale: false, message: newCardLooseRefusal('field-notes.md') })
  expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'field-notes', expected })).toEqual({ ok: false, stale: false, message: newCardLooseRefusal('field-notes.md') })
  expect(await tree()).toEqual(before)
  expect(h.checkpoints).toEqual([])
})

test('S-5 New card: the Index Note\'s own name (its heading or its file name) and a reserved name are refused in plain words, with no backup written', async () => {
  await indexOnlyFolio(root, 'index-only')
  const before = await tree()
  const h = harness()
  const expected = await keysOf('index-only')
  for (const title of ['Index only', '_index-only_INDEX']) {
    expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title, expected })).toEqual({ ok: false, stale: false, message: NEW_CARD_INDEX_NOTE })
  }
  expect(NEW_CARD_INDEX_NOTE).toBe('That title is the name of the Folio’s own Index Note. Choose another title.')
  for (const title of ['AGENTS', 'CLAUDE.md', '_report-structure', '_index-only_EVIDENCE-AND-NOTES', 'map.canvas']) {
    expect(await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title, expected })).toEqual({ ok: false, stale: false, message: NEW_CARD_RESERVED })
  }
  expect(await tree()).toEqual(before)
  expect(h.checkpoints).toEqual([])
})

test('S-1 New card: a title that resolves to some other file of the Folio (here its README cover) is refused on the write\'s own read, writing nothing', async () => {
  await indexOnlyFolio(root, 'index-only')
  await writeFile(join(root, 'index-only/README.md'), '# About\n\nA cover.\n')
  const before = await tree()
  const result = await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'README', expected: await keysOf('index-only') })
  expect(result).toMatchObject({ ok: false, stale: false })
  if (result.ok) throw new Error('added')
  expect(result.message).toBe(newCardFileRefusal('README.md'))
  expect(result.message).not.toContain('Fallback path')
  expect(await tree()).toEqual(before)
})

// ---- A created manifest that keeps files not in the running order says so (review S-2) ----------------------------

test('S-2: the first room reorder on F-INDEX-ONLY with a loose file keeps it in export at the end, as ticket 06 does, and says so', async () => {
  await indexOnlyWithLoose()
  const result = await roomMove('index-only', 1, 0) // Two, One, Three
  expect(result).toMatchObject({ ok: true, changed: true, manifestCreated: true, notInRunningOrder: ['index-only/extra.md'] })
  const manifest = JSON.parse(await read('index-only/_report-structure.json')) as { files: Array<{ path: string }> }
  expect(manifest.files.map((file) => file.path)).toEqual(['two.md', 'one.md', 'extra.md'])
  expect(withManifestNote('Moved Two to 1 of 3', result.manifestCreated, result.notInRunningOrder)).toBe(
    'Moved Two to 1 of 3. This Folio now has a manifest, so export and sharing follow its running order. 1 file not in the running order stays in export, at the end: extra.md.',
  )
  // The next reorder creates nothing and says nothing of it.
  const second = await roomMove('index-only', 0, 1)
  expect(second.manifestCreated).toBeUndefined()
  expect(second.notInRunningOrder).toBeUndefined()
})

test('S-2: with no loose file the sentence is the manifest sentence alone; more than three files are named up to three, then "and n more"', async () => {
  await indexOnlyFolio(root, 'index-only')
  const result = await roomMove('index-only', 1, 0)
  expect(result).toMatchObject({ ok: true, manifestCreated: true })
  expect(result.notInRunningOrder).toBeUndefined()
  expect(manifestCreatedSentence(result.notInRunningOrder)).toBe(MANIFEST_CREATED)
  expect(manifestCreatedSentence(['f/a.md', 'f/b.md'])).toBe(`${MANIFEST_CREATED} 2 files not in the running order stay in export, at the end: a.md, b.md.`)
  expect(manifestCreatedSentence(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])).toBe(`${MANIFEST_CREATED} 5 files not in the running order stay in export, at the end: a.md, b.md, c.md and 2 more.`)
})

test('S-2: New card and Make export follow the running order that create the manifest name the loose files it keeps in export', async () => {
  await indexOnlyWithLoose()
  const made = await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'Four', expected: await keysOf('index-only') })
  expect(made).toMatchObject({ ok: true, manifestCreated: true, notInRunningOrder: ['index-only/extra.md'] })

  await rm(join(root, 'index-only'), { recursive: true })
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
  await indexOnlyWithLoose()
  const h = harness()
  const check = await h.invoke<{ expected: unknown }>('plan:export-order', { dir: 'index-only' })
  const repaired = await h.invoke<ExportOrderRepairResult>('plan:align-manifest', { dir: 'index-only', expected: check.expected })
  expect(repaired).toMatchObject({ ok: true, changed: true, notInRunningOrder: ['index-only/extra.md'] })
})

test('T-2: New card in a "Start a plan" Folio writes the Running order heading and the card; a created manifest names the loose file it keeps', async () => {
  await noRunningOrderFolio(root, 'no-order')
  const made = await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'no-order', title: 'Methods', expected: [] })
  expect(made).toEqual({ ok: true, parts: [{ title: 'Methods', path: null }], index: 0, manifestCreated: true, notInRunningOrder: ['no-order/loose.md'] })
  expect(await read('no-order/_no-order_INDEX.md')).toContain('## Running order')
  expect(await read('no-order/_no-order_INDEX.md')).toContain('[[Methods]]')
})

test('T-4: a New card that was written and could not be read again still says it created the manifest', async () => {
  await indexOnlyFolio(root, 'index-only')
  const expected = await keysOf('index-only')
  let failing = false
  const listFiles = ws.listFiles.bind(ws)
  ws.listFiles = (async () => {
    if (failing) throw new Error(`EIO: i/o error, scandir '${root}'`)
    return listFiles()
  }) as typeof ws.listFiles
  try {
    const h = harness(async (path) => { if (path.endsWith('_report-structure.json')) failing = true })
    const made = await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'index-only', title: 'Four', expected })
    expect(made).toMatchObject({ ok: true, manifestCreated: true, index: 3 })
  } finally {
    ws.listFiles = listFiles
  }
  expect(await exists('index-only/_report-structure.json')).toBe(true)
})

// ---- T-CONTAIN -----------------------------------------------------------------------------------------------------

/** A second Folio beside `paper/`, which a write must never reach. */
async function otherFolio(): Promise<void> {
  await mkdir(join(root, 'other/contents'), { recursive: true })
  await writeFile(join(root, 'other/_other_INDEX.md'), '# Other\n\n## Running order\n\n- [[Notes]]\n')
  await writeFile(join(root, 'other/contents/notes.md'), '# Notes\n\nNotes of the other Folio.\n')
}
/** F-LINK on the Folio folder: `paper/` moved inside the other Folio and a link to it put at its old name. */
const linkFolioIntoOther = async (): Promise<void> => {
  await rename(join(root, 'paper'), join(root, 'other/paper'))
  await symlink(join(root, 'other/paper'), join(root, 'paper'))
}
/** F-LINK on the parts folder: `paper/contents` a link to the other Folio's `contents/`, holding the parts. */
const linkContentsIntoOther = async (): Promise<void> => {
  await rm(join(root, 'other/contents'), { recursive: true })
  await rename(join(root, 'paper/contents'), join(root, 'other/contents'))
  await symlink(join(root, 'other/contents'), join(root, 'paper/contents'))
}

test('T-CONTAIN F-LINK: a room reorder with `paper/contents` a link into the other Folio is refused, and both Folios are byte-identical', async () => {
  await pangramFolio(root, 'paper')
  await otherFolio()
  await linkContentsIntoOther()
  const before = await tree()
  const result = await roomMove('paper', 1, 0)
  expect(result.ok).toBe(false)
  expect(await tree()).toEqual(before)
})

test('T-CONTAIN race: the Folio folder becomes a link into the other Folio at the reorder\'s checkpoint: refused in the room\'s words, and the other Folio is byte-identical', async () => {
  await pangramFolio(root, 'paper')
  await otherFolio()
  let other: Record<string, string> = {}
  let linked = false
  const h = harness(async () => {
    if (linked) return
    linked = true
    await linkFolioIntoOther()
    other = await tree(join(root, 'other'))
  })
  const result = await roomMove('paper', 1, 0, await keysOf('paper'), h)
  expect(result).toEqual({ ok: false, stale: false, message: FOLIO_REFUSAL })
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('T-CONTAIN race: Make export follow the running order writes through the room\'s view: the Folio folder linked away at its checkpoint → refused, the other Folio byte-identical', async () => {
  await pangramFolio(root, 'paper')
  // Out of step: the manifest lists Details before Summary (a crash between the two writes of a Plan change).
  const manifest = JSON.parse(await read('paper/_report-structure.json')) as { files: unknown[] }
  await writeFile(join(root, 'paper/_report-structure.json'), JSON.stringify({ ...manifest, files: [...manifest.files].reverse() }, null, 2))
  await otherFolio()
  invalidateFolioPlaces(root)
  const check = await harness().invoke<{ expected: { parts: PlanPartKey[]; manifestExists: boolean } }>('plan:export-order', { dir: 'paper' })
  let other: Record<string, string> = {}
  const h = harness(async () => { await linkFolioIntoOther(); other = await tree(join(root, 'other')) })
  const result = await h.invoke<{ ok: boolean; message?: string }>('plan:align-manifest', { dir: 'paper', expected: check.expected })
  expect(result).toEqual({ ok: false, message: FOLIO_REFUSAL })
  expect(Object.keys(other).length).toBeGreaterThan(0)
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('reorderRoomParts takes the room\'s view: a refused clash reads nothing and an ordinary move writes through the pin', async () => {
  await pangramFolio(root, 'paper')
  const fws = new FolioWorkspace(ws, 'paper')
  const outcome = await reorderRoomParts(fws, { order: [1, 0], expected: await keysOf('paper') })
  expect(outcome.result).toMatchObject({ ok: true, changed: true })
  expect(outcome.plan?.parts.map((part) => part.title)).toEqual(['Details', 'Summary'])
})


for (const action of ['reorder', 'add', 'remove'] as const) {
  test(`orphan manifest record is set aside before Folio room ${action}`, async () => {
    await pangramFolio(root, 'paper')
    const sidecar = 'paper/_report-structure.json.writeflex-backup.json'
    await writeFile(join(root, sidecar), 'orphan evidence\n')
    const fws = new FolioWorkspace(ws, 'paper')
    if (action === 'reorder') {
      expect((await reorderRoomParts(fws, { order: [1, 0], expected: await keysOf('paper') })).result.ok).toBe(true)
    } else if (action === 'add') {
      expect((await harness().invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'Methods', expected: await keysOf('paper') })).ok).toBe(true)
    } else {
      const h = harness()
      const made = await h.invoke<RoomCardResult>('plan:room-new-card', { dir: 'paper', title: 'Methods', expected: await keysOf('paper') })
      if (!made.ok) throw new Error(made.message)
      await rm(join(root, 'paper/_report-structure.json.writeflex-backup'))
      await writeFile(join(root, sidecar), 'orphan evidence\n')
      expect((await h.invoke<RoomOrderResult>('plan:room-remove-card', { dir: 'paper', index: made.index, title: 'Methods', expected: made.parts })).ok).toBe(true)
    }
    await expect(fws.setAsideBackupRecord(sidecar, 'paper/record.json')).rejects.toThrow()
    const names = await readdir(join(root, '.writeflex/backup-records-set-aside'))
    expect(await read(`.writeflex/backup-records-set-aside/${names[0]}`)).toBe('orphan evidence\n')
    await expect(fws.setAsideBackupRecord('other/record.writeflex-backup.json', '.writeflex/backup-records-set-aside/record.json')).rejects.toThrow(FOLIO_REFUSAL)
  })
}
