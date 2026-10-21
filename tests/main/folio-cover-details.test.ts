// The exported cover reads the Folio's Details (0.26): the Index Note's header wins per field (title, standfirst,
// Date, Status, Author chips); the title page's own header fills only what the Details leave empty.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { exportBundle, suggestedName } from '../../src/main/export'
import { MANIFEST_NAME } from '../../src/main/folio'
import { Workspace } from '../../src/main/workspace'
import { coverChips, coverWithDetails, folioHeaderDetails } from '../../src/shared/folio-cover-details'
import { folioDetailsWithFallback } from '../../src/shared/folio-details'
import { readFolioDetails } from '../../src/main/folio-details'

let root: string
let out: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-cover-details-'))
  out = await mkdtemp(join(tmpdir(), 'wf-cover-details-out-'))
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

async function pangram(index: string | null, options: { titlePage?: boolean } = {}): Promise<void> {
  const { titlePage = true } = options
  const files = [
    ...(titlePage ? [{ id: 'title-matter', path: '00-frontmatter.md', role: 'front-matter', toc: false }] : []),
    { id: 'executive-summary', path: '01-executive-summary.md', role: 'executive-summary', render: 'section', toc: true },
  ]
  await write(`pangram/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: 'contents', ...(titlePage ? { title_matter: 'contents/00-frontmatter.md' } : {}), files, title: TITLE }, null, 2)}\n`)
  if (titlePage) await write('pangram/contents/00-frontmatter.md', `---\nrole: title-matter\ntitle: "${TITLE}"\nauthor: Dominik Lukeš\ndate: 2026-10-14\nstatus: draft-for-review\n---\n\n${BYLINE}\n`)
  await write('pangram/contents/01-executive-summary.md', '---\ntitle: Summary\n---\n\n## Summary\nTo test the feasibility.\n')
  if (index !== null) await write('pangram/_pangram_INDEX.md', index)
}

