/**
 * The Folio page and the Outline's Folio part read one Folio: the same folder and Index Note whatever file is
 * open, the same running order and the same "Not in the outline" when the Index Note names no part yet (the
 * manifest's order, read by the Plan itself), never the "Start a Folio outline" state for a Folio, a create of the
 * Index Note refused in main when the Folio has one (or the folder is inside another Folio), and the first change
 * writing the running order it showed exactly once. Shapes from two real Folios (2026-10-19).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME, indexNotePath } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { folioOutline } from '../../src/main/folio-outline'
import { folioContaining, folioDirOf, folioPlace, invalidateFolioPlaces } from '../../src/main/folio-place'
import { INDEX_NOTE_EXISTS, INSIDE_ANOTHER_FOLIO } from '../../src/main/folio-index-note'
import { moveFolioPiece } from '../../src/main/folio-running-order'
import { createIndexNote, firstParagraphAfterH1, listCollection, setCollectionPieceMode } from '../../src/main/collection'
import { setCollectionCounted } from '../../src/main/diary'
import { prepareProposal, runPlanOperations } from '../../src/main/plan-proposal'
import { INDEX_NOTE_NOT_READABLE, MANIFEST_NOT_READABLE, movePart, readFolioPlan, readPlan, removePart, setPartRole } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { Workspace } from '../../src/main/workspace'
import { planDirFor } from '../../src/renderer/src/app/plan-dir'

let root: string
let ws: Workspace
const DIR = 'reports/review'
const INDEX = `${DIR}/_review_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const NAMES = ['00-title', '01-summary', '02-map', '03-catalogue', '04-findings']
const ORDER = NAMES.map((name) => `${DIR}/contents/${name}.md`)

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-lookup-'))
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
const titleOf = (name: string): string => `Part ${name}`
const fresh = (): void => { invalidateFolioPlaces(root); invalidateFolioOrderFacts(root) }

/** Case 1's shape: `content_root: contents`, parts with frontmatter (so `contents/` is a Collection by itself), two widget sources not in the manifest. */
async function reviewFolio(index: string | null): Promise<void> {
  for (const name of NAMES) {
    await write(`${DIR}/contents/${name}.md`, `---\ntitle: "${titleOf(name)}"\nstatus: "draft"\ndate: "2026-10-19"\n---\n\n# ${titleOf(name)}\n\nText.\n`)
  }
  await write(`${DIR}/contents/widget-map-source.md`, '# Widget map source\n')
  await write(`${DIR}/contents/nested/deep-note.md`, '# Deep note\n')
  await write(`${DIR}/README.md`, '# Review\n\nAbout this folder.\n')
  await write(`${DIR}/research/notes.md`, '# Notes\n')
  await write(MANIFEST, JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    files: NAMES.map((name, at) => ({ path: `${name}.md`, role: at === NAMES.length - 1 ? 'appendix' : 'section' })),
  }, null, 2))
  if (index !== null) await write(INDEX, index)
}

/** The page's picture and the Outline's, for the file that is open. */
async function bothSurfaces(open: string) {
  fresh()
  const dir = await planDirFor({ file: open }, { folioDirOf: (folder) => folioDirOf(ws, folder), collectionDirFor: async () => 'wrong' })
  const plan = await readFolioPlan(ws, dir)
  const outline = await folioOutline(ws, open)
  return {
    dir,
    plan,
    outline,
    pageOrder: plan?.parts.map((part) => part.path) ?? null,
    pageNotIn: new Set(plan?.unlisted.map((part) => part.path) ?? []),
    sidebarOrder: outline?.pieces.map((piece) => piece.path) ?? null,
    sidebarNotIn: new Set(outline?.also.map((file) => file.path) ?? []),
  }
}

