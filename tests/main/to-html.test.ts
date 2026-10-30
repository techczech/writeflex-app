import { test, expect } from 'bun:test'
import { toHtml } from '../../src/shared/markdown/to-html'

// The PRD's "what travels and what does not" table (reports/2026-07-25-prd-export-clipboard/PRD.md),
// row by row, plus the edges the plan names: a labelled wikilink, a missing image, a footnote
// referenced twice, a table with inline formatting, and a code fence containing HTML.

// ---- Travels ----------------------------------------------------------------------------------

test('headings travel as real headings', () => {
  const { html } = toHtml('# One\n\n## Two\n\n###### Six\n')
  expect(html).toContain('<h1')
  expect(html).toContain('>One</h1>')
  expect(html).toContain('>Two</h2>')
  expect(html).toContain('>Six</h6>')
  // A fragment carries no ids: the clipboard has nowhere to jump to.
  expect(html).not.toContain('id=')
})

test('bold, italic, strikethrough, marks and inline code travel', () => {
  const { html } = toHtml('**bold** *italic* ~~struck~~ ==marked== `code()`\n')
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('<em>italic</em>')
  expect(html).toContain('<s>struck</s>')
  expect(html).toContain('marked</mark>')
  expect(html).toContain('>code()</code>')
})

test('lists travel, ordered and unordered, nested, with task boxes', () => {
  const { html } = toHtml('- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n')
  expect(html).toContain('<ul')
  expect(html).toContain('<ol')
  expect(html).toContain('<li style=')
  expect(html).toContain('nested')
  // A single-paragraph item stays flat, so a paste target has nothing to reinvent.
  expect(html).toMatch(/<li[^>]*>one<\/li>/)
  expect(html).toContain('☐ todo')
  expect(html).toContain('☑ done')
})

test('a task item shows its box in place of the bullet, ticked or not; a numbered one keeps its number', () => {
  const { html } = toHtml('- [ ] todo\n- [x] done\n- plain\n\n1. [x] first\n')
  expect(html).toMatch(/<li[^>]*style="[^"]*list-style-type:none;[^"]*">☐ todo<\/li>/)
  expect(html).toMatch(/<li[^>]*style="[^"]*list-style-type:none;[^"]*">☑ done<\/li>/)
  expect(html).toMatch(/<li[^>]*style="margin:0 0 0.25em 0;">plain<\/li>/)
  expect(html).toMatch(/<ol[^>]*><li[^>]*style="margin:0 0 0.25em 0;">☑ first<\/li>/)
  // Static: a document to read, so no form control a reader could tick.
  expect(html).not.toContain('<input')
})

test('an ordered list keeps a start other than one', () => {
  expect(toHtml('5. five\n6. six\n').html).toContain('start="5"')
})

test('block quotes travel with their own indent, not an inherited one', () => {
  const { html } = toHtml('> quoted\n> lines\n')
  expect(html).toContain('<blockquote style="')
  expect(html).toContain('border-left')
  expect(html).toContain('<p style=')
})

test('code fences travel as preformatted blocks and never execute their contents', () => {
  const { html } = toHtml('```html\n<script>alert(1)</script>\n```\n')
  expect(html).toContain('<pre style=')
  expect(html).toContain('class="language-html"')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>')
})

test('raw HTML the writer typed is shown, not run', () => {
  const inlineHtml = toHtml('Text with <b>a tag</b> in it.\n').html
  expect(inlineHtml).toContain('&lt;b&gt;')
  expect(inlineHtml).not.toContain('<b>')
  const blockHtml = toHtml('<div onclick="steal()">block</div>\n').html
  expect(blockHtml).toContain('&lt;div')
  expect(blockHtml).not.toContain('<div')
})

test('links travel as real anchors, including reference and bare forms', () => {
  const { html } = toHtml(
    'A [link](https://example.com "Title"), a [reference][id] and https://bare.example.com\n\n[id]: https://ref.example.com\n',
  )
  expect(html).toContain('<a href="https://example.com" title="Title">link</a>')
  expect(html).toContain('<a href="https://ref.example.com">reference</a>')
  expect(html).toContain('<a href="https://bare.example.com">https://bare.example.com</a>')
  // The definition line itself is not content.
  expect(html).not.toContain('[id]:')
})

