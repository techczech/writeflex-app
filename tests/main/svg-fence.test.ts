import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { exportDocument } from '../../src/main/export'
import { clipboardPayload } from '../../src/main/clipboard'

// the user's usability review find: "svg stays code not image". A ```svg fence is one of the app's four object
// types — the editor already DRAWS it — so a copy and an export that show it as escaped source are
// showing the writer something the app itself does not believe. It is sanitised by the app's OWN
// rule (`shared/sanitise-svg`, shared rather than forked) and then inlined in HTML, rasterised for
// RTF and Word. ```mermaid and ```markmap stay code: they need rendering engines that are not in
// the main process, and a half-rendered diagram would be worse than the source.

let root: string
let ws: Workspace
let out: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-fence-'))
  out = await mkdtemp(join(tmpdir(), 'wf-fence-out-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(out, { recursive: true, force: true })
})

const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>'
const fence = (body: string, language = 'svg'): string => `Before.\n\n\`\`\`${language}\n${body}\n\`\`\`\n\nAfter.\n`

test('an exported HTML file draws the fence, it does not print it', async () => {
  await write('piece.md', fence(SVG))
  const outcome = await exportDocument(ws, { path: 'piece.md', format: 'html', target: join(out, 'piece.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toContain('<svg')
  expect(html).toContain('fill="green"')
  expect(html).not.toContain('language-svg')
  expect(html).not.toContain('&lt;svg')
})

// the user's second usability review find (0.9.1): "it works in HTML export, but not in Word or copy as rich
// text". The Word export was fine; the CLIPBOARD's HTML flavour was not. It emitted the inline
// <svg> the exported file emits, and Word, Teams and Outlook DISCARD an inline <svg> when they
// import HTML from the clipboard — so the picture vanished on paste even though the RTF flavour
// carried a perfectly good \pict. The two HTML paths are now deliberately different, and these two
// tests are the pair that says so: do not "unify" them.
test('the CLIPBOARD html flavour rasterises the fence — Word and Teams DISCARD an inline <svg> on paste', async () => {
  const { payload } = await clipboardPayload(fence(SVG), 'rich', { workspace: ws, path: 'piece.md' })
  expect(payload.html).toContain('data:image/png;base64,')
  expect(payload.html).not.toContain('<svg')
  expect(payload.html).not.toContain('&lt;svg')
  expect(payload.html).not.toContain('data:image/svg+xml')
  expect(payload.rtf).toContain('\\pict')
  expect(payload.rtf).toContain('\\pngblip')
  // The prose around it is untouched.
  expect(payload.text).toContain('Before.')
  expect(payload.text).toContain('After.')
})

test('the EXPORTED html file keeps the inline <svg> — a file is opened in a browser, which draws it crisply', async () => {
  await write('piece.md', fence(SVG))
  const outcome = await exportDocument(ws, { path: 'piece.md', format: 'html', target: join(out, 'piece.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toContain('<svg')
  expect(html).not.toContain('data:image/png;base64,')
})

test('a Word export embeds the fence as a picture', async () => {
  await write('piece.md', fence(SVG))
  const outcome = await exportDocument(ws, { path: 'piece.md', format: 'docx', target: join(out, 'piece.docx') })
  expect(outcome.missingImages).toEqual([])
  expect(outcome.unreadableImages).toEqual([])
  const names = (await readFile(outcome.target)).toString('latin1').match(/word\/media\/[\w-]+\.(?:png|jpe?g|gif|bmp)/g) ?? []
  expect(new Set(names).size).toBe(1)
})

test('an UNSAFE fence stays code — a removal is a visible failure, never a hole', async () => {
  const nasty = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'
  await write('piece.md', fence(nasty))
  const outcome = await exportDocument(ws, { path: 'piece.md', format: 'html', target: join(out, 'piece.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toContain('language-svg')
  expect(html).not.toContain('<script>')
  expect(html).toContain('&lt;script&gt;')
})

test('mermaid and markmap fences stay code — a deliberate boundary, not an oversight', async () => {
  await write('piece.md', `${fence('graph TD; A-->B;', 'mermaid')}\n${fence('# map\n- one', 'markmap')}`)
  const outcome = await exportDocument(ws, { path: 'piece.md', format: 'html', target: join(out, 'piece.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toContain('language-mermaid')
  expect(html).toContain('language-markmap')
})

test('an ordinary code fence is still code, and HTML inside one still READS as that HTML', async () => {
  await write('piece.md', fence('<svg width="1"></svg>', 'html'))
  const outcome = await exportDocument(ws, { path: 'piece.md', format: 'html', target: join(out, 'piece.html') })
  const html = await readFile(outcome.target, 'utf8')
  expect(html).toContain('language-html')
  expect(html).toContain('&lt;svg width="1"&gt;')
})
