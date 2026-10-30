import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../../src/main/cli/run'
import { MANIFEST_NAME } from '../../src/main/folio'

// Paths the command line is given are checked in document-path.test.ts. These are the paths a
// DOCUMENT names: a Folio manifest's parts and content_root, a running order's lines, a piece's
// `sources:` list and its wikilinks.
const SECRET = 'zebra-secret-token'
const HIDDEN_TITLE = 'Hidden Part'
let root: string

async function write(rel: string, content: string): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}

const manifest = (parts: string[], contentRoot = ''): string =>
  `${JSON.stringify({ schema_version: 1, content_root: contentRoot, files: ['00_intro.md', ...parts].map((path) => ({ path, role: 'section' })) })}\n`

/** The piece lists the same three sources each time; only how the hidden one is named changes. */
const intro = (hiddenSource: string): string => [
  '---', 'status: draft', 'sources:', '  - research/real.md', `  - ${hiddenSource}`, '---',
  '# Introduction', '', `Opening words, see [[${HIDDEN_TITLE}]] and [[Real note]].`, '',
].join('\n')

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-content-')))
  await write('.writeflex/x.md', `---\ntitle: ${HIDDEN_TITLE}\nstatus: draft\n---\n# ${HIDDEN_TITLE}\n${SECRET} one two three four five\n`)
  await write('.writeflex/planted.json', `${JSON.stringify({ schema_version: 1, content_root: SECRET, files: [{ path: SECRET }] })}\n`)
  await write('report/_report_INDEX.md', ['# Report', '', '## Running order', '', '- [[Introduction]]', `- [[${HIDDEN_TITLE}]]`, ''].join('\n'))
  await write('report/research/real.md', '# Real note\n\nA note.\n')
  await write('report/00_intro-copy.md', '# Introduction\n\nOpening words, differently.\n')
  await symlink('../.writeflex', join(root, 'report', 'link'))
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function json(...argv: string[]): Promise<{ code: number; out: string; result: unknown }> {
  let out = ''
  const code = await runCli(['--root', root, '--json', ...argv], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {}, openUrl: async () => {} })
  return { code, out, result: (JSON.parse(out) as { result?: unknown }).result }
}

/** Run every operation that reads paths named in documents, with the hidden part named as `part`. */
async function readAll(part: string): Promise<Record<string, { code: number; out: string; result: unknown }>> {
  await write(`report/${MANIFEST_NAME}`, manifest([part]))
  await write('report/00_intro.md', intro(part))
  return {
    'running-order': await json('running-order', 'report'),
    sources: await json('sources', 'report/00_intro.md'),
    query: await json('query', 'status: draft', '--dir', 'report'),
    'compare-parts': await json('compare-parts', 'report/00_intro.md', 'report/00_intro-copy.md'),
    search: await json('search', 'zebra'),
  }
}

/** The one place the three runs may differ: the name as the document wrote it. (Each run rewrites the
 *  fixture files, so their modification times are taken out of the comparison.) */
const withName = (text: string, from: string, to: string): string => text.split(from).join(to).replace(/"modifiedAt":[\d.]+/g, '"modifiedAt":0')

test('a part or source a document names in a hidden folder, directly or through a link, reads exactly like one that does not exist', async () => {
  const missing = await readAll('gone/x.md')
  for (const part of ['../.writeflex/x.md', 'link/x.md']) {
    const hidden = await readAll(part)
    for (const [operation, run] of Object.entries(hidden)) {
      expect(run.code, `${operation} with ${part}`).toBe(0)
      expect(run.out, `${operation} with ${part}`).not.toContain(SECRET)
      // Byte for byte the result for a file that is not there, save the name as written: no title,
      // no word count, no sign that anything exists at the far end.
      expect(withName(run.out, part, 'gone/x.md'), `${operation} with ${part}`).toBe(withName(missing[operation].out, part, 'gone/x.md'))
    }
  }
  // An unresolved line stays as it did before linking; no document facts are exposed.
  const plan = missing['running-order'].result as { parts: Array<Record<string, unknown>> }
  expect(plan.parts).toEqual([
    { title: 'Introduction', gloss: null, role: 'section', path: 'report/00_intro.md', words: expect.any(Number), exists: true, synopsis: null, label: null, priority: null, status: 'draft', openFlags: [], evidenceCount: 3 },
    { title: HIDDEN_TITLE, gloss: null, role: 'section', path: null, words: null, exists: false, synopsis: null, label: null, priority: null, status: 'idea', openFlags: [], evidenceCount: 0 },
  ])
  const sources = missing.sources.result as { entries: Array<{ title: string; path: string | null }> }
  expect(sources.entries.find((entry) => entry.title.includes('gone'))?.path ?? null).toBeNull()
})

test('a manifest that is itself a link into a hidden folder is not read: the folder reads as one with no manifest', async () => {
  await write('report/00_intro.md', intro('gone/x.md'))
  const without = await readAll_noManifest()
  await symlink('../.writeflex/planted.json', join(root, 'report', MANIFEST_NAME))
  for (const [operation, argv] of Object.entries(OPERATIONS)) {
    const run = await json(...argv)
    expect(run.out, operation).not.toContain(SECRET)
    expect(run.out, operation).toBe(without[operation])
  }
})

const OPERATIONS: Record<string, string[]> = {
  'running-order': ['running-order', 'report'],
  sources: ['sources', 'report/00_intro.md'],
  query: ['query', 'status: draft', '--dir', 'report'],
  'compare-parts': ['compare-parts', 'report/00_intro.md', 'report/00_intro-copy.md'],
}
async function readAll_noManifest(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [operation, argv] of Object.entries(OPERATIONS)) out[operation] = (await json(...argv)).out
  return out
}

test('a content_root that names a hidden folder, directly or through a link, brings nothing from it into the running order', async () => {
  for (const contentRoot of ['../.writeflex', 'link']) {
    await write(`report/${MANIFEST_NAME}`, manifest(['x.md'], contentRoot))
    await write('report/00_intro.md', intro('x.md'))
    const run = await json('running-order', 'report')
    expect(run.code, contentRoot).toBe(0)
    expect(run.out, contentRoot).not.toContain(SECRET)
    const plan = run.result as { parts: Array<{ title: string; path: string | null; words: number | null }>; strays: unknown[] }
    expect(plan.parts.find((part) => part.title === HIDDEN_TITLE), contentRoot).toMatchObject({ path: null, words: null, exists: false })
    // next/0.23 reads a content_root that leaves the Folio as the Folio folder itself (folio.ts, `contentRootRefused`),
    // so the folder's own unlisted files are strays there; nothing from the hidden folder ever is.
    const strays = plan.strays as Array<{ path: string; title: string }>
    expect(strays.filter((stray) => !stray.path.startsWith('report/') || stray.title === HIDDEN_TITLE), contentRoot).toEqual([])
    if (contentRoot === 'link') expect(strays, contentRoot).toEqual([])
  }
})