test('a javascript: destination is refused, and its text survives', () => {
  const { html } = toHtml('[click me](javascript:alert(1))\n')
  expect(html).not.toContain('javascript:')
  expect(html).toContain('click me')
})

test('tables travel as tables, with borders written on the cells', () => {
  const { html } = toHtml('| Column | Another |\n| --- | ---: |\n| **bold** | `code` |\n')
  expect(html).toContain('<table border="1"')
  expect(html).toContain('<th style=')
  expect(html).toContain('<td style=')
  expect(html).toContain('border:1px solid')
  expect(html).toContain('text-align:right')
  // Inline formatting inside a cell survives the cell.
  expect(html).toContain('<strong>bold</strong>')
  expect(html).toContain('>code</code>')
})

test('footnotes travel, rendered at the end with back-references', () => {
  const result = toHtml('Prose with a note[^1] in it.\n\n[^1]: The note itself.\n')
  expect(result.footnotes).toBe(1)
  expect(result.html).toContain('<sup id="fnref-1-1"><a href="#fn-1"')
  expect(result.html).toContain('<li id="fn-1"')
  expect(result.html).toContain('The note itself.')
  expect(result.html).toContain('href="#fnref-1-1"')
  // The mark comes before the list: notes go to the END of the paste.
  expect(result.html.indexOf('fnref-1-1')).toBeLessThan(result.html.indexOf('<li id="fn-1"'))
})

test('a footnote referenced twice is one note with two back-references', () => {
  const result = toHtml('First[^a] and again[^a].\n\n[^a]: Once only.\n')
  expect(result.footnotes).toBe(1)
  expect(result.html).toContain('id="fnref-1-1"')
  expect(result.html).toContain('id="fnref-1-2"')
  expect(result.html).toContain('href="#fnref-1-1"')
  expect(result.html).toContain('href="#fnref-1-2"')
  expect([...result.html.matchAll(/<li id="fn-1"/g)]).toHaveLength(1)
})

test('an inline footnote travels as its own note', () => {
  const result = toHtml('Said in passing^[a quiet aside].\n')
  expect(result.footnotes).toBe(1)
  expect(result.html).toContain('a quiet aside')
  expect(result.html).toContain('<li id="fn-1"')
})

test('a footnote reference with no definition stays as the writer typed it', () => {
  const result = toHtml('Dangling[^missing] reference.\n')
  expect(result.footnotes).toBe(0)
  expect(result.html).toContain('[^missing]')
  expect(result.html).not.toContain('<sup')
})

test('images travel with their source by default', () => {
  const result = toHtml('![A river](pictures/river.png "Caption")\n')
  expect(result.html).toContain('<img src="pictures/river.png" alt="A river" title="Caption"')
  expect(result.missingImages).toEqual([])
})

// ---- Does not travel --------------------------------------------------------------------------

test('wikilinks disappear: the label text remains as ordinary words', () => {
  const { html } = toHtml('See [[The River]] and [[the-river|the piece about it]].\n')
  expect(html).toContain('See The River and the piece about it.')
  expect(html).not.toContain('[[')
  expect(html).not.toContain('<a')
})

test('a wikilink inside a code span is code, not a link', () => {
  const { html } = toHtml('Type `[[target]]` to link.\n')
  expect(html).toContain('<code')
  expect(html).toContain('[[target]]') // inside code the brackets are the writer's own characters
  expect(html).not.toContain('<a')
})

test('a resolver may promote a wikilink to an internal anchor, and declining leaves text', () => {
  const { html } = toHtml('Inside [[here]], outside [[elsewhere]].\n', {
    wikilinks: { resolve: (target) => (target === 'here' ? 'piece-1' : null) },
  })
  expect(html).toContain('<a href="#piece-1">here</a>')
  expect(html).toContain('outside elsewhere')
  expect(html).not.toContain('#elsewhere')
})

