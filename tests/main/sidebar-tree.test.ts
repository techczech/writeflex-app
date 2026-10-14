import { expect, test } from 'bun:test'
import { buildTree, createTargetDirectory, filterTreeByName, focusSegments, focusTree, folderBrowsePath, isInFocus, type TreeNode } from '../../src/renderer/src/sidebar-tree'
import type { MarkdownFile } from '../../src/preload'

function file(path: string): MarkdownFile {
  const name = path.split('/').at(-1) ?? path
  const slash = path.lastIndexOf('/')
  return { path, name, directory: slash === -1 ? '' : path.slice(0, slash), modifiedAt: 0, size: 0 }
}

function paths(nodes: TreeNode[]): string[] {
  return nodes.flatMap((node) => (node.kind === 'file' ? [node.path] : [node.path, ...paths(node.children)]))
}

test('filterTreeByName narrows to matching filenames and keeps ancestor folders', () => {
  const tree = buildTree([
    file('drafts/chapter-one.md'),
    file('drafts/research/river-notes.md'),
    file('archive/old.md'),
    file('summary.md'),
  ])

  expect(paths(filterTreeByName(tree, 'river'))).toEqual(['drafts', 'drafts/research', 'drafts/research/river-notes.md'])
})

test('filterTreeByName matches folder names and keeps all children of a matched folder', () => {
  const tree = buildTree([file('Drafts/alpha.md'), file('notes/DRAFTING.md')])

  expect(paths(filterTreeByName(tree, 'draft'))).toEqual(['Drafts', 'Drafts/alpha.md', 'notes', 'notes/DRAFTING.md'])
})

test('filterTreeByName folds diacritics for file and folder names', () => {
  const tree = buildTree([file('mýty/koláč.md'), file('archive/plain.md')])

  expect(paths(filterTreeByName(tree, 'myty'))).toEqual(['mýty', 'mýty/koláč.md'])
  expect(paths(filterTreeByName(tree, 'kolac'))).toEqual(['mýty', 'mýty/koláč.md'])
})

test('filterTreeByName keeps generated top-level directories in the unfiltered tree but not by-name results', () => {
  const tree = buildTree([file('cache/hidden.md'), file('indexes/generated.md'), file('notes/cache-visible.md')])

  expect(paths(filterTreeByName(tree, ''))).toContain('cache/hidden.md')
  expect(paths(filterTreeByName(tree, 'cache'))).toEqual(['notes', 'notes/cache-visible.md'])
})

test('filterTreeByName returns the original tree for a blank query', () => {
  const tree = buildTree([file('a.md')])

  expect(filterTreeByName(tree, '   ')).toBe(tree)
})

test('folder browsing follows sidebar file order within the active folder and wraps', () => {
  const files = [
    file('root-b.md'),
    file('drafts/zeta.md'),
    file('drafts/_drafts_INDEX.md'),
    file('drafts/alpha.md'),
    file('root-a.md'),
  ]

  expect(folderBrowsePath(files, 'drafts/_drafts_INDEX.md', 1)).toBe('drafts/alpha.md')
  expect(folderBrowsePath(files, 'drafts/alpha.md', -1)).toBe('drafts/_drafts_INDEX.md')
  expect(folderBrowsePath(files, 'drafts/zeta.md', 1)).toBe('drafts/_drafts_INDEX.md')
  expect(folderBrowsePath(files, 'root-a.md', -1)).toBe('root-b.md')
})

test('folder browsing is a no-op for an unknown active path or a one-file folder', () => {
  const files = [file('solo/only.md'), file('root.md')]
  expect(folderBrowsePath(files, 'missing.md', 1)).toBeNull()
  expect(folderBrowsePath(files, 'solo/only.md', 1)).toBe('solo/only.md')
})

test('the sidebar name filter keeps an agent note as a candidate, by one word or two', () => {
  const tree = buildTree([file('blogs/schemas-and-propositions/why-schemas-matter.md'), file('blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md')], ['blogs', 'blogs/schemas-and-propositions', 'blogs/schemas-and-propositions/agent-notes'])
  expect(paths(filterTreeByName(tree, 'review'))).toContain('blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md')
  expect(paths(filterTreeByName(tree, 'schem review'))).toContain('blogs/schemas-and-propositions/agent-notes/why-schemas-matter.review.md')
  expect(paths(filterTreeByName(tree, 'schem review'))).not.toContain('blogs/schemas-and-propositions/why-schemas-matter.md')
})

