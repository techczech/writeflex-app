import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, stat, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { collectionPattern, collectionPieces, collectionStatus, isStub, listCollection, createIndexNote, createPiece, localCalendarDate, unresolvedFolderPieces, resolvedCollectionPattern, setCollectionPieceMode, setCollectionPieceStatus } from '../../src/main/collection'
import { normaliseCollectionStatus } from '../../src/shared/collection-status'
import { frontmatterKeys, parseFrontmatter } from '../../src/main/frontmatter'
import { UNSORTED_STATUS } from '../../src/shared/collection-status'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-collection-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const piece = (title: string, purpose: string, status: string, body = 'Body.'): string =>
  `---\ntitle: ${title}\npurpose: ${purpose}\nstatus: ${status}\n---\n\n# ${title}\n\n${body}\n`

// ---- Cover resolution (ADR-0008): _<name>_INDEX.md → _<name>.md → README.md → index.md ----

test('the Index Note is the cover; its first paragraph after the H1 is the blurb; it is not a row', async () => {
  await write('drafts/_drafts_INDEX.md', '# drafts\n\nWorking drafts for the metaphor series.\n\nA second paragraph.\n')
  await write('drafts/metaphors.md', piece('metaphors-we-compute-by', 'blog', 'draft'))
  const c = await listCollection(ws, 'drafts')
  expect(c.name).toBe('drafts')
  expect(c.cover).not.toBeNull()
  expect(c.cover!.source).toBe('_drafts_INDEX.md')
  expect(c.cover!.path).toBe('drafts/_drafts_INDEX.md')
  expect(c.cover!.text).toBe('Working drafts for the metaphor series.') // first paragraph only
  // The Index Note is chrome, never a piece.
  expect(c.rows.map((r) => r.name)).toEqual(['metaphors.md'])
})

test('cover falls back through the order; README wins over index.md; none present → null cover', async () => {
  await write('notes/README.md', '# Notes\n\nA folder of loose notes.\n')
  await write('notes/index.md', '# Index\n\nShould not win over README.\n')
  await write('notes/a.md', piece('a', 'note', 'idea'))
  const withReadme = await listCollection(ws, 'notes')
  expect(withReadme.cover!.source).toBe('README.md')
  // README is the cover, so it is excluded; index.md is a plain piece (not an Index Note) and stays.
  expect(withReadme.rows.map((r) => r.name).sort()).toEqual(['a.md', 'index.md'])

  await write('plain/a.md', piece('a', 'note', 'idea'))
  const noCover = await listCollection(ws, 'plain')
  expect(noCover.cover).toBeNull()
  expect(noCover.rows.map((r) => r.name)).toEqual(['a.md'])
})

// ---- Rows: frontmatter promotes; bare files are welcome ----

test('Collection rows derive title and Unsorted while preserving written purpose/status and bare truth', async () => {
  await write('drafts/metaphors.md', piece('metaphors-we-compute-by', 'blog', 'draft'))
  await write('drafts/lakoff-quotes.md', 'Just some quotes, no frontmatter.\n')
  const c = await listCollection(ws, 'drafts')
  const meta = c.rows.find((r) => r.name === 'metaphors.md')!
  expect(meta.title).toBe('metaphors-we-compute-by')
  expect(meta.purpose).toBe('blog')
  expect(meta.status).toBe('draft')
  expect(meta.bare).toBe(false)
  const bare = c.rows.find((r) => r.name === 'lakoff-quotes.md')!
  expect(bare.title).toBe('lakoff-quotes')
  expect(bare.purpose).toBeNull()
  expect(bare.status).toBe('Unsorted')
  expect(bare.bare).toBe(true)
  expect(meta.provenance).toEqual({ title: 'derived', purpose: 'written', status: 'written' })
  expect(bare.provenance).toEqual({ title: 'derived', purpose: 'derived', status: 'derived' })
})

test('empty written values are derived by value in Piece and Collection-row provenance', async () => {
  await write('series/empty.md', '---\nstatus:\npurpose:\nrelated: []\n---\n\n# Empty values\n')
  const [pieceTruth] = await collectionPieces(ws, 'series')
  const [row] = (await listCollection(ws, 'series')).rows
  expect(pieceTruth.provenance).toEqual({ title: 'derived', date: 'derived', status: 'derived', purpose: 'derived', related: 'derived' })
  expect(row.provenance).toEqual({ title: 'derived', purpose: 'derived', status: 'derived' })
})

test('word count ignores the frontmatter block; empty body counts zero', async () => {
  await write('d/full.md', '---\ntitle: T\n---\n\n# Heading\n\nfour words go here\n')
  await write('d/empty.md', '')
  const c = await listCollection(ws, 'd')
  expect(c.rows.find((r) => r.name === 'full.md')!.words).toBe(6) // "Heading" + "four words go here"
  expect(c.rows.find((r) => r.name === 'empty.md')!.words).toBe(0)
})

test('Digest derivation ignores fenced gists and wikilinks and falls back to the Agent note kind', async () => {
  await write('essays/agent-notes/sketch.md', [
    '---',
    'object_kind: mermaid',
    '---',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[[Fenced target]] --> B',
    '```',
    '',
  ].join('\n'))

  const [note] = await collectionPieces(ws, 'essays')
  expect(note.derived.gist).toBe('mermaid sketch')
  expect(note.derived.wikilinks).toEqual([])
})

