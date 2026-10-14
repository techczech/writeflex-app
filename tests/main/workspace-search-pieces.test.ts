import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Workspace } from '../../src/main/workspace'

/**
 * Workspace.search matches whole pieces (ticket 01, 2026-09-26): plain words anywhere in the file,
 * one ranked result per file at its best line, a total beyond the cap, all from the content cache.
 */

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-search-pieces-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Write files, each with an explicit mtime (seconds after a fixed epoch) so recency is deterministic. */
async function workspace(files: Record<string, { body: string; age?: number }>): Promise<Workspace> {
  const base = Date.parse('2026-01-01T00:00:00Z')
  for (const [path, { body, age = 0 }] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
    const when = new Date(base + age * 1000)
    await utimes(join(root, path), when, when)
  }
  return new Workspace(root)
}

/** A body of `count` filler lines with the given lines placed at 1-based line numbers. */
function body(count: number, placed: Record<number, string>): string {
  return Array.from({ length: count }, (_, i) => placed[i + 1] ?? `filler line ${i + 1}`).join('\n')
}

test('plain words match a piece when each appears on any line; a piece with one word does not', async () => {
  const ws = await workspace({
    'both.md': { body: body(45, { 3: 'The reader arrives with a model.', 40: 'That expectation shapes the rest.' }) },
    'only-reader.md': { body: body(10, { 2: 'A reader alone.' }) },
    'only-expectation.md': { body: body(10, { 5: 'An expectation alone.' }) },
  })
  const { matches, total } = await ws.search('reader expectation')
  expect(matches.map((m) => m.path)).toEqual(['both.md'])
  expect(total).toBe(1)
  // Order-free: the same piece matches with the words reversed.
  expect((await ws.search('expectation reader')).matches.map((m) => m.path)).toEqual(['both.md'])
})

test('a quoted phrase matches only where the phrase sits on one line', async () => {
  const ws = await workspace({
    'phrase.md': { body: body(6, { 4: 'It all turns on reader expectation, as ever.' }) },
    'spread.md': { body: body(45, { 3: 'The reader arrives.', 40: 'The expectation follows.' }) },
    'reordered.md': { body: body(6, { 2: 'The expectation of the reader.' }) },
    'wrapped-space.md': { body: body(6, { 2: 'Reader   expectation, spaced out.' }) },
  })
  const { matches } = await ws.search('"reader expectation"')
  expect(matches.map((m) => m.path).sort()).toEqual(['phrase.md', 'wrapped-space.md'])
  const phrase = matches.find((m) => m.path === 'phrase.md')!
  expect(phrase.line).toBe(4)
  expect(phrase.preview.slice(phrase.column - 1, phrase.column - 1 + phrase.length)).toBe('reader expectation')
  // The unquoted words still match all four pieces.
  expect((await ws.search('reader expectation')).total).toBe(4)
})

test('a phrase combines with a word elsewhere in the piece', async () => {
  const ws = await workspace({
    'yes.md': { body: body(20, { 2: 'on reader expectation', 18: 'in the classroom' }) },
    'no.md': { body: body(20, { 2: 'on reader expectation' }) },
  })
  expect((await ws.search('"reader expectation" classroom')).matches.map((m) => m.path)).toEqual(['yes.md'])
})

test('AND is the default made explicit: both terms somewhere in the piece', async () => {
  const ws = await workspace({
    'a.md': { body: 'alpha on one line\n\nbeta on another\n' },
    'b.md': { body: 'just beta\n' },
  })
  expect((await ws.search('alpha AND beta')).matches.map((m) => m.path)).toEqual(['a.md'])
  expect((await ws.search('alpha beta')).matches.map((m) => m.path)).toEqual(['a.md'])
})

test('-not filters lines: a term only on an excluded line does not count toward the piece', async () => {
  const ws = await workspace({
    'kept.md': { body: 'reader here\nexpectation there\n' },
    'excluded.md': { body: 'reader here\nexpectation in the classroom\n' },
  })
  const { matches } = await ws.search('reader expectation -classroom')
  expect(matches.map((m) => m.path)).toEqual(['kept.md'])
  expect(matches[0].snippet.text).not.toContain('classroom')
})

test('/regex/ yields one result per piece, at the first matching line', async () => {
  const ws = await workspace({
    'r.md': { body: 'nothing\nThe Artefact glimmers.\nanother artefacts line\n' },
  })
  const { matches } = await ws.search('/artef\\w+/')
  expect(matches).toHaveLength(1)
  expect(matches[0]).toMatchObject({ path: 'r.md', line: 2, column: 5, length: 8 })
})

test('tag: plus words: the tag gates the file, the words match anywhere in it', async () => {
  const ws = await workspace({
    'tagged.md': { body: '---\ntags: [draft]\n---\n\nreader first\n\nlater an expectation\n' },
    'untagged.md': { body: 'reader first\n\nlater an expectation\n' },
  })
  const { matches } = await ws.search('tag:draft reader expectation')
  expect(matches.map((m) => m.path)).toEqual(['tagged.md'])
})