test('comments are removed, and a // line inside a fence is code and stays', () => {
  const { html } = toHtml('Kept prose.\n// a post-it note\nMore prose.\n\n```js\n// real code\n```\n')
  expect(html).not.toContain('a post-it note')
  expect(html).toContain('Kept prose.')
  expect(html).toContain('// real code')
})

test('frontmatter never leaves the app', () => {
  const { html } = toHtml('---\ntitle: Stage truth\nstatus: draft\n---\n\n# Real title\n\nBody.\n')
  expect(html).not.toContain('Stage truth')
  expect(html).not.toContain('status')
  expect(html).toContain('>Real title</h1>')
})

// ---- Options ----------------------------------------------------------------------------------

test('an unresolved image is reported, never silently dropped', () => {
  const result = toHtml('![A river](pictures/river.png) and ![ok](there.png)\n', {
    images: { resolve: (src) => (src === 'there.png' ? 'data:image/png;base64,AAAA' : null) },
  })
  expect(result.missingImages).toEqual(['pictures/river.png'])
  expect(result.html).toContain('A river')       // the alt text carries the meaning
  expect(result.html).toContain('data:image/png;base64,AAAA')
})

test('images can be omitted entirely, keeping their alt text', () => {
  const result = toHtml('![A river](pictures/river.png)\n', { images: 'omit' })
  expect(result.html).not.toContain('<img')
  expect(result.html).toContain('A river')
  expect(result.missingImages).toEqual([])
})

test('standalone wraps a complete document with its styles inlined', () => {
  const { html } = toHtml('# The Title\n\nBody.\n', { standalone: true })
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain('<meta charset="utf-8" />')
  expect(html).toContain('<title>The Title</title>')
  expect(html).toContain('<style>')
  expect(html).toContain('</html>')
  // Standalone headings carry ids so a contents list has somewhere to point.
  expect(html).toContain('id="the-title"')
})

test('an explicit title wins over the first heading', () => {
  expect(toHtml('# Heading\n', { standalone: true, title: 'Chosen' }).html).toContain('<title>Chosen</title>')
})

test('idPrefix namespaces every generated id so sections can be concatenated', () => {
  const { html } = toHtml('# Section\n\nNote[^1].\n\n[^1]: Text.\n', { idPrefix: 'p3-' })
  expect(html).toContain('id="p3-section"')
  expect(html).toContain('id="p3-fn-1"')
  expect(html).toContain('id="p3-fnref-1-1"')
  expect(html).toContain('href="#p3-fn-1"')
})

test('duplicate headings get distinct ids', () => {
  const { html } = toHtml('# Same\n\n# Same\n', { standalone: true })
  expect(html).toContain('id="same"')
  expect(html).toContain('id="same-2"')
})

test('headingOffset demotes a piece so a bundle can title its sections', () => {
  const { html } = toHtml('# One\n\n###### Six\n', { headingOffset: 1 })
  expect(html).toContain('>One</h2>')
  expect(html).toContain('>Six</h6>') // clamped, never h7
})

test('stable heading ids are opt-in for a fragment and disambiguated by content order', () => {
  const markdown = '# Scope\n\nFirst.\n\n# Scope\n\nSecond.\n'
  const first = toHtml(markdown, { stableHeadingIds: true }).html
  const second = toHtml(markdown, { stableHeadingIds: true }).html

  expect(first).toBe(second)
  expect(first).toContain('<h1 id="scope"')
  expect(first).toContain('<h1 id="scope-2"')
  expect(toHtml(markdown).html).not.toContain('id="scope"')
})

test('stable block ids use the enclosing section anchor and block order', () => {
  const markdown = 'Opening.\n\n# Scope\n\nFirst.\n\n- One\n- Two\n\n## Detail\n\nLast.\n'
  const first = toHtml(markdown, { stableHeadingIds: true, stableBlockIds: true }).html
  const second = toHtml(markdown, { stableHeadingIds: true, stableBlockIds: true }).html

  expect(first).toBe(second)
  expect(first).toContain('id="document-block-1"')
  expect(first).toContain('id="scope-block-1"')
  expect(first).toContain('id="scope-block-2"')
  expect(first).toContain('id="scope-block-3"')
  expect(first).toContain('id="detail-block-1"')
  expect(toHtml(markdown, { stableHeadingIds: true }).html).not.toContain('-block-')
})

