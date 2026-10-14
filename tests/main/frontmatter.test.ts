import { test, expect } from 'bun:test'
import { parseFrontmatter, patternFor, DEFAULT_PATTERN, documentTitle } from '../../src/main/frontmatter'

// ---- The reading contract (ADR-0008): frontmatter is READ, never written; bare files stay bare. ----

test("parses a fictional talk-archive shape; unknown keys land in extra", () => {
  // Fictional talk archive: rich per-file frontmatter with
  // a mix of core fields and archive-specific keys. Core fields promote; the rest land in `extra`.
  const doc = [
    '---',
    'title: "Exploring Gardens: Beyond the City Wall"',
    'date: 2025-04-12',
    'venue: Imaginary Garden Conference',
    'audience: practitioners',
    'status: delivered',
    'category: talk',
    'series: Garden Dialogues',
    'series-order: 2',
    'tags: [gardening, landscape, community]',
    'format: keynote',
    'modified: 2025-05-09',
    'adapted_from: metaphor-and-mind.md',
    '---',
    '',
    '# Abstract',
    '',
    'Body text here.',
  ].join('\n')

  const fm = parseFrontmatter(doc)
  expect(fm).not.toBeNull()
  expect(fm!.title).toBe('Exploring Gardens: Beyond the City Wall') // quoted, colon survives, quotes stripped
  expect(fm!.date).toBe('2025-04-12')
  expect(fm!.status).toBe('delivered')
  expect(fm!.series).toBe('Garden Dialogues')
  expect(fm!.seriesOrder).toBe(2) // frontmatter key `series-order` → number
  expect(fm!.tags).toEqual(['gardening', 'landscape', 'community'])
  // Archive-specific keys are preserved verbatim in `extra`, never lost, never promoted.
  expect(fm!.extra).toEqual({
    venue: 'Imaginary Garden Conference',
    audience: 'practitioners',
    category: 'talk',
    format: 'keynote',
    modified: '2025-05-09',
    adapted_from: 'metaphor-and-mind.md',
  })
})

test('a bare file (no leading --- line) returns null — bare files stay bare (ADR-0008)', () => {
  expect(parseFrontmatter('# Just a heading\n\nSome prose.\n')).toBeNull()
  expect(parseFrontmatter('')).toBeNull()
  expect(parseFrontmatter('Plain text with a colon: not frontmatter.\n')).toBeNull()
})

test('a --- horizontal rule mid-document is NOT mistaken for frontmatter', () => {
  const doc = 'Intro paragraph.\n\n---\n\nSection after a thematic break.\n'
  expect(parseFrontmatter(doc)).toBeNull()
})

test('a leading UTF-8 BOM does not defeat the fence check (Windows-authored files read correctly)', () => {
  // A BOM decodes to a leading U+FEFF; abstracts-archive files authored on Windows carry one. Without
  // stripping it, the fence line reads as "﻿---" and the whole file is misread as bare.
  const doc = '﻿---\ntitle: Windows-authored abstract\ntags: [gardening]\n---\n\n# Abstract\n'
  const fm = parseFrontmatter(doc)
  expect(fm).not.toBeNull()
  expect(fm!.title).toBe('Windows-authored abstract')
  expect(fm!.tags).toEqual(['gardening'])
  // patternFor routes through the same fence check, so a BOM'd Index Note still yields its columns.
  expect(patternFor('﻿---\npattern: [title, venue]\n---\n').columns).toEqual(['title', 'venue'])
})

test('a leading --- with no closing fence is not frontmatter (returns null)', () => {
  // A doc that opens with a thematic break and never fences a block is not frontmatter.
  expect(parseFrontmatter('---\n\nJust content, no closing fence.\n')).toBeNull()
})

test('inline list form [a, b] parses into a string array', () => {
  const fm = parseFrontmatter('---\ntitle: Piece\ntags: [draft, river, "quiet water"]\n---\n\nBody\n')
  expect(fm!.tags).toEqual(['draft', 'river', 'quiet water'])
})

test('dashed block-list form parses into a string array (quotes stripped)', () => {
  const fm = parseFrontmatter('---\ntitle: Piece\ntags:\n  - draft\n  - "river"\n  - quiet\n---\n\nBody\n')
  expect(fm!.tags).toEqual(['draft', 'river', 'quiet'])
})

test('unindented dashed block-list form parses into a string array', () => {
  const fm = parseFrontmatter('---\ntags:\n- draft\n- river\n---\n\nBody\n')
  expect(fm!.tags).toEqual(['draft', 'river'])
})

