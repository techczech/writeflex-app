/**
 * Running order of a Folio that has a manifest and no Index Note (what "Make a Folio" leaves): the Outline's
 * three routes change the manifest's `files` array only, never create an Index Note, and refuse, writing
 * nothing, whatever they cannot do exactly. Each test fails when the guard it names is taken out.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { draftManifest, MANIFEST_NAME } from '../../src/main/folio'
import { folioOutline } from '../../src/main/folio-outline'
import { folioPlace, invalidateFolioPlaces } from '../../src/main/folio-place'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from '../../src/main/folio-running-order'
import { jsonArrayLayout } from '../../src/main/json-array-layout'
import { PLAN_BACKUP_SUFFIX } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { OUTLINE_UNSAFE_MESSAGE, STALE_ORDER_MESSAGE, STALE_UNDO_MESSAGE } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'guide'
const INDEX = `${DIR}/_guide_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const BACKUP = `${MANIFEST}${PLAN_BACKUP_SUFFIX}`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writeflex-manifest-only-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const read = (path: string) => readFile(join(root, path), 'utf8')
const piece = (name: string) => `${DIR}/${name}.md`
const ABCD = ['a', 'b', 'c', 'd'].map(piece)

/** Four-space indentation, unknown top-level keys before and after `files`, per-entry fields, differing spacing inside entries, two trailing newlines. */
const ODD = [
  '{',
  '    "schema_version": 1,',
  '    "title": "Guide",',
  '    "content_root": "",',
  '    "x_custom": { "keep": [1, 2,  3], "note": "do not touch" },',
  '    "files": [',
  '        { "path": "a.md",   "role": "vignette", "render": "plain" },',
  '        {"path":"b.md","role":"section","x":{"deep":true}},',
  '        { "path": "c.md", "toc": false },',
  '        { "path": "d.md", "role": "appendix" }',
  '    ],',
  '    "output": "out/guide.docx"',
  '}',
  '',
  '',
].join('\n')
const plain = (paths: string[], contentRoot = ''): string =>
  ['{', '  "schema_version": 1,', `  "content_root": "${contentRoot}",`, '  "files": [', paths.map((path) => `    { "path": "${path}" }`).join(',\n'), '  ]', '}', ''].join('\n')

async function makeFolio(manifest: string = ODD, extra: Record<string, string> = {}): Promise<void> {
  const files: Record<string, string> = {
    'a.md': '# Alpha\n', 'b.md': '# Beta\n', 'c.md': '# Gamma\n', 'd.md': '# Delta\n',
    'glossary.md': '# Glossary\n', 'snippets.md': '---\nrole: appendix\n---\n# Snippets\n', '_hidden.md': '# Hidden\n', 'sub/deep.md': '# Deep\n', ...extra,
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, DIR, name, '..'), { recursive: true })
    await writeFile(join(root, DIR, name), text)
  }
  await writeFile(join(root, MANIFEST), manifest)
  invalidateFolioPlaces(root)
}

const raws = (source: string): string[] => jsonArrayLayout(source, 'files').entries.map((entry) => entry.raw)
/** `before` with the raw text of its entries replaced, slot by slot, by `entries`: every byte outside the entries kept. */
function withEntries(before: string, entries: string[]): string {
  const layout = jsonArrayLayout(before, 'files')
  let out = before
  for (let at = layout.entries.length - 1; at >= 0; at -= 1) out = `${out.slice(0, layout.entries[at].start)}${entries[at]}${out.slice(layout.entries[at].end)}`
  return out
}
/** Nothing was written: the manifest's bytes, no Index Note, no backup, no stray temporary file. */
async function expectUntouched(bytes: string): Promise<void> {
  expect(await read(MANIFEST)).toBe(bytes)
  expect(existsSync(join(root, INDEX))).toBe(false)
  expect(existsSync(join(root, BACKUP))).toBe(false)
  expect((await readdir(join(root, DIR))).filter((name) => name.endsWith('.tmp'))).toEqual([])
}

