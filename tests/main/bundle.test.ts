import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { exportBundle, suggestedName } from '../../src/main/export'
import { assertHtmlExportDoesNotLeak } from '../helpers/html-export-leak-harness'

// THE LINK LAW, tested both ways (Round B T7). A Collection whose pieces reference each other leaves
// the app as ONE self-contained file: a wikilink to a piece INSIDE the bundle becomes a working
// internal anchor — the single exception to the disappearing-wikilink law, because its target is
// present — and a wikilink to anything outside degrades to plain words. Never a dead anchor, either
// way, and never a link that quietly points at nothing.

let root: string
let ws: Workspace
let out: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-bundle-'))
  out = await mkdtemp(join(tmpdir(), 'wf-bundle-out-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const target = (name: string): string => join(out, name)

function assertGeneratedHtmlDoesNotLeak(html: string): void {
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [],
    sourceFrontmatter: {},
    selectedFrontmatterFields: [],
    workspaceRoot: root,
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: ['VERSION_RECORD_CANARY'],
    diarySessionMarkers: ['DIARY_SESSION_CANARY'],
    collectionProvenanceMarkers: ['COLLECTION_PROVENANCE_CANARY'],
    annotationEnabled: false,
  })
}

/** Two pieces that link to each other, and one that links out of the Collection. */
async function essays(): Promise<void> {
  await write('essays/attention.md', [
    '---', 'title: On attention', 'status: draft', '---', '',
    '# On attention', '',
    'This picks up [[The unit of courage]], and reaches for [[Somewhere Else]].', '',
  ].join('\n'))
  await write('essays/courage.md', [
    '---', 'title: The unit of courage', '---', '',
    '# The unit of courage', '',
    'Answering [[On attention]].', '',
  ].join('\n'))
  await write('elsewhere/other.md', '---\ntitle: Somewhere Else\n---\n\n# Somewhere Else\n\nNot in the Collection.\n')
}