async function html(options: Record<string, unknown> = { frontPage: true }): Promise<string> {
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

test('the cover shows the Status and Date picked in Details, not the title page’s', async () => {
  await pangram('---\nstatus: ready\ndate: 2026-10-20\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  const cover = coverOf(await html())
  expect(cover).toContain('ready')
  expect(cover).not.toContain('draft-for-review')
  expect(cover).toContain('20 October 2026')
  expect(cover).not.toContain('14 October 2026</span>')
})

test('a field the Details leave empty still comes from the title page', async () => {
  await pangram('---\nstatus: ready\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  const cover = coverOf(await html())
  expect(cover).toContain('ready')
  // Author and date are the title page's.
  expect(cover).toContain('Dominik Lukeš')
  expect(cover).toContain('14 October 2026')
})

test('the Details’ title and standfirst are the cover’s, the standfirst above the title page’s own body', async () => {
  await pangram('---\ntitle: A better title\nstandfirst: One line for the cover.\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  const cover = coverOf(await html())
  expect(cover).toContain('<h1 class="front-page-title">A better title</h1>')
  expect(cover).toContain('<p class="standfirst">One line for the cover.</p>')
  expect(cover.indexOf('One line for the cover.')).toBeLessThan(cover.indexOf(BYLINE))
})

test('with no Details the cover is exactly as before', async () => {
  await pangram('---\ntags: [a]\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  const withIndex = coverOf(await html())
  await rm(join(root, 'pangram/_pangram_INDEX.md'))
  const without = coverOf(await html())
  expect(withIndex).toBe(without)
  expect(without).toContain('draft-for-review')
  expect(without).toContain(`<h1 class="front-page-title">${TITLE}</h1>`)
})

test('with no title page the generated cover shows the Details’ standfirst and chips', async () => {
  await pangram('---\nstandfirst: Standing words.\nstatus: ready\nauthor: Someone\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n', { titlePage: false })
  const cover = coverOf(await html())
  expect(cover).toContain('<p class="standfirst">Standing words.</p>')
  expect(cover).toContain('Someone')
  expect(cover).toContain('ready')
})

test('with the cover off the title page is a section under the export’s title and the masthead carries the Details', async () => {
  await pangram('---\ntitle: A better title\nstandfirst: Standing words.\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  const page = await html({ frontPage: false })
  expect(coverOf(page)).toBe('')
  expect(page).toContain('Standing words.')
  expect(page).not.toContain(TITLE)
})

// Sol round 3, new P2: every place an export shows its title takes the one resolved title (Details first).
test('Word and HTML show the Details title everywhere: visible title, document properties and file name', async () => {
  await pangram(null)
  // The manifest and the title page both say "Old title"; the Details say "New title".
  await write(`pangram/${MANIFEST_NAME}`, (await readFile(join(root, `pangram/${MANIFEST_NAME}`), 'utf8')).replace(TITLE, 'Old title'))
  await write('pangram/contents/00-frontmatter.md', (await readFile(join(root, 'pangram/contents/00-frontmatter.md'), 'utf8')).replace(TITLE, 'Old title'))
  await write('pangram/_pangram_INDEX.md', '---\ntitle: New title\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')

  const docx = join(out, 'pangram.docx')
  await exportBundle(ws, { dir: 'pangram', format: 'docx', target: docx })
  const zip = await JSZip.loadAsync(await readFile(docx))
  const body = await zip.file('word/document.xml')!.async('string')
  const core = await zip.file('docProps/core.xml')!.async('string')
  // The first section's heading (Word's visible title) is the resolved title.
  expect(body.match(/<w:t[^>]*>([^<]*)<\/w:t>/)?.[1]).toBe('New title')
  expect(body).not.toContain('Old title')
  expect(core).toContain('<dc:title>New title</dc:title>')
  expect(await suggestedName(ws, { scope: 'collection', dir: 'pangram', format: 'docx' })).toContain('New title')

  for (const frontPage of [true, false]) {
    const page = await html({ frontPage })
    expect(page).toContain('<title>New title</title>')
    expect(page).toContain('New title')
    expect(page).not.toContain('Old title')
  }
  expect(await suggestedName(ws, { scope: 'collection', dir: 'pangram', format: 'html' })).toContain('New title')
})

test('a standfirst the Details leave empty comes from the title page, as the card shows it (Sol round 2, finding 5)', async () => {
  await pangram('---\nstatus: ready\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  await write('pangram/contents/00-frontmatter.md', `---\nrole: title-matter\ntitle: "${TITLE}"\nstandfirst: Inherited line\n---\n\n${BYLINE}\n`)
  // The card shows the inherited value...
  const card = await readFolioDetails(ws, 'pangram')
  expect(card).toMatchObject({ ok: true, fields: { standfirst: { value: 'Inherited line', from: 'title-page' } } })
  // ...and the exported cover carries it, once.
  const cover = coverOf(await html())
  expect(cover).toContain('<p class="standfirst">Inherited line</p>')
  // The Details' own standfirst still wins.
  await write('pangram/_pangram_INDEX.md', '---\nstandfirst: Own line\n---\n\n# Pangram\n\n## Running order\n\n- [[Summary]]\n')
  const own = coverOf(await html())
  expect(own).toContain('<p class="standfirst">Own line</p>')
  expect(own).not.toContain('Inherited line')
})

test('the card and the export take each field by the one rule: the Index Note’s, else the title page’s', () => {
  const empty = { title: null, standfirst: null, author: null, date: null, status: null, audience: null, language: null }
  const fields = folioDetailsWithFallback({ ...empty, title: 'Mine' }, { ...empty, title: 'Theirs', standfirst: 'Inherited' })
  expect(fields.title).toEqual({ value: 'Mine', from: 'index' })
  expect(fields.standfirst).toEqual({ value: 'Inherited', from: 'title-page' })
  expect(fields.status).toEqual({ value: null, from: null })
  expect(folioDetailsWithFallback(empty, null).title).toEqual({ value: null, from: null })
})

test('chips follow the selected fields, Details over title page, and keep anything else the title page carried', () => {
  const existing = { author: 'Page Author', date: '2026-10-14', series: 'S' }
  expect(coverChips(existing, { status: 'ready', author: 'Detail Author' }, ['date', 'status', 'author'])).toEqual({ date: '2026-10-14', status: 'ready', author: 'Detail Author', series: 'S' })
  expect(coverChips({}, { status: 'ready' }, ['date', 'author'])).toEqual({})
  const cover = { title: 'T', body: '<p>b</p>' }
  expect(coverWithDetails(cover, null, ['date'])).toBe(cover)
  expect(coverWithDetails(cover, { status: 'ready', standfirst: 'S' }, ['status']).data?.frontmatter).toEqual({ status: 'ready' })
  expect(folioHeaderDetails(null, ['status'])).toBeNull()
  expect(folioHeaderDetails({ title: 'x' }, ['status'])).toBeNull()
  expect(folioHeaderDetails({ standfirst: 'S' }, ['status'])).toEqual({ standfirst: 'S', frontmatter: {} })
})