test('a move changes only the order of the array elements: every other byte is identical, each entry keeps its exact text, no Index Note is made', async () => {
  await makeFolio()
  const before = await read(MANIFEST)
  const [a, b, c, d] = raws(before)
  const { result, plan, manifestOnly } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD })
  expect(result).toEqual({ ok: true, changed: true, order: [piece('c'), piece('a'), piece('b'), piece('d')] })
  expect(plan).toBeNull()
  expect(manifestOnly).toBe(true)
  const after = await read(MANIFEST)
  expect(raws(after)).toEqual([c, a, b, d])
  expect(after).toBe(withEntries(before, [c, a, b, d]))
  expect(after.endsWith('}\n\n')).toBe(true)
  expect(JSON.parse(after).x_custom).toEqual({ keep: [1, 2, 3], note: 'do not touch' })
  expect(existsSync(join(root, INDEX))).toBe(false)
  // The pristine copy is the manifest as it was before its first change.
  expect(await read(BACKUP)).toBe(before)

  // To the end, then back: the manifest is byte for byte what it was.
  const second = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: null, expected: [piece('c'), piece('a'), piece('b'), piece('d')] })
  expect(second.result).toMatchObject({ ok: true, order: [piece('a'), piece('b'), piece('d'), piece('c')] })
  await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('d'), expected: [piece('a'), piece('b'), piece('d'), piece('c')] })
  expect(await read(MANIFEST)).toBe(before)
  expect(existsSync(join(root, INDEX))).toBe(false)
})

test('the Outline read shows a manifest-only Folio as changeable, and the Plan line follows a move', async () => {
  await makeFolio()
  const outline = await folioOutline(ws, piece('c'))
  expect(outline?.orderInPlanOnly).toBeUndefined()
  expect(outline?.also.filter((file) => file.addable).map((file) => file.path)).toEqual([piece('glossary'), piece('snippets')])
  expect(outline?.also.find((file) => file.path === piece('_hidden'))?.addable).toBe(false)
  expect((await folioPlace(ws, piece('c')))?.position).toBe(3)
  await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD })
  invalidateFolioPlaces(root) // main does this when it pushes collection:changed
  expect((await folioPlace(ws, piece('c')))).toMatchObject({ position: 1, total: 4 })
  expect((await folioOutline(ws, piece('c')))?.pieces.map((file) => file.path)).toEqual([piece('c'), piece('a'), piece('b'), piece('d')])
})

test('a move in place writes nothing', async () => {
  await makeFolio()
  const before = await read(MANIFEST)
  expect((await moveFolioPiece(ws, DIR, { path: piece('b'), beforePath: piece('c'), expected: ABCD })).result).toEqual({ ok: true, changed: false, order: ABCD })
  await expectUntouched(before)
})

test('Add appends entries in the manifest\'s own layout and the Plan\'s shape; Undo takes out exactly those and restores the bytes', async () => {
  await makeFolio()
  const before = await read(MANIFEST)
  const added = await addFolioPieces(ws, DIR, { paths: [piece('snippets'), piece('glossary')], expected: ABCD })
  expect(added.result).toEqual({ ok: true, changed: true, order: [...ABCD, piece('snippets'), piece('glossary')] })
  const after = await read(MANIFEST)
  // Siblings carry roles, so a new entry carries one: the file's own role, else section. Existing entries keep their bytes.
  expect(raws(after)).toEqual([
    ...raws(before),
    '{\n          "path": "snippets.md",\n          "role": "appendix"\n        }',
    '{\n          "path": "glossary.md",\n          "role": "section"\n        }',
  ])
  expect(after.startsWith(before.slice(0, jsonArrayLayout(before, 'files').entries[3].end))).toBe(true)
  expect(after.endsWith('\n    ],\n    "output": "out/guide.docx"\n}\n\n')).toBe(true)
  expect(existsSync(join(root, INDEX))).toBe(false)

  // Undo of only the last one is refused while it names pieces that are not the tail in the order added.
  const wrong = await removeAddedFolioPieces(ws, DIR, { paths: [piece('glossary'), piece('snippets')], expected: [...ABCD, piece('snippets'), piece('glossary')] })
  expect(wrong.result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
  expect(await read(MANIFEST)).toBe(after)
  const undone = await removeAddedFolioPieces(ws, DIR, { paths: [piece('snippets'), piece('glossary')], expected: [...ABCD, piece('snippets'), piece('glossary')] })
  expect(undone.result).toEqual({ ok: true, changed: true, order: ABCD })
  expect(await read(MANIFEST)).toBe(before)
  expect(existsSync(join(root, INDEX))).toBe(false)
})

test('Add writes the entry draftManifest writes for a freshly made Folio, and the same bytes the Plan\'s Add writes when the Folio has an Index Note', async () => {
  // A Folio exactly as "Make a Folio" leaves it.
  await makeFolio('{}')
  await rm(join(root, MANIFEST))
  await rm(join(root, DIR, 'glossary.md'))
  const drafted = await draftManifest(ws, DIR)
  await writeFile(join(root, MANIFEST), drafted)
  await writeFile(join(root, DIR, 'glossary.md'), '# Glossary\n')
  invalidateFolioPlaces(root)
  const order = [...ABCD, piece('snippets')]
  expect((await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: order })).result).toMatchObject({ ok: true })
  const manifestOnly = await read(MANIFEST)
  expect(JSON.parse(manifestOnly).files.at(-1)).toEqual({ path: 'glossary.md', role: 'section' })
  expect(raws(manifestOnly).at(-1)).toBe('{\n      "path": "glossary.md",\n      "role": "section"\n    }')

  // The same manifest with an Index Note beside it: the two-document Add leaves the same manifest bytes.
  await writeFile(join(root, MANIFEST), drafted)
  await writeFile(join(root, INDEX), '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n- [[Snippets]]\n')
  expect((await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: order })).result).toMatchObject({ ok: true })
  expect(await read(MANIFEST)).toBe(manifestOnly)
})

