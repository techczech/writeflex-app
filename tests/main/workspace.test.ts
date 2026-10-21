import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, mkdir, readFile as readFileOnDisk, readdir, writeFile, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Workspace,
  slugifyFileName,
  normaliseMarkdownPath,
  assertRelativeWorkspacePath,
  parseQuery,
  extractFrontmatterTags,
} from '../../src/main/workspace'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-ws-'))
  ws = new Workspace(root)
  await writeFile(join(root, 'alpha.md'), '# Alpha\n\nRiver stories flow.\n')
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes', 'beta.md'), 'Beta line one\nbeta river again\n')
  // One shared mtime, so search's recency rule ties and results keep the listing order.
  const same = new Date('2026-01-01T12:00:00Z')
  await utimes(join(root, 'alpha.md'), same, same)
  await utimes(join(root, 'notes', 'beta.md'), same, same)
  await mkdir(join(root, '.bridle'))
  await writeFile(join(root, '.bridle', 'journal.jsonl'), '')
  await writeFile(join(root, 'ignore.txt'), 'not markdown')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

test('listFiles returns only markdown, sorted, ignoring dot/state dirs', async () => {
  const files = await ws.listFiles()
  expect(files.map((f) => f.path)).toEqual(['alpha.md', 'notes/beta.md'])
  expect(files[1].directory).toBe('notes')
})

test('the Workspace visibility predicate agrees with the Markdown walker', async () => {
  const paths = [
    'visible.md',
    'notes/visible.md',
    '.hidden.md',
    '.git/hidden.md',
    '.bridle/hidden.md',
    '.writeflex/hidden.md',
    '.obsidian/hidden.md',
    'node_modules/hidden.md',
    'out/hidden.md',
    'release/hidden.md',
    '.custom/hidden.md',
  ]
  for (const path of paths) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), '# Note\n')
  }

  const listed = new Set((await ws.listFiles()).map((file) => file.path))
  for (const path of paths) {
    expect(ws.isVisiblePath(path)).toBe(listed.has(path))
  }
})

test('search excludes top-level cache and indexes while the tree listing keeps them', async () => {
  await mkdir(join(root, 'cache'))
  await mkdir(join(root, 'indexes'))
  await writeFile(join(root, 'cache', 'cached.md'), 'private needle\n')
  await writeFile(join(root, 'indexes', 'generated.md'), 'generated needle\n')

  expect((await ws.listFiles()).map((file) => file.path)).toEqual([
    'alpha.md',
    'cache/cached.md',
    'indexes/generated.md',
    'notes/beta.md',
  ])
  expect(await ws.listFolders()).toEqual(['cache', 'indexes', 'notes'])
  expect((await ws.search('needle')).matches).toEqual([])
})

test('listSources reads research/ recursively (not markdown-only), classifies by kind, sorts, ignores dotfiles', async () => {
  expect(await ws.listSources()).toEqual([]) // no research/ dir yet → empty

  await mkdir(join(root, 'research', 'clippings'), { recursive: true })
  await writeFile(join(root, 'research', 'evidence.md'), '# Evidence\n')
  await writeFile(join(root, 'research', 'scan.pdf'), '%PDF-1.4\n')
  await writeFile(join(root, 'research', 'chart.png'), 'PNGDATA')
  await writeFile(join(root, 'research', 'data.csv'), 'a,b\n')
  await writeFile(join(root, 'research', 'clippings', 'note.md'), 'nested\n')
  await writeFile(join(root, 'research', '.DS_Store'), 'junk') // dotfiles are ignored

  const sources = await ws.listSources()
  expect(sources.map((s) => [s.path, s.kind])).toEqual([
    ['research/chart.png', 'image'],
    ['research/clippings/note.md', 'md'],
    ['research/data.csv', 'other'],
    ['research/evidence.md', 'md'],
    ['research/scan.pdf', 'pdf'],
  ])
  const pdf = sources.find((s) => s.name === 'scan.pdf')!
  expect(pdf.size).toBe(Buffer.byteLength('%PDF-1.4\n'))
})