test('a persisted Agent note gist uses its summary or kind and never Settlement history', async () => {
  await write('essays/agent-notes/summarised.md', [
    '---', 'object_kind: query', '---', '', '# Pieces in editing', '',
    '## Object source', '', '```markdown', '```query', 'status: editing', '```', '```', '',
    '## Settlement history', '', '- accepted — 2026-08-02T13:58:36.447Z', '',
  ].join('\n'))
  await write('essays/agent-notes/fallback.md', [
    '---', 'object_kind: mermaid', '---', '',
    '## Object source', '', '```markdown', '```mermaid', 'flowchart LR', '  A --> B', '```', '```', '',
    '## Settlement history', '', '- discarded — 2026-08-02T14:00:00.000Z', '',
  ].join('\n'))

  const notes = await collectionPieces(ws, 'essays')

  expect(notes.find((note) => note.path.endsWith('summarised.md'))?.derived.gist).toBe('Pieces in editing')
  expect(notes.find((note) => note.path.endsWith('fallback.md'))?.derived.gist).toBe('mermaid sketch')
  expect(notes.map((note) => note.derived.gist).join('\n')).not.toContain('accepted —')
  expect(notes.map((note) => note.derived.gist).join('\n')).not.toContain('discarded —')
})

test('Agent-note gist fallbacks cover fresh, settled, missing-source, and user-authored files', async () => {
  await write('notes/agent-notes/fresh.md', '# Fresh object\n\n## Object source\n\n```markdown\n```query\nstatus: editing\n```\n```\n')
  await write('notes/agent-notes/settled.md', '# Settled object\n\n## Object source\n\n```markdown\n```query\nstatus: editing\n```\n```\n\n## Settlement history\n\n- discarded — 2026-08-02T09:48:00.000Z\n')
  await write('notes/agent-notes/no-source.md', '# Heading without source marker\n\nBody after the heading.\n')
  await write('notes/agent-notes/user.md', 'User prose in an agent-notes folder.\n\n## Settlement history\n\n- accepted — 2026-08-02T09:48:00.000Z\n')

  const pieces = await collectionPieces(ws, 'notes')
  const gists = Object.fromEntries(pieces.map((item) => [item.path, item.derived.gist]))

  expect(gists['notes/agent-notes/fresh.md']).toBe('Fresh object')
  expect(gists['notes/agent-notes/settled.md']).toBe('Settled object')
  expect(gists['notes/agent-notes/no-source.md']).toBe('Heading without source marker')
  expect(gists['notes/agent-notes/user.md']).toBe('User prose in an agent-notes folder.')
})

test('description-less gists are capped at 120 characters with an ellipsis at derivation', async () => {
  await write('essays/long.md', `# Long\n\n${'x'.repeat(2_000)}\n`)

  const [long] = await collectionPieces(ws, 'essays')
  expect(long.derived.gist.length).toBeLessThanOrEqual(120)
  expect(long.derived.gist).toEndWith('…')
})

test('a Collection is the folder’s OWN pieces — nested subfolder files are excluded', async () => {
  await write('report/intro.md', piece('intro', 'report', 'draft'))
  await write('report/sections/one.md', piece('one', 'report', 'draft'))
  const c = await listCollection(ws, 'report')
  expect(c.rows.map((r) => r.name)).toEqual(['intro.md'])
})

// ---- Folder Pieces (0.18, ADR-0033) ------------------------------------------------------------

test('recognises Folder Pieces from work conventions but not undeclared Collection covers', async () => {
  await write('series/folder-named/folder-named.md', '# Folder named\n')
  await write('series/index-note/_index-note_INDEX.md', '# Index note\n')
  await write('series/short-cover/_short-cover.md', '# Short cover\n')
  await write('series/readme/README.md', '# Readme cover\n')
  await write('series/index/index.md', '# Index cover\n')
  await write('series/report/_report-structure.json', JSON.stringify({ content_root: 'contents', files: [{ path: '01-intro.md' }] }))
  await write('series/report/contents/01-intro.md', '# Folio report\n')

  const pieces = await collectionPieces(ws, 'series')

  expect(pieces.map((item) => ({ path: item.path, folderPath: item.folderPath }))).toEqual([
    { path: 'series/folder-named/folder-named.md', folderPath: 'series/folder-named' },
    { path: 'series/index-note/_index-note_INDEX.md', folderPath: undefined },
    { path: 'series/index/index.md', folderPath: 'series/index' },
    { path: 'series/readme/README.md', folderPath: 'series/readme' },
    { path: 'series/report/contents/01-intro.md', folderPath: 'series/report' },
    { path: 'series/short-cover/_short-cover.md', folderPath: undefined },
  ])
})

