/**
 * The Outline read of a Folio's order facts: kept per Folio folder (no Plan load on a tab switch), dropped
 * when the app says something changed and after every Plan write; and "Not in the outline" for a Folio
 * that takes its pieces from a `content_root` folder. Plus the Plan view's own Add (`adoptPart`), which
 * must add exactly the file chosen.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { folioOutline } from '../../src/main/folio-outline'
import { folioPlace, invalidateFolioPlaces } from '../../src/main/folio-place'
import { addFolioPieces, moveFolioPiece } from '../../src/main/folio-running-order'
import { adoptPart, movePart, readPlan, removePart } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { OUTLINE_UNSAFE_MESSAGE } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'guide'
const INDEX = `${DIR}/_guide_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writeflex-order-facts-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const read = (path: string) => readFile(join(root, path), 'utf8')
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}
const manifestOf = (paths: string[], contentRoot = ''): string =>
  ['{', '  "schema_version": 1,', `  "content_root": "${contentRoot}",`, '  "files": [', paths.map((path) => `    { "path": "${path}" }`).join(',\n'), '  ]', '}', ''].join('\n')
const indexOf = (titles: string[]): string => `# Guide\n\n## Running order\n\n${titles.map((title) => `- [[${title}]]`).join('\n')}\n`
const piece = (name: string) => `${DIR}/${name}.md`
const AB = [piece('a'), piece('b')]

async function flatFolio(withIndex: boolean): Promise<void> {
  await write(piece('a'), '# Alpha\n')
  await write(piece('b'), '# Beta\n')
  await write(piece('glossary'), '# Glossary\n')
  await write(MANIFEST, manifestOf(['a.md', 'b.md']))
  if (withIndex) await write(INDEX, indexOf(['Alpha', 'Beta']))
}

/** Count what a Plan load does that an Outline read otherwise never does: list the whole workspace; and reads of the manifest. */
function counting(): { plans: () => number; manifests: () => number } {
  let plans = 0
  let manifests = 0
  const listFiles = ws.listFiles.bind(ws)
  ws.listFiles = (async () => { plans += 1; return listFiles() }) as typeof ws.listFiles
  const readFileOf = ws.readFile.bind(ws)
  ws.readFile = (async (path: string) => { if (path === MANIFEST) manifests += 1; return readFileOf(path) }) as typeof ws.readFile
  return { plans: () => plans, manifests: () => manifests }
}
const addable = async (path: string): Promise<string[]> => ((await folioOutline(ws, path))?.also ?? []).filter((file) => file.addable).map((file) => file.path)

test('two consecutive Outline reads of one Folio load its Folio outline once; a third after an invalidation loads it again', async () => {
  await flatFolio(true)
  const count = counting()
  expect(await addable(piece('a'))).toEqual([piece('glossary')])
  const afterFirst = count.plans()
  expect(afterFirst).toBeGreaterThan(0)
  // A tab switch inside the Folio: another file of it.
  expect(await addable(piece('b'))).toEqual([piece('glossary')])
  expect(await addable(piece('glossary'))).toEqual([piece('glossary')])
  expect(count.plans()).toBe(afterFirst)

  // The manifest changes on disk; main pushes collection:changed, which drops both kept answers.
  await write(MANIFEST, manifestOf(['b.md', 'a.md']))
  expect(await addable(piece('a'))).toEqual([piece('glossary')]) // still the kept answer: nothing said it changed
  expect(count.plans()).toBe(afterFirst)
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
  const changed = await folioOutline(ws, piece('a'))
  expect(count.plans()).toBeGreaterThan(afterFirst)
  // The Index Note still says Alpha, Beta: the two now disagree, so the controls go.
  expect(changed?.orderInPlanOnly).toBe(true)
  expect(changed?.also.some((file) => file.addable)).toBe(false)
})

// Sol round 2 (2026-10-20): the Outline takes the order the Folio page reads for a Folio with no Index Note (one
// Folio outline load, `readFolioPlan`), so the two never disagree; that load is kept with the facts like any other.
test('a manifest-only Folio: consecutive reads read the manifest and load the page\'s Folio outline for the order facts once', async () => {
  await flatFolio(false)
  const count = counting()
  expect(await addable(piece('a'))).toEqual([piece('glossary')])
  const afterFirst = count.manifests()
  const plansAfterFirst = count.plans()
  expect(plansAfterFirst).toBeGreaterThan(0)
  expect(await addable(piece('b'))).toEqual([piece('glossary')])
  expect(count.manifests()).toBe(afterFirst)
  expect(count.plans()).toBe(plansAfterFirst)
})

