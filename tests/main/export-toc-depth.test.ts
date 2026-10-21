import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { Workspace } from '../../src/main/workspace'
import { exportBundle, exportDocument } from '../../src/main/export'
import { readTocDepthSource, saveExportTocDepth, withTocDepth, writeTocDepth } from '../../src/main/export-toc-depth'
import { exportBundleRequest, exportDocumentRequest } from '../../src/main/export-ipc'
import { removeFrontmatterKeys } from '../../src/main/capabilities'
import { tocDepthOf } from '../../src/shared/toc-depth'
import { documentSaveSeams } from '../../src/main/guarded-document-write'

// Per-Folio (and per-document) Contents depth: `toc_depth` in the file's own frontmatter (a Folio's in
// its Index Note). The write is the writer's direct act from the Export sheet — goal:set's pattern —
// so it changes that one key byte-preservingly and only over the version the sheet read.

let root: string
let out: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-toc-depth-'))
  out = await mkdtemp(join(tmpdir(), 'wf-toc-depth-out-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  delete documentSaveSeams.betweenCheckAndWrite
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

const put = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}
const disk = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const basis = (text: string) => ({ kind: 'disk' as const, text })
// A Folio's contents is the heading-flow tree (export-folio-contents-flow.test.ts): the part's row is a
// `piece-link`, its first `# One` heading is its title and is not listed again, and depth counts from the
// chapter level, so these lists hold the `level-N` rows only.
const navOf = (html: string): string[] =>
  [...html.matchAll(/<a class="nav-link level-\d" href="#[^"]*">([^<]*)<\/a>/g)].map((m) => m[1])

test('tocDepthOf reads 1-6 and nothing else', () => {
  expect(tocDepthOf('---\ntoc_depth: 3\n---\nBody\n')).toBe(3)
  expect(tocDepthOf('---\ntoc_depth: "5"\n---\nBody\n')).toBe(5)
  for (const bad of ['0', '7', '2.5', 'three', '', '[3]']) expect(tocDepthOf(`---\ntoc_depth: ${bad}\n---\nBody\n`)).toBeNull()
  expect(tocDepthOf('No frontmatter.\n')).toBeNull()
})

test('setting the depth changes only that key: order, quoting, comments and CRLF survive', () => {
  const doc = '---\r\ntitle: "A: quoted"\r\n# a comment\r\ntags: [a, b]\r\nstatus: draft\r\n---\r\n\r\nBody stays.\r\n'
  expect(withTocDepth(doc, 3)).toBe('---\r\ntitle: "A: quoted"\r\n# a comment\r\ntags: [a, b]\r\nstatus: draft\r\ntoc_depth: 3\r\n---\r\n\r\nBody stays.\r\n')
  // An existing value is replaced in place.
  expect(withTocDepth('---\ntoc_depth: 2\ntitle: x\n---\nB\n', 5)).toBe('---\ntoc_depth: 5\ntitle: x\n---\nB\n')
})

test('a bare file gets a minimal block; Default removes the key as the goal path does', () => {
  const bare = '# Heading\n\nBody.\n'
  const set = withTocDepth(bare, 4)
  expect(set).toBe('---\ntoc_depth: 4\n---\n\n# Heading\n\nBody.\n')
  // Removing the only key leaves no empty block, exactly as clearing a writing goal does.
  expect(withTocDepth(set, null)).toBe(removeFrontmatterKeys(set, ['toc_depth']))
  expect(withTocDepth(set, null)).toBe(bare)
  expect(withTocDepth('---\r\ntitle: x\r\ntoc_depth: 2\r\n---\r\nB\r\n', null)).toBe('---\r\ntitle: x\r\n---\r\nB\r\n')
  expect(withTocDepth(bare, null)).toBe(bare) // nothing to remove
})

test('the write lands on disk over the version read, and Default removes it again', async () => {
  const text = '---\ntitle: Piece\nstatus: draft\n---\n\n# Piece\n'
  await put('essays/piece.md', text)
  const written = await writeTocDepth(ws, { scope: { kind: 'document', path: 'essays/piece.md' }, depth: 2, basis: basis(text) })
  expect('refused' in written).toBe(false)
  expect(await disk('essays/piece.md')).toBe('---\ntitle: Piece\nstatus: draft\ntoc_depth: 2\n---\n\n# Piece\n')
  const now = await disk('essays/piece.md')
  await writeTocDepth(ws, { scope: { kind: 'document', path: 'essays/piece.md' }, depth: null, basis: basis(now) })
  expect(await disk('essays/piece.md')).toBe(text)
})

test('a file changed since it was read is refused and left alone', async () => {
  await put('piece.md', '---\ntitle: Piece\n---\nBody\n')
  const read = await readTocDepthSource(ws, { kind: 'document', path: 'piece.md' })
  expect(read).toMatchObject({ path: 'piece.md', depth: null })
  await put('piece.md', '---\ntitle: Piece\n---\nSomeone else wrote this.\n')
  const result = await writeTocDepth(ws, { scope: { kind: 'document', path: 'piece.md' }, depth: 3, basis: basis(read!.text) })
  expect(result).toMatchObject({ refused: 'disk-changed', path: 'piece.md' })
  expect(await disk('piece.md')).toBe('---\ntitle: Piece\n---\nSomeone else wrote this.\n')
})

test('a path outside the Workspace is refused with nothing written', async () => {
  const outside = join(out, 'elsewhere.md')
  await writeFile(outside, 'Outside.\n')
  for (const path of ['../elsewhere.md', outside, '', 42]) {
    const result = await writeTocDepth(ws, { scope: { kind: 'document', path }, depth: 3, basis: basis('Outside.\n') })
    expect(result).toMatchObject({ refused: 'outside' })
  }
  expect(await readFile(outside, 'utf8')).toBe('Outside.\n')
  await expect(readTocDepthSource(ws, { kind: 'document', path: '../elsewhere.md' })).rejects.toThrow()
})

test('only whole numbers 1-6 are written', async () => {
  const text = 'Body\n'
  await put('piece.md', text)
  for (const depth of [0, 7, 2.5, '3', true]) {
    expect(await writeTocDepth(ws, { scope: { kind: 'document', path: 'piece.md' }, depth, basis: basis(text) })).toMatchObject({ refused: 'invalid' })
  }
  expect(await writeTocDepth(ws, { scope: { kind: 'document', path: 'piece.md' }, depth: 3 })).toMatchObject({ refused: 'invalid' }) // no basis
  expect(await disk('piece.md')).toBe(text)
})

test('a block the strict writer cannot edit safely is refused, not rewritten', async () => {
  const text = '---\ntitle: x # trailing comment\n---\nBody\n'
  await put('piece.md', text)
  expect(await writeTocDepth(ws, { scope: { kind: 'document', path: 'piece.md' }, depth: 3, basis: basis(text) })).toMatchObject({ refused: 'unwritable' })
  expect(await disk('piece.md')).toBe(text)
})

test('a Folio reads its depth from the Index Note; no Index Note, no home', async () => {
  await put('paper/_paper_INDEX.md', '---\ntoc_depth: 3\n---\n# Paper\n')
  expect(await readTocDepthSource(ws, { kind: 'folio', dir: 'paper' })).toMatchObject({ path: 'paper/_paper_INDEX.md', depth: 3 })
  await mkdir(join(root, 'bare'), { recursive: true })
  expect(await readTocDepthSource(ws, { kind: 'folio', dir: 'bare' })).toBeNull()
})

const FIVE = ['# One', '', '## Two', '', '### Three', '', '#### Four', '', '##### Five', ''].join('\n')

test('a document export without an explicit depth uses its toc_depth; an explicit one wins', async () => {
  await put('deep.md', `---\ntoc_depth: 2\n---\n\n${FIVE}`)
  await exportDocument(ws, { path: 'deep.md', format: 'html', target: join(out, 'a.html'), html: {} })
  expect(navOf(await readFile(join(out, 'a.html'), 'utf8'))).toEqual(['Two'])
  await exportDocument(ws, { path: 'deep.md', format: 'html', target: join(out, 'b.html'), html: { tocDepth: 6 } })
  expect(navOf(await readFile(join(out, 'b.html'), 'utf8'))).toEqual(['Two', 'Three', 'Four', 'Five'])
})

test('a five-level Folio whose Index Note says toc_depth: 3 lists h1-h3; the body keeps h4 and h5', async () => {
  await put('paper/_report-structure.json', JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'deep.md', role: 'section' }] }))
  await put('paper/_paper_INDEX.md', '---\ntitle: Paper\ntoc_depth: 3\n---\n\n# Paper\n')
  // The piece's own title differs from its first heading, so `# One` stays in the body as authored.
  await put('paper/deep.md', `---\ntitle: Deep\n---\n\n${FIVE}`)
  await exportBundle(ws, { dir: 'paper', format: 'html', target: join(out, 'paper.html'), html: {} })
  const html = await readFile(join(out, 'paper.html'), 'utf8')
  expect(navOf(html)).toEqual(['Two', 'Three'])
  expect(html).toMatch(/>Four<\/h\d>/)
  expect(html).toMatch(/>Five<\/h\d>/)
  // Without the Index Note's setting the default four levels come back.
  await put('paper/_paper_INDEX.md', '---\ntitle: Paper\n---\n\n# Paper\n')
  await exportBundle(ws, { dir: 'paper', format: 'html', target: join(out, 'paper2.html'), html: {} })
  expect(navOf(await readFile(join(out, 'paper2.html'), 'utf8'))).toEqual(['Two', 'Three', 'Four'])
  // An explicit request depth still wins over the Index Note.
  await put('paper/_paper_INDEX.md', '---\ntoc_depth: 3\n---\n# Paper\n')
  await exportBundle(ws, { dir: 'paper', format: 'html', target: join(out, 'paper3.html'), html: { tocDepth: 1 } })
  expect(navOf(await readFile(join(out, 'paper3.html'), 'utf8'))).toEqual([])
})

