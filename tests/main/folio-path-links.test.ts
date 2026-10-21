/**
 * Sol rounds 2 and 3 (2026-10-20): path links in a Folio's running order.
 * - A title a running-order line cannot hold (`# Has # punctuation`) goes in by its path; page and sidebar agree.
 * - A path link has one form: its target starts with `./` (`[[./contents/a]]`), read from the note's own folder. It
 *   names that file or nothing, never a title or alias, so another file's title cannot take it over. Every other
 *   link, with a `/` or without, resolves exactly as before path links (round 3: no path step for them).
 * - Exact: an explicit extension matches only itself; two extension variants of a bare path, or two case variants
 *   with no exact one, name nothing.
 * - The editor and the page resolve a `./` link among the same files: every file in the folder, listed or not.
 * - Add all's Undo removes an Index Note the Add created only while its bytes are exactly what the Add wrote.
 * - The sidebar offers Add only for a file the resulting order can name; Add refuses one it cannot, by name.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { folioOutline } from '../../src/main/folio-outline'
import { folioOrderFacts } from '../../src/main/folio-order-facts'
import { addFolioPieces } from '../../src/main/folio-running-order'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import { forgetAddUndoRecords, readFolioDocuments, recordAdd, undoRecordedAdd } from '../../src/main/folio-add-undo'
import { readFolioPlan } from '../../src/main/plan'
import { registerPlanIpcHandlers, type PlanIpcHandler } from '../../src/main/plan-ipc'
import { buildWikilinkCandidateIndex, collectionLinks, resolveWikilinkTargetFromIndex, type Candidate } from '../../src/main/wikilinks'
import { Workspace } from '../../src/main/workspace'
import { STALE_UNDO_MESSAGE } from '../../src/shared/folio-running-order'

let root: string
let ws: Workspace
const DIR = 'book'
const INDEX = `${DIR}/_book_INDEX.md`
const MANIFEST = `${DIR}/${MANIFEST_NAME}`
const A = `${DIR}/contents/a.md`
const B = `${DIR}/contents/b.md`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-path-links-'))
  ws = new Workspace(root)
  forgetAddUndoRecords()
  fresh()
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const fresh = (): void => { invalidateFolioPlaces(root); invalidateFolioOrderFacts(root) }
const read = (rel: string) => readFile(join(root, rel), 'utf8')
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

function harness() {
  const handlers = new Map<string, PlanIpcHandler>()
  registerPlanIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    stateForSender: () => ({ workspace: ws }),
    requireWorkspace: (state) => state.workspace,
    checkpointFile: async () => undefined,
    notifyCollectionChanged: () => undefined,
    notifyChangedOnDisk: () => undefined,
  })
  return (channel: string, input: unknown) => handlers.get(channel)!({ sender: { id: 1 } }, input)
}

async function surfaces(open: string) {
  fresh()
  const plan = await readFolioPlan(ws, DIR)
  const outline = await folioOutline(ws, open)
  return {
    plan,
    pageOrder: plan?.parts.map((part) => part.path) ?? null,
    pageNotIn: (plan?.unlisted ?? []).map((part) => part.path),
    sidebarOrder: outline?.pieces.map((piece) => piece.path) ?? null,
    sidebarNotIn: (outline?.also ?? []).map((file) => file.path),
  }
}

async function manifestFolio(files: string[], index: string | null): Promise<void> {
  await write(MANIFEST, JSON.stringify({ schema_version: 1, content_root: 'contents', files: files.map((path) => ({ path })) }, null, 2))
  if (index !== null) await write(INDEX, index)
}

// ---- 1. A title a line cannot hold goes in by path ----

for (const index of [null, '# book\n']) {
  test(`a title a running-order line cannot hold goes in by its path; page and sidebar agree (${index === null ? 'no Index Note' : 'Index Note with no order'})`, async () => {
    await write(A, '# Has # punctuation\n\nA.\n')
    await write(B, '# Plain\n\nB.\n')
    await manifestFolio(['a.md', 'b.md'], index)
    const seen = await surfaces(A)
    expect(seen.pageOrder).toEqual([A, B])
    expect(seen.sidebarOrder).toEqual([A, B])
    expect(seen.pageNotIn).not.toContain(A)
    expect(seen.sidebarNotIn).not.toContain(A)
    expect(seen.plan?.parts.map((part) => part.title)).toEqual(['./contents/a', 'Plain'])
    // The first page change writes that line by path.
    const invoke = harness()
    await invoke('plan:move-part', { dir: DIR, from: 1, to: 0 })
    expect(await read(INDEX)).toContain('- [[Plain]]\n- [[./contents/a]]\n')
    const after = await surfaces(B)
    expect(after.pageOrder).toEqual([B, A])
    expect(after.sidebarOrder).toEqual([B, A])
  })
}

test('an entry no line can name (its title and its path both unholdable) is out of the order on both surfaces alike', async () => {
  const odd = `${DIR}/contents/x#1.md`
  await write(odd, '# Bad | title\n')
  await write(B, '# Plain\n')
  await manifestFolio(['x#1.md', 'b.md'], null)
  const seen = await surfaces(B)
  expect(seen.pageOrder).toEqual([B])
  expect(seen.sidebarOrder).toEqual([B])
  expect(seen.pageNotIn).toContain(odd)
  expect(seen.sidebarNotIn).toContain(odd)
})

// ---- 3. Path first ----

test('a path link names its file first: another file retitled to that path does not take it over', async () => {
  await write(A, '# Same\n\nA.\n')
  await write(B, '# Same\n\nB.\n')
  await manifestFolio(['a.md', 'b.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/b]]\n')
  await write(B, '# ./contents/a\n\nB.\n')
  const seen = await surfaces(A)
  expect(seen.pageOrder).toEqual([A, B])
  expect(seen.pageNotIn).not.toContain(A)
  expect(seen.sidebarOrder).toEqual([A, B])
})

const piece = (path: string, title: string, aliases: string[] = []): Candidate => ({
  path,
  title,
  basename: path.split('/').at(-1)!.replace(/\.md$/, ''),
  aliases,
})

test('path resolution: only ./ targets, from the note\'s folder, with or without .md, never outside the scope', () => {
  const index = buildWikilinkCandidateIndex([
    piece('book/contents/a.md', 'Alpha'),
    piece('book/b.md', 'contents/a', ['./b-alias']),
    piece('other/c.md', 'Gamma'),
    piece('book/contents/sub/d.md', 'Delta'),
  ])
  const from = 'book/_book_INDEX.md'
  expect(resolveWikilinkTargetFromIndex(from, './contents/a', index)).toEqual({ to: 'book/contents/a.md' })
  expect(resolveWikilinkTargetFromIndex(from, './contents/a.md', index).to).toBe('book/contents/a.md')
  expect(resolveWikilinkTargetFromIndex(from, './CONTENTS/A', index).to).toBe('book/contents/a.md')
  expect(resolveWikilinkTargetFromIndex(from, './b', index).to).toBe('book/b.md')
  expect(resolveWikilinkTargetFromIndex(from, './contents/sub/d', index).to).toBe('book/contents/sub/d.md')
  expect(resolveWikilinkTargetFromIndex('book/contents/x.md', './sub/d', index).to).toBe('book/contents/sub/d.md')
  // Without `./` a slash target is a title link, as it always was: `contents/a` is book/b.md's title.
  expect(resolveWikilinkTargetFromIndex(from, 'contents/a', index).to).toBe('book/b.md')
  expect(resolveWikilinkTargetFromIndex('book/contents/x.md', 'sub/d', index).to).toBe(null)
  // A `./` target names a file by path or nothing: never a title or alias.
  expect(resolveWikilinkTargetFromIndex(from, './b-alias', index)).toEqual({ to: null })
  expect(resolveWikilinkTargetFromIndex(from, './Alpha', index)).toEqual({ to: null })
  // Out of the folder, absolute, backslashed, or out of the scope: never a path match.
  expect(resolveWikilinkTargetFromIndex(from, './../other/c', index).to).toBe(null)
  expect(resolveWikilinkTargetFromIndex(from, '../other/c', index).to).toBe(null)
  expect(resolveWikilinkTargetFromIndex(from, '/book/contents/a', index).to).toBe(null)
  expect(resolveWikilinkTargetFromIndex(from, '.\\contents\\a', index).to).toBe(null)
  expect(resolveWikilinkTargetFromIndex(from, './contents/a', index, { within: 'other' }).to).toBe(null)
  expect(resolveWikilinkTargetFromIndex(from, './contents/a', index, { within: 'book' }).to).toBe('book/contents/a.md')
})

test('path links are exact: an explicit extension matches only itself; extension or case variants never pick silently', () => {
  const from = 'book/_book_INDEX.md'
  const variants = buildWikilinkCandidateIndex([piece('book/contents/a.md', 'A1'), piece('book/contents/a.mdx', 'A2')])
  expect(resolveWikilinkTargetFromIndex(from, './contents/a.mdx', variants)).toEqual({ to: 'book/contents/a.mdx' })
  expect(resolveWikilinkTargetFromIndex(from, './contents/a.md', variants)).toEqual({ to: 'book/contents/a.md' })
  expect(resolveWikilinkTargetFromIndex(from, './contents/a.markdown', variants)).toEqual({ to: null })
  // Two extension variants of the bare path: ambiguous, so nothing (never the first sorted).
  expect(resolveWikilinkTargetFromIndex(from, './contents/a', variants)).toEqual({ to: null })

  const cases = buildWikilinkCandidateIndex([piece('book/contents/A.md', 'Upper'), piece('book/contents/a.md', 'Lower')])
  expect(resolveWikilinkTargetFromIndex(from, './contents/a.md', cases)).toEqual({ to: 'book/contents/a.md' })
  expect(resolveWikilinkTargetFromIndex(from, './contents/A.md', cases)).toEqual({ to: 'book/contents/A.md' })
  expect(resolveWikilinkTargetFromIndex(from, './contents/a', cases)).toEqual({ to: 'book/contents/a.md' })
  // No exact-case match and two case-folded ones: nothing.
  expect(resolveWikilinkTargetFromIndex(from, './CONTENTS/A.MD', cases)).toEqual({ to: null })
  // One case-folded candidate alone is used.
  const single = buildWikilinkCandidateIndex([piece('book/contents/a.md', 'Lower')])
  expect(resolveWikilinkTargetFromIndex(from, './Contents/A.MD', single)).toEqual({ to: 'book/contents/a.md' })
})

/** Wikilink resolution as it was on next/0.26 before path links: title, then file name, then alias, nearest first. */
function resolveBeforePathLinks(from: string, target: string, pieces: Candidate[]): { to: string | null; ambiguous?: string[] } {
  const key = (value: string): string => value.replace(/\.(?:md|markdown|mdx)$/i, '').toLocaleLowerCase()
  const wanted = key(target)
  const depth = (path: string): string[] => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')).split('/') : [])
  const distance = (a: string, b: string): number => {
    const left = depth(a)
    const right = depth(b)
    let common = 0
    while (common < left.length && common < right.length && left[common] === right[common]) common += 1
    return left.length - common + right.length - common
  }
  const tiers = [
    pieces.filter((p) => key(p.title) === wanted),
    pieces.filter((p) => key(p.basename) === wanted),
    pieces.filter((p) => p.aliases.some((alias) => key(alias) === wanted)),
  ]
  const matches = tiers.find((tier) => tier.length > 0) ?? []
  if (!matches.length) return { to: null }
  const ordered = [...matches].sort((a, b) => distance(from, a.path) - distance(from, b.path) || a.path.localeCompare(b.path))
  return { to: ordered[0].path, ...(ordered.length > 1 ? { ambiguous: ordered.map((p) => p.path) } : {}) }
}

