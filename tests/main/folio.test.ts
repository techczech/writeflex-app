import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { readManifest, orderFor, draftManifest, orderEntriesByFolio, folioPieces, manifestEntryPointsOutsideFolio, manifestFilePathCandidates, resolveManifestFilePath, MANIFEST_NAME } from '../../src/main/folio'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

// The real report shape: contents/ holds the parts, the manifest at the folder root orders them, and
// two 04- files collide — the manifest's explicit order disambiguates what a prefix sort cannot.
const seedReport = async (): Promise<void> => {
  await write('report/contents/01-intro.md', '# Intro\n\nOne.\n')
  await write('report/contents/02-method.md', '# Method\n\nTwo.\n')
  await write('report/contents/04-results.md', '# Results\n\nThree.\n')
  await write('report/contents/04-appendix.md', '# Appendix\n\nFour.\n')
  await write(
    `report/${MANIFEST_NAME}`,
    JSON.stringify(
      {
        schema_version: 1,
        content_root: 'contents',
        output: 'html/report.html',
        ignored_top_key: 'superset-tolerant',
        files: [
          { path: '01-intro.md', role: 'section' },
          { path: '02-method.md', role: 'section', toc: true },
          { path: '04-results.md', role: 'section' }, // results BEFORE appendix — the reverse of alpha
          { path: '04-appendix.md', role: 'appendix', ignored_file_key: 'ok' },
        ],
      },
      null,
      2,
    ),
  )
}

// ---- readManifest ----

test('readManifest parses schema_version 1, is superset-tolerant, and returns null when absent', async () => {
  await seedReport()
  const folio = await readManifest(ws, 'report')
  expect(folio).not.toBeNull()
  expect(folio!.contentRoot).toBe('contents')
  expect(folio!.output).toBe('html/report.html')
  expect(folio!.files).toHaveLength(4)
  expect(folio!.files[1]).toEqual({ path: '02-method.md', role: 'section', toc: true })
  expect(folio!.files[3].role).toBe('appendix') // unknown per-file keys dropped, known ones kept
  // A folder with no manifest is not a Folio.
  await write('plain/a.md', '# A\n')
  expect(await readManifest(ws, 'plain')).toBeNull()
})

test('readManifest returns null (not a throw) on a malformed manifest', async () => {
  await write(`broken/${MANIFEST_NAME}`, '{ not valid json,,, }')
  expect(await readManifest(ws, 'broken')).toBeNull()
})

// ---- orderFor ----

test('orderFor uses the manifest order (disambiguating the 04- collision), resolved to workspace paths', async () => {
  await seedReport()
  expect(await orderFor(ws, 'report')).toEqual([
    'report/contents/01-intro.md',
    'report/contents/02-method.md',
    'report/contents/04-results.md', // manifest order wins — a prefix+alpha sort would put appendix first
    'report/contents/04-appendix.md',
  ])
})

test('orderFor skips a manifest entry whose file no longer exists', async () => {
  await write('r/contents/01-a.md', '# A\n')
  await write(
    `r/${MANIFEST_NAME}`,
    JSON.stringify({ schema_version: 1, content_root: 'contents', files: [{ path: '01-a.md' }, { path: '99-gone.md' }] }),
  )
  expect(await orderFor(ws, 'r')).toEqual(['r/contents/01-a.md']) // the phantom entry is dropped
})

test('orderFor without a manifest falls back to numeric-prefix-then-alpha over direct children', async () => {
  await write('chapters/01-first.md', '# 1\n')
  await write('chapters/02-second.md', '# 2\n')
  await write('chapters/10-tenth.md', '# 10\n') // 10 sorts AFTER 2 numerically, not as a string
  await write('chapters/notes.md', '# Notes\n') // unnumbered files come last, alpha
  expect(await orderFor(ws, 'chapters')).toEqual([
    'chapters/01-first.md',
    'chapters/02-second.md',
    'chapters/10-tenth.md',
    'chapters/notes.md',
  ])
})

// ---- draftManifest ----

test('draftManifest uses contents when it is the only populated part location', async () => {
  await seedReport()
  const draft = JSON.parse(await draftManifest(ws, 'report'))
  expect(draft.schema_version).toBe(1)
  expect(draft.content_root).toBe('contents')
  // Drafting has no writer intent to encode, so it uses the prefix+alpha order and guesses 'section'.
  expect(draft.files).toEqual([
    { path: '01-intro.md', role: 'section' },
    { path: '02-method.md', role: 'section' },
    { path: '04-appendix.md', role: 'section' },
    { path: '04-results.md', role: 'section' },
  ])
})

test('draftManifest uses the top level when it is the only populated part location', async () => {
  await write('flat/01-a.md', '# A\n')
  await write('flat/02-b.md', '# B\n')
  const draft = JSON.parse(await draftManifest(ws, 'flat'))
  expect(draft.content_root).toBe('')
  expect(draft.files.map((f: { path: string }) => f.path)).toEqual(['01-a.md', '02-b.md'])
})

