import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folioPieces, MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from '../../src/main/folio-running-order'
import { readPlan } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { addedAnnouncement, commandTarget, dragLabel, dropFor, movedAnnouncement, undoneAnnouncement, isInPlace, resolveMove, slotAt, successorOf } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'guide'
const INDEX = `${DIR}/_guide_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writeflex-running-order-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const read = (path: string) => readFile(join(root, path), 'utf8')
const piece = (name: string) => `${DIR}/${name}.md`

/** Four pieces in the manifest (a b c d) and files that are not listed. (A Folio with an entry outside its folder is the Plan's to change: folio-running-order-guards.test.ts.) */
async function makeFolio(opts: { manifest?: string; index?: string; extra?: Record<string, string> } = {}): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  const files: Record<string, string> = {
    'a.md': '# Alpha\n', 'b.md': '# Beta\n', 'c.md': '# Gamma\n', 'd.md': '# Delta\n',
    'glossary.md': '# Glossary\n', 'snippets.md': '# Snippets\n', '_hidden.md': '# Hidden\n', ...opts.extra,
  }
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, DIR, name), text)
  await writeFile(join(root, MANIFEST), opts.manifest ?? [
    '{', '  "schema_version": 1,', '  "content_root": "",', '  "files": [',
    '    { "path": "a.md" },', '    { "path": "b.md" },', '    { "path": "c.md" },', '    { "path": "d.md" }',
    '  ]', '}', '',
  ].join('\n'))
  await writeFile(join(root, INDEX), opts.index ?? '# Guide\n\nIntro.\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Gamma]]\n- [[Delta]]\n')
}

const order = async () => (await folioPieces(ws, DIR))!.pieces
const ABCD = ['a', 'b', 'c', 'd'].map(piece)

test('moving a piece before another writes the new order and keeps every entry once', async () => {
  await makeFolio()
  const before = await order()
  expect(before).toEqual(ABCD)
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: before })
  expect(result).toEqual({ ok: true, changed: true, order: ['c', 'a', 'b', 'd'].map(piece) })
  expect([...(await order())].sort()).toEqual([...before].sort())
  const manifest = await read(MANIFEST)
  expect(manifest.indexOf('"c.md"')).toBeLessThan(manifest.indexOf('"a.md"'))
  expect(await read(INDEX)).toContain('- [[Gamma]]\n- [[Alpha]]\n- [[Beta]]\n- [[Delta]]')
})

test('moving to the end (beforePath null) puts the piece last', async () => {
  await makeFolio()
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath: null, expected: await order() })
  expect(result).toMatchObject({ ok: true, order: ['b', 'c', 'd', 'a'].map(piece) })
})

test('dropping in place writes nothing', async () => {
  await makeFolio()
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const expected = await order()
  for (const beforePath of [piece('b'), piece('a')]) {
    const { result, plan } = await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath, expected })
    expect(result).toMatchObject({ ok: true, changed: false })
    expect(plan).toBeNull()
  }
  expect(await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: null, expected })).toMatchObject({ result: { changed: false } })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  // No backup file appears from a no-op either.
  expect((await readdir(join(root, DIR))).filter((n) => n.endsWith('.writeflex-backup'))).toEqual([])
})

test('a stale read is refused and nothing is written (a piece was inserted before it)', async () => {
  await makeFolio()
  const seen = await order()
  // Another writer puts a piece first, in both the manifest and the Index Note, after the Outline read.
  await writeFile(join(root, DIR, 'n.md'), '# New\n')
  await writeFile(join(root, MANIFEST), (await read(MANIFEST)).replace('{ "path": "a.md" },', '{ "path": "n.md" },\n    { "path": "a.md" },'))
  await writeFile(join(root, INDEX), (await read(INDEX)).replace('- [[Alpha]]', '- [[New]]\n- [[Alpha]]'))
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: seen })
  expect(result).toMatchObject({ ok: false, stale: true })
  // A drop "in place" against the fresh order never reaches a Plan write, so only the first check can
  // refuse it: with a stale `expected` it is stale too, not a silent no-op.
  expect((await moveFolioPiece(ws, DIR, { path: piece('n'), beforePath: piece('a'), expected: seen })).result).toMatchObject({ ok: false, stale: true })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  // Asked again with the fresh order, the right piece moves.
  const fresh = await order()
  expect(fresh[0]).toBe(piece('n'))
  const retry = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: fresh })
  expect(retry.result).toMatchObject({ ok: true, order: ['n', 'c', 'a', 'b', 'd'].map(piece) })
})

test('an unknown path, a path outside the Folio and a path that is not a piece are refused with nothing written', async () => {
  await makeFolio()
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const expected = await order()
  for (const [path, beforePath] of [[piece('zzz'), piece('a')], [piece('a'), piece('zzz')], [piece('glossary'), piece('a')], [piece('a'), piece('snippets')]] as const) {
    expect((await moveFolioPiece(ws, DIR, { path, beforePath, expected })).result).toMatchObject({ ok: false })
  }
  await expect(moveFolioPiece(ws, DIR, { path: '../outside.md', beforePath: null, expected })).rejects.toThrow()
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('a Folio with no manifest is not changed here', async () => {
  await makeFolio()
  await rm(join(root, MANIFEST))
  invalidateFolioPlaces(root)
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: ['a', 'b', 'c', 'd'].map(piece) })
  expect(result).toMatchObject({ ok: false, stale: false })
  expect(await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })).toMatchObject({ result: { ok: false } })
})

test('a manifest the Index Note disagrees with is refused rather than guessed at', async () => {
  await makeFolio({ index: '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n' })
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: await order() })
  expect(result).toMatchObject({ ok: false, stale: false })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('a piece listed twice cannot be moved', async () => {
  await makeFolio({
    manifest: '{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [\n    { "path": "a.md" },\n    { "path": "b.md" },\n    { "path": "a.md" }\n  ]\n}\n',
    index: '# Guide\n\n## Running order\n\n- [[Alpha]]\n- [[Beta]]\n- [[Alpha]]\n',
  })
  const expected = await order()
  const bytes = [await read(MANIFEST), await read(INDEX)]
  expect((await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath: null, expected })).result).toMatchObject({ ok: false })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('Undo of a move (moving it back before its old successor) restores the previous order in the manifest and the Index Note', async () => {
  await makeFolio()
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const start = await order()
  const moved = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: start })
  expect(moved.result.ok && moved.result.order).toEqual(['c', 'a', 'b', 'd'].map(piece))
  const back = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: successorOf(start, piece('c')), expected: ['c', 'a', 'b', 'd'].map(piece) })
  expect(back.result).toMatchObject({ ok: true, order: start })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  // Moved to the end and undone (old successor null).
  await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: start })
  await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: null, expected: ['d', 'a', 'b', 'c'].map(piece) })
  await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: ['a', 'b', 'c', 'd'].map(piece) })
  const restored = await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: null, expected: ['d', 'a', 'b', 'c'].map(piece) })
  expect(restored.result).toMatchObject({ ok: true, order: start })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('Undo of a move is refused when the running order changed since', async () => {
  await makeFolio()
  const start = await order()
  await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: start })
  await moveFolioPiece(ws, DIR, { path: piece('b'), beforePath: null, expected: ['c', 'a', 'b', 'd'].map(piece) })
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const back = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('b'), expected: ['c', 'a', 'b', 'd'].map(piece) })
  expect(back.result).toMatchObject({ ok: false, stale: true })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('Add puts the file last, and only files directly in the Folio folder that its rules admit', async () => {
  await makeFolio()
  const expected = await order()
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected })
  expect(result).toMatchObject({ ok: true, changed: true, order: [...ABCD, piece('glossary')] })
  expect(result.ok && typeof result.undoToken).toBe('string')
  expect(await read(MANIFEST)).toContain('glossary.md')
  expect(await read(INDEX)).toContain('- [[Glossary]]')
  expect(await read(`${DIR}/glossary.md`)).toBe('# Glossary\n')
})

test('Add refuses a non-addable file, a listed file and a file outside, writing nothing; a file in a sub-folder is accepted', async () => {
  await makeFolio({ extra: {} })
  await mkdir(join(root, DIR, 'sub'), { recursive: true })
  await writeFile(join(root, DIR, 'sub', 'deep.md'), '# Deep\n')
  await writeFile(join(root, 'stray.md'), '# Stray\n')
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const expected = await order()
  for (const paths of [[piece('_hidden')], [INDEX], ['stray.md'], [piece('a')], [piece('glossary'), piece('_hidden')], [piece('gone')], []]) {
    const { result } = await addFolioPieces(ws, DIR, { paths, expected })
    expect(result.ok).toBe(false)
  }
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  expect(await order()).toEqual(expected)
  const deep = await addFolioPieces(ws, DIR, { paths: [`${DIR}/sub/deep.md`], expected })
  expect(deep.result).toMatchObject({ ok: true, changed: true })
  expect(await order()).toEqual([...expected, `${DIR}/sub/deep.md`])
})

test('Add all adds every file in the order given, in one write', async () => {
  await makeFolio()
  const expected = await order()
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('glossary'), piece('snippets')], expected })
  expect(result).toMatchObject({ ok: true, order: [...ABCD, piece('glossary'), piece('snippets')] })
  expect(await read(INDEX)).toContain('- [[Delta]]\n- [[Glossary]]\n- [[Snippets]]')
})

test('Add all: a file whose bare path two files share goes in by its path with its extension', async () => {
  // zz.md shares its title with a cover, and its bare path `./zz` with zz.markdown (ambiguous: names neither). Its
  // path with the extension, `./zz.md`, names it alone (Sol round 3: an explicit extension matches only itself).
  await makeFolio({ extra: { 'zz.md': '# Shared\n', 'zz.markdown': '# Shared\n', 'README.md': '# Shared\n' } })
  const expected = await order()
  const added = await addFolioPieces(ws, DIR, { paths: [piece('glossary'), piece('zz')], expected })
  expect(added.result).toMatchObject({ ok: true, order: [...ABCD, piece('glossary'), piece('zz')] })
  expect(await read(INDEX)).toContain('- [[Glossary]]\n- [[./zz.md]]\n')
  expect((await readPlan(ws, DIR))?.parts.map((part) => part.path)).toEqual([...ABCD, piece('glossary'), piece('zz')])
})

test('Add all: a file no line can name is skipped and named; the rest go in and Undo takes back only them (Sol round 3)', async () => {
  // `x#1.md` headed `# Bad | title`: neither its title nor its path `./x#1` can be a running-order line.
  await makeFolio({ extra: { 'x#1.md': '# Bad | title\n' } })
  const odd = `${DIR}/x#1.md`
  expect((await readPlan(ws, DIR))?.unlisted.find((part) => part.path === odd)?.putBackRefusal).toMatch(/No running-order line can name this file/)
  const expected = await order()
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const alone = await addFolioPieces(ws, DIR, { paths: [odd], expected })
  expect(alone.result).toMatchObject({ ok: false, stale: false })
  expect(alone.result.ok ? '' : alone.result.message).toContain('“x#1.md” was not added')
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)

  const added = await addFolioPieces(ws, DIR, { paths: [piece('glossary'), odd], expected })
  expect(added.result).toMatchObject({ ok: true, order: [...ABCD, piece('glossary')], skipped: [odd] })
  expect(added.result.ok ? added.result.note : '').toContain('“x#1.md” was not added')
  expect(await read(MANIFEST)).not.toContain('x#1')
  expect((await readPlan(ws, DIR))?.parts.map((part) => part.path)).toEqual([...ABCD, piece('glossary')])
  const token = added.result.ok ? added.result.undoToken : undefined
  expect(token).toBeTruthy()
  expect((await removeAddedFolioPieces(ws, DIR, { token: token! })).result).toMatchObject({ ok: true })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('Add refuses a stale running order', async () => {
  await makeFolio()
  const seen = await order()
  await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: seen })
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: seen })
  expect(result).toMatchObject({ ok: false, stale: true })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('Undo of an Add and of Add all takes out exactly the added pieces, and both documents list the previous order again', async () => {
  await makeFolio()
  const bytes = [await read(MANIFEST), await read(INDEX)]
  const start = await order()
  const added = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: start })
  if (!added.result.ok) throw new Error(added.result.message)
  const one = await removeAddedFolioPieces(ws, DIR, { token: added.result.undoToken! })
  expect(one.result).toMatchObject({ ok: true, order: start })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  const both = [piece('glossary'), piece('snippets')]
  const addedBoth = await addFolioPieces(ws, DIR, { paths: both, expected: start })
  if (!addedBoth.result.ok) throw new Error(addedBoth.result.message)
  const undone = await removeAddedFolioPieces(ws, DIR, { token: addedBoth.result.undoToken! })
  expect(undone.result).toMatchObject({ ok: true, order: start })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
  expect(await read(`${DIR}/glossary.md`)).toBe('# Glossary\n')
})