test('every Folio outline write in this process drops the kept answer for its Folio, with no push from main', async () => {
  await flatFolio(true)
  expect(await addable(piece('a'))).toEqual([piece('glossary')])
  // The Outline's own Add, then a Plan-view write: after each, the next read is made afresh.
  expect((await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: AB })).result).toMatchObject({ ok: true })
  invalidateFolioPlaces(root)
  expect(await addable(piece('a'))).toEqual([])
  await write(piece('notes'), '# Notes\n')
  expect(await addable(piece('a'))).toEqual([]) // kept: a new file with no push is not seen
  await movePart(ws, DIR, 0, 1)
  expect(await addable(piece('a'))).toEqual([piece('notes')])
  // And the manifest-only route.
  await rm(join(root, INDEX))
  invalidateFolioPlaces(root)
  invalidateFolioOrderFacts(root)
  const order = (await folioOutline(ws, piece('a')))!.pieces.map((file) => file.path)
  expect((await addFolioPieces(ws, DIR, { paths: [piece('notes')], expected: order })).result).toMatchObject({ ok: true })
  invalidateFolioPlaces(root)
  expect(await addable(piece('a'))).toEqual([])
})

test('the write routes do not trust the kept answer: a file marked addable that has since been listed is refused', async () => {
  await flatFolio(false)
  expect(await addable(piece('a'))).toEqual([piece('glossary')])
  await write(piece('_later'), '# Later\n')
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('_later')], expected: AB })
  expect(result).toMatchObject({ ok: false, stale: false })
})

// ---- "Not in the outline" for a content_root Folio ----

async function contentRootFolio(withIndex: boolean, contentRoot = 'contents'): Promise<void> {
  await write(`${DIR}/contents/01-a.md`, '# Alpha\n')
  await write(`${DIR}/contents/02-b.md`, '# Beta\n')
  await write(`${DIR}/contents/Notes.md`, '# Notes\n\n## Loose ends\n')
  await write(`${DIR}/contents/_draft.md`, '# Draft\n')
  await write(`${DIR}/contents/deeper/x.md`, '# X\n')
  await write(`${DIR}/README.md`, '# Read me\n')
  await write(`${DIR}/top.md`, '# Top\n')
  await write('elsewhere/out.md', '# Out\n')
  await write(MANIFEST, manifestOf(['01-a.md', '02-b.md'], contentRoot))
  if (withIndex) await write(INDEX, indexOf(['Alpha', 'Beta']))
}
const IN = [`${DIR}/contents/01-a.md`, `${DIR}/contents/02-b.md`]

for (const withIndex of [false, true]) {
  test(`a content_root Folio ${withIndex ? 'with an Index Note' : 'with no Index Note'} lists the content folder's unlisted file, with its sub-path, addable; Add works`, async () => {
    await contentRootFolio(withIndex)
    const outline = (await folioOutline(ws, IN[0]))!
    expect(outline.pieces.map((file) => file.path)).toEqual(IN)
    expect(outline.orderInPlanOnly).toBeUndefined()
    expect(outline.also.map((file) => [file.path, file.addable, file.under ?? null])).toEqual([
      // The Index Note, README and `_draft.md` are never listed; a sub-folder of the content folder is (any depth).
      // The Folio folder's own `top.md` is outside the piece root (content_root), so it is not listed: the Plan's boundary (review P2).
      [`${DIR}/contents/Notes.md`, true, 'contents'],
      [`${DIR}/contents/deeper/x.md`, true, 'contents/deeper'],
    ])
    expect(outline.also[0]).toMatchObject({ title: 'Notes', headings: [{ text: 'Notes' }, { text: 'Loose ends' }] })

    const before = await read(MANIFEST)
    // A direct child of the Folio folder is not in the folder the Folio takes its pieces from.
    expect((await addFolioPieces(ws, DIR, { paths: [`${DIR}/top.md`], expected: IN })).result).toMatchObject({ ok: false, stale: false })
    expect(await read(MANIFEST)).toBe(before)
    const { result } = await addFolioPieces(ws, DIR, { paths: [`${DIR}/contents/Notes.md`], expected: IN })
    expect(result).toMatchObject({ ok: true, changed: true, order: [...IN, `${DIR}/contents/Notes.md`] })
    expect(JSON.parse(await read(MANIFEST)).files.map((file: { path: string }) => file.path)).toEqual(['01-a.md', '02-b.md', 'Notes.md'])
    expect(existsSync(join(root, INDEX))).toBe(withIndex)
    invalidateFolioPlaces(root)
    const after = (await folioOutline(ws, IN[0]))!
    expect(after.pieces.map((file) => file.path)).toEqual([...IN, `${DIR}/contents/Notes.md`])
    expect(after.also.filter((file) => file.under).map((file) => file.under)).toEqual(['contents/deeper'])
  })

  test(`a content_root that points outside the Folio folder ${withIndex ? 'with an Index Note' : 'with no Index Note'}: nothing outside is listed, nothing is addable, Add is refused`, async () => {
    await contentRootFolio(withIndex, '../elsewhere')
    const outline = (await folioOutline(ws, `${DIR}/top.md`))!
    expect(outline.pieces).toEqual([])
    expect(outline.orderInPlanOnly).toBe(true)
    expect(outline.also.every((file) => file.path.startsWith(`${DIR}/`) && !file.path.slice(DIR.length + 1).includes('/'))).toBe(true)
    expect(outline.also.some((file) => file.addable || file.under)).toBe(false)
    const before = await read(MANIFEST)
    for (const path of ['elsewhere/out.md', `${DIR}/top.md`]) {
      expect((await addFolioPieces(ws, DIR, { paths: [path], expected: [] })).result).toEqual({ ok: false, stale: false, message: OUTLINE_UNSAFE_MESSAGE })
    }
    expect((await moveFolioPiece(ws, DIR, { path: `${DIR}/top.md`, beforePath: null, expected: [] })).result).toMatchObject({ ok: false })
    expect(await read(MANIFEST)).toBe(before)
  })
}

