import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { collectionQueryInvalidation, evaluateCollectionQuery, parseQuery } from '../../src/main/query-engine'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-query-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

function doc(input: { title?: string; status?: string; description?: string; date?: string; tags?: string[]; purpose?: string; related?: string[]; goal?: number; due?: string; project?: string; body?: string }): string {
  const fields = [
    input.title && `title: ${input.title}`,
    input.status && `status: ${input.status}`,
    input.description && `description: ${input.description}`,
    input.date && `date: ${input.date}`,
    input.tags && `tags: [${input.tags.join(', ')}]`,
    input.purpose && `purpose: ${input.purpose}`,
    input.related && `related: [${input.related.join(', ')}]`,
    input.goal && `goal: ${input.goal}`,
    input.due && `due: ${input.due}`,
    input.project && `project: ${input.project}`,
  ].filter(Boolean)
  return `---\n${fields.join('\n')}\n---\n\n${input.title ? `# ${input.title}\n\n` : ''}${input.body ?? ''}\n`
}

test('parses the complete line-based Query grammar', () => {
  expect(parseQuery('title: Alpha\nstatus: editing, ready\ntags: schemas, metaphor\nfolder: ideas\ngoal: 1200\ndue: 2026-08-15\nproject: book\nwords: 350\nsort: project asc\nlimit: 12')).toEqual({
    ok: true,
    query: {
      title: ['Alpha'],
      status: ['editing', 'ready'],
      tags: ['schemas', 'metaphor'],
      folder: 'ideas',
      goal: ['1200'],
      due: ['2026-08-15'],
      project: ['book'],
      words: ['350'],
      sort: { field: 'project', direction: 'asc' },
      limit: 12,
    },
  })
})

test('every filter field accepts quoted comma values and escaped quotes', () => {
  expect(parseQuery('status: "needs, review", ready\ntags: "language, style", "editor says \\"hold\\""\nproject: "book, one"\npurpose: "draft, revise"')).toEqual({
    ok: true,
    query: {
      status: ['needs, review', 'ready'],
      tags: ['language, style', 'editor says "hold"'],
      project: ['book, one'],
      purpose: ['draft, revise'],
    },
  })
})

test('filters every new field and ordinary Piece metadata without bypassing the one engine', async () => {
  await write('series/a.md', doc({ title: 'Alpha', status: 'editing', description: 'First', date: '2026-08-01', tags: ['metaphor'], purpose: 'essay', related: ['Beta'], goal: 1200, due: '2026-08-15', project: 'book', body: 'one two' }))
  await write('series/b.md', doc({ title: 'Beta', status: 'ready', description: 'Second', date: '2026-08-02', tags: ['other'], purpose: 'note', related: ['Alpha'], goal: 800, due: '2026-09-01', project: 'course', body: 'one' }))

  const cases = [
    ['title: Alpha', 'Alpha'],
    ['date: 2026-08-01', 'Alpha'],
    ['description: First', 'Alpha'],
    ['purpose: essay', 'Alpha'],
    ['related: Beta', 'Alpha'],
    ['goal: 1200', 'Alpha'],
    ['due: 2026-08-15', 'Alpha'],
    ['project: book', 'Alpha'],
    ['words: 4', 'Alpha'],
  ] as const
  for (const [source, expected] of cases) {
    const result = await evaluateCollectionQuery(ws, 'series', source)
    expect(result.ok && result.rows.map((row) => row.title), source).toEqual([expected])
  }
})

test('derived title, date, Unsorted status, and words participate in filters without touching the Piece', async () => {
  await write('series/derived.md', '# Derived heading\n\none two\n')
  const all = await evaluateCollectionQuery(ws, 'series', '')
  if (!all.ok) throw new Error(all.error.message)
  const row = all.rows[0]
  const sources = [
    'title: Derived heading',
    `date: ${row.date}`,
    'status: Unsorted',
    'words: 5',
  ]
  for (const source of sources) {
    const result = await evaluateCollectionQuery(ws, 'series', source)
    expect(result.ok && result.rows.map((item) => item.path), source).toEqual(['series/derived.md'])
  }
})

