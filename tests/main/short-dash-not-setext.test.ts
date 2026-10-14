import { expect, test } from 'bun:test'
import { readDocument } from '../../src/shared/markdown/model'
import { parseMarkdown } from '../../src/shared/markdown/dialect'

// Starting a list under a paragraph must never turn the paragraph into a heading. A lone `-` (or `--`)
// is a setext underline in CommonMark; in WriteFlex's dialect it is paragraph text, so the paragraph
// above keeps its rendering while the list is being typed. `---` and longer, and `=`, still underline.
const kinds = (source: string): string[] => readDocument(source).blocks.map((block) => block.kind)

test('a lone dash or two dashes under a paragraph leave the paragraph a paragraph', () => {
  for (const source of ['Intro line\n-', 'Intro line\n--', 'Intro line\n- ', 'Intro line\n-  \n', 'Line one\nline two\n-']) {
    expect(kinds(source)).toEqual(['paragraph'])
  }
})

test('typing a list under a paragraph keeps the paragraph at every keystroke', () => {
  for (const marker of ['-', '*', '+', '1.']) {
    for (const typed of [marker, `${marker} `, `${marker} i`, `${marker} item`]) {
      const blocks = readDocument(`Intro line\n${typed}`).blocks
      expect(blocks[0]?.kind).toBe('paragraph')
      expect(blocks.some((block) => block.kind === 'heading')).toBe(false)
    }
  }
  expect(kinds('Intro line\n- item')).toEqual(['paragraph', 'list'])
  expect(kinds('Intro line\n1. item')).toEqual(['paragraph', 'list'])
})

test('three or more dashes, and equals underlines, still make a heading', () => {
  expect(readDocument('Title\n---').blocks).toMatchObject([{ kind: 'heading', level: 2 }])
  expect(readDocument('Title\n-----').blocks).toMatchObject([{ kind: 'heading', level: 2 }])
  expect(readDocument('Title\n=').blocks).toMatchObject([{ kind: 'heading', level: 1 }])
  expect(readDocument('Title\n===').blocks).toMatchObject([{ kind: 'heading', level: 1 }])
  expect(kinds('Title\n\n---')).toEqual(['paragraph', 'rule'])
})

test('the dialect tree agrees (editor, outline and exports share it)', () => {
  const names = (source: string): string[] => { const out: string[] = []; parseMarkdown(source).iterate({ enter: (node) => { out.push(node.name) } }); return out }
  expect(names('Intro\n-')).not.toContain('SetextHeading2')
  expect(names('Intro\n---')).toContain('SetextHeading2')
})