test('a content folder that is a symbolic link lists nothing from it (nor the Folio folder outside it) and nothing is addable from it', async () => {
  await write('real/01-a.md', '# Alpha\n')
  await write('real/Notes.md', '# Notes\n')
  await write(`${DIR}/top.md`, '# Top\n')
  await symlink(join(root, 'real'), join(root, DIR, 'contents'))
  await write(MANIFEST, manifestOf(['01-a.md'], 'contents'))
  const outline = (await folioOutline(ws, `${DIR}/top.md`))!
  expect(outline.pieces).toEqual([])
  expect(outline.also.map((file) => file.path)).toEqual([])
  expect(outline.also.some((file) => file.addable)).toBe(false)
  const before = await read(MANIFEST)
  expect((await addFolioPieces(ws, DIR, { paths: [`${DIR}/contents/Notes.md`], expected: [] })).result).toMatchObject({ ok: false })
  expect(await read(MANIFEST)).toBe(before)
})

// ---- The Plan view's own Add ----

test('the Folio outline view\'s Add of a file that shares its title with another file adds that file by its path; no other file is added in its place', async () => {
  // Duplicate titles are allowed so the author can rename them later.
  await flatFolio(true)
  await write(piece('z'), '# Shared\n')
  await write(`${DIR}/README.md`, '# Shared\n')
  const plan = (await readPlan(ws, DIR))!
  const index = plan.unlisted.findIndex((part) => part.path === piece('z'))
  expect(index).toBeGreaterThanOrEqual(0)
  const added = await adoptPart(ws, DIR, index)
  expect(added.parts.map((part) => part.path)).toEqual([...AB, piece('z')])
  expect(await read(INDEX)).toContain('- [[./z]]')
  expect(await read(INDEX)).not.toContain('[[Shared]]')
  // A file with a title of its own is still added by its title.
  const glossary = added.unlisted.findIndex((part) => part.path === piece('glossary'))
  const after = await adoptPart(ws, DIR, glossary)
  expect(after.parts.map((part) => part.path)).toEqual([...AB, piece('z'), piece('glossary')])
})

// ---- The Pangram-shaped Folio: title_matter removed from the running order (ADR-0046) ----

for (const withIndex of [false, true]) {
  test(`${withIndex ? 'with' : 'without'} an Index Note, the title_matter file left out of the running order is listed under Not in the outline and can be put back`, async () => {
    await write(`${DIR}/contents/00-frontmatter.md`, '# Front matter\n')
    await write(`${DIR}/contents/01-a.md`, '# Alpha\n')
    await write(`${DIR}/contents/02-b.md`, '# Beta\n')
    await write(`${DIR}/contents/03-vignettes/v1.md`, '# Vignette one\n')
    await write(MANIFEST, JSON.stringify({ schema_version: 1, content_root: 'contents', title_matter: 'contents/00-frontmatter.md', files: [{ path: '01-a.md' }, { path: '02-b.md' }] }, null, 2))
    if (withIndex) await write(INDEX, indexOf(['Alpha', 'Beta']))
    const IN2 = [`${DIR}/contents/01-a.md`, `${DIR}/contents/02-b.md`]
    const outline = (await folioOutline(ws, IN2[0]))!
    expect(outline.also.map((file) => [file.path, file.addable, file.under ?? null])).toEqual([
      [`${DIR}/contents/00-frontmatter.md`, true, 'contents'],
      [`${DIR}/contents/03-vignettes/v1.md`, true, 'contents/03-vignettes'],
    ])
    for (const path of [`${DIR}/contents/00-frontmatter.md`, `${DIR}/contents/03-vignettes/v1.md`]) {
      const current = (await folioOutline(ws, IN2[0]))!.pieces.map((file) => file.path)
      const { result } = await addFolioPieces(ws, DIR, { paths: [path], expected: current })
      expect(result).toMatchObject({ ok: true, changed: true })
      invalidateFolioPlaces(root)
      invalidateFolioOrderFacts(root)
      expect((await folioOutline(ws, IN2[0]))!.pieces.map((file) => file.path)).toContain(path)
    }
    expect((await folioOutline(ws, IN2[0]))!.also).toEqual([])
  })
}

