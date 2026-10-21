import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeStore, closedCodeOf, closedReasonOf } from '../../src/main/changes'
import { fingerprintOf } from '../../src/main/guarded-document-read'
import { proposePartTitles } from '../../src/main/folio-part-proposals'
import { FRONT_MATTER_TITLE_REFUSED, registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { readFolioFrontMatter, readPlan } from '../../src/main/plan'
import { folioOutline } from '../../src/main/folio-outline'
import { folioPlace, invalidateFolioPlaces } from '../../src/main/folio-place'
import { WRITEFLEX_SELF_AUTHOR } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { isFrontMatterPart, partIsFrontMatter } from '../../src/shared/folio-front-matter'
import { frontMatterPathSet } from '../../src/main/folio-front-matter'
import { parseManifest } from '../../src/main/folio'

// Folio front matter (a title page: frontmatter plus a byline, no heading by design) is exempt from the
// heading checks: no missing-heading warning, no "Add the heading" proposal, no title conflict or its fixes.
// Seams: the predicate (shared/folio-front-matter.ts), the Plan and Outline readers, the proposal builder,
// and the Plan IPC `title:fix-part` / `title:fix-folio`.

test('a part is front matter by its line tag, its manifest role or the title_matter path, and by nothing else', () => {
  const path = 'book/00-title.md'
  expect(isFrontMatterPart({ path, lineTags: ['draft', 'front-matter'] })).toBe(true)
  expect(isFrontMatterPart({ path, lineTags: ['Front-Matter'] })).toBe(true)
  expect(isFrontMatterPart({ path, manifestRole: 'front-matter' })).toBe(true)
  expect(isFrontMatterPart({ path, manifestRole: 'title-matter' })).toBe(true)
  expect(isFrontMatterPart({ path, titleMatterPath: path })).toBe(true)
  // None of them.
  expect(isFrontMatterPart({ path })).toBe(false)
  expect(isFrontMatterPart({ path, lineTags: ['appendix', 'frontmatter'], manifestRole: 'section', titleMatterPath: 'book/other.md' })).toBe(false)
  expect(isFrontMatterPart({ path, titleMatterPath: null })).toBe(false)
})

test('the heading checks read front matter by the one rule (partIsFrontMatter); title_matter counts whatever its entry says', () => {
  const path = 'book/00-title.md'
  for (const signals of [{ lineTags: ['front-matter'] }, { manifestRole: 'title-matter' }, { manifestRole: 'section' }, { titleMatterPath: path }, { manifestRole: 'section', titleMatterPath: path }, {}]) {
    expect(isFrontMatterPart({ path, ...signals })).toBe(partIsFrontMatter({
      lineRole: signals.lineTags?.[0],
      entry: signals.manifestRole === undefined ? null : { role: signals.manifestRole },
      isTitleMatter: signals.titleMatterPath === path,
    }))
  }
  // The manifest's title_matter is front matter even when no entry and no line names it; toc false alone is not.
  const manifest = parseManifest('book', JSON.stringify({ schema_version: 1, title_matter: '00-title.md', files: [
    { path: '01-one.md', toc: false }, { path: '00b-preface.md', role: 'front-matter' },
  ] }))!
  const present = new Set(['book/00-title.md', 'book/00b-preface.md', 'book/01-one.md', 'book/02-two.md'])
  const lines = [{ path: 'book/02-two.md', role: 'front-matter', tags: [] }, { path: 'book/01-one.md', role: 'section', tags: [] }]
  expect([...frontMatterPathSet('book', manifest, present, lines)]).toEqual(['book/02-two.md', 'book/00b-preface.md', 'book/00-title.md'])
})

let root: string
let ws: Workspace
let changes: ChangeStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-front-matter-'))
  ws = new Workspace(root)
  changes = new ChangeStore(ws)
  invalidateFolioPlaces(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const seen = async (rel: string): Promise<{ path: string; fingerprint: string }> => ({ path: rel, fingerprint: fingerprintOf(await readFile(join(root, rel))) })

/** A title page: its title only in frontmatter, a byline that is a `#` line, so it would read as a conflict. */
const TITLE_PAGE = '---\ntitle: The Book of Cost\n---\n\n# Jane Doe\n\nOxford, 2026\n'
/** A title page with no heading at all. */
const BARE_TITLE_PAGE = '---\ntitle: The Book of Cost\n---\n\nJane Doe\n'
const CHAPTER = '---\ntitle: Chapter one\n---\n\n# Chapter one\n\nText.\n'

async function indexFolio(titlePage: string): Promise<void> {
  await write('book/_book_INDEX.md', '# Book\n\n## Running order\n\n- [[00-title]] #front-matter\n- [[01-chapter]]\n')
  await write('book/00-title.md', titlePage)
  await write('book/01-chapter.md', CHAPTER)
}

test('the front-matter set reads the line tag, the manifest role and the title_matter path', async () => {
  await indexFolio(BARE_TITLE_PAGE)
  expect([...await readFolioFrontMatter(ws, 'book')]).toEqual(['book/00-title.md'])

  await write('mf/00-title.md', BARE_TITLE_PAGE)
  await write('mf/00-half.md', BARE_TITLE_PAGE)
  await write('mf/01-chapter.md', CHAPTER)
  await write('mf/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', title_matter: '00-half.md', files: [
    { path: '00-title.md', role: 'title-matter' }, { path: '01-chapter.md', role: 'section' },
  ] }))
  expect([...await readFolioFrontMatter(ws, 'mf')].sort()).toEqual(['mf/00-half.md', 'mf/00-title.md'])
})

