/**
 * The Outline's running-order routes refuse what they cannot do exactly, and write nothing when they
 * refuse: a stale running order (manifest or Index Note), a Folio the Plan must change, a file whose
 * title names another file, an Undo whose pieces are no longer the tail. Each test here fails when the
 * guard it names is taken out.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { folioPieces, MANIFEST_NAME } from '../../src/main/folio'
import { folioOutline } from '../../src/main/folio-outline'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { addFolioPieces, moveFolioPiece, removeAddedFolioPieces } from '../../src/main/folio-running-order'
import { MANIFEST_WOULD_NOT_FOLLOW, movePart, readPlan } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { OUTLINE_UNSAFE_MESSAGE, STALE_ORDER_MESSAGE } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'guide'
const INDEX = `${DIR}/_guide_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'writeflex-order-guards-'))
  ws = new Workspace(root)
  invalidateFolioPlaces(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const read = (path: string) => readFile(join(root, path), 'utf8')
const piece = (name: string) => `${DIR}/${name}.md`
const manifestOf = (paths: string[], contentRoot = ''): string =>
  ['{', '  "schema_version": 1,', `  "content_root": "${contentRoot}",`, '  "files": [', paths.map((path) => `    { "path": "${path}" }`).join(',\n'), '  ]', '}', ''].join('\n')
const indexOf = (titles: string[]): string => `# Guide\n\nIntro.\n\n## Running order\n\n${titles.map((title) => `- [[${title}]]`).join('\n')}\n`

async function makeFolio(opts: { manifest?: string | null; index?: string; extra?: Record<string, string> } = {}): Promise<void> {
  await mkdir(join(root, DIR), { recursive: true })
  const files: Record<string, string> = {
    'a.md': '# Alpha\n', 'b.md': '# Beta\n', 'c.md': '# Gamma\n', 'd.md': '# Delta\n',
    'glossary.md': '# Glossary\n', 'snippets.md': '# Snippets\n', ...opts.extra,
  }
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, DIR, name, '..'), { recursive: true })
    await writeFile(join(root, DIR, name), text)
  }
  if (opts.manifest !== null) await writeFile(join(root, MANIFEST), opts.manifest ?? manifestOf(['a.md', 'b.md', 'c.md', 'd.md']))
  await writeFile(join(root, INDEX), opts.index ?? indexOf(['Alpha', 'Beta', 'Gamma', 'Delta']))
  invalidateFolioPlaces(root)
}

const ABCD = ['a', 'b', 'c', 'd'].map(piece)
const bytesNow = async () => [await read(MANIFEST).catch(() => null), await read(INDEX)]

/** Run `change` just before the Nth read of the Index Note returns, so the read itself sees the change (a racing writer). */
function beforeIndexRead(nth: number, change: () => Promise<void>): () => void {
  const original = ws.readFile.bind(ws)
  let reads = 0
  ws.readFile = (async (path: string) => {
    if (path === INDEX && ++reads === nth) await change()
    return original(path)
  }) as typeof ws.readFile
  return () => { ws.readFile = original }
}

// ---- C: stale detection covers the manifest, on the first read and on the write's own read ----

test('C: a manifest-only reorder after the Outline read is refused as stale; both files stay byte-identical', async () => {
  await makeFolio()
  await writeFile(join(root, MANIFEST), manifestOf(['b.md', 'a.md', 'c.md', 'd.md']))
  const bytes = await bytesNow()
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: ABCD })
  expect(result).toEqual({ ok: false, stale: true, message: STALE_ORDER_MESSAGE })
  expect(await bytesNow()).toEqual(bytes)
  expect((await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })).result).toMatchObject({ ok: false, stale: true })
  expect(await bytesNow()).toEqual(bytes)
})