// The sidebar's numbered order is the Plan's running order, not the manifest's `files` (owner report, 0.25.1-alpha.2).
const REPORT = 'report'
const REPORT_INDEX = `${REPORT}/_report_INDEX.md`
const REPORT_PARTS: Array<[string, string]> = [
  ['02-offer.md', 'Offer'], ['03-team.md', 'Team'], ['04-researchers.md', 'Researchers'], ['05-talks.md', 'Talks'], ['06-consultancy.md', 'Consultancy'],
]
async function reportFolio(indexTitles: string[]): Promise<void> {
  await write(`${REPORT}/contents/00-frontmatter.md`, '---\ntitle: Title page\n---\n')
  for (const [file, title] of REPORT_PARTS) await write(`${REPORT}/contents/${file}`, `# ${title}\n`)
  await write(`${REPORT}/${MANIFEST_NAME}`, JSON.stringify({
    schema_version: 1,
    content_root: 'contents',
    title_matter: 'contents/00-frontmatter.md',
    files: [{ path: '00-frontmatter.md', role: 'title-matter', toc: false }, ...REPORT_PARTS.map(([file]) => ({ path: file, role: 'section', toc: true }))],
  }, null, 2))
  await write(REPORT_INDEX, indexOf(indexTitles))
}
const planOrder = async (): Promise<string[]> => ((await readPlan(ws, REPORT))?.parts ?? []).map((part) => part.path as string)
const sidebarOrder = async (): Promise<string[]> => ((await folioOutline(ws, `${REPORT}/contents/02-offer.md`))?.pieces ?? []).map((file) => file.path)

test('the sidebar numbered order is the Folio outline running order; a manifest file the running order lacks is Not in the outline', async () => {
  await reportFolio(REPORT_PARTS.map(([, title]) => title))
  const outline = await folioOutline(ws, `${REPORT}/contents/02-offer.md`)
  expect(outline?.pieces.map((file) => file.path)).toEqual(await planOrder())
  expect(outline?.pieces.map((file) => file.path)).toEqual(REPORT_PARTS.map(([file]) => `${REPORT}/contents/${file}`))
  expect(outline?.also.map((file) => file.path)).toContain(`${REPORT}/contents/00-frontmatter.md`)
})

test('after the Folio outline removes a part, the sidebar order matches the Folio outline and the part is Not in the outline', async () => {
  await reportFolio(['Title page', ...REPORT_PARTS.map(([, title]) => title)])
  expect((await sidebarOrder())[0]).toBe(`${REPORT}/contents/00-frontmatter.md`)
  await removePart(ws, REPORT, 0)
  invalidateFolioPlaces(root) // main drops these on the published collection:changed
  expect(await sidebarOrder()).toEqual(await planOrder())
  expect((await sidebarOrder())[0]).toBe(`${REPORT}/contents/02-offer.md`)
  expect((await folioOutline(ws, `${REPORT}/contents/02-offer.md`))?.also.map((file) => file.path)).toContain(`${REPORT}/contents/00-frontmatter.md`)
})

test('a manifest-only Folio keeps the manifest order', async () => {
  await reportFolio([])
  await rm(join(root, REPORT_INDEX))
  expect(await sidebarOrder()).toEqual(['00-frontmatter.md', ...REPORT_PARTS.map(([file]) => file)].map((file) => `${REPORT}/contents/${file}`))
})

test('a plain running-order line names a manifest piece in a sub-folder: the Outline order and the place keep it', async () => {
  await write('quokka/01-alpha.md', '# Alpha\n')
  await write('quokka/evidence/02-delta.md', '# Delta\n')
  await write('quokka/_quokka_INDEX.md', '# quokka\n\n## Running order\n\n- Alpha\n- Delta\n')
  await write(`quokka/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: '01-alpha.md' }, { path: 'evidence/02-delta.md' }] }))
  const outline = await folioOutline(ws, 'quokka/01-alpha.md')
  expect(outline?.pieces.map((p) => p.path)).toEqual(['quokka/01-alpha.md', 'quokka/evidence/02-delta.md'])
  const place = await folioPlace(ws, 'quokka/01-alpha.md')
  expect(place).toMatchObject({ position: 1, total: 2 })
  expect(place?.next?.path).toBe('quokka/evidence/02-delta.md')
})
