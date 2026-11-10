import { expect, test } from 'bun:test'
import { isHiddenByView, quickOpenFiles } from '../../src/renderer/src/quick-open'
import { buildCommandPaletteSections } from '../../src/renderer/src/components/CommandPalette'

const paths = ['papers/unitybc-paper/01-pilot-overview.md', 'papers/unitybc-paper/research/notes/trial-run.md', 'inbox/ideas.md', 'archive/2019-old-draft.md']
const titles = { 'papers/unitybc-paper/01-pilot-overview.md': 'Pilot overview', 'inbox/ideas.md': 'Things I want to write', 'archive/2019-old-draft.md': 'An old draft' }
const hiddenPaths = ['archive', 'papers/unitybc-paper/research']

test('quick open finds a file by its title as well as by its file name', () => {
  expect(quickOpenFiles('pilot over', paths, { titles }).map((hit) => hit.path)[0]).toBe('papers/unitybc-paper/01-pilot-overview.md')
  expect(quickOpenFiles('things write', paths, { titles }).map((hit) => hit.path)).toEqual(['inbox/ideas.md'])
  expect(quickOpenFiles('trial run', paths, { titles }).map((hit) => hit.path)).toEqual(['papers/unitybc-paper/research/notes/trial-run.md'])
})

test('quick open always includes what Writing only hides, and marks it', () => {
  const hits = quickOpenFiles('draft', paths, { titles, hiddenPaths })
  const old = hits.find((hit) => hit.path === 'archive/2019-old-draft.md')
  expect(old?.hidden).toBe(true)
  expect(old?.title).toBe('An old draft')
  expect(quickOpenFiles('', paths, { titles, hiddenPaths }).filter((hit) => hit.hidden).map((hit) => hit.path)).toEqual(['papers/unitybc-paper/research/notes/trial-run.md', 'archive/2019-old-draft.md'])
  expect(isHiddenByView('papers/unitybc-paper/01-pilot-overview.md', hiddenPaths)).toBe(false)
  expect(isHiddenByView('archive', hiddenPaths)).toBe(true)
})

test('the palette in files mode lists hidden files with the hidden mark and a title match', () => {
  const files = paths.map((path) => ({ path, name: path.split('/').at(-1)!, directory: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }))
  const sections = buildCommandPaletteSections({ mode: 'files', query: 'old draft', files: files as never, folders: [], commands: [], skills: [], activeFile: null, recentIds: [], titles, hiddenPaths })
  const items = sections.flatMap((section) => section.items)
  const old = items.find((item) => item.kind === 'file' && item.file.path === 'archive/2019-old-draft.md')
  expect(old).toBeDefined()
  expect(old && old.kind === 'file' ? old.hidden : false).toBe(true)
})