test('Undo of an Add is refused when the running order changed since, and writes nothing', async () => {
  await makeFolio()
  const start = await order()
  const both = [piece('glossary'), piece('snippets')]
  const added = await addFolioPieces(ws, DIR, { paths: both, expected: start })
  if (!added.result.ok) throw new Error(added.result.message)
  const afterAdd = [...start, ...both]
  await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath: null, expected: afterAdd })
  const bytes = [await read(MANIFEST), await read(INDEX)]
  expect((await removeAddedFolioPieces(ws, DIR, { token: added.result.undoToken! })).result).toMatchObject({ ok: false, stale: true })
  expect([await read(MANIFEST), await read(INDEX)]).toEqual(bytes)
})

test('numbered Index Notes stay numbered after a move and after Undo (the order is restored; a 1,2,3 list comes back as it was)', async () => {
  await makeFolio({ index: '# Guide\n\n## Running order\n\n1. [[Alpha]]\n2. [[Beta]]\n3. [[Gamma]]\n4. [[Delta]]\n' })
  const bytes = await read(INDEX)
  const start = await order()
  await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: start })
  expect(await read(INDEX)).toContain('1. [[Gamma]]\n2. [[Alpha]]\n3. [[Beta]]\n4. [[Delta]]')
  await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('d'), expected: ['c', 'a', 'b', 'd'].map(piece) })
  expect(await read(INDEX)).toBe(bytes)
})

