import { pinnedIndex } from '../helpers/folio-file-identity'
// Folio front matter (ADR-0046, ticket B of 0.25.1): front matter is a part role, read from a `#front-matter` line
// tag, a manifest entry (`role: front-matter|title-matter`) or the manifest's `title_matter` file, written as `role: front-matter` with
// `toc: false`, always a leading block (`toc: false` alone only offers "Add as front matter"; the part stays put), of the running order, and "Add as front matter" puts a title page back
// through the guarded Put back. The Pangram-shaped fixture is the owner's real Folio as it stands on 2026-10-19.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { jsonArrayLayout } from '../../src/main/json-array-layout'
import { NOT_OFFERED_AS_FRONT_MATTER, adoptPart, adoptParts, insertPart, movePart, readPlan, reorderParts, setPartRole as setPartRoleNamed } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from '../../src/main/folio-running-order'
import { addPlanParts, planPartKeys, removeAddedPlanParts } from '../../src/main/plan-running-order'
import { Workspace } from '../../src/main/workspace'
import { ADD_UNDO_KEPT } from '../../src/main/folio-add-undo'
import { STALE_UNDO_MESSAGE } from '../../src/shared/folio-running-order'
import {
  FRONT_MATTER_STAYS_LEADING,
  TITLE_PAGE_SET_IN_MANIFEST,
  partIsFrontMatter,
  frontMatterLeads,
  isFrontMatterRole,
  manifestEntryIsFrontMatter,
  manifestEntryOffersFrontMatter,
  moveStaysInBlock,
  placeInOrder,
  roleLabel,
} from '../../src/shared/folio-front-matter'
import { parsePlanLine, serialisePlanLine } from '../../src/shared/plan-line'
import { chapterSortOrder } from '../../src/shared/folio-chapter-order'
import { blockCommandTarget } from '../../src/shared/folio-running-order'
import { exportBundle } from '../../src/main/export'
import { folioFrontMatter } from '../../src/main/folio-front-matter'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-front-matter-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const rawEntries = (source: string): string[] => jsonArrayLayout(source, 'files').entries.map((entry) => entry.raw)

/** The role menu as the owner uses it: the card at `index` as the Plan shows it now. */
async function setPartRole(dir: string, index: number, role: string) {
  const part = (await readPlan(ws, dir))!.parts[index]
  return setPartRoleNamed(ws, dir, index, role, { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: part.tags })
}

// ---- The Pangram Folio, as the owner's copy stands (manifest, title page, two parts) ----------------------------

const PANGRAM = 'reports/pangram'
const PANGRAM_INDEX = `${PANGRAM}/_pangram_INDEX.md`
const PANGRAM_MANIFEST = `${PANGRAM}/${MANIFEST_NAME}`
const PANGRAM_TITLE = 'Pangram evaluation: proposal and proof of concept'
const PANGRAM_MANIFEST_TEXT = `{
  "schema_version": 1,
  "report_id": "pangram-evaluation-proposal-2026-10-14",
  "content_root": "contents",
  "output": "html/report-pangram-evaluation-writeflex-2026-10-19.html",
  "title_matter": "contents/00-frontmatter.md",
  "files": [
    {
      "id": "executive-summary",
      "path": "01-executive-summary.md",
      "role": "executive-summary",
      "render": "section",
      "annotatable": true,
      "toc": true
    },
    {
      "id": "report-body",
      "path": "02-report.md",
      "role": "report-body",
      "render": "sections",
      "strip_title_matter": true,
      "annotatable": true,
      "toc": true
    }
  ],
  "vignettes": [],
  "title": "${PANGRAM_TITLE}"
}
`
const PANGRAM_TITLE_PAGE = `---
role: title-matter
title: "${PANGRAM_TITLE}"
author: Dominik Lukeš
date: 2026-10-14
status: draft-for-review
audience: Example Author and Example Education Committee
---

Dominik Lukeš · 14 October 2026 · For discussion
`

async function pangram(): Promise<void> {
  await write(PANGRAM_MANIFEST, PANGRAM_MANIFEST_TEXT)
  await write(`${PANGRAM}/contents/00-frontmatter.md`, PANGRAM_TITLE_PAGE)
  await write(`${PANGRAM}/contents/01-executive-summary.md`, '---\nrole: executive-summary\ntitle: Summary\n---\n\n## Summary\nTo test the feasibility of evaluating current AI detection tools.\n')
  await write(`${PANGRAM}/contents/02-report.md`, '---\nrole: report-body\ntitle: Details\n---\n# Details\n## Background and purpose\nAdvances in AI writing detection.\n')
  await write(PANGRAM_INDEX, `---\ntitle: "${PANGRAM_TITLE}"\n---\n\n# ${PANGRAM_TITLE}\n\n## Running order\n\n- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n- [[Details]]\n`)
}

// ---- The shared rules ------------------------------------------------------------------------------------------

test('the role and the manifest reading: a line tag, a front-matter or title-matter role, or the title_matter file; toc false only offers', () => {
  expect(parsePlanLine('- [[Title page]] #front-matter')).toMatchObject({ role: 'front-matter', tags: [] })
  expect(serialisePlanLine({ title: 'Title page', role: 'front-matter' })).toBe('- [[Title page]] #front-matter')
  expect(parsePlanLine(serialisePlanLine({ title: 'Preface', gloss: 'why', role: 'front-matter', tags: ['draft'] }))).toMatchObject({ role: 'front-matter', gloss: 'why', tags: ['draft'] })
  expect(isFrontMatterRole('Title-Matter')).toBe(true)
  expect(isFrontMatterRole('section')).toBe(false)
  expect(manifestEntryIsFrontMatter({ role: 'title-matter' })).toBe(true)
  expect(manifestEntryIsFrontMatter({ role: 'front-matter' })).toBe(true)
  expect(manifestEntryIsFrontMatter({ role: 'appendix', toc: false })).toBe(false)
  expect(manifestEntryIsFrontMatter({ toc: false })).toBe(false)
  expect(manifestEntryIsFrontMatter({})).toBe(false)
  // The title_matter file is front matter whatever role its entry names.
  expect(manifestEntryIsFrontMatter({}, true)).toBe(true)
  expect(manifestEntryIsFrontMatter({ role: 'front-matter' }, true)).toBe(true)
  expect(manifestEntryIsFrontMatter({ role: 'section' }, true)).toBe(true)
  // The one shared reading: any one marker suffices, none vetoes another.
  expect(partIsFrontMatter({ lineRole: 'front-matter', entry: { role: 'summary' } })).toBe(true)
  expect(partIsFrontMatter({ lineRole: 'summary', entry: { role: 'front-matter' } })).toBe(true)
  expect(partIsFrontMatter({ lineRole: 'section', entry: { role: 'section' }, isTitleMatter: true })).toBe(true)
  expect(partIsFrontMatter({ lineRole: 'appendix', entry: { role: 'appendix', toc: false } as { role: string } })).toBe(false)
  // `toc: false` offers "Add as front matter" and nothing more.
  expect(manifestEntryOffersFrontMatter({ role: 'appendix', toc: false })).toBe(true)
  expect(manifestEntryOffersFrontMatter({ role: 'appendix', toc: true })).toBe(false)
  expect(manifestEntryOffersFrontMatter({ role: 'front-matter' })).toBe(true)
  expect(roleLabel('front-matter')).toBe('Front matter')
})