test('the Folio, its Index Note and its running order resolve the same from the Index Note, a root file, a contents part and a nested part', async () => {
  await reviewFolio('# review\n')
  for (const open of [INDEX, `${DIR}/README.md`, `${DIR}/contents/00-title.md`, `${DIR}/contents/nested/deep-note.md`]) {
    const seen = await bothSurfaces(open)
    expect(seen.dir).toBe(DIR)
    expect((await folioContaining(ws, open))?.dir).toBe(DIR)
    expect((await folioPlace(ws, open))?.dir).toBe(DIR)
    expect(seen.plan?.indexPath).toBe(INDEX)
    expect(seen.outline?.dir).toBe(DIR)
    expect(seen.pageOrder).toEqual(ORDER)
    expect(seen.sidebarOrder).toEqual(ORDER)
  }
  // A sub-folder of the Folio shown as a Collection (the folder view, the Board) opens the Folio's page too.
  expect(await planDirFor({ folder: `${DIR}/contents` }, { folioDirOf: (folder) => folioDirOf(ws, folder), collectionDirFor: async () => 'wrong' })).toBe(DIR)
  // A file in no Folio keeps the nearest Collection.
  await write('loose/a.md', '# A\n')
  expect(await planDirFor({ file: 'loose/a.md' }, { folioDirOf: (folder) => folioDirOf(ws, folder), collectionDirFor: async () => 'loose' })).toBe('loose')
})

test('case 1: an Index Note that is only its H1 shows the manifest order on both surfaces, with the same Not in the outline', async () => {
  await reviewFolio('# review\n')
  const seen = await bothSurfaces(`${DIR}/contents/00-title.md`)
  expect(seen.plan?.orderFrom).toBe('manifest')
  expect(seen.pageOrder).toEqual(ORDER)
  expect(seen.sidebarOrder).toEqual(seen.pageOrder)
  expect(seen.pageNotIn).toEqual(seen.sidebarNotIn)
  expect([...seen.pageNotIn].sort()).toEqual([`${DIR}/contents/nested/deep-note.md`, `${DIR}/contents/widget-map-source.md`])
  // The manifest's roles come with the order.
  expect(seen.plan?.parts.at(-1)?.role).toBe('appendix')
  // The Outline may change it: the same Plan writes take it (no "change it in the Folio outline" state).
  expect(seen.outline?.orderInPlanOnly).toBeUndefined()
  // Nothing was written by the reads.
  expect(await read(INDEX)).toBe('# review\n')
})

test('case 2: a Running order heading with no part under it shows the manifest order on both surfaces and is never the gloss', async () => {
  await reviewFolio('# review\n\n## Running order\n\n- Plain line, not a part\n')
  const seen = await bothSurfaces(`${DIR}/contents/01-summary.md`)
  expect(seen.pageOrder).toEqual(ORDER)
  expect(seen.sidebarOrder).toEqual(ORDER)
  expect(seen.pageNotIn).toEqual(seen.sidebarNotIn)
  expect(seen.pageNotIn.size).toBe(2)
  expect((await listCollection(ws, DIR)).cover?.text ?? null).toBeNull()
})

test('a heading line is never the cover gloss; prose under the H1 still is', () => {
  expect(firstParagraphAfterH1('# Title\n## Running order\n')).toBeNull()
  expect(firstParagraphAfterH1('# Title\n\n## Running order\n\n- [[A]]\n')).toBeNull()
  expect(firstParagraphAfterH1('# Title\n\n   ### Notes\n')).toBeNull()
  expect(firstParagraphAfterH1('# Title\n\nA short gloss.\n## Running order\n')).toBe('A short gloss.')
  expect(firstParagraphAfterH1('# Title\n\nA short gloss\nover two lines.\n\n## Running order\n')).toBe('A short gloss over two lines.')
})

test('a Folio with a manifest and no Index Note reads as its first Index Note would: never the Start state, nothing written', async () => {
  await reviewFolio(null)
  expect(await readPlan(ws, DIR)).toBeNull()
  const plan = await readFolioPlan(ws, DIR)
  expect(plan?.orderFrom).toBe('manifest')
  expect(plan?.indexNoteAbsent).toBe(true)
  expect(plan?.indexPath).toBe(INDEX)
  expect(plan?.parts.map((part) => part.path)).toEqual(ORDER)
  expect(existsSync(join(root, INDEX))).toBe(false)
  // A plain folder still has no Plan, so the Start state is offered only there.
  await write('plain/a.md', '# A\n')
  expect(await readFolioPlan(ws, 'plain')).toBeNull()
})

