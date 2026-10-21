import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clipboardPayload } from '../../src/main/clipboard'
import { exportBundle, exportDocument, type HtmlExportOptions } from '../../src/main/export'
import { Workspace } from '../../src/main/workspace'
import { assembleDocument, TABLE_RUNTIME_SCRIPT as BUILT_TABLE_SCRIPT, tableRuntimeFill, tableRuntimeScript } from '../../src/shared/markdown/html-document'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toRtf } from '../../src/shared/markdown/to-rtf'

// The emitter seam of sort, filter and search on exported tables: the wrapper around a table, the
// table styles and the one page script reach the HTML FILE export and nothing else.

const TABLE = '| Left | Right |\n| --- | ---: |\n| One | 2 |\n'
const TWO_TABLES = `# Tables\n\n${TABLE}\nBetween.\n\n${TABLE}`
const NO_TABLE = '# Prose\n\nA paragraph with `code` and a [link](https://example.com).\n'
const REGION = '<div class="wf-table-region table-scroll">'
// As the emitter writes it: the stylesheet's own comment mentions the bare tag, so counts use this.
const WRAPPED = `${REGION}<table`
const SCRIPT_OPEN = '<script data-writeflex-table-runtime>'
const TABLE_STYLE_MARK = '.wf-table-region,.wf-table-bar{--wt-ink'
const POLICY = `<head><meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'; worker-src 'none'">`
const count = (text: string, part: string) => text.split(part).length - 1
// Null only when the script's own source is unsafe to inline, which the source test below fails on by name.
const TABLE_RUNTIME_SCRIPT: string = BUILT_TABLE_SCRIPT ?? '(the table script was left out)'

const TEMPLATES: Record<string, HtmlExportOptions> = {
  'plain page': { sidebar: false, titleBlock: false, summaryTiles: false, frontPage: false, readerNotes: false, readerEdits: false, frontmatterFields: [] },
  'styled page without the sidebar': { sidebar: false, titleBlock: true },
  'styled page with the sidebar': { sidebar: true, titleBlock: true },
}

let root: string, out: string, ws: Workspace
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-table-regions-')); out = await mkdtemp(join(tmpdir(), 'wf-table-regions-out-')); ws = new Workspace(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }) })
async function exported(markdown: string, html?: HtmlExportOptions): Promise<string> {
  await writeFile(join(root, 'doc.md'), markdown)
  const result = await exportDocument(ws, { path: 'doc.md', format: 'html', target: join(out, 'doc.html'), ...(html ? { html } : {}) })
  return readFile(result.target, 'utf8')
}

test('with table regions on, a table is wrapped once and its own markup is what it is without them', () => {
  const bare = toHtml(TABLE).html
  const wrapped = toHtml(TABLE, { tableRegions: true }).html
  expect(bare.startsWith('<table border="1" cellspacing="0" cellpadding="6"')).toBe(true)
  expect(wrapped).toBe(`${REGION}${bare}</div>`)
  expect(toHtml(TABLE, { tableRegions: false }).html).toBe(bare)
})

test('a copy never carries the wrapper, the table styles or the table script', async () => {
  const copy = (await clipboardPayload(TWO_TABLES, 'rich')).payload
  expect(copy.html).toBe(toHtml(TWO_TABLES, { images: 'omit' }).html)
  expect(copy.html).not.toContain('wf-table-region')
  expect(copy.html).not.toContain('<script')
  expect(copy.html).toContain('<table border="1"')
  expect(toRtf(TWO_TABLES)).not.toContain('wf-table-region')
  expect(copy.text).not.toContain('wf-table-region')
})

test('a standalone page made without table regions has neither the styles nor the script', () => {
  const { html } = toHtml(TWO_TABLES, { standalone: true })
  expect(html).not.toContain('wf-table-region')
  expect(html).not.toContain('data-writeflex-table-runtime')
})

