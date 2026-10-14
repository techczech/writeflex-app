import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { changeMarking, changeMarkRanges, setChangeMarks } from '../../src/renderer/src/editor/change-marks'
import {
  blockJumpTarget,
  detectLivePreviewBlocks,
  headingJumpTarget,
  intersectsPendingChange,
  rendersBlockWithPendingChange,
  shouldProtectBackspaceAfterBlock,
  widgetKindForFenceLanguage,
} from '../../src/renderer/src/editor/live-preview'

const fixture = `# River

Prose before.

![Heron](assets/heron.jpg)

| Season | Flow |
| --- | --- |
| Summer | slow |

\`\`\`ts
const flow = 'fast'
\`\`\`

## End
`

function state(doc = fixture): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: [GFM] })] })
}

describe('live-preview block model', () => {
  test('only pending dock marks suppress rendered blocks', () => {
    let s = EditorState.create({ doc: fixture, extensions: [changeMarking] })
    s = s.update({
      effects: setChangeMarks.of({
        marks: [
          { id: 'accepted-object', from: 10, to: 20, pending: false },
          { id: 'pending-object', from: 30, to: 40, pending: true },
        ],
        selectedId: null,
      }),
    }).state

    expect(changeMarkRanges(s)).toEqual([{ from: 30, to: 40 }])
  })

  test('pending dock ranges map through edits strictly before the range', () => {
    let s = EditorState.create({ doc: fixture, extensions: [changeMarking] })
    s = s.update({
      effects: setChangeMarks.of({
        marks: [{ id: 'pending-object', from: 30, to: 40, pending: true }],
        selectedId: null,
      }),
    }).state
    s = s.update({ changes: { from: 0, insert: 'x' } }).state

    expect(changeMarkRanges(s)).toEqual([{ from: 31, to: 41 }])
  })

  test('maps object fence languages to their dedicated widget kinds', () => {
    expect(widgetKindForFenceLanguage('mermaid')).toBe('mermaid')
    expect(widgetKindForFenceLanguage('MARKMAP')).toBe('markmap')
    expect(widgetKindForFenceLanguage('query')).toBe('query')
    expect(widgetKindForFenceLanguage('SVG')).toBe('svg')
    expect(widgetKindForFenceLanguage('ts')).toBe('code')
  })
  test('detects query fences as first-class live-preview objects', () => {
    const source = '```query\nstatus: editing\nsort: date desc\n```\n'
    expect(detectLivePreviewBlocks(state(source))).toMatchObject([{ kind: 'query', language: 'query', source }])
  })
  test('an SVG language with the code marker remains a plain code block', () => {
    const source = '```svg code\n<svg><rect/></svg>\n```'
    expect(detectLivePreviewBlocks(state(source))).toMatchObject([{ kind: 'code', language: 'svg' }])
  })
  test('a diagram language with the code marker remains a plain code block', () => {
    const source = '```mermaid code\ngraph TD\n  A --> B\n```'
    expect(detectLivePreviewBlocks(state(source))).toMatchObject([{ kind: 'code', language: 'mermaid' }])
  })
  test('detects an exact image paragraph, GFM table, and fenced code without prose', () => {
    const s = state()
    const blocks = detectLivePreviewBlocks(s, 0, s.doc.length)
    expect(blocks.map((block) => block.kind)).toEqual(['image', 'table', 'code'])
    expect(blocks.map((block) => s.doc.sliceString(block.from, block.to))).toEqual([
      '![Heron](assets/heron.jpg)\n',
      '| Season | Flow |\n| --- | --- |\n| Summer | slow |\n',
      "```ts\nconst flow = 'fast'\n```\n",
    ])
  })

  test('detects only a closed document-leading frontmatter fence and spans both delimiters', () => {
    const source = '---\ntitle: River\ntags: [water, essay]\n---\n\nBody\n\n---\nthematic\n---\n'
    const blocks = detectLivePreviewBlocks(state(source), 0, source.length)
    expect(blocks.map((block) => block.kind)).toEqual(['frontmatter'])
    expect(source.slice(blocks[0].from, blocks[0].to)).toBe('---\ntitle: River\ntags: [water, essay]\n---\n')
    expect(detectLivePreviewBlocks(state('---\ntitle: never closed'), 0, 24)).toEqual([])
    expect(detectLivePreviewBlocks(state('Prose\n\n---\ntitle: not metadata\n---'), 0, 35).some((block) => block.kind === 'frontmatter')).toBe(false)
  })

  test('a block intersecting a pending change renders as source', () => {
    const block = detectLivePreviewBlocks(state(), 0, fixture.length)[1]
    expect(intersectsPendingChange(block, [{ from: block.from + 2, to: block.from + 8 }])).toBe(true)
    expect(intersectsPendingChange(block, [{ from: 0, to: 3 }])).toBe(false)
  })

  test('frontmatter alone keeps its form when a pending change intersects it', () => {
    expect(rendersBlockWithPendingChange('frontmatter')).toBe(true)
    expect(rendersBlockWithPendingChange('table')).toBe(false)
    expect(rendersBlockWithPendingChange('mermaid')).toBe(false)
  })

  test('block and heading jumps choose the next or previous target', () => {
    const s = state()
    const blocks = detectLivePreviewBlocks(s, 0, s.doc.length)
    expect(blockJumpTarget(blocks, blocks[0].from, 1)).toBe(blocks[1].from)
    expect(blockJumpTarget(blocks, blocks[2].from, -1)).toBe(blocks[1].from)
    expect(headingJumpTarget(s, 0, 1)).toBe(fixture.indexOf('## End'))
    expect(headingJumpTarget(s, fixture.indexOf('## End'), -1)).toBe(0)
  })

  test('atomic step list is the detected block ranges', () => {
    const blocks = detectLivePreviewBlocks(state(), 0, fixture.length)
    expect(blocks.map(({ from, to }) => [from, to])).toEqual([
      [fixture.indexOf('![Heron]'), fixture.indexOf('![Heron]') + '![Heron](assets/heron.jpg)\n'.length],
      [fixture.indexOf('| Season'), fixture.indexOf('| Season') + '| Season | Flow |\n| --- | --- |\n| Summer | slow |\n'.length],
      [fixture.indexOf('```ts'), fixture.indexOf('```ts') + "```ts\nconst flow = 'fast'\n```\n".length],
    ])
  })

  test('Backspace at the start of the line following a rendered block is protected', () => {
    const s = state()
    const blocks = detectLivePreviewBlocks(s)
    expect(shouldProtectBackspaceAfterBlock(blocks, blocks[0].to)).toBe(true)
    expect(shouldProtectBackspaceAfterBlock(blocks, blocks[0].to + 1)).toBe(false)
  })
})