test('after a write the Folio outline reads the same running order the Outline will', async () => {
  await makeFolio()
  await moveFolioPiece(ws, DIR, { path: piece('b'), beforePath: null, expected: await order() })
  const plan = await readPlan(ws, DIR)
  expect(plan!.parts.map((part) => part.path)).toEqual(await order())
})

test('pure rules: resolveMove, successorOf, slot maths, labels', () => {
  const parts = ['a', 'b', null, 'c', 'd']
  expect(resolveMove(parts, 'd', 'a')).toEqual({ from: 4, to: 0 })
  expect(resolveMove(parts, 'a', 'c')).toEqual({ from: 0, to: 2 })
  expect(resolveMove(parts, 'a', null)).toEqual({ from: 0, to: 4 })
  expect(resolveMove(parts, 'a', 'a')).toEqual({ from: 0, to: 0 })
  expect(resolveMove(parts, 'zz', null)).toBeNull()
  expect(resolveMove(['a', 'b', 'a'], 'a', null)).toBeNull()
  expect(isInPlace(parts, 'b', 'b')).toBe(true)
  expect(isInPlace(['a', 'b', 'c'], 'b', 'c')).toBe(true)
  expect(isInPlace(['a', 'b', 'c'], 'c', null)).toBe(true)
  expect(successorOf(['a', 'b'], 'a')).toBe('b')
  expect(successorOf(['a', 'b'], 'b')).toBeNull()
  const boxes = [{ top: 0, bottom: 20 }, { top: 20, bottom: 100 }, { top: 100, bottom: 120 }]
  expect([-5, 5, 15, 25, 70, 99, 105, 119, 500].map((y) => slotAt(boxes, y))).toEqual([0, 0, 1, 1, 2, 2, 2, 3, 3])
  const list = ['a', 'b', 'c', 'd', 'e']
  expect(dropFor(list, 4, 1)).toEqual({ inPlace: false, beforePath: 'b', position: 2 })
  expect(dropFor(list, 0, 3)).toEqual({ inPlace: false, beforePath: 'd', position: 3 })
  expect(dropFor(list, 0, 5)).toEqual({ inPlace: false, beforePath: null, position: 5 })
  expect(dropFor(list, 2, 2)).toEqual({ inPlace: true })
  expect(dropFor(list, 2, 3)).toEqual({ inPlace: true })
  expect(dragLabel('Listen', 2, 9)).toBe('Move Listen to 2 of 9')
})