test('draftManifest prefers numbered contents parts over unnumbered top-level notes', async () => {
  await write('report/notes.md', '# Scratch notes\n')
  await write('report/contents/01-intro.md', '# Intro\n')
  await write('report/contents/02-body.md', '# Body\n')

  const draft = JSON.parse(await draftManifest(ws, 'report'))

  expect(draft.content_root).toBe('contents')
  expect(draft.files).toEqual([
    { path: '01-intro.md', role: 'section' },
    { path: '02-body.md', role: 'section' },
  ])
})

test('draftManifest keeps numbered top-level parts when contents contains a stray file', async () => {
  await write('report/00-strategy.md', '# Strategy\n')
  await write('report/01-understanding.md', '# Understanding\n')
  await write('report/02-moves.md', '# Moves\n')
  await write('report/contents/scratch.md', '# Scratch\n')

  const draft = JSON.parse(await draftManifest(ws, 'report'))

  expect(draft.content_root).toBe('')
  expect(draft.files).toEqual([
    { path: '00-strategy.md', role: 'section' },
    { path: '01-understanding.md', role: 'section' },
    { path: '02-moves.md', role: 'section' },
  ])
})

test('draftManifest seeds every direct Markdown part in fallback order and excludes folder covers', async () => {
  await write('flat/notes.md', '# Notes\n')
  await write('flat/02_second.md', '# Second\n')
  await write('flat/00_first.md', '# First\n')
  await write('flat/_flat_INDEX.md', '# Flat\n')
  await write('flat/_flat.md', '# Legacy cover\n')
  await write('flat/README.md', '# Read me\n')
  await write('flat/index.md', '# Index\n')
  await write('flat/_private-notes.md', '# Private notes\n')

  const draft = JSON.parse(await draftManifest(ws, 'flat'))

  expect(draft.files).toEqual([
    { path: '00_first.md', role: 'section' },
    { path: '02_second.md', role: 'section' },
    { path: 'notes.md', role: 'section' },
  ])
})

test('fallback Folio parts exclude the root Index Note and legacy root cover by the workspace name', async () => {
  const rootName = root.split('/').at(-1)!
  await write(`_${rootName}_INDEX.md`, '# Root index\n')
  await write(`_${rootName}.md`, '# Root cover\n')
  await write('01-opening.md', '# Opening\n')

  const draft = JSON.parse(await draftManifest(ws, ''))

  expect(draft.files).toEqual([{ path: '01-opening.md', role: 'section' }])
})

test('draftManifest refuses a folder with no Markdown parts', async () => {
  await write('empty/source.txt', 'not a report part\n')

  await expect(draftManifest(ws, 'empty')).rejects.toThrow('This folder has no Markdown files to include in a Folio.')
})

// ---- orderEntriesByFolio (the folder-scope reorder the ipc jumps:scan handler applies) ----