test('the order rule: front matter leads, a part asked for on the wrong side lands at the edge, a move never crosses', () => {
  const flags = [true, true, false, false]
  expect(frontMatterLeads(flags)).toBe(true)
  expect(frontMatterLeads([true, false, true])).toBe(false)
  expect(placeInOrder(flags, 4, true)).toBe(2)
  expect(placeInOrder(flags, 0, false)).toBe(2)
  expect(placeInOrder(flags, 1, true)).toBe(1)
  expect(placeInOrder(flags, 3, false)).toBe(3)
  expect(moveStaysInBlock(flags, 1, 0)).toBe(true)
  expect(moveStaysInBlock(flags, 1, 2)).toBe(false)
  expect(moveStaysInBlock(flags, 2, 1)).toBe(false)
  expect(moveStaysInBlock(flags, 3, 2)).toBe(true)
  // Sort by chapter number sorts each side among its own places.
  expect(chapterSortOrder(['z/09-title.md', 'z/00-preface.md', 'z/02-b.md', 'z/01-a.md'], flags)).toEqual([1, 0, 3, 2])
  // An order that does not lead (an outside edit): the front matter keeps its place, the contents sort around it.
  expect(chapterSortOrder(['z/02-b.md', 'z/00-front.md', 'z/01-a.md'], [false, true, false])).toEqual([2, 1, 0])
})

test('Move up / down in the Outline stays on its side; front matter moved down goes before the first contents piece', () => {
  const outline = {
    pieces: [
      { path: 'f/a.md', title: 'A', frontMatter: true },
      { path: 'f/b.md', title: 'B', frontMatter: true },
      { path: 'f/c.md', title: 'C' },
      { path: 'f/d.md', title: 'D' },
    ],
    also: [],
  }
  expect(blockCommandTarget('down', { path: 'f/a.md', kind: 'piece' }, null, outline)).toEqual({ path: 'f/a.md', title: 'A', beforePath: 'f/c.md' })
  expect(blockCommandTarget('down', { path: 'f/b.md', kind: 'piece' }, null, outline)).toEqual({ message: 'B is already last in the running order.' })
  expect(blockCommandTarget('up', { path: 'f/c.md', kind: 'piece' }, null, outline)).toEqual({ message: 'C is already first in the running order.' })
  expect(blockCommandTarget('down', { path: 'f/c.md', kind: 'piece' }, null, outline)).toEqual({ path: 'f/c.md', title: 'C', beforePath: null })
})

// ---- Reading -----------------------------------------------------------------------------------------------------

test('a line with no role of its own reads front matter from its manifest entry (title-matter role) or as the title_matter file; toc false does not', async () => {
  await write('r/a.md', '# A\n')
  await write('r/t.md', '# T\n')
  await write('r/b.md', '# B\n')
  await write('r/c.md', '# C\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', title_matter: 't.md', files: [{ path: 'a.md', role: 'title-matter' }, { path: 't.md' }, { path: 'b.md', toc: false }, { path: 'c.md', toc: true }] }, null, 2)}\n`)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[A]]\n- [[T]]\n- [[B]]\n- [[C]]\n')
  const plan = (await readPlan(ws, 'r'))!
  expect(plan.parts.map((part) => part.role)).toEqual(['front-matter', 'front-matter', 'section', 'section'])
})

test('an appendix with toc false keeps its place, its role and its export: it is not front matter', async () => {
  await write('r/a.md', '# Opening\n\nOPENING-TEXT\n')
  await write('r/z.md', '# Appendix\n\nAPPENDIX-TEXT\n')
  await write('r/b.md', '# Body\n\nBODY-TEXT\n')
  const manifest = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md', role: 'section' }, { path: 'z.md', role: 'appendix', toc: false }, { path: 'b.md' }] }, null, 2)}\n`
  await write(`r/${MANIFEST_NAME}`, manifest)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[Opening]]\n- [[Appendix]] #appendix\n- [[Body]]\n')
  const plan = (await readPlan(ws, 'r'))!
  expect(plan.parts.map((part) => [part.title, part.role])).toEqual([['Opening', 'section'], ['Appendix', 'appendix'], ['Body', 'section']])
  // A move across what would be a boundary is an ordinary move: there is no front matter here.
  const moved = await movePart(ws, 'r', 1, 0)
  expect(moved.parts.map((part) => part.title)).toEqual(['Appendix', 'Opening', 'Body'])
  await movePart(ws, 'r', 0, 1)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
  // The export: no front matter, the appendix in its place in the body and listed in the contents, as before.
  expect(await folioFrontMatter(ws, 'r')).toEqual({ front: [], titlePage: null })
  const target = join(root, 'r.html')
  await exportBundle(ws, { dir: 'r', format: 'html', target, html: {} })
  const page = await readFile(target, 'utf8')
  const toc = page.slice(page.indexOf('<nav id="toc">'), page.indexOf('</nav>', page.indexOf('<nav id="toc">')))
  expect(toc).toContain('href="#p2-section"')
  expect(page.indexOf('OPENING-TEXT')).toBeLessThan(page.indexOf('APPENDIX-TEXT'))
  expect(page.indexOf('APPENDIX-TEXT')).toBeLessThan(page.indexOf('BODY-TEXT'))
  expect(page).not.toContain('id="f1-section"')
})