test('a front-matter part has no title conflict and no missing-heading flag; its title is its frontmatter title', async () => {
  await indexFolio(TITLE_PAGE)
  const plan = await readPlan(ws, 'book')
  const page = plan!.parts.find((part) => part.path === 'book/00-title.md')!
  expect(page.heading).toMatchObject({ frontMatter: true, mismatch: false, title: 'The Book of Cost', from: 'frontmatter' })
  expect(page.heading!.fingerprint).toBeUndefined()
  const outline = await folioOutline(ws, 'book/00-title.md')
  const row = outline!.pieces.find((file) => file.path === 'book/00-title.md')!
  expect(row).toMatchObject({ frontMatter: true, title: 'The Book of Cost' })
  expect(row.titleMismatch).toBeUndefined()
  expect(row.titleConflict).toBeUndefined()
  // The open document's bar asks main, through the per-document Folio lookup.
  expect((await folioPlace(ws, 'book/00-title.md'))!.frontMatter).toBe(true)
  expect((await folioPlace(ws, 'book/01-chapter.md'))!.frontMatter).toBeUndefined()

  // The same page without the tag is an ordinary part: the conflict is back.
  await write('book/_book_INDEX.md', '# Book\n\n## Running order\n\n- [[00-title]]\n- [[01-chapter]]\n')
  invalidateFolioPlaces(root)
  expect((await readPlan(ws, 'book'))!.parts[0].heading).toMatchObject({ mismatch: true })
})

test('a part with only toc: false still gets the heading checks', async () => {
  await write('mf/00-appendix.md', TITLE_PAGE)
  await write('mf/01-chapter.md', CHAPTER)
  await write('mf/02-bare.md', BARE_TITLE_PAGE)
  await write('mf/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [
    { path: '00-appendix.md', toc: false }, { path: '01-chapter.md' }, { path: '02-bare.md', toc: false },
  ] }))
  expect([...await readFolioFrontMatter(ws, 'mf')]).toEqual([])
  const outline = await folioOutline(ws, 'mf/01-chapter.md')
  // 00-appendix and 02-bare share the title "The Book of Cost". Both parts go in the outline, told apart by path
  // (Dominik 2026-10-20). The heading checks still run on the 00-appendix row.
  expect(outline!.pieces.map((file) => file.path)).toEqual(['mf/00-appendix.md', 'mf/01-chapter.md', 'mf/02-bare.md'])
  const row = outline!.pieces.find((file) => file.path === 'mf/00-appendix.md')!
  expect(row.frontMatter).toBeUndefined()
  expect(row.titleConflict).toMatchObject({ title: 'The Book of Cost', heading: 'Jane Doe' })
  expect(await proposePartTitles(ws, changes, 'mf')).toEqual({ proposed: 1, flagged: 1, withdrawn: 0 })
  expect((await changes.list()).map((change) => change.path)).toEqual(['mf/02-bare.md'])
})

test('no "Add the heading" is filed for a front-matter part, and an undecided old one is closed as superseded', async () => {
  await indexFolio(BARE_TITLE_PAGE)
  const old = await changes.add({
    path: 'book/00-title.md', provenance: 'agent', editClass: 'housekeeping', category: 'structure', summary: 'Add the heading “The Book of Cost”',
    oldText: 'Jane Doe', newText: '# The Book of Cost\n\nJane Doe', anchor: { from: 33, to: 41 }, isCorrection: false, author: WRITEFLEX_SELF_AUTHOR,
  })
  expect(await proposePartTitles(ws, changes, 'book')).toEqual({ proposed: 0, flagged: 0, withdrawn: 1 })
  const closed = (await changes.list()).find((change) => change.id === old.id)!
  expect([closed.status, closedCodeOf(closed)]).toEqual(['rejected', 'superseded'])
  expect(closedReasonOf(closed)).toContain('front matter')
  expect(await proposePartTitles(ws, changes, 'book')).toEqual({ proposed: 0, flagged: 0, withdrawn: 0 })
  expect((await changes.list()).length).toBe(1)
  expect(await read('book/00-title.md')).toBe(BARE_TITLE_PAGE)
})

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
  const invoke = async (channel: string, input: unknown): Promise<any> => handlers.get(channel)!({ sender: { id: 1 } }, input)
  return { invoke, checkpoints }
}