// The dropdown never writes: the depth is saved once, by main, when an HTML export runs, into the file of
// the scope the export itself resolved (the document it read, the folder it bundled).
const FOLIO_MANIFEST = JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: 'deep.md', role: 'section' }] })

test('a Folio export with depth N writes N to its Index Note, and exports with N', async () => {
  const index = '---\ntitle: Paper\n# keeps its comment\ntoc_depth: 3\n---\n\n# Paper\n'
  await put('paper/_report-structure.json', FOLIO_MANIFEST)
  await put('paper/_paper_INDEX.md', index)
  await put('paper/deep.md', `---\ntitle: Deep\n---\n\n${FIVE}`)
  const outcome = await exportBundle(ws, exportBundleRequest({ dir: 'paper', format: 'html', target: join(out, 'p.html'), html: { tocDepth: 2 }, keepTocDepth: true }))
  expect(navOf(await readFile(join(out, 'p.html'), 'utf8'))).toEqual(['Two'])
  expect(await disk('paper/_paper_INDEX.md')).toBe(index.replace('toc_depth: 3', 'toc_depth: 2'))
  expect(outcome.tocDepthSave).toMatchObject({ file: { path: 'paper/_paper_INDEX.md' } })
  expect(outcome.tocDepthSave).toHaveProperty('written')
  expect(await disk('paper/deep.md')).toBe(`---\ntitle: Deep\n---\n\n${FIVE}`)
  // The same depth again: nothing is written (no receipt).
  const again = await exportBundle(ws, { dir: 'paper', format: 'html', target: join(out, 'p2.html'), html: { tocDepth: 2 }, keepTocDepth: true })
  expect(again.tocDepthSave).not.toHaveProperty('refused')
  expect(again.tocDepthSave).not.toHaveProperty('written')
})