test('a file whose manifest entry says toc false, under Not in the outline, is offered Add as front matter; Put back keeps it a contents part with toc false', async () => {
  await write('r/a.md', '# A\n')
  await write('r/z.md', '# Appendix\n')
  const manifest = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'z.md', role: 'appendix', toc: false }] }, null, 2)}\n`
  await write(`r/${MANIFEST_NAME}`, manifest)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[A]]\n')
  const plan = (await readPlan(ws, 'r'))!
  expect(plan.unlisted).toHaveLength(1)
  expect(plan.unlisted[0]).toMatchObject({ title: 'Appendix', role: 'appendix', frontMatterOffer: true })
  const back = await adoptPart(ws, 'r', 0)
  expect(back.parts.map((part) => [part.title, part.role])).toEqual([['A', 'section'], ['Appendix', 'appendix']])
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
})

test('the same toc-false file added as front matter goes first, and its entry becomes front matter with toc false', async () => {
  await write('r/a.md', '# A\n')
  await write('r/z.md', '# Appendix\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'z.md', role: 'appendix', toc: false }] }, null, 2)}\n`)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[A]]\n')
  const plan = await adoptPart(ws, 'r', 0, {}, true)
  expect(plan.parts.map((part) => [part.title, part.role])).toEqual([['Appendix', 'front-matter'], ['A', 'section']])
  const files = (JSON.parse(await read(`r/${MANIFEST_NAME}`)) as { files: Array<Record<string, unknown>> }).files
  expect(files.find((file) => file.path === 'z.md')).toEqual({ path: 'z.md', role: 'front-matter', toc: false })
})

test('the Pangram Folio: its title page is under Not in the outline, offered as front matter and marked a title page', async () => {
  await pangram()
  const plan = (await readPlan(ws, PANGRAM))!
  expect(plan.parts.map((part) => [part.title, part.role])).toEqual([['Summary', 'summary'], ['Details', 'section']])
  expect(plan.unlisted).toHaveLength(1)
  // The manifest's title_matter file: front matter by the manifest, so it would go back as front matter either way.
  expect(plan.unlisted[0]).toMatchObject({ title: PANGRAM_TITLE, path: `${PANGRAM}/contents/00-frontmatter.md`, role: 'front-matter', manifestBacked: false, titlePage: true, frontMatterOffer: true })
})

// ---- Add as front matter ---------------------------------------------------------------------------------------

test('Add as front matter on the Pangram Folio: the title page goes back first, tagged; the manifest gains role front-matter and toc false, every other byte kept', async () => {
  await pangram()
  const before = await read(PANGRAM_MANIFEST)
  const plan = await adoptPart(ws, PANGRAM, 0, {}, true)

  expect(plan.parts.map((part) => [part.title, part.role])).toEqual([[PANGRAM_TITLE, 'front-matter'], ['Summary', 'summary'], ['Details', 'section']])
  expect(plan.parts[0]).toMatchObject({ path: `${PANGRAM}/contents/00-frontmatter.md`, titlePage: true })
  expect(plan.unlisted).toEqual([])
  expect(await read(PANGRAM_INDEX)).toBe(pinnedIndex(`---\ntitle: "${PANGRAM_TITLE}"\n---\n\n# ${PANGRAM_TITLE}\n\n## Running order\n\n- [[${PANGRAM_TITLE}]] #front-matter\n- [[Summary]] — Summary of the findings and proposed evaluation. #summary\n- [[Details]]\n`, {"Summary":"./contents/01-executive-summary.md|Summary","Details":"./contents/02-report.md|Details","Pangram evaluation: proposal and proof of concept":"./contents/00-frontmatter.md|Pangram evaluation: proposal and proof of concept"}))

  const after = await read(PANGRAM_MANIFEST)
  const manifest = JSON.parse(after) as { files: Array<Record<string, unknown>>; title_matter: string }
  expect(manifest.files[0]).toEqual({ id: 'pangram-evaluation-proposal-and-proof-of-concept', path: '00-frontmatter.md', role: 'front-matter', toc: false })
  // The two entries that were there keep their bytes exactly, and so does everything outside the array.
  expect(rawEntries(after).slice(1)).toEqual(rawEntries(before))
  const outside = (text: string): string => { const layout = jsonArrayLayout(text, 'files'); return text.slice(0, layout.start) + text.slice(layout.end) }
  expect(outside(after)).toBe(outside(before))
})

test('Add as front matter keeps the front matter a leading block: a second one goes after the first, before the contents', async () => {
  await pangram()
  await write(`${PANGRAM}/contents/00b-preface.md`, '---\nrole: front-matter\ntitle: Preface\n---\n\nWhy this report.\n')
  const first = (await readPlan(ws, PANGRAM))!
  const titleAt = first.unlisted.findIndex((part) => part.title === PANGRAM_TITLE)
  await adoptPart(ws, PANGRAM, titleAt, {}, true)
  const second = (await readPlan(ws, PANGRAM))!
  const prefaceAt = second.unlisted.findIndex((part) => part.title === 'Preface')
  expect(second.unlisted[prefaceAt]).toMatchObject({ frontMatterOffer: true })
  expect(second.unlisted[prefaceAt].titlePage).toBeUndefined()
  const plan = await adoptPart(ws, PANGRAM, prefaceAt, {}, true)
  expect(plan.parts.map((part) => [part.title, part.role])).toEqual([[PANGRAM_TITLE, 'front-matter'], ['Preface', 'front-matter'], ['Summary', 'summary'], ['Details', 'section']])
  expect((JSON.parse(await read(PANGRAM_MANIFEST)) as { files: Array<{ path: string }> }).files.map((file) => file.path)).toEqual(['00-frontmatter.md', '00b-preface.md', '01-executive-summary.md', '02-report.md'])
})

test('ordinary Put back of the title_matter file puts it back as front matter, first: the manifest names it front matter, so the block stays leading', async () => {
  await pangram()
  const plan = await adoptPart(ws, PANGRAM, 0)
  expect(plan.parts.map((part) => [part.title, part.role])).toEqual([[PANGRAM_TITLE, 'front-matter'], ['Summary', 'summary'], ['Details', 'section']])
  const entry = (JSON.parse(await read(PANGRAM_MANIFEST)) as { files: Array<Record<string, unknown>> }).files[0]
  expect(entry).toMatchObject({ path: '00-frontmatter.md', role: 'front-matter', toc: false })
})

test('Add as front matter is refused, with nothing written, for a file that is not offered as front matter', async () => {
  await pangram()
  await write(`${PANGRAM}/contents/03-notes.md`, '# Notes\n')
  const plan = (await readPlan(ws, PANGRAM))!
  const at = plan.unlisted.findIndex((part) => part.title === 'Notes')
  expect(plan.unlisted[at].frontMatterOffer).toBeUndefined()
  const index = await read(PANGRAM_INDEX)
  const manifest = await read(PANGRAM_MANIFEST)
  await expect(adoptPart(ws, PANGRAM, at, {}, true)).rejects.toThrow(NOT_OFFERED_AS_FRONT_MATTER)
  expect(await read(PANGRAM_INDEX)).toBe(index)
  expect(await read(PANGRAM_MANIFEST)).toBe(manifest)
})