for (const [name, options] of Object.entries(TEMPLATES)) {
  test(`HTML file export, ${name}: every table is wrapped, and the styles and the script are there exactly once`, async () => {
    const html = await exported(TWO_TABLES, options)
    expect(count(html, WRAPPED)).toBe(2)
    expect(count(html, SCRIPT_OPEN)).toBe(1)
    expect(count(html, TABLE_RUNTIME_SCRIPT)).toBe(1)
    expect(count(html, TABLE_STYLE_MARK)).toBe(1)
    // the styles are in the head's one style element, the script after the last table
    expect(html.indexOf(TABLE_STYLE_MARK)).toBeLessThan(html.indexOf('</style>'))
    expect(html.indexOf(SCRIPT_OPEN)).toBeGreaterThan(html.lastIndexOf('</table></div>'))
    expect(html).not.toContain('Content-Security-Policy')
  })

  test(`HTML file export, ${name}: a document with no table gets nothing, and a table adds the wrapper, the styles and the script and nothing else`, async () => {
    const none = await exported(NO_TABLE, options)
    expect(none).not.toContain('wf-table-region')
    expect(none).not.toContain('data-writeflex-table-runtime')
    expect(none).not.toContain('Content-Security-Policy')
    // Take the three additions out of an export with a table and no trace of the feature is left.
    const withTable = await exported(`${NO_TABLE}\n${TABLE}`, options)
    const css = await readFile(join(import.meta.dir, '../../src/shared/markdown/export-table.css'), 'utf8')
    const without = withTable.replace(`\n${css}</style>`, () => '</style>').replace(`\n${TABLE_RUNTIME_SCRIPT}`, () => '').replace(`${REGION}<table`, () => '<table').replace('</table></div>', () => '</table>')
    expect(without).not.toContain('wf-table-region')
    expect(without).not.toContain('<script data-writeflex-table')
    expect(withTable.length - without.length).toBe(css.length + 1 + TABLE_RUNTIME_SCRIPT.length + 1 + REGION.length + '</div>'.length)
    // and what is left is the no-table page plus the bare table
    expect(without.replace(`\n${toHtml(TABLE).html}`, () => '')).toBe(none)
  })
}

test('a Folio export of several pieces carries one script for all their tables', async () => {
  await writeFile(join(root, '01-a.md'), `# A\n\n${TABLE}`)
  await writeFile(join(root, '02-b.md'), `# B\n\n${TABLE}\n${TABLE.replace('One', 'Uno')}`)
  await writeFile(join(root, '_report-structure.json'), JSON.stringify({ schema_version: 1, files: [{ path: '01-a.md', role: 'section' }, { path: '02-b.md', role: 'section' }] }))
  const result = await exportBundle(ws, { dir: '', format: 'html', target: join(out, 'folio.html') })
  const html = await readFile(result.target, 'utf8')
  expect(count(html, WRAPPED)).toBe(3)
  expect(count(html, SCRIPT_OPEN)).toBe(1)
  expect(count(html, TABLE_STYLE_MARK)).toBe(1)
})

test('text that only looks like a table region (a code fence, inline code, raw HTML) brings no script', async () => {
  const html = await exported('# Code\n\n```html\n<div class="wf-table-region"><table></table></div>\n```\n\nInline `<div class="wf-table-region">` and raw:\n\n<div class="wf-table-region">x</div>\n')
  expect(html).toContain('&lt;div class="wf-table-region"&gt;')
  expect(html).not.toContain('data-writeflex-table-runtime')
  expect(html).not.toContain(TABLE_STYLE_MARK)
})

test('the page policy is the same string with a table on the page, and the widget is byte-equal', async () => {
  await writeFile(join(root, 'w.html'), '<!doctype html><title>Scores</title><button onclick="this.textContent=\'Compared\'">Compare</button>')
  const widgetOnly = await exported('# Results\n\n[Simulation: w.html]\n')
  const both = await exported(`# Results\n\n[Simulation: w.html]\n\n${TABLE}`)
  for (const html of [widgetOnly, both]) {
    expect(count(html, 'http-equiv="Content-Security-Policy" content="frame-src')).toBe(1)
    expect(html).toContain(POLICY)
    // the host policy names no script or default source: one would also bind every widget frame
    const policy = /<head><meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(html)![1]
    expect(policy).toBe(`frame-src 'none'; child-src 'none'; worker-src 'none'`)
    expect(policy).not.toContain('script-src')
    expect(policy).not.toContain('default-src')
  }
  const figure = (html: string) => html.slice(html.indexOf('<figure class="wf-export-widget"'), html.indexOf('</figure>') + '</figure>'.length)
  expect(figure(both)).toBe(figure(widgetOnly))
  expect(figure(both)).toContain('srcdoc="')
  // the widget host script is still first in the body, the table script last
  const hostScript = (html: string) => html.slice(html.indexOf('<script>\n(() => {\n  const states'), html.indexOf('</script>', html.indexOf('const states')))
  expect(hostScript(both)).toBe(hostScript(widgetOnly))
  expect(count(both, SCRIPT_OPEN)).toBe(1)
  expect(count(widgetOnly, SCRIPT_OPEN)).toBe(0)
  // a table and no widget: no policy at all
  expect(await exported(TABLE)).not.toContain('Content-Security-Policy')
})

