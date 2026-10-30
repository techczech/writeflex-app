import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { Workspace } from '../../src/main/workspace'
import { exportBundle, exportDocument, exportFileName, suggestedName } from '../../src/main/export'
import { exportCollectionTitle } from '../../src/main/export-title'
import { readManifest } from '../../src/main/folio'
import { exportBundleRequest, exportDocumentRequest } from '../../src/main/export-ipc'
import { writeFixture } from '../helpers/cli-write-fixture'

let root: string
let out: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-title-source-'))
  out = await mkdtemp(join(tmpdir(), 'wf-title-output-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})
async function write(path: string, content: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}
/** `index` and `page`: the Index Note's (the Details') and the title page's declared titles; null leaves them out. */
async function folio(title: unknown = 'Declared report title', { index = 'Index metadata title', page = 'Title matter metadata' }: { index?: string | null; page?: string | null } = {}): Promise<void> {
  await write('machine-folder-slug/_report-structure.json', JSON.stringify({
    title, content_root: 'contents', title_matter: '00-frontmatter.md',
    files: [{ path: '00-frontmatter.md' }, { path: '01-analysis.md' }],
  }))
  await write('machine-folder-slug/_machine-folder-slug_INDEX.md', `---\n${index === null ? 'tags: [a]' : `title: ${index}`}\n---\n\n# Index heading\n`)
  await write('machine-folder-slug/contents/00-frontmatter.md', `---\n${page === null ? '' : `title: ${page}\n`}heading: none\nprivate: PRIVATE_CANARY\n---\n\nOpening prose.\n`)
  await write('machine-folder-slug/contents/01-analysis.md', '---\ntitle: Analysis title\n---\n\n# Analysis title\n\n[Opening](00-frontmatter.md)\n\n| A | B |\n| --- | --- |\n| one | two |\n')
}
async function bundle(): Promise<string> {
  const target = join(out, 'folio.html')
  await exportBundle(ws, exportBundleRequest({ dir: 'machine-folder-slug', format: 'html', target, html: { frontPage: true } }))
  return readFile(target, 'utf8')
}
function expectReportTitle(html: string, title: string): void {
  expect(html).toContain(`<title>${title}</title>`)
  expect(html).toContain(`<h1>${title}</h1>`)
  expect(html).toContain(`<h2 class="sidebar-title">${title}</h2>`)
}

const NO_DECLARED = { index: null, page: null }

test('an Index Note that is listed but unreadable falls back to the next title instead of throwing', async () => {
  await folio('Manifest title', { index: 'Index title', page: null })
  const index = join(root, 'machine-folder-slug/_machine-folder-slug_INDEX.md')
  await chmod(index, 0o000)
  try {
    expect(await exportCollectionTitle(ws, 'machine-folder-slug')).toBe('Manifest title')
  } finally {
    await chmod(index, 0o644)
  }
})

test('manifest titles reach browser, cover, masthead, navigation and save suggestions through the app export request', async () => {
  // The manifest's title is used when neither the Details (Index Note) nor the title page declares one.
  await folio(undefined, NO_DECLARED)
  expect((await readManifest(ws, 'machine-folder-slug'))?.title).toBe('Declared report title')
  const html = await bundle()
  expectReportTitle(html, 'Declared report title')
  expect(html).not.toContain('machine-folder-slug')
  expect(html).not.toContain('PRIVATE_CANARY')
  // The title_matter file is the title page and so the cover (ADR-0046): the link to it lands on the cover.
  expect(html).toContain('href="#wf-title-page"')
  expect(html).toContain('id="wf-title-page"')
  expect(html).toContain('<table')
  expect(html.indexOf('Opening prose.')).toBeLessThan(html.indexOf('<table'))
  expect(await suggestedName(ws, { scope: 'collection', dir: 'machine-folder-slug', format: 'html' })).toBe('Declared report title.html')
  await folio('Revised report title', NO_DECLARED)
  expectReportTitle(await bundle(), 'Revised report title')
})

test('one title for cover, browser title and file name: the Details, then the title page, then the manifest (Sol round 2, finding 4)', async () => {
  // A Folio with no title page: the generated cover takes the Details title over the manifest's.
  await folio('Old title', { index: 'New title', page: null })
  const path = 'machine-folder-slug/_report-structure.json'
  const manifest = JSON.parse(await readFile(join(root, path), 'utf8'))
  delete manifest.title_matter
  manifest.files = [{ path: '01-analysis.md' }]
  await write(path, JSON.stringify(manifest))
  let html = await bundle()
  expectReportTitle(html, 'New title')
  expect(html).not.toContain('Old title')
  expect(await suggestedName(ws, { scope: 'collection', dir: 'machine-folder-slug', format: 'html' })).toBe('New title.html')
  // With a title page: the cover, the browser title and the file name all take the Details title.
  await folio('Old title', { index: 'New title', page: 'Title page title' })
  html = await bundle()
  expectReportTitle(html, 'New title')
  expect(html).toContain('id="wf-title-page"')
  expect(html).not.toContain('Old title')
  expect(await suggestedName(ws, { scope: 'collection', dir: 'machine-folder-slug', format: 'html' })).toBe('New title.html')
  expect(html).toContain('<h1 class="front-page-title">New title</h1>')
  // No Details title: the title page's, over the manifest's.
  await folio('Old title', { index: null, page: 'Title page title' })
  expectReportTitle(await bundle(), 'Title page title')
  expect(await suggestedName(ws, { scope: 'collection', dir: 'machine-folder-slug', format: 'html' })).toBe('Title page title.html')
  // Neither declares one: the cover drawn from the title page takes the manifest's too, as the browser title does.
  await folio('Old title', NO_DECLARED)
  html = await bundle()
  expectReportTitle(html, 'Old title')
  expect(html).toContain('<h1 class="front-page-title">Old title</h1>')
  expect(await suggestedName(ws, { scope: 'collection', dir: 'machine-folder-slug', format: 'html' })).toBe('Old title.html')
})

test('blank or invalid manifest titles fall through to the next declared title', async () => {
  for (const title of ['', '   ', 42, ['not a title']]) {
    await folio(title, { index: null })
    expectReportTitle(await bundle(), 'Title matter metadata')
    await folio(title, NO_DECLARED)
    expectReportTitle(await bundle(), 'Index heading')
  }
})

test('Index metadata precedes a title-matter heading when no title matter metadata is declared', async () => {
  await folio('')
  await write('machine-folder-slug/contents/00-frontmatter.md', '# Title matter heading\n\nOpening.\n')
  expectReportTitle(await bundle(), 'Index metadata title')
})

test('an external title-matter path is never read as the Folio title', async () => {
  await folio('')
  await write('outside.md', '---\ntitle: PRIVATE_OUTSIDE_TITLE\n---\n\n# Private\n')
  const path = 'machine-folder-slug/_report-structure.json'
  const manifest = JSON.parse(await readFile(join(root, path), 'utf8'))
  manifest.title_matter = '../../outside.md'
  await write(path, JSON.stringify(manifest))
  expectReportTitle(await bundle(), 'Index metadata title')
  expect(await bundle()).not.toContain('PRIVATE_OUTSIDE_TITLE')
})

test('a metadata-free collection uses its Index heading, and never exposes an unlabelled folder name', async () => {
  await write('machine-folder-slug/body.md', '# Body\n\nProse.\n')
  await write('machine-folder-slug/_machine-folder-slug_INDEX.md', '# Human collection title\n')
  expectReportTitle(await bundle(), 'Human collection title')
  await write('machine-folder-slug/_machine-folder-slug_INDEX.md', 'No title.\n')
  expectReportTitle(await bundle(), 'Untitled collection')
})

test('single-piece metadata names a heading-free export, its metadata and suggested filename', async () => {
  await write('01-file-slug.md', '---\ntitle: Declared piece title\nheading: none\n---\n\nOnly prose.\n')
  const target = join(out, 'piece.html')
  await exportDocument(ws, exportDocumentRequest({ path: '01-file-slug.md', format: 'html', target }))
  const html = await readFile(target, 'utf8')
  expectReportTitle(html, 'Declared piece title')
  expect(html).not.toContain('01-file-slug')
  expect(await suggestedName(ws, { scope: 'piece', path: '01-file-slug.md', format: 'docx' })).toBe('Declared piece title.docx')
  await write('01-file-slug.md', '---\ntitle: Revised title\n---\n\n# Different heading\n\nOnly prose.\n')
  await exportDocument(ws, { path: '01-file-slug.md', format: 'html', target })
  expectReportTitle(await readFile(target, 'utf8'), 'Revised title')
})

test('pieces without declared metadata retain meaningful headings but never use filenames for an absent title', async () => {
  await write('01-file-slug.md', '# Human heading\n\nProse.\n')
  expect(await suggestedName(ws, { scope: 'piece', path: '01-file-slug.md', format: 'html' })).toBe('Human heading.html')
  await write('01-file-slug.md', 'Only prose.\n')
  expect(await suggestedName(ws, { scope: 'piece', path: '01-file-slug.md', format: 'html' })).toBe('Untitled document.html')
})

test('the real CLI operation resolves Folio and heading-free piece titles from the same metadata', async () => {
  const fx = await writeFixture()
  try {
    await mkdir(join(fx.root, 'folio'), { recursive: true })
    await writeFile(join(fx.root, 'folio/_report-structure.json'), JSON.stringify({ title: 'CLI report title', files: [{ path: 'part.md' }] }))
    await writeFile(join(fx.root, 'folio/part.md'), '---\ntitle: CLI piece title\nheading: none\n---\n\nBody.\n')
    for (const [path, title, name] of [['folio', 'CLI report title', 'cli-folio.html'], ['folio/part.md', 'CLI piece title', 'cli-piece.html']]) {
      const target = join(out, name)
      const result = await fx.cli(['export', path, '--to', target, '--confirm'])
      expect(result.json.ok).toBe(true)
      expectReportTitle(await readFile(target, 'utf8'), title)
    }
  } finally { await fx.dispose() }
})


test('Word document properties use declared titles for both scopes', async () => {
  await folio()
  for (const scope of ['piece', 'collection'] as const) {
    const target = join(out, `${scope}.docx`)
    if (scope === 'piece') await exportDocument(ws, { path: 'machine-folder-slug/contents/00-frontmatter.md', format: 'docx', target })
    else {
      // Word's existing collection order is unchanged; provide a direct piece as that path expects.
      await write('machine-folder-slug/direct.md', '# Direct piece\n\nBody.\n')
      await exportBundle(ws, { dir: 'machine-folder-slug', format: 'docx', target })
    }
    const zip = await JSZip.loadAsync(await readFile(target))
    const core = await zip.file('docProps/core.xml')!.async('string')
    // The collection's title is the Details title (the Index Note's), which comes before the manifest's.
    expect(core).toContain(`<dc:title>${scope === 'piece' ? 'Title matter metadata' : 'Index metadata title'}</dc:title>`)
    expect(core).not.toContain('machine-folder-slug')
  }
})

test('declared titles are escaped in HTML rather than interpreted as markup', async () => {
  await folio('<img src=x onerror=alert(1)> & Report', NO_DECLARED)
  const html = await bundle()
  expectReportTitle(html, '&lt;img src=x onerror=alert(1)&gt; &amp; Report')
  expect(html).not.toContain('<img src=x onerror=alert(1)>')
})

test('workspace-root exports resolve the canonical root Index Note without displaying the temporary root name', async () => {
  const name = root.split('/').at(-1)!
  await write(`_${name}_INDEX.md`, '---\ntitle: Root report title\n---\n\n# Root heading\n')
  await write('body.md', '# Body\n\nProse.\n')
  const target = join(out, 'root.html')
  await exportBundle(ws, { dir: '', format: 'html', target })
  expectReportTitle(await readFile(target, 'utf8'), 'Root report title')
  expect(await readFile(target, 'utf8')).not.toContain(name)
})


test('an untitled Folio part keeps its subsection as body text, without inventing a file-derived section title', async () => {
  await folio()
  await write('machine-folder-slug/contents/01-analysis.md', 'Costs.\n\n## Items\n\nDetails.\n')
  const html = await bundle()
  expect(html).toContain('class="wf-bundle-section-title">Untitled document</h1>')
  expect(html).toContain('>Items</h3>')
  expect(html).not.toContain('class="wf-bundle-section-title">Items</h1>')
  expect(html).not.toContain('01-analysis')
})


test('a Folio part keeps a first heading that differs from its declared export title', async () => {
  await folio()
  await write('machine-folder-slug/contents/01-analysis.md', '---\ntitle: Declared part title\n---\n\n# Different heading\n\nKeep this content.\n')
  const html = await bundle()
  expect(html).toContain('class="wf-bundle-section-title">Declared part title</h1>')
  expect(html).toContain('>Different heading</h2>')
})

test('declared-title changes retain the pre-repair reader-note and reader-edit document identities', async () => {
  await folio()
  const target = join(out, 'notes.html')
  const id = (html: string): string => /"documentId":"([^"\n]+)"/.exec(html)![1]
  const exportIds = async (): Promise<string[]> => {
    await exportDocument(ws, { path: 'machine-folder-slug/contents/00-frontmatter.md', format: 'html', target, html: { readerNotes: true, readerEdits: true } })
    const piece = id(await readFile(target, 'utf8'))
    await exportBundle(ws, { dir: 'machine-folder-slug', format: 'html', target, html: { readerNotes: true, readerEdits: true } })
    return [piece, id(await readFile(target, 'utf8'))]
  }
  const original = await exportIds()
  expect(original[0]).toStartWith('writeflex-00-frontmatter-')
  expect(original[1]).toStartWith('writeflex-machine-folder-slug-')
  await folio('Updated report title')
  await write('machine-folder-slug/contents/00-frontmatter.md', '---\ntitle: Updated piece title\nheading: none\n---\n\nOpening prose.\n')
  expect(await exportIds()).toEqual(original)
})

