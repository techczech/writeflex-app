import { describe, expect, test } from 'bun:test'
import type { Tree } from '@lezer/common'
import { parseMarkdown } from '../../src/shared/markdown/dialect'
import { fancyMarkerAt, labelFor, nextMarker, numberingOfFirst, ordinalOf } from '../../src/shared/markdown/fancy-lists'
import { readDocument } from '../../src/shared/markdown/model'

/**
 * Lettered and roman lists (docs/plans/2026-09-27-checkbox-lists/tickets/02): the numbering
 * arithmetic the editor and exporters share, and the dialect's reading of `a.`, `A.`, `i.`, `I.`.
 */

describe('the continuation seam: marker → next marker', () => {
  test('letters and numerals count on, keeping the delimiter', () => {
    expect(nextMarker('a.')).toBe('b.')
    expect(nextMarker('b)')).toBe('c)')
    expect(nextMarker('A.')).toBe('B.')
    expect(nextMarker('i.')).toBe('ii.')
    expect(nextMarker('ii.')).toBe('iii.')
    expect(nextMarker('iv)')).toBe('v)')
    expect(nextMarker('I.')).toBe('II.')
    expect(nextMarker('9.')).toBe('10.')
  })

  test('z → aa, and xxxix → xl', () => {
    expect(nextMarker('z.')).toBe('aa.')
    expect(nextMarker('Z)')).toBe('AA)')
    expect(nextMarker('az.', 'lower-alpha')).toBe('ba.')
    expect(nextMarker('xxxix.')).toBe('xl.')
    expect(nextMarker('XXXIX.')).toBe('XL.')
    expect(nextMarker('mcmxcix.')).toBe('mm.')
  })

  test('the list’s own numbering decides an ambiguous label: i after h is a letter', () => {
    expect(nextMarker('i.', 'lower-alpha')).toBe('j.')
    expect(nextMarker('v.', 'lower-roman')).toBe('vi.')
    expect(nextMarker('v.')).toBe('w.') // alone, v is the 22nd letter, as Pandoc reads it
    expect(nextMarker('-')).toBeNull()
  })

  test('a list opens on a single letter, i/I, or a roman numeral — not on aa', () => {
    expect(numberingOfFirst('a')).toBe('lower-alpha')
    expect(numberingOfFirst('C')).toBe('upper-alpha')
    expect(numberingOfFirst('i')).toBe('lower-roman')
    expect(numberingOfFirst('I')).toBe('upper-roman')
    expect(numberingOfFirst('iv')).toBe('lower-roman')
    expect(numberingOfFirst('12')).toBe('decimal')
    expect(numberingOfFirst('aa')).toBeNull()
    expect(numberingOfFirst('ok')).toBeNull()
    expect(numberingOfFirst('Ab')).toBeNull()
  })

  test('ordinals and labels round-trip', () => {
    for (let n = 1; n <= 800; n += 1) {
      expect(ordinalOf(labelFor(n, 'lower-alpha'), 'lower-alpha')).toBe(n)
      expect(ordinalOf(labelFor(n, 'upper-roman'), 'upper-roman')).toBe(n)
    }
    expect(labelFor(27, 'lower-alpha')).toBe('aa')
    expect(labelFor(40, 'lower-roman')).toBe('xl')
  })

  test('Pandoc’s initials guard: a single capital with a period needs two spaces', () => {
    expect(fancyMarkerAt('I. M. Pei designed it')).toBeNull()
    expect(fancyMarkerAt('B. Russell wrote')).toBeNull()
    expect(fancyMarkerAt('I.  Introduction')?.label).toBe('I')
    expect(fancyMarkerAt('B)\tsecond')?.label).toBe('B')
    expect(fancyMarkerAt('a. first')?.numbering).toBe('lower-alpha')
    expect(fancyMarkerAt('aa. later')).toMatchObject({ label: 'aa', numbering: null })
    expect(fancyMarkerAt('a.b')).toBeNull()
    expect(fancyMarkerAt('Hello. there')).toBeNull()
  })
})