test('Add as front matter checks the file as it is now: a header that no longer says front matter is refused', async () => {
  await write('r/a.md', '# A\n')
  await write('r/pre.md', '---\nrole: front-matter\ntitle: Preface\n---\n\nText.\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }] }, null, 2)}\n`)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[A]]\n')
  const plan = (await readPlan(ws, 'r'))!
  const at = plan.unlisted.findIndex((part) => part.title === 'Preface')
  expect(plan.unlisted[at].frontMatterOffer).toBe(true)
  await write('r/pre.md', '---\ntitle: Preface\n---\n\nText.\n')
  await expect(adoptPart(ws, 'r', at, {}, true)).rejects.toThrow(NOT_OFFERED_AS_FRONT_MATTER)
})

test('plan:adopt-part with asFrontMatter is the same guarded Put back: the row the owner saw, then the front-matter write', async () => {
  await pangram()
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async () => {},
    notifyCollectionChanged: () => {},
    notifyChangedOnDisk: () => {},
  })
  const invoke = (input: unknown) => handlers.get('plan:adopt-part')!({ sender: { id: 1 } }, input)
  const path = `${PANGRAM}/contents/00-frontmatter.md`
  await expect(invoke({ dir: PANGRAM, unlistedIndex: 0, expected: { title: 'Another', path: `${PANGRAM}/contents/another.md` }, asFrontMatter: true })).rejects.toThrow(/look again/i)
  await expect(invoke({ dir: PANGRAM, unlistedIndex: 0, expected: { title: PANGRAM_TITLE, path }, asFrontMatter: 'yes' })).rejects.toThrow('Invalid Folio outline adoption.')
  const plan = await invoke({ dir: PANGRAM, unlistedIndex: 0, expected: { title: PANGRAM_TITLE, path }, asFrontMatter: true }) as { parts: Array<{ role: string }> }
  expect(plan.parts.map((part) => part.role)).toEqual(['front-matter', 'summary', 'section'])
})

// ---- The order block on every write ----------------------------------------------------------------------------

async function frontFolio(): Promise<void> {
  await write('r/title.md', '---\nrole: title-matter\ntitle: Title\n---\n\nBy me.\n')
  await write('r/a.md', '# A\n')
  await write('r/b.md', '# B\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'title.md', role: 'front-matter', toc: false }, { path: 'a.md', role: 'section' }, { path: 'b.md', role: 'section' }] }, null, 2)}\n`)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[Title]] #front-matter\n- [[A]]\n- [[B]]\n')
}