test('main-document candidacy follows the ruled convention order', async () => {
  await write('series/work/work.md', '# Folder named\n')
  await write('series/work/_report-structure.json', JSON.stringify({ files: [{ path: 'folio.md' }] }))
  await write('series/work/folio.md', '# Folio main\n')
  await write('series/work/README.md', '# Readme\n')
  await write('series/work/index.md', '# Index\n')
  await write('series/work/_work.md', '# Short cover\n')
  await write('series/work/_work_INDEX.md', '# Canonical index\n\nReal prose.\n')

  const main = async (): Promise<string> => (await collectionPieces(ws, 'series'))[0].path
  expect(await main()).toBe('series/work/work.md')
  await unlink(join(root, 'series/work/work.md'))
  expect(await main()).toBe('series/work/folio.md')
  await unlink(join(root, 'series/work/folio.md'))
  expect(await main()).toBe('series/work/README.md')
  await unlink(join(root, 'series/work/README.md'))
  expect(await main()).toBe('series/work/index.md')
  await unlink(join(root, 'series/work/index.md'))
  expect((await collectionPieces(ws, 'series')).some((piece) => piece.folderPath === 'series/work')).toBe(false)
  await setCollectionPieceMode(ws, 'series', 'series/work', 'one')
  expect(await main()).toBe('series/work/_work.md')
  await unlink(join(root, 'series/work/_work.md'))
  expect(await main()).toBe('series/work/_work_INDEX.md')
})

test('one-many-one round-trips preserve the same main document for the four inferred conventions', async () => {
  const conventions = [
    { folder: 'named', path: 'named.md', extra: {} },
    { folder: 'folio', path: 'content.md', extra: { '_report-structure.json': JSON.stringify({ files: [{ path: 'content.md' }] }) } },
    { folder: 'readme', path: 'README.md', extra: {} },
    { folder: 'index', path: 'index.md', extra: {} },
  ]
  for (const convention of conventions) {
    const folderPath = `series/${convention.folder}`
    const mainPath = `${folderPath}/${convention.path}`
    await write(mainPath, `# ${convention.folder}\n\nThe work survives.\n`)
    for (const [name, content] of Object.entries(convention.extra)) await write(`${folderPath}/${name}`, content)
    await write(`${folderPath}/inside.md`, '# Inside\n')

    expect((await collectionPieces(ws, 'series')).find((piece) => piece.folderPath === folderPath)?.path).toBe(mainPath)
    await setCollectionPieceMode(ws, 'series', folderPath, 'many')
    expect((await collectionPieces(ws, 'series')).some((piece) => piece.folderPath === folderPath)).toBe(false)
    await setCollectionPieceMode(ws, 'series', folderPath, 'one')
    expect((await collectionPieces(ws, 'series')).find((piece) => piece.folderPath === folderPath)?.path).toBe(mainPath)
    expect(await readFile(join(root, mainPath), 'utf8')).toContain('The work survives.')
  }
})

test('declared cover conventions round-trip as one work without making undeclared covers Folder Pieces', async () => {
  const conventions = [
    { folder: 'short', path: '_short.md' },
    { folder: 'canonical', path: '_canonical_INDEX.md' },
  ]
  for (const convention of conventions) {
    const folderPath = `series/${convention.folder}`
    const mainPath = `${folderPath}/${convention.path}`
    await write(mainPath, `# ${convention.folder}\n\nThe declared work survives.\n`)
    await write(`${folderPath}/inside.md`, '# Inside\n')

    expect((await collectionPieces(ws, 'series')).some((piece) => piece.folderPath === folderPath)).toBe(false)
    await setCollectionPieceMode(ws, 'series', folderPath, 'one')
    expect((await collectionPieces(ws, 'series')).find((piece) => piece.folderPath === folderPath)?.path).toBe(mainPath)
    await setCollectionPieceMode(ws, 'series', folderPath, 'many')
    expect((await collectionPieces(ws, 'series')).some((piece) => piece.folderPath === folderPath)).toBe(false)
    await setCollectionPieceMode(ws, 'series', folderPath, 'one')
    expect((await collectionPieces(ws, 'series')).find((piece) => piece.folderPath === folderPath)?.path).toBe(mainPath)
  }
})

test('a machine stub Index Note is never a main-document candidate', async () => {
  await write('series/blog/research.md', '# Research\n\nReal work.\n')
  await write('series/blog/_blog_INDEX.md', '---\npiece: one\n---\n\n# blog\n\n')

  expect((await collectionPieces(ws, 'series')).map((piece) => ({ path: piece.path, folderPath: piece.folderPath }))).toEqual([
    { path: 'series/blog/research.md', folderPath: undefined },
  ])
})

test('a Folder Piece title falls back to the folder name rather than its main-document filename', async () => {
  await write('series/Long Report/README.md', 'No heading here.\n')

  const [folderPiece] = await collectionPieces(ws, 'series')

  expect(folderPiece.metadata.title).toBe('Long Report')
  expect((await listCollection(ws, 'series')).rows[0]).toMatchObject({
    title: 'Long Report',
    name: 'Long Report',
    folderPath: 'series/Long Report',
  })
})

test('Folder Piece internals disappear from parent population and its main document counts once in pattern detection', async () => {
  await write('series/direct-a.md', '---\nstatus: idea\npurpose: essay\n---\n# A\n')
  await write('series/direct-b.md', '---\nstatus: ready\n---\n# B\n')
  await write('series/report/report.md', '---\nstatus: editing\npurpose: report\n---\n# Report\n')
  await write('series/report/research/notes.md', '---\nstatus: parked\ninternal-only: yes\n---\n# Notes\n')

  const pieces = await collectionPieces(ws, 'series')

  expect(pieces.map((item) => item.path)).toEqual(['series/direct-a.md', 'series/direct-b.md', 'series/report/report.md'])
  expect(await collectionPattern(ws, 'series')).toEqual({
    keys: ['status', 'purpose'],
    statuses: ['idea', 'editing', 'ready'],
  })
})