/** The parse as an outline of block node names, with each ListMark's text. */
function outline(source: string): string[] {
  const tree: Tree = parseMarkdown(source)
  const out: string[] = []
  const cursor = tree.cursor()
  const walk = (depth: number): void => {
    do {
      const name = cursor.name
      if (/List|ListItem|ListMark|Paragraph|Task$|FencedCode/.test(name)) {
        out.push(`${'  '.repeat(depth)}${name}${name === 'ListMark' ? ` ${source.slice(cursor.from, cursor.to)}` : ''}`)
      }
      if (cursor.firstChild()) {
        walk(depth + 1)
        cursor.parent()
      }
    } while (cursor.nextSibling())
  }
  walk(0)
  return out.map((line) => line.replace(/^ {2}/, ''))
}

describe('the dialect reads lettered and roman lists', () => {
  test('a./b. items form one list; an indented i./ii. list nests inside an item', () => {
    const source = 'Three kinds of failure:\na. decoded\nb. understood\n   i. nobody asked\n   ii. no words yet\nc. trusted'
    expect(outline(source)).toEqual([
      'Paragraph',
      'FancyList',
      '  ListItem',
      '    ListMark a.',
      '    Paragraph',
      '  ListItem',
      '    ListMark b.',
      '    Paragraph',
      '    FancyList',
      '      ListItem',
      '        ListMark i.',
      '        Paragraph',
      '      ListItem',
      '        ListMark ii.',
      '        Paragraph',
      '  ListItem',
      '    ListMark c.',
      '    Paragraph',
    ])
  })

  test('the file keeps exactly what was typed; the model reads the style and start', () => {
    const doc = readDocument('A)  first\nB)  second\n\nc. third\nd. fourth\n\niv. four\nv. five')
    const lists = doc.blocks.filter((block) => block.kind === 'list')
    expect(lists.map((list) => list.kind === 'list' && [list.ordered, list.start, list.lettering])).toEqual([
      [true, 1, { numbering: 'upper-alpha', delimiter: ')' }],
      [true, 3, { numbering: 'lower-alpha', delimiter: '.' }],
      [true, 4, { numbering: 'lower-roman', delimiter: '.' }],
    ])
  })

  test('z. continues with aa. inside a lettered list; a loose list survives its blank lines', () => {
    expect(outline('y. one\nz. two\naa. three').filter((line) => line.includes('ListMark'))).toEqual([
      '    ListMark y.', '    ListMark z.', '    ListMark aa.',
    ])
    const loose = readDocument('a. one\n\nb. two\n\nc. three').blocks
    expect(loose).toHaveLength(1)
    expect(loose[0].kind === 'list' && loose[0].items).toHaveLength(3)
  })

  test('prose that begins "I. " is a paragraph, not a list — and so are initials mid-paragraph', () => {
    expect(outline('I. M. Pei designed the pyramid.')).toEqual(['Paragraph'])
    expect(outline('Written by\nA. Smith and\nB. Jones.')).toEqual(['Paragraph'])
    expect(outline('aa. is not a list opener')).toEqual(['Paragraph'])
  })

  test('a list interrupts a paragraph only when it opens on a, A, i or I', () => {
    expect(outline('Three kinds:\na. one')).toEqual(['Paragraph', 'FancyList', '  ListItem', '    ListMark a.', '    Paragraph'])
    expect(outline('Three kinds:\nc. one')).toEqual(['Paragraph'])
  })

  test('task boxes work after lettered markers; code fences stay code', () => {
    expect(outline('a. [x] done\nb. [ ] open')).toEqual([
      'FancyList', '  ListItem', '    ListMark a.', '    Task', '  ListItem', '    ListMark b.', '    Task',
    ])
    const tasks = readDocument('a. [x] done\nb. [ ] open').blocks[0]
    expect(tasks.kind === 'list' && tasks.items.map((item) => item.task)).toEqual(['done', 'todo'])
    expect(outline('```\na. not a list\n```')).toEqual(['FencedCode'])
  })

  test('numbered and lettered markers are different lists; numbered lists are unchanged', () => {
    expect(outline('1. one\na. two').filter((line) => !line.startsWith('    '))).toEqual([
      'OrderedList', '  ListItem', 'FancyList', '  ListItem',
    ])
    expect(outline('1. one\n2. two')).toEqual([
      'OrderedList', '  ListItem', '    ListMark 1.', '    Paragraph', '  ListItem', '    ListMark 2.', '    Paragraph',
    ])
  })
})
