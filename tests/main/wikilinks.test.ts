import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { collectionLinks, createCollectionStub, extractWikilinks, previewCollectionStub } from '../../src/main/wikilinks'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-wikilinks-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

test('extracts target, display text, source offsets, and prose context', () => {
  expect(extractWikilinks('A sentence about [[Target|the display words]] and more.')).toEqual([
    expect.objectContaining({ target: 'Target', display: 'the display words', raw: '[[Target|the display words]]', from: 17, to: 45, context: 'A sentence about the display words and more.' }),
  ])
})

test('frontmatter offsets address the original CRLF text byte-for-byte', () => {
  const source = '---\r\ntitle: Ref\r\n---\r\n\r\nIntro line here.\r\nSee [[old|the old file]] now.\r\n'

  const [link] = extractWikilinks(source)

  expect(link).toEqual(expect.objectContaining({ target: 'old', raw: '[[old|the old file]]', context: 'See the old file now.' }))
  expect(source.slice(link.from, link.to)).toBe(link.raw)
})

test('CRLF offsets without frontmatter remain original document offsets', () => {
  const source = 'Intro line here.\r\nSee [[old]] now.\r\n'

  const [link] = extractWikilinks(source)

  expect(source.slice(link.from, link.to)).toBe('[[old]]')
})

test('frontmatter offsets remain structural with carriage-return line endings', () => {
  const source = '---\rtitle: "[[metadata]]"\r---\r\rSee [[old]].\r'

  const links = extractWikilinks(source)

  expect(links.map((link) => source.slice(link.from, link.to))).toEqual(['[[old]]'])
})

test('builds a collection-scoped graph with title-first, basename, alias, and dead-link resolution', async () => {
  await write('source.md', '# Source\n\n[[Named]] [[file-stem]] [[Other name]] [[Missing|idea]]\n')
  await write('title.md', '---\ntitle: Named\n---\n\n# Different heading\n')
  await write('file-stem.md', '# A heading that differs\n')
  await write('alias.md', '---\ntitle: Canonical\naliases: [Other name]\n---\n\nBody\n')
  await write('outside.md', '---\ntitle: Missing\n---\n')

  const graph = await collectionLinks(ws, '')
  expect(graph.filter((link) => link.from === 'source.md').map(({ target, display, to }) => ({ target, display, to }))).toEqual([
    { target: 'Named', display: 'Named', to: 'title.md' },
    { target: 'file-stem', display: 'file-stem', to: 'file-stem.md' },
    { target: 'Other name', display: 'Other name', to: 'alias.md' },
    { target: 'Missing', display: 'idea', to: 'outside.md' },
  ])
})

test('resolves markdown-extension link targets against extensionless basenames', async () => {
  await write('source.md', '# Source\n\n[[walk-sample.md]] [[notes.markdown]] [[draft.MDX]]\n')
  await write('walk-sample.md', '# Walk sample\n')
  await write('notes.markdown', '# Notes\n')
  await write('draft.mdx', '# Draft\n')

  const links = (await collectionLinks(ws, '')).filter((link) => link.from === 'source.md')
  expect(links.map(({ target, to }) => ({ target, to }))).toEqual([
    { target: 'walk-sample.md', to: 'walk-sample.md' },
    { target: 'notes.markdown', to: 'notes.markdown' },
    { target: 'draft.MDX', to: 'draft.mdx' },
  ])
})

test('reports ambiguity and resolves it by nearest folder then path order', async () => {
  await write('drafts/source.md', '# Source\n\n[[Shared]]\n')
  await write('drafts/b.md', '---\ntitle: Shared\n---\n')
  await write('drafts/a.md', '---\ntitle: Shared\n---\n')
  await write('other/shared.md', '---\ntitle: Shared\n---\n')

  const [link] = (await collectionLinks(ws, '')).filter((entry) => entry.from === 'drafts/source.md')
  expect(link.to).toBe('drafts/a.md')
  expect(link.ambiguous).toEqual(['drafts/a.md', 'drafts/b.md', 'other/shared.md'])
})

test('creates a seeded Stub in an existing ideas folder for a detected Collection', async () => {
  await write('one.md', '---\ntitle: One\nstatus: editing\ndescription: first\ndate: 2026-07-13\ntags: [one]\n---\n')
  await write('two.md', '---\ntitle: Two\nstatus: ready\ndescription: second\ndate: 2026-07-14\ntags: [two]\n---\n')
  await mkdir(join(root, 'ideas'))

  const result = await createCollectionStub(ws, {
    dir: '', title: 'The gestalt and the frame', gist: 'a brief history of schemas in psychology', from: 'one.md', now: new Date('2026-07-14T12:00:00Z'),
  })
  expect(result.created).toBe(true)
  if (!result.created) return
  expect(result.path).toBe('ideas/the-gestalt-and-the-frame.md')
  expect(result.seeded).toBe(true)
  const saved = await ws.readFile(result.path)
  expect(saved.content).toContain('status: idea')
  expect(saved.content).toContain('description: "a brief history of schemas in psychology"')
  expect(saved.content).toContain('date: 2026-07-14')
  expect(saved.content).toContain('tags: []')
  expect(saved.content).toContain('Backlink: [[One]].')
  expect(saved.content).not.toContain('title:')
})

