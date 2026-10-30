import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { resolveTabGroups, tabGroupPaths, TAB_GROUP_PATH_LIMIT } from '../../src/main/tab-groups'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-tab-groups-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const write = async (rel: string, content = '# Note\n'): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const manifest = JSON.stringify({ schema_version: 1, content_root: 'parts', files: [{ path: '01.md', role: 'section' }] })

// One fixture tree covering all three rules:
//   talks/ai-foundations-2026/            Folio (manifest)
//     parts/_parts_INDEX.md               a NEARER Index Note — the Folio still wins
//     parts/01.md, research/priming.md
//   metaphor-series/README.md             Index Note (a recognised cover form)
//     drafts/machine.md
//   series-two/_series-two.md             Index Note in the `_<name>.md` form
//     deep/nested/piece.md
//   notebooks/reading/dyslexia.md         neither → own folder
//   README.md                             a root cover: does not swallow the ungrouped folders
async function seedTree(): Promise<void> {
  await write(`talks/ai-foundations-2026/${MANIFEST_NAME}`, manifest)
  await write('talks/ai-foundations-2026/parts/_parts_INDEX.md', '# Parts\n')
  await write('talks/ai-foundations-2026/parts/01.md')
  await write('talks/ai-foundations-2026/research/priming.md')
  await write('metaphor-series/README.md', '# Metaphor series\n')
  await write('metaphor-series/drafts/machine.md')
  await write('series-two/_series-two.md', '# Series two\n')
  await write('series-two/deep/nested/piece.md')
  await write('notebooks/reading/dyslexia.md')
  await write('README.md', '# Archive\n')
  await write('loose.md')
}

test('nearest Folio wins over a nearer Index Note folder; Index Note next; own folder last', async () => {
  await seedTree()
  expect(await resolveTabGroups(ws, [
    'talks/ai-foundations-2026/parts/01.md',
    'talks/ai-foundations-2026/research/priming.md',
    'metaphor-series/drafts/machine.md',
    'series-two/deep/nested/piece.md',
    'notebooks/reading/dyslexia.md',
    'loose.md',
  ])).toEqual({
    'talks/ai-foundations-2026/parts/01.md': 'talks/ai-foundations-2026',
    'talks/ai-foundations-2026/research/priming.md': 'talks/ai-foundations-2026',
    'metaphor-series/drafts/machine.md': 'metaphor-series',
    'series-two/deep/nested/piece.md': 'series-two',
    'notebooks/reading/dyslexia.md': 'notebooks/reading',
    'loose.md': '',
  })
})

test('without the manifest the nearer Index Note decides, and a file in the Folio folder itself groups there', async () => {
  await seedTree()
  await write('talks/ai-foundations-2026/outline.md')
  expect(await resolveTabGroups(ws, ['talks/ai-foundations-2026/outline.md'])).toEqual({ 'talks/ai-foundations-2026/outline.md': 'talks/ai-foundations-2026' })
  await rm(join(root, `talks/ai-foundations-2026/${MANIFEST_NAME}`))
  expect(await resolveTabGroups(ws, ['talks/ai-foundations-2026/parts/01.md', 'talks/ai-foundations-2026/research/priming.md'])).toEqual({
    'talks/ai-foundations-2026/parts/01.md': 'talks/ai-foundations-2026/parts',
    'talks/ai-foundations-2026/research/priming.md': 'talks/ai-foundations-2026/research',
  })
})

test('a malformed manifest still declares a Folio under the shared presence rule', async () => {
  await write(`talk/${MANIFEST_NAME}`, '{ not json')
  await write('talk/parts/01.md')
  expect(await resolveTabGroups(ws, ['talk/parts/01.md'])).toEqual({ 'talk/parts/01.md': 'talk' })
})

test('a root manifest makes the whole workspace one group', async () => {
  await write(MANIFEST_NAME, manifest)
  await write('parts/01.md')
  await write('research/x.md')
  expect(await resolveTabGroups(ws, ['parts/01.md', 'research/x.md'])).toEqual({ 'parts/01.md': '', 'research/x.md': '' })
})

test('a folder path (the Board\'s Collection, `dir/`) resolves as a file inside that folder would', async () => {
  await seedTree()
  expect(await resolveTabGroups(ws, ['talks/ai-foundations-2026/parts/', 'metaphor-series/drafts/', 'notebooks/reading/'])).toEqual({
    'talks/ai-foundations-2026/parts/': 'talks/ai-foundations-2026',
    'metaphor-series/drafts/': 'metaphor-series',
    'notebooks/reading/': 'notebooks/reading',
  })
})

test('non-file tab ids and paths escaping the workspace are skipped, not thrown', async () => {
  await seedTree()
  expect(await resolveTabGroups(ws, ['writeflex://board', '../outside.md', '/abs.md', 'loose.md'])).toEqual({ 'loose.md': '' })
})

test('the IPC boundary accepts only a bounded array of strings', () => {
  expect(tabGroupPaths({ paths: ['a.md'] })).toEqual(['a.md'])
  expect(() => tabGroupPaths({ paths: 'a.md' })).toThrow('Invalid tab group paths.')
  expect(() => tabGroupPaths({ paths: [1] })).toThrow('Invalid tab group paths.')
  expect(() => tabGroupPaths(null)).toThrow('Invalid tab group paths.')
  expect(() => tabGroupPaths({ paths: Array(TAB_GROUP_PATH_LIMIT + 1).fill('a.md') })).toThrow('Too many tab group paths.')
})
