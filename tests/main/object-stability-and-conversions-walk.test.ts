import { describe, expect, test } from 'bun:test'
import { EditorSelection, EditorState, type StateCommand } from '@codemirror/state'
import { history } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { detectLivePreviewBlocks, livePreview, shouldProtectBackspaceAfterBlock } from '../../src/renderer/src/editor/live-preview'
import { registryCommand } from '../../src/renderer/src/commands/registry'
import { LAYOUTS } from '../../src/renderer/src/commands/actions-layout'

// The logic of tests/e2e/object-stability-and-conversions.spec.ts without Electron: the same documents,
// the same edits around a rendered object, the same conversion commands in the same order. Whether a
// widget is drawn (the e2e's toBeVisible) is the renderer's; here the object is still *found as a block*
// after every step, which is what drawing it depends on.
const objects = [
  { name: 'mermaid', source: '```mermaid\ngraph TD\n  A --> B\n```' },
  { name: 'markmap', source: '```markmap\n- Root\n  - Child\n```' },
  { name: 'table', source: '| A | B |\n| --- | --- |\n| 1 | 2 |' },
  { name: 'code', source: '```ts\nconst value = 1\n```' },
  { name: 'image', source: '![River](https://example.com/river.png)' },
] as const

// The editor's own parser (the dialect), fully parsed, as the live editor has it after a moment.
const extensions = [markdown({ extensions: markdownDialect() }), history({ newGroupDelay: 0 }), livePreview({ assetBaseUrl: () => '' })]
const settle = (state: EditorState): EditorState => { ensureSyntaxTree(state, state.doc.length, 5_000); return state.update({}).state }
class Doc {
  #state: EditorState
  constructor(state: EditorState) { this.#state = settle(state) }
  get state(): EditorState { return this.#state }
  set state(next: EditorState) { this.#state = settle(next) }
}
const make = (doc: string, anchor = 0): Doc => new Doc(EditorState.create({ doc, selection: { anchor }, extensions }))
const text = (d: Doc): string => d.state.doc.toString()
const caretAtEnd = (d: Doc, line: string): void => { d.state = d.state.update({ selection: EditorSelection.cursor(text(d).indexOf(line) + line.length) }).state }
const backspace = (d: Doc): void => {
  const head = d.state.selection.main.head
  d.state = d.state.update({ changes: { from: head - 1, to: head }, selection: { anchor: head - 1 } }).state
}
const type = (d: Doc, value: string): void => {
  const head = d.state.selection.main.head
  d.state = d.state.update({ changes: { from: head, insert: value }, selection: { anchor: head + value.length } }).state
}

for (const object of objects) {
  describe(`${object.name} stays a block across adjacent edits, source-edge selection and protected Backspace`, () => {
    const doc = `Before paragraph.\n\n${object.source}\n\nAfter paragraph.`
    const found = (d: Doc) => detectLivePreviewBlocks(d.state).filter((block) => block.kind === (object.name === 'code' ? 'code' : object.name))

    test('the object is found, once, with its source', () => {
      const d = make(doc)
      expect(found(d)).toHaveLength(1)
      expect(found(d)[0].source.trim()).toBe(object.source)
    })

    test('Backspace and typing at the end of the paragraphs either side never disturb it', () => {
      const d = make(doc)
      for (const line of ['Before paragraph.', 'After paragraph.']) {
        caretAtEnd(d, line)
        backspace(d)
        expect(found(d), `after Backspace at the end of "${line}"`).toHaveLength(1)
        type(d, '.')
        expect(found(d), `after typing at the end of "${line}"`).toHaveLength(1)
      }
      expect(text(d)).toBe(doc) // the edits cancelled out
      expect(found(d)[0].source.trim()).toBe(object.source)
    })

    test('a caret on either source edge leaves the block found', () => {
      const from = doc.indexOf(object.source)
      for (const position of [from, from + object.source.length - 1]) {
        const d = make(doc, position)
        expect(found(d)).toHaveLength(1)
      }
    })

    test('Backspace just below the block is protected; inside the paragraph below it still works', () => {
      const d = make(doc)
      const [block] = found(d)
      const below = doc.indexOf(object.source) + object.source.length + 1
      expect(below).toBe(block.to)
      expect(shouldProtectBackspaceAfterBlock(detectLivePreviewBlocks(d.state), below)).toBe(true)
      expect(shouldProtectBackspaceAfterBlock(detectLivePreviewBlocks(d.state), below + 3)).toBe(false) // inside the paragraph below, Backspace works
    })
  })
}

describe('the conversion grammar', () => {
  const start = (doc: string, anchor: number, head = anchor): Doc => new Doc(EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions }))
  const run = (session: Doc, id: string): boolean => {
    const command = registryCommand(id)
    if (command.when && !command.when(session.state)) return false
    return (command.run as StateCommand)({ state: session.state, dispatch: (tr) => { session.state = tr.state } })
  }

  test('block menu and palette: flow diagram to code and back, then outline to mind map and back to the outline', () => {
    const outline = '- Root\n  - Child\n- Last'
    const doc = `# Conversions\n\n\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\`\n\n${outline}\n`
    const s = start(doc, doc.indexOf('graph TD'))
    expect(run(s, 'block.toCode')).toBe(true)
    expect(detectLivePreviewBlocks(s.state).map((block) => block.kind)).toEqual(['code'])

    s.state = s.state.update({ selection: EditorSelection.cursor(s.state.doc.toString().indexOf('graph TD')) }).state
    expect(run(s, 'block.toMermaid')).toBe(true)
    expect(detectLivePreviewBlocks(s.state).map((block) => block.kind)).toEqual(['mermaid'])

    s.state = s.state.update({ selection: EditorSelection.cursor(s.state.doc.toString().indexOf('Child')) }).state
    expect(run(s, 'outline.toMindMap')).toBe(true)
    expect(detectLivePreviewBlocks(s.state).map((block) => block.kind)).toEqual(['mermaid', 'markmap'])

    s.state = s.state.update({ selection: EditorSelection.cursor(s.state.doc.toString().indexOf('Child')) }).state
    expect(run(s, 'block.toText')).toBe(true)
    expect(s.state.doc.toString()).toContain(outline)
  })

  test('the drawn menus offer the same conversions by name', () => {
    const turnInto = (place: 'list-item' | 'code-block' | 'table'): string[] => {
      const opener = LAYOUTS[place].find((item) => item.kind === 'opener' && item.label === 'Turn into…')
      return opener && opener.kind === 'opener' ? opener.children.flatMap((kid) => (kid.kind === 'sep' ? [] : [kid.label])) : []
    }
    expect(turnInto('list-item')).toContain('Mind map')
    expect(turnInto('code-block')).toEqual(expect.arrayContaining(['Text', 'Flow diagram', 'Mind map', 'Table']))
    expect(turnInto('table')).toEqual(['Text', 'Code block'])
  })

  test('mixed selected outlines and heading sections become mind maps and round-trip byte-identically', () => {
    const selected = '## One\nLead-in prose.\n- **Definition:** Working memory\n  1. Nested item'
    const section = '## Five\n- First\n  - Detail\nClosing prose.'
    const doc = `# Outline\n\n${selected}\n\n${section}\n\n## Six\nAfter\n`

    const s = start(doc, doc.indexOf('## One') + 3, doc.indexOf('## One') + selected.length - 3)
    expect(run(s, 'outline.toMindMap')).toBe(true)
    expect(detectLivePreviewBlocks(s.state).map((block) => block.kind)).toEqual(['markmap'])
    s.state = s.state.update({ selection: EditorSelection.cursor(s.state.doc.toString().indexOf('Lead-in')) }).state
    expect(run(s, 'block.toText')).toBe(true)
    expect(s.state.doc.toString()).toBe(doc)

    // A caret on a heading converts the whole section up to the next heading of its level.
    const h = start(doc, doc.indexOf('## Five') + 3)
    expect(run(h, 'outline.toMindMap')).toBe(true)
    expect(detectLivePreviewBlocks(h.state).map((block) => block.kind)).toEqual(['markmap'])
    h.state = h.state.update({ selection: EditorSelection.cursor(h.state.doc.toString().indexOf('First')) }).state
    expect(run(h, 'block.toText')).toBe(true)
    expect(h.state.doc.toString()).toBe(doc)
  })
})