test('a Folio export with Default removes the key, and exports with the default, not the old value', async () => {
  const index = '---\ntitle: Paper\ntoc_depth: 1\n---\n\n# Paper\n'
  await put('paper/_report-structure.json', FOLIO_MANIFEST)
  await put('paper/_paper_INDEX.md', index)
  await put('paper/deep.md', `---\ntitle: Deep\n---\n\n${FIVE}`)
  await exportBundle(ws, { dir: 'paper', format: 'html', target: join(out, 'p.html'), html: {}, keepTocDepth: true })
  expect(navOf(await readFile(join(out, 'p.html'), 'utf8'))).toEqual(['Two', 'Three', 'Four'])
  expect(await disk('paper/_paper_INDEX.md')).toBe('---\ntitle: Paper\n---\n\n# Paper\n')
  // Without keepTocDepth an export follows the file and writes nothing (a command or an agent export).
  await put('paper/_paper_INDEX.md', index)
  const plain = await exportBundle(ws, { dir: 'paper', format: 'html', target: join(out, 'p2.html'), html: {} })
  expect(navOf(await readFile(join(out, 'p2.html'), 'utf8'))).toEqual([])
  expect(plain).not.toHaveProperty('tocDepthSave')
  expect(await disk('paper/_paper_INDEX.md')).toBe(index)
})

