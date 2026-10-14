import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archivePassage, resolveScoutBinary, searchArchive, type ScoutEnvironment } from '../../src/main/scout'

// A fake `scout`: records its argv (one line per argument) and prints the fixture for the
// subcommand, exiting with the code the fixture directory names. No real engine runs.
let dir = ''
let piece = ''
let fake = ''
const argvLog = () => join(dir, 'argv.log')

const citation = (quote: string, link: string) =>
  `> ${quote}\n\n— Dominik Lukeš, *Repaved paths and generative metaphors: Expressing human purposes with technology*, 23 June 2016 · [archive](${link}) · [public](https://medium.com/p/x)\n`

async function writeFake(search: object | string, cite: object | string, codes: { search?: number; cite?: number; stderr?: string } = {}): Promise<void> {
  await writeFile(join(dir, 'search.json'), typeof search === 'string' ? search : JSON.stringify(search))
  await writeFile(join(dir, 'cite.json'), typeof cite === 'string' ? cite : JSON.stringify(cite))
  await writeFile(fake, `#!/bin/sh
: > "${argvLog()}"
for arg in "$@"; do printf '%s\\n' "$arg" >> "${argvLog()}"; done
${codes.stderr ? `echo "${codes.stderr}" >&2` : ''}
case "$1" in
  search) cat "${join(dir, 'search.json')}"; exit ${codes.search ?? 0} ;;
  cite) cat "${join(dir, 'cite.json')}"; exit ${codes.cite ?? 0} ;;
esac
exit 2
`)
  await chmod(fake, 0o755)
}

const env = (): ScoutEnvironment => ({ override: fake })

const QUOTE = 'But being open to repaving once new paths are trodden alongside those you outlined with your technology is perhaps the most important thing.'

function searchFixture(link: string) {
  return {
    schema_version: 1,
    query: 'paths metaphor',
    corpora: ['writing', 'tweets', 'highlights'],
    total_documents: 1,
    total_passages: 1,
    results: [{
      corpus: 'writing', rel_path: 'blogs/repaved.md', path: piece, title: 'Repaved paths and generative metaphors: Expressing human purposes with technology',
      author: 'Dominik Lukeš', date: '2016-06-23', date_display: '23 June 2016', genre: 'essay', lang: 'en',
      public_url: 'https://medium.com/p/x', score: 12.3, rank: 1, title_match: true, passage_count: 1,
      hits: [{ passage_id: 'writing:blogs/repaved.md:8', line_start: 8, line_end: 8, line: 8, quote: QUOTE, score: 11.1, link }],
      citation: { markdown: citation(QUOTE, link), plain: '…' },
    }],
  }
}

function citeFixture(passage: string) {
  return { schema_version: 1, passage_id: 'writing:blogs/repaved.md:8', corpus: 'writing', rel_path: 'blogs/repaved.md', path: piece, line_start: 8, line_end: 8, quote: passage }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wf-scout-'))
  fake = join(dir, 'scout')
  piece = join(dir, 'repaved.md')
  await writeFile(piece, [
    '---', 'title: Repaved paths', '---', '', '# Repaved paths', '',
    'They simply looked at paths trodden in the grass and then paved them.',
    `Before the quote. ${QUOTE}`,
    'After the quote comes this line.',
    '## Next section',
  ].join('\n'))
})

afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

test('the binary is the override alone, else the first on PATH, else ~/.cargo/bin/scout', async () => {
  const onPath = join(dir, 'bin-a')
  const home = join(dir, 'home')
  await mkdir(onPath, { recursive: true })
  await mkdir(join(home, '.cargo', 'bin'), { recursive: true })
  const cargo = join(home, '.cargo', 'bin', 'scout')
  await writeFile(cargo, '#!/bin/sh\n')
  await chmod(cargo, 0o755)
  // Finder-launched PATH without cargo: the fallback finds it.
  expect(resolveScoutBinary({ pathEnv: '/usr/bin:/bin', home })).toBe(cargo)
  await writeFile(join(onPath, 'scout'), '#!/bin/sh\n')
  await chmod(join(onPath, 'scout'), 0o755)
  expect(resolveScoutBinary({ pathEnv: `relative/dir:${onPath}`, home })).toBe(join(onPath, 'scout'))
  // A non-executable file is not a binary.
  await chmod(join(onPath, 'scout'), 0o644)
  expect(resolveScoutBinary({ pathEnv: onPath, home })).toBe(cargo)
  expect(resolveScoutBinary({ pathEnv: '', home: join(dir, 'nobody') })).toBeNull()
  // An override that does not exist means "absent", never a fallback: the e2e path for the empty state.
  expect(resolveScoutBinary({ override: join(dir, 'missing-scout'), pathEnv: onPath, home })).toBeNull()
})