test('creating the Index Note is refused in main when the Folio has one, or the folder is inside another Folio; nothing is written', async () => {
  await reviewFolio('# review\n\nKept prose.\n')
  await expect(createIndexNote(ws, DIR)).rejects.toThrow(INDEX_NOTE_EXISTS('_review_INDEX.md'))
  expect(await read(INDEX)).toBe('# review\n\nKept prose.\n')
  // The bug's path: a part in contents/ resolved the page to contents/, whose Start would have made a second Index Note.
  await expect(createIndexNote(ws, `${DIR}/contents`)).rejects.toThrow(INSIDE_ANOTHER_FOLIO('review'))
  expect(existsSync(join(root, indexNotePath(ws, `${DIR}/contents`)))).toBe(false)
  // Inside a Folio with no Index Note yet: still refused for the sub-folder.
  await rm(join(root, INDEX))
  fresh()
  await expect(createIndexNote(ws, `${DIR}/research`)).rejects.toThrow(INSIDE_ANOTHER_FOLIO('review'))
  expect(existsSync(join(root, `${DIR}/research/_research_INDEX.md`))).toBe(false)
  // The Folio's own folder may get its first one, and a plain folder may too.
  expect(await createIndexNote(ws, DIR)).toBe(INDEX)
  await write('plain/a.md', '# A\n')
  expect(await createIndexNote(ws, 'plain')).toBe('plain/_plain_INDEX.md')
})

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1