test('C: a manifest-only reorder between the route\'s read and the write\'s own read is refused; both files stay byte-identical', async () => {
  await makeFolio()
  let changed: (string | null)[] = []
  // Read 1 is the route's; read 2 is movePart's. The manifest is rewritten before read 2, so the write reads it changed.
  const restore = beforeIndexRead(2, async () => {
    await writeFile(join(root, MANIFEST), manifestOf(['b.md', 'a.md', 'c.md', 'd.md']))
    changed = await bytesNow()
  })
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: ABCD })
  restore()
  expect(changed.length).toBe(2)
  expect(result).toEqual({ ok: false, stale: true, message: STALE_ORDER_MESSAGE })
  expect(await bytesNow()).toEqual(changed)
})

test('C: an Index Note rewritten between the route\'s read and the write\'s own read is refused by the check on that read', async () => {
  await makeFolio()
  let changed: (string | null)[] = []
  // Both documents are reordered together, so the write's own byte comparisons all pass: only the check against `expected` can refuse.
  const restore = beforeIndexRead(2, async () => {
    await writeFile(join(root, MANIFEST), manifestOf(['b.md', 'a.md', 'c.md', 'd.md']))
    await writeFile(join(root, INDEX), indexOf(['Beta', 'Alpha', 'Gamma', 'Delta']))
    changed = await bytesNow()
  })
  const { result } = await moveFolioPiece(ws, DIR, { path: piece('d'), beforePath: piece('a'), expected: ABCD })
  restore()
  expect(changed.length).toBe(2)
  expect(result).toMatchObject({ ok: false, stale: true })
  expect(await bytesNow()).toEqual(changed)
})

// ---- D: Folios the Outline cannot change exactly ----

type Shape = { name: string; manifest: string | null; index: string; extra?: Record<string, string>; message?: string }
const SHAPES: Shape[] = [
  { name: 'another piece listed twice', manifest: manifestOf(['a.md', 'b.md', 'b.md', 'c.md']), index: indexOf(['Alpha', 'Beta', 'Beta', 'Gamma']) },
  { name: 'an entry whose file is missing', manifest: manifestOf(['a.md', 'missing.md', 'b.md']), index: indexOf(['Alpha', 'Beta']) },
  { name: 'an entry outside the Folio folder', manifest: manifestOf(['a.md', '../elsewhere.md', 'b.md', '../other.md', 'c.md']), index: indexOf(['Alpha', 'Beta', 'Gamma']) },
  { name: 'an Index Note that lists fewer pieces than the manifest', manifest: manifestOf(['a.md', 'b.md', 'c.md', 'd.md']), index: indexOf(['Alpha', 'Beta']) },
  { name: 'an Index Note in another order than the manifest', manifest: manifestOf(['a.md', 'b.md', 'c.md', 'd.md']), index: indexOf(['Beta', 'Alpha', 'Gamma', 'Delta']) },
  { name: 'a part with no file', manifest: manifestOf(['a.md', 'b.md', 'c.md']), index: indexOf(['Alpha', 'Beta', 'Not written yet', 'Gamma']) },
  { name: 'no manifest', manifest: null, index: indexOf(['Alpha', 'Beta', 'Gamma', 'Delta']), message: 'file names' },
]

for (const shape of SHAPES) {
  test(`D: ${shape.name}: move, Add and Undo of an Add are refused, nothing is written, and the Outline read says so`, async () => {
    await makeFolio({ manifest: shape.manifest, index: shape.index })
    const bytes = await bytesNow()
    // The order the Outline would have shown: the manifest's resolved pieces, or the file-name order without one.
    const expected = (await folioPieces(ws, DIR))?.pieces ?? ['a', 'b', 'c', 'd', 'glossary', 'snippets'].map(piece)
    const attempts = [
      await moveFolioPiece(ws, DIR, { path: piece('a'), beforePath: null, expected }),
      await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected }),
      await removeAddedFolioPieces(ws, DIR, { paths: [expected.at(-1)!], expected }),
    ]
    for (const { result, plan } of attempts) {
      expect(result).toMatchObject({ ok: false, stale: false })
      if (!result.ok) {
        if (shape.message) expect(result.message).toContain(shape.message)
        else expect(result.message).toBe(OUTLINE_UNSAFE_MESSAGE)
      }
      expect(plan).toBeNull()
    }
    expect(await bytesNow()).toEqual(bytes)
    const outline = await folioOutline(ws, piece('a'))
    expect(outline?.orderInPlanOnly).toBe(true)
    expect(outline?.also.filter((file) => file.addable)).toEqual([])
  })
}