test('sort supports the new scalar fields and keeps absent values last in both directions', async () => {
  await write('series/a.md', doc({ title: 'Alpha', goal: 1200, due: '2026-08-15', project: 'book' }))
  await write('series/b.md', doc({ title: 'Beta', goal: 800, due: '2026-09-01', project: 'course' }))
  await write('series/c.md', doc({ title: 'Gamma' }))

  const titles = async (source: string): Promise<string[]> => {
    const result = await evaluateCollectionQuery(ws, 'series', source)
    if (!result.ok) throw new Error(result.error.message)
    return result.rows.map((row) => row.title)
  }
  expect(await titles('sort: goal asc')).toEqual(['Beta', 'Alpha', 'Gamma'])
  expect(await titles('sort: due desc')).toEqual(['Beta', 'Alpha', 'Gamma'])
  expect(await titles('sort: project asc')).toEqual(['Alpha', 'Beta', 'Gamma'])
})

test('blank source is a valid Query over every Piece', () => {
  expect(parseQuery('\n  \n')).toEqual({ ok: true, query: {} })
})

test('invalid Query source returns its line and a human-readable message', () => {
  expect(parseQuery('status: editing\norder: newest')).toEqual({
    ok: false,
    error: {
      line: 2,
      message: 'Unknown query key "order".',
      humanReadable: 'Line 2: “order” is not a query field. Use a Piece field, folder, sort, or limit.',
    },
  })
  expect(parseQuery('sort: newest')).toMatchObject({ ok: false, error: { line: 1 } })
  expect(parseQuery('limit: many')).toMatchObject({ ok: false, error: { line: 1 } })
  expect(parseQuery('status editing')).toMatchObject({ ok: false, error: { line: 1 } })
  expect(parseQuery('status: editing\nstatus: ready')).toMatchObject({ ok: false, error: { line: 2 } })
})

test('rejects folder traversal and malformed Collection-relative paths', () => {
  for (const source of ['folder: ../x', 'folder: /abs', 'folder: a//b']) {
    expect(parseQuery(source)).toMatchObject({ ok: false, error: { line: 1 } })
  }
})

test('accepts a trailing slash on a Collection-relative folder', () => {
  expect(parseQuery('folder: essays/')).toEqual({ ok: true, query: { folder: 'essays' } })
})

test('requires an explicit valid sort direction with no extra tokens', () => {
  for (const source of ['sort: title', 'sort: title sideways', 'sort: title asc extra']) {
    expect(parseQuery(source)).toMatchObject({ ok: false, error: { line: 1 } })
  }
})

test('accepts zero limit and rejects signed, negative, and fractional limits', () => {
  expect(parseQuery('limit: 0')).toEqual({ ok: true, query: { limit: 0 } })
  for (const source of ['limit: -1', 'limit: +1', 'limit: 1.5']) {
    expect(parseQuery(source)).toMatchObject({ ok: false, error: { line: 1 } })
  }
})

test('evaluates multi-value filters and returns the projection row shape', async () => {
  await write('series/a.md', doc({ title: 'Alpha', status: 'editing', description: 'First', date: '2026-07-13', tags: ['schemas'], body: 'one two' }))
  await write('series/b.md', doc({ title: 'Beta', status: 'ready', description: 'Second', date: '2026-07-14', tags: ['metaphor'], body: 'one' }))
  await write('series/c.md', doc({ title: 'Gamma', status: 'published', tags: ['other'] }))

  const result = await evaluateCollectionQuery(ws, 'series', 'status: editing, ready\ntags: schemas, metaphor\nsort: title asc')
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.rows).toEqual([
    { path: 'series/a.md', title: 'Alpha', status: 'editing', description: 'First', date: '2026-07-13', words: 4, agentAuthored: false, provenance: { title: 'derived', status: 'written', date: 'written' }, scrapCount: 0, sourceCount: 0, taskOpen: 0, taskDone: 0 },
    { path: 'series/b.md', title: 'Beta', status: 'ready', description: 'Second', date: '2026-07-14', words: 3, agentAuthored: false, provenance: { title: 'derived', status: 'written', date: 'written' }, scrapCount: 0, sourceCount: 0, taskOpen: 0, taskDone: 0 },
  ])
})