test('absolute() rejects traversal outside the root', () => {
  expect(() => ws.absolute('../evil.md')).toThrow(/outside/i)
  expect(() => ws.absolute('')).toThrow()
})

test('absolute() refuses symlinks that escape the workspace', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'wf-outside-'))
  try {
    await symlink(outside, join(root, 'escape'))
    expect(() => ws.absolute('escape/secret.md')).toThrow(/outside/i)
    // An internal symlink (target still inside the root) must NOT be treated as an escape; the
    // real-path check is a validation gate only, so the return value stays the lexical `resolved`
    // (join(root, ...)) rather than the realpath'd form, keeping every other caller/test that
    // combines absolute() with relative()/dirname() byte-identical.
    await symlink(join(root, 'notes'), join(root, 'inside'))
    expect(ws.absolute('inside/beta.md')).toBe(join(root, 'inside/beta.md'))
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

// listFilesIn must list exactly what listFiles filtered to the folder lists. The whole-workspace walk
// never enters a symlink, so a folder that is one, or lies beneath one, has no listed files.
const seedTree = async (): Promise<void> => {
  for (const file of ['book/01-a.md', 'book/02-b.markdown', 'book/notes.txt', 'book/.hidden/h.md', 'book/node_modules/n.md',
    'book/part/03-c.md', 'book/part/deep/04-d.md', 'bookish/x.md', 'other/o.md', 'shelf/real/book/s.md']) {
    await mkdir(join(root, file, '..'), { recursive: true })
    await writeFile(join(root, file), `# ${file}\n`)
  }
}

test('listFilesIn lists nothing for a folder that is a symlink to a folder inside the root', async () => {
  await seedTree()
  await symlink(join(root, 'book'), join(root, 'linked'))
  expect((await ws.listFilesIn('book')).length).toBeGreaterThan(0)
  expect(await ws.listFilesIn('linked')).toEqual([])
  expect(await ws.listFilesIn('linked', { recursive: false })).toEqual([])
  expect((await ws.listFiles()).filter((file) => file.path.startsWith('linked/'))).toEqual([])
})

test('listFilesIn lists nothing for a folder beneath a symlinked folder', async () => {
  await seedTree()
  await symlink(join(root, 'shelf/real'), join(root, 'shelf/alias'))
  expect((await ws.listFilesIn('shelf/real/book')).map((file) => file.path)).toEqual(['shelf/real/book/s.md'])
  expect(await ws.listFilesIn('shelf/alias/book')).toEqual([])
  await symlink(join(root, 'book'), join(root, 'top'))
  expect(await ws.listFilesIn('top/part/deep')).toEqual([])
})

test('listFilesIn does not enter a symlinked sub-folder or list a symlinked file', async () => {
  await seedTree()
  await symlink(join(root, 'other'), join(root, 'book/borrowed'))
  await symlink(join(root, 'other/o.md'), join(root, 'book/05-linked.md'))
  const expected = ['book/01-a.md', 'book/02-b.markdown', 'book/part/03-c.md', 'book/part/deep/04-d.md']
  expect((await ws.listFilesIn('book')).map((file) => file.path)).toEqual(expected)
  expect((await ws.listFilesIn('book', { recursive: false })).map((file) => file.path)).toEqual(['book/01-a.md', 'book/02-b.markdown'])
  expect((await ws.listFiles()).filter((file) => file.path.startsWith('book/')).map((file) => file.path)).toEqual(expected)
})

test('listFilesIn still throws for a symlinked folder that leaves the root', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'wf-outside-'))
  try {
    await writeFile(join(outside, 'secret.md'), '# Secret\n')
    await symlink(outside, join(root, 'escape'))
    await expect(ws.listFilesIn('escape')).rejects.toThrow(/outside/i)
    await expect(ws.listFilesIn('escape/deeper')).rejects.toThrow(/outside/i)
  } finally {
    await rm(outside, { recursive: true, force: true })
  }
})

