import { expect, test } from 'bun:test'
import { assembleDocument, type HtmlDocumentData } from '../../src/shared/markdown/html-document'
import { toHtml } from '../../src/shared/markdown/to-html'
import { assertHtmlExportDoesNotLeak } from '../helpers/html-export-leak-harness'

const REPRESENTATIVE_MARKDOWN = [
  '# Groundwork',
  '',
  'A **bold** paragraph with `code` and a [link](https://example.com).',
  '',
  '> Quoted text',
  '',
  '- [x] Finished',
  '- Pending',
  '',
  '| Left | Right |',
  '| --- | ---: |',
  '| One | Two |',
  '',
  'A note[^1].',
  '',
  '[^1]: Footnote text.',
].join('\n')

// Captured byte-for-byte from main before the document shell and styles moved into imported assets.
// One deliberate change since: a task item's box stands in for its bullet (checkbox lists, 2026-09-27).
const CURRENT_EXPORT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Export &lt;proof&gt; &amp; check</title>
<style>body{font-family:Georgia,"Times New Roman",serif;font-size:16px;line-height:1.6;color:#26262a;max-width:44em;margin:2.5em auto;padding:0 1.5em;}img{max-width:100%;height:auto}table{border-collapse:collapse}</style>
</head>
<body>
<h1 style="margin:1.2em 0 0.5em 0;line-height:1.25;">Groundwork</h1>
<p style="margin:0 0 1em 0;">A <strong>bold</strong> paragraph with <code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:0.9em;background:#f4f4f4;padding:0.1em 0.3em;border-radius:3px;">code</code> and a <a href="https://example.com">link</a>.</p>
<blockquote style="margin:0 0 1em 0;padding:0 0 0 1em;border-left:3px solid #cccccc;color:#555555;"><p style="margin:0 0 1em 0;">Quoted text</p></blockquote>
<ul style="margin:0 0 1em 0;padding-left:1.6em;"><li style="margin:0 0 0.25em 0;list-style-type:none;">☑ Finished</li><li style="margin:0 0 0.25em 0;">Pending</li></ul>
<table border="1" cellspacing="0" cellpadding="6" style="border-collapse:collapse;margin:0 0 1em 0;"><thead><tr><th style="border:1px solid #999999;padding:6px 10px;vertical-align:top;background:#f0f0f0;font-weight:700;">Left</th><th style="border:1px solid #999999;padding:6px 10px;vertical-align:top;background:#f0f0f0;font-weight:700;text-align:right;">Right</th></tr></thead><tbody><tr><td style="border:1px solid #999999;padding:6px 10px;vertical-align:top;">One</td><td style="border:1px solid #999999;padding:6px 10px;vertical-align:top;text-align:right;">Two</td></tr></tbody></table>
<p style="margin:0 0 1em 0;">A note<sup id="fnref-1-1"><a href="#fn-1" style="text-decoration:none;">1</a></sup>.</p>
<section style="margin:2em 0 0 0;padding-top:0.5em;border-top:1px solid #cccccc;font-size:0.9em;"><ol style="margin:0 0 1em 0;padding-left:1.6em;"><li id="fn-1" style="margin:0 0 0.25em 0;">Footnote text. <a href="#fnref-1-1" style="text-decoration:none;">&#8617;</a></li></ol></section>
</body>
</html>
`

function assertGeneratedHtmlDoesNotLeak(html: string): void {
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [],
    sourceFrontmatter: {},
    selectedFrontmatterFields: [],
    workspaceRoot: '/html-export-workspace-canary',
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: ['VERSION_RECORD_CANARY'],
    diarySessionMarkers: ['DIARY_SESSION_CANARY'],
    collectionProvenanceMarkers: ['COLLECTION_PROVENANCE_CANARY'],
    annotationEnabled: false,
  })
}

test('the all-features-off document stays byte-identical to the export before document chrome', () => {
  const body = toHtml(REPRESENTATIVE_MARKDOWN).html
  const html = assembleDocument({
    title: 'Export <proof> & check',
    body,
    sidebar: false,
    titleBlock: false,
    summaryTiles: false,
  })

  expect(html).toBe(CURRENT_EXPORT)
  assertGeneratedHtmlDoesNotLeak(html)
})

test('template replacement leaves dollar replacement tokens unchanged', () => {
  const html = assembleDocument({ title: '$& title', body: '<p>$& $` $\'</p>', sidebar: false })

  expect(html).toContain('<title>$&amp; title</title>')
  expect(html).toContain('<p>$& $` $\'</p>')
  assertGeneratedHtmlDoesNotLeak(html)
})

