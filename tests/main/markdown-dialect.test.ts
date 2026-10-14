import { test, expect } from 'bun:test'
import { GFM, parser, type MarkdownConfig, type DelimiterType } from '@lezer/markdown'
import { Tag, tags } from '@lezer/highlight'
import {
  exportSource,
  flattenWikilinks,
  footnoteDefinitions,
  markdownDialect,
  parseMarkdown,
  stripComments,
  stripFrontmatter,
  wikilinkRanges,
} from '../../src/shared/markdown/dialect'

// ---------------------------------------------------------------------------------------------
// The FROZEN copy of the editor's inline parser configuration as it stood before Round B Task 1
// (src/renderer/src/editor/setup.ts @ 0.8.2). Nothing below may be "tidied": it is the reference
// the shared dialect is measured against, so that the extraction is provably a pure move and the
// editor's parse cannot drift from the exporters' parse afterwards.
// ---------------------------------------------------------------------------------------------

const oldHighlightMarkTag = Tag.define()
const oldFootnoteTag = Tag.define()

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' }
const INLINE_PUNCTUATION = /[!-/:-@[-`{-~¡-¿‐-‧]/

const OldHighlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': oldHighlightMarkTag } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = INLINE_PUNCTUATION.test(before)
        const pAfter = INLINE_PUNCTUATION.test(after)
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        )
      },
    },
  ],
}

const OldFootnotes: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: oldFootnoteTag },
    { name: 'FootnoteInline', style: oldFootnoteTag },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1
        let end = pos + 2
        while (end < cx.end) {
          const c = cx.char(end)
          if (c === 93 /* ] */) break
          if (c === 32 || c === 9 || c === 10 || c === 91) return -1
          end++
        }
        if (end >= cx.end || cx.char(end) !== 93 || end === pos + 2) return -1
        return cx.addElement(cx.elt('FootnoteReference', pos, end + 1))
      },
    },
    {
      name: 'FootnoteInline',
      parse(cx, next, pos) {
        if (next !== 94 /* ^ */ || cx.char(pos + 1) !== 91 /* [ */) return -1
        let depth = 1
        let end = pos + 2
        while (end < cx.end && depth > 0) {
          const c = cx.char(end)
          if (c === 91 /* [ */) depth++
          else if (c === 93 /* ] */) {
            depth--
            if (depth === 0) break
          }
          end++
        }
        if (depth !== 0) return -1
        return cx.addElement(cx.elt('FootnoteInline', pos, end + 1))
      },
    },
  ],
}

const oldParser = parser.configure([GFM, OldHighlight, OldFootnotes])

/** Every node as `name@from-to`, in tree order — positions included, so a shifted boundary fails. */
function serialise(tree: { cursor: () => { name: string; from: number; to: number; next: () => boolean } }): string {
  const lines: string[] = []
  const cursor = tree.cursor()
  do lines.push(`${cursor.name}@${cursor.from}-${cursor.to}`)
  while (cursor.next())
  return lines.join('\n')
}

/** One fixture exercising every construct the dialect claims: headings, GFM tables, task lists,
 *  strikethrough, `==mark==`, footnote reference + inline, code fences, block quotes, nested lists,
 *  links, images, wikilinks. */
const FIXTURE = `---
title: Fixture
tags: [a, b]
---

# Heading one

## Heading two

Prose with **bold**, *italic*, ~~struck~~, ==marked==, \`code\`, a [link](https://example.com)
and an ![image](pictures/river.png), plus a [[wikilink]] and a [[target|labelled one]].

A footnote reference[^1] and an inline one ^[said in passing].

> A block quote
> over two lines.

- one
- two
  - nested
  - also nested
- three

1. first
2. second

- [ ] unticked task
- [x] ticked task

| Column | Another |
| --- | ---: |
| **cell** | \`code\` |
| plain | [link](https://example.com) |

\`\`\`js
const x = '==not a mark=='
\`\`\`

    indented code block

Setext heading
==============

[^1]: The definition, at the end.
`

test('the shared dialect is the editor configuration, unchanged', () => {
  expect(serialise(oldParser.parse(FIXTURE))).toBe(serialise(parseMarkdown(FIXTURE)))
})

test('the shared dialect parses each construct identically in isolation', () => {
  const cases = [
    '# H1\n',
    '###### H6\n',
    'Setext\n===\n',
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    '- [ ] todo\n- [x] done\n',
    '~~gone~~\n',
    '==mark== and ===not a mark===\n',
    'a[^label] b\n',
    '^[inline note]\n',
    '^[nested [brackets] inside]\n',
    '[^1]: definition\n',
    '```ts\nconst a = 1\n```\n',
    '> quote\n> more\n',
    '- a\n  - b\n    - c\n',
    '1. one\n2. two\n',
    '[text](url "title")\n',
    '![alt](src.png)\n',
    '[[wiki]] [[wiki|label]] [[]]\n',
    'word==word== ==word==word x ==a b==\n',
    'https://autolink.example.com\n',
    'a  \nhard break\n',
    'Čeština — em-dash a diakritika ==zvýrazněná==.\n',
  ]
  for (const source of cases) {
    expect(serialise(parseMarkdown(source))).toBe(serialise(oldParser.parse(source)))
  }
})

test('markdownDialect is the five-extension list the editor installs', () => {
  const dialect = markdownDialect()
  // 3 → 4 (2026-09-27, list types): FancyLists, Pandoc-style lettered and roman lists.
  // 4 → 5 (2026-10-09): ShortDashIsText, a lone `-` under a paragraph is not a setext underline (no nodes of its own).
  expect(dialect).toHaveLength(5)
  expect(dialect[0]).toBe(GFM)
  // The WriteFlex configurations carry their node definitions, not just parsers — the editor's
  // highlighting depends on the styles travelling with the configuration.
  const names = dialect.slice(1).flatMap((config) => (config as MarkdownConfig).defineNodes ?? [])
    .map((node) => (typeof node === 'string' ? node : node.name))
  expect(names).toEqual(['Highlight', 'HighlightMark', 'FootnoteReference', 'FootnoteInline', 'FancyList'])
})

// ---- What is content, and what is not (Round B T2) --------------------------------------------

test('frontmatter is stripped, and only a leading block counts as frontmatter', () => {
  expect(stripFrontmatter('---\ntitle: x\ntags: [a]\n---\n\nBody.\n')).toBe('\nBody.\n')
  expect(stripFrontmatter('Body.\n\n---\n\nMore.\n')).toBe('Body.\n\n---\n\nMore.\n')
  expect(stripFrontmatter('No frontmatter here.\n')).toBe('No frontmatter here.\n')
  // A thematic break is not an unterminated frontmatter block.
  expect(stripFrontmatter('---\nnot closed\n')).toBe('---\nnot closed\n')
  expect(stripFrontmatter('---\nnázev: Poznámka\n---\n\nBody.\n')).toBe('\nBody.\n')
})

test('comments are stripped outside fences and kept inside them', () => {
  expect(stripComments('a\n// note\nb\n')).toBe('a\nb\n')
  expect(stripComments('a\n  // indented note\nb\n')).toBe('a\nb\n')
  expect(stripComments('```js\n// real code\n```\n')).toBe('```js\n// real code\n```\n')
  expect(stripComments('~~~\n// real code\n~~~\n')).toBe('~~~\n// real code\n~~~\n')
})

test('exportSource is the bytes that may leave the app', () => {
  expect(exportSource('---\nstatus: draft\n---\n\n// private\nProse.\n')).toBe('Prose.\n')
  expect(exportSource('---\nnázev: Poznámka\n---\n\nProse.\n')).toBe('Prose.\n')
})

test('wikilink ranges follow the editor classifier', () => {
  expect(wikilinkRanges('a [[Target]] b [[t#head|Label]] c [[]]').map((link) => [link.target, link.label])).toEqual([
    ['Target', 'Target'],
    ['t', 'Label'],
    ['', 'Untitled idea'],
  ])
  expect(flattenWikilinks('See [[The River]] and [[x|that]].')).toBe('See The River and that.')
})

test('footnote definitions are lifted out of the body, continuation lines folded in', () => {
  const { body, definitions } = footnoteDefinitions('Prose[^1] here.\n\n[^1]: The note,\n    continued.\n\n[^b]: Another.\n')
  expect(body).toBe('Prose[^1] here.')
  expect(definitions).toEqual([
    { label: '1', text: 'The note, continued.' },
    { label: 'b', text: 'Another.' },
  ])
})