test('search spawns scout with --json, the scope and -- before the query, and maps the typed result', async () => {
  const link = `writeflex://open?path=${encodeURIComponent(piece)}&line=8`
  await writeFake(searchFixture(link), citeFixture(QUOTE))
  const response = await searchArchive({ query: '  -lakoff paths  ', scope: 'writing', limit: 5 }, env())
  expect((await readFile(argvLog(), 'utf8')).split('\n').filter(Boolean)).toEqual(['search', '--json', '--limit', '5', '--in', 'writing', '--', '-lakoff paths'])
  expect(response.status).toBe('ok')
  if (response.status !== 'ok') return
  expect(response.totalDocuments).toBe(1)
  expect(response.results).toEqual([{
    corpus: 'writing',
    title: 'Repaved paths and generative metaphors: Expressing human purposes with technology',
    author: 'Dominik Lukeš',
    date: '2016-06-23',
    dateDisplay: '23 June 2016',
    genre: 'essay',
    source: null,
    publicUrl: 'https://medium.com/p/x',
    passageId: 'writing:blogs/repaved.md:8',
    line: 8,
    quote: QUOTE,
    link,
    citationMarkdown: citation(QUOTE, link),
  }])
})

test('scope "all" passes no --in; no results (exit 1) is an empty ok, not an error', async () => {
  await writeFake({ schema_version: 1, query: 'zzz', corpora: ['writing'], total_documents: 0, total_passages: 0, results: [] }, '{}', { search: 1 })
  const response = await searchArchive({ query: 'zzz' }, env())
  expect(await readFile(argvLog(), 'utf8')).not.toContain('--in')
  expect(response).toEqual({ status: 'ok', query: 'zzz', corpora: ['writing'], totalDocuments: 0, totalPassages: 0, results: [] })
})

test('a missing binary, a missing index and unparseable output each come back typed, never thrown', async () => {
  expect(await searchArchive({ query: 'x' }, { override: join(dir, 'no-such-scout') })).toEqual({ status: 'missing' })
  await writeFake('', '', { search: 3, stderr: 'scout: no corpus indexed; run scout index build' })
  expect(await searchArchive({ query: 'x' }, env())).toEqual({ status: 'unavailable', message: 'no corpus indexed; run scout index build' })
  await writeFake('not json', '')
  expect((await searchArchive({ query: 'x' }, env())).status).toBe('error')
  await writeFake({ schema_version: 2, results: [] }, '')
  expect(await searchArchive({ query: 'x' }, env())).toEqual({ status: 'error', message: 'scout printed schema 2; WriteFlex reads schema 1.' })
  // An empty query never spawns anything.
  expect(await searchArchive({ query: '   ' }, { override: join(dir, 'no-such-scout') })).toMatchObject({ status: 'ok', results: [] })
})

test('passage cites the id and adds the prose lines around it from a still-matching writing file', async () => {
  await writeFake('{}', citeFixture(`Before the quote. ${QUOTE}`))
  const response = await archivePassage('writing:blogs/repaved.md:8', env())
  expect((await readFile(argvLog(), 'utf8')).split('\n').filter(Boolean)).toEqual(['cite', '--json', '--', 'writing:blogs/repaved.md:8'])
  expect(response).toEqual({
    status: 'ok',
    passage: `Before the quote. ${QUOTE}`,
    before: 'They simply looked at paths trodden in the grass and then paved them.',
    after: 'After the quote comes this line.',
  })
})

test('passage context stops at headings and frontmatter, and a stale index gets none', async () => {
  // Line 7 is prose, but its predecessor is a blank then the heading: only one line of context.
  await writeFake('{}', { ...citeFixture('They simply looked at paths trodden in the grass and then paved them.'), line_start: 7, line_end: 7 })
  expect(await archivePassage('writing:blogs/repaved.md:7', env())).toMatchObject({ before: null, after: `Before the quote. ${QUOTE}` })
  await writeFake('{}', { ...citeFixture('Text that is no longer at line 8.') })
  expect(await archivePassage('writing:blogs/repaved.md:8', env())).toMatchObject({ before: null, after: null })
  await writeFake('{}', { ...citeFixture('A tweet.'), corpus: 'tweets' })
  expect(await archivePassage('tweets:stream/2016-06.md#1:8', env())).toEqual({ status: 'ok', passage: 'A tweet.', before: null, after: null })
  expect(await archivePassage('../etc/passwd', env())).toEqual({ status: 'error', message: 'Invalid passage.' })
})
