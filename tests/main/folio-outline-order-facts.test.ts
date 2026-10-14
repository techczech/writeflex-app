/**
 * The Outline read of a Folio's order facts: kept per Folio folder (no Plan load on a tab switch), dropped
 * when the app says something changed and after every Plan write; and "Also in this folder" for a Folio
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
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { addFolioPieces, moveFolioPiece } from '../../src/main/folio-running-order'
import { adoptPart, movePart, readPlan } from '../../src/main/plan'
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

test('two consecutive Outline reads of one Folio load its Plan once; a third after an invalidation loads it again', async () => {
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

test('a manifest-only Folio: consecutive reads read the manifest for the order facts once, and never load a Plan', async () => {
  await flatFolio(false)
  const count = counting()
  expect(await addable(piece('a'))).toEqual([piece('glossary')])
  const afterFirst = count.manifests()
  expect(await addable(piece('b'))).toEqual([piece('glossary')])
  expect(count.manifests()).toBe(afterFirst)
  expect(count.plans()).toBe(0)
})

test('every Plan write in this process drops the kept answer for its Folio, with no push from main', async () => {
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

// ---- "Also in this folder" for a content_root Folio ----

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
      ...(withIndex ? [[INDEX, false, null]] : []),
      [`${DIR}/README.md`, false, null],
      [`${DIR}/top.md`, false, null],
      [`${DIR}/contents/Notes.md`, true, 'contents'],
    ])
    expect(outline.also.at(-1)).toMatchObject({ title: 'Notes', headings: [{ text: 'Notes' }, { text: 'Loose ends' }] })

    const before = await read(MANIFEST)
    // A direct child of the Folio folder is not in the folder the Folio takes its pieces from.
    expect((await addFolioPieces(ws, DIR, { paths: [`${DIR}/top.md`], expected: IN })).result).toMatchObject({ ok: false, stale: false })
    expect(await read(MANIFEST)).toBe(before)
    const { result } = await addFolioPieces(ws, DIR, { paths: [`${DIR}/contents/Notes.md`], expected: IN })
    expect(result).toEqual({ ok: true, changed: true, order: [...IN, `${DIR}/contents/Notes.md`] })
    expect(JSON.parse(await read(MANIFEST)).files.map((file: { path: string }) => file.path)).toEqual(['01-a.md', '02-b.md', 'Notes.md'])
    expect(existsSync(join(root, INDEX))).toBe(withIndex)
    invalidateFolioPlaces(root)
    const after = (await folioOutline(ws, IN[0]))!
    expect(after.pieces.map((file) => file.path)).toEqual([...IN, `${DIR}/contents/Notes.md`])
    expect(after.also.some((file) => file.under)).toBe(false)
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

test('a content folder that is a symbolic link lists nothing from it and nothing is addable from it', async () => {
  await write('real/01-a.md', '# Alpha\n')
  await write('real/Notes.md', '# Notes\n')
  await write(`${DIR}/top.md`, '# Top\n')
  await symlink(join(root, 'real'), join(root, DIR, 'contents'))
  await write(MANIFEST, manifestOf(['01-a.md'], 'contents'))
  const outline = (await folioOutline(ws, `${DIR}/top.md`))!
  expect(outline.pieces).toEqual([])
  expect(outline.also.map((file) => file.path)).toEqual([`${DIR}/top.md`])
  expect(outline.also.some((file) => file.addable)).toBe(false)
  const before = await read(MANIFEST)
  expect((await addFolioPieces(ws, DIR, { paths: [`${DIR}/contents/Notes.md`], expected: [] })).result).toMatchObject({ ok: false })
  expect(await read(MANIFEST)).toBe(before)
})

// ---- The Plan view's own Add ----

test('the Plan view\'s Add of a file that shares its title with another file is refused; no other file is added in its place', async () => {
  await flatFolio(true)
  await write(piece('z'), '# Shared\n')
  await write(`${DIR}/README.md`, '# Shared\n')
  const plan = (await readPlan(ws, DIR))!
  const index = plan.unlisted.findIndex((part) => part.path === piece('z'))
  expect(index).toBeGreaterThanOrEqual(0)
  const bytes = [await read(MANIFEST), await read(INDEX)]
  await expect(adoptPart(ws, DIR, index)).rejects.toThrow('Two files here share the title "Shared". Rename one, then add it. Nothing was added.')
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  // A file with a title of its own is still added.
  const glossary = plan.unlisted.findIndex((part) => part.path === piece('glossary'))
  const after = await adoptPart(ws, DIR, glossary)
  expect(after.parts.map((part) => part.path)).toEqual([...AB, piece('glossary')])
})