test('Add to a manifest whose entries carry no role writes a path only; one whose entries carry ids gains an id', async () => {
  await makeFolio(plain(['a.md', 'b.md', 'c.md', 'd.md']))
  await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })
  expect(JSON.parse(await read(MANIFEST)).files.at(-1)).toEqual({ path: 'glossary.md' })
  await writeFile(join(root, MANIFEST), plain(['a.md', 'b.md', 'c.md', 'd.md']).replace('{ "path": "a.md" }', '{ "id": "alpha", "path": "a.md" }'))
  await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })
  expect(JSON.parse(await read(MANIFEST)).files.at(-1)).toEqual({ id: 'glossary', path: 'glossary.md' })
})

test('two files with the same title can both be added: entries are paths, and each resolves to its own file', async () => {
  await makeFolio(ODD, { 'z.md': '# Glossary\n' })
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('z'), piece('glossary')], expected: ABCD })
  expect(result).toMatchObject({ ok: true, order: [...ABCD, piece('z'), piece('glossary')] })
})

test('a manifest in another order than the caller saw is refused as stale by all three routes; nothing is written', async () => {
  await makeFolio(plain(['b.md', 'a.md', 'c.md', 'd.md']))
  const bytes = await read(MANIFEST)
  expect((await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: ABCD })).result).toEqual({ ok: false, stale: true, message: STALE_ORDER_MESSAGE })
  expect((await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })).result).toMatchObject({ ok: false, stale: true })
  expect((await removeAddedFolioPieces(ws, DIR, { paths: [piece('d')], expected: ABCD })).result).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
  await expectUntouched(bytes)
})

const REFUSED: Array<[string, () => Promise<string>]> = [
  ['a file listed twice', async () => plain(['a.md', 'b.md', 'b.md', 'c.md', 'd.md'])],
  ['one file listed under both path conventions', async () => {
    await mkdir(join(root, DIR, 'contents'), { recursive: true })
    await writeFile(join(root, DIR, 'contents/x.md'), '# X\n')
    return plain(['x.md', 'contents/x.md'], 'contents')
  }],
  ['an entry whose file is missing', async () => plain(['a.md', 'gone.md', 'c.md', 'd.md'])],
  ['an entry outside the folder', async () => plain(['a.md', '../elsewhere.md', 'b.md', 'c.md', 'd.md'])],
  ['a content_root that leaves the folder', async () => plain(['a.md', 'b.md', 'c.md', 'd.md'], '../elsewhere')],
  ['an entry with no path', async () => plain(['a.md', 'b.md', 'c.md', 'd.md']).replace('{ "path": "b.md" }', '{ "role": "section" },\n    { "path": "b.md" }')],
  ['an element that is not an entry', async () => plain(['a.md', 'b.md', 'c.md', 'd.md']).replace('{ "path": "b.md" }', '"b.md"')],
]
for (const [shape, build] of REFUSED) {
  test(`refused, nothing written: ${shape}`, async () => {
    await writeFile(join(root, 'elsewhere.md'), '# Elsewhere\n')
    await makeFolio()
    await writeFile(join(root, MANIFEST), await build())
    invalidateFolioPlaces(root)
    const bytes = await read(MANIFEST)
    const shown = (await folioOutline(ws, piece('a')))!
    expect(shown.orderInPlanOnly).toBe(true)
    expect(shown.also.some((file) => file.addable)).toBe(false)
    const expected = shown.pieces.map((file) => file.path)
    const refusal = { ok: false, stale: false, message: OUTLINE_UNSAFE_MESSAGE }
    expect((await moveFolioPiece(ws, DIR, { path: expected.at(-1) ?? piece('a'), beforePath: expected[0] ?? null, expected })).result).toEqual(refusal)
    expect((await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected })).result).toEqual(refusal)
    expect((await removeAddedFolioPieces(ws, DIR, { paths: [expected.at(-1) ?? piece('a')], expected })).result).toEqual(refusal)
    await expectUntouched(bytes)
  })
}