test('D: a Folio the Outline can change carries no flag, and its addable files are the ones Add accepts', async () => {
  await makeFolio({ extra: { '_hidden.md': '# Hidden\n' } })
  const outline = await folioOutline(ws, piece('a'))
  expect(outline?.orderInPlanOnly).toBeUndefined()
  expect(outline?.also.filter((file) => file.addable).map((file) => file.path)).toEqual([piece('glossary'), piece('snippets')])
})

test('D: a Plan write that would change the Index Note and leave the manifest alone is refused before anything is written', async () => {
  // [a, b, b, c]: the Plan view moves `a` in the Index Note only (the manifest write is skipped for a Folio with a repeated part).
  await makeFolio({ manifest: manifestOf(['a.md', 'b.md', 'b.md', 'c.md']), index: indexOf(['Alpha', 'Beta', 'Beta', 'Gamma']) })
  const bytes = await bytesNow()
  await expect(movePart(ws, DIR, 0, 3, { requireManifestWrite: true })).rejects.toThrow(MANIFEST_WOULD_NOT_FOLLOW)
  expect(await bytesNow()).toEqual(bytes)
  // The Plan view's own write (no such option) is unchanged: it still writes the Index Note.
  await movePart(ws, DIR, 0, 3)
  expect(await read(INDEX)).toContain('- [[Beta]]\n- [[Beta]]\n- [[Gamma]]\n- [[Alpha]]')
  expect(await read(MANIFEST)).toBe(bytes[0]!)
})

// ---- E: Add adopts exactly the named file ----

test('E: a file that shares its title with another file is not added, and no other file is added in its place', async () => {
  await makeFolio({ extra: { 'z.md': '# Shared\n', 'README.md': '# Shared\n' } })
  const bytes = await bytesNow()
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('z')], expected: ABCD })
  expect(result).toEqual({ ok: false, stale: false, message: 'Two files here share the title "Shared". Rename one, or add it from the Plan.' })
  expect(await bytesNow()).toEqual(bytes)
  expect((await folioPieces(ws, DIR))!.pieces).toEqual(ABCD)
})

test('E: a content_root Folio: what the Outline marks addable is what Add accepts, and Add of a file in the content folder works', async () => {
  await makeFolio({
    manifest: manifestOf(['a.md', 'b.md'], 'chapters'),
    index: indexOf(['Alpha', 'Beta']),
    extra: { 'chapters/a.md': '# Alpha\n', 'chapters/b.md': '# Beta\n', 'chapters/extra.md': '# Extra\n', 'a.md': '# Loose A\n', 'b.md': '# Loose B\n', 'c.md': '# Loose C\n', 'd.md': '# Loose D\n' },
  })
  const expected = (await folioPieces(ws, DIR))!.pieces
  expect(expected).toEqual([`${DIR}/chapters/a.md`, `${DIR}/chapters/b.md`])
  const outline = (await folioOutline(ws, `${DIR}/chapters/a.md`))!
  expect(outline.orderInPlanOnly).toBeUndefined()
  // Every file the Outline lists under "Also in this folder": its addable mark is exactly whether Add accepts it.
  const bytes = await bytesNow()
  expect(outline.also.length).toBeGreaterThan(0)
  for (const file of outline.also) {
    const attempt = await addFolioPieces(ws, DIR, { paths: [file.path], expected })
    expect([file.path, attempt.result.ok]).toEqual([file.path, file.addable === true])
    if (attempt.result.ok) {
      const undone = await removeAddedFolioPieces(ws, DIR, { paths: [file.path], expected: [...expected, file.path] })
      expect(undone.result.ok).toBe(true)
    }
  }
  expect(await bytesNow()).toEqual(bytes)
  // The Plan's own unlisted file, in the content folder, is accepted.
  const plan = (await readPlan(ws, DIR))!
  expect(plan.unlisted.filter((part) => part.manifestBacked === false).map((part) => part.path)).toEqual([`${DIR}/chapters/extra.md`])
  const added = await addFolioPieces(ws, DIR, { paths: [`${DIR}/chapters/extra.md`], expected })
  expect(added.result).toEqual({ ok: true, changed: true, order: [...expected, `${DIR}/chapters/extra.md`] })
  expect((await folioPieces(ws, DIR))!.pieces).toEqual([...expected, `${DIR}/chapters/extra.md`])
  expect(await read(INDEX)).toContain('- [[Beta]]\n- [[Extra]]')
})