test('a bare Piece is returned as Unsorted with heading truth, a derived date, and provenance', async () => {
  await write('series/legacy.md', '---\ntitle: Ignore me\n---\n\n# Visible heading\n')

  const result = await evaluateCollectionQuery(ws, 'series', '')

  expect(result.ok && result.rows[0]).toMatchObject({
    title: 'Visible heading',
    status: 'Unsorted',
    date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    provenance: { title: 'derived', status: 'derived', date: 'derived' },
  })
})

test('supports every sort field, keeps missing values last, and applies limit after sorting', async () => {
  await write('series/a.md', doc({ title: 'Zulu', status: 'published', date: '2026-07-12', body: 'one two three' }))
  await write('series/b.md', doc({ title: 'Alpha', status: 'idea', date: '2026-07-14', body: 'one' }))
  await write('series/c.md', doc({ title: 'Middle', status: 'editing', body: 'one two' }))

  const titles = async (source: string): Promise<string[]> => {
    const result = await evaluateCollectionQuery(ws, 'series', source)
    if (!result.ok) throw new Error(result.error.message)
    return result.rows.map((row) => row.title)
  }
  expect(await titles('sort: date desc')).toEqual(['Middle', 'Alpha', 'Zulu'])
  expect(await titles('sort: title asc')).toEqual(['Alpha', 'Middle', 'Zulu'])
  expect(await titles('sort: status asc')).toEqual(['Alpha', 'Middle', 'Zulu'])
  expect(await titles('sort: words desc\nlimit: 2')).toEqual(['Zulu', 'Middle'])
})

test('sorts filename and Unsorted derivations as real title and status values', async () => {
  await write('series/alpha.md', doc({ title: 'Alpha', status: 'idea' }))
  await write('series/zulu.md', doc({ title: 'Zulu', status: 'published' }))
  await write('series/untitled.md', '---\ndescription: no title or status\n---\n\nbody only\n')

  const paths = async (source: string): Promise<string[]> => {
    const result = await evaluateCollectionQuery(ws, 'series', source)
    if (!result.ok) throw new Error(result.error.message)
    return result.rows.map((row) => row.path)
  }
  expect(await paths('sort: title asc')).toEqual(['series/alpha.md', 'series/untitled.md', 'series/zulu.md'])
  expect(await paths('sort: title desc')).toEqual(['series/zulu.md', 'series/untitled.md', 'series/alpha.md'])
  expect(await paths('sort: status asc')).toEqual(['series/untitled.md', 'series/alpha.md', 'series/zulu.md'])
  expect(await paths('sort: status desc')).toEqual(['series/zulu.md', 'series/alpha.md', 'series/untitled.md'])
})

test('a valid Query may return an empty result without becoming an error', async () => {
  await write('series/a.md', doc({ title: 'Alpha', status: 'editing' }))
  expect(await evaluateCollectionQuery(ws, 'series', 'status: ready')).toEqual({
    ok: true,
    source: 'status: ready',
    query: { status: ['ready'] },
    rows: [],
  })
})

test('folder filters are Collection-relative and agent-notes Pieces carry filesystem provenance', async () => {
  await write('series/ideas/a.md', doc({ title: 'Idea', status: 'idea' }))
  await write('series/agent-notes/report.md', doc({ title: 'Report', status: 'ready' }))
  await write('series/root.md', doc({ title: 'Root', status: 'editing' }))

  const ideas = await evaluateCollectionQuery(ws, 'series', 'folder: ideas')
  expect(ideas.ok && ideas.rows.map((row) => row.path)).toEqual(['series/ideas/a.md'])
  const all = await evaluateCollectionQuery(ws, 'series', 'sort: title asc')
  expect(all.ok && all.rows.find((row) => row.path === 'series/agent-notes/report.md')?.agentAuthored).toBe(true)
  expect(all.ok && all.rows.find((row) => row.path === 'series/root.md')?.agentAuthored).toBe(false)
})

test('a folder filter evaluates an ordinary Index-Note folder as the Collection root', async () => {
  await write('essays/_essays_INDEX.md', doc({ title: 'Essays', status: 'ready' }))
  await write('essays/draft.md', doc({ title: 'Draft', status: 'editing' }))
  await write('essays/ready.md', doc({ title: 'Ready', status: 'ready' }))

  const rail = await evaluateCollectionQuery(ws, 'essays', 'status: editing')
  const inserted = await evaluateCollectionQuery(ws, '', 'folder: essays\nstatus: editing')
  expect(rail.ok && rail.rows.map((row) => row.path)).toEqual(['essays/draft.md'])
  expect(inserted.ok && inserted.rows.map((row) => row.path)).toEqual(rail.ok ? rail.rows.map((row) => row.path) : [])
})