const DOCUMENT_DATA: HtmlDocumentData = {
  frontmatter: { date: '2026-05-14', status: 'For discussion', author: 'Dominik Lukeš' },
  outline: [
    { level: 1, text: 'Opening & purpose', anchor: 'opening-purpose' },
    { level: 2, text: 'Evidence', anchor: 'evidence' },
    { level: 4, text: 'A caveat', anchor: 'a-caveat' },
    { level: 5, text: 'Appendix detail', anchor: 'appendix-detail' },
  ],
  metadata: {
    title: 'A <report>',
    description: 'A standfirst with <meaning>.',
    purpose: null,
    status: 'For discussion',
    modified: Date.UTC(2026, 4, 18, 12),
    words: 1_428,
  },
}

test('the new default is a design-A document shell with an h1-h4 contents sidebar', () => {
  const body = '<h1 id="opening-purpose">Opening &amp; purpose</h1>\n<h2 id="evidence">Evidence</h2>\n<h4 id="a-caveat">A caveat</h4>'
  const html = assembleDocument({ title: 'A <report>', body, documents: [DOCUMENT_DATA] })

  expect(html).toContain('<body class="wf-design-a">')
  expect(html).toContain('<header class="hero wf-masthead">')
  expect(html).toContain('<h1>A &lt;report&gt;</h1>')
  expect(html).toContain('<p class="standfirst">A standfirst with &lt;meaning&gt;.</p>')
  expect(html).toContain('<span class="chip"><strong>Date</strong> · 14 May 2026</span>')
  expect(html).toContain('<span class="chip"><strong>Author</strong> · Dominik Lukeš</span>')
  expect(html).not.toContain('class="summary-grid"')
  expect(html).toContain('<aside class="sidebar" aria-label="Document contents">')
  expect(html).toContain('<h2 class="sidebar-title">A &lt;report&gt;</h2>')
  expect(html).toContain('<a class="nav-link level-1" href="#opening-purpose">Opening &amp; purpose</a>')
  expect(html).toContain('<a class="nav-link level-4" href="#a-caveat">A caveat</a>')
  expect(html).not.toContain('Appendix detail')
  expect(html).toContain(body)
  assertGeneratedHtmlDoesNotLeak(html)
})

test('design B selects the dark numbered-rail treatment without changing document content', () => {
  const body = '<h2 id="evidence">Evidence</h2>'
  const html = assembleDocument({ title: 'Report', body, documents: [DOCUMENT_DATA], design: 'b' })

  expect(html).toContain('<body class="wf-design-b">')
  expect(html).toContain('<span class="chip"><strong>Date</strong>14 May 2026</span>')
  expect(html).not.toContain('<strong>Date</strong> · ')
  expect(html).toContain('.wf-design-b .sidebar{')
  expect(html).toContain('.wf-design-b #toc{counter-reset:toc;}')
  expect(html).toContain(body)
  assertGeneratedHtmlDoesNotLeak(html)
})

test('sidebar off omits the sidebar and its containing shell structurally', () => {
  const html = assembleDocument({ title: 'Report', body: '<p>Plain.</p>', documents: [DOCUMENT_DATA], sidebar: false })

  expect(html).not.toContain('class="sidebar"')
  expect(html).not.toContain('id="toc"')
  expect(html).not.toContain('class="shell"')
  assertGeneratedHtmlDoesNotLeak(html)
})

test('a title-only masthead has no empty standfirst or chip row', () => {
  const data: HtmlDocumentData = {
    ...DOCUMENT_DATA,
    frontmatter: {},
    metadata: { ...DOCUMENT_DATA.metadata, description: null },
  }
  const html = assembleDocument({ title: 'Bare piece', body: '<p>Plain.</p>', documents: [data] })

  expect(html).toContain('<header class="hero wf-masthead">')
  expect(html).toContain('<h1>Bare piece</h1>')
  expect(html).not.toContain('class="standfirst"')
  expect(html).not.toContain('class="meta-row"')
  assertGeneratedHtmlDoesNotLeak(html)
})

