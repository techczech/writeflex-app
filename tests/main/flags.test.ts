// Needs-work flags (Folio room spec § 6, T-FLAG / T-PERF): the scanner, and the flag stripped from every output.
import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFlags, stripFlags, stripFlagsInLine } from '../../src/shared/markdown/flags.ts'
import { exportSource } from '../../src/shared/markdown/dialect.ts'
import { toHtml } from '../../src/shared/markdown/to-html.ts'
import { toPlain } from '../../src/shared/markdown/to-plain.ts'
import { toRtf } from '../../src/shared/markdown/to-rtf.ts'
import { toNormalisedMarkdown } from '../../src/shared/markdown/to-markdown.ts'
import { headingPlainText } from '../../src/shared/folio-part-title.ts'
import { countUnits, countWords } from '../../src/renderer/src/editor/word-count.ts'
import { extractOutline } from '../../src/renderer/src/editor/outline.ts'
import { projectMarkdown, anchorReaderNote } from '../../src/main/reader-note-anchor.ts'
import { Workspace } from '../../src/main/workspace.ts'
import { renderPieceForSharing } from '../../src/main/sharing-render.ts'

// F-FLAGS
const REAL = [
  '# Heading ==h==<!--flag:rewrite-->',
  '',
  '- item ==i==<!--flag:expand-->',
  '',
  '> quote ==q==<!--flag:check-fact-->',
  '',
  '[label ==l==<!--flag:needs-citation--> end](https://example.org)',
  '',
  '| a | b |',
  '|---|---|',
  '| ==cell==<!--flag:rewrite--> | x |',
  '',
  'soft ==two\nlines==<!--flag:rewrite--> then ==A==<!--flag:expand--><!--flag:rewrite--> and ==B==<!--flag:EXPAND--> ==C==<!-- flag : Rewrite -->',
  '',
].join('\n')
const NOT_FLAGS = [
  'bare ==highlight== stays',
  '',
  'orphan <!--flag:rewrite--> comment',
  '',
  'unknown ==kind==<!--flag:bogus--> here',
  '',
  'ordinary ==mark==<!-- note --> here',
  '',
  '```',
  'code ==x==<!--flag:rewrite-->',
  '```',
  '',
  'inline `==y==<!--flag:rewrite-->` code',
  '',
].join('\n')
const FRONT = '---\ntitle: ==t==<!--flag:rewrite-->\n---\n\n'

test('findFlags finds exactly the real flags, in every place a flag may sit', () => {
  const flags = findFlags(FRONT + REAL + '\n' + NOT_FLAGS)
  expect(flags.map((f) => [f.words, f.kind, f.inTable])).toEqual([
    ['h', 'rewrite', false],
    ['i', 'expand', false],
    ['q', 'check-fact', false],
    ['l', 'needs-citation', false],
    ['cell', 'rewrite', true],
    ['two\nlines', 'rewrite', false],
    ['A', 'expand', false],
    ['B', 'expand', false],
    ['C', 'rewrite', false],
  ])
})

test('a flag carries its ranges, block index and context', () => {
  const source = 'Intro.\n\nThis is ==other findings==<!--flag:needs-citation--> but not.\n'
  const [flag] = findFlags(source)
  expect(source.slice(flag.from, flag.to)).toBe('==other findings==<!--flag:needs-citation-->')
  expect(source.slice(flag.wordsFrom, flag.wordsTo)).toBe('other findings')
  expect(flag.paragraph).toBe(1)
  expect(flag.contextBefore).toBe('Intro. This is ')
  expect(flag.contextAfter).toBe(' but not. ')
})

test('stripFlags keeps the words and every other byte; plain highlights stay', () => {
  expect(stripFlags(NOT_FLAGS)).toBe(NOT_FLAGS)
  expect(stripFlags('a ==b==<!--flag:rewrite--> c ==d== e\n')).toBe('a b c ==d== e\n')
  expect(stripFlags(FRONT + 'x\n')).toBe(FRONT + 'x\n')
  expect(stripFlagsInLine('Title ==here==<!--flag:expand--> now')).toBe('Title here now')
  expect(stripFlagsInLine('plain')).toBe('plain')
})

