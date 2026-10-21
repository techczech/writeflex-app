import { test, expect } from 'bun:test'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import {
  extractOutline,
  extractOutlineOfState,
  buildOutlineTree,
  activeHeadingIndex,
} from '../../src/renderer/src/editor/outline'

// ── extractOutline (salvaged from M1) ────────────────────────────────────────
test('extracts ATX headings with level, text, and position', () => {
  const doc = '# One\n\ntext\n\n## Two\n\n### Three deep\n'
  expect(extractOutline(doc)).toEqual([
    { level: 1, text: 'One', from: 0 },
    { level: 2, text: 'Two', from: 13 },
    { level: 3, text: 'Three deep', from: 21 },
  ])
})

test('ignores hashes inside fenced code and requires the space', () => {
  const doc = '```\n# not a heading\n```\n\n#nospace\n\n# real\n'
  const outline = extractOutline(doc)
  expect(outline.length).toBe(1)
  expect(outline[0].text).toBe('real')
})

test('setext headings', () => {
  const doc = 'Title\n=====\n\nSub\n---\n'
  expect(extractOutline(doc).map((h) => [h.level, h.text])).toEqual([
    [1, 'Title'],
    [2, 'Sub'],
  ])
})

test('a frontmatter block yields no heading and the real headings keep their offsets', () => {
  // Backlog 2026-09-11: the closing `---` read as a Setext underline, so `title: X` became an H2.
  const doc = '---\ntitle: X\ntags: [a]\n---\n\n# Real\n\ntext\n\n## Second\n'
  expect(extractOutline(doc)).toEqual([
    { level: 1, text: 'Real', from: doc.indexOf('# Real') },
    { level: 2, text: 'Second', from: doc.indexOf('## Second') },
  ])
})

test('a document opening on a thematic break is not frontmatter and keeps its setext heading', () => {
  // The shared recogniser demands a `key: value` line; prose between two rules is writing.
  const doc = '---\nJust prose here\n---\n\n# Real\n'
  expect(extractOutline(doc).map((h) => [h.level, h.text])).toEqual([[2, 'Just prose here'], [1, 'Real']])
})

// ── buildOutlineTree ─────────────────────────────────────────────────────────
test('nests headings by level into a tree', () => {
  const headings = extractOutline('# A\n\n## B\n\n### C\n\n## D\n\n# E\n')
  const tree = buildOutlineTree(headings)
  expect(tree.map((n) => n.text)).toEqual(['A', 'E'])
  expect(tree[0].children.map((n) => n.text)).toEqual(['B', 'D'])
  expect(tree[0].children[0].children.map((n) => n.text)).toEqual(['C'])
  expect(tree[1].children).toEqual([])
})

test('an irregular level jump still attaches every heading', () => {
  const headings = extractOutline('# A\n\n### C\n')
  const tree = buildOutlineTree(headings)
  expect(tree.map((n) => n.text)).toEqual(['A'])
  expect(tree[0].children.map((n) => n.text)).toEqual(['C'])
})

// ── activeHeadingIndex (cursor follow) ───────────────────────────────────────
test('active heading is the last one starting at or before the cursor', () => {
  const headings = extractOutline('# One\n\ntext\n\n## Two\n\nbody\n')
  // "# One" at 0, "## Two" at 13.
  expect(activeHeadingIndex(headings, 0)).toBe(0) // on the first heading
  expect(activeHeadingIndex(headings, 8)).toBe(0) // in One's body
  expect(activeHeadingIndex(headings, 13)).toBe(1) // on the second heading
  expect(activeHeadingIndex(headings, 22)).toBe(1) // in Two's body
})

test('active heading index is -1 above the first heading', () => {
  const headings = extractOutline('intro\n\n# One\n')
  expect(activeHeadingIndex(headings, 2)).toBe(-1)
})

// ── extractOutlineOfState (0.24.1): the editor's syntax tree answers what the text parse did ──
for (const [name, doc] of Object.entries({
  fenced: 'Prose\n```bash\n# not a heading\n```\n## Real\n',
  setext: 'Title\n=====\n\nSub\n---\n\ntext\n',
  frontmatter: '---\ntitle: x\n---\n# First\n\n## Second *em*\n',
  nested: '- item\n  # in list\n\n> ## in quote\n\n1. one\n\n#### deep ####\n',
  none: 'just prose\n',
})) {
  test(`state outline equals text outline: ${name}`, () => {
    const state = EditorState.create({ doc, extensions: [markdown({ extensions: markdownDialect() })] })
    expect(extractOutlineOfState(state, doc)).toEqual(extractOutline(doc))
    expect(extractOutlineOfState(EditorState.create({ doc }), doc)).toEqual(extractOutline(doc))
  })
}