test('a folder filter opens a folder-named Folder Piece as a Collection root', async () => {
  await write('essays/essays.md', doc({ title: 'Essays', status: 'ready' }))
  await write('essays/draft.md', doc({ title: 'Draft', status: 'editing' }))

  const rail = await evaluateCollectionQuery(ws, 'essays', 'status: editing')
  const inserted = await evaluateCollectionQuery(ws, '', 'folder: essays\nstatus: editing')
  expect(inserted.ok && inserted.rows.map((row) => row.path)).toEqual(rail.ok ? rail.rows.map((row) => row.path) : [])
})

test('folder-scoped Unsorted queries match the same scoped Collection population', async () => {
  await write('essays/_essays_INDEX.md', doc({ title: 'Essays', status: 'ready' }))
  await write('essays/bare.md', '# Bare\n')

  const rail = await evaluateCollectionQuery(ws, 'essays', 'status: Unsorted')
  const inserted = await evaluateCollectionQuery(ws, '', 'folder: essays\nstatus: Unsorted')
  expect(inserted.ok && inserted.rows.map((row) => row.path)).toEqual(rail.ok ? rail.rows.map((row) => row.path) : [])
})

test('agent-notes provenance is invariant when the query root is inside agent-notes', async () => {
  await write('series/agent-notes/report.md', doc({ title: 'Report', status: 'ready' }))

  const result = await evaluateCollectionQuery(ws, 'series/agent-notes', '')
  expect(result.ok && result.rows).toEqual([
    expect.objectContaining({ path: 'series/agent-notes/report.md', agentAuthored: true }),
  ])
})

test('Agent notes remain ordinary query Pieces but carry no pipeline status', async () => {
  await write('series/draft.md', doc({ title: 'Draft', status: 'editing' }))
  await write('series/agent-notes/discarded.md', '# Discarded query\n\nMachine record.\n')

  const all = await evaluateCollectionQuery(ws, 'series', 'sort: title asc')
  expect(all.ok && all.rows.map(({ path, status, agentAuthored }) => ({ path, status, agentAuthored }))).toEqual([
    { path: 'series/agent-notes/discarded.md', status: null, agentAuthored: true },
    { path: 'series/draft.md', status: 'editing', agentAuthored: false },
  ])
  const unsorted = await evaluateCollectionQuery(ws, 'series', 'status: Unsorted')
  expect(unsorted.ok && unsorted.rows).toEqual([])
})

test('folder filters distinguish a folder from sibling path prefixes', async () => {
  await write('series/idea/a.md', doc({ title: 'Singular' }))
  await write('series/ideas/b.md', doc({ title: 'Plural' }))

  const result = await evaluateCollectionQuery(ws, 'series', 'folder: idea')
  expect(result.ok && result.rows.map((row) => row.path)).toEqual(['series/idea/a.md'])
})

test('queries return a Folder Piece once and hide every internal file from the parent', async () => {
  await write('series/report/report.md', doc({ title: 'The report', status: 'editing', description: 'one work' }))
  await write('series/report/research/evidence.md', doc({ title: 'Evidence', status: 'ready' }))
  await write('series/report/appendix.md', doc({ title: 'Appendix', status: 'published' }))

  const result = await evaluateCollectionQuery(ws, 'series', '')

  expect(result.ok && result.rows).toEqual([
    expect.objectContaining({
      path: 'series/report/report.md',
      folderPath: 'series/report',
      title: 'The report',
      description: 'one work',
    }),
  ])
})

