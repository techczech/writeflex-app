// The Folio HTML export's contents is the sidebar Outline's tree (ADR-0046 rule B, folio-heading-flow.ts):
// front matter not listed, chapters on top, a part that opens deeper nested under the chapter before it,
// toc_depth counted from the chapter level, anchors landing on the real headings.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exportBundle } from '../../src/main/export'
import { MANIFEST_NAME } from '../../src/main/folio'
import { Workspace } from '../../src/main/workspace'

let root: string
let out: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-flow-export-'))
  out = await mkdtemp(join(tmpdir(), 'wf-flow-export-out-'))
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

async function folio(dir: string, files: Array<{ path: string; text: string; front?: boolean }>): Promise<void> {
  const entries = files.map((file) => ({ path: file.path, ...(file.front ? { role: 'front-matter', toc: false } : { render: 'section', toc: true }) }))
  await write(`${dir}/${MANIFEST_NAME}`, `${JSON.stringify({ schema_version: 1, content_root: 'contents', files: entries, title: 'Test Folio' }, null, 2)}\n`)
  for (const file of files) await write(`${dir}/contents/${file.path}`, file.text)
}

async function contents(dir: string, html: Record<string, unknown> = {}): Promise<{ page: string; rows: Array<{ cls: string; href: string; text: string }> }> {
  const target = join(out, `${dir}.html`)
  await exportBundle(ws, { dir, format: 'html', target, html })
  const page = await readFile(target, 'utf8')
  const toc = /<nav id="toc">[\s\S]*?<\/nav>/.exec(page)?.[0] ?? ''
  return { page, rows: [...toc.matchAll(/<a class="nav-link ([^"]*)" href="#([^"]*)">([^<]*)<\/a>/g)].map((m) => ({ cls: m[1], href: m[2], text: m[3] })) }
}
const show = (rows: Array<{ cls: string; text: string }>): string[] => rows.map((row) => `${row.cls} ${row.text}`)

const part = (title: string, heading: string, extra = ''): string => `---\ntitle: ${title}\n---\n\n${heading} ${title}\n\nText.\n${extra}`

async function translation(): Promise<void> {
  await folio('tr', [
    { path: '01.md', text: part('Chapter One', '##', '\n### One point\n\nMore.\n') },
    { path: '02.md', text: part('Chapter Two', '##') },
    { path: '03.md', text: part('Berlin a Kay', '###', '\n#### Colour terms\n\nMore.\n') },
    { path: '04.md', text: part('Chapter Three', '##') },
  ])
}

test('translation shape: a part opening deeper nests under the chapter before it, one level in', async () => {
  await translation()
  const { rows } = await contents('tr')
  expect(show(rows)).toEqual([
    'piece-link Chapter One', 'level-2 One point',
    'piece-link Chapter Two', 'level-2 Berlin a Kay', 'level-3 Colour terms',
    'piece-link Chapter Three',
  ])
})

test('toc_depth counts from the chapter level: 1 is chapters only, 2 adds one level below', async () => {
  await translation()
  expect(show((await contents('tr', { tocDepth: 1 })).rows)).toEqual(['piece-link Chapter One', 'piece-link Chapter Two', 'piece-link Chapter Three'])
  expect(show((await contents('tr', { tocDepth: 2 })).rows)).toEqual([
    'piece-link Chapter One', 'level-2 One point', 'piece-link Chapter Two', 'level-2 Berlin a Kay', 'piece-link Chapter Three',
  ])
})

test('every contents link lands on an element of the page: a part on its section, a heading on its id', async () => {
  await translation()
  const { page, rows } = await contents('tr')
  for (const row of rows) expect(page).toContain(`id="${row.href}"`)
  expect(rows.find((row) => row.text === 'Berlin a Kay')?.href).toBe('p3-section')
  expect(rows.find((row) => row.text === 'Colour terms')?.href).toMatch(/^p3-/)
})

test('Pangram shape: the title page is not listed; the parts are chapters', async () => {
  await folio('pg', [
    { path: '00-frontmatter.md', front: true, text: '---\nrole: title-matter\ntitle: Pangram\n---\n\nByline\n' },
    { path: '01-summary.md', text: '---\ntitle: Summary\n---\n\n## Summary\nText.\n' },
    { path: '02-report.md', text: '---\ntitle: Details\n---\n# Details\n## Background\nText.\n' },
  ])
  const { rows } = await contents('pg')
  expect(show(rows)).toEqual(['piece-link Summary', 'piece-link Details', 'level-2 Background'])
})