test('Add re-checks the addable rule in main: an underscore file, a file in a sub-folder and a file of another folder are refused', async () => {
  await makeFolio()
  await writeFile(join(root, 'loose.md'), '# Loose\n')
  const bytes = await read(MANIFEST)
  for (const path of [piece('_hidden'), `${DIR}/sub/deep.md`, 'loose.md', `${DIR}/nowhere.md`]) {
    const { result } = await addFolioPieces(ws, DIR, { paths: [piece('glossary'), path], expected: ABCD })
    expect(result).toMatchObject({ ok: false, stale: false })
    expect((result as { message: string }).message).toContain('Nothing was added.')
  }
  expect((await addFolioPieces(ws, DIR, { paths: [piece('b')], expected: ABCD })).result).toMatchObject({ ok: false, stale: true })
  await expectUntouched(bytes)
})

test('two requests made at once from the same running order: the first is written, the second waits and is refused as stale', async () => {
  await makeFolio()
  const [first, second, third] = await Promise.all([
    moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: ABCD }),
    moveFolioPiece(ws, DIR, { path: piece('b'), beforePath: null, expected: ABCD }),
    addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD }),
  ])
  expect(first.result).toMatchObject({ ok: true, order: [piece('d'), piece('a'), piece('b'), piece('c')] })
  expect(second.result).toEqual({ ok: false, stale: true, message: STALE_ORDER_MESSAGE })
  expect(third.result).toMatchObject({ ok: false, stale: true })
  expect(JSON.parse(await read(MANIFEST)).files.map((file: { path: string }) => file.path)).toEqual(['d.md', 'a.md', 'b.md', 'c.md'])
})

test('a manifest another writer changes after the request read it is not overwritten', async () => {
  await makeFolio()
  const racer = plain(['d.md', 'c.md', 'b.md', 'a.md'])
  // The checkpoint hook runs after every check and before the write's own byte comparison.
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD }, {
    beforeManifestWrite: async () => { await writeFile(join(root, MANIFEST), racer) },
  })
  expect(result).toMatchObject({ ok: false, stale: false })
  expect(await read(MANIFEST)).toBe(racer)
  expect(existsSync(join(root, BACKUP))).toBe(false)
})

test('an Index Note that appears while the request is under way stops the manifest-only write', async () => {
  await makeFolio()
  const bytes = await read(MANIFEST)
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD }, {
    beforeManifestWrite: async () => { await writeFile(join(root, INDEX), '# Guide\n') },
  })
  expect(result).toEqual({ ok: false, stale: false, message: 'This Folio gained an Index Note meanwhile, so nothing was changed.' })
  expect(await read(MANIFEST)).toBe(bytes)
  expect((await readdir(join(root, DIR))).filter((name) => name.endsWith('.tmp'))).toEqual([])
})

test('a Folio with both documents is still changed in both, as before', async () => {
  await makeFolio(plain(['a.md', 'b.md', 'c.md', 'd.md']))
  await writeFile(join(root, INDEX), '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n')
  const { result, plan, manifestOnly } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ABCD })
  expect(result).toMatchObject({ ok: true })
  expect(manifestOnly).toBeUndefined()
  expect(plan?.parts.map((part) => part.title)).toEqual(['Gamma', 'Alpha', 'Beta', 'Delta'])
  expect(await read(INDEX)).toContain('- [[Gamma]]\n- [[Alpha]]\n- [[Beta]]\n- [[Delta]]')
})