test('a link with a slash and no ./ resolves exactly as before path links (Sol round 3 finding 2)', async () => {
  const pieces = [
    piece('book/original.md', 'sub/target'),
    piece('book/sub/target.md', 'Unrelated'),
    piece('book/contents/a.md', 'Either/Or', ['x/y']),
    piece('book/contents/b.md', 'contents/a'),
    piece('book/contents/sub/c.md', 'Gamma'),
  ]
  const index = buildWikilinkCandidateIndex(pieces)
  for (const from of ['book/_book_INDEX.md', 'book/contents/note.md']) {
    for (const target of ['sub/target', 'sub/target.md', 'Either/Or', 'x/y', 'contents/a', 'contents/b', 'sub/c', 'contents/sub/c', 'a/b/c']) {
      expect([target, resolveWikilinkTargetFromIndex(from, target, index)]).toEqual([target, resolveBeforePathLinks(from, target, pieces)])
    }
  }

  // The review's case on disk: `[[sub/target]]` names the file titled `sub/target`, in the editor and on the page,
  // although an unlisted `sub/target.md` (titled "Unrelated") sits at that path.
  await write(`${DIR}/original.md`, '# sub/target\n')
  await write(`${DIR}/sub/target.md`, '# Unrelated\n')
  await write(MANIFEST, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'original.md' }] }, null, 2))
  await write(INDEX, '# book\n\n## Running order\n\n- [[sub/target]]\n')
  fresh()
  const page = await readFolioPlan(ws, DIR)
  expect(page?.parts.map((part) => part.path)).toEqual([`${DIR}/original.md`])
  const editor = (await collectionLinks(ws, DIR)).filter((link) => link.from === INDEX)
  expect(editor.map((link) => link.to)).toEqual([`${DIR}/original.md`])
})