test('readme, index, and plain Collection roots agree with explicitly addressed queries while the parent folds Folder Pieces', async () => {
  await write('readme-col/README.md', doc({ title: 'Readme Collection', status: 'ready' }))
  await write('readme-col/draft.md', doc({ title: 'Readme Draft', status: 'editing' }))
  await write('index-col/index.md', doc({ title: 'Index Collection', status: 'ready' }))
  await write('index-col/draft.md', doc({ title: 'Index Draft', status: 'editing' }))
  await write('plain-col/_plain-col_INDEX.md', '# Plain Collection\n')
  await write('plain-col/draft.md', doc({ title: 'Plain Draft', status: 'editing' }))

  for (const dir of ['readme-col', 'index-col', 'plain-col']) {
    const rail = await evaluateCollectionQuery(ws, dir, 'status: editing')
    const inserted = await evaluateCollectionQuery(ws, '', `folder: ${dir}\nstatus: editing`)
    expect(rail.ok && rail.rows.map((row) => row.path), dir).toEqual([`${dir}/draft.md`])
    expect(inserted.ok && inserted.rows.map((row) => row.path), dir).toEqual(rail.ok ? rail.rows.map((row) => row.path) : [])
  }

  const parent = await evaluateCollectionQuery(ws, '', '')
  expect(parent.ok && parent.rows.filter((row) => row.folderPath).map((row) => row.folderPath)).toEqual(['index-col', 'readme-col'])
  expect(parent.ok && parent.rows.some((row) => row.path === 'readme-col/draft.md')).toBe(false)
  expect(parent.ok && parent.rows.some((row) => row.path === 'index-col/draft.md')).toBe(false)
})

test('an explicit deeper folder path opens a Folder Piece as a Collection root', async () => {
  await write('essays/report/report.md', doc({ title: 'The report', status: 'editing' }))
  await write('essays/report/research/evidence.md', doc({ title: 'Evidence', status: 'ready' }))

  const result = await evaluateCollectionQuery(ws, '', 'folder: essays/report\nstatus: ready')
  expect(result.ok && result.rows.map((row) => row.path)).toEqual(['essays/report/research/evidence.md'])
})

test('evaluation preserves invalid source beside the structured parse error', async () => {
  expect(await evaluateCollectionQuery(ws, '', 'sort: newest')).toMatchObject({
    ok: false,
    source: 'sort: newest',
    error: { line: 1, humanReadable: expect.any(String) },
  })
})

test('query invalidation payloads are path-addressed, stable, and de-duplicated', () => {
  expect(collectionQueryInvalidation(['series/b.md', 'series/a.md', 'series/b.md'])).toEqual({
    paths: ['series/b.md', 'series/a.md'],
  })
})

async function materialFixture(): Promise<void> {
  await write('schemas/how-humans-hallucinate.md', [
    '---', 'status: editing', 'sources:', '  - research/hall-1976-notes.md', '  - research/bartlett-remembering.md', '  - Minsky, Frames', '---', '',
    '# How humans hallucinate', '', 'As [[Hall 1976 notes]] has it, and [[bartlett-remembering|Bartlett]] and [[kahneman-notes]] agree.',
    'See [[schank-abelson-scripts]], [[frames-and-scripts]] and [[missing-note]].', '',
  ].join('\n'))
  await write('schemas/frames-and-scripts.md', doc({ title: 'Frames and scripts', status: 'idea', body: 'Plain.' }))
  await write('schemas/tools-of-reason.md', doc({ title: 'Tools of reason', status: 'in progress', body: 'Nothing cited.' }))
  await write('schemas/research/hall-1976-notes.md', '# Hall 1976 notes\n\nNotes.\n')
  await write('schemas/research/bartlett-remembering.md', '# Bartlett, Remembering\n')
  await write('schemas/research/kahneman-notes.md', '# Kahneman, Thinking fast and slow\n')
  await write('schemas/research/schank-abelson-scripts.md', '# Schank & Abelson, Scripts\n')
  await write('schemas/scraps/how-humans-hallucinate-SCRAPS.md', [
    '## s_one', "Hall's high and low context cultures: every culture has high and low context areas.", '',
    '## s_two [x]', 'Families share more context than offices.', '',
    '## s_three', 'Offices more than institutions.', '',
  ].join('\n'))
  await write('schemas/scraps/frames-and-scripts-SCRAPS.md', '## s_four\nA list is a promise about order.\n')
}

