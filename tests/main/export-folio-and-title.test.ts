import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { exportBundle, exportDocument } from '../../src/main/export'
import { folioPlace } from '../../src/main/folio-place'
import { folioPieces } from '../../src/main/folio'
import { exportCollectionDirFor, type ExportDirApi } from '../../src/renderer/src/app/export-collection-dir'

let root: string, out: string, ws: Workspace
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-ftitle-')); out = await mkdtemp(join(tmpdir(), 'wf-ftitle-out-')); ws = new Workspace(root) })
afterEach(async () => { await rm(root, { recursive: true, force: true }); await rm(out, { recursive: true, force: true }) })
async function put(path: string, content: string) { await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), content) }
const contents = (html: string): string[] => [...html.matchAll(/<a class="nav-link ((?:level-\d|piece-link))" href="#[^"]*">([^<]*)<\/a>/g)].map((m) => `${m[1]} ${m[2]}`)

// Defect 1: the sheet bundled the nearest ancestor Collection, not the Folio, for a part under a subfolder.
function api(): ExportDirApi {
  return {
    folioDirOf: async (path) => (await folioPlace(ws, path))?.dir ?? null,
    hasManifest: async (dir) => (await folioPieces(ws, dir)) !== null,
    // What the renderer's collectionDirFor answers for a part in `report/evidence`: its own folder.
    collectionDirFor: async (path) => path.slice(0, path.lastIndexOf('/')),
  }
}
async function realFolio(): Promise<void> {
  await put('report/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: 'contents', title_matter: 'contents/00-frontmatter.md', files: [{ path: '01-summary.md' }, { path: '02-report.md' }, { path: 'evidence/passage.md' }] }))
  await put('report/_report_INDEX.md', '# Report index\n')
  await put('report/contents/00-frontmatter.md', '---\ntitle: The Report\n---\nFront words.\n')
  await put('report/contents/01-summary.md', '# Summary\n\nSummary text.\n')
  await put('report/contents/02-report.md', '# Full report\n\nReport text.\n')
  await put('report/contents/evidence/passage.md', '# Passage\n\nPassage text.\n')
}
for (const active of ['report/_report_INDEX.md', 'report/contents/01-summary.md', 'report/contents/02-report.md', 'report/contents/evidence/passage.md']) {
  test(`HTML export with ${active} open exports every part of the Folio in running order`, async () => {
    await realFolio()
    const dir = await exportCollectionDirFor(active, api())
    expect(dir).toBe('report')
    const result = await exportBundle(ws, { dir, format: 'html', target: join(out, 'r.html') })
    const html = await readFile(result.target, 'utf8')
    expect(result.pieces).toBe(3)
    const order = ['Summary text.', 'Report text.', 'Passage text.'].map((t) => html.indexOf(t))
    expect(order.every((i) => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
}
test('a piece in no Folio keeps the nearest Collection', async () => {
  await put('loose/a.md', '# A\n')
  expect(await exportCollectionDirFor('loose/a.md', api())).toBe('loose')
})

// Defect 2.
const doc = '# Offer for researchers\n\nIntro.\n\n## Access\n\nText.\n\n### Training\n\nMore.\n'
test('a document whose opening H1 is its title: no repeat in the body, no contents row, H2 and H3 keep their levels', async () => {
  await put('offer.md', doc)
  const result = await exportDocument(ws, { path: 'offer.md', format: 'html', target: join(out, 'offer.html'), html: { titleBlock: true } })
  const html = await readFile(result.target, 'utf8')
  expect(html).not.toMatch(/<h1 id=/)
  expect(html).not.toContain('>Offer for researchers</a>')
  expect(contents(html)).toEqual(['level-1 Access', 'level-2 Training'])
  expect(html).toContain('Access</h2>')
  expect(html).toContain('Training</h3>')
  await writeFile('/private/tmp/claude-501/fix-title-once.html', html)
})
test('the cover carries the title once; the body does not repeat it', async () => {
  await put('offer.md', doc)
  const result = await exportDocument(ws, { path: 'offer.md', format: 'html', target: join(out, 'o.html'), html: { titleBlock: false, frontPage: true } })
  const html = await readFile(result.target, 'utf8')
  expect(html).toContain('front-page-title')
  expect(html).not.toMatch(/<h1 id=/)
  expect(html.match(/<h1 class="front-page-title">Offer for researchers<\/h1>/g)?.length).toBe(1)
  expect(contents(html)[0]).toBe('level-1 Access')
})
test('with no cover and no title block the H1 stays in the body, but is still not a contents row', async () => {
  await put('offer.md', doc)
  const result = await exportDocument(ws, { path: 'offer.md', format: 'html', target: join(out, 'o.html'), html: { titleBlock: false, frontPage: false } })
  const html = await readFile(result.target, 'utf8')
  expect(html).toMatch(/<h1[^>]*>Offer for researchers<\/h1>/)
  expect(contents(html)).toEqual(['level-1 Access', 'level-2 Training'])
  // Anchors of the headings in the body and in the contents agree.
  const id = /<h2 id="([^"]+)"[^>]*>Access<\/h2>/.exec(html)![1]
  expect(html).toContain(`href="#${id}">Access</a>`)
})
test('an opening H1 that is not the title stays in the body and in the contents', async () => {
  await put('offer.md', '---\ntitle: Offer\n---\n# Something else\n\n## Access\n')
  const result = await exportDocument(ws, { path: 'offer.md', format: 'html', target: join(out, 'o.html'), html: { titleBlock: true } })
  const html = await readFile(result.target, 'utf8')
  expect(html).toMatch(/<h1[^>]*>Something else<\/h1>/)
  expect(contents(html)).toEqual(['level-1 Something else', 'level-2 Access'])
})
test('the Folio title is not a contents entry, with the cover on or off', async () => {
  await realFolio()
  for (const frontPage of [true, false]) {
    const result = await exportBundle(ws, { dir: 'report', format: 'html', target: join(out, `f${frontPage}.html`), html: { frontPage } })
    const html = await readFile(result.target, 'utf8')
    expect(contents(html).some((row) => row.includes('The Report'))).toBe(false)
    expect(contents(html).map((r) => r.replace(/^\S+ /, ''))).toEqual(['Summary', 'Full report', 'Passage'])
  }
})
test('the old rule (nearest ancestor folder) named the part\'s own subfolder, which is not the Folio', async () => {
  await realFolio()
  const old = await api().collectionDirFor('report/contents/evidence/passage.md')
  expect(old).toBe('report/contents/evidence')
  expect(await folioPieces(ws, old)).toBeNull() // no manifest there: the sheet found no Folio to bundle
})