// ---- G: Undo of an Add ----

test('G: Undo of an Add refuses, before removing anything, when the pieces named are not the tail in the order they were added', async () => {
  await makeFolio()
  const both = [piece('glossary'), piece('snippets')]
  await addFolioPieces(ws, DIR, { paths: both, expected: ABCD })
  const after = [...ABCD, ...both]
  const bytes = await bytesNow()
  // The second case ends with the real last piece: only the check made before the first removal keeps it in.
  for (const paths of [[piece('snippets'), piece('glossary')], [piece('c'), piece('snippets')], [piece('glossary')], [piece('d'), piece('glossary')], [piece('c'), piece('d'), piece('glossary'), piece('snippets'), piece('a'), piece('b'), piece('zz')]]) {
    expect((await removeAddedFolioPieces(ws, DIR, { paths, expected: after })).result).toMatchObject({ ok: false, stale: true })
  }
  expect(await bytesNow()).toEqual(bytes)
})

test('G: an Undo that stops part-way says exactly which pieces were taken out and which remain, and the documents agree', async () => {
  await makeFolio()
  const three = [piece('glossary'), piece('snippets'), piece('e')]
  await writeFile(join(root, DIR, 'e.md'), '# Epsilon\n')
  await addFolioPieces(ws, DIR, { paths: three, expected: ABCD })
  const after = [...ABCD, ...three]
  // The second removal's manifest write fails (the first, of Epsilon, goes through).
  const original = ws.saveFileWithoutReadBack.bind(ws)
  let manifestWrites = 0
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === MANIFEST && ++manifestWrites === 2) throw new Error(`EACCES: permission denied, open '${join(root, MANIFEST)}'`)
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  const { result, plan } = await removeAddedFolioPieces(ws, DIR, { paths: three, expected: after })
  ws.saveFileWithoutReadBack = original
  expect(result.ok).toBe(false)
  if (result.ok) return
  expect(result.partial).toEqual({ removed: [piece('e')], remaining: [piece('glossary'), piece('snippets')], order: [...ABCD, piece('glossary'), piece('snippets')] })
  expect(result.message).toContain('Taken out again: Epsilon.')
  expect(result.message).toContain('Still in the running order: Glossary, Snippets.')
  expect(result.message).not.toContain(root)
  expect(plan).not.toBeNull()
  // The failed removal was rolled back: both documents list the same order, the one the answer names.
  expect((await folioPieces(ws, DIR))!.pieces).toEqual(result.partial!.order)
  expect((await readPlan(ws, DIR))!.parts.map((part) => part.path)).toEqual(result.partial!.order)
  // The remainder can then be undone with what the answer gave.
  const rest = await removeAddedFolioPieces(ws, DIR, { paths: result.partial!.remaining, expected: result.partial!.order })
  expect(rest.result).toEqual({ ok: true, changed: true, order: ABCD })
})