test('title block and summary tiles are independently structural', () => {
  const withoutTitle = assembleDocument({
    title: 'Report',
    body: '<p>Plain.</p>',
    documents: [DOCUMENT_DATA],
    titleBlock: false,
    summaryTiles: true,
  })
  expect(withoutTitle).not.toContain('class="hero wf-masthead"')
  expect(withoutTitle).toContain('<section class="summary-grid wf-summary-only" aria-label="Document summary">')
  expect(withoutTitle).toContain('<div class="summary-card"><b>1,428</b><span>words</span></div>')
  expect(withoutTitle).toContain('<div class="summary-card"><b>18 May 2026</b><span>last modified</span></div>')
  assertGeneratedHtmlDoesNotLeak(withoutTitle)

  const withoutSummary = assembleDocument({
    title: 'Report',
    body: '<p>Plain.</p>',
    documents: [DOCUMENT_DATA],
    titleBlock: true,
    summaryTiles: false,
  })
  expect(withoutSummary).toContain('class="hero wf-masthead"')
  expect(withoutSummary).not.toContain('class="summary-grid')
  assertGeneratedHtmlDoesNotLeak(withoutSummary)
})

test('the front page is a cover above the shell, entered by a link, and absent by default', () => {
  const parts = {
    title: 'Report',
    body: '<h1 id="report">Report</h1>',
    documents: [DOCUMENT_DATA],
  }
  const off = assembleDocument(parts)
  const on = assembleDocument({ ...parts, frontPage: true })

  expect(off).not.toContain('front-page')
  expect(on).toContain('<section class="front-page" aria-label="Cover">')
  expect(on).toContain('<h1 class="front-page-title">Report</h1>')
  expect(on).toContain('href="#wf-document-start"')
  expect(on).toContain('id="wf-document-start"')
  expect(on.indexOf('class="front-page"')).toBeLessThan(on.indexOf('<div class="shell">'))
  expect(on).toContain('.front-page{position:relative;')
  expect(on).toContain('break-after:page')
  expect(on).toContain('<h1 id="report">Report</h1>')
  assertGeneratedHtmlDoesNotLeak(on)
})

test('the inlined stylesheet always contains print collapse, reader-control and page-break rules', () => {
  const html = assembleDocument({ title: 'Report', body: '<h1 id="report">Report</h1>', documents: [DOCUMENT_DATA] })

  expect(html).toContain('@media print{')
  expect(html).toContain('.sidebar,.reader-badge-region')
  expect(html).toContain('display:none!important')
  expect(html).toContain('h1,h2,h3,h4{break-after:avoid;break-inside:avoid;}')
  expect(html).toContain('overflow-x:clip')
  assertGeneratedHtmlDoesNotLeak(html)
})

test('reader notes inject the manifest, notes UI and vendored runtime at the document seam', () => {
  const html = assembleDocument({
    title: 'Report',
    body: '<h1 id="report">Report</h1><p id="report-block-1">Public prose.</p>',
    documents: [DOCUMENT_DATA],
    readerNotes: {
      documentId: 'writeflex-report-1234abcd',
      targets: ['report', 'report-block-1'],
    },
  })

  expect(html).toContain('<script id="writeflex-interaction-manifest" type="application/json">')
  expect(html).toContain('"documentId":"writeflex-report-1234abcd"')
  expect(html).toContain('"targets":["report","report-block-1"]')
  expect(html).toContain('data-writeflex-reader-notes-ui')
  expect(html).toContain('data-writeflex-reader-notes-runtime')
  expect(html).toContain('WriteFlexReaderNotes')
  expect(html).not.toContain('"editDiff"')
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [],
    sourceFrontmatter: {},
    selectedFrontmatterFields: [],
    workspaceRoot: '/html-export-workspace-canary',
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: [],
    diarySessionMarkers: [],
    collectionProvenanceMarkers: [],
    annotationEnabled: true,
  })
})

