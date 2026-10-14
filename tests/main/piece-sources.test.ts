import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capability, CapabilityContext } from '@bridle/core'
import { WorkspaceAgent } from '../../src/main/agent'
import { BoardMaterialDesk } from '../../src/main/board-material-desk'
import { buildWriteFlexManifest } from '../../src/main/capabilities'
import { listPieceSources, matchAuthorYear, pieceCollectionDir, readPieceSources, surnamesOf, yearOf, type CitationNote } from '../../src/main/piece-sources'
import { ScrapStore } from '../../src/main/scraps'
import { Workspace } from '../../src/main/workspace'

// Scraps ticket 04, locked design frame 5: a piece's sources, its `sources:` list merged with what its
// text cites. Wikilinks to research notes always count; author–year citations count only against
// research notes whose frontmatter carries an author and a year, and an ambiguous one is never picked.

const note = (path: string, title: string, authors: string[], year: string | null): CitationNote => ({ path, title, authors, year })
const HALL = note('c/research/hall-beyond-culture.md', 'Edward T. Hall, Beyond Culture', ['hall'], '1976')
const BARTLETT = note('c/research/bartlett.md', 'Bartlett, Remembering', ['bartlett'], '1932')
const SCHANK = note('c/research/schank.md', 'Schank & Abelson, Scripts', ['schank', 'abelson'], '1977')
const HALL_SILENT = note('c/research/hall-silent-language.md', 'Hall, The Silent Language', ['hall'], '1976')
const text = 'Hall 1976 argued it. Later (Bartlett, 1932) and again Bartlett 1932, plus Schank & Abelson (1977).'

test('author–year citations match research notes by author and year, counted per note', () => {
  const result = matchAuthorYear(text, [HALL, BARTLETT, SCHANK])
  expect(result.matched).toEqual([
    { path: HALL.path, title: HALL.title, count: 1 },
    { path: BARTLETT.path, title: BARTLETT.title, count: 2 },
    { path: SCHANK.path, title: SCHANK.title, count: 1 },
  ])
  expect(result.ambiguous).toEqual([])
  expect(result.availability).toMatchObject({ available: true, notesWithMetadata: 3, notesTotal: 3, message: null })
})

test('with no author and year on any note only links count, and the result says matching was unavailable', () => {
  const result = matchAuthorYear(text, [note('c/research/a.md', 'A', [], null), note('c/research/b.md', 'B', ['hall'], null)])
  expect(result.matched).toEqual([])
  expect(result.availability.available).toBe(false)
  expect(result.availability.message).toContain('Author–year matching was unavailable')
})

test('partial metadata: only notes with both author and year take part, and the list says so', () => {
  const result = matchAuthorYear(text, [HALL, note('c/research/bartlett.md', 'Bartlett, Remembering', ['bartlett'], null)])
  expect(result.matched.map((hit) => hit.path)).toEqual([HALL.path])
  expect(result.availability).toMatchObject({ available: true, notesWithMetadata: 1, notesTotal: 2 })
  expect(result.availability.message).toContain('used 1 of 2 research notes')
})

test('a citation two notes fit is ambiguous: shown with its candidates, counted for neither', () => {
  const result = matchAuthorYear('Hall 1976 said so, and Hall, 1976 again.', [HALL, HALL_SILENT])
  expect(result.matched).toEqual([])
  expect(result.ambiguous).toEqual([{
    text: 'Hall 1976', count: 2,
    candidates: [{ path: HALL.path, title: HALL.title }, { path: HALL_SILENT.path, title: HALL_SILENT.title }],
  }])
})

test('a second author in the citation narrows the notes that fit; wikilinks and code are not scanned', () => {
  const abelson = note('c/research/abelson.md', 'Abelson, Beliefs', ['abelson'], '1977')
  expect(matchAuthorYear('Schank & Abelson 1977.', [SCHANK, note('c/research/schank-2.md', 'Schank, Other', ['schank'], '1977')]).matched.map((hit) => hit.path)).toEqual([SCHANK.path])
  expect(matchAuthorYear('See [[Hall 1976 notes]] and\n```\nBartlett 1932\n```\n', [HALL, BARTLETT, abelson]).matched).toEqual([])
})

test('author and year metadata is read in the forms a writer uses', () => {
  expect(surnamesOf('Hall, Edward T.')).toEqual(['hall'])
  expect(surnamesOf('Edward T. Hall')).toEqual(['hall'])
  expect(surnamesOf(['Schank, Roger', 'Robert P. Abelson'])).toEqual(['schank', 'abelson'])
  expect(surnamesOf('Schank & Abelson')).toEqual(['schank', 'abelson'])
  expect(surnamesOf('Évelyne Müller')).toEqual(['muller'])
  expect(yearOf(1932)).toBe('1932')
  expect(yearOf('c. 1976')).toBe('1976')
  expect(yearOf('n.d.')).toBeNull()
})

