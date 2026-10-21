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
    ]
    for (const { result, plan } of attempts) {
      expect(result).toMatchObject({ ok: false, stale: false })
      if (!result.ok) {
        if (shape.message) expect(result.message).toContain(shape.message)
        else expect(result.message).toBe(OUTLINE_UNSAFE_MESSAGE)
      }
      expect(plan).toBeNull()
    }
    // An Undo with no Add of its own behind it is refused as stale (folio-add-undo.ts).
    const undo = await removeAddedFolioPieces(ws, DIR, { token: 'no-such-add' })
    expect(undo.result).toMatchObject({ ok: false, stale: true })
    expect(undo.plan).toBeNull()
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

test('D: a Folio outline write that would change the Index Note and leave the manifest alone is refused before anything is written', async () => {
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

test('E: a file that shares its title with another file is added by its path, and no other file is added in its place', async () => {
  // Dominik 2026-10-20 ("just put both in and I will rename later"): reverses the earlier refusal.
  await makeFolio({ extra: { 'z.md': '# Shared\n', 'README.md': '# Shared\n' } })
  const { result } = await addFolioPieces(ws, DIR, { paths: [piece('z')], expected: ABCD })
  expect(result).toMatchObject({ ok: true, order: [...ABCD, piece('z')] })
  expect(await read(INDEX)).toContain('- [[./z]]')
  expect((await folioPieces(ws, DIR))!.pieces).toEqual([...ABCD, piece('z')])
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
  // Every file the Outline lists under "Not in the outline": its addable mark is exactly whether Add accepts it.
  const bytes = await bytesNow()
  expect(outline.also.length).toBeGreaterThan(0)
  for (const file of outline.also) {
    const attempt = await addFolioPieces(ws, DIR, { paths: [file.path], expected })
    expect([file.path, attempt.result.ok]).toEqual([file.path, file.addable === true])
    if (attempt.result.ok) {
      const undone = await removeAddedFolioPieces(ws, DIR, { token: attempt.result.undoToken! })
      expect(undone.result.ok).toBe(true)
    }
  }
  expect(await bytesNow()).toEqual(bytes)
  // The Plan's own unlisted file, in the content folder, is accepted.
  const plan = (await readPlan(ws, DIR))!
  expect(plan.unlisted.filter((part) => part.manifestBacked === false).map((part) => part.path)).toEqual([`${DIR}/chapters/extra.md`])
  const added = await addFolioPieces(ws, DIR, { paths: [`${DIR}/chapters/extra.md`], expected })
  expect(added.result).toMatchObject({ ok: true, changed: true, order: [...expected, `${DIR}/chapters/extra.md`] })
  expect((await folioPieces(ws, DIR))!.pieces).toEqual([...expected, `${DIR}/chapters/extra.md`])
  expect(await read(INDEX)).toContain('- [[Beta]]\n- [[Extra]]')
})

// ---- G: Undo of an Add ----

test('G: Undo of an earlier Add is refused once a later Add has changed the documents; the later one undoes, then the earlier one', async () => {
  await makeFolio()
  const first = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })
  if (!first.result.ok) throw new Error(first.result.message)
  const second = await addFolioPieces(ws, DIR, { paths: [piece('snippets')], expected: [...ABCD, piece('glossary')] })
  if (!second.result.ok) throw new Error(second.result.message)
  const bytes = await bytesNow()
  expect((await removeAddedFolioPieces(ws, DIR, { token: first.result.undoToken! })).result).toMatchObject({ ok: false, stale: true })
  expect(await bytesNow()).toEqual(bytes)
  expect((await removeAddedFolioPieces(ws, DIR, { token: second.result.undoToken! })).result).toMatchObject({ ok: true, order: [...ABCD, piece('glossary')] })
  expect((await removeAddedFolioPieces(ws, DIR, { token: first.result.undoToken! })).result).toMatchObject({ ok: true, order: ABCD })
  expect(await read(INDEX)).toBe(indexOf(['Alpha', 'Beta', 'Gamma', 'Delta']))
})

test('G: an Undo whose manifest cannot be written puts the Index Note back as the Add left it, says nothing was changed, and can be made again', async () => {
  await makeFolio()
  const three = [piece('glossary'), piece('snippets'), piece('e')]
  await writeFile(join(root, DIR, 'e.md'), '# Epsilon\n')
  const added = await addFolioPieces(ws, DIR, { paths: three, expected: ABCD })
  if (!added.result.ok) throw new Error(added.result.message)
  const bytes = await bytesNow()
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === MANIFEST) throw new Error(`EACCES: permission denied, open '${join(root, MANIFEST)}'`)
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  const { result } = await removeAddedFolioPieces(ws, DIR, { token: added.result.undoToken! })
  ws.saveFileWithoutReadBack = original
  expect(result).toMatchObject({ ok: false, stale: false })
  if (result.ok) return
  expect(result.message).toContain('Nothing was changed.')
  expect(result.message).not.toContain(root)
  expect(await bytesNow()).toEqual(bytes)
  // The record is kept: the Undo can be made again once the manifest can be written.
  expect((await removeAddedFolioPieces(ws, DIR, { token: added.result.undoToken! })).result).toMatchObject({ ok: true, order: ABCD })
})

test('G: an Undo whose rollback fails uses up its token: the documents put back by hand to what the Add left do not revive it', async () => {
  await makeFolio()
  const added = await addFolioPieces(ws, DIR, { paths: [piece('glossary')], expected: ABCD })
  if (!added.result.ok) throw new Error(added.result.message)
  const [manifestAfter, indexAfter] = await bytesNow()
  const original = ws.saveFileWithoutReadBack.bind(ws)
  let indexWrites = 0
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === MANIFEST) throw new Error('manifest cannot be written')
    // The first Index write is the Undo's own; the second is its take-back, which fails: a split state.
    if (path === INDEX && ++indexWrites === 2) throw new Error('Index Note cannot be put back')
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  const { result } = await removeAddedFolioPieces(ws, DIR, { token: added.result.undoToken! })
  ws.saveFileWithoutReadBack = original
  expect(result).toMatchObject({ ok: false, stale: false })
  expect(await read(INDEX)).not.toBe(indexAfter)
  expect(await read(MANIFEST)).toBe(manifestAfter!)
  // Put back by hand to exactly what the Add left: the token is still used up.
  await writeFile(join(root, INDEX), indexAfter!)
  expect((await removeAddedFolioPieces(ws, DIR, { token: added.result.undoToken! })).result).toMatchObject({ ok: false, stale: true })
  expect(await bytesNow()).toEqual([manifestAfter, indexAfter])
})