test('the one-piece and many-pieces flip is byte-surgical in the canonical Index Note', async () => {
  await write('series/blog/blog.md', '# Blog\n')
  await write('series/blog/research.md', '# Research\n')
  await write('series/blog/_blog_INDEX.md', '---\npurpose: collection\ncustom: keep me\n---\n\n# Blog index\n')

  await setCollectionPieceMode(ws, 'series', 'series/blog', 'many')
  expect(await readFile(join(root, 'series/blog/_blog_INDEX.md'), 'utf8')).toBe(
    '---\npurpose: collection\ncustom: keep me\npiece: many\n---\n\n# Blog index\n',
  )
  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([
    'series/blog/blog.md',
    'series/blog/research.md',
  ])

  await setCollectionPieceMode(ws, 'series', 'series/blog', 'one')
  expect(await readFile(join(root, 'series/blog/_blog_INDEX.md'), 'utf8')).toBe(
    '---\npurpose: collection\ncustom: keep me\npiece: one\n---\n\n# Blog index\n',
  )
  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual(['series/blog/blog.md'])
})

test('piece mode parsing is case-insensitive and trimmed', async () => {
  await write('series/blog/blog.md', '# Blog\n')
  await write('series/blog/research.md', '# Research\n')
  await write('series/blog/_blog_INDEX.md', '---\npiece: " Many "\n---\n\n# blog\n\n')

  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([
    'series/blog/blog.md',
    'series/blog/research.md',
  ])
})

test('content-bearing Index Notes remain Pieces while machine stubs are excluded', async () => {
  await write('series/_series_INDEX.md', '---\npurpose: cover\n---\n\n# Series\n\nThis is real work.\n')
  await write('series/_old_INDEX.md', '---\npiece: many\n---\n\n# old\n\n')
  await write('series/a.md', '# A\n')

  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([
    'series/_series_INDEX.md',
    'series/a.md',
  ])
})

test('a content-bearing Index Note remains the work through a one-many-one flip', async () => {
  const indexPath = 'series/report/_report_INDEX.md'
  await write(indexPath, '---\nstatus: editing\n---\n\n# Report\n\nThe report itself lives here.\n')
  await write('series/report/research.md', '# Research\n')

  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([
    indexPath,
    'series/report/research.md',
  ])
  await setCollectionPieceMode(ws, 'series', 'series/report', 'one')
  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([indexPath])
  await setCollectionPieceMode(ws, 'series', 'series/report', 'many')
  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([
    indexPath,
    'series/report/research.md',
  ])
  await setCollectionPieceMode(ws, 'series', 'series/report', 'one')
  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual([indexPath])
  expect(await readFile(join(root, indexPath), 'utf8')).toContain('The report itself lives here.')
})

test('the flip creates a missing Index Note through the sanctioned creator', async () => {
  await write('series/blog/blog.md', '# Blog\n')

  await setCollectionPieceMode(ws, 'series', 'series/blog', 'many')

  expect(await readFile(join(root, 'series/blog/_blog_INDEX.md'), 'utf8')).toBe(
    '---\npiece: many\n---\n\n# blog\n\n',
  )
})

test('a Board status write for a Folder Piece changes only its main document', async () => {
  await write('series/report/report.md', '---\nstatus: idea\n---\n\n# Report\n')
  await write('series/report/research.md', '---\nstatus: private\n---\n\n# Research\n')
  const [folderPiece] = await collectionPieces(ws, 'series')
  const internalBefore = await readFile(join(root, 'series/report/research.md'), 'utf8')

  await setCollectionPieceStatus(ws, 'series', folderPiece.path, 'editing')

  expect(await readFile(join(root, 'series/report/report.md'), 'utf8')).toContain('status: editing')
  expect(await readFile(join(root, 'series/report/research.md'), 'utf8')).toBe(internalBefore)
})

test('a Folder Piece Board write resolves the parent pattern and never its internal pattern', async () => {
  await write('series/_series_INDEX.md', '---\npattern: [title, status, date]\n---\n\n# Series\n\nParent cover prose.\n')
  await write('series/sibling.md', '---\nstatus: ready\ndate: 2026-08-01\n---\n\n# Sibling\n')
  await write('series/report/report.md', '# Report\n')
  await write('series/report/_report_INDEX.md', '---\npattern: [internal-only, secret-rank]\n---\n\n# Report cover\n\nInside-only declaration.\n')
  await write('series/report/research.md', '---\ninternal-only: yes\nsecret-rank: 7\n---\n\n# Research\n')
  const folderPiece = (await collectionPieces(ws, 'series')).find((item) => item.folderPath === 'series/report')!

  await setCollectionPieceStatus(ws, 'series', folderPiece.path, 'editing')

  const saved = await readFile(join(root, 'series/report/report.md'), 'utf8')
  expect(frontmatterKeys(saved)).toEqual(['status', 'date'])
  expect(parseFrontmatter(saved)).toMatchObject({ status: 'editing', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })
  expect(saved).not.toContain('internal-only:')
  expect(saved).not.toContain('secret-rank:')
})