test('the first page change writes the running order it showed with the change, once; later changes do not write it again', async () => {
  await reviewFolio('# review\n')
  // Move the last part to the front: one write.
  const moved = await movePart(ws, DIR, NAMES.length - 1, 0)
  const expected = [ORDER.at(-1), ...ORDER.slice(0, -1)]
  expect(moved.parts.map((part) => part.path)).toEqual(expected)
  expect(moved.orderFrom).toBeUndefined()
  let index = await read(INDEX)
  expect(index).toBe(`# review\n\n## Running order\n\n${[NAMES.at(-1)!, ...NAMES.slice(0, -1)].map((name) => `- [[${titleOf(name)}]]${name === NAMES.at(-1) ? ' #appendix' : ''}`).join('\n')}\n`)
  // The manifest followed.
  expect((JSON.parse(await read(MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual([NAMES.at(-1), ...NAMES.slice(0, -1)].map((name) => `${name}.md`))
  // A second change edits the written order; nothing is added twice.
  await setPartRole(ws, DIR, 1, 'summary', { title: titleOf(NAMES[0]), path: ORDER[0], gloss: null, role: 'section', tags: [] })
  await removePart(ws, DIR, 2)
  index = await read(INDEX)
  expect(occurrences(index, '## Running order')).toBe(1)
  for (const name of NAMES) expect(occurrences(index, `[[${titleOf(name)}]]`)).toBeLessThanOrEqual(1)
  expect(occurrences(index, `[[${titleOf(NAMES[1])}]]`)).toBe(0)
  fresh()
  const outline = await folioOutline(ws, ORDER[0])
  expect(outline?.pieces.map((piece) => piece.path)).toEqual((await readPlan(ws, DIR))?.parts.map((part) => part.path))
})

test('the Outline\'s drag on such a Folio goes through the same Plan write: the order and the move, in one write', async () => {
  await reviewFolio('# review\n')
  const outcome = await moveFolioPiece(ws, DIR, { path: ORDER[2], beforePath: ORDER[0], expected: ORDER })
  expect(outcome.result.ok).toBe(true)
  const index = await read(INDEX)
  expect(occurrences(index, '## Running order')).toBe(1)
  expect(index.indexOf(`[[${titleOf(NAMES[2])}]]`)).toBeLessThan(index.indexOf(`[[${titleOf(NAMES[0])}]]`))
  for (const name of NAMES) expect(occurrences(index, `[[${titleOf(name)}]]`)).toBe(1)
})

function harness() {
  const handlers = new Map<string, PlanIpcHandler>()
  const checkpoints: string[] = []
  const collectionChanges: string[][] = []
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { checkpoints.push(path) },
    notifyCollectionChanged: (_state, paths) => collectionChanges.push(paths),
    notifyChangedOnDisk: () => undefined,
  })
  const invoke = (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
  return { invoke, checkpoints, collectionChanges }
}

test('the page on a Folio with no Index Note: plan:read shows the manifest order; the first move creates the Index Note and writes the order with the move', async () => {
  await reviewFolio(null)
  const api = harness()
  const shown = await api.invoke('plan:read', { dir: DIR }) as { parts: Array<{ path: string }>; indexNoteAbsent?: true }
  expect(shown.indexNoteAbsent).toBe(true)
  expect(shown.parts.map((part) => part.path)).toEqual(ORDER)
  const moved = await api.invoke('plan:move-part', { dir: DIR, from: 1, to: 0 }) as { parts: Array<{ path: string }> }
  expect(moved.parts.map((part) => part.path)).toEqual([ORDER[1], ORDER[0], ...ORDER.slice(2)])
  const index = await read(INDEX)
  expect(index.startsWith('# review\n\n## Running order\n\n')).toBe(true)
  for (const name of NAMES) expect(occurrences(index, `[[${titleOf(name)}]]`)).toBe(1)
  expect(api.collectionChanges.some((paths) => paths.includes(INDEX))).toBe(true)
  // The write was checkpointed like every Plan write (its Undo).
  expect(api.checkpoints).toContain(INDEX)
})

// ---- Sol round 1 (2026-10-20) ----

/** Two parts headed `# Same`, listed b then a; `index`: the Index Note's text, or null for none. */
async function sameTitleFolio(index: string | null): Promise<string[]> {
  await write(`${DIR}/contents/b.md`, '# Same\n\nB.\n')
  await write(`${DIR}/contents/a.md`, '# Same\n\nA.\n')
  await write(MANIFEST, JSON.stringify({ schema_version: 1, content_root: 'contents', files: [{ path: 'b.md' }, { path: 'a.md' }] }, null, 2))
  if (index !== null) await write(INDEX, index)
  return [`${DIR}/contents/b.md`, `${DIR}/contents/a.md`]
}

for (const index of ['# review\n', null]) {
  test(`two parts with one title both go in, told apart by path, on the page and in the sidebar (${index === null ? 'no Index Note' : 'Index Note with no order'})`, async () => {
    const [b, a] = await sameTitleFolio(index)
    const seen = await bothSurfaces(a)
    expect(seen.pageOrder).toEqual([b, a])
    expect(seen.sidebarOrder).toEqual([b, a])
    expect(seen.pageNotIn.has(a) || seen.pageNotIn.has(b)).toBe(false)
    expect(seen.sidebarNotIn.has(a) || seen.sidebarNotIn.has(b)).toBe(false)
    expect(seen.plan?.parts.map((part) => part.title)).toEqual(['./contents/b', './contents/a'])
    // The first page change writes both lines by path, with the change: both surfaces still agree.
    const api = harness()
    const moved = await api.invoke('plan:move-part', { dir: DIR, from: 1, to: 0 }) as { parts: Array<{ path: string }>; unlisted: Array<{ path: string }> }
    expect(moved.parts.map((part) => part.path)).toEqual([a, b])
    expect(await read(INDEX)).toContain('## Running order\n\n- [[./contents/a]]\n- [[./contents/b]]\n')
    const after = await bothSurfaces(b)
    expect(after.pageOrder).toEqual([a, b])
    expect(after.sidebarOrder).toEqual([a, b])
    expect(after.pageNotIn.has(a) || after.pageNotIn.has(b)).toBe(false)
    // Renaming one later: its path line still names it.
    await write(a, '# Alpha\n\nA.\n')
    expect((await bothSurfaces(a)).pageOrder).toEqual([a, b])
  })
}

/** The harness, with each checkpoint saying whether the file was there when it was taken. */
function recordingHarness() {
  const api = harness()
  const taken: Array<{ path: string; existed: boolean }> = []
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { taken.push({ path, existed: existsSync(join(root, path)) }) },
    notifyCollectionChanged: () => undefined,
    notifyChangedOnDisk: () => undefined,
  })
  return { ...api, taken, invoke: (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input) }
}

test('the first page change on a Folio with no Index Note is one step: a refused change writes nothing and takes no checkpoint', async () => {
  await reviewFolio(null)
  const manifest = await read(MANIFEST)
  const api = recordingHarness()
  await expect(api.invoke('plan:move-part', { dir: DIR, from: 99, to: 0 })).rejects.toThrow()
  expect(existsSync(join(root, INDEX))).toBe(false)
  expect(api.taken).toEqual([])
  await expect(api.invoke('plan:remove-part', { dir: DIR, index: 42 })).rejects.toThrow()
  await expect(api.invoke('plan:set-part-role', { dir: DIR, index: 0, role: 'summary', expected: { title: 'Wrong', path: null, gloss: null, role: 'section', tags: [] } })).rejects.toThrow()
  expect(existsSync(join(root, INDEX))).toBe(false)
  expect(api.taken).toEqual([])
  expect(await read(MANIFEST)).toBe(manifest)
})

test('the first page change checkpoints the Index Note as absent, then creates it holding the order and the change', async () => {
  await reviewFolio(null)
  const api = recordingHarness()
  await api.invoke('plan:move-part', { dir: DIR, from: 1, to: 0 })
  // The Index Note's checkpoint was taken while it was absent: its Undo is "no Index Note file".
  expect(api.taken.filter((item) => item.path === INDEX)).toEqual([{ path: INDEX, existed: false }])
  const index = await read(INDEX)
  expect(index.startsWith('# review\n\n## Running order\n\n')).toBe(true)
  expect(index.indexOf(`[[${titleOf(NAMES[1])}]]`)).toBeLessThan(index.indexOf(`[[${titleOf(NAMES[0])}]]`))
  // No pristine-copy backup is made of a file that did not exist.
  expect(existsSync(join(root, `${INDEX}.writeflex-backup`))).toBe(false)
})

test('the first page change: a manifest write that fails removes the Index Note it created; one that appeared meanwhile is never written over', async () => {
  await reviewFolio(null)
  const manifest = await read(MANIFEST)
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<Workspace['saveFileWithoutReadBack']>[2]) => {
    if (path === MANIFEST) throw new Error('disk full')
    return original(path, content, options)
  }) as Workspace['saveFileWithoutReadBack']
  const api = harness()
  await expect(api.invoke('plan:move-part', { dir: DIR, from: 1, to: 0 })).rejects.toThrow('put back as it was')
  expect(existsSync(join(root, INDEX))).toBe(false)
  expect(await read(MANIFEST)).toBe(manifest)
  ws.saveFileWithoutReadBack = original
  // Another writer creates the Index Note after the read (here: while the checkpoint is taken): the owner's file stands.
  const racing = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => racing.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async (_state, path) => { if (path === INDEX) await write(INDEX, '# Owner\n') },
    notifyCollectionChanged: () => undefined,
    notifyChangedOnDisk: () => undefined,
  })
  await expect(racing.get('plan:move-part')!({ sender: { id: 1 } }, { dir: DIR, from: 1, to: 0 })).rejects.toThrow('Another Index Note appeared')
  expect(await read(INDEX)).toBe('# Owner\n')
  expect(await read(MANIFEST)).toBe(manifest)
})

