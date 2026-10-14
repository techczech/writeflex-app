import { test, expect } from 'bun:test'
import { exportSource, footnoteDefinitions, stripComments } from '../../src/shared/markdown/dialect'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toRtf } from '../../src/shared/markdown/to-rtf'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toNormalisedMarkdown } from '../../src/shared/markdown/to-markdown'

// CODE IS QUOTED, NOT PROSE — the boundary the wikilink law already draws, held by the two cleaners
// that run BEFORE the parse (dialect.ts).
//
// Both used to read the source as flat lines. `stripComments` tracked ``` fences with a delimiter-
// blind toggle, so a `~~~` line inside a ``` block closed it and everything after was "prose"; and it
// knew nothing of INDENTED code, so `    // real code` was deleted from a writer's example. The
// footnote lifter matched `[^1]:` anywhere at all, so a Markdown example inside a fence lost the line
// and had its closing fence folded into the note.
//
// The fix is the same in both places: what counts as code is asked of the dialect's own parser, once,
// rather than re-guessed by a regex. Every case below is silent deletion of the writer's text.

const FLAVOURS: Record<string, (source: string) => string> = {
  html: (source) => toHtml(source).html,
  rtf: (source) => toRtf(source),
  plain: (source) => toPlain(source),
  'normalised markdown': (source) => toNormalisedMarkdown(source),
}

function expectEveryFlavour(source: string, expectation: (output: string, flavour: string) => void): void {
  for (const [flavour, render] of Object.entries(FLAVOURS)) expectation(render(source), flavour)
}

// ---- `//` inside code ---------------------------------------------------------------------------

test('a `//` line inside an INDENTED code block is code, and survives every flavour', () => {
  const source = 'Example:\n\n    // real code\n    const a = 1\n'
  expect(stripComments(source)).toBe(source)
  expectEveryFlavour(source, (output, flavour) => {
    expect(`${flavour} → ${output}`).toContain('// real code')
  })
})

test('every line of an indented code block travels, not just the first', () => {
  // An indented block is one CodeBlock node holding a CodeText run PER CHUNK — the gaps between them
  // are exactly the four spaces that make the block code. Reading only the FIRST CodeText child threw
  // away every line after the first, in all four flavours at once.
  const source = 'Example:\n\n    const a = 1\n    const b = 2\n\n    const c = 3\n'
  expectEveryFlavour(source, (output, flavour) => {
    for (const line of ['const a = 1', 'const b = 2', 'const c = 3']) {
      expect(`${flavour} → ${output}`).toContain(line)
    }
  })
  expect(toPlain(source)).toBe('Example:\n\nconst a = 1\nconst b = 2\n\nconst c = 3\n')
})

test('an indented code block inside a list item is code too', () => {
  const source = '- item\n\n      // deep code\n\nafter\n'
  expect(stripComments(source)).toBe(source)
  expect(toPlain(source)).toContain('// deep code')
})

test('a closing fence must match the delimiter that opened the block', () => {
  // `~~~` cannot close a ``` block: everything between the two ``` lines is one code block, and the
  // delimiter-blind toggle turned the second half of it back into "prose" and deleted the `//` line.
  const source = '```\n// code\n~~~\n// still code?\n```\n'
  expect(stripComments(source)).toBe(source)
  expect(toPlain(source)).toContain('// still code?')
})

test('a longer fence run closes a shorter one, and a shorter one does not close a longer', () => {
  const source = '````\n// outer code\n```\n// still inside\n````\n'
  expect(stripComments(source)).toBe(source)
  expect(toPlain(source)).toContain('// still inside')
})

test('a `//` line inside a fence in a block quote is code', () => {
  const source = '> ```\n> // quoted code\n> ```\n'
  expect(stripComments(source)).toBe(source)
  expect(toPlain(source)).toContain('// quoted code')
})

test('a `//` line that is ordinary prose annotation still goes', () => {
  expect(stripComments('a\n// note\nb\n')).toBe('a\nb\n')
  expect(stripComments('a\n  // indented note\nb\n')).toBe('a\nb\n')
  expect(stripComments('```js\n// real code\n```\n')).toBe('```js\n// real code\n```\n')
  expect(stripComments('~~~\n// real code\n~~~\n')).toBe('~~~\n// real code\n~~~\n')
  // Four spaces alone are not a code block when they continue a paragraph — the line is prose, and a
  // `//` on it is a comment, exactly as the writer sees it painted.
  expect(stripComments('A paragraph\n    // still the paragraph\n')).toBe('A paragraph\n')
})

// ---- A footnote definition inside code ----------------------------------------------------------

test('a `[^1]:` line inside a fence is an example, not a definition', () => {
  const source = 'Here is how:\n\n```md\n[^1]: a definition\n```\n\nDone.\n'
  const { body, definitions } = footnoteDefinitions(source)
  expect(definitions).toEqual([])
  expect(body).toBe('Here is how:\n\n```md\n[^1]: a definition\n```\n\nDone.')
  expectEveryFlavour(source, (output, flavour) => {
    expect(`${flavour} → ${output}`).toContain('[^1]: a definition')
    expect(`${flavour} → ${output}`).toContain('Done.')
  })
})

test('a `[^1]:` line inside an indented code block is an example too', () => {
  const source = 'Like this:\n\n    [^1]: a definition\n\nDone.\n'
  expect(footnoteDefinitions(source).definitions).toEqual([])
  expect(toPlain(source)).toContain('[^1]: a definition')
})

test('a real definition outside code is still lifted, continuation lines folded in', () => {
  const { body, definitions } = footnoteDefinitions('Prose[^1] here.\n\n[^1]: The note,\n    continued.\n\n[^b]: Another.\n')
  expect(body).toBe('Prose[^1] here.')
  expect(definitions).toEqual([
    { label: '1', text: 'The note, continued.' },
    { label: 'b', text: 'Another.' },
  ])
})

test("a definition's continuation stops at a code block rather than swallowing it", () => {
  const { body, definitions } = footnoteDefinitions('Prose[^1] here.\n\n[^1]: The note.\n```js\nconst a = 1\n```\n')
  expect(definitions).toEqual([{ label: '1', text: 'The note.' }])
  expect(body).toContain('const a = 1')
  expect(body).toContain('```js')
})

// ---- A Windows-authored file with no frontmatter ------------------------------------------------

test('a UTF-8 BOM never reaches the parse — the first line is read as what it is', () => {
  // The BOM is removed once, at the export boundary, because every "first line" question downstream
  // is otherwise answered wrongly: `﻿# Heading` parses as a paragraph, `﻿// note` scans as prose and
  // `﻿[^1]: x` is not a definition. The frontmatter reader tolerates its own BOM (frontmatter.ts).
  expect(exportSource('﻿# Heading\n\nBody.\n')).toBe('# Heading\n\nBody.\n')
  expect(exportSource('﻿// private\nProse.\n')).toBe('Prose.\n')
  expectEveryFlavour('﻿# Heading\n\nBody.\n', (output, flavour) => {
    expect(`${flavour} → ${output}`).not.toContain('﻿')
  })
  expect(toHtml('﻿# Heading\n\nBody.\n').html).toContain('<h1')
  expect(toPlain('﻿# Heading\n\nBody.\n')).toBe('Heading\n\nBody.\n')
  // A U+FEFF anywhere else is a character the writer typed; only a leading one is a byte-order mark.
  expect(exportSource('Body﻿mid.\n')).toBe('Body﻿mid.\n')
})