test('a Folder Piece whose main document vanishes falls back to its many-piece population', async () => {
  await write('series/blog/blog.md', '# Blog\n')
  await write('series/blog/research.md', '# Research\n')
  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual(['series/blog/blog.md'])

  await unlink(join(root, 'series/blog/blog.md'))

  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual(['series/blog/research.md'])
  expect((await listCollection(ws, 'series')).rows).toEqual([])
})

test('a recorded one mode falls back to many when its resolved main document is missing', async () => {
  await write('series/blog/blog.md', '# Blog\n')
  await write('series/blog/research.md', '# Research\n')
  await setCollectionPieceMode(ws, 'series', 'series/blog', 'one')
  await unlink(join(root, 'series/blog/blog.md'))

  expect((await collectionPieces(ws, 'series')).map((item) => item.path)).toEqual(['series/blog/research.md'])
})

test('the Rail can name a declared Folder Piece whose main document vanished', async () => {
  await write('series/report/_report_INDEX.md', '---\npiece: one\n---\n\n# Annual Report\n')
  await write('series/report/notes.md', '# Internal notes\n')

  expect(await unresolvedFolderPieces(ws, 'series')).toEqual([
    { folderPath: 'series/report', title: 'Annual Report' },
  ])
})

test('Collection rows retain recognisable subfolders in both modes for shape selection', async () => {
  await write('series/report/report.md', '# Report\n')
  await write('series/report/research.md', '# Research\n')

  expect((await listCollection(ws, 'series')).rows.find((row) => row.folderPath === 'series/report')).toMatchObject({
    name: 'report',
    folderPieceMode: 'one',
  })
  await setCollectionPieceMode(ws, 'series', 'series/report', 'many')
  expect((await listCollection(ws, 'series')).rows.find((row) => row.folderPath === 'series/report')).toMatchObject({
    name: 'report',
    folderPieceMode: 'many',
  })
})

test('listCollection walks Markdown files once with thirty Folder Pieces', async () => {
  for (let index = 0; index < 30; index += 1) {
    const name = `work-${String(index).padStart(2, '0')}`
    await write(`series/${name}/${name}.md`, `# ${name}\n`)
  }
  const originalListFiles = ws.listFiles.bind(ws)
  let walks = 0
  ws.listFiles = async () => {
    walks += 1
    return originalListFiles()
  }

  const collection = await listCollection(ws, 'series')

  expect(collection.rows.filter((row) => row.folderPath)).toHaveLength(30)
  expect(walks).toBe(1)
})

test('any Index-Note-named file is excluded from rows even when it is not the chosen cover', async () => {
  // _old_INDEX.md doesn't match the folder name, so it isn't the cover — but it is still an Index Note.
  await write('drafts/_drafts_INDEX.md', '# drafts\n\nCover.\n')
  await write('drafts/_old_INDEX.md', '# old\n\nA stale index note.\n')
  await write('drafts/a.md', piece('a', 'blog', 'draft'))
  const c = await listCollection(ws, 'drafts')
  expect(c.cover!.source).toBe('_drafts_INDEX.md')
  expect(c.rows.map((r) => r.name)).toEqual(['a.md'])
})

test('the workspace root is a Collection named after the workspace folder', async () => {
  await write('top.md', piece('top', 'note', 'final'))
  await write(`_${basename(root)}_INDEX.md`, `# ${basename(root)}\n\nThe library cover.\n`)
  const c = await listCollection(ws, '')
  expect(c.name).toBe(basename(root))
  expect(c.cover!.text).toBe('The library cover.')
  expect(c.rows.map((r) => r.name)).toEqual(['top.md'])
})

// ---- The one sanctioned Index-Note write ----

test('createIndexNote writes _<name>_INDEX.md with just the H1, only when absent', async () => {
  await write('drafts/a.md', piece('a', 'blog', 'draft'))
  const path = await createIndexNote(ws, 'drafts')
  expect(path).toBe('drafts/_drafts_INDEX.md')
  expect(existsSync(join(root, 'drafts', '_drafts_INDEX.md'))).toBe(true)
  expect(await readFile(join(root, 'drafts', '_drafts_INDEX.md'), 'utf8')).toBe('# drafts\n\n')
  // Only when absent: a second call must refuse rather than clobber the note.
  await expect(createIndexNote(ws, 'drafts')).rejects.toThrow()
})

// ---- New piece: folder-aware creation ----

test('createPiece creates untitled files inside the folder with the universal fields from birth', async () => {
  const first = await createPiece(ws, 'drafts')
  expect(first).toBe('drafts/untitled.md')
  const firstContent = await readFile(join(root, 'drafts', 'untitled.md'), 'utf8')
  expect(frontmatterKeys(firstContent)).toEqual(['date', 'status', 'purpose', 'related'])
  expect(parseFrontmatter(firstContent)).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), status: '' })
  expect(firstContent).not.toContain('title:')
  expect(firstContent).toEndWith('# untitled\n\n')
  const second = await createPiece(ws, 'drafts')
  expect(second).toBe('drafts/untitled-2.md')
})