test('listFilesIn(dir, recursive) equals listFiles filtered to the folder, for every folder of a tree', async () => {
  await seedTree()
  await symlink(join(root, 'other'), join(root, 'book/borrowed'))
  await symlink(join(root, 'other/o.md'), join(root, 'book/05-linked.md'))
  await symlink(join(root, 'book'), join(root, 'linked'))
  const all = await ws.listFiles()
  const dirs = ['book', 'book/part', 'book/part/deep', 'bookish', 'other', 'notes', 'shelf', 'shelf/real', 'shelf/real/book',
    'book/.hidden', 'book/node_modules', 'book/borrowed', 'linked', 'linked/part', 'missing', 'book/01-a.md', '.bridle']
  let compared = 0
  for (const dir of dirs) {
    expect(await ws.listFilesIn(dir, { recursive: true })).toEqual(all.filter((file) => file.path.startsWith(`${dir}/`)))
    expect(await ws.listFilesIn(dir, { recursive: false })).toEqual(all.filter((file) => file.directory === dir))
    compared += 1
  }
  expect(await ws.listFilesIn('', { recursive: true })).toEqual(all)
  expect((await ws.listFilesIn('book')).length).toBe(4)
  console.log('listFilesIn equivalence', JSON.stringify({ folders: compared, files: all.length }))
})

test('createFile refuses to overwrite and creates parent dirs', async () => {
  const created = await ws.createFile('drafts/new-piece.md', '# New\n')
  expect(created.file.path).toBe('drafts/new-piece.md')
  await expect(ws.createFile('alpha.md', 'x')).rejects.toThrow(/exists/i)
})

test('saveFile round-trips content', async () => {
  await ws.saveFile('alpha.md', '# Alpha v2\n')
  const read = await ws.readFile('alpha.md')
  expect(read.content).toBe('# Alpha v2\n')
})

test('saveEditorText writes nothing when the editor text is the file (CRLF, BOM, mixed), and keeps endings on an edit', async () => {
  // Bug 01: the editor holds LF text; saving an opened, untouched CRLF file must leave its bytes alone.
  const crlf = '# Windows\r\n\r\nalpha\r\n'
  const bom = '\uFEFF# BOM\r\n\r\nbeta\r\n'
  const mixed = '# Mixed\r\nalpha\nbeta\r\n'
  await writeFile(join(root, 'crlf.md'), crlf)
  await writeFile(join(root, 'bom.md'), bom)
  await writeFile(join(root, 'mixed.md'), mixed)
  const old = new Date('2026-01-01T12:00:00Z')
  for (const name of ['crlf.md', 'bom.md', 'mixed.md']) await utimes(join(root, name), old, old)

  // Each save carries the baseline as it is on disk (EditorBaselines.diskText), as the app sends it: main
  // compares bytes (review round 1, Sol M3).
  const seen = (text: string) => ({ kind: 'disk' as const, text })
  const unchanged = await ws.saveEditorText('crlf.md', '# Windows\n\nalpha\n', seen(crlf))
  expect(unchanged.content).toBe(crlf)
  expect(unchanged.file.modifiedAt).toBe(old.getTime()) // no write happened at all
  await ws.saveEditorText('bom.md', '\uFEFF# BOM\n\nbeta\n', seen(bom))
  await ws.saveEditorText('mixed.md', '# Mixed\nalpha\nbeta\n', seen(mixed))
  expect(await readFileOnDisk(join(root, 'bom.md'), 'utf8')).toBe(bom)
  expect(await readFileOnDisk(join(root, 'mixed.md'), 'utf8')).toBe(mixed)
  expect((await ws.readFile('mixed.md')).file.modifiedAt).toBe(old.getTime())

  expect((await ws.saveEditorText('crlf.md', '# Windows\n\nalpha EDIT\n', seen(crlf))).content).toBe('# Windows\r\n\r\nalpha EDIT\r\n')
  expect((await ws.saveEditorText('bom.md', '# BOM\n\nbeta EDIT\n', seen(bom))).content).toBe('\uFEFF# BOM\r\n\r\nbeta EDIT\r\n')
  expect((await ws.saveEditorText('mixed.md', '# Mixed\nalpha EDIT\nbeta\n', seen(mixed))).content).toBe('# Mixed\r\nalpha EDIT\r\nbeta\r\n')
  expect((await ws.saveEditorText('fresh.md', 'new\n', { kind: 'new' })).content).toBe('new\n')
})