test('the table script is one static element that no document text can end, enter or change', async () => {
  const source = await readFile(join(import.meta.dir, '../../src/shared/markdown/export-table-runtime.js'), 'utf8')
  expect(TABLE_RUNTIME_SCRIPT).toBe(`<script data-writeflex-table-runtime>\n${source}\n</script>`)
  expect(source.toLowerCase()).not.toContain('</script')
  expect(source).not.toContain('<!--')
  expect(count(TABLE_RUNTIME_SCRIPT.toLowerCase(), '</script')).toBe(1)
  // Whatever the document says, the script in the page is that same string.
  const hostile = [
    '# {{body}} {{reader-notes}} {{styles}} {{runtime}}',
    '',
    '| {{runtime}} | </script><script>alert(1)</script> |',
    '| --- | --- |',
    '| {{reader-notes}} | <img src=x onerror=alert(1)> |',
    '| {{body}} | "quoted" \'single\' $& $1 $` |',
    '',
  ].join('\n')
  for (const options of [undefined, { readerNotes: true, readerEdits: true }] as const) {
    const html = await exported(hostile, options)
    expect(count(html, TABLE_RUNTIME_SCRIPT)).toBe(1)
    expect(count(html, SCRIPT_OPEN)).toBe(1)
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('{{reader-notes}}')
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;')
    // nothing follows the table script inside the body fill but the page's own markup
    const after = html.slice(html.indexOf(TABLE_RUNTIME_SCRIPT) + TABLE_RUNTIME_SCRIPT.length)
    expect(after).not.toContain('alert(1)')
  }
})

test('the table script uses none of the ways a string becomes markup or code, and no network, storage or message listener', async () => {
  const source = await readFile(join(import.meta.dir, '../../src/shared/markdown/export-table-runtime.js'), 'utf8')
  // Judged on the code alone: the comments name what is avoided, and the SVG namespace is a name, never fetched.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace('http://www.w3.org/2000/svg', '').replace(/(^|\s)\/\/.*$/gm, '')
  // The list below proves nothing about code the stripping removed, so what is left must still be the
  // whole script: it compiles, and it still holds the line that starts the work.
  expect(() => new Function(code)).not.toThrow()
  expect(code).toContain("document.querySelectorAll('.wf-table-region')")
  expect(code.length).toBeGreaterThan(source.length * 0.6)
  for (const banned of [
    /innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\s*\.\s*write/, /\beval\b/, /\bFunction\b/, /DOMParser/, /createContextualFragment/, /srcdoc/,
    /setAttribute\(\s*['"`]on/, /RegExp/, /\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /sendBeacon/, /\bimport\b/, /Storage\b/, /indexedDB/, /cookie/,
    /['"`]message['"`]/, /onmessage/, /postMessage/, /contentWindow/, /contentDocument/, /iframe/, /\bframes\b/, /https?:/, /\bsrc\b/, /\bhref\b/,
  ]) expect(`${banned} ${banned.test(code)}`).toBe(`${banned} false`)
  // timers take a function, never a string
  expect(/setTimeout\(\s*['"`]/.test(source)).toBe(false)
})

test('assembling a body that holds a table region adds the script after the body; one that does not is unchanged', () => {
  const body = `${REGION}<table><tbody><tr><td>1</td></tr></tbody></table></div>`
  const page = assembleDocument({ title: 'T', body, sidebar: false, titleBlock: false })
  expect(page).toContain(`${body}\n${TABLE_RUNTIME_SCRIPT}`)
  const plain = assembleDocument({ title: 'T', body: '<p>None</p>', sidebar: false, titleBlock: false })
  expect(plain).not.toContain('wf-table-region')
  expect(plain).not.toContain('<script')
})

test('the table script source is safe to inline, and writes its combining-marks range as escapes', async () => {
  const source = await readFile(join(import.meta.dir, '../../src/shared/markdown/export-table-runtime.js'), 'utf8')
  // The protection that used to throw when the module loaded: the source never ends its own element
  // and never opens a comment. Checked here, before release, over the file itself.
  expect(/<\/script|<!--/i.test(source)).toBe(false)
  expect(BUILT_TABLE_SCRIPT).not.toBeNull()
  expect(tableRuntimeScript(source)).toBe(`<script data-writeflex-table-runtime>\n${source}\n</script>`)
  // Raw combining characters are invisible in an editor and easy to lose in a copy.
  expect(/[\u0300-\u036f]/.test(source)).toBe(false)
  expect(source).toContain(String.raw`.replace(/[\u0300-\u036f]/g, '')`)
})

test('a table script that could end its own element is left out and logged; nothing throws and the page is whole', () => {
  for (const unsafe of ['const a = "</script>"', 'const a = "</SCRIPT"', 'const a = "<!--"']) expect(tableRuntimeScript(unsafe)).toBeNull()
  expect(tableRuntimeScript('const a = 1')).toBe('<script data-writeflex-table-runtime>\nconst a = 1\n</script>')
  const logged = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(tableRuntimeFill(null)).toBe('')
    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0][0])).toContain('table script')
    expect(tableRuntimeFill('<script>x</script>')).toBe('\n<script>x</script>')
    expect(logged).toHaveBeenCalledTimes(1)
  } finally { logged.mockRestore() }
})