test('reader edits inject only edit configuration, UI and vendored runtime at the document seam', () => {
  const html = assembleDocument({
    title: 'Report',
    body: '<h1 id="report">Report</h1><p id="report-block-1">Public prose.</p>',
    documents: [DOCUMENT_DATA],
    readerEdits: {
      documentId: 'writeflex-report-1234abcd',
      targets: ['report', 'report-block-1'],
    },
  })

  expect(html).toContain('<script id="writeflex-interaction-manifest" type="application/json">')
  expect(html).toContain('"editDiff":{"enabled":true,"targets":["report","report-block-1"]}')
  expect(html).not.toContain('"annotations"')
  expect(html).toContain('data-writeflex-reader-edits-ui')
  expect(html).toContain('data-writeflex-reader-edits-runtime')
  expect(html).toContain('WriteFlexReaderEdits')
  expect(html).not.toContain('data-writeflex-reader-notes-runtime')
  assertHtmlExportDoesNotLeak(html, {
    marginNoteTexts: [],
    sourceFrontmatter: {},
    selectedFrontmatterFields: [],
    workspaceRoot: '/html-export-workspace-canary',
    machineHostname: 'HTML_EXPORT_HOST_CANARY',
    versionRecordMarkers: [],
    diarySessionMarkers: [],
    collectionProvenanceMarkers: [],
    annotationEnabled: false,
    editEnabled: true,
  })
})

test('reader notes and edits share one manifest and keep both runtimes distinct', () => {
  const html = assembleDocument({
    title: 'Report',
    body: '<h1 id="report">Report</h1><p id="report-block-1">Public prose.</p>',
    documents: [DOCUMENT_DATA],
    readerNotes: { documentId: 'writeflex-report-1234abcd', targets: ['report', 'report-block-1'] },
    readerEdits: { documentId: 'writeflex-report-1234abcd', targets: ['report', 'report-block-1'] },
  })

  expect(html.match(/id="writeflex-interaction-manifest"/g)).toHaveLength(1)
  expect(html).toContain('"annotations":{"enabled":true,"targets":["report","report-block-1"]}')
  expect(html).toContain('"editDiff":{"enabled":true,"targets":["report","report-block-1"]}')
  expect(html).toContain('data-writeflex-reader-notes-runtime')
  expect(html).toContain('data-writeflex-reader-edits-runtime')
})

