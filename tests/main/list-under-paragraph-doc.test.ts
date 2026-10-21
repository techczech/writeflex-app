import { expect, test } from 'bun:test'
import { parseMarkdown } from '../../src/shared/markdown/dialect'
import { readDocument } from '../../src/shared/markdown/model'

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