test('title:fix-part and title:fix-folio refuse a front-matter part and write nothing', async () => {
  await indexFolio(TITLE_PAGE)
  await write('book/02-other.md', '---\ntitle: Old\n---\n\n# New\n')
  await write('book/_book_INDEX.md', '# Book\n\n## Running order\n\n- [[00-title]] #front-matter\n- [[01-chapter]]\n- [[02-other]]\n')
  const api = harness()
  for (const direction of ['heading-to-title', 'title-to-heading']) {
    expect(await api.invoke('title:fix-part', { dir: 'book', item: await seen('book/00-title.md'), direction })).toEqual({ ok: false, message: FRONT_MATTER_TITLE_REFUSED })
  }
  expect(await api.invoke('title:fix-folio', { dir: 'book', items: [await seen('book/02-other.md'), await seen('book/00-title.md')], direction: 'title-to-heading' }))
    .toEqual({ ok: false, message: FRONT_MATTER_TITLE_REFUSED })
  expect(api.checkpoints).toEqual([])
  expect(await read('book/00-title.md')).toBe(TITLE_PAGE)
  expect(await read('book/02-other.md')).toBe('---\ntitle: Old\n---\n\n# New\n')
  // An ordinary part of the same Folio is still fixed.
  expect(await api.invoke('title:fix-part', { dir: 'book', item: await seen('book/02-other.md'), direction: 'heading-to-title' })).toMatchObject({ ok: true, written: ['book/02-other.md'] })
})

// Sol review round 3 (2026-10-19): main finds the Folio that owns each path itself and refuses a renderer
// `dir` that is any other folder, so the front-matter check cannot be pointed at a folder with no manifest.
test('title:fix-part and title:fix-folio refuse a dir that is not the Folio owning the part (content_root)', async () => {
  await write('book/contents/00-title.md', TITLE_PAGE)
  await write('book/contents/01-chapter.md', '---\ntitle: Old\n---\n\n# New\n')
  await write('book/contents/02-chapter.md', '---\ntitle: Old two\n---\n\n# New two\n')
  await write('book/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: 'contents', files: [
    { path: '00-title.md', role: 'title-matter' }, { path: '01-chapter.md', role: 'section' }, { path: '02-chapter.md', role: 'section' },
  ] }))
  const api = harness()
  for (const direction of ['heading-to-title', 'title-to-heading']) {
    // The owning Folio: the front matter refuses.
    expect(await api.invoke('title:fix-part', { dir: 'book', item: await seen('book/contents/00-title.md'), direction })).toEqual({ ok: false, message: FRONT_MATTER_TITLE_REFUSED })
    // The content folder named instead (Sol's reproduction): refused, not written.
    await expect(api.invoke('title:fix-part', { dir: 'book/contents', item: await seen('book/contents/00-title.md'), direction })).rejects.toThrow('That file is not a part of this Folio.')
    await expect(api.invoke('title:fix-folio', { dir: 'book/contents', items: [await seen('book/contents/00-title.md')], direction })).rejects.toThrow('That file is not a part of this Folio.')
    // An ordinary part named under the wrong folder is refused too.
    await expect(api.invoke('title:fix-part', { dir: 'book/contents', item: await seen('book/contents/01-chapter.md'), direction })).rejects.toThrow('That file is not a part of this Folio.')
  }
  expect(api.checkpoints).toEqual([])
  expect(await read('book/contents/00-title.md')).toBe(TITLE_PAGE)
  // An ordinary part under content_root, with the owning folder named, is still fixed, alone and in a whole-Folio call.
  expect(await api.invoke('title:fix-part', { dir: 'book', item: await seen('book/contents/01-chapter.md'), direction: 'heading-to-title' }))
    .toMatchObject({ ok: true, written: ['book/contents/01-chapter.md'] })
  expect(await api.invoke('title:fix-folio', { dir: 'book', items: [await seen('book/contents/02-chapter.md')], direction: 'title-to-heading' }))
    .toMatchObject({ ok: true, written: ['book/contents/02-chapter.md'] })
  expect(await read('book/contents/02-chapter.md')).toBe('---\ntitle: Old two\n---\n\n# Old two\n')
})
