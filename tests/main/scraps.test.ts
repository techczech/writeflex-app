import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { ScrapStore, parseScrapsFile, serializeBlocks, type Scrap } from '../../src/main/scraps'

let root: string
let ws: Workspace
let store: ScrapStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-scraps-'))
  ws = new Workspace(root)
  store = new ScrapStore(ws)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const scrapsFile = (stem: string): string => join(root, 'scraps', `${stem}-SCRAPS.md`)
/** The per-origin-folder location: `<dir>/scraps/<stem>-SCRAPS.md`. */
const scrapsFileIn = (dir: string, stem: string): string => join(root, dir, 'scraps', `${stem}-SCRAPS.md`)

// ---- pure parse/serialise ----------------------------------------------------------------------

test('parse/serialise round-trips a file byte-for-byte', () => {
  const content =
    '## s_a\nCut from §2 — the aside.\n\n## s_b [x]\nCheck the quotes.\n\n## s_c {mwcb} (#b97d10)\nMetaphors We Compute By\n'
  expect(serializeBlocks(parseScrapsFile(content))).toBe(content)
})

test('parse reads every flag; an edit rewrites only the owned heading line', () => {
  const content = '## s_a {trig} (#3b6db5)\nbody one\n\n## s_b [x]\nbody two\n'
  const blocks = parseScrapsFile(content)
  const scraps = blocks.filter((b) => b.kind === 'scrap')
  expect(scraps).toHaveLength(2)
  const a = blocks[0]
  const b = blocks[1]
  if (a.kind !== 'scrap' || b.kind !== 'scrap') throw new Error('expected two scrap blocks')
  expect(a.trigger).toBe('trig')
  expect(a.colour).toBe('#3b6db5')
  expect(a.done).toBe(false)
  expect(b.done).toBe(true)
  // Edit only A's flags → B's section must remain byte-identical.
  a.done = true
  a.dirty = true
  const out = serializeBlocks(blocks)
  expect(out).toContain('## s_a [x] {trig} (#3b6db5)')
  expect(out).toContain('## s_b [x]\nbody two\n')
})

test('a foreign ## heading and preamble are not parsed as scraps', () => {
  const content = 'A note I typed at the top.\n\n## My own heading\nnot a scrap\n\n## s_a\nreal scrap\n'
  const blocks = parseScrapsFile(content)
  expect(blocks.filter((b) => b.kind === 'scrap')).toHaveLength(1)
  expect(serializeBlocks(blocks)).toBe(content) // preserved verbatim
})

// ---- store round-trip on disk ------------------------------------------------------------------

test('add creates scraps/<origin>-SCRAPS.md on first cut and lists it grouped by origin', async () => {
  expect(existsSync(join(root, 'scraps'))).toBe(false)
  const scrap = await store.add('essay.md', 'Cut from §2 — the machine-translation aside.')
  expect(scrap.origin).toBe('essay.md')
  expect(scrap.done).toBe(false)
  expect(existsSync(scrapsFile('essay'))).toBe(true)
  const onDisk = await readFile(scrapsFile('essay'), 'utf8')
  expect(onDisk).toContain(`## ${scrap.id}`)
  expect(onDisk).toContain('Cut from §2 — the machine-translation aside.')

  const listed = await store.list()
  expect(listed).toHaveLength(1)
  expect(listed[0].text).toBe('Cut from §2 — the machine-translation aside.')
  expect(listed[0].origin).toBe('essay.md')
})

test('add places the scraps file in a scraps/ subfolder beside the origin, keeping the full-path origin', async () => {
  const scrap = await store.add('notes/lakoff-quotes.md', 'Ask the agent to check all quotes.')
  expect(existsSync(scrapsFileIn('notes', 'lakoff-quotes'))).toBe(true) // beside the origin (ADR-0008)
  expect(existsSync(scrapsFile('lakoff-quotes'))).toBe(false) // NOT at the workspace root
  expect(scrap.origin).toBe('notes/lakoff-quotes.md')
  expect((await store.list())[0].origin).toBe('notes/lakoff-quotes.md')
})

// ---- serialised writes + per-folder location (fix wave 1) --------------------------------------

test('concurrent add() calls to one origin all land — serialised writes, no lost cut', async () => {
  const N = 12
  await Promise.all(Array.from({ length: N }, (_, i) => store.add('essay.md', `cut ${i}`)))
  const listed = await store.list()
  expect(listed).toHaveLength(N) // an unguarded read-modify-write would have clobbered most of these
  expect(new Set(listed.map((s) => s.text))).toEqual(new Set(Array.from({ length: N }, (_, i) => `cut ${i}`)))
  expect(new Set(listed.map((s) => s.id)).size).toBe(N) // ids distinct on disk too
})

test('concurrent toggleDone + setColour on two siblings both land, neither clobbering the other', async () => {
  const a = await store.add('essay.md', 'first')
  const b = await store.add('essay.md', 'second')
  await Promise.all([store.toggleDone(a.id), store.setColour(b.id, '#b97d10')])
  const listed = await store.list()
  const la = listed.find((s) => s.id === a.id) as Scrap
  const lb = listed.find((s) => s.id === b.id) as Scrap
  expect(la.done).toBe(true)
  expect(lb.colour).toBe('#b97d10')
  expect(la.colour).toBeUndefined() // the other flag on each sibling is untouched
  expect(lb.done).toBe(false)
})