test('no export flavour holds flag syntax or a mark for flagged words, and plain highlights stay', () => {
  const text = '# Head ==h==<!--flag:rewrite-->\n\nA ==flagged==<!--flag:check-fact--> and ==plain== words.\n'
  const outputs = [toHtml(text).html, toPlain(text), toRtf(text), toNormalisedMarkdown(text)]
  for (const out of outputs) {
    expect(out).not.toContain('flag:')
    expect(out).toContain('flagged')
  }
  expect(outputs[0]).toMatch(/<mark[^>]*>plain<\/mark>/)
  expect(outputs[0]).not.toMatch(/<mark[^>]*>flagged/)
  expect(outputs[3]).toContain('==plain==')
  expect(outputs[3]).not.toContain('==flagged')
})

test('word counts are equal with and without flags', () => {
  const plain = '# Head h\n\nA flagged and ==plain== words, two words.\n'
  const flagged = '# Head ==h==<!--flag:rewrite-->\n\nA ==flagged==<!--flag:check-fact--> and ==plain== words, ==two words==<!-- flag : Expand -->.\n'
  expect(countWords(flagged)).toBe(countWords(plain))
  expect(countUnits(flagged).words).toBe(countUnits(plain).words)
  expect(countUnits(flagged).characters).toBe(countUnits(plain).characters)
})

test('a heading with a flag is plain text in the outline and the heading text', () => {
  expect(extractOutline('# Alpha ==beta==<!--flag:rewrite--> gamma\n\ntext\n')).toEqual([{ level: 1, text: 'Alpha beta gamma', from: 0 }])
  expect(extractOutline('x\n\n## ==Two==<!--flag:expand-->\n').map((h) => [h.text, h.from])).toEqual([['Two', 3]])
  expect(headingPlainText('Alpha ==beta==<!--flag:rewrite--> gamma')).toBe('Alpha beta gamma')
})

test('reader-note anchoring maps a quote across flag markup back to the source', () => {
  const source = 'The ==quick brown==<!--flag:rewrite--> fox jumps.\n'
  const projected = projectMarkdown(source)
  expect(projected.text).toBe('The quick brown fox jumps.')
  const anchor = anchorReaderNote(source, { quote: 'quick brown fox', before: 'The ', after: ' jumps.' })
  expect(anchor.state).toBe('unchanged')
  if (anchor.state === 'unchanged') expect(source.slice(anchor.from, anchor.to)).toBe('quick brown==<!--flag:rewrite--> fox')
})

async function shared(text: string) {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-flags-share-'))
  mkdirSync(join(root, 'd'), { recursive: true })
  writeFileSync(join(root, 'd/p.md'), text)
  return renderPieceForSharing(root, 'd/p.md', '/s/abcdefgh1234/images/')
}

test('the sharing reader page holds no flag syntax and no mark for flagged words, but keeps plain highlights', async () => {
  const piece = await shared('# T\n\nA ==flagged==<!--flag:rewrite--> and ==plain== text <!-- hidden -->.\n')
  expect(piece.html).not.toContain('flag:')
  expect(piece.html).not.toContain('<!--')
  expect(piece.html).not.toContain('hidden')
  expect(piece.html).not.toMatch(/<mark[^>]*>flagged/)
  expect(piece.html).toContain('flagged')
  expect(piece.html).toMatch(/<mark[^>]*>plain<\/mark>/)
})