test('saveEditorText keeps the empty-write guard', async () => {
  await expect(ws.saveEditorText('alpha.md', '', { kind: 'disk', text: '# Alpha\n\nRiver stories flow.\n' })).rejects.toThrow(/empty save/)
  expect(await readFileOnDisk(join(root, 'alpha.md'), 'utf8')).toBe('# Alpha\n\nRiver stories flow.\n')
})

test('saveFile refuses whitespace over non-empty work, reports the refusal, and rescues both sides', async () => {
  const rejected = ' \n\t'
  let refusal: unknown
  try {
    await ws.saveFile('alpha.md', rejected)
  } catch (error) {
    refusal = error
  }

  expect(refusal).toBeInstanceOf(Error)
  expect(refusal).toMatchObject({
    name: 'EmptyWriteRefusal',
    path: 'alpha.md',
    rescueDirectory: '.writeflex/rescue',
  })
  expect((refusal as Error).message).toContain('WriteFlex prevented an empty save over alpha.md')
  expect((refusal as Error).message).toContain('The previous content is intact')
  expect((refusal as Error).message).toContain('Clear document')
  expect(await readFileOnDisk(join(root, 'alpha.md'), 'utf8')).toBe('# Alpha\n\nRiver stories flow.\n')

  const rescueDir = join(root, '.writeflex', 'rescue')
  const rescueNames = await readdir(rescueDir)
  const previous = rescueNames.find((name) => name.endsWith('--previous.md'))
  const attempted = rescueNames.find((name) => name.endsWith('--rejected.md'))
  expect(previous).toBeTruthy()
  expect(attempted).toBeTruthy()
  expect(await readFileOnDisk(join(rescueDir, previous!), 'utf8')).toBe('# Alpha\n\nRiver stories flow.\n')
  expect(await readFileOnDisk(join(rescueDir, attempted!), 'utf8')).toBe(rejected)
})

test('saveFile keeps empty-file creation, empty-over-empty, and non-empty writes unchanged', async () => {
  expect((await ws.saveFile('new-empty.md', '')).content).toBe('')
  const created = await ws.createFile('empty.md', '')
  expect(created.content).toBe('')
  expect((await ws.saveFile('empty.md', ' \n')).content).toBe(' \n')
  expect((await ws.saveFile('alpha.md', '# Revised\n')).content).toBe('# Revised\n')
})

test('saveFile allows a deliberate emptying only through the explicit override', async () => {
  const cleared = await ws.saveFile('alpha.md', '', { allowExplicitEmpty: true })

  expect(cleared.content).toBe('')
  expect(await readFileOnDisk(join(root, 'alpha.md'), 'utf8')).toBe('')
})

test('renameFile moves within the workspace and normalises extension', async () => {
  const renamed = await ws.renameFile('alpha.md', 'alpha-two')
  expect(renamed.file.path).toBe('alpha-two.md')
  await expect(ws.renameFile('alpha-two.md', '../out')).rejects.toThrow(/outside/i)
})

test('renameTarget: bare names stay in the source folder; slash paths are root-relative', async () => {
  await ws.createFile('notes/inner.md', 'x')
  expect(ws.renameTarget('notes/inner.md', 'renamed')).toBe(join(root, 'notes/renamed.md'))
  expect(ws.renameTarget('notes/inner.md', 'moved/out.md')).toBe(join(root, 'moved/out.md'))
  expect(() => ws.renameTarget('notes/inner.md', '../escape.md')).toThrow(/outside/i)
})