test('editor and page resolve the same ./ link to the same file, listed or not', async () => {
  await write(A, '# Alpha\n')
  await write(`${DIR}/contents/deep/c.md`, '# Gamma\n')
  await write(`${DIR}/notes.md`, '# Notes\n')
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/deep/c]]\n- [[./notes]]\n- [[./contents/missing]]\n')
  fresh()
  const page = await readFolioPlan(ws, DIR)
  const editor = (await collectionLinks(ws, DIR)).filter((link) => link.from === INDEX)
  expect(page?.parts.map((part) => part.path)).toEqual([A, `${DIR}/contents/deep/c.md`, `${DIR}/notes.md`, null])
  expect(editor.map((link) => link.to)).toEqual(page!.parts.map((part) => part.path))
})

test('title links without a slash resolve exactly as before (title, then file name, then alias, nearest first)', () => {
  const pieces = [
    piece('book/contents/a.md', 'Alpha', ['First']),
    piece('book/contents/alpha.md', 'Other'),
    piece('book/b.md', 'Beta'),
    piece('book/contents/beta.md', 'Beta'),
    piece('book/contents/sub/c.md', 'Gamma', ['Alpha']),
  ]
  const index = buildWikilinkCandidateIndex(pieces)
  const from = 'book/_book_INDEX.md'
  expect(resolveWikilinkTargetFromIndex(from, 'Alpha', index)).toEqual({ to: 'book/contents/a.md' })
  expect(resolveWikilinkTargetFromIndex(from, 'alpha.md', index)).toEqual({ to: 'book/contents/a.md' })
  expect(resolveWikilinkTargetFromIndex(from, 'Beta', index)).toEqual({ to: 'book/b.md', ambiguous: ['book/b.md', 'book/contents/beta.md'] })
  expect(resolveWikilinkTargetFromIndex(from, 'First', index)).toEqual({ to: 'book/contents/a.md' })
  expect(resolveWikilinkTargetFromIndex(from, 'c', index)).toEqual({ to: 'book/contents/sub/c.md' })
  expect(resolveWikilinkTargetFromIndex(from, 'Nothing', index)).toEqual({ to: null })
})