test('createPiece is born with a declared pattern, an empty status, a filled date, and no title key', async () => {
  await write('drafts/_drafts_INDEX.md', '---\npattern: [title, date, status, venue]\n---\n\n# drafts\n')

  const path = await createPiece(ws, 'drafts')
  const content = await readFile(join(root, path), 'utf8')

  expect(frontmatterKeys(content)).toEqual(['date', 'status', 'venue'])
  expect(parseFrontmatter(content)).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), status: '', extra: { venue: '' } })
  expect(content).not.toContain('title:')
})

// ---- Collection detection (0.6 W1a): folder shape, never a declaration ----

test('two Pieces carrying collection frontmatter light up the folder', async () => {
  await write('series/one.md', '---\ndescription: First gist\n---\n\nOne.\n')
  await write('series/two.md', '---\ndate: 2026-07-14\n---\n\nTwo.\n')

  expect(await collectionStatus(ws, 'series')).toEqual({
    collection: true,
    signals: {
      frontmatterPattern: true,
      frontmatterPieceCount: 2,
      indexNote: false,
      indexSiblingLinkCount: 0,
      siblingWikilinks: false,
      siblingWikilinkCount: 0,
    },
    pieceCount: 2,
  })
})

test('an index or 0-prefixed tracker linking at least three sibling Pieces lights up the folder', async () => {
  await write('series/0 Tracker.md', '[[One]]\n[[Two|second]]\n[[Three#Section]]\n')
  await write('series/One.md', 'One.\n')
  await write('series/Two.md', 'Two.\n')
  await write('series/Three.md', 'Three.\n')

  const result = await collectionStatus(ws, 'series')
  expect(result.collection).toBe(true)
  expect(result.signals.indexNote).toBe(true)
  expect(result.signals.indexSiblingLinkCount).toBe(3)
  expect(result.pieceCount).toBe(4)
})

test('a wikilink from one sibling Piece to another lights up the folder', async () => {
  await write('series/One.md', 'Continue in [[Two]].\n')
  await write('series/Two.md', 'Two.\n')

  const result = await collectionStatus(ws, 'series')
  expect(result.collection).toBe(true)
  expect(result.signals.siblingWikilinks).toBe(true)
  expect(result.signals.siblingWikilinkCount).toBe(1)
})

test('a bare folder stays bare when thresholds and sibling structure are absent', async () => {
  await write('loose/one.md', 'A bare note linking outside [[Missing]].\n')
  await write('loose/two.md', '---\ntitle: Title alone is not collection stage truth\n---\n\nTwo.\n')
  await write('loose/index.md', '[[one]]\n[[two]]\n')

  expect(await collectionStatus(ws, 'loose')).toEqual({
    collection: false,
    signals: {
      frontmatterPattern: false,
      frontmatterPieceCount: 0,
      indexNote: false,
      indexSiblingLinkCount: 2,
      siblingWikilinks: false,
      siblingWikilinkCount: 0,
    },
    pieceCount: 3,
  })
})

// ---- Piece truth + observed Frontmatter Pattern (ADR-0019) ----

test('a Piece is path plus tolerant frontmatter and derived word-count/mtime truth', async () => {
  await write('series/idea.md', '---\nstatus: idea\ndescription: A seed\ntags: [one, two]\nunknown: kept\n---\n\n# Seed\n\nThree body words.\n')

  const pieces = await collectionPieces(ws, 'series')
  expect(pieces).toHaveLength(1)
  expect(pieces[0].path).toBe('series/idea.md')
  expect(pieces[0].frontmatter?.description).toBe('A seed')
  expect(pieces[0].frontmatter?.extra.unknown).toBe('kept')
  expect(pieces[0].derived.words).toBe(5) // existing Collection count includes the ATX marker token
  expect(pieces[0].derived.mtime).toBeGreaterThan(0)
  expect(isStub(pieces[0])).toBe(true)
})

test('a bare Piece remains queryable but is not a Stub', async () => {
  await write('series/bare.md', '# Bare\n')
  const [bare] = await collectionPieces(ws, 'series')
  expect(bare.frontmatter).toBeNull()
  expect(isStub(bare)).toBe(false)
})

test('Piece metadata derives title, creation date, and Unsorted with per-field provenance', async () => {
  await write('series/bare.md', '---\ntitle: Ignored legacy title\n---\n\n# Heading truth\n')
  const created = localCalendarDate(new Date((await stat(join(root, 'series', 'bare.md'))).birthtimeMs))

  const [bare] = await collectionPieces(ws, 'series')

  expect(bare.metadata).toMatchObject({ title: 'Heading truth', date: created, status: 'Unsorted' })
  expect(bare.provenance).toEqual({ title: 'derived', date: 'derived', status: 'derived', purpose: 'derived', related: 'derived' })
})

test('a stat failure omits only that Piece derived date and does not reject the listing', async () => {
  const fake = {
    listFiles: async () => [{ path: 'series/missing-stat.md', modifiedAt: 1 }],
    readFile: async () => ({ file: { path: 'series/missing-stat.md' }, content: '# Still listed\n' }),
    absolute: () => join(root, 'does-not-exist.md'),
  } as unknown as Workspace
  const pieces = await collectionPieces(fake, 'series')
  expect(pieces).toHaveLength(1)
  expect(pieces[0].metadata.date).toBeNull()
  expect(pieces[0].metadata.title).toBe('Still listed')
})