test('search finds case-insensitive matches with line/column/length', async () => {
  const { matches, note } = await ws.search('river')
  expect(note).toBeUndefined()
  expect(matches).toEqual([
    {
      path: 'alpha.md', line: 3, column: 1, length: 5, preview: 'River stories flow.', marks: [{ column: 1, length: 5 }],
      context: { before: ['# Alpha', ''], after: [''] },
      snippet: { text: 'River stories flow.', marks: [{ column: 1, length: 5 }] },
    },
    {
      path: 'notes/beta.md', line: 2, column: 6, length: 5, preview: 'beta river again', marks: [{ column: 6, length: 5 }],
      context: { before: ['Beta line one'], after: [''] },
      snippet: { text: 'beta river again', marks: [{ column: 6, length: 5 }] },
    }
  ])
})

test('search: default-AND of space-separated terms narrows to lines holding both', async () => {
  // 'River stories flow.' (alpha) has river but not beta; 'beta river again' has both.
  const { matches } = await ws.search('beta river')
  expect(matches).toEqual([
    {
      path: 'notes/beta.md', line: 2, column: 1, length: 4, preview: 'beta river again', marks: [{ column: 1, length: 4 }, { column: 6, length: 5 }],
      context: { before: ['Beta line one'], after: [''] },
      snippet: { text: 'beta river again', marks: [{ column: 1, length: 4 }, { column: 6, length: 5 }] },
    }
  ])
})

test('search: /regex/ matches case-insensitively (no literal note)', async () => {
  const { matches, note } = await ws.search('/riv\\w+/')
  expect(note).toBeUndefined()
  expect(matches.map((m) => [m.path, m.line, m.column, m.length])).toEqual([
    ['alpha.md', 3, 1, 5],
    ['notes/beta.md', 2, 6, 5]
  ])
})

test('search: an invalid regex falls back to a literal search and carries note:"literal"', async () => {
  const { matches, note } = await ws.search('/riv(/')
  expect(note).toBe('literal')
  expect(matches).toHaveLength(0) // no line contains the literal text "riv("
  const literal = await ws.search('/river/')
  expect(literal.note).toBeUndefined() // a VALID regex carries no note
})

test('search: tag:x hits a frontmattered file, selecting the tag value', async () => {
  await writeFile(join(root, 'tagged.md'), '---\ntitle: A Piece\ntags:\n  - draft\n  - river\n---\n\n# Body\n')
  const { matches } = await ws.search('tag:draft')
  expect(matches).toHaveLength(1)
  expect(matches[0].path).toBe('tagged.md')
  // The hit lands on the frontmatter list item and selects just the tag value.
  expect(matches[0].preview.slice(matches[0].column - 1, matches[0].column - 1 + matches[0].length)).toBe('draft')
  // A tag not present in the frontmatter matches nothing.
  expect((await ws.search('tag:missing')).matches).toHaveLength(0)
})

test('search: tag:x hits inline [a, b] frontmatter tags (Task 22 — organ replaces block-list-only reader)', async () => {
  // The T14 inline reader saw dashed lists only; the frontmatter organ reads inline lists too, so an
  // inline-tagged file is now findable by tag: (the T14 ledger note, resolved).
  await writeFile(join(root, 'inline.md'), '---\ntitle: Inline\ntags: [draft, river]\n---\n\n# Body\n')
  const draft = await ws.search('tag:draft')
  expect(draft.matches.map((m) => m.path)).toContain('inline.md')
  const river = await ws.search('tag:river')
  expect(river.matches.map((m) => m.path)).toContain('inline.md')
  // A tag not in the inline list still matches nothing on that file.
  expect((await ws.search('tag:missing')).matches.map((m) => m.path)).not.toContain('inline.md')
})

