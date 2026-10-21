// A `#front-matter` line tag is a sufficient front-matter marker on its own (ADR-0046): another role tag on the same
// line (`#front-matter #summary`, either order) never takes the part out of front matter. The Plan, the Outline
// (sidebar) facts and the HTML export read it alike; a move out of the leading block is refused; writes that do not
// change that line keep its bytes, both tags included. Cross-family review round 3, Spec 1.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBundle } from '../../src/main/export'
import { MANIFEST_NAME } from '../../src/main/folio'
import { folioFrontMatter } from '../../src/main/folio-front-matter'
import { folioOutline } from '../../src/main/folio-outline'
import { movePart, readPlan, setPartRole as setPartRoleNamed } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'
import { FRONT_MATTER_STAYS_LEADING } from '../../src/shared/folio-front-matter'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-front-line-tags-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

async function setPartRole(dir: string, index: number, role: string) {
  const part = (await readPlan(ws, dir))!.parts[index]
  return setPartRoleNamed(ws, dir, index, role, { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: part.tags })
}

const INDEX = 'r/_r_INDEX.md'

/** A Folio whose running order is `lines`; the manifest lists A and B with no role (no manifest marker). */
async function folio(lines: string[], order: string[] = ['a.md', 'b.md']): Promise<void> {
  await write('r/a.md', '# A\n\nA BODY\n\n## Alpha section\n\nMore of A.\n')
  await write('r/b.md', '# B\n\nB BODY\n\n## Beta section\n\nMore of B.\n')
  await write(INDEX, `# R\n\n## Running order\n\n${lines.join('\n')}\n`)
  await write(`r/${MANIFEST_NAME}`, JSON.stringify({ schema_version: 1, files: order.map((path) => ({ path })) }))
}

async function exportedHtml(): Promise<string> {
  const target = join(root, 'out.html')
  await exportBundle(ws, { dir: 'r', format: 'html', target, html: { sidebar: true } })
  return readFile(target, 'utf8')
}

for (const tags of ['#front-matter #summary', '#summary #front-matter']) {
  test(`a line tagged ${tags} with no manifest role is front matter in the Folio outline, the sidebar facts and the export`, async () => {
    // Written after B, as the review's reproduction has it: the export still puts A first.
    await folio(['- [[B]]', `- [[A]] ${tags}`], ['b.md', 'a.md'])
    const plan = (await readPlan(ws, 'r'))!
    expect(plan.parts.map((part) => [part.title, part.role])).toEqual([['B', 'section'], ['A', 'front-matter']])
    expect((await folioFrontMatter(ws, 'r')).front).toEqual(['r/a.md'])
    const outline = (await folioOutline(ws, 'r/b.md'))!
    expect(outline.pieces.find((piece) => piece.path === 'r/a.md')?.frontMatter).toBe(true)
    expect(outline.pieces.find((piece) => piece.path === 'r/b.md')?.frontMatter).toBeUndefined()
    const html = await exportedHtml()
    const toc = html.match(/<nav id="toc">[\s\S]*?<\/nav>/)?.[0] ?? ''
    expect(toc).toContain('Beta section')
    expect(toc).not.toContain('Alpha section')
    expect(html.indexOf('A BODY')).toBeGreaterThan(-1)
    expect(html.indexOf('A BODY')).toBeLessThan(html.indexOf('B BODY'))
  })
}

test('a move that would take a #front-matter #summary part out of the leading block is refused, nothing written', async () => {
  await folio(['- [[A]] #front-matter #summary', '- [[B]]'])
  const before = await read(INDEX)
  await expect(movePart(ws, 'r', 0, 1)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  await expect(movePart(ws, 'r', 1, 0)).rejects.toThrow(FRONT_MATTER_STAYS_LEADING)
  expect(await read(INDEX)).toBe(before)
})

test('a write to another line keeps the #front-matter #summary line byte for byte', async () => {
  await folio(['- [[A]] #front-matter #summary', '- [[B]]'])
  await setPartRole('r', 1, 'appendix')
  const index = await read(INDEX)
  expect(index).toContain('- [[A]] #front-matter #summary\n')
  expect(index).toContain('- [[B]] #appendix\n')
  expect((await readPlan(ws, 'r'))!.parts.map((part) => part.role)).toEqual(['front-matter', 'appendix'])
})

test('the role menu: Front matter on a #front-matter #summary part changes nothing; another role replaces the role tags and takes it out', async () => {
  await folio(['- [[A]] #front-matter #summary', '- [[B]]'])
  const before = await read(INDEX)
  // The Plan shows the part as Front matter; choosing it again is no change, and both tags stay.
  await setPartRole('r', 0, 'front-matter')
  expect(await read(INDEX)).toBe(before)
  expect((await readPlan(ws, 'r'))!.parts[0].role).toBe('front-matter')
  // Choosing Front matter where the line's last role tag is front matter already is no change either.
  await write(INDEX, '# R\n\n## Running order\n\n- [[A]] #summary #front-matter\n- [[B]]\n')
  await setPartRole('r', 0, 'front-matter')
  expect(await read(INDEX)).toContain('- [[A]] #summary #front-matter\n')
  // Another role is the owner taking the part out of front matter, as it is for a manifest-marked part: the line
  // gets that role tag alone and the part goes to the start of the contents.
  await write(INDEX, before)
  await setPartRole('r', 0, 'appendix')
  expect(await read(INDEX)).toContain('- [[A]] #appendix\n')
  expect((await readPlan(ws, 'r'))!.parts.map((part) => [part.title, part.role])).toEqual([['A', 'appendix'], ['B', 'section']])
})