test('Piece metadata prefers a written date and marks it written', async () => {
  await write('series/dated.md', '---\ndate: 2024-03-14\nstatus: editing\n---\n\n# Dated\n')

  const [dated] = await collectionPieces(ws, 'series')

  expect(dated.metadata.date).toBe('2024-03-14')
  expect(dated.provenance.date).toBe('written')
  expect(dated.provenance.status).toBe('written')
})

test('the detected Collection pattern keeps majority keys and orders observed statuses', async () => {
  await write('series/a.md', '---\nstatus: bespoke\nowner: Dominik\n---\n')
  await write('series/b.md', '---\nstatus: published\ndescription: Done\n---\n')
  await write('series/c.md', '---\nstatus: editing\ntags: [query]\nstatus-note: revise\n---\n')
  await write('series/d.md', '---\nstatus: bespoke\ndate: 2026-07-14\n---\n')

  expect(await collectionPattern(ws, 'series')).toEqual({
    keys: ['status'],
    statuses: ['editing', 'published', 'bespoke'],
  })
})

test('first-touch pattern resolution is declared, then detected, then the universal core, and never title', async () => {
  await write('declared/_declared_INDEX.md', '---\npattern: [title, venue, date, status]\n---\n\n# declared\n')
  await write('declared/piece.md', '# Piece\n')
  await write('detected/a.md', '---\ntitle: Legacy\nowner: Dominik\nstatus: editing\n---\n')
  await write('detected/b.md', '---\nowner: Dominik\nstatus: ready\ndate: 2026-08-01\n---\n')
  await write('legacy/bare.md', '# Bare\n')

  expect(await resolvedCollectionPattern(ws, 'declared')).toEqual(['venue', 'date', 'status'])
  expect(await resolvedCollectionPattern(ws, 'detected', 'detected/bare.md')).toEqual(['owner', 'status'])
  expect(await resolvedCollectionPattern(ws, 'legacy')).toEqual(['date', 'status', 'purpose', 'related'])
})

test('detected first-touch pattern is the sibling majority in the Piece own folder, never recursive union', async () => {
  await write('mixed/a.md', '---\nstatus: idea\nvenue: Meadow Hall\njunk-a: one\n---\n')
  await write('mixed/b.md', '---\nstatus: editing\nvenue: London\njunk-b: two\n---\n')
  await write('mixed/c.md', '---\nstatus: ready\naudience: staff\n---\n')
  await write('mixed/bare.md', '# Bare\n')
  await write('mixed/nested/other.md', '---\nrecursive-junk: no\nstatus: parked\n---\n')

  expect(await resolvedCollectionPattern(ws, 'mixed', 'mixed/bare.md')).toEqual(['status', 'venue'])
})

test('the app-owned Board status write preserves existing metadata values and Piece prose', async () => {
  const original = '---\ntitle: The Piece\nstatus: idea\ndescription: Keep this\n---\n\n# The Piece\n\nBody stays byte-for-byte.\n'
  await write('series/piece.md', original)

  const saved = await setCollectionPieceStatus(ws, 'series', 'series/piece.md', 'note gathering')

  expect(saved.file.path).toBe('series/piece.md')
  expect(saved.content).toBe('---\ntitle: The Piece\nstatus: note gathering\ndescription: Keep this\n---\n\n# The Piece\n\nBody stays byte-for-byte.\n')
  expect(await readFile(join(root, 'series', 'piece.md'), 'utf8')).toBe(saved.content)
})

test('first touch in a bare legacy Collection writes exactly the universal core to exactly one Piece', async () => {
  await write('legacy/one.md', '# One\n')
  await write('legacy/two.md', '# Two\n')
  const beforeTwo = await readFile(join(root, 'legacy', 'two.md'), 'utf8')

  const saved = await setCollectionPieceStatus(ws, 'legacy', 'legacy/one.md', 'editing')

  expect(frontmatterKeys(saved.content)).toEqual(['date', 'status', 'purpose', 'related'])
  expect(parseFrontmatter(saved.content)).toMatchObject({
    date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    status: 'editing',
    purpose: '',
  })
  expect(saved.content).not.toContain('title:')
  expect(await readFile(join(root, 'legacy', 'two.md'), 'utf8')).toBe(beforeTwo)
})

test('first touch writes exactly a declared pattern plus the chosen status, never title', async () => {
  await write('declared/_declared_INDEX.md', '---\npattern: [title, status, venue]\n---\n\n# declared\n')
  await write('declared/piece.md', '# Piece\n')

  const saved = await setCollectionPieceStatus(ws, 'declared', 'declared/piece.md', 'idea')

  expect(frontmatterKeys(saved.content)).toEqual(['status', 'venue'])
  expect(parseFrontmatter(saved.content)).toMatchObject({ status: 'idea', extra: { venue: '' } })
  expect(saved.content).not.toContain('date:')
  expect(saved.content).not.toContain('title:')
})

test('a status write preserves an unindented tags list byte-for-byte apart from changed and appended keys', async () => {
  const original = '---\ntags:\n- alpha\n- beta\nstatus: idea\n---\n\n# Piece\n'
  await write('series/_series_INDEX.md', '---\npattern: [tags, status, venue]\n---\n\n# Series\n')
  await write('series/piece.md', original)
  const saved = await setCollectionPieceStatus(ws, 'series', 'series/piece.md', 'editing')
  expect(saved.content).toBe('---\ntags:\n- alpha\n- beta\nstatus: editing\nvenue: ""\n---\n\n# Piece\n')
})

