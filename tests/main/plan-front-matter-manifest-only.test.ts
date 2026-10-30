// Choosing Front matter for a part the manifest alone marks as front matter (its Index Note line is a bare `- [[Pre]]`,
// no `#front-matter` tag) must write the Index Note tag and `toc: false`, as the Plan did before 745aed81.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readPlan, setPartRole as setPartRoleNamed } from '../../src/main/plan'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-manifest-only-front-'))
  ws = new Workspace(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

test('choosing Front matter for a manifest-only front-matter part writes the Index Note tag and toc false', async () => {
  await write('book/pre.md', '---\nfolio: section\n---\n# Pre\n')
  await write('book/a.md', '# Alpha\n')
  await write('book/_report-structure.json', '{"files":[{"path":"pre.md","role":"front-matter"},{"path":"a.md"}]}\n')
  await write('book/_book_INDEX.md', '# Book\n\n## Running order\n\n- [[Pre]]\n- [[Alpha]]\n')

  const plan = (await readPlan(ws, 'book'))!
  expect(plan.parts[0].role).toBe('front-matter')
  const part = plan.parts[0]
  await setPartRoleNamed(ws, 'book', 0, 'front-matter', { title: part.title, path: part.path, gloss: part.gloss, role: part.role, tags: part.tags })

  const index = await readFile(join(root, 'book/_book_INDEX.md'), 'utf8')
  expect(index).toMatch(/^- \[\[.*Pre\]\] #front-matter$/m)
  expect(index).toMatch(/^- \[\[.*Alpha\]\]$/m)
  const manifest = JSON.parse(await readFile(join(root, 'book/_report-structure.json'), 'utf8')) as { files: Array<{ path: string; role?: string; toc?: boolean }> }
  expect(manifest.files[0]).toMatchObject({ path: 'pre.md', role: 'front-matter', toc: false })
  expect((await readPlan(ws, 'book'))!.parts[0].role).toBe('front-matter')
})