test('one badge names the modes, one return action carries them back, and passages stay plain', () => {
  const body = '<h1 id="report">Report</h1><p id="report-block-1">Public prose.</p>'
  const targets = ['report', 'report-block-1']
  const document_ = { documentId: 'writeflex-report-1234abcd', targets }
  const notesOnly = assembleDocument({ title: 'Report', body, documents: [DOCUMENT_DATA], readerNotes: document_ })
  const editsOnly = assembleDocument({ title: 'Report', body, documents: [DOCUMENT_DATA], readerEdits: document_ })
  const both = assembleDocument({ title: 'Report', body, documents: [DOCUMENT_DATA], readerNotes: document_, readerEdits: document_ })
  const plain = assembleDocument({ title: 'Report', body, documents: [DOCUMENT_DATA] })

  // The badge is a label with an information mark, never a button, and it never shares a corner
  // with the one action (Requirement: "it should be more clear it's not a button").
  for (const html of [notesOnly, editsOnly, both]) {
    expect(html).toContain('<span class="reader-badge" id="wf-reader-badge" tabindex="0" role="note" aria-describedby="wf-reader-badge-explainer">')
    expect(html).not.toContain('<button class="reader-badge"')
    expect(html).toContain('<div class="reader-badge-region" data-writeflex-reader-badge>')
    expect(html).toContain('<div class="reader-return-region" data-writeflex-reader-return>')
    expect(html.indexOf('id="wf-reader-badge"')).toBeLessThan(html.indexOf('class="reader-return-region"'))
    expect(html).toContain('.reader-badge-region{position:fixed;left:18px;')
    expect(html).toContain('.reader-return-region{position:fixed;right:18px;')
    expect(html.match(/id="wf-reader-badge"/g)).toHaveLength(1)
    expect(html.match(/id="wf-reader-return"/g)).toHaveLength(1)
    expect(html).toContain('id="wf-reader-badge-explainer" role="tooltip"')
    expect(html).not.toContain('EDITABLE PASSAGE')
    expect(html).not.toContain('[data-editable]{')
    expect(html).not.toContain('[data-editable]::before')
    expect(html).not.toContain('Save notes as JSON')
    expect(html).not.toContain('Save edits')
  }

  expect(both).toContain('<span class="reader-badge-text">Comment or suggest edits</span>')
  expect(notesOnly).toContain('<span class="reader-badge-text">Comment</span>')
  expect(editsOnly).toContain('<span class="reader-badge-text">Suggest edits</span>')
  expect(both).toContain('class="reader-return" id="wf-reader-return" type="button">Export comments and edits</button>')
  expect(notesOnly).toContain('class="reader-return" id="wf-reader-return" type="button">Export comments</button>')
  expect(editsOnly).toContain('class="reader-return" id="wf-reader-return" type="button">Export edits</button>')

  // The explainer opens with what this copy of the document IS, before it says how.
  expect(both).toContain('<p class="reader-badge-intro">This is a version of this document for comments and editing. You can export and email your suggestions to the author.</p>')
  expect(notesOnly).toContain('<p class="reader-badge-intro">This is a version of this document for comments. You can export and email your suggestions to the author.</p>')
  expect(editsOnly).toContain('<p class="reader-badge-intro">This is a version of this document for editing. You can export and email your suggestions to the author.</p>')
  expect(both.indexOf('reader-badge-intro')).toBeLessThan(both.indexOf('reader-badge-how-notes'))

  // Both modes off: the badge is absent, not hidden.
  expect(plain).not.toContain('class="reader-badge-region"')
  expect(plain).not.toContain('id="wf-reader-badge"')
  // The explainer halves keep their two colour families, and only the enabled half is emitted.
  expect(notesOnly).toContain('class="reader-badge-how reader-badge-how-notes"')
  expect(notesOnly).not.toContain('class="reader-badge-how reader-badge-how-edits"')
  expect(editsOnly).toContain('class="reader-badge-how reader-badge-how-edits"')
  expect(both).toContain('class="reader-badge-how reader-badge-how-notes"')
  expect(both).toContain('class="reader-badge-how reader-badge-how-edits"')
  // Print carries no editing chrome at all.
  expect(both).toContain('.sidebar,.reader-badge-region,.reader-return-region,.reader-selection-prompt,.notes-drawer,.edits-drawer')
  expect(both.slice(both.indexOf('@media print{'))).not.toContain('[data-editable]')
})

test('a printed front page replaces the masthead and brings the contents with it', () => {
  const parts = { title: 'Report', body: '<h1 id="report">Report</h1>', documents: [DOCUMENT_DATA] }
  const off = assembleDocument(parts)
  const on = assembleDocument({ ...parts, frontPage: true })

  // Front page on: the cover is the title page, so the masthead does not print, and the contents
  // list prints as its own page between the cover and the document.
  expect(on).toContain('.front-page{min-height:0;break-after:page;')
  expect(on).toContain('.hero{display:none!important;}')
  expect(on).toContain('.sidebar{display:block!important;position:static!important;')
  expect(on).toContain('break-before:page;break-after:page;}')
  expect(on).toContain('#toc .nav-link::before{content:counter(toc,decimal-leading-zero)')
  // Front page off: print is what it was — the masthead prints and the sidebar does not.
  expect(off).not.toContain('.hero{display:none!important;}')
  expect(off).not.toContain('.sidebar{display:block!important;')
  expect(off).not.toContain('#toc .nav-link::before')
  expect(off).toContain('.sidebar,.reader-badge-region,.reader-return-region,.reader-selection-prompt,.notes-drawer,.edits-drawer,.mode-key{display:none!important;}')
  // The page box keeps most of the margin and the printed containers keep a cushion of their own,
  // so text stays off the paper's edge even where @page is ignored.
  expect(on).toContain('@page{margin:12mm;}')
  expect(on).toContain('.main,.content{display:block;max-width:none;padding:0 8mm;}')
  expect(on).toContain('.front-page{min-height:0;break-after:page;padding:2mm 8mm 8mm!important;')
})