test('first touch does not swallow a thematic-break pull quote', async () => {
  const original = '---\nA pull quote opening the piece.\n---\n\n# Heading\n\nProse.\n'
  await write('legacy/piece.md', original)
  const saved = await setCollectionPieceStatus(ws, 'legacy', 'legacy/piece.md', 'editing')
  expect(saved.content).toEndWith(original)
  expect(saved.content).toStartWith('---\ndate:')
})

test('an unsafe changed key surfaces the file and key while leaving the Piece untouched', async () => {
  const original = '---\nstatus: |\n  editing\npurpose: essay\n---\n\n# Piece\n'
  await write('series/piece.md', original)
  await expect(setCollectionPieceStatus(ws, 'series', 'series/piece.md', 'ready')).rejects.toThrow(/series\/piece\.md.*status/)
  expect(await readFile(join(root, 'series', 'piece.md'), 'utf8')).toBe(original)
})

test('an unsafe unrelated entry refuses the whole Board status write and leaves the Piece untouched', async () => {
  const original = '---\nstatus: idea\nauthors:\n  - name: Ada\n---\n\n# Piece\n'
  await write('series/piece.md', original)

  await expect(setCollectionPieceStatus(ws, 'series', 'series/piece.md', 'ready')).rejects
    .toThrow(/series\/piece\.md.*cannot safely rewrite this block: line 4 reads .*name: Ada/)
  expect(await readFile(join(root, 'series', 'piece.md'), 'utf8')).toBe(original)
})

test('same-status writes are a main-process no-op', async () => {
  const original = '---\nstatus: editing\n---\n\n# Piece\n'
  await write('series/piece.md', original)
  const before = await stat(join(root, 'series', 'piece.md'))
  await Bun.sleep(20)
  const result = await setCollectionPieceStatus(ws, 'series', 'series/piece.md', 'editing')
  const after = await stat(join(root, 'series', 'piece.md'))
  expect(result.content).toBe(original)
  expect(after.mtimeMs).toBe(before.mtimeMs)
})

test('Collection status validation accepts unknown lanes and rejects unsafe scalar shapes', () => {
  expect(normaliseCollectionStatus('  parked  ')).toBe('parked')
  expect(() => normaliseCollectionStatus('')).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('x'.repeat(65))).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('two\nlanes')).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('two\u2028lanes')).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('two\u2029lanes')).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('two\u0085lanes')).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('"quoted"')).toThrow('Invalid Collection status')
  expect(() => normaliseCollectionStatus('stage: broken')).toThrow('Invalid Collection status')
})

test('Collection containment rejects a traversal-shaped Piece path', async () => {
  await write('outside.md', '# Outside\n')
  const before = await readFile(join(root, 'outside.md'), 'utf8')
  await expect(setCollectionPieceStatus(ws, 'series', 'series/../outside.md', 'editing')).rejects.toThrow('outside its Collection')
  expect(await readFile(join(root, 'outside.md'), 'utf8')).toBe(before)
})

test('localCalendarDate uses local calendar components at a timezone boundary', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Europe/London'
  try {
    expect(localCalendarDate(new Date('2026-08-01T23:30:00Z'))).toBe('2026-08-02')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('moving a Piece back to Unsorted clears its written status value', async () => {
  await write('series/piece.md', '---\ndate: 2026-08-01\nstatus: editing\npurpose: essay\nrelated: [One]\n---\n\n# Piece\n')

  const saved = await setCollectionPieceStatus(ws, 'series', 'series/piece.md', UNSORTED_STATUS)

  expect(frontmatterKeys(saved.content)).toEqual(['date', 'status', 'purpose', 'related'])
  expect(parseFrontmatter(saved.content)?.status).toBe('')
  expect(parseFrontmatter(saved.content)?.purpose).toBe('essay')
})

test('a Folder Piece never takes its main document from a manifest entry outside its folder', async () => {
  await write('journal/private.md', '# Private\n')
  await write('series/escape/_report-structure.json', JSON.stringify({ content_root: '', files: [{ path: '../../journal/private.md' }] }))
  await write('series/root-escape/_report-structure.json', JSON.stringify({ content_root: '../../journal', files: [{ path: 'private.md' }] }))
  await write('series/report/_report-structure.json', JSON.stringify({ content_root: 'contents', files: [{ path: '../../../journal/private.md' }, { path: '01-intro.md' }] }))
  await write('series/report/contents/01-intro.md', '# Folio report\n')
  // A refused content_root is not re-read relative to the folder: the file of the same name inside
  // stays an ordinary piece and is not made the folder's main document.
  await write('series/root-escape/private.md', '# Not the listed file\n')

  const pieces = await collectionPieces(ws, 'series')

  expect(pieces.map((item) => ({ path: item.path, folderPath: item.folderPath }))).toEqual([
    { path: 'series/report/contents/01-intro.md', folderPath: 'series/report' },
    { path: 'series/root-escape/private.md', folderPath: undefined },
  ])
})
