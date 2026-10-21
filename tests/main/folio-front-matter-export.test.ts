// Folio front matter in the export (ADR-0046, ticket B of 0.25.1): front matter is exported first and never in the
// contents (the sidebar links, the summary tiles); a title page is the cover in place of the generated one, its
// title above its body and no chips; with no title page the generated cover is as before. Word: the title page
// first of all, then the other front matter, then the contents.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// jszip is the zip library `docx` itself packs with (export-external-links.test.ts reads Word the same way): no
// outside tool, so a package that cannot be read fails the test instead of skipping it.
import JSZip from 'jszip'
import { exportBundle } from '../../src/main/export'
import { MANIFEST_NAME } from '../../src/main/folio'
import { folioFrontMatter, frontMatterExportOrder } from '../../src/main/folio-front-matter'
import { Workspace } from '../../src/main/workspace'
import { TITLE_PAGE_COVER_CHIPS, titlePageCoverChips } from '../../src/shared/markdown/html-document'

let root: string
let out: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-front-export-'))
  out = await mkdtemp(join(tmpdir(), 'wf-front-export-out-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const TITLE = 'Pangram evaluation: proposal and proof of concept'
const BYLINE = 'Dominik Lukeš · 14 October 2026 · For discussion'

/** The Pangram Folio after Add as front matter: the title page listed first as front matter. */
async function pangram(options: { titlePage?: boolean; preface?: boolean } = {}): Promise<void> {
  const { titlePage = true, preface = false } = options
  const files = [
    ...(titlePage ? [{ id: 'title-matter', path: '00-frontmatter.md', role: 'front-matter', toc: false }] : []),
    ...(preface ? [{ path: '00b-preface.md', role: 'front-matter', toc: false }] : []),
    { id: 'executive-summary', path: '01-executive-summary.md', role: 'executive-summary', render: 'section', toc: true },
    { id: 'report-body', path: '02-report.md', role: 'report-body', render: 'sections', toc: true },
  ]
  await write(`pangram/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: 'contents', ...(titlePage ? { title_matter: 'contents/00-frontmatter.md' } : {}), files, title: TITLE }, null, 2)}\n`)
  if (titlePage) await write('pangram/contents/00-frontmatter.md', `---\nrole: title-matter\ntitle: "${TITLE}"\nauthor: Dominik Lukeš\ndate: 2026-10-14\nstatus: draft-for-review\n---\n\n${BYLINE}\n`)
  if (preface) await write('pangram/contents/00b-preface.md', '---\nrole: front-matter\ntitle: Preface\n---\n\nWhy this proposal was written.\n')
  await write('pangram/contents/01-executive-summary.md', '---\ntitle: Summary\nauthor: Dominik Lukeš\n---\n\n## Summary\nTo test the feasibility of evaluating current AI detection tools.\n')
  await write('pangram/contents/02-report.md', '---\ntitle: Details\n---\n# Details\n## Background and purpose\nAdvances in AI writing detection.\n')
}

async function html(options: Record<string, unknown> = {}): Promise<string> {
  const target = join(out, 'pangram.html')
  await exportBundle(ws, { dir: 'pangram', format: 'html', target, html: options })
  return readFile(target, 'utf8')
}

const between = (text: string, start: string, end: string): string => {
  const from = text.indexOf(start)
  if (from < 0) return ''
  const to = text.indexOf(end, from)
  return text.slice(from, to < 0 ? undefined : to + end.length)
}
const coverOf = (page: string): string => between(page, '<section class="front-page"', '</section>')
const tocOf = (page: string): string => between(page, '<nav id="toc">', '</nav>')
const articleOf = (page: string): string => between(page, '<article class="content">', '</article>')

/** The Word export of the Folio at `dir`, its document.xml as text. A package that cannot be read fails the test. */
async function wordXml(dir: string): Promise<string> {
  const target = join(out, `${dir.replace(/\//g, '-')}.docx`)
  await exportBundle(ws, { dir, format: 'docx', target })
  const document = (await JSZip.loadAsync(await readFile(target))).file('word/document.xml')
  expect(document).not.toBeNull()
  return document!.async('string')
}

test('the front matter of the Folio, by its manifest: the title page is the title_matter file or a title-matter header', async () => {
  await pangram({ preface: true })
  expect(await folioFrontMatter(ws, 'pangram')).toEqual({ front: ['pangram/contents/00-frontmatter.md', 'pangram/contents/00b-preface.md'], titlePage: 'pangram/contents/00-frontmatter.md' })
  expect(frontMatterExportOrder(['c.md', 'p.md', 't.md', 'a.md'], { front: ['p.md', 't.md'], titlePage: 't.md' })).toEqual({ titlePage: 't.md', front: ['p.md'], contents: ['c.md', 'a.md'] })
})

test('the title page is the cover: its title, its body as written beneath, and the Date / Status / Author chips', async () => {
  await pangram()
  const page = await html({ frontPage: true })
  const cover = coverOf(page)
  expect(cover).toContain(`<h1 class="front-page-title">${TITLE}</h1>`)
  expect(cover).toContain('class="front-page-body"')
  expect(cover).toContain(BYLINE)
  expect(cover).toContain('meta-row')
  expect(cover).toContain('draft-for-review')
  // It is not also a section of the body, and never in the contents.
  expect(articleOf(page)).not.toContain(BYLINE)
  expect(tocOf(page)).not.toContain(TITLE)
  expect(tocOf(page)).toContain('Summary')
  expect(tocOf(page)).toContain('Details')
})

test('the chips under a title-page cover are one switch, on as approved', () => {
  expect(TITLE_PAGE_COVER_CHIPS).toBe(true)
  const data = { frontmatter: { date: '2026-10-14', status: 'draft-for-review' }, outline: [], metadata: { title: TITLE, description: null, purpose: null, status: null, modified: 0, words: 0 } }
  expect(titlePageCoverChips({ title: TITLE, body: '', data }, 'a', false)).toBe('')
  expect(titlePageCoverChips({ title: TITLE, body: '', data }, 'a')).toContain('draft-for-review')
  const shown = titlePageCoverChips({ title: TITLE, body: '', data }, 'a', true)
  expect(shown).toContain('meta-row')
  expect(shown).toContain('draft-for-review')
})

test('front matter is exported before the contents and never listed in them; with the cover off the title page leads the body', async () => {
  await pangram({ preface: true })
  const page = await html({ frontPage: false })
  expect(coverOf(page)).toBe('')
  const article = articleOf(page)
  const at = (text: string): number => article.indexOf(text)
  expect(at('id="wf-title-page"')).toBeGreaterThanOrEqual(0)
  expect(at('id="wf-title-page"')).toBeLessThan(at('id="f1-section"'))
  expect(at('id="f1-section"')).toBeLessThan(at('id="p1-section"'))
  expect(at('id="p1-section"')).toBeLessThan(at('id="p2-section"'))
  expect(at(BYLINE)).toBeLessThan(at('Why this proposal was written.'))
  const toc = tocOf(page)
  expect(toc).not.toContain('Preface')
  expect(toc).not.toContain(TITLE)
  expect(toc).toContain('href="#p1-section"')
  expect(toc).toContain('href="#p2-section"')
  expect(toc).not.toContain('f1-')
})

test('the summary tiles count the contents only', async () => {
  await pangram({ preface: true })
  const words = (page: string): string | undefined => /<div class="summary-card"><b>([\d,]+)<\/b><span>words<\/span>/.exec(page)?.[1]
  const withFront = words(await html({ summaryTiles: true }))
  await rm(join(root, 'pangram'), { recursive: true, force: true })
  await pangram({ titlePage: false, preface: false })
  const contentsOnly = words(await html({ summaryTiles: true }))
  expect(contentsOnly).toMatch(/^\d+$/)
  expect(withFront).toBe(contentsOnly)
})

test('with no title page the generated cover is as before: the Folio title, no title-page body', async () => {
  await pangram({ titlePage: false })
  const page = await html({ frontPage: true })
  const cover = coverOf(page)
  expect(cover).toContain(`<h1 class="front-page-title">${TITLE}</h1>`)
  expect(cover).not.toContain('front-page-body')
  expect(articleOf(page)).not.toContain('wf-title-page')
})

test('Word: the title page first of all, then the other front matter, then the contents', async () => {
  // A flat Folio whose manifest lists the title page after the preface (an outside edit): the export still leads with it.
  await write(`flat/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: '', files: [
    { path: 'a-preface.md', role: 'front-matter', toc: false },
    { path: 'b-title.md', role: 'title-matter', toc: false },
    { path: 'c-body.md' },
  ] }, null, 2)}\n`)
  await write('flat/a-preface.md', '---\ntitle: Preface words\n---\n\nPREFACE-TEXT\n')
  await write('flat/b-title.md', '---\nrole: title-matter\ntitle: Cover words\n---\n\nTITLE-TEXT\n')
  await write('flat/c-body.md', '# Body words\n\nBODY-TEXT\n')
  const xml = await wordXml('flat')
  const title = xml.indexOf('TITLE-TEXT')
  const preface = xml.indexOf('PREFACE-TEXT')
  const body = xml.indexOf('BODY-TEXT')
  expect(title).toBeGreaterThanOrEqual(0)
  expect(title).toBeLessThan(preface)
  expect(preface).toBeLessThan(body)
})

test('Word on a content_root Folio follows its manifest: the title page, the preface, then the contents, as HTML counts them', async () => {
  await pangram({ preface: true })
  const xml = await wordXml('pangram')
  const at = [BYLINE, 'Why this proposal was written.', 'To test the feasibility', 'Advances in AI writing detection.'].map((text) => xml.indexOf(text))
  expect(at.every((index) => index >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  const word = await exportBundle(ws, { dir: 'pangram', format: 'docx', target: join(out, 'count.docx') })
  const page = await exportBundle(ws, { dir: 'pangram', format: 'html', target: join(out, 'count.html') })
  expect([word.pieces, word.listed]).toEqual([4, 4])
  expect([word.pieces, word.listed]).toEqual([page.pieces, page.listed])
})

test('a part tagged #front-matter only on its Index Note line is front matter in the export: out of the HTML contents, first in the body', async () => {
  // No manifest role, no title_matter: the line tag alone marks it (ADR-0046), as it does in the Plan.
  await write(`tagged/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, files: [{ path: 'a-body.md' }, { path: 'b-preface.md' }, { path: 'c-more.md' }] }, null, 2)}\n`)
  await write('tagged/a-body.md', '# Body words\n\nBODY-TEXT\n')
  await write('tagged/b-preface.md', '# Preface words\n\nPREFACE-TEXT\n')
  await write('tagged/c-more.md', '# More words\n\nMORE-TEXT\n')
  await write('tagged/_tagged_INDEX.md', '# Tagged\n\n## Running order\n\n- [[Body words]]\n- [[Preface words]] #front-matter\n- [[More words]]\n')
  expect((await folioFrontMatter(ws, 'tagged')).front).toEqual(['tagged/b-preface.md'])
  const target = join(out, 'tagged.html')
  await exportBundle(ws, { dir: 'tagged', format: 'html', target, html: { frontPage: false } })
  const page = await readFile(target, 'utf8')
  expect(tocOf(page)).not.toContain('Preface words')
  expect(tocOf(page)).toContain('Body words')
  expect(tocOf(page)).toContain('More words')
  const article = articleOf(page)
  expect(article.indexOf('PREFACE-TEXT')).toBeGreaterThanOrEqual(0)
  expect(article.indexOf('PREFACE-TEXT')).toBeLessThan(article.indexOf('BODY-TEXT'))
  // Word reads the same front matter.
  const xml = await wordXml('tagged')
  expect(xml.indexOf('PREFACE-TEXT')).toBeLessThan(xml.indexOf('BODY-TEXT'))
})

test('the title_matter file is front matter whatever role its entry names: the title page, and the cover', async () => {
  await write(`t/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, title_matter: 't.md', title: 'Folio T', files: [{ path: 'b.md' }, { path: 't.md', role: 'section' }] }, null, 2)}\n`)
  await write('t/t.md', '---\ntitle: Cover words\n---\n\nTITLE-TEXT\n')
  await write('t/b.md', '# Body words\n\nBODY-TEXT\n')
  expect(await folioFrontMatter(ws, 't')).toEqual({ front: ['t/t.md'], titlePage: 't/t.md' })
  const target = join(out, 't.html')
  await exportBundle(ws, { dir: 't', format: 'html', target, html: { frontPage: true } })
  const page = await readFile(target, 'utf8')
  const cover = coverOf(page)
  expect(cover).toContain('<h1 class="front-page-title">Cover words</h1>')
  expect(cover).toContain('TITLE-TEXT')
  expect(tocOf(page)).not.toContain('Cover words')
  expect(articleOf(page)).not.toContain('TITLE-TEXT')
})