test('a born Stub writes its date from local calendar components at a timezone boundary', async () => {
  await write('one.md', '---\nstatus: editing\ndate: 2026-08-01\n---\n\n# One\n')
  await write('two.md', '---\nstatus: ready\ndate: 2026-08-01\n---\n\n# Two\n')
  const previous = process.env.TZ
  process.env.TZ = 'Europe/London'
  try {
    const preview = await previewCollectionStub(ws, {
      dir: '', title: 'Boundary', gist: 'Local day', now: new Date('2026-08-01T23:30:00Z'),
    })
    expect(preview.content).toContain('date: 2026-08-02')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('bare-folder materialisation creates plain Markdown and never invents frontmatter', async () => {
  await write('source.md', '# Source\n\n[[Plain idea]]\n')

  const preview = await previewCollectionStub(ws, { dir: '', title: 'Plain idea', gist: 'A thought', from: 'source.md' })
  expect(preview.seeded).toBe(false)
  expect(preview.content.startsWith('---')).toBe(false)
  expect(preview.explanation).toContain('plain Markdown')
  const result = await createCollectionStub(ws, { dir: '', title: 'Plain idea', gist: 'A thought', from: 'source.md' })
  expect(result.created).toBe(true)
  if (result.created) expect((await ws.readFile(result.path)).content.startsWith('---')).toBe(false)
})

test('duplicate titles are surfaced before capture and create-anyway picks a collision-free path', async () => {
  await write('existing.md', '---\ntitle: Same idea\nstatus: idea\n---\n')
  await write('second.md', '---\ntitle: Second\nstatus: idea\n---\n')

  const blocked = await createCollectionStub(ws, { dir: '', title: 'Same idea', gist: 'again' })
  expect(blocked).toEqual({ created: false, existing: ['existing.md'] })
  const created = await createCollectionStub(ws, { dir: '', title: 'Same idea', gist: 'again', createAnyway: true })
  expect(created.created && created.path).toBe('same-idea.md')
})

test('the legacy Stub input still produces byte-identical path and content', async () => {
  await write('one.md', '---\nstatus: editing\ndescription: first\n---\n\n# One\n')
  await write('two.md', '---\nstatus: ready\ndescription: second\n---\n\n# Two\n')

  const preview = await previewCollectionStub(ws, {
    dir: '',
    title: 'Existing caller',
    gist: 'The same bytes as before',
    now: new Date('2026-08-07T10:00:00Z'),
  })

  expect({ path: preview.path, content: preview.content }).toEqual({
    path: 'existing-caller.md',
    content: '---\nstatus: idea\ndescription: "The same bytes as before"\n---\n\n# Existing caller\n\n',
  })
})

test('a Plan-style Stub can suppress a supplied backlink without changing the default', async () => {
  await write('source.md', '# Source\n')
  await write('pattern.md', '---\ntitle: Pattern\nstatus: editing\ndescription: first\n---\n\n# Pattern\n')
  await write('pattern-two.md', '---\ntitle: Pattern two\nstatus: ready\ndescription: second\n---\n\n# Pattern two\n')

  const preview = await previewCollectionStub(ws, {
    dir: '',
    title: 'Plan part',
    gist: 'Exact gloss',
    from: 'source.md',
    titleInFrontmatter: true,
    suppressBacklink: true,
  })

  expect(preview.content).toContain('title: "Plan part"')
  expect(preview.content).toContain('description: "Exact gloss"')
  expect(preview.content).not.toContain('Backlink:')

  const capture = await previewCollectionStub(ws, {
    dir: '',
    title: 'Capture part',
    gist: 'Default flags',
    from: 'source.md',
  })
  expect(capture.content).toContain('Backlink: [[Source]].')
  expect(capture.content).not.toContain('\ntitle:')
})

test('a Collection pattern role key stays blank when the renderer did not supply a role', async () => {
  await write('one.md', '---\nstatus: editing\ndescription: first\nrole: report-body\n---\n\n# One\n')
  await write('two.md', '---\nstatus: ready\ndescription: second\nrole: appendix\n---\n\n# Two\n')

  const preview = await previewCollectionStub(ws, {
    dir: '',
    title: 'Ordinary capture',
    gist: 'No role was selected',
  })

  expect({ blankRole: preview.content.includes('\nrole: \n'), stampedDefault: preview.content.includes('role: "section"') }).toEqual({
    blankRole: true,
    stampedDefault: false,
  })
})

test('an exact Stub destination, role and body lead pass through the existing writer', async () => {
  await write('report/_report_INDEX.md', '# Report\n')
  await write('report/pattern.md', '---\nstatus: editing\ndescription: first\nrole: section\n---\n\n# Pattern\n')
  await write('report/pattern-two.md', '---\nstatus: ready\ndescription: second\nrole: appendix\n---\n\n# Pattern two\n')

  const result = await createCollectionStub(ws, {
    dir: 'report',
    path: 'report/contents/03-findings.md',
    title: 'Findings',
    gist: 'What the evidence shows',
    role: 'summary',
    bodyLead: 'Use the strongest evidence first.',
  })

  expect(result.created).toBe(true)
  if (!result.created) return
  expect(result.path).toBe('report/contents/03-findings.md')
  expect(result.content).toBe(
    '---\nstatus: idea\ndescription: "What the evidence shows"\nrole: "summary"\n---\n\n' +
    '# Findings\n\nUse the strongest evidence first.\n',
  )
})
