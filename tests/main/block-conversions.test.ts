import { describe, expect, test } from 'bun:test'
import {
  codeObjectConversion,
  objectToCode,
  objectToText,
  outlineToMindMap,
} from '../../src/renderer/src/editor/block-conversions'
import type { LivePreviewBlock } from '../../src/renderer/src/editor/live-preview'
import { EditorState } from '@codemirror/state'
import { history, undo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { GFM } from '@lezer/markdown'
import { livePreview } from '../../src/renderer/src/editor/live-preview'
import { convertBlockToText, convertOutlineToMindMap } from '../../src/renderer/src/editor/commands'

const block = (kind: LivePreviewBlock['kind'], source: string, language?: string): LivePreviewBlock => ({
  kind,
  from: 5,
  to: 5 + source.length,
  source,
  ...(language !== undefined ? { language } : {}),
})

describe('block conversion grammar', () => {
  test('objects become their inner source as plain text in one replacement', () => {
    expect(objectToText(block('mermaid', '```mermaid\ngraph TD\n  A --> B\n```\n', 'mermaid')))
      .toBe('graph TD\n  A --> B\n')
    expect(objectToText(block('table', '| A | B |\n| --- | --- |\n')))
      .toBe('| A | B |\n| --- | --- |\n')
    expect(objectToText(block('image', '![River](assets/river.png)\n')))
      .toBe('![River](assets/river.png)\n')
  })

  test('objects become plain fenced code with a round-trippable language tag', () => {
    expect(objectToCode(block('mermaid', '```mermaid\ngraph TD\n  A --> B\n```\n', 'mermaid')))
      .toBe('```mermaid code\ngraph TD\n  A --> B\n```\n')
    expect(objectToCode(block('markmap', '```markmap\n- Root\n```', 'markmap')))
      .toBe('```markmap code\n- Root\n```')
    expect(objectToCode(block('table', '| A |\n| --- |\n')))
      .toBe('```markdown\n| A |\n| --- |\n```\n')
  })

  test('code becomes an object by language tag first, then structural parseability', () => {
    expect(codeObjectConversion(block('code', '```mermaid code\ngraph TD\n  A --> B\n```\n', 'mermaid'))).toEqual({
      kind: 'mermaid',
      label: 'Convert to flow diagram object',
      replacement: '```mermaid\ngraph TD\n  A --> B\n```\n',
    })
    expect(codeObjectConversion(block('code', '```\n- Root\n  - Child\n```', ''))?.kind).toBe('markmap')
    expect(codeObjectConversion(block('code', '```markdown\n| A | B |\n| --- | --- |\n```', 'markdown'))?.kind).toBe('table')
    expect(codeObjectConversion(block('code', '```ts\nconst value = 1\n```', 'ts'))).toBeNull()
  })

  test('a bullet-list outline round-trips through mind map back to byte-identical text', () => {
    const doc = 'Before\n\n- Root\n  - Child\n- Last\n\nAfter'
    const conversion = outlineToMindMap(doc, doc.indexOf('Child'))
    expect(conversion).toEqual({
      from: doc.indexOf('- Root'),
      to: doc.indexOf('\n\nAfter'),
      replacement: '```markmap\n- Root\n  - Child\n- Last\n```',
    })
    expect(objectToText(block('markmap', conversion!.replacement, 'markmap')))
      .toBe('- Root\n  - Child\n- Last')
  })

  test('a non-empty selection snaps to whole lines and accepts any outline-shaped Markdown verbatim', () => {
    const doc = 'Before\n## One\nLead-in prose.\n- **Definition:** Working memory\n  1. Nested item\n## Five\nAfter'
    const from = doc.indexOf('One')
    const to = doc.indexOf('Nested') + 'Nested'.length
    const source = '## One\nLead-in prose.\n- **Definition:** Working memory\n  1. Nested item'
    const conversion = outlineToMindMap(doc, from, to)
    expect(conversion).toEqual({
      from: doc.indexOf('## One'),
      to: doc.indexOf('\n## Five'),
      replacement: `\`\`\`markmap\n${source}\n\`\`\``,
    })
    expect(objectToText(block('markmap', conversion!.replacement, 'markmap'))).toBe(source)
  })

  test('a non-empty selection without a heading or list marker is unavailable', () => {
    const doc = 'Before\nPlain paragraph only.\nAfter'
    expect(outlineToMindMap(doc, doc.indexOf('Plain'), doc.indexOf('only') + 4)).toBeNull()
  })

  test('a caret on a heading converts its whole section up to the next same-or-higher heading', () => {
    const doc = '# Start\nIntro\n## One\n- Child\n### Detail\nText\n## Two\nLater\n# End'
    const source = '## One\n- Child\n### Detail\nText'
    const conversion = outlineToMindMap(doc, doc.indexOf('One'))
    expect(conversion).toEqual({
      from: doc.indexOf('## One'),
      to: doc.indexOf('\n## Two'),
      replacement: `\`\`\`markmap\n${source}\n\`\`\``,
    })
    expect(objectToText(block('markmap', conversion!.replacement, 'markmap'))).toBe(source)
  })

  test('a caret in numbered and task lists converts the whole adjacent list', () => {
    for (const source of ['1. One\n   1. Child\n2. Two', '- [ ] One\n  - [x] Child']) {
      const doc = `Before\n\n${source}\n\nAfter`
      expect(outlineToMindMap(doc, doc.indexOf('Child'))?.replacement).toBe(`\`\`\`markmap\n${source}\n\`\`\``)
    }
  })

  test('conversion commands dispatch one undoable editor transaction', () => {
    const source = 'Before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter'
    let state = EditorState.create({
      doc: source,
      selection: { anchor: source.indexOf('```mermaid') },
      extensions: [markdown({ extensions: [GFM] }), history(), livePreview({ assetBaseUrl: () => '' })],
    })
    expect(convertBlockToText({ state, dispatch: (tr) => { state = tr.state } } as never)).toBe(true)
    expect(state.doc.toString()).toBe('Before\n\ngraph TD\n  A --> B\n\nAfter')
    expect(undo({ state, dispatch: (tr) => { state = tr.state } })).toBe(true)
    expect(state.doc.toString()).toBe(source)
  })

  test('the outline command is available from a caret inside the list', () => {
    const source = 'Before\n\n- Root\n  - Child\n\nAfter'
    let state = EditorState.create({ doc: source, selection: { anchor: source.indexOf('Child') }, extensions: [history()] })
    expect(convertOutlineToMindMap({ state, dispatch: (tr) => { state = tr.state } } as never)).toBe(true)
    expect(state.doc.toString()).toContain('```markmap\n- Root\n  - Child\n```')
  })
})