test('a citation that fits a dated note and an undated note by the same author is ambiguous, not picked', () => {
  const undated = note('c/research/hall-notes.md', 'Hall, loose notes', ['hall'], null)
  const result = matchAuthorYear('Hall 1976 said so.', [HALL, undated])
  expect(result.matched).toEqual([])
  expect(result.ambiguous).toEqual([{
    text: 'Hall 1976', count: 1,
    candidates: [{ path: HALL.path, title: HALL.title }, { path: undated.path, title: undated.title }],
  }])
})

test('letter suffixes keep two same-year citations apart in the ambiguity list', () => {
  const result = matchAuthorYear('Hall 1976a and Hall 1976b and Hall 1976a.', [HALL, HALL_SILENT])
  expect(result.ambiguous.map((item) => [item.text, item.count])).toEqual([['Hall 1976a', 2], ['Hall 1976b', 1]])
})

test('the citation scan is linear on a long run of capitals with no spaces', () => {
  const long = 'A'.repeat(40_000)
  const started = performance.now()
  matchAuthorYear(long, [HALL])
  expect(performance.now() - started).toBeLessThan(100)
})

test('a published: date is read in UTC', () => {
  expect(yearOf(new Date('1976-01-01T00:00:00Z'))).toBe('1976')
})

test('the listing marks each source listed, cited or both, listed first and cited-only after', () => {
  const listing = listPieceSources({
    piece: 'c/p.md', pieceTitle: 'P', dir: 'c', text,
    listed: [{ title: HALL.title, path: HALL.path }, { title: BARTLETT.title, path: BARTLETT.path }, { title: 'Loose entry', path: null }],
    linked: [{ title: BARTLETT.title, path: BARTLETT.path, count: 1 }],
    notes: [HALL, BARTLETT, SCHANK],
  })
  expect(listing.entries.map((entry) => [entry.title, entry.status, entry.cited, entry.links, entry.authorYear])).toEqual([
    [HALL.title, 'both', 1, 0, 1],
    [BARTLETT.title, 'both', 3, 1, 2],
    ['Loose entry', 'listed', 0, 0, 0],
    [SCHANK.title, 'cited', 1, 0, 1],
  ])
})

let root: string
let appData: string
let ws: Workspace
let agent: WorkspaceAgent | null = null

const PIECE = 'schemas/how-humans-hallucinate.md'
const files: Record<string, string> = {
  [PIECE]: '---\nstatus: editing\nsources:\n  - research/hall-1976.md\n  - research/bartlett.md\n---\n# How humans hallucinate\n\nBartlett [[Bartlett, Remembering]] showed it; see [[Bartlett, Remembering]] again. Schank & Abelson (1977) agree, and Hall 1976.\n\nA [[Schank & Abelson, Scripts]] link and a [[Some piece]] link.\n',
  'schemas/some-piece.md': '---\nstatus: idea\n---\n# Some piece\n',
  'schemas/research/hall-1976.md': '---\nauthor: Hall, Edward T.\nyear: 1976\n---\n# Hall 1976 notes\n',
  'schemas/research/bartlett.md': '# Bartlett, Remembering\n',
  'schemas/research/schank.md': '---\nauthors:\n  - Schank, Roger\n  - Abelson, Robert\nyear: 1977\n---\n# Schank & Abelson, Scripts\n',
  'schemas/research/hall-beyond-culture.md': '---\nauthor: Edward T. Hall\nyear: 1976\n---\n# Edward T. Hall, Beyond Culture\n',
}

const ctx: CapabilityContext = {
  trigger: { id: 't', source: 'user', trust: 'interactive' },
  sessionId: 's', attemptId: 'attempt', idempotencyKey: 'attempt', audit: () => {},
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-piece-sources-'))
  appData = await mkdtemp(join(tmpdir(), 'wf-piece-sources-data-'))
  ws = new Workspace(root)
  await mkdir(join(root, 'schemas/research'), { recursive: true })
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content, 'utf8')
})

afterEach(async () => {
  await agent?.dispose()
  agent = null
  await rm(root, { recursive: true, force: true })
  await rm(appData, { recursive: true, force: true })
})

