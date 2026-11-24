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

// The logic of tests/e2e/list-under-paragraph.spec.ts without Electron: the e2e's own document, with each list
// marker typed under "Intro paragraph" one keystroke at a time. The paragraph above must stay a paragraph in
// the editor's tree at every step (the e2e measured its font weight and heading class; both follow from
// the node name here). The rule itself is also pinned in short-dash-not-setext.test.ts.
const DOC = 'Reference paragraph\n\nIntro paragraph\n'

const nodes = (source: string): string[] => { const out: string[] = []; parseMarkdown(source).iterate({ enter: (node) => { out.push(node.name) } }); return out }

for (const marker of ['-', '*', '+', '1.']) {
  test(`typing "${marker} item" under a paragraph never changes the paragraph above`, () => {
    const referenceKinds = readDocument(DOC).blocks.map((block) => block.kind)
    expect(referenceKinds).toEqual(['paragraph', 'paragraph'])
    let typedSoFar = ''
    for (const typed of [marker, ' ', 'i', 'tem']) {
      typedSoFar += typed
      const source = `${DOC}${typedSoFar}`
      const blocks = readDocument(source).blocks
      expect(blocks[0].kind, `after "${typedSoFar}"`).toBe('paragraph')
      expect(blocks[1].kind, `after "${typedSoFar}"`).toBe('paragraph') // "Intro paragraph" keeps its look
      expect(nodes(source).some((name) => /Heading/.test(name)), `after "${typedSoFar}"`).toBe(false)
    }
    expect(readDocument(`${DOC}${marker} item`).blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph', 'list'])
  })
}