test('a move across the boundary is refused with nothing written; a move inside a side is made', async () => {
  await frontFolio()
  const index = await read('r/_r_INDEX.md')
  const manifest = await read(`r/${MANIFEST_NAME}`)
  await expect(movePart(ws, 'r', 0, 1)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  await expect(movePart(ws, 'r', 2, 0)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  await expect(reorderParts(ws, 'r', [1, 0, 2])).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  expect(await read('r/_r_INDEX.md')).toBe(index)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
  const moved = await movePart(ws, 'r', 2, 1)
  expect(moved.parts.map((part) => part.title)).toEqual(['Title', 'B', 'A'])
})

test('the Outline’s move across the boundary is refused as such, and the manifest-only route refuses it too', async () => {
  await frontFolio()
  const order = ['r/title.md', 'r/a.md', 'r/b.md']
  const outcome = await moveFolioPiece(ws, 'r', { path: 'r/b.md', beforePath: 'r/title.md', expected: order })
  expect(outcome.result).toMatchObject({ ok: false, message: FRONT_MATTER_STAYS_LEADING })
  await rm(join(root, 'r/_r_INDEX.md'))
  const manifestOnly = await moveFolioPiece(ws, 'r', { path: 'r/b.md', beforePath: 'r/title.md', expected: order })
  expect(manifestOnly.result).toMatchObject({ ok: false, message: FRONT_MATTER_STAYS_LEADING })
})

test('insert keeps the block: a contents part asked for first lands after the front matter; front matter asked for last lands at its edge', async () => {
  await frontFolio()
  const contents = await insertPart(ws, 'r', 0, { title: 'Intro' })
  expect(contents.parts.map((part) => [part.title, part.role])).toEqual([['Title', 'front-matter'], ['Intro', 'section'], ['A', 'section'], ['B', 'section']])
  const front = await insertPart(ws, 'r', 4, { title: 'Preface', role: 'front-matter' })
  expect(front.parts.map((part) => [part.title, part.role])).toEqual([['Title', 'front-matter'], ['Preface', 'front-matter'], ['Intro', 'section'], ['A', 'section'], ['B', 'section']])
  expect(await read('r/_r_INDEX.md')).toBe(pinnedIndex('# R\n\n## Running order\n\n- [[Title]] #front-matter\n- [[Preface]] #front-matter\n- [[Intro]]\n- [[A]]\n- [[B]]\n', {"Title":"./title.md|Title","A":"./a.md|A","B":"./b.md|B"}))
})

test('a role across the boundary moves the part to the edge of its new side, in both documents; back again restores the order', async () => {
  await frontFolio()
  const manifestBefore = await read(`r/${MANIFEST_NAME}`)
  const toFront = await setPartRole('r', 2, 'front-matter')
  expect(toFront.parts.map((part) => [part.title, part.role])).toEqual([['Title', 'front-matter'], ['B', 'front-matter'], ['A', 'section']])
  expect(await read('r/_r_INDEX.md')).toBe(pinnedIndex('# R\n\n## Running order\n\n- [[Title]] #front-matter\n- [[B]] #front-matter\n- [[A]]\n', {"Title":"./title.md|Title","B":"./b.md|B","A":"./a.md|A"}))
  const files = (JSON.parse(await read(`r/${MANIFEST_NAME}`)) as { files: Array<Record<string, unknown>> }).files
  expect(files).toEqual([{ path: 'title.md', role: 'front-matter', toc: false }, { path: 'b.md', role: 'front-matter', toc: false }, { path: 'a.md', role: 'section' }])

  const toContents = await setPartRole('r', 1, 'section')
  expect(toContents.parts.map((part) => [part.title, part.role])).toEqual([['Title', 'front-matter'], ['B', 'section'], ['A', 'section']])
  const back = (JSON.parse(await read(`r/${MANIFEST_NAME}`)) as { files: Array<Record<string, unknown>> }).files
  expect(back).toEqual([{ path: 'title.md', role: 'front-matter', toc: false }, { path: 'b.md', role: 'section', toc: true }, { path: 'a.md', role: 'section' }])
  // The entries the role changes did not touch keep their bytes.
  expect(rawEntries(await read(`r/${MANIFEST_NAME}`))[0]).toBe(rawEntries(manifestBefore)[0])
  expect(rawEntries(await read(`r/${MANIFEST_NAME}`))[2]).toBe(rawEntries(manifestBefore)[1])
})

test('the title_matter file stays front matter: the role menu is off for it, and a role that would take it out is refused with nothing written', async () => {
  await write('r/title.md', '# Title\n')
  await write('r/a.md', '# A\n')
  const manifest = '{\n  "schema_version": 1,\n  "content_root": "",\n  "title_matter": "title.md",\n  "files": [\n    { "path": "title.md", "toc": false },\n    { "path": "a.md" }\n  ]\n}\n'
  await write(`r/${MANIFEST_NAME}`, manifest)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[Title]]\n- [[A]]\n')
  const plan = (await readPlan(ws, 'r'))!
  expect(plan.parts.map((part) => [part.role, part.manifestTitlePage ?? null])).toEqual([['front-matter', true], ['section', null]])
  await expect(setPartRole('r', 0, 'section')).rejects.toThrow(TITLE_PAGE_SET_IN_MANIFEST)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
  expect(await read('r/_r_INDEX.md')).toBe('# R\n\n## Running order\n\n- [[Title]]\n- [[A]]\n')
})

test('title_matter "t.md" with its entry {path: "t.md", role: "section"}: front matter, the title page, and the cover', async () => {
  await write('r/t.md', '---\ntitle: Cover words\n---\n\nTITLE-TEXT\n')
  await write('r/a.md', '# A\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', title_matter: 't.md', files: [{ path: 't.md', role: 'section' }, { path: 'a.md' }] }, null, 2)}\n`)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[Cover words]]\n- [[A]]\n')
  const plan = (await readPlan(ws, 'r'))!
  expect(plan.parts.map((part) => [part.role, part.titlePage ?? null])).toEqual([['front-matter', true], ['section', null]])
  expect(await folioFrontMatter(ws, 'r')).toEqual({ front: ['r/t.md'], titlePage: 'r/t.md' })
  // A move that would carry it after the contents is refused.
  await expect(movePart(ws, 'r', 0, 1)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
})

test('no veto: a manifest role front-matter makes a line tagged #summary front matter, and a move out of the block is refused with nothing written', async () => {
  await write('r/s.md', '# S\n')
  await write('r/a.md', '# A\n')
  await write('r/b.md', '# B\n')
  const manifest = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 's.md', role: 'front-matter' }, { path: 'a.md' }, { path: 'b.md' }] }, null, 2)}\n`
  await write(`r/${MANIFEST_NAME}`, manifest)
  const index = '# R\n\n## Running order\n\n- [[S]] #summary\n- [[A]]\n- [[B]]\n'
  await write('r/_r_INDEX.md', index)
  expect((await readPlan(ws, 'r'))!.parts.map((part) => part.role)).toEqual(['front-matter', 'section', 'section'])
  await expect(movePart(ws, 'r', 0, 2)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  const outline = await moveFolioPiece(ws, 'r', { path: 'r/s.md', beforePath: null, expected: ['r/s.md', 'r/a.md', 'r/b.md'] })
  expect(outline.result).toMatchObject({ ok: false, message: FRONT_MATTER_STAYS_LEADING })
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
  expect(await read('r/_r_INDEX.md')).toBe(index)
  // The same the other way: a line tag #front-matter against a manifest role summary.
  await write(`r/${MANIFEST_NAME}`, manifest.replace('"role": "front-matter"', '"role": "summary"'))
  await write('r/_r_INDEX.md', index.replace('#summary', '#front-matter'))
  expect((await readPlan(ws, 'r'))!.parts[0].role).toBe('front-matter')
  await expect(movePart(ws, 'r', 0, 2)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  // The export and the sidebar read it the same way.
  expect((await folioFrontMatter(ws, 'r')).front).toEqual(['r/s.md'])
})

test('the role menu on an appendix with toc false keeps toc false: it was never front matter', async () => {
  await write('r/a.md', '# A\n')
  await write('r/z.md', '# Z\n')
  const manifest = '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md" },\n    { "path": "z.md", "role": "appendix", "toc": false }\n  ]\n}\n'
  await write(`r/${MANIFEST_NAME}`, manifest)
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[A]]\n- [[Z]] #appendix\n')
  await setPartRole('r', 1, 'section')
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest.replace('"role": "appendix", "toc": false', '"role": "section", "toc": false'))
})

test('Add all and the Outline’s Add put a front-matter file (header role front-matter) at the end of the block, the rest at the end', async () => {
  await frontFolio()
  await write('r/pre.md', '---\nrole: front-matter\ntitle: Preface\n---\n\nText.\n')
  await write('r/c.md', '# C\n')
  const plan = (await readPlan(ws, 'r'))!
  const indices = ['C', 'Preface'].map((title) => plan.unlisted.findIndex((part) => part.title === title))
  const after = await adoptParts(ws, 'r', indices)
  expect(after.parts.map((part) => part.title)).toEqual(['Title', 'Preface', 'A', 'B', 'C'])
  expect((JSON.parse(await read(`r/${MANIFEST_NAME}`)) as { files: Array<Record<string, unknown>> }).files.map((file) => [file.path, file.toc ?? null])).toEqual([
    ['title.md', false], ['pre.md', false], ['a.md', null], ['b.md', null], ['c.md', null],
  ])
})