test('a wikilink INSIDE the bundle becomes a working anchor; one pointing out becomes plain words', async () => {
  await essays()
  const outcome = await exportBundle(ws, { dir: 'essays', format: 'html', target: target('essays.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(outcome.pieces).toBe(2)

  // Every anchor the bundle writes has a section to land on — nothing points at nothing.
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1])
  for (const anchor of anchors) expect(html).toContain(`id="${anchor}"`)

  // Inside: the link resolves to the other piece's section.
  const courage = /id="(p\d+-section)"[^>]*>\s*<h1[^>]*>The unit of courage/.exec(html)
  expect(courage).not.toBeNull()
  expect(html).toContain(`<a href="#${courage![1]}">The unit of courage</a>`)

  // Outside: the label survives as words, with no anchor and no brackets.
  expect(html).toContain('Somewhere Else')
  expect(html).not.toContain('>Somewhere Else</a>')
  expect(html).not.toContain('[[')
})

test('the bundle sidebar carries pieces in Collection order with each piece heading beneath it', async () => {
  await essays()
  await write('essays/attention.md', '---\ntitle: On attention\n---\n\n# On attention\n\n## First signs\n\nProse.\n')
  await write('essays/courage.md', '---\ntitle: The unit of courage\n---\n\n# The unit of courage\n\n## A response\n\nProse.\n')
  const outcome = await exportBundle(ws, { dir: 'essays', format: 'html', target: target('essays.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toContain('<aside class="sidebar" aria-label="Document contents">')
  const attentionPiece = html.indexOf('<a class="nav-link piece-link" href="#p1-section">On attention</a>')
  const attentionHeading = html.indexOf('<a class="nav-link level-2" href="#p1-on-attention">On attention</a>')
  const signsHeading = html.indexOf('<a class="nav-link level-3" href="#p1-first-signs">First signs</a>')
  const couragePiece = html.indexOf('<a class="nav-link piece-link" href="#p2-section">The unit of courage</a>')
  const responseHeading = html.indexOf('<a class="nav-link level-3" href="#p2-a-response">A response</a>')
  expect(attentionPiece).toBeGreaterThan(-1)
  expect(attentionHeading).toBeGreaterThan(attentionPiece)
  expect(signsHeading).toBeGreaterThan(attentionHeading)
  expect(couragePiece).toBeGreaterThan(signsHeading)
  expect(responseHeading).toBeGreaterThan(couragePiece)
  for (const anchor of [...html.matchAll(/class="nav-link[^"]*" href="#([^"]+)"/g)].map((match) => match[1])) {
    expect(html).toContain(`id="${anchor}"`)
  }
  assertGeneratedHtmlDoesNotLeak(html)
})

test('a bundle of one piece still gets the default heading sidebar', async () => {
  await write('solo/only.md', '---\ntitle: The only piece\n---\n\n# The only piece\n\nProse.\n')
  const outcome = await exportBundle(ws, { dir: 'solo', format: 'html', target: target('solo.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(outcome.pieces).toBe(1)
  expect(html).toContain('<a class="nav-link level-1" href="#p1-the-only-piece">The only piece</a>')
  expect(html).toContain('The only piece')
  expect(html).toContain('Prose.')
  assertGeneratedHtmlDoesNotLeak(html)
})

test('bundle design B and sidebar-off options are structural and leak-free', async () => {
  await essays()
  const dark = await exportBundle(ws, {
    dir: 'essays',
    format: 'html',
    target: target('essays-dark.html'),
    html: { design: 'b' },
  })
  const darkHtml = await readFile(dark.target, 'utf8')
  expect(darkHtml).toContain('<body class="wf-design-b">')
  expect(darkHtml).toContain('<aside class="sidebar" aria-label="Document contents">')
  assertGeneratedHtmlDoesNotLeak(darkHtml)

  const plain = await exportBundle(ws, {
    dir: 'essays',
    format: 'html',
    target: target('essays-plain.html'),
    html: { sidebar: false, titleBlock: false, summaryTiles: false },
  })
  const plainHtml = await readFile(plain.target, 'utf8')
  expect(plainHtml).not.toContain('class="sidebar"')
  expect(plainHtml).not.toContain('id="toc"')
  expect(plainHtml).not.toContain('class="hero wf-masthead"')
  expect(plainHtml).not.toContain('class="summary-grid')
  assertGeneratedHtmlDoesNotLeak(plainHtml)
})

test('a Collection masthead uses the bundle title and summary tiles aggregate row metadata', async () => {
  const secretCanary = 'COLLECTION_SECRET_PROJECT_CANARY'
  await write('reports/one.md', [
    '---',
    'status: in progress',
    `secret-project: ${secretCanary}`,
    '---',
    '',
    '# One',
    '',
    'One two three.',
  ].join('\n'))
  await write('reports/two.md', '---\nstatus: in progress\n---\n\n# Two\n\nFour five.\n')

  const outcome = await exportBundle(ws, {
    dir: 'reports',
    format: 'html',
    target: target('reports-summary.html'),
    html: { summaryTiles: true },
  })
  const html = await readFile(outcome.target, 'utf8')

  expect(html).toContain('<header class="hero wf-masthead">')
  expect(html).toContain('<h1>reports</h1>')
  expect(html).toContain('<div class="summary-card"><b>9</b><span>words</span></div>')
  expect(html).toContain('<div class="summary-card"><b>in progress</b><span>collection status</span></div>')
  expect(html).not.toContain(secretCanary)
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [],
    sourceFrontmatter: { 'secret-project': secretCanary },
    selectedFrontmatterFields: [],
    workspaceRoot: root,
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: ['VERSION_RECORD_CANARY'],
    diarySessionMarkers: ['DIARY_SESSION_CANARY'],
    collectionProvenanceMarkers: ['COLLECTION_PROVENANCE_CANARY'],
    annotationEnabled: false,
  })
})

test('the bundle is one self-contained document, and still never carries metadata or comments', async () => {
  await write('essays/one.md', '---\ntitle: One\nstatus: draft\n---\n\n# One\n\n// a note\n\nFirst.\n')
  await write('essays/two.md', '---\ntitle: Two\n---\n\n# Two\n\nSecond.\n')
  const outcome = await exportBundle(ws, { dir: 'essays', format: 'html', target: target('essays.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toStartWith('<!doctype html>')
  expect(html).toContain('<style>')
  expect(html).not.toContain('status')
  expect(html).not.toContain('a note')
  expect(html).toContain('First.')
  expect(html).toContain('Second.')
})

test('each piece keeps its own heading ids and footnote numbers — nine pieces cannot collide', async () => {
  await write('essays/one.md', '---\ntitle: One\n---\n\n# Shared heading\n\nA note[^1].\n\n[^1]: First note.\n')
  await write('essays/two.md', '---\ntitle: Two\n---\n\n# Shared heading\n\nAnother note[^1].\n\n[^1]: Second note.\n')
  const outcome = await exportBundle(ws, { dir: 'essays', format: 'html', target: target('essays.html') })
  const html = await readFile(outcome.target, 'utf8')
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
  expect(new Set(ids).size).toBe(ids.length)
  expect(html).toContain('First note.')
  expect(html).toContain('Second note.')
  // A piece's own headings sit BELOW the section title the bundle generates.
  expect(html).toContain('<h2')
})

test('bundle options carry each piece outline, selected front matter and row metadata without leaks', async () => {
  const marginNote = 'BUNDLE_MARGIN_NOTE_CANARY'
  const unselectedCanary = 'BUNDLE_UNSELECTED_FRONTMATTER_CANARY'
  await write('essays/one.md', [
    '---',
    'status: draft',
    `private-canary: ${unselectedCanary}`,
    '---',
    '',
    '# Shared heading',
    '',
    `// ${marginNote}`,
    '',
    'First paragraph.',
  ].join('\n'))

  const outcome = await exportBundle(ws, {
    dir: 'essays',
    format: 'html',
    target: target('bundle-with-data.html'),
    html: {
      stableHeadingIds: true,
      stableBlockIds: true,
      frontmatterFields: ['status'],
    },
  })
  const html = await readFile(outcome.target, 'utf8')

  expect(html).toContain('id="p1-shared-heading"')
  expect(html).toContain('id="p1-shared-heading-block-1"')
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [marginNote],
    sourceFrontmatter: { status: 'draft', 'private-canary': unselectedCanary },
    selectedFrontmatterFields: ['status'],
    workspaceRoot: root,
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: ['VERSION_RECORD_CANARY'],
    diarySessionMarkers: ['DIARY_SESSION_CANARY'],
    collectionProvenanceMarkers: ['COLLECTION_PROVENANCE_CANARY'],
    annotationEnabled: false,
  })
})

test('reader notes namespace stable targets across every piece in a bundle', async () => {
  await write('essays/one.md', '# Shared heading\n\nFirst paragraph.\n')
  await write('essays/two.md', '# Shared heading\n\nSecond paragraph.\n')
  const outcome = await exportBundle(ws, {
    dir: 'essays',
    format: 'html',
    target: target('annotatable-essays.html'),
    html: { readerNotes: true },
  })
  const html = await readFile(outcome.target, 'utf8')

  expect(html).toContain('id="p1-shared-heading-block-1"')
  expect(html).toContain('id="p2-shared-heading-block-1"')
  expect(html).toContain('"targets":["p1-shared-heading","p1-shared-heading-block-1","p2-shared-heading","p2-shared-heading-block-1"]')
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [],
    sourceFrontmatter: {},
    selectedFrontmatterFields: [],
    workspaceRoot: root,
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: [],
    diarySessionMarkers: [],
    collectionProvenanceMarkers: [],
    annotationEnabled: true,
  })
})

test('a Word bundle is one document with every piece in it', async () => {
  await essays()
  const outcome = await exportBundle(ws, { dir: 'essays', format: 'docx', target: target('essays.docx') })
  const bytes = await readFile(outcome.target)
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
  expect(outcome.pieces).toBe(2)
  expect(outcome.format).toBe('docx')
})

test('an empty Collection is refused with a way forward, not an empty file', async () => {
  await mkdir(join(root, 'empty'), { recursive: true })
  await expect(exportBundle(ws, { dir: 'empty', format: 'html', target: target('empty.html') }))
    .rejects.toThrow(/no pieces/)
})

test('the bundle is named after the Collection', async () => {
  await essays()
  expect(await suggestedName(ws, { scope: 'collection', dir: 'essays', format: 'html' })).toBe('essays.html')
})