test('manifest and frontmatter title controls cannot enter filenames or Word XML', async () => {
  const bad = 'Report\u0000draft\u0001\u000b\ufffe\ud800'
  expect(exportFileName(bad, 'html')).not.toContain('\u0000')
  await folio(bad, NO_DECLARED)
  await write('machine-folder-slug/direct.md', `---\ntitle: ${JSON.stringify(bad)}\n---\n\nBody.\n`)
  for (const scope of ['piece', 'collection'] as const) {
    const choice = scope === 'piece'
      ? { scope, path: 'machine-folder-slug/direct.md', format: 'docx' as const }
      : { scope, dir: 'machine-folder-slug', format: 'docx' as const }
    expect(await suggestedName(ws, choice)).toBe('Reportdraft.docx')
    const target = join(out, `${scope}-controls.docx`)
    if (scope === 'piece') await exportDocument(ws, { path: 'machine-folder-slug/direct.md', format: 'docx', target })
    else await exportBundle(ws, { dir: 'machine-folder-slug', format: 'docx', target })
    const zip = await JSZip.loadAsync(await readFile(target))
    const core = await zip.file('docProps/core.xml')!.async('string')
    expect(core).toContain('<dc:title>Reportdraft</dc:title>')
    expect(core).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u)
  }
})