test('a Folio with no Index Note: the Outline’s Add puts a front-matter file at the end of the block', async () => {
  await write('r/title.md', '# Title\n')
  await write('r/a.md', '# A\n')
  await write('r/pre.md', '---\nrole: front-matter\ntitle: Preface\n---\n\nText.\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'title.md', role: 'title-matter', toc: false }, { path: 'a.md' }] }, null, 2)}\n`)
  const outcome = await addFolioPieces(ws, 'r', { paths: ['r/pre.md'], expected: ['r/title.md', 'r/a.md'] })
  expect(outcome.result).toMatchObject({ ok: true, order: ['r/title.md', 'r/pre.md', 'r/a.md'] })
  const files = (JSON.parse(await read(`r/${MANIFEST_NAME}`)) as { files: Array<Record<string, unknown>> }).files
  expect(files[1]).toEqual({ path: 'pre.md', role: 'front-matter', toc: false })
})

// ---- Undo of an Add that placed front matter inside the block ---------------------------------------------------

/** frontFolio plus two files not in the outline: a preface (header role front-matter) and a plain contents file. */
async function frontFolioWithTwoToAdd(): Promise<{ index: string; manifest: string }> {
  await frontFolio()
  await write('r/pre.md', '---\nrole: front-matter\ntitle: Preface\n---\n\nText.\n')
  await write('r/c.md', '# C\n')
  return { index: await read('r/_r_INDEX.md'), manifest: await read(`r/${MANIFEST_NAME}`) }
}

test('Undo of the Outline’s Add that put a preface inside the front matter restores the Index Note and the manifest exactly', async () => {
  const before = await frontFolioWithTwoToAdd()
  const paths = ['r/c.md', 'r/pre.md']
  const added = await addFolioPieces(ws, 'r', { paths, expected: ['r/title.md', 'r/a.md', 'r/b.md'] })
  expect(added.result).toMatchObject({ ok: true, order: ['r/title.md', 'r/pre.md', 'r/a.md', 'r/b.md', 'r/c.md'] })
  if (!added.result.ok) throw new Error(added.result.message)
  const undone = await removeAddedFolioPieces(ws, 'r', { token: added.result.undoToken! })
  expect(undone.result).toMatchObject({ ok: true, changed: true, order: ['r/title.md', 'r/a.md', 'r/b.md'] })
  expect(await read('r/_r_INDEX.md')).toBe(before.index)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(before.manifest)
})

test('Undo of the Folio outline’s Add all that put a preface inside the front matter restores the Index Note and the manifest exactly', async () => {
  const before = await frontFolioWithTwoToAdd()
  const paths = ['r/c.md', 'r/pre.md']
  const added = await addPlanParts(ws, 'r', { paths, expected: planPartKeys((await readPlan(ws, 'r'))!) })
  if (!added.result.ok) throw new Error(added.result.message)
  expect(added.result.parts.map((part) => part.path)).toEqual(['r/title.md', 'r/pre.md', 'r/a.md', 'r/b.md', 'r/c.md'])
  const undone = await removeAddedPlanParts(ws, 'r', { token: added.result.undoToken! })
  expect(undone.result).toMatchObject({ ok: true, changed: true })
  expect(await read('r/_r_INDEX.md')).toBe(before.index)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(before.manifest)
})

test('Undo of the Outline’s Add in a Folio with no Index Note, front matter placed inside the block, restores the manifest exactly', async () => {
  const before = await frontFolioWithTwoToAdd()
  await rm(join(root, 'r/_r_INDEX.md'))
  const paths = ['r/c.md', 'r/pre.md']
  const added = await addFolioPieces(ws, 'r', { paths, expected: ['r/title.md', 'r/a.md', 'r/b.md'] })
  expect(added.result).toMatchObject({ ok: true, order: ['r/title.md', 'r/pre.md', 'r/a.md', 'r/b.md', 'r/c.md'] })
  if (!added.result.ok) throw new Error(added.result.message)
  const undone = await removeAddedFolioPieces(ws, 'r', { token: added.result.undoToken! })
  expect(undone.result).toMatchObject({ ok: true, changed: true, order: ['r/title.md', 'r/a.md', 'r/b.md'] })
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(before.manifest)
  expect(existsSync(join(root, 'r/_r_INDEX.md'))).toBe(false)
})

test('Undo of an Add is refused, with nothing written, after any change to either document since that Add', async () => {
  await frontFolioWithTwoToAdd()
  const paths = ['r/c.md', 'r/pre.md']
  const added = await addFolioPieces(ws, 'r', { paths, expected: ['r/title.md', 'r/a.md', 'r/b.md'] })
  if (!added.result.ok) throw new Error(added.result.message)
  const token = added.result.undoToken!
  // A move made in WriteFlex after the Add.
  await movePart(ws, 'r', 2, 3)
  const index = await read('r/_r_INDEX.md')
  const manifest = await read(`r/${MANIFEST_NAME}`)
  expect((await removeAddedFolioPieces(ws, 'r', { token })).result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
  expect(await read('r/_r_INDEX.md')).toBe(index)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
})

test('Undo of an Add is refused after an outside edit to the Index Note alone, or to the manifest alone', async () => {
  for (const edited of ['r/_r_INDEX.md', `r/${MANIFEST_NAME}`]) {
    await rm(join(root, 'r'), { recursive: true, force: true })
    await frontFolioWithTwoToAdd()
    const added = await addFolioPieces(ws, 'r', { paths: ['r/c.md'], expected: ['r/title.md', 'r/a.md', 'r/b.md'] })
    if (!added.result.ok) throw new Error(added.result.message)
    // An outside edit (a sync client, another editor): one byte added at the end.
    await writeFile(join(root, edited), `${await read(edited)} `, 'utf8')
    const index = await read('r/_r_INDEX.md')
    const manifest = await read(`r/${MANIFEST_NAME}`)
    expect((await removeAddedFolioPieces(ws, 'r', { token: added.result.undoToken! })).result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
    expect(await read('r/_r_INDEX.md')).toBe(index)
    expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
  }
})

test('Undo with no originating Add is refused and writes nothing: existing front matter cannot be taken out by Undo', async () => {
  // The reproduction: a title page followed by a body, no Add made. The title page sits exactly where an Add would put it.
  await write('r/title.md', '---\nrole: title-matter\ntitle: Title\n---\n\nBy me.\n')
  await write('r/a.md', '# A\n')
  const manifest = `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'title.md', role: 'front-matter', toc: false, custom: { keep: true } }, { path: 'a.md' }] }, null, 2)}\n`
  await write(`r/${MANIFEST_NAME}`, manifest)
  const index = '# R\n\n## Running order\n\n- [[Title]] #front-matter\n- [[A]]\n'
  await write('r/_r_INDEX.md', index)
  for (const token of ['', 'not-a-token', '00000000-0000-4000-8000-000000000000']) {
    expect((await removeAddedFolioPieces(ws, 'r', { token })).result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
    expect((await removeAddedPlanParts(ws, 'r', { token })).result).toMatchObject({ ok: false, stale: true })
  }
  expect(await read('r/_r_INDEX.md')).toBe(index)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifest)
})

test('an Undo token works once, only in its own Folio', async () => {
  await frontFolioWithTwoToAdd()
  await write('other/x.md', '# X\n')
  await write('other/y.md', '# Y\n')
  await write(`other/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'x.md' }] }, null, 2)}\n`)
  await write('other/_other_INDEX.md', '# Other\n\n## Running order\n\n- [[X]]\n')
  const added = await addFolioPieces(ws, 'r', { paths: ['r/c.md'], expected: ['r/title.md', 'r/a.md', 'r/b.md'] })
  if (!added.result.ok) throw new Error(added.result.message)
  const token = added.result.undoToken!
  const otherIndex = await read('other/_other_INDEX.md')
  expect((await removeAddedFolioPieces(ws, 'other', { token })).result).toMatchObject({ ok: false, stale: true })
  expect(await read('other/_other_INDEX.md')).toBe(otherIndex)
  expect((await removeAddedFolioPieces(ws, 'r', { token })).result).toMatchObject({ ok: true })
  // Used: the same token again is refused, even though the documents are as the Add found them.
  const again = await addFolioPieces(ws, 'r', { paths: ['r/c.md'], expected: ['r/title.md', 'r/a.md', 'r/b.md'] })
  if (!again.result.ok) throw new Error(again.result.message)
  expect((await removeAddedFolioPieces(ws, 'r', { token })).result).toMatchObject({ ok: false, stale: true })
  expect((await removeAddedFolioPieces(ws, 'r', { token: again.result.undoToken! })).result).toMatchObject({ ok: true })
})

test('Undo puts both documents back byte for byte: a Running order heading the Add inserted, 5./9. numbering, a whitespace-only manifest array', async () => {
  // No Running order heading: the Add inserts one, the Undo takes it away again.
  await write('h/a.md', '# A\n')
  await write('h/b.md', '# B\n')
  await write(`h/${MANIFEST_NAME}`, '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    \n  ]\n}\n')
  await write('h/_h_INDEX.md', '# H\n\nNo order yet.\n')
  const headingBefore = { index: await read('h/_h_INDEX.md'), manifest: await read(`h/${MANIFEST_NAME}`) }
  const plan = (await readPlan(ws, 'h'))!
  const addedHeading = await addPlanParts(ws, 'h', { paths: ['h/a.md'], expected: planPartKeys(plan) })
  if (!addedHeading.result.ok) throw new Error(addedHeading.result.message)
  expect(await read('h/_h_INDEX.md')).toContain('## Running order')
  expect((await removeAddedPlanParts(ws, 'h', { token: addedHeading.result.undoToken! })).result).toMatchObject({ ok: true })
  expect(await read('h/_h_INDEX.md')).toBe(headingBefore.index)
  // The whitespace inside the empty array is kept exactly.
  expect(await read(`h/${MANIFEST_NAME}`)).toBe(headingBefore.manifest)

  // A numbered running order that starts at 5 and skips to 9: the Add renumbers, the Undo restores 5. and 9.
  await write('n/a.md', '# A\n')
  await write('n/b.md', '# B\n')
  await write('n/c.md', '# C\n')
  await write(`n/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'b.md' }] }, null, 2)}\n`)
  await write('n/_n_INDEX.md', '# N\n\n## Running order\n\n5. [[A]]\n9. [[B]]\n')
  const numbered = { index: await read('n/_n_INDEX.md'), manifest: await read(`n/${MANIFEST_NAME}`) }
  const addedNumbered = await addFolioPieces(ws, 'n', { paths: ['n/c.md'], expected: ['n/a.md', 'n/b.md'] })
  if (!addedNumbered.result.ok) throw new Error(addedNumbered.result.message)
  expect((await removeAddedFolioPieces(ws, 'n', { token: addedNumbered.result.undoToken! })).result).toMatchObject({ ok: true, order: ['n/a.md', 'n/b.md'] })
  expect(await read('n/_n_INDEX.md')).toBe(numbered.index)
  expect(await read(`n/${MANIFEST_NAME}`)).toBe(numbered.manifest)
})

test('the Undo records are bounded: the last ADD_UNDO_KEPT Adds of a Folio keep theirs', async () => {
  await frontFolio()
  const tokens: string[] = []
  for (let n = 0; n <= ADD_UNDO_KEPT; n += 1) {
    await write(`r/x${n}.md`, `# X${n}\n`)
    const expected = (await readPlan(ws, 'r'))!.parts.map((part) => part.path as string)
    const added = await addFolioPieces(ws, 'r', { paths: [`r/x${n}.md`], expected })
    if (!added.result.ok) throw new Error(added.result.message)
    tokens.push(added.result.undoToken!)
  }
  // The oldest record is gone; the newest one undoes its Add.
  const index = await read('r/_r_INDEX.md')
  expect((await removeAddedFolioPieces(ws, 'r', { token: tokens[0] })).result).toMatchObject({ ok: false, stale: true })
  expect(await read('r/_r_INDEX.md')).toBe(index)
  expect((await removeAddedFolioPieces(ws, 'r', { token: tokens.at(-1)! })).result).toMatchObject({ ok: true })
})

test('a Folio with no Index Note: the title_matter file listed with no role is front matter; a toc-false appendix is not', async () => {
  await write('r/t.md', '# T\n')
  await write('r/a.md', '# A\n')
  await write('r/z.md', '# Z\n')
  await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', title_matter: 't.md', files: [{ path: 't.md' }, { path: 'a.md' }, { path: 'z.md', role: 'appendix', toc: false }] }, null, 2)}\n`)
  const order = ['r/t.md', 'r/a.md', 'r/z.md']
  const across = await moveFolioPiece(ws, 'r', { path: 'r/a.md', beforePath: 'r/t.md', expected: order })
  expect(across.result).toMatchObject({ ok: false, message: FRONT_MATTER_STAYS_LEADING })
  const appendix = await moveFolioPiece(ws, 'r', { path: 'r/z.md', beforePath: 'r/a.md', expected: order })
  expect(appendix.result).toMatchObject({ ok: true, order: ['r/t.md', 'r/z.md', 'r/a.md'] })
  expect(await folioFrontMatter(ws, 'r')).toEqual({ front: ['r/t.md'], titlePage: 'r/t.md' })
})

// ---- Undo of an Add: backups, the two-document guard through the checkpoints, a split Undo's notifications ---------

/** An Index-only Folio (no manifest) with r/a.md listed and r/b.md to add, and a Folio with both documents. */
async function smallFolio(withManifest: boolean): Promise<void> {
  await write('r/a.md', '# A\n')
  await write('r/b.md', '# B\n')
  await write('r/_r_INDEX.md', '# R\n\n## Running order\n\n- [[A]]\n')
  if (withManifest) await write(`r/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }] }, null, 2)}\n`)
}

test('Undo leaves every .writeflex-backup alone: one another writer made while the Add ran survives the Undo', async () => {
  await smallFolio(true)
  const backup = 'r/_r_INDEX.md.writeflex-backup'
  const added = await addFolioPieces(ws, 'r', { paths: ['r/b.md'], expected: ['r/a.md'] }, {
    beforeIndexWrite: async () => { await write(backup, 'INDEPENDENT BACKUP') },
  })
  if (!added.result.ok) throw new Error(added.result.message)
  expect(await read(backup)).toBe('INDEPENDENT BACKUP')
  const manifestBackup = `r/${MANIFEST_NAME}.writeflex-backup`
  const manifestBackupText = existsSync(join(root, manifestBackup)) ? await read(manifestBackup) : null
  expect((await removeAddedFolioPieces(ws, 'r', { token: added.result.undoToken! })).result).toMatchObject({ ok: true })
  expect(await read(backup)).toBe('INDEPENDENT BACKUP')
  // A backup the Add itself wrote stays too.
  if (manifestBackupText !== null) expect(await read(manifestBackup)).toBe(manifestBackupText)
})

test('a manifest that appears during the Undo’s Index Note checkpoint stops the Undo: nothing written, the token still usable', async () => {
  await smallFolio(false)
  const added = await addPlanParts(ws, 'r', { paths: ['r/b.md'], expected: planPartKeys((await readPlan(ws, 'r'))!) })
  if (!added.result.ok) throw new Error(added.result.message)
  expect(existsSync(join(root, `r/${MANIFEST_NAME}`))).toBe(false)
  const indexAfter = await read('r/_r_INDEX.md')
  const racer = JSON.stringify({ schema_version: 1, files: [{ path: 'a.md' }, { path: 'b.md' }] })
  const undone = await removeAddedPlanParts(ws, 'r', { token: added.result.undoToken! }, {
    beforeIndexWrite: async () => { await write(`r/${MANIFEST_NAME}`, racer) },
  })
  expect(undone.result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
  expect(undone.plan).toBeNull()
  expect(undone.writtenIndex).toBeUndefined()
  expect(await read('r/_r_INDEX.md')).toBe(indexAfter)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(racer)
  // Nothing was written, so the token is kept: once the manifest is gone again the Undo goes through.
  await rm(join(root, `r/${MANIFEST_NAME}`))
  expect((await removeAddedPlanParts(ws, 'r', { token: added.result.undoToken! })).result).toMatchObject({ ok: true })
  expect(await read('r/_r_INDEX.md')).toBe('# R\n\n## Running order\n\n- [[A]]\n')
})

test('a manifest changed between the Undo’s two writes: the Index Note is taken back, the Undo is stale, the token used up', async () => {
  await smallFolio(true)
  const added = await addFolioPieces(ws, 'r', { paths: ['r/b.md'], expected: ['r/a.md'] })
  if (!added.result.ok) throw new Error(added.result.message)
  const indexAfter = await read('r/_r_INDEX.md')
  const manifestAfter = await read(`r/${MANIFEST_NAME}`)
  const racer = `${manifestAfter} `
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    await original(path, content, options)
    if (path === 'r/_r_INDEX.md' && content !== indexAfter) await write(`r/${MANIFEST_NAME}`, racer)
  }) as typeof ws.saveFileWithoutReadBack
  const undone = await removeAddedFolioPieces(ws, 'r', { token: added.result.undoToken! })
  ws.saveFileWithoutReadBack = original
  expect(undone.result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
  expect(await read('r/_r_INDEX.md')).toBe(indexAfter)
  expect(await read(`r/${MANIFEST_NAME}`)).toBe(racer)
  // The Index Note was written (and taken back), so the token is gone even with the manifest as the Add left it.
  await write(`r/${MANIFEST_NAME}`, manifestAfter)
  expect((await removeAddedFolioPieces(ws, 'r', { token: added.result.undoToken! })).result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
})

test('folio:remove-added and plan:remove-added: a split Undo still tells the buffers and the collection about the Index Note', async () => {
  for (const channel of ['folio:remove-added', 'plan:remove-added']) {
    await rm(join(root, 'r'), { recursive: true, force: true })
    await smallFolio(true)
    const handlers = new Map<string, PlanIpcHandler>()
    const notices: Array<[string, string[]]> = []
    registerPlanIpcHandlers({ handle: (name, handler) => handlers.set(name, handler) }, {
      stateForSender: () => ({ workspace: ws }),
      requireWorkspace: (state) => state.workspace,
      checkpointFile: async () => {},
      notifyCollectionChanged: (_state, paths) => notices.push(['collection', paths]),
      notifyChangedOnDisk: (_state, paths) => notices.push(['disk', paths]),
    })
    const call = (name: string, input: unknown) => handlers.get(name)!({ sender: { id: 7 } }, input)
    const added = await call('folio:add-pieces', { dir: 'r', paths: ['r/b.md'], expected: ['r/a.md'] }) as { ok: boolean; undoToken?: string }
    expect(added.ok).toBe(true)
    const manifestAfter = await read(`r/${MANIFEST_NAME}`)
    notices.length = 0
    const original = ws.saveFileWithoutReadBack.bind(ws)
    let indexWrites = 0
    ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
      if (path === `r/${MANIFEST_NAME}`) throw new Error('injected manifest failure')
      if (path === 'r/_r_INDEX.md' && ++indexWrites === 2) throw new Error('injected take-back failure')
      return original(path, content, options)
    }) as typeof ws.saveFileWithoutReadBack
    const result = await call(channel, { dir: 'r', token: added.undoToken }) as { ok: boolean; message?: string }
    ws.saveFileWithoutReadBack = original
    expect(result.ok).toBe(false)
    expect(result.message).toContain('The Index Note was put back as it was before the Add, the Folio manifest was not')
    expect(await read('r/_r_INDEX.md')).toBe('# R\n\n## Running order\n\n- [[A]]\n')
    expect(await read(`r/${MANIFEST_NAME}`)).toBe(manifestAfter)
    expect(notices).toEqual([
      ['collection', ['r/_r_INDEX.md', `r/${MANIFEST_NAME}`]],
      ['disk', ['r/_r_INDEX.md']],
    ])
  }
})