test('T-PERF: a 100 KB part scans fast; 200 parts of 10 KB with 500 flags scan in under a second', () => {
  const para = 'Some ordinary prose with a ==flagged phrase==<!--flag:rewrite--> inside it and a plain ==mark== too.\n\n'
  const part = para.repeat(Math.ceil(100_000 / para.length))
  findFlags(part) // warm
  let started = performance.now()
  expect(findFlags(part).length).toBeGreaterThan(500)
  expect(performance.now() - started).toBeLessThan(50)

  const small = ('word '.repeat(190) + '\n\n').repeat(10) // ~10 KB
  expect(small.length).toBeGreaterThan(9_500)
  started = performance.now()
  let found = 0
  for (let i = 0; i < 200; i += 1) {
    const withFlags = i < 100 ? small + '==a==<!--flag:expand-->\n\n'.repeat(5) : small
    expect(withFlags.length).toBeGreaterThan(9_500)
    found += findFlags(withFlags).length
  }
  expect(found).toBe(500)
  expect(performance.now() - started).toBeLessThan(1000)
})

test('the flagged words survive as text: a post-it look-alike, a rule, a heading, a list number', () => {
  expect(toPlain('==// keep these words==<!--flag:rewrite-->')).toContain('// keep these words')
  expect(toHtml('==// keep these words==<!--flag:rewrite-->').html).toContain('// keep these words')
  expect(toHtml('Para\n\n==---==<!--flag:rewrite-->').html).not.toContain('<hr')
  expect(toHtml('Para\n\n==---==<!--flag:rewrite-->').html).toContain('---')
  expect(toHtml('==# not a heading==<!--flag:rewrite-->').html).not.toContain('<h1')
  expect(toHtml('==1. not a list==<!--flag:rewrite-->').html).not.toContain('<ol')
  expect(toHtml('text\n==---==<!--flag:rewrite-->').html).not.toContain('<h2')
  expect(toPlain('- item\n- ==// kept==<!--flag:rewrite-->')).toContain('// kept')
})

test('r2: code spans, existing escapes, multi-line and doubly nested words come out exactly as the writer wrote them', () => {
  const html = (s: string): string => toHtml(s).html
  // a code span inside flagged words stays code
  expect(html('==`code`==<!--flag:rewrite-->')).toContain('<code')
  expect(html('==`code`==<!--flag:rewrite-->')).not.toContain('`')
  // an existing escape is not doubled into a visible backslash
  expect(toPlain('==\\-word==<!--flag:rewrite-->')).toContain('-word')
  expect(toPlain('==\\-word==<!--flag:rewrite-->')).not.toContain('\\')
  // a code span across lines
  const across = html('==start `a\n// code`==<!--flag:rewrite-->')
  expect(across).not.toContain('\\')
  expect(across).toContain('<p')
  // (a later line that BEGINS with `//` is a post-it line by the app's existing rule, flag or not)
  expect(toPlain('prefix ==first // kept==<!--flag:rewrite-->')).toContain('first // kept')
  // doubly nested, with //
  const nested = '==outer\n==// inner==<!--flag:expand--> end==<!--flag:rewrite-->'
  expect(toPlain(nested)).not.toContain('\\')
  expect(toPlain(nested)).toContain('// inner')
  expect(html(nested)).not.toContain('flag')
  expect(html(nested)).not.toContain('<mark')
})

test('nested flags are found and stripped too', () => {
  const source = 'A ==outer ==inner==<!--flag:expand--> words==<!--flag:rewrite--> end.\n'
  const flags = findFlags(source)
  expect(flags.map((f) => f.kind).sort()).toEqual(['expand', 'rewrite'])
  expect(stripFlags(source)).toBe('A outer inner words end.\n')
  expect(toNormalisedMarkdown(source)).toBe('A outer inner words end.\n')
  expect(toHtml(source).html).not.toContain('flag:')
  expect(toHtml(source).html).not.toMatch(/<mark[^>]*>inner/)
})

test('r2: an outline label shows the words as written, with no backslash', () => {
  expect(extractOutline('==---==<!--flag:rewrite-->\n---\n')[0].text).toBe('---')
  expect(extractOutline('# ==---==<!--flag:rewrite-->\n')[0].text).toBe('---')
  expect(stripFlags('==// x==<!--flag:rewrite-->')).toBe('// x')
  expect(stripFlags('==a ==b==<!--flag:expand--> c==<!--flag:rewrite--> tail')).toBe('a b c tail')
})

