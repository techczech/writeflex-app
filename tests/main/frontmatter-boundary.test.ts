import { test, expect } from 'bun:test'
import { frontmatterBlock } from '../../src/shared/markdown/frontmatter'
import { exportSource, stripFrontmatter } from '../../src/shared/markdown/dialect'
import { parseFrontmatter, frontmatterKeys } from '../../src/main/frontmatter'
import { toHtml } from '../../src/shared/markdown/to-html'
import { toRtf } from '../../src/shared/markdown/to-rtf'
import { toPlain } from '../../src/shared/markdown/to-plain'
import { toNormalisedMarkdown } from '../../src/shared/markdown/to-markdown'

// Where frontmatter ENDS and the writing BEGINS, asked once and answered once (finding 4).
//
// The export layer used to answer it with a bare shape check — a leading `---`, anything at all, a
// closing `---` — while the frontmatter organ (src/main/frontmatter.ts) answered it with the key
// shapes it can actually read. A document that opens on a thematic break therefore had its first
// paragraph DELETED from every copy and every export. There is now one definition, in
// src/shared/markdown/frontmatter.ts, and both sides ask it.

const FLAVOURS: Record<string, (source: string) => string> = {
  html: (source) => toHtml(source).html,
  rtf: (source) => toRtf(source),
  plain: (source) => toPlain(source),
  'normalised markdown': (source) => toNormalisedMarkdown(source),
}

function expectEveryFlavour(source: string, expectation: (output: string, flavour: string) => void): void {
  for (const [flavour, render] of Object.entries(FLAVOURS)) expectation(render(source), flavour)
}

// ---- The data loss (finding 4) ------------------------------------------------------------------

test('a leading thematic break followed by prose is NOT frontmatter — the writing survives', () => {
  const source = '---\n\nSome real prose paragraph.\n\n---\n\nMore.\n'
  expect(stripFrontmatter(source)).toBe(source)
  expectEveryFlavour(source, (output, flavour) => {
    expect(`${flavour} → ${output}`).toContain('Some real prose paragraph.')
    expect(`${flavour} → ${output}`).toContain('More.')
  })
})

test('a leading list, quote or heading between two rules is not frontmatter either', () => {
  for (const source of [
    '---\n- a shopping list\n- of two items\n---\n\nMore.\n',
    '---\n> A quotation to open on.\n---\n\nMore.\n',
    '---\n# A heading\n---\n\nMore.\n',
  ]) {
    expect(stripFrontmatter(source)).toBe(source)
    expect(parseFrontmatter(source)).toBeNull()
  }
})

// ---- Real frontmatter still never leaves ---------------------------------------------------------

test('real frontmatter is still stripped from every flavour', () => {
  const source = '---\ntitle: A Piece\nstatus: draft\ntags: [river, quiet]\n---\n\nThe writing itself.\n'
  expect(stripFrontmatter(source)).toBe('\nThe writing itself.\n')
  expectEveryFlavour(source, (output, flavour) => {
    expect(`${flavour} → ${output}`).not.toContain('status')
    expect(`${flavour} → ${output}`).not.toContain('A Piece')
    expect(`${flavour} → ${output}`).toContain('The writing itself.')
  })
})

test('a frontmatter block whose junk lines sit beside real keys is still frontmatter', () => {
  // The organ keeps unparseable lines under extra._raw rather than throwing; the export layer must
  // agree that the whole block is metadata, junk lines and all.
  const source = '---\ntitle: Good\nthis line has no colon and is junk\nstatus: draft\n---\n\nBody.\n'
  expect(stripFrontmatter(source)).toBe('\nBody.\n')
  expect(parseFrontmatter(source)!.extra._raw).toEqual(['this line has no colon and is junk'])
})

test('an empty frontmatter block is frontmatter, and an unclosed one is not', () => {
  expect(stripFrontmatter('---\n---\n\nBody.\n')).toBe('\nBody.\n')
  expect(stripFrontmatter('---\nnot closed\n')).toBe('---\nnot closed\n')
  expect(stripFrontmatter('---\ntitle: never closed\n')).toBe('---\ntitle: never closed\n')
})

test('a Windows-authored file (UTF-8 BOM) has its frontmatter stripped too', () => {
  // The organ already stripped a leading U+FEFF before its fence check; the export regex did not,
  // so a BOM'd file leaked its whole metadata block into every copy and export.
  const source = '﻿---\ntitle: Windows-authored\nstatus: draft\n---\n\nThe writing itself.\n'
  expect(stripFrontmatter(source)).toBe('\nThe writing itself.\n')
  expectEveryFlavour(source, (output, flavour) => {
    expect(`${flavour} → ${output}`).not.toContain('Windows-authored')
    expect(`${flavour} → ${output}`).toContain('The writing itself.')
  })
})

test('exportSource still removes frontmatter and comments together', () => {
  expect(exportSource('---\nstatus: draft\n---\n\n// private\nProse.\n')).toBe('Prose.\n')
})

// ---- One definition, asked by both sides ----------------------------------------------------------

test('the shared block reader and the frontmatter organ agree on every shape', () => {
  const shapes = [
    '---\ntitle: x\n---\n\nBody.\n',
    '---\n---\n\nBody.\n',
    '---\n\nProse, not metadata.\n\n---\n\nMore.\n',
    '---\nnot closed\n',
    'Body first.\n\n---\n\nMore.\n',
    '﻿---\ntitle: x\n---\n',
    '',
    '---\n- a\n- b\n---\n',
  ]
  for (const source of shapes) {
    const isFrontmatter = frontmatterBlock(source) !== null
    expect(`${JSON.stringify(source)} → organ: ${parseFrontmatter(source) !== null}`)
      .toBe(`${JSON.stringify(source)} → organ: ${isFrontmatter}`)
    expect(`${JSON.stringify(source)} → stripped: ${stripFrontmatter(source) !== source.replace(/^﻿/, '')}`)
      .toBe(`${JSON.stringify(source)} → stripped: ${isFrontmatter}`)
  }
})

test('frontmatterKeys reads the same block the exporters remove', () => {
  expect(frontmatterKeys('---\ntitle: x\nvenue: y\n---\n\nBody.\n')).toEqual(['title', 'venue'])
  expect(frontmatterKeys('---\n\nProse, not metadata.\n\n---\n')).toEqual([])
})