test('a slash title with no file at that path still resolves by title', () => {
  const index = buildWikilinkCandidateIndex([piece('book/contents/a.md', 'Either/Or')])
  expect(resolveWikilinkTargetFromIndex('book/_book_INDEX.md', 'Either/Or', index).to).toBe('book/contents/a.md')
})

// ---- 4. The editor's links ----

test('generated path links in the Index Note are live links in the editor', async () => {
  await write(A, '# Same\n\nA.\n')
  await write(B, '# Same\n\nB.\n')
  await manifestFolio(['a.md', 'b.md'], '# book\n\n## Running order\n\n- [[./contents/a]]\n- [[./contents/b]]\n')
  const links = (await collectionLinks(ws, DIR)).filter((link) => link.from === INDEX)
  expect(links.map((link) => [link.target, link.to])).toEqual([['./contents/a', A], ['./contents/b', B]])
})

// ---- 2. Add all's Undo and a created Index Note ----

test('Add all on a Folio with no Index Note writes the manifest only and never creates the Index Note; its Undo restores the manifest', async () => {
  await write(A, '# Alpha\n')
  await write(B, '# Beta\n')
  await manifestFolio(['a.md'], null)
  const manifest = await read(MANIFEST)
  const invoke = harness()
  const added = await invoke('plan:add-parts', { dir: DIR, paths: [B], expected: [{ title: 'Alpha', path: A }] }) as { ok: boolean; undoToken?: string }
  expect(added.ok).toBe(true)
  expect(existsSync(join(root, INDEX))).toBe(false)
  const undone = await invoke('plan:remove-added', { dir: DIR, token: added.undoToken }) as { ok: boolean }
  expect(undone.ok).toBe(true)
  expect(await read(MANIFEST)).toBe(manifest)
  expect(existsSync(join(root, INDEX))).toBe(false)
})

test('an Add Undo removes an Index Note the Add created only while it holds exactly what the Add wrote; otherwise it refuses and changes nothing', async () => {
  await write(A, '# Alpha\n')
  await manifestFolio(['a.md'], null)
  const before = readFolioDocuments(ws, DIR)
  await write(INDEX, '# book\n\n## Running order\n\n- [[Alpha]]\n')
  const after = readFolioDocuments(ws, DIR)
  const edited = recordAdd(ws, DIR, before, after)!
  await write(INDEX, '# book\n\n## Running order\n\n- [[Alpha]]\n\nMy own note.\n')
  const refused = await undoRecordedAdd(ws, DIR, edited)
  expect(refused).toEqual({ ok: false, stale: true, message: STALE_UNDO_MESSAGE })
  expect(await read(INDEX)).toBe('# book\n\n## Running order\n\n- [[Alpha]]\n\nMy own note.\n')

  await write(INDEX, '# book\n\n## Running order\n\n- [[Alpha]]\n')
  const kept = recordAdd(ws, DIR, before, readFolioDocuments(ws, DIR))!
  const undone = await undoRecordedAdd(ws, DIR, kept)
  expect(undone.ok).toBe(true)
  expect(existsSync(join(root, INDEX))).toBe(false)
})