test('a document export writes the depth into the document it exported; Word keeps nothing', async () => {
  const text = `---\ntitle: Deep\n---\n\n${FIVE}`
  await put('deep.md', text)
  const outcome = await exportDocument(ws, exportDocumentRequest({ path: 'deep.md', format: 'html', target: join(out, 'd.html'), html: { tocDepth: 5 }, keepTocDepth: true }))
  expect(navOf(await readFile(join(out, 'd.html'), 'utf8'))).toEqual(['One', 'Two', 'Three', 'Four', 'Five'])
  expect(await disk('deep.md')).toBe(`---\ntitle: Deep\ntoc_depth: 5\n---\n\n${FIVE}`)
  expect(outcome.tocDepthSave).toMatchObject({ file: { path: 'deep.md' } })
  const word = await exportDocument(ws, { path: 'deep.md', format: 'docx', target: join(out, 'd.docx'), keepTocDepth: true })
  expect(word).not.toHaveProperty('tocDepthSave')
  expect(await disk('deep.md')).toBe(`---\ntitle: Deep\ntoc_depth: 5\n---\n\n${FIVE}`)
  // The request flag is true or absent; anything else is refused before anything runs.
  expect(() => exportDocumentRequest({ path: 'deep.md', format: 'html', target: 'x', keepTocDepth: 'yes' })).toThrow()
})

test('a refused depth save never fails the export: it comes back as a note, and nothing else is written', async () => {
  // A Folio with no Index Note: the export is written, no Index Note is created.
  await put('bare/_report-structure.json', FOLIO_MANIFEST)
  await put('bare/deep.md', `---\ntitle: Deep\n---\n\n${FIVE}`)
  const outcome = await exportBundle(ws, { dir: 'bare', format: 'html', target: join(out, 'b.html'), html: { tocDepth: 2 }, keepTocDepth: true })
  expect(existsSync(join(out, 'b.html'))).toBe(true)
  expect(outcome.tocDepthSave).toMatchObject({ refused: 'missing' })
  expect(existsSync(join(root, 'bare/_bare_INDEX.md'))).toBe(false)
  // A strict-writer refusal on the document itself: exported, the file left as it was.
  const odd = '---\ntitle: x # trailing comment\n---\n\n# One\n'
  await put('odd.md', odd)
  const refused = await exportDocument(ws, { path: 'odd.md', format: 'html', target: join(out, 'o.html'), html: { tocDepth: 2 }, keepTocDepth: true })
  expect(existsSync(join(out, 'o.html'))).toBe(true)
  expect(refused.tocDepthSave).toMatchObject({ refused: 'unwritable' })
  expect(await disk('odd.md')).toBe(odd)
})

test('the export save goes only through the guarded write: a changed file or a non-document scope is refused', async () => {
  const text = '---\ntitle: Piece\n---\nBody\n'
  await put('piece.md', text)
  // A basis that is not what is on disk (the file changed after the export read it): refused, untouched.
  expect(await saveExportTocDepth(ws, { kind: 'document', path: 'piece.md' }, 3, 'an older version\n')).toMatchObject({ refused: 'disk-changed' })
  expect(await disk('piece.md')).toBe(text)
  // Outside the Workspace, a manifest, a hidden file: refused, nothing written.
  expect(await saveExportTocDepth(ws, { kind: 'document', path: '../outside.md' }, 3, text)).toHaveProperty('refused')
  await put('paper/_report-structure.json', FOLIO_MANIFEST)
  expect(await saveExportTocDepth(ws, { kind: 'document', path: 'paper/_report-structure.json' }, 3, FOLIO_MANIFEST)).toMatchObject({ refused: 'not-a-document' })
  await put('.writeflex/private.md', 'private\n')
  expect(await saveExportTocDepth(ws, { kind: 'document', path: '.writeflex/private.md' }, 3, 'private\n')).toHaveProperty('refused')
  expect(await disk('paper/_report-structure.json')).toBe(FOLIO_MANIFEST)
  expect(await disk('.writeflex/private.md')).toBe('private\n')
  expect(await saveExportTocDepth(ws, { kind: 'folio', dir: '../elsewhere' }, 3)).toHaveProperty('refused')
})