test('command targets: the focused row of the right kind, else the open file; first, last and non-addable say why', () => {
  const outline = {
    pieces: [{ path: 'p/a.md', title: 'Alpha' }, { path: 'p/b.md', title: 'Beta' }, { path: 'p/c.md', title: 'Gamma' }],
    also: [{ path: 'p/g.md', title: 'Glossary', addable: true }, { path: 'p/_i.md', title: 'Index', addable: false }],
  }
  expect(commandTarget('up', { path: 'p/b.md', kind: 'piece' }, 'p/c.md', outline)).toEqual({ path: 'p/b.md', title: 'Beta', beforePath: 'p/a.md' })
  expect(commandTarget('up', null, 'p/c.md', outline)).toEqual({ path: 'p/c.md', title: 'Gamma', beforePath: 'p/b.md' })
  expect(commandTarget('down', null, 'p/a.md', outline)).toEqual({ path: 'p/a.md', title: 'Alpha', beforePath: 'p/c.md' })
  expect(commandTarget('down', null, 'p/b.md', outline)).toEqual({ path: 'p/b.md', title: 'Beta', beforePath: null })
  expect(commandTarget('up', null, 'p/a.md', outline)).toEqual({ message: 'Alpha is already first in the running order.' })
  expect(commandTarget('down', null, 'p/c.md', outline)).toEqual({ message: 'Gamma is already last in the running order.' })
  expect(commandTarget('up', null, 'p/g.md', outline)).toHaveProperty('message')
  expect(commandTarget('add', { path: 'p/g.md', kind: 'also' }, 'p/a.md', outline)).toEqual({ path: 'p/g.md', title: 'Glossary', beforePath: null })
  expect(commandTarget('add', null, 'p/g.md', outline)).toMatchObject({ path: 'p/g.md' })
  expect(commandTarget('add', null, 'p/_i.md', outline)).toHaveProperty('message')
  expect(commandTarget('add', null, 'p/a.md', outline)).toHaveProperty('message')
})