test('a Setext heading whose flag spans the line break shows plain text in the outline', () => {
  expect(extractOutline('Alpha ==two\nlines==<!--flag:rewrite-->\n---\n')[0].text).toBe('Alpha two')
})

test('search neither matches nor shows flag tags, and keeps its positions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-flags-search-'))
  writeFileSync(join(root, 'p.md'), 'First line.\nA ==claim==<!--flag:needs-citation--> here.\n')
  const ws = new Workspace(root)
  expect((await ws.search('needs-citation')).matches).toEqual([])
  const hit = (await ws.search('here')).matches[0]
  expect(hit.snippet.text).toBe('A ==claim== here.')
  expect(hit.snippet.text.slice(hit.snippet.marks[0].column - 1, hit.snippet.marks[0].column - 1 + hit.snippet.marks[0].length)).toBe('here')
  expect([hit.line, hit.column]).toEqual([2, 'A ==claim==<!--flag:needs-citation--> '.length + 1])
  expect(hit.preview).toBe('A ==claim== here.')
})

test('r2 search: nested flags, multi-line comments and regex marks keep their positions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'writeflex-flags-search2-'))
  const nested = '==outer ==inner==<!--flag:expand--> words==<!--flag:rewrite--> tail'
  writeFileSync(join(root, 'n.md'), nested + '\n')
  writeFileSync(join(root, 'm.md'), '==claim==<!--flag:\nrewrite--> after\nlast\n')
  writeFileSync(join(root, 'r.md'), 'A ==claim==<!--flag:rewrite--> here. innocent tail\n')
  const ws = new Workspace(root)
  expect((await ws.search('expand')).matches).toEqual([])
  expect((await ws.search('rewrite')).matches).toEqual([])
  const tail = (await ws.search('tail')).matches.find((m) => m.path === 'n.md')!
  expect(tail.column).toBe(nested.indexOf('tail') + 1)
  expect(tail.column).toBe(64)
  expect(tail.preview).not.toContain('flag')
  expect(tail.snippet.text).toBe('==outer ==inner== words== tail')
  const after = (await ws.search('after')).matches.find((m) => m.path === 'm.md')!
  expect([after.line, after.column]).toEqual([2, 12])
  const last = (await ws.search('last')).matches.find((m) => m.path === 'm.md')!
  expect(last.line).toBe(3)
  const re = (await ws.search('/claim.*here/')).matches.find((m) => m.path === 'r.md')!
  const [mark] = re.snippet.marks
  expect(re.snippet.text.slice(mark.column - 1, mark.column - 1 + mark.length)).toBe('claim== here')
  const [pm] = re.marks
  expect(re.preview.slice(pm.column - 1, pm.column - 1 + pm.length)).toBe('claim== here')
})

test('r3: flags inside wikilink labels, unresolved links and image alt text are plain words', async () => {
  const cases = [
    '[[target|==word==<!--flag:rewrite-->]]',
    '[==word==<!--flag:rewrite-->][missing]',
    '![==secret==<!--flag:rewrite-->](image.png)',
  ]
  for (const source of cases) {
    expect(toPlain(source)).not.toContain('flag:')
    expect(toPlain(source)).not.toContain('==')
    expect(toHtml(source).html).not.toContain('flag:')
    expect(toHtml(source).html).not.toContain('==')
    const piece = await shared(`# T\n\n${source}\n`)
    expect(piece.html).not.toContain('flag:')
    expect(piece.html).not.toContain('==')
  }
})

test('r3: an orphan flag tag is cut in sharing, so deleting a comment never makes a false flag', async () => {
  const piece = await shared('# T\n\nA ==mark==<!--hidden--><!--flag:rewrite-->.\n')
  expect(piece.html).toMatch(/<mark[^>]*>mark<\/mark>/)
  expect(piece.html).not.toContain('flag:')
})