test('one result per piece: the best line wins, with every term marked in the snippet', async () => {
  const ws = await workspace({
    'piece.md': {
      body: body(12, {
        2: 'A reader alone.',
        6: 'Here the reader meets an expectation, and the reader adjusts.',
        10: 'An expectation alone.',
      }),
    },
  })
  const { matches } = await ws.search('reader expectation')
  expect(matches).toHaveLength(1)
  const [hit] = matches
  expect(hit.line).toBe(6) // two distinct terms on one line beat one
  expect(hit.preview.slice(hit.column - 1, hit.column - 1 + hit.length)).toBe('reader') // earliest term selected
  const marked = hit.snippet.marks.map((m) => hit.snippet.text.slice(m.column - 1, m.column - 1 + m.length))
  expect(marked).toEqual(['reader', 'expectation', 'reader'])
  // The preview carries the same terms, placed on the full line, so it can mark every one too.
  expect(hit.marks.map((m) => hit.preview.slice(m.column - 1, m.column - 1 + m.length))).toEqual(['reader', 'expectation', 'reader'])
})

test('a long best line is cut to a window around the marks', async () => {
  const long = `${'lorem ipsum dolor '.repeat(20)}the reader meets an expectation here ${'sit amet consectetur '.repeat(20)}`
  const ws = await workspace({ 'long.md': { body: `${long}\n` } })
  const [hit] = (await ws.search('reader expectation')).matches
  expect(hit.snippet.text.startsWith('…')).toBe(true)
  expect(hit.snippet.text.endsWith('…')).toBe(true)
  expect(hit.snippet.text.length).toBeLessThanOrEqual(142)
  const marked = hit.snippet.marks.map((m) => hit.snippet.text.slice(m.column - 1, m.column - 1 + m.length))
  expect(marked).toEqual(['reader', 'expectation'])
  // The jump offsets stay in doc-line coordinates.
  expect(long.slice(hit.column - 1, hit.column - 1 + hit.length)).toBe('reader')
})

test('ranking: name or title first, then distinct terms on a line, then total hits, then recency; ties keep listing order', async () => {
  const ws = await workspace({
    // Rule 1 by file name: the name holds both words; the content is the weakest here.
    'reader-expectation-notes.md': { body: 'reader\n\nexpectation\n', age: 0 },
    // Rule 1 by title (first heading): fewer hits than b-same-line, so only rule 1 puts it ahead.
    'z-titled.md': { body: '# Reader expectation\n\nsome reader\n', age: 0 },
    // Rule 2a: both terms on one line.
    'b-same-line.md': { body: 'the reader expectation, reader expectation\n', age: 1 },
    // Rule 2b: separate lines, but more hits.
    'c-many-hits.md': { body: 'reader reader reader\nexpectation expectation\n', age: 1 },
    // Rule 3: same shape, different ages; f and g tie completely.
    'd-older.md': { body: 'reader\nexpectation\n', age: 10 },
    'e-newest.md': { body: 'reader\nexpectation\n', age: 50 },
    'g-tie.md': { body: 'reader\nexpectation\n', age: 5 },
    'f-tie.md': { body: 'reader\nexpectation\n', age: 5 },
  })
  const { matches } = await ws.search('reader expectation')
  expect(matches.map((m) => m.path)).toEqual([
    'z-titled.md', // rule 1 (title); two terms on its heading line put it ahead of the other rule-1 piece
    'reader-expectation-notes.md', // rule 1 (name), despite the thinnest content
    'b-same-line.md', // rule 2: two distinct terms on one line
    'c-many-hits.md', // rule 2: more total hits
    'e-newest.md', // rule 3: most recently modified first, against the listing order
    'd-older.md',
    'f-tie.md', // full tie with g — the listing (path) order holds
    'g-tie.md',
  ])
})

test('ranking: a title holding only some of the terms does not count as rule 1', async () => {
  const ws = await workspace({
    'a.md': { body: '# Reader\n\nexpectation\n', age: 0 },
    'b.md': { body: 'reader\nexpectation\n', age: 9 },
  })
  expect((await ws.search('reader expectation')).matches.map((m) => m.path)).toEqual(['b.md', 'a.md'])
})

test('over the cap: the matches stop at maxResults and total counts every matching piece', async () => {
  const files: Record<string, { body: string; age: number }> = {}
  for (let i = 0; i < 7; i += 1) files[`p${i}.md`] = { body: `river ${i}\n`, age: i }
  files['dry.md'] = { body: 'no water\n', age: 0 }
  const ws = await workspace(files)
  const { matches, total } = await ws.search('river', { maxResults: 3 })
  expect(total).toBe(7)
  expect(matches.map((m) => m.path)).toEqual(['p6.md', 'p5.md', 'p4.md']) // ranked, then capped
})

test('the content cache serves the search: each file is read once cold and never again warm', async () => {
  const files: Record<string, { body: string }> = {}
  for (let i = 0; i < 12; i += 1) files[`n${i}.md`] = { body: `# Note ${i}\n\nreader\n\nexpectation ${i}\n` }
  const ws = await workspace(files)
  const cold = await ws.search('reader expectation')
  expect(cold.total).toBe(12)
  expect(ws.searchIndex.reads).toBe(12) // titles come from the cached content, not a second read
  const warm = await ws.search('note reader')
  expect(warm.total).toBe(12)
  expect(ws.searchIndex.reads).toBe(12)
})