test('a heading named Document cannot collide with the pre-heading block namespace', () => {
  const html = toHtml('Opening.\n\n# Document\n\nBody.\n', {
    stableHeadingIds: true,
    stableBlockIds: true,
  }).html
  const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])

  expect(new Set(ids).size).toBe(ids.length)
})

test('every collected reader-note target exists after footnote paragraphs are flattened', () => {
  const result = toHtml('# Scope\n\nA note[^1].\n\n[^1]: Footnote text.\n', {
    standalone: true,
    readerNotes: { documentId: 'writeflex-footnote-proof' },
  })

  for (const target of result.interactionTargets) {
    expect(result.html).toContain(`id="${target}"`)
  }
})

// ---- Escaping and characters -------------------------------------------------------------------

test('every character is escaped, and entities decode to the character they name', () => {
  const { html } = toHtml('5 < 6 & 7 > 4, "quoted", &amp; &mdash; &#233;\n')
  expect(html).toContain('5 &lt; 6 &amp; 7 &gt; 4')
  expect(html).toContain('&amp; — é')
})

test('Czech text and em-dashes survive unchanged', () => {
  const { html } = toHtml('Čeština — příliš žluťoučký kůň úpěl ďábelské ódy.\n')
  expect(html).toContain('Čeština — příliš žluťoučký kůň úpěl ďábelské ódy.')
})

test('an escaped character is emitted as the character, not the backslash', () => {
  expect(toHtml('a \\*not emphasis\\* b\n').html).toContain('a *not emphasis* b')
})

test('a hard break travels as a line break', () => {
  expect(toHtml('one  \ntwo\n').html).toContain('<br />')
})

test('an empty document emits nothing', () => {
  const result = toHtml('')
  expect(result.html).toBe('')
  expect(result.footnotes).toBe(0)
})

test('a document that is only frontmatter emits nothing', () => {
  expect(toHtml('---\ntitle: x\n---\n').html).toBe('')
})

// ---- <kbd> key caps (onboarding ticket 05) ----

test('a bare <kbd>…</kbd> pair is emitted as a key cap element, in a quotation too', () => {
  const { html } = toHtml('Press <kbd>⌘K</kbd> now.\n\n> Fold. Press <kbd>⌃⌘0</kbd>.\n')
  expect(html).toMatch(/<kbd style="[^"]*">⌘K<\/kbd>/)
  expect(html).toMatch(/<blockquote[^>]*>.*<kbd style="[^"]*">⌃⌘0<\/kbd>/s)
})

test('only the bare kbd pair gets through; other raw HTML and unpaired tags are still shown, not run', () => {
  const { html } = toHtml('<kbd onclick="x()">A</kbd> and <b>C</b>\n')
  expect(html).not.toContain('<kbd onclick')
  expect(html).toContain('&lt;kbd onclick="x()"&gt;A')
  expect(html).not.toContain('<b>')
  expect(html).toContain('&lt;b&gt;')
  const unpaired = toHtml('Press <kbd>B alone\n').html
  expect(unpaired).not.toContain('<kbd')
})

test('workspace image URLs require an explicit per-window preview origin; normal exports still refuse them', () => {
  const source = '![Local](assets/a.png)'
  expect(toHtml(source, { images: { resolve: () => 'wf-asset://window-token/assets/a.png' } }).html).not.toContain('<img')
  expect(toHtml(source, { images: { workspaceAssetBase: 'wf-asset://window-token', resolve: () => 'wf-asset://window-token/assets/a.png' } }).html).toContain('<img src="wf-asset://window-token/assets/a.png"')
  expect(toHtml(source, { images: { workspaceAssetBase: 'wf-asset://window-token', resolve: () => 'wf-asset://other-token/assets/a.png' } }).html).not.toContain('<img')
  expect(toHtml(source, { images: { workspaceAssetBase: 'wf-asset://window-token', resolve: () => 'javascript:alert(1)' } }).html).not.toContain('<img')
})