test('related[] reads both list forms', () => {
  const inline = parseFrontmatter('---\nrelated: [a.md, b.md]\n---\n')
  expect(inline!.related).toEqual(['a.md', 'b.md'])
  const dashed = parseFrontmatter('---\nrelated:\n  - a.md\n  - b.md\n---\n')
  expect(dashed!.related).toEqual(['a.md', 'b.md'])
})

test('a quoted title containing a colon keeps the colon (single and double quotes)', () => {
  expect(parseFrontmatter('---\ntitle: "Metaphor: A User\'s Guide"\n---\n')!.title)
    .toBe("Metaphor: A User's Guide")
  expect(parseFrontmatter("---\ntitle: 'Foo: Bar'\n---\n")!.title).toBe('Foo: Bar')
})

test('an empty frontmatter block parses to a non-null Frontmatter with empty extra', () => {
  const fm = parseFrontmatter('---\n---\n\n# Body\n')
  expect(fm).not.toBeNull()
  expect(fm!.extra).toEqual({})
  expect(fm!.title).toBeUndefined()
  expect(fm!.tags).toBeUndefined()
})

test('malformed lines inside a valid fence never throw; parseable keys survive, junk is kept raw', () => {
  const doc = '---\ntitle: Good\nthis line has no colon and is junk\nstatus: draft\n---\n\nBody\n'
  let fm: ReturnType<typeof parseFrontmatter>
  expect(() => { fm = parseFrontmatter(doc) }).not.toThrow()
  expect(fm!.title).toBe('Good')
  expect(fm!.status).toBe('draft')
  // The unparseable line is not lost — it is kept raw so nothing is silently dropped.
  expect(fm!.extra._raw).toEqual(['this line has no colon and is junk'])
})

test('Unicode word keys make a leading fence pair frontmatter and parse as entries', () => {
  const fm = parseFrontmatter('---\nnázev: Poznámka\n---\n\nBody\n')
  expect(fm).not.toBeNull()
  expect(fm!.extra.název).toBe('Poznámka')
  expect(fm!.extra._raw).toBeUndefined()
})

test('a scalar tag value is coerced to a single-element list; empty list-key stays absent', () => {
  expect(parseFrontmatter('---\ntags: draft\n---\n')!.tags).toEqual(['draft'])
  expect(parseFrontmatter('---\ntags:\n---\n')!.tags).toBeUndefined()
})

test('purpose is a recognised core field', () => {
  expect(parseFrontmatter('---\npurpose: blog\n---\n')!.purpose).toBe('blog')
})

test('description is promoted while unknown frontmatter remains preserved', () => {
  const fm = parseFrontmatter('---\ndescription: A compact gist\ncustom-stage-note: Waiting for evidence\n---\n')!
  expect(fm.description).toBe('A compact gist')
  expect(fm.extra).toEqual({ 'custom-stage-note': 'Waiting for evidence' })
})

test('author is a first-class exported field rather than an arbitrary extra key', () => {
  const fm = parseFrontmatter('---\nauthor: Dominik Lukeš\nsecret-project: X\n---\n')!
  expect(fm.author).toBe('Dominik Lukeš')
  expect(fm.extra).toEqual({ 'secret-project': 'X' })
})

// ---- patternFor: an Index Note declares the columns a Collection is browsed by (PRD S32). ----

test('patternFor returns the default pattern when there is no Index Note text', () => {
  const p = patternFor(null)
  expect(p.columns).toEqual(DEFAULT_PATTERN)
  expect(p.columns).toEqual(['date', 'status', 'purpose', 'related'])
})

test('patternFor returns the default pattern for an Index Note with no pattern: key', () => {
  expect(patternFor('---\ntitle: My Folder\n---\n\nCover text.\n').columns).toEqual(DEFAULT_PATTERN)
  expect(patternFor('# No frontmatter cover\n').columns).toEqual(DEFAULT_PATTERN)
})

test("patternFor reads pattern: from the Index Note's own frontmatter (inline and dashed)", () => {
  const inline = patternFor('---\npattern: [title, venue, date]\n---\n')
  expect(inline.columns).toEqual(['title', 'venue', 'date'])
  const dashed = patternFor('---\npattern:\n  - title\n  - status\n---\n')
  expect(dashed.columns).toEqual(['title', 'status'])
})

test('documentTitle ignores a legacy title key and always prefers the first H1', () => {
  expect(documentTitle('---\ntitle: Legacy title\n---\n\n# Heading truth\n', 'piece.md')).toBe('Heading truth')
})

test('documentTitle uses the first heading of any level nearest the top', () => {
  expect(documentTitle('## Supporting heading\n\nBody.\n\n# Buried H1\n', 'piece.md')).toBe('Supporting heading')
})