// ---- 5. Sidebar Add only for a file the resulting order can name (Sol round 3 finding 1) ----

test('a manifest-only Folio: a file no line can name is not offered, and Add refuses it by name; Add all adds the rest', async () => {
  const odd = `${DIR}/contents/x#1.md`
  await write(A, '# Alpha\n')
  await write(odd, '# Bad | title\n')
  await write(B, '# Beta\n')
  await manifestFolio(['a.md'], null)
  fresh()
  const facts = await folioOrderFacts(ws, DIR)
  expect(facts.changeable).toBe(true)
  expect(facts.addable).toEqual([B])
  const outline = await folioOutline(ws, A)
  expect(outline?.also.find((file) => file.path === odd)?.addable).toBe(false)
  expect(outline?.also.find((file) => file.path === B)?.addable).toBe(true)

  const manifest = await read(MANIFEST)
  const alone = await addFolioPieces(ws, DIR, { paths: [odd], expected: [A] })
  expect(alone.result).toMatchObject({ ok: false, stale: false })
  expect(alone.result.ok ? '' : alone.result.message).toContain('“x#1.md” was not added')
  expect(await read(MANIFEST)).toBe(manifest)

  const invoke = harness()
  const added = await invoke('plan:add-parts', { dir: DIR, paths: [B, odd], expected: [{ title: 'Alpha', path: A }] }) as { ok: boolean; skipped?: string[]; note?: string; undoToken?: string; parts?: Array<{ path: string }> }
  expect(added.ok).toBe(true)
  expect(added.skipped).toEqual([odd])
  expect(added.note).toContain('“x#1.md” was not added')
  expect(added.parts?.map((part) => part.path)).toEqual([A, B])
  expect(await read(MANIFEST)).not.toContain('x#1')
  // What Add said is what both surfaces show after a refresh.
  const seen = await surfaces(A)
  expect(seen.pageOrder).toEqual([A, B])
  expect(seen.sidebarOrder).toEqual([A, B])
  expect(seen.sidebarNotIn).toContain(odd)
  expect(seen.pageNotIn).toContain(odd)
  // Undo takes back only what was added.
  const undone = await invoke('plan:remove-added', { dir: DIR, token: added.undoToken }) as { ok: boolean }
  expect(undone.ok).toBe(true)
  expect(await read(MANIFEST)).toBe(manifest)
})

test('a manifest-only Folio: a file whose title a line cannot hold is offered, and once added shows on both surfaces', async () => {
  const odd = `${DIR}/contents/odd.md`
  await write(A, '# Alpha\n')
  await write(odd, '# Bad | title\n')
  await manifestFolio(['a.md'], null)
  fresh()
  expect((await folioOrderFacts(ws, DIR)).addable).toEqual([odd])
  const added = await addFolioPieces(ws, DIR, { paths: [odd], expected: [A] })
  expect(added.result).toMatchObject({ ok: true })
  const seen = await surfaces(A)
  expect(seen.pageOrder).toEqual([A, odd])
  expect(seen.sidebarOrder).toEqual([A, odd])
  expect(seen.plan?.parts.map((part) => part.title)).toEqual(['Alpha', './contents/odd'])
})

test('a Folio with an Index Note: a file no line can name is not offered and its Put back is refused', async () => {
  const odd = `${DIR}/contents/x#1.md`
  await write(A, '# Alpha\n')
  await write(odd, '# Bad | title\n')
  await manifestFolio(['a.md'], '# book\n\n## Running order\n\n- [[Alpha]]\n')
  fresh()
  expect((await folioOrderFacts(ws, DIR)).addable).toEqual([])
  const plan = await readFolioPlan(ws, DIR)
  expect(plan?.unlisted.find((part) => part.path === odd)?.putBackRefusal).toMatch(/No running-order line can name this file/)
  const index = await read(INDEX)
  const alone = await addFolioPieces(ws, DIR, { paths: [odd], expected: [A] })
  expect(alone.result.ok ? '' : alone.result.message).toContain('“x#1.md” was not added')
  expect(await read(INDEX)).toBe(index)
})