test('Board rows count each piece\'s scraps by origin and its sources from frontmatter and wikilinked research notes', async () => {
  await materialFixture()

  const result = await evaluateCollectionQuery(ws, 'schemas', '')
  if (!result.ok) throw new Error(result.error.message)
  const row = (path: string) => result.rows.find((candidate) => candidate.path === `schemas/${path}`)

  // Listed: hall, bartlett, "Minsky, Frames" (no file). Cited research: kahneman, schank. Hall and
  // Bartlett are both listed and cited, so they count once; a non-research piece and a dead link never count.
  expect(row('how-humans-hallucinate.md')).toMatchObject({
    scrapCount: 3,
    sourceCount: 5,
    drawer: {
      scraps: [
        { id: 's_one', text: "Hall's high and low context cultures: every culture has high and low context areas.", firstWords: "Hall's high and low context cultures…" },
        { id: 's_two', text: 'Families share more context than offices.', firstWords: 'Families share more context than…' },
      ],
      moreScraps: 1,
      sources: [
        { title: 'Hall 1976 notes', path: 'schemas/research/hall-1976-notes.md' },
        { title: 'Bartlett, Remembering', path: 'schemas/research/bartlett-remembering.md' },
      ],
      moreSources: 3,
    },
  })
  expect(row('frames-and-scripts.md')).toMatchObject({ scrapCount: 1, sourceCount: 0, drawer: { scraps: [{ id: 's_four', firstWords: 'A list is a promise about order.' }], moreScraps: 0, sources: [], moreSources: 0 } })
  expect(row('tools-of-reason.md')).toMatchObject({ scrapCount: 0, sourceCount: 0 })
  expect(row('tools-of-reason.md')).not.toHaveProperty('drawer')
})

test('material counts need no disk read beyond the pieces the query already reads', async () => {
  await materialFixture()
  const reads: string[] = []
  const readFile = ws.readFile.bind(ws)
  ws.readFile = async (path: string) => {
    reads.push(path)
    return readFile(path)
  }

  const result = await evaluateCollectionQuery(ws, 'schemas', '')

  expect(result.ok).toBe(true)
  const markdown = (await ws.listFiles()).map((file) => file.path).filter((path) => path.startsWith('schemas/'))
  // Every Markdown file is read exactly once (scraps files and research notes as Pieces); the only other
  // reads are the Folder Piece manifest probes the query already made before material existed.
  expect(reads.filter((path) => path.endsWith('.md')).sort()).toEqual([...markdown].sort())
})

test('a filtered query still counts material from files the filter leaves out', async () => {
  await materialFixture()

  const result = await evaluateCollectionQuery(ws, 'schemas', 'status: editing')

  expect(result.ok && result.rows.map(({ path, scrapCount, sourceCount }) => ({ path, scrapCount, sourceCount }))).toEqual([
    { path: 'schemas/how-humans-hallucinate.md', scrapCount: 3, sourceCount: 5 },
  ])
})

test('scraps files and research notes are marked as material; a scraps file carries its offcuts', async () => {
  await materialFixture()

  const result = await evaluateCollectionQuery(ws, 'schemas', '')
  if (!result.ok) throw new Error(result.error.message)
  const row = (path: string) => result.rows.find((candidate) => candidate.path === `schemas/${path}`)

  expect(row('research/hall-1976-notes.md')?.material).toBe('research')
  expect(row('how-humans-hallucinate.md')).not.toHaveProperty('material')
  expect(row('scraps/frames-and-scripts-SCRAPS.md')).toMatchObject({
    material: 'scraps',
    offcuts: [{
      id: 's_four', text: 'A list is a promise about order.', firstWords: 'A list is a promise about order.',
      suggestedName: 'A list is a promise about', done: false,
      scrapsPath: 'schemas/scraps/frames-and-scripts-SCRAPS.md', origin: 'schemas/frames-and-scripts.md', originTitle: 'Frames and scripts',
    }],
  })
  const hall = row('scraps/how-humans-hallucinate-SCRAPS.md')?.offcuts ?? []
  expect(hall.map((offcut) => [offcut.id, offcut.done, offcut.originTitle])).toEqual([
    ['s_one', false, 'How humans hallucinate'], ['s_two', true, 'How humans hallucinate'], ['s_three', false, 'How humans hallucinate'],
  ])
  // Hand-written ids carry no cut time, so the scraps file's own date stands in.
  expect(hall[0].cutOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
})