test('same-basename origins in different folders get distinct files and groups (collision killed)', async () => {
  const a = await store.add('a/notes.md', 'from A')
  const b = await store.add('b/notes.md', 'from B')
  expect(a.origin).toBe('a/notes.md')
  expect(b.origin).toBe('b/notes.md')
  expect(existsSync(scrapsFileIn('a', 'notes'))).toBe(true)
  expect(existsSync(scrapsFileIn('b', 'notes'))).toBe(true)
  const listed = await store.list()
  expect(listed).toHaveLength(2)
  expect(new Set(listed.map((s) => s.origin))).toEqual(new Set(['a/notes.md', 'b/notes.md']))
  expect(await readFile(scrapsFileIn('a', 'notes'), 'utf8')).toContain('from A')
  expect(await readFile(scrapsFileIn('a', 'notes'), 'utf8')).not.toContain('from B') // no cross-contamination
  // Scoped list is path-precise, not basename-collided.
  expect((await store.list({ origin: 'a/notes.md' })).map((s) => s.text)).toEqual(['from A'])
})

test('add appends without disturbing an existing scrap or a foreign preamble', async () => {
  await mkdir(join(root, 'scraps'), { recursive: true })
  await writeFile(scrapsFile('essay'), '<!-- my notes -->\n\n## s_keep\nfirst cutting\n', 'utf8')
  const added = await store.add('essay.md', 'second cutting')
  const onDisk = await readFile(scrapsFile('essay'), 'utf8')
  expect(onDisk.startsWith('<!-- my notes -->\n\n## s_keep\nfirst cutting\n')).toBe(true)
  expect(onDisk).toContain(`## ${added.id}`)
  expect(onDisk).toContain('second cutting')
  const listed = await store.list()
  expect(listed.map((s) => s.text)).toEqual(['first cutting', 'second cutting'])
})

test('toggleDone flips [x] on disk and back', async () => {
  const scrap = await store.add('essay.md', 'a cutting')
  await store.toggleDone(scrap.id)
  expect(await readFile(scrapsFile('essay'), 'utf8')).toContain(`## ${scrap.id} [x]`)
  expect((await store.list())[0].done).toBe(true)
  await store.toggleDone(scrap.id)
  expect(await readFile(scrapsFile('essay'), 'utf8')).not.toContain('[x]')
  expect((await store.list())[0].done).toBe(false)
})

test('setColour writes and clears the (colour) mark; toggleDone leaves a sibling untouched', async () => {
  const a = await store.add('essay.md', 'first')
  const b = await store.add('essay.md', 'second')
  await store.setColour(a.id, '#b97d10')
  expect(await readFile(scrapsFile('essay'), 'utf8')).toContain(`## ${a.id} (#b97d10)`)
  // Editing A must not touch B's section.
  await store.toggleDone(a.id)
  const onDisk = await readFile(scrapsFile('essay'), 'utf8')
  expect(onDisk).toContain(`## ${b.id}\nsecond\n`)
  const listedA = (await store.list()).find((s) => s.id === a.id) as Scrap
  expect(listedA.colour).toBe('#b97d10')
  expect(listedA.done).toBe(true)
  await store.setColour(a.id, null)
  expect((await store.list()).find((s) => s.id === a.id)?.colour).toBeUndefined()
})

test('setColour rejects a heading-breaking colour so the scrap can never be orphaned', async () => {
  const a = await store.add('essay.md', 'body')
  // A space, newline, or paren in the colour would re-break the `## id (colour)` heading on re-parse
  // and silently drop the scrap from the list. Each must be refused, and the on-disk scrap untouched.
  for (const bad of ['red evil', 'x)', '(y', 'a\nb']) {
    await expect(store.setColour(a.id, bad)).rejects.toThrow(/single token/)
  }
  const onDisk = await readFile(scrapsFile('essay'), 'utf8')
  expect(onDisk).toContain(`## ${a.id}\nbody`) // never gained a (colour) mark
  expect((await store.list()).find((s) => s.id === a.id)?.colour).toBeUndefined() // still listed, still bare
  await store.setColour(a.id, '#e8a') // a valid palette token still works
  expect((await store.list()).find((s) => s.id === a.id)?.colour).toBe('#e8a')
})

test('remove returns the scrap for paste-back and drops the file when empty', async () => {
  const scrap = await store.add('essay.md', 'to be removed')
  const removed = await store.remove(scrap.id)
  expect(removed.id).toBe(scrap.id)
  expect(removed.text).toBe('to be removed')
  expect(existsSync(scrapsFile('essay'))).toBe(false) // no scraps and no foreign content left
  expect(await store.list()).toEqual([])
})

test('remove keeps a foreign preamble and sibling scraps', async () => {
  await mkdir(join(root, 'scraps'), { recursive: true })
  const a = await store.add('essay.md', 'first')
  const b = await store.add('essay.md', 'second')
  await store.remove(a.id)
  const onDisk = await readFile(scrapsFile('essay'), 'utf8')
  expect(onDisk).not.toContain('first')
  expect(onDisk).toContain('second')
  expect((await store.list()).map((s) => s.text)).toEqual(['second'])
  // Removing the last one now empties the file.
  await store.remove(b.id)
  expect(existsSync(scrapsFile('essay'))).toBe(false)
})

test('list scopes to one origin and preserves an expandable trigger', async () => {
  await mkdir(join(root, 'scraps'), { recursive: true })
  await writeFile(scrapsFile('essay'), '## s_e {mwcb}\nMetaphors We Compute By\n', 'utf8')
  await store.add('other.md', 'unrelated cutting')
  const scoped = await store.list({ origin: 'essay.md' })
  expect(scoped).toHaveLength(1)
  expect(scoped[0].expandTrigger).toBe('mwcb')
  expect(scoped[0].origin).toBe('essay.md')
  expect((await store.list()).length).toBe(2)
})

test('a multi-line cut body round-trips through list', async () => {
  const scrap = await store.add('essay.md', 'line one\n\nline two')
  expect(scrap.text).toBe('line one\n\nline two')
  expect((await store.list())[0].text).toBe('line one\n\nline two')
})