test('focusTree narrows to the focused folder as the one top row, holding its whole subtree', () => {
  const tree = buildTree(
    [file('talks/ai-2026/parts/01.md'), file('talks/ai-2026/research/wolf.md'), file('talks/york/a.md'), file('essays/b.md'), file('top.md')],
    ['talks/ai-2026/scraps'],
  )
  const focused = focusTree(tree, 'talks/ai-2026')
  expect(focused.map((node) => node.path)).toEqual(['talks/ai-2026'])
  expect(paths(focused)).toEqual([
    'talks/ai-2026',
    'talks/ai-2026/parts', 'talks/ai-2026/parts/01.md',
    'talks/ai-2026/research', 'talks/ai-2026/research/wolf.md',
    'talks/ai-2026/scraps',
  ])
  expect(focusTree(tree, null)).toBe(tree)
  // A folder the tree no longer holds narrows to nothing, never silently to the whole archive.
  expect(focusTree(tree, 'talks/gone')).toEqual([])
  // A sibling that shares the name prefix is not inside the focus.
  expect(focusTree(buildTree([file('talks/ai-2026-extra/x.md')]), 'talks/ai-2026')).toEqual([])
})

test('the name filter works inside the focus only', () => {
  const tree = buildTree([file('talks/ai-2026/opening.md'), file('essays/opening.md')])
  expect(paths(filterTreeByName(focusTree(tree, 'talks/ai-2026'), 'opening'))).toEqual(['talks/ai-2026', 'talks/ai-2026/opening.md'])
})

test('path bar segments walk from the top level down to the focus; isInFocus is by segment', () => {
  expect(focusSegments('talks/ai-2026')).toEqual([
    { path: 'talks', name: 'talks' },
    { path: 'talks/ai-2026', name: 'ai-2026' },
  ])
  expect(isInFocus('talks/ai-2026/parts/01.md', 'talks/ai-2026')).toBe(true)
  expect(isInFocus('talks/ai-2026', 'talks/ai-2026')).toBe(true)
  expect(isInFocus('talks/ai-2026-extra/x.md', 'talks/ai-2026')).toBe(false)
  expect(isInFocus('anything.md', null)).toBe(true)
})

test('New file / New folder target: the focused row, else the open file\'s folder, never outside a focused folder', () => {
  const none = { focusedRow: null, activePath: null, focus: null }
  // Unfocused: the existing ruling, unchanged.
  expect(createTargetDirectory({ ...none, focusedRow: { key: 'essays', kind: 'folder' } })).toBe('essays')
  expect(createTargetDirectory({ ...none, focusedRow: { key: 'essays/a.md', kind: 'file' } })).toBe('essays')
  expect(createTargetDirectory({ ...none, activePath: 'talks/ai-2026/parts/01.md' })).toBe('talks/ai-2026/parts')
  expect(createTargetDirectory({ ...none, activePath: 'top.md' })).toBe('')
  expect(createTargetDirectory(none)).toBe('')
  // Focused: the open file's folder when it lies inside the focus…
  const focus = 'talks/ai-2026'
  expect(createTargetDirectory({ focusedRow: null, activePath: 'talks/ai-2026/parts/01.md', focus })).toBe('talks/ai-2026/parts')
  expect(createTargetDirectory({ focusedRow: null, activePath: 'talks/ai-2026/intro.md', focus })).toBe('talks/ai-2026')
  // …otherwise the focused folder itself: a file elsewhere, at the root, none open, or the Board.
  expect(createTargetDirectory({ focusedRow: null, activePath: 'essays/metaphor.md', focus })).toBe(focus)
  expect(createTargetDirectory({ focusedRow: null, activePath: 'top.md', focus })).toBe(focus)
  expect(createTargetDirectory({ focusedRow: null, activePath: null, focus })).toBe(focus)
  expect(createTargetDirectory({ focusedRow: null, activePath: 'writeflex://board', focus })).toBe(focus)
  expect(createTargetDirectory({ focusedRow: null, activePath: 'talks/ai-2026-extra/x.md', focus })).toBe(focus)
  // A tree row inside the focus still wins; a stale row outside it is clamped too.
  expect(createTargetDirectory({ focusedRow: { key: 'talks/ai-2026/research', kind: 'folder' }, activePath: 'top.md', focus })).toBe('talks/ai-2026/research')
  expect(createTargetDirectory({ focusedRow: { key: 'essays', kind: 'folder' }, activePath: null, focus })).toBe(focus)
})