test('the reader merges the sources: list with wikilinks and author–year citations of a real collection', async () => {
  const listing = await readPieceSources(ws, { path: PIECE, dir: 'schemas' })
  expect(listing).toMatchObject({ piece: PIECE, pieceTitle: 'How humans hallucinate', dir: 'schemas' })
  expect(listing.entries.map((entry) => [entry.path, entry.status, entry.cited])).toEqual([
    ['schemas/research/hall-1976.md', 'listed', 0],
    ['schemas/research/bartlett.md', 'both', 2],
    ['schemas/research/schank.md', 'cited', 2],
  ])
  // "Hall 1976" fits two notes (hall-1976 and hall-beyond-culture): shown as ambiguous, counted for neither.
  expect(listing.ambiguous).toEqual([expect.objectContaining({ text: 'Hall 1976', count: 1 })])
  expect(listing.ambiguous[0].candidates.map((candidate) => candidate.path).sort()).toEqual(['schemas/research/hall-1976.md', 'schemas/research/hall-beyond-culture.md'])
  expect(listing.authorYearMatching.message).toContain('used 3 of 4 research notes')
})

test('without dir the reader finds the piece\'s collection itself', async () => {
  const listing = await readPieceSources(ws, { path: PIECE })
  expect(listing.dir).toBe('schemas')
  expect(listing.entries).toHaveLength(3)
})

test('an absolute path is refused promptly, outside the root or inside it', async () => {
  await expect(readPieceSources(ws, { path: '/etc/outside.md' })).rejects.toThrow('workspace-relative')
  await expect(readPieceSources(ws, { path: join(root, PIECE) })).rejects.toThrow('workspace-relative')
  await expect(readPieceSources(ws, { path: '../escape.md' })).rejects.toThrow('workspace-relative')
  expect(await pieceCollectionDir(ws, '/nowhere/piece.md')).toBe('/nowhere')
}, 2000)

test('the sources.list verb is a direct read that returns the listing and writes nothing', async () => {
  const manifest = buildWriteFlexManifest(ws, undefined, { scraps: new ScrapStore(ws) })
  const list = manifest.capabilities.find((c) => c.name === 'sources.list') as Capability
  expect(list.risk).toBe('read')
  const result = await list.execute({ path: PIECE }, ctx) as { text: string; details: { sources: { entries: unknown[] } } }
  expect(result.text).toContain('Sources of How humans hallucinate (schemas/how-humans-hallucinate.md) · 3')
  expect(result.text).toContain('Bartlett, Remembering (schemas/research/bartlett.md) — listed, cited 2×')
  expect(result.text).toContain('Schank & Abelson, Scripts (schemas/research/schank.md) — cited 2×, not listed')
  expect(result.text).toContain('Ambiguous citation "Hall 1976"')
  expect(result.details.sources.entries).toHaveLength(3)
  expect(await readFile(join(root, PIECE), 'utf8')).toBe(files[PIECE])
  const refused = await list.execute({ path: 'schemas/missing.md' }, ctx) as { isError?: boolean }
  expect(refused.isError).toBe(true)
})

test('sources.list does not record the piece as read: it returns the listing, not the text', async () => {
  const reads: string[] = []
  const manifest = buildWriteFlexManifest(ws, undefined, { scraps: new ScrapStore(ws), onFileRead: (path) => reads.push(path) })
  const list = manifest.capabilities.find((c) => c.name === 'sources.list') as Capability
  await list.execute({ path: PIECE }, ctx)
  expect(reads).toEqual([])
})

test('"Add to sources" is ticket 03\'s attach: the cited source becomes listed, one undo takes it back', async () => {
  agent = await WorkspaceAgent.create({
    workspace: ws, appDataDir: appData, services: { scraps: new ScrapStore(ws) },
    onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {},
  })
  const desk = new BoardMaterialDesk(ws, agent.hostSnapshots(), new ScrapStore(ws))
  const before = await readPieceSources(ws, { path: PIECE })
  const cited = before.entries.find((entry) => entry.status === 'cited')!
  const added = await desk.attachSource({ dir: before.dir, piece: before.piece, source: cited.path! })
  expect(added).toMatchObject({ ok: true, step: { kind: 'source', activity: 'Source attached' } })
  const after = await readPieceSources(ws, { path: PIECE })
  expect(after.entries.find((entry) => entry.path === cited.path)).toMatchObject({ status: 'both', cited: 2 })
  expect(await desk.undo(added.ok ? added.step.id : '')).toMatchObject({ ok: true })
  expect(await readFile(join(root, PIECE), 'utf8')).toBe(files[PIECE])
})