test('an Index Note that is a link never reads as "no Folio": the page read refuses with a sentence; only no manifest and no Index Note reads as null', async () => {
  await reviewFolio(null)
  await write(`${DIR}/real-index.md`, '# review\n\n## Running order\n\n- [[Part 00-title]]\n')
  await symlink(join(root, `${DIR}/real-index.md`), join(root, INDEX))
  await expect(readFolioPlan(ws, DIR)).rejects.toThrow(INDEX_NOTE_NOT_READABLE('_review_INDEX.md'))
  const api = harness()
  await expect(api.invoke('plan:read', { dir: DIR })).rejects.toThrow('is a link or not an ordinary file')
  // A page write refuses too, and nothing is written through the link.
  await expect(api.invoke('plan:move-part', { dir: DIR, from: 1, to: 0 })).rejects.toThrow('is a link or not an ordinary file')
  expect(await read(`${DIR}/real-index.md`)).toBe('# review\n\n## Running order\n\n- [[Part 00-title]]\n')
  // A dangling link is not "absent" either; nor is a link in a folder with no manifest.
  await rm(join(root, INDEX))
  await symlink(join(root, `${DIR}/gone.md`), join(root, INDEX))
  await expect(readFolioPlan(ws, DIR)).rejects.toThrow(INDEX_NOTE_NOT_READABLE('_review_INDEX.md'))
  await write('plain/a.md', '# A\n')
  await symlink(join(root, 'plain/a.md'), join(root, 'plain/_plain_INDEX.md'))
  await expect(readFolioPlan(ws, 'plain')).rejects.toThrow(INDEX_NOTE_NOT_READABLE('_plain_INDEX.md'))
  // A manifest file that cannot be read is not "no Folio".
  await write('broken/a.md', '# A\n')
  await write(`broken/${MANIFEST_NAME}`, '{ not json')
  await expect(readFolioPlan(ws, 'broken')).rejects.toThrow(MANIFEST_NOT_READABLE)
  // Nothing at either name: null, the one answer that offers Start.
  await write('empty/a.md', '# A\n')
  expect(await readFolioPlan(ws, 'empty')).toBeNull()
})

