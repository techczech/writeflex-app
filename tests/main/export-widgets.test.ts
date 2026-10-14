import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Workspace } from '../../src/main/workspace'
import { exportBundle, exportDocument } from '../../src/main/export'
import { listCollection } from '../../src/main/collection'
let root: string, out: string, ws: Workspace
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-widgets-')); out = await mkdtemp(join(tmpdir(), 'wf-widget-export-')); ws = new Workspace(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }) })
async function put(path: string, content: string) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content) }
const widget = '<!doctype html><title>Compare &amp; inspect</title><button onclick="this.textContent=\'Working\'">Compare</button>'
test('HTML export carries a sealed, escaped widget with a readable caption, not an embed marker', async () => {
  await put('parts/a.md', '# Results\n\n[Simulation: ../assets/w.html]\n')
  await put('assets/w.html', widget)
  const result = await exportDocument(ws, { path: 'parts/a.md', format: 'html', target: join(out, 'report.html') })
  const html = await readFile(result.target, 'utf8')
  expect(html).toContain('<iframe')
  expect(html).toContain('sandbox="allow-scripts allow-forms"')
  expect(html).toContain('srcdoc="')
  // The PARENT document's policy: an unescaped meta in the host's own head, before the first frame.
  // (The widget's own policy is escaped inside srcdoc and would not satisfy this.)
  const host = html.slice(0, html.indexOf('<iframe'))
  expect(host).toContain(`<head><meta http-equiv="Content-Security-Policy" content="frame-src 'none'; child-src 'none'; worker-src 'none'">`)
  expect(html).toContain('&lt;meta http-equiv=&quot;Content-Security-Policy&quot;')
  expect(html).toContain('<figcaption>Compare &amp; inspect</figcaption>')
  expect(html).not.toContain('allow-same-origin')
  expect(html).not.toContain('[Simulation:')
  expect(html).not.toContain(root)
  expect(html).not.toContain('<button onclick=')
})
test('Folio export follows only its explicit ordered parts, including nested appendices', async () => {
  await put('folio/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'z.md', role: 'section' }, { path: 'evidence/passage.md', role: 'appendix' }] }))
  await put('folio/z.md', '# Report first\n\n[[Passage context]]\n\n[Read original and translation](evidence/passage.md)\n')
  await put('folio/evidence/passage.md', '# Passage context\n\nOriginal and translation\n\n[Simulation: ../assets/w.html]\n')
  await put('folio/assets/w.html', widget)
  await put('folio/a-private.md', '# PRIVATE_UNLISTED_CANARY')
  const result = await exportBundle(ws, { dir: 'folio', format: 'html', target: join(out, 'report.html') })
  const html = await readFile(result.target, 'utf8')
  expect(result.pieces).toBe(2)
  expect(html).toContain('Original and translation')
  expect(result.listed).toBe(2)
  expect(html).toContain('href="#p2-section">Read original and translation')
  expect(html).toContain('href="#p2-section">Passage context')
  expect(html).toContain('<iframe')
  expect(html).not.toContain('PRIVATE_UNLISTED_CANARY')
})
test('missing and outside-workspace widgets leave a visible explanation without reading outside', async () => {
  await writeFile(join(out, 'secret.html'), '<p>PRIVATE_OUTSIDE_CANARY</p>')
  await symlink(join(out, 'secret.html'), join(root, 'escape.html'))
  await put('a.md', '# Refusals\n\n[Simulation: escape.html]\n\n[Simulation: missing.html]\n\n[Embed: https://example.com]\n')
  const html = await readFile((await exportDocument(ws, { path: 'a.md', format: 'html', target: join(out, 'report.html') })).target, 'utf8')
  expect(html).not.toContain('PRIVATE_OUTSIDE_CANARY')
  expect(html).not.toContain('<iframe')
  expect(html.match(/Interactive widget unavailable/g)?.length).toBe(3)
  expect(html).not.toContain(root)
})
test('Folio export never reads a listed entry outside its folder, and reports how many were listed', async () => {
  await put('folio/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'a.md' }, { path: '../journal/private.md' }, { path: join(root, 'journal/private.md') }, { path: 'gone.md' }] }))
  await put('folio/a.md', '# Inside\n\nKept.\n')
  await put('journal/private.md', '# PRIVATE_OUTSIDE_FOLIO_CANARY\n')
  const result = await exportBundle(ws, { dir: 'folio', format: 'html', target: join(out, 'report.html') })
  const html = await readFile(result.target, 'utf8')
  expect(result.pieces).toBe(1)
  expect(result.listed).toBe(4)
  expect(html).toContain('Kept.')
  expect(html).not.toContain('PRIVATE_OUTSIDE_FOLIO_CANARY')
})
test('a content_root that leaves the Folio folder exports nothing: not the outside file, not the file of the same name inside', async () => {
  await put('folio/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '..', files: [{ path: 'journal/private.md' }, { path: 'a.md' }] }))
  await put('folio/a.md', '# Inside\n\nNOT_LISTED_UNDER_THIS_ROOT\n')
  await put('journal/private.md', '# PRIVATE_OUTSIDE_FOLIO_CANARY\n')
  const target = join(out, 'report.html')
  await expect(exportBundle(ws, { dir: 'folio', format: 'html', target })).rejects.toThrow('There are no pieces in folio to export.')
  expect(existsSync(target)).toBe(false)
})
test('placeholder text in a widget, a title or a body is exported as written', async () => {
  const marked = '<!doctype html><title>Template lab</title><p id="t">{{reader-notes}} {{front-page}} {{body}} {{styles}}</p>'
  await put('folio/_report-structure.json', JSON.stringify({ schema_version: 1, files: [{ path: 'a.md' }, { path: 'b.md' }] }))
  await put('folio/a.md', '# {{body}}\n\nProse says {{reader-notes}} and {{front-page}}.\n\n[Simulation: w.html]\n')
  await put('folio/b.md', '# Second\n\nSECOND_BODY_MARK\n')
  await put('folio/w.html', marked)
  for (const options of [{}, { readerNotes: true, frontPage: true }, { sidebar: false, titleBlock: false }]) {
    const result = await exportBundle(ws, { dir: 'folio', format: 'html', target: join(out, 'report.html'), html: options })
    const html = await readFile(result.target, 'utf8')
    // The widget's source reaches srcdoc byte for byte (escaped once as an attribute), placeholders included.
    expect(html).toContain('&lt;p id=&quot;t&quot;&gt;{{reader-notes}} {{front-page}} {{body}} {{styles}}&lt;/p&gt;')
    expect(html).toContain('Prose says {{reader-notes}} and {{front-page}}.')
    expect(html).toContain('>{{body}}</h2>')
    expect(html.match(/SECOND_BODY_MARK/g)?.length).toBe(1)
    expect(html.match(/id="writeflex-interaction-manifest"/g)?.length ?? 0).toBe('readerNotes' in options ? 1 : 0)
  }
  const single = await readFile((await exportDocument(ws, { path: 'folio/a.md', format: 'html', target: join(out, 'one.html'), html: { readerNotes: true } })).target, 'utf8')
  expect(single).toContain('&lt;p id=&quot;t&quot;&gt;{{reader-notes}} {{front-page}} {{body}} {{styles}}&lt;/p&gt;')
  expect(single.match(/id="writeflex-interaction-manifest"/g)?.length).toBe(1)
})
test('Word writes the pieces directly in the folder: the count the sheet shows for Word is the Collection rows', async () => {
  await put('folio/_report-structure.json', JSON.stringify({ schema_version: 1, files: [{ path: 'z.md' }, { path: 'evidence/passage.md' }] }))
  await put('folio/z.md', '# Report first\n')
  await put('folio/evidence/passage.md', '# Passage context\n')
  const word = await exportBundle(ws, { dir: 'folio', format: 'docx', target: join(out, 'report.docx') })
  expect(word.pieces).toBe((await listCollection(ws, 'folio')).rows.length)
  expect([word.pieces, word.listed]).toEqual([1, 1])
  // Every listed part nested: Word has nothing to write and says so; HTML writes the listed part.
  await put('nested/_report-structure.json', JSON.stringify({ schema_version: 1, files: [{ path: 'evidence/passage.md' }] }))
  await put('nested/evidence/passage.md', '# Passage context\n')
  expect((await listCollection(ws, 'nested')).rows.length).toBe(0)
  await expect(exportBundle(ws, { dir: 'nested', format: 'docx', target: join(out, 'nested.docx') })).rejects.toThrow('There are no pieces in nested to export')
  expect((await exportBundle(ws, { dir: 'nested', format: 'html', target: join(out, 'nested.html') })).pieces).toBe(1)
})