// Sol D1, Standards P1: the sheet names a scope; main derives the file and refuses anything else.
test('a manifest, a non-Markdown file or a hidden file is never written, whatever basis the caller holds', async () => {
  const manifest = JSON.stringify({ schema_version: 1, content_root: '', files: [] })
  await put('paper/_report-structure.json', manifest)
  await put('paper/notes.txt', 'plain\n')
  await put('.writeflex/private.md', 'private\n')
  expect(await writeTocDepth(ws, { scope: { kind: 'document', path: 'paper/_report-structure.json' }, depth: 3, basis: basis(manifest) }))
    .toMatchObject({ refused: 'not-a-document' })
  expect(await writeTocDepth(ws, { scope: { kind: 'document', path: 'paper/notes.txt' }, depth: 3, basis: basis('plain\n') }))
    .toMatchObject({ refused: 'not-a-document' })
  expect(await writeTocDepth(ws, { scope: { kind: 'document', path: '.writeflex/private.md' }, depth: 3, basis: basis('private\n') }))
    .toMatchObject({ refused: 'outside' })
  // A path is no scope: the old shape is refused outright.
  expect(await writeTocDepth(ws, { path: 'paper/_report-structure.json', depth: 3, basis: basis(manifest) })).toMatchObject({ refused: 'outside' })
  expect(await disk('paper/_report-structure.json')).toBe(manifest)
  expect(await disk('paper/notes.txt')).toBe('plain\n')
  expect(await disk('.writeflex/private.md')).toBe('private\n')
  await expect(readTocDepthSource(ws, { kind: 'document', path: 'paper/_report-structure.json' })).rejects.toThrow()
})

test('a Folio writes only its canonical Index Note, and one with no Index Note gets none created', async () => {
  const index = '---\ntitle: Paper\n---\n# Paper\n'
  await put('paper/_paper_INDEX.md', index)
  await put('paper/other.md', index)
  expect(await writeTocDepth(ws, { scope: { kind: 'folio', dir: 'paper' }, depth: 2, basis: basis(index) })).not.toHaveProperty('refused')
  expect(await disk('paper/_paper_INDEX.md')).toBe('---\ntitle: Paper\ntoc_depth: 2\n---\n# Paper\n')
  expect(await disk('paper/other.md')).toBe(index)
  await mkdir(join(root, 'bare'), { recursive: true })
  expect(await writeTocDepth(ws, { scope: { kind: 'folio', dir: 'bare' }, depth: 2, basis: { kind: 'new' } })).toMatchObject({ refused: 'missing' })
  expect(existsSync(join(root, 'bare/_bare_INDEX.md'))).toBe(false)
  expect(await writeTocDepth(ws, { scope: { kind: 'folio', dir: '../elsewhere' }, depth: 2, basis: basis(index) })).toMatchObject({ refused: 'outside' })
})

// Sol D1, Spec P1: the parent folder swapped for a link to an outside folder after the checks, before the write.
test('a folder swapped for an outside link while the depth is being written is refused; the outside file is untouched', async () => {
  const text = '---\ntitle: Piece\n---\nBody\n'
  await put('essays/piece.md', text)
  const outsideDir = join(out, 'essays')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'piece.md'), text) // the same text, so the basis check alone would pass
  let swapped = false
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await rename(join(root, 'essays'), join(root, 'essays-moved'))
    await symlink(outsideDir, join(root, 'essays'))
    swapped = true
  }
  const result = await writeTocDepth(ws, { scope: { kind: 'document', path: 'essays/piece.md' }, depth: 3, basis: basis(text) })
  expect(swapped).toBe(true)
  expect(result).toMatchObject({ refused: 'outside' })
  expect(await readFile(join(outsideDir, 'piece.md'), 'utf8')).toBe(text)
  expect(await readFile(join(root, 'essays-moved/piece.md'), 'utf8')).toBe(text)
})

test('a folder swapped for an outside link after validation, before the save starts, is refused too', async () => {
  const text = '---\ntitle: Piece\n---\nBody\n'
  await put('essays/piece.md', text)
  const outsideDir = join(out, 'essays')
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'piece.md'), text)
  const save = ws.saveFile.bind(ws)
  ws.saveFile = async (...args: Parameters<Workspace['saveFile']>) => {
    await rename(join(root, 'essays'), join(root, 'essays-moved'))
    await symlink(outsideDir, join(root, 'essays'))
    return save(...args)
  }
  const result = await writeTocDepth(ws, { scope: { kind: 'document', path: 'essays/piece.md' }, depth: 3, basis: basis(text) })
  expect(result).toMatchObject({ refused: 'outside' })
  expect(await readFile(join(outsideDir, 'piece.md'), 'utf8')).toBe(text)
})