test('search: cat OR dog -bird excludes bird lines in OR mode (fix wave 1)', async () => {
  await writeFile(join(root, 'animals.md'), 'cat on the mat\ndog in the fog\ncat dog bird trio\nbird alone\n')
  await writeFile(join(root, 'birds.md'), 'a cat and a bird\nbird alone\n')
  const { matches } = await ws.search('cat OR dog -bird')
  // One result per piece. animals.md keeps its single-animal lines; the cat/dog line holding 'bird'
  // is filtered out. birds.md's only cat sits on a bird line, so the piece does not match.
  expect(matches.map((m) => [m.path, m.line])).toEqual([['animals.md', 1]])
  // No returned preview or snippet contains the negative term.
  expect(matches.some((m) => m.preview.includes('bird') || m.snippet.text.includes('bird'))).toBe(false)
})

test('search: tag:draft -river returns tagged files minus river lines; matches are lines (fix wave 1)', async () => {
  await writeFile(
    join(root, 'tagged.md'),
    '---\ntags:\n  - draft\n---\n\nMeadow and sky.\nThe river bends here.\nQuiet hills.\n',
  )
  await writeFile(join(root, 'plain.md'), 'river without a tag\nmeadow without a tag\n')
  const { matches } = await ws.search('tag:draft -river')
  // Only the draft-tagged file contributes (plain.md is untagged): one result, which lands on its
  // tag line — there is no positive term to show — and never on the filtered 'river' line.
  expect(matches.map((m) => m.path)).toEqual(['tagged.md'])
  expect(matches[0].preview.includes('river')).toBe(false)
  expect(matches[0].preview.slice(matches[0].column - 1, matches[0].column - 1 + matches[0].length)).toBe('draft')
})

test('parseQuery: literal term reports first case-insensitive hit column/length; misses are null', () => {
  const m = parseQuery('river')
  expect(m.usesLines).toBe(true)
  expect(m.usesTags).toBe(false)
  expect(m.matchLine('A River flows')).toEqual({ column: 3, length: 5 })
  expect(m.matchLine('nothing here')).toBeNull()
})

test('parseQuery: /pattern/ compiles a case-insensitive RegExp', () => {
  const m = parseQuery('/riv.r/')
  expect(m.note).toBeUndefined()
  expect(m.matchLine('a River here')).toEqual({ column: 3, length: 5 })
  expect(m.matchLine('no match')).toBeNull()
})

test('parseQuery: an invalid /regex/ falls back to a literal matcher (note:"literal")', () => {
  const m = parseQuery('/(/')
  expect(m.note).toBe('literal')
  expect(m.matchLine('foo (bar')).toEqual({ column: 5, length: 1 })
})

test('parseQuery: AND (default and explicit) requires every positive term on the line', () => {
  for (const q of ['alpha beta', 'alpha AND beta']) {
    const m = parseQuery(q)
    // Earliest-position positive hit is returned for selection: here beta at column 1.
    expect(m.matchLine('beta then alpha')).toEqual({ column: 1, length: 4 })
    expect(m.matchLine('alpha only')).toBeNull()
  }
})

test('parseQuery: OR matches any positive term; NOT excludes a line', () => {
  const or = parseQuery('cat OR dog')
  expect(or.matchLine('a dog barks')).toEqual({ column: 3, length: 3 })
  expect(or.matchLine('a bird sings')).toBeNull()

  const not = parseQuery('alpha -beta')
  expect(not.matchLine('alpha stands alone')).toEqual({ column: 1, length: 5 })
  expect(not.matchLine('alpha and beta')).toBeNull()
})

test('parseQuery: negatives are a filter in OR mode too (fix wave 1)', () => {
  const m = parseQuery('cat OR dog -bird')
  // OR over cat/dog, but a line holding the negative is excluded regardless of the OR match.
  expect(m.matchLine('a cat sat')).toEqual({ column: 3, length: 3 })
  expect(m.matchLine('a dog ran')).toEqual({ column: 3, length: 3 })
  expect(m.matchLine('cat and bird')).toBeNull() // -bird excludes even though cat matches
  expect(m.matchLine('a bird alone')).toBeNull() // no positive present, and the negative is
})