test('orderEntriesByFolio reorders file-groups by the manifest, preserving intra-file order, trailing undeclared files', async () => {
  await write('r/01-a.md', '# A\n')
  await write('r/02-b.md', '# B\n')
  await write('r/stray.md', '# Stray\n') // not in the manifest
  await write(`r/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: '02-b.md' }, { path: '01-a.md' }] }))
  const entries = [
    { file: 'r/01-a.md', line: 1 },
    { file: 'r/01-a.md', line: 5 }, // two entries in one file — intra-file order must survive
    { file: 'r/02-b.md', line: 2 },
    { file: 'r/stray.md', line: 1 },
  ]
  const ordered = await orderEntriesByFolio(ws, 'r', entries)
  expect(ordered.map((e) => `${e.file}:${e.line}`)).toEqual([
    'r/02-b.md:2', // manifest puts 02 first
    'r/01-a.md:1',
    'r/01-a.md:5', // 01's two entries stay in their original order
    'r/stray.md:1', // undeclared file trails
  ])
})

test('orderEntriesByFolio leaves a non-Folio folder’s entries untouched', async () => {
  await write('plain/a.md', '# A\n')
  const entries = [{ file: 'plain/b.md', line: 1 }, { file: 'plain/a.md', line: 1 }]
  expect(await orderEntriesByFolio(ws, 'plain', entries)).toEqual(entries) // no manifest → identity
})

test('orderEntriesByFolio orders the canonical report shape: manifest at report/, parts scoped in report/contents', async () => {
  // The outline scopes on the folder that HOLDS the parts (report/contents), while the manifest lives
  // one level up at report/. The ancestor lookup (content_root: contents → report/contents) must find it,
  // so the 04-results/04-appendix pair the manifest exists to disambiguate is ordered, not alpha-sorted.
  await seedReport()
  const entries = [
    { file: 'report/contents/04-appendix.md', line: 1 },
    { file: 'report/contents/01-intro.md', line: 1 },
    { file: 'report/contents/04-results.md', line: 1 },
    { file: 'report/contents/02-method.md', line: 1 },
  ]
  const ordered = await orderEntriesByFolio(ws, 'report/contents', entries)
  expect(ordered.map((e) => e.file)).toEqual([
    'report/contents/01-intro.md',
    'report/contents/02-method.md',
    'report/contents/04-results.md', // manifest puts results before appendix — the reverse of alpha
    'report/contents/04-appendix.md',
  ])
})

// ---- A Folio may only contain pieces inside its own folder (owner's decision, 2026-10-13) ----

const manifestOf = (contentRoot: string, ...paths: string[]): string =>
  JSON.stringify({ schema_version: 1, content_root: contentRoot, files: paths.map((path) => ({ path, role: 'section' })) })

test('a ../ entry is refused: not a candidate, not resolved, reported as outside the Folio folder', async () => {
  await write('journal/private.md', '# Private\n')
  await write('folio/a.md', '# A\n')
  await write(`folio/${MANIFEST_NAME}`, manifestOf('', 'a.md', '../journal/private.md', 'sub/../../journal/private.md'))
  const manifest = (await readManifest(ws, 'folio'))!
  expect(manifestFilePathCandidates('folio', manifest, { path: '../journal/private.md' })).toEqual([])
  expect(resolveManifestFilePath('folio', manifest, { path: '../journal/private.md' }, new Set(['journal/private.md']))).toBeNull()
  expect(await orderFor(ws, 'folio')).toEqual(['folio/a.md'])
  expect(await folioPieces(ws, 'folio')).toEqual({
    pieces: ['folio/a.md'],
    leftOut: [
      { path: '../journal/private.md', reason: 'outside-folio' },
      { path: 'sub/../../journal/private.md', reason: 'outside-folio' },
    ],
  })
})

test('a refused content_root resolves no entry: nothing is re-read relative to the folder, all are left out as outside', async () => {
  await write('journal/private.md', '# Private\n')
  await write('shared/01.md', '# The file the author listed\n')
  await write('folio/01.md', '# A file the author did not list\n')
  await write('folio/a.md', '# A\n')
  for (const refused of ['..', '../shared', '../journal', '/tmp', 'contents/../..', '..\\journal']) {
    await write(`folio/${MANIFEST_NAME}`, manifestOf(refused, '01.md', 'a.md', 'journal/private.md'))
    const manifest = (await readManifest(ws, 'folio'))!
    expect(manifest.contentRoot).toBe('')
    expect(manifest.contentRootRefused).toBe(true)
    const present = new Set(['folio/01.md', 'folio/a.md', 'shared/01.md', 'journal/private.md'])
    for (const file of manifest.files) {
      expect(manifestFilePathCandidates('folio', manifest, file)).toEqual([])
      expect(resolveManifestFilePath('folio', manifest, file, present)).toBeNull()
    }
    expect(await folioPieces(ws, 'folio')).toEqual({
      pieces: [],
      leftOut: [
        { path: '01.md', reason: 'outside-folio' },
        { path: 'a.md', reason: 'outside-folio' },
        { path: 'journal/private.md', reason: 'outside-folio' },
      ],
    })
    expect(await orderFor(ws, 'folio')).toEqual([])
  }
  // A hand-built manifest that still carries the authored root, without the flag, resolves nothing either.
  expect(manifestFilePathCandidates('folio', { contentRoot: '../shared', files: [] }, { path: '01.md' })).toEqual([])
  expect(manifestEntryPointsOutsideFolio('folio', { contentRoot: '../shared', files: [] }, { path: '01.md' })).toBe(true)
})

test('an entry is outside only when it has no place inside the folder; a missing file at a place inside is not found', async () => {
  await write('report/contents/01-intro.md', '# Intro\n')
  await write(`report/${MANIFEST_NAME}`, manifestOf('contents', '01-intro.md', '../x.md', '../../x.md', 'contents/../../../x.md', 'gone.md'))
  const manifest = (await readManifest(ws, 'report'))!
  // `../x.md` under `contents` is `report/x.md`: inside the folder, so it is a file that is not there.
  expect(manifestFilePathCandidates('report', manifest, { path: '../x.md' })).toEqual(['report/x.md'])
  expect(manifestEntryPointsOutsideFolio('report', manifest, { path: '../x.md' })).toBe(false)
  expect(manifestEntryPointsOutsideFolio('report', manifest, { path: '../../x.md' })).toBe(true)
  expect(await folioPieces(ws, 'report')).toEqual({
    pieces: ['report/contents/01-intro.md'],
    leftOut: [
      { path: '../x.md', reason: 'not-found' },
      { path: '../../x.md', reason: 'outside-folio' },
      { path: 'contents/../../../x.md', reason: 'outside-folio' },
      { path: 'gone.md', reason: 'not-found' },
    ],
  })
  await write('report/x.md', '# X\n')
  expect((await folioPieces(ws, 'report'))!.pieces).toEqual(['report/contents/01-intro.md', 'report/x.md'])
})

test('an absolute path is refused, including one that exists and one inside the workspace', async () => {
  await write('folio/a.md', '# A\n')
  await write('folio/etc/passwd.md', '# Not the real one\n')
  const inside = join(root, 'folio/a.md')
  await write(`folio/${MANIFEST_NAME}`, manifestOf('', '/etc/passwd.md', inside, 'C:\\example\\x.md', 'a.md'))
  expect(await folioPieces(ws, 'folio')).toEqual({
    pieces: ['folio/a.md'],
    leftOut: [
      { path: '/etc/passwd.md', reason: 'outside-folio' },
      { path: inside, reason: 'outside-folio' },
      { path: 'C:\\example\\x.md', reason: 'outside-folio' },
    ],
  })
})

test('at the workspace root the workspace is the folder: entries inside resolve, ../ is refused', async () => {
  await write('a.md', '# A\n')
  await write('evidence/b.md', '# B\n')
  await write(MANIFEST_NAME, manifestOf('', 'a.md', 'evidence/b.md', '../outside.md'))
  expect(await folioPieces(ws, '')).toEqual({
    pieces: ['a.md', 'evidence/b.md'],
    leftOut: [{ path: '../outside.md', reason: 'outside-folio' }],
  })
})

test('a listed file that is not there is reported as not found, in its authored spelling', async () => {
  await write('folio/a.md', '# A\n')
  await write(`folio/${MANIFEST_NAME}`, manifestOf('contents', 'a.md', 'gone.md', 'evidence/gone-too.md'))
  expect(await folioPieces(ws, 'folio')).toEqual({
    pieces: ['folio/a.md'],
    leftOut: [{ path: 'gone.md', reason: 'not-found' }, { path: 'evidence/gone-too.md', reason: 'not-found' }],
  })
})

test('an entry listed twice resolves twice, in both positions, as before', async () => {
  await write('folio/a.md', '# A\n')
  await write('folio/b.md', '# B\n')
  await write(`folio/${MANIFEST_NAME}`, manifestOf('', 'a.md', 'b.md', 'a.md'))
  expect(await orderFor(ws, 'folio')).toEqual(['folio/a.md', 'folio/b.md', 'folio/a.md'])
  expect((await folioPieces(ws, 'folio'))!.leftOut).toEqual([])
})

test('ordinary Folios resolve as before: content_root parts, both path conventions, nested appendices, in order', async () => {
  await seedReport()
  await write('report/contents/evidence/deep/passage.md', '# Passage\n')
  await write('report/notes/aside.md', '# Aside\n')
  await write(
    `report/${MANIFEST_NAME}`,
    manifestOf('contents', '04-results.md', 'evidence/deep/passage.md', 'contents/01-intro.md', 'notes/aside.md', './02-method.md'),
  )
  expect(await folioPieces(ws, 'report')).toEqual({
    pieces: [
      'report/contents/04-results.md',
      'report/contents/evidence/deep/passage.md',
      'report/contents/01-intro.md',
      'report/notes/aside.md',
      'report/contents/02-method.md',
    ],
    leftOut: [],
  })
  expect(await folioPieces(ws, 'report/contents')).toBeNull()
})

// The whole-workspace walk never enters a symlink, so a Folio reached through one has no listed files.
test('folioPieces reports every entry as file not found when the Folio folder is a symlink', async () => {
  await write(`real/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: 'sub/b.md' }] }))
  await write('real/a.md', '# A\n')
  await write('real/sub/b.md', '# B\n')
  expect((await folioPieces(ws, 'real'))!.pieces).toEqual(['real/a.md', 'real/sub/b.md'])
  await symlink(join(root, 'real'), join(root, 'alias'))
  expect(await folioPieces(ws, 'alias')).toEqual({
    pieces: [],
    leftOut: [{ path: 'a.md', reason: 'not-found' }, { path: 'sub/b.md', reason: 'not-found' }],
  })
})

test('folioPieces reports every entry as file not found when an ancestor of the Folio folder is a symlink', async () => {
  await write(`shelf/real/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }] }))
  await write('shelf/real/a.md', '# A\n')
  await symlink(join(root, 'shelf'), join(root, 'via'))
  expect((await folioPieces(ws, 'shelf/real'))!.pieces).toEqual(['shelf/real/a.md'])
  expect(await folioPieces(ws, 'via/real')).toEqual({ pieces: [], leftOut: [{ path: 'a.md', reason: 'not-found' }] })
})