test('collection title previews read the current title-matter and cover buffers without writing them', async () => {
  await folio('', { index: null })
  const titlePath = 'machine-folder-slug/contents/00-frontmatter.md'
  const coverPath = 'machine-folder-slug/_machine-folder-slug_INDEX.md'
  const before = await readFile(join(root, titlePath), 'utf8')
  const buffers = new Map([[titlePath, '---\ntitle: Unsaved title matter\n---\n\nDraft.\n']])
  expect(await exportCollectionTitle(ws, 'machine-folder-slug', buffers)).toBe('Unsaved title matter')
  expect(await readFile(join(root, titlePath), 'utf8')).toBe(before)
  buffers.set(titlePath, 'Draft without a declared title.\n')
  buffers.set(coverPath, '---\ntitle: Unsaved cover title\n---\n\nDraft.\n')
  expect(await exportCollectionTitle(ws, 'machine-folder-slug', buffers)).toBe('Unsaved cover title')
})

test('export title resolution propagates an unreadable title file instead of falling back', async () => {
  await folio(undefined, { index: null })
  const original = ws.readFile.bind(ws)
  ws.readFile = async path => {
    if (path.endsWith('00-frontmatter.md')) throw new Error('unreadable title file')
    return original(path)
  }
  await expect(exportCollectionTitle(ws, 'machine-folder-slug')).rejects.toThrow('unreadable title file')
})