test('announcement texts follow the spec', () => {
  expect(movedAnnouncement('Listen', 2, 9)).toBe('Listen moved to position 2 of 9.')
  expect(addedAnnouncement(['Snippets'], 10, 10)).toBe('Snippets added to the running order, position 10 of 10.')
  expect(addedAnnouncement(['a', 'b', 'c'], 10, 12)).toBe('3 pieces added to the running order.')
  expect(undoneAnnouncement('Listen', 5, 9)).toBe('Order restored. Listen is back at position 5 of 9.')
})

test('Undo of a move restores the ORDER, not the bytes: a sparsely numbered Index Note is renumbered by every Folio outline write', async () => {
  await makeFolio({ index: '# Guide\n\n## Running order\n\n10. [[Alpha]]\n20. [[Beta]]\n30. [[Gamma]]\n40. [[Delta]]\n' })
  const start = await order()
  const manifest = await read(MANIFEST)
  await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('a'), expected: start })
  const back = await moveFolioPiece(ws, DIR, { path: piece('c'), beforePath: piece('d'), expected: ['c', 'a', 'b', 'd'].map(piece) })
  expect(back.result).toMatchObject({ ok: true, order: start })
  expect(await read(MANIFEST)).toBe(manifest)
  expect(await read(INDEX)).toContain('10. [[Alpha]]\n11. [[Beta]]\n12. [[Gamma]]\n13. [[Delta]]')
})

test('Add from the resolved Folio read refuses left-out entries explicitly, without claiming stale order', async () => {
  for (const withIndex of [true, false]) {
    await makeFolio({ manifest: JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'missing.md' }] }) })
    if (!withIndex) await rm(join(root, INDEX))
    const seen = (await folioPieces(ws, DIR))!
    expect(seen.leftOut).toHaveLength(1)
    const before = await read(MANIFEST)
    const { result } = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: seen.pieces })
    expect(result).toMatchObject({ ok: false, stale: false })
    if (!result.ok) expect(result.message).toContain('Folio outline')
    expect(await read(MANIFEST)).toBe(before)
  }
})