test('a setext heading under the H1 is a heading, never the cover gloss', () => {
  expect(firstParagraphAfterH1('# Title\n\nRunning order\n-------------\n')).toBeNull()
  expect(firstParagraphAfterH1('# Title\n\nRunning order\n=============\n')).toBeNull()
  expect(firstParagraphAfterH1('# Title\n\nTwo line\nheading\n---\n\n- [[A]]\n')).toBeNull()
  expect(firstParagraphAfterH1('# Title\n\nA gloss.\n\nRunning order\n---\n')).toBe('A gloss.')
  expect(firstParagraphAfterH1('# Title\n\nA gloss.\n- [[A]]\n')).toBe('A gloss. - [[A]]')
})

test('every Index Note creation obeys the ownership rule: an agent proposal for a Folio\'s content folder is refused and writes nothing', async () => {
  await reviewFolio('# review\n\nKept.\n')
  const contents = `${DIR}/contents`
  const second = indexNotePath(ws, contents)
  await expect(prepareProposal(ws, { dir: contents, changes: [{ op: 'insert', title: 'New part' }] })).rejects.toThrow(INSIDE_ANOTHER_FOLIO('review'))
  // Accept's run, should a staged proposal reach it: the creation itself refuses before anything is written.
  await expect(runPlanOperations(ws, contents, [{ op: 'createIndexNote' }, { op: 'insertPart', title: 'New part' }])).rejects.toThrow(INSIDE_ANOTHER_FOLIO('review'))
  expect(existsSync(join(root, second))).toBe(false)
  // The other callers of the one creation: a counted diary, a Folder Piece's mode.
  await expect(setCollectionCounted(ws, contents, true)).rejects.toThrow(INSIDE_ANOTHER_FOLIO('review'))
  await write(`${DIR}/contents/chapter/one.md`, '# One\n')
  await write(`${DIR}/contents/chapter/two.md`, '# Two\n')
  await expect(setCollectionPieceMode(ws, contents, `${DIR}/contents/chapter`, 'one-work')).rejects.toThrow(INSIDE_ANOTHER_FOLIO('review'))
  expect(existsSync(join(root, second))).toBe(false)
  expect(existsSync(join(root, `${DIR}/contents/chapter/_chapter_INDEX.md`))).toBe(false)
  expect(await read(INDEX)).toBe('# review\n\nKept.\n')
})