test('parseQuery: tag + negative filters LINES within tagged files; matches are whole lines (fix wave 1)', () => {
  const m = parseQuery('tag:draft -river')
  expect(m.usesTags).toBe(true)
  expect(m.usesLines).toBe(true) // negatives gated by a tag DO run the per-line pass
  expect(m.matchTags(['draft'])).toBe(true)
  expect(m.matchTags(['idea'])).toBe(false)
  // No positive term to mark: a surviving line is a whole-line hit (column 1, length 0)…
  expect(m.matchLine('a quiet meadow')).toEqual({ column: 1, length: 0 })
  // …and a line holding the negative is excluded.
  expect(m.matchLine('down by the river')).toBeNull()
})

test('parseQuery: a bare all-negative query is a documented no-op (fix wave 1)', () => {
  const m = parseQuery('-foo')
  // No tag: to bound the file set, so neither pass runs — matching every non-foo line workspace-wide
  // would be a useless dump. usesLines/usesTags both false → search returns nothing.
  expect(m.usesLines).toBe(false)
  expect(m.usesTags).toBe(false)
  expect(m.matchLine('anything at all')).toBeNull()
})

test('parseQuery: tag:x is a frontmatter filter; combines with line terms', () => {
  const tagOnly = parseQuery('tag:draft')
  expect(tagOnly.usesTags).toBe(true)
  expect(tagOnly.usesLines).toBe(false)
  expect(tagOnly.matchTags(['draft', 'idea'])).toBe(true)
  expect(tagOnly.matchTags(['idea'])).toBe(false)

  const combo = parseQuery('tag:draft river')
  expect(combo.usesTags).toBe(true)
  expect(combo.usesLines).toBe(true)
  expect(combo.matchTags(['draft'])).toBe(true)
  expect(combo.matchLine('down by the river')).toEqual({ column: 13, length: 5 })
})

test('parseQuery: an empty query matches nothing', () => {
  const m = parseQuery('   ')
  expect(m.usesLines).toBe(false)
  expect(m.usesTags).toBe(false)
  expect(m.matchLine('anything')).toBeNull()
})

test('extractFrontmatterTags reads the block-list tags form', () => {
  const content = '---\ntitle: A Piece\ntags:\n  - draft\n  - "river"\n---\n\n# Body\n'
  expect(extractFrontmatterTags(content)).toEqual(['draft', 'river'])
  expect(extractFrontmatterTags('# No frontmatter\n')).toEqual([])
  expect(extractFrontmatterTags('---\ntitle: t\n---\nno tags key\n')).toEqual([])
})

test('assertRelativeWorkspacePath accepts relative paths, rejects absolute/escaping/empty', () => {
  expect(() => assertRelativeWorkspacePath('a.md')).not.toThrow()
  expect(() => assertRelativeWorkspacePath('dir/a.md')).not.toThrow()
  // Win-style backslashes are literal text under POSIX semantics (favourites are stored POSIX-relative),
  // so the normalised form has no separator and passes the traversal check.
  expect(() => assertRelativeWorkspacePath('..\\out.md')).not.toThrow()
  expect(() => assertRelativeWorkspacePath('')).toThrow(/workspace-relative/)
  expect(() => assertRelativeWorkspacePath('/abs/a.md')).toThrow(/workspace-relative/)
  expect(() => assertRelativeWorkspacePath('../out.md')).toThrow(/workspace-relative/)
  expect(() => assertRelativeWorkspacePath('a/../../out.md')).toThrow(/workspace-relative/)
})

test('slugifyFileName and normaliseMarkdownPath', () => {
  expect(slugifyFileName("My Piece's Title.md")).toBe('my-pieces-title.md')
  expect(normaliseMarkdownPath('notes/idea')).toBe('notes/idea.md')
  expect(normaliseMarkdownPath('notes/idea.markdown')).toBe('notes/idea.markdown')
})
