import { expect, spyOn, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import {
  approvableObjectProposal,
  categoryClassForInlineChange,
  diffInlineChangeText,
  inlineChangeOverlapsFrontmatter,
  inlineChangeRanges,
  inlineChangesField,
  inlineChanges,
  inlineObjectProposals,
  setInlineChanges,
} from '../../src/renderer/src/editor/inline-changes'
import { setWriterMode, writerReviewing } from '../../src/renderer/src/editor/writer-review'
import { inlineChangeForPendingAgentChange } from '../../src/renderer/src/components/EditorPane'
import type { Change } from '../../src/preload'

test.each(['accept', 'reject', 'revise'] as const)('inline %s gives keyboard focus to the intended destination', (action) => {
  const calls: string[] = []
  const handlers = spyOn(EditorView, 'domEventHandlers')
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
  class FakeElement {
    dataset = { cid: 'c1', act: action }
    closest() { return this }
  }
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: FakeElement })
  try {
    inlineChanges(() => (id, act) => calls.push(`${id}:${act}`), () => () => {})
    const mousedown = handlers.mock.calls[0][0].mousedown!
    const view = { focus: () => calls.push('focus') } as unknown as EditorView
    const event = {
      target: new FakeElement(),
      preventDefault: () => calls.push('preventDefault'),
    } as unknown as MouseEvent

    expect(mousedown.call(view, event, view)).toBe(true)
    expect(calls).toEqual(action === 'revise'
      ? ['preventDefault', 'c1:revise']
      : ['preventDefault', 'focus', `c1:${action}`])
  } finally {
    handlers.mockRestore()
    if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement)
    else Reflect.deleteProperty(globalThis, 'HTMLElement')
  }
})

function change(over: Partial<Change>): Change {
  return {
    id: 'c1',
    path: 'draft.md',
    ts: 0,
    provenance: 'agent',
    editClass: 'copy',
    category: null,
    summary: 's',
    oldText: '',
    newText: '',
    status: 'pending',
    isCorrection: false,
    ...over,
  }
}

function decorationCount(state: EditorState): number {
  const view = { state } as EditorView
  return state.facet(EditorView.decorations).reduce((count, layer) => {
    const decorations = typeof layer === 'function' ? layer(view) : layer as DecorationSet
    return count + decorations.size
  }, 0)
}

const TABLE = '| A | B |\n| --- | --- |\n| 1 | 2 |\n'

test('a prose proposal draws nothing in the text in Drafting or Reviewing (ticket 13); its place is still known', () => {
  let state = EditorState.create({
    doc: 'The old draft.',
    extensions: [writerReviewing({ initialMode: 'drafting' }), inlineChangesField],
  })
  state = state.update({
    effects: setInlineChanges.of([
      { kind: 'text', id: 'c1', from: 4, to: 7, oldText: 'old', newText: 'new', category: 'wording', selected: false },
      { kind: 'text', id: 'c2', from: 14, to: 14, oldText: '', newText: ' More.', category: 'wording', selected: true },
      { kind: 'move', id: 'c3', from: 0, to: 3, oldText: 'The', newText: 'The', category: 'structure', selected: false, destination: 14 },
    ]),
  }).state
  expect(decorationCount(state)).toBe(0)
  // The keymap, live preview and the "could not be placed" flag still read where each proposal sits.
  expect(inlineChangeRanges(state)).toEqual([{ from: 4, to: 7 }, { from: 14, to: 14 }, { from: 0, to: 3 }])

  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  expect(decorationCount(state)).toBe(0)
})

test('an agent\'s proposed object is still staged over its render, in both modes (ADR-0024)', () => {
  let state = EditorState.create({
    doc: 'Intro.\n',
    extensions: [writerReviewing({ initialMode: 'drafting' }), inlineChangesField],
  })
  state = state.update({
    effects: setInlineChanges.of([{ kind: 'text', id: 't1', from: 7, to: 7, oldText: '', newText: TABLE, category: 'structure', selected: false }]),
  }).state
  expect(decorationCount(state)).toBe(1)
  state = state.update({ effects: setWriterMode.of('reviewing') }).state
  expect(decorationCount(state)).toBe(1)
})

test('inlineObjectProposals keeps only point insertions that are one complete object', () => {
  const doc = 'Intro.\n'
  const found = inlineObjectProposals(doc, [
    { kind: 'text', id: 'obj', from: 7, to: 7, oldText: '', newText: TABLE, category: null, selected: false },
    { kind: 'text', id: 'prose', from: 7, to: 7, oldText: '', newText: 'More words.', category: null, selected: false },
    { kind: 'text', id: 'replace', from: 0, to: 5, oldText: 'Intro', newText: TABLE, category: null, selected: false },
  ])
  expect(found.map(({ change, block }) => [change.id, block.kind])).toEqual([['obj', 'table']])
})

test('categoryClassForInlineChange maps writer-facing categories to mockup classes', () => {
  expect(categoryClassForInlineChange('typo')).toBe('cat-typo')
  expect(categoryClassForInlineChange('grammar')).toBe('cat-grammar')
  expect(categoryClassForInlineChange('wording')).toBe('cat-wording')
  expect(categoryClassForInlineChange('structure')).toBe('cat-structure')
})

test('categoryClassForInlineChange reuses stable tints for secondary categories', () => {
  expect(categoryClassForInlineChange('clarity')).toBe('cat-wording')
  expect(categoryClassForInlineChange('tone')).toBe('cat-wording')
  expect(categoryClassForInlineChange('other')).toBe('cat-typo')
  expect(categoryClassForInlineChange(null)).toBe('cat-typo')
})

test('approvableObjectProposal recognises one complete approvable object and preserves its kind', () => {
  const proposals = [
    ['query', '```query\nstatus: editing\n```'],
    ['table', '| Title | Status |\n| --- | --- |\n| Draft | editing |'],
    ['mermaid', '```mermaid\nflowchart LR\n  A --> B\n```\n'],
    ['markmap', '```markmap\n- Root\n  - Child\n```\n'],
  ] as const

  for (const [kind, source] of proposals) {
    expect(approvableObjectProposal(source)).toMatchObject({ kind, from: 0, to: source.length, source })
  }
})

test('approvableObjectProposal rejects prose, ordinary code, partial fences and multiple blocks', () => {
  expect(approvableObjectProposal('A plain paragraph.')).toBeNull()
  expect(approvableObjectProposal('```ts\nconst answer = 42\n```\n')).toBeNull()
  expect(approvableObjectProposal('```query\nstatus: editing')).toBeNull()
  expect(approvableObjectProposal('```query\nstatus: editing\n```\n\n```markmap\n- Root\n```\n')).toBeNull()
  expect(approvableObjectProposal('\n```query\nstatus: editing\n```\n')).toBeNull()
})

test('diffInlineChangeText marks only a prepended heading and leaves the paragraph plain', () => {
  const paragraph = 'The first thing I wanted to say stays here.'
  expect(diffInlineChangeText(paragraph, `## Opening\n\n${paragraph}`)).toEqual({
    prefix: '',
    oldMiddle: '',
    newMiddle: '## Opening\n\n',
    suffix: paragraph,
  })
})

test('diffInlineChangeText strips shared leading words at word boundaries', () => {
  expect(diffInlineChangeText('The first thing ran', 'The first thing crossed')).toEqual({
    prefix: 'The first thing ',
    oldMiddle: 'ran',
    newMiddle: 'crossed',
    suffix: '',
  })
})

test('diffInlineChangeText strips shared trailing words at word boundaries', () => {
  expect(diffInlineChangeText('sat on mat by the door', 'sat on the mat by the door')).toEqual({
    prefix: 'sat on ',
    oldMiddle: '',
    newMiddle: 'the ',
    suffix: 'mat by the door',
  })
})

test('diffInlineChangeText does not split inside a word', () => {
  expect(diffInlineChangeText('running', 'ran')).toEqual({
    prefix: '',
    oldMiddle: 'running',
    newMiddle: 'ran',
    suffix: '',
  })
})

test('diffInlineChangeText keeps pure word swaps as a whole strike and insert', () => {
  expect(diffInlineChangeText('ordinary', 'unremarkable')).toEqual({
    prefix: '',
    oldMiddle: 'ordinary',
    newMiddle: 'unremarkable',
    suffix: '',
  })
})

test('a whole-document metadata proposal is not rendered as a multiline inline replacement', () => {
  const doc = '---\ntitle: Sample\n"another one": original\n---\n\n'
  expect(inlineChangeOverlapsFrontmatter(doc, { from: 0, to: doc.length })).toBe(true)
  expect(inlineChangeOverlapsFrontmatter(doc, { from: doc.length, to: doc.length })).toBe(false)
})

test('a document that merely OPENS on a thematic break has no frontmatter to overlap', () => {
  // The guard used to read any leading `---` … `---` pair as frontmatter, so an edit to the first
  // paragraph of a piece that opens on a rule was refused a prose rendering (finding 4's bug class).
  const doc = '---\n\nSome real prose paragraph.\n\n---\n\nMore.\n'
  expect(inlineChangeOverlapsFrontmatter(doc, { from: 0, to: doc.length })).toBe(false)
  expect(inlineChangeOverlapsFrontmatter(doc, { from: 5, to: 10 })).toBe(false)
})

test('inlineChangeForPendingAgentChange resolves move source by text and destination by moveTo', () => {
  const doc = '# Draft\n\nFirst paragraph.\n\nSecond paragraph to move.\n\nThird paragraph stays.\n'
  const moved = 'Second paragraph to move.'
  const destination = doc.indexOf('Third paragraph stays.') + 'Third paragraph stays.'.length

  expect(
    inlineChangeForPendingAgentChange(
      doc,
      change({
        id: 'move-1',
        editClass: 'move',
        category: 'structure',
        oldText: moved,
        newText: moved,
        moveFrom: { from: doc.indexOf(moved), to: doc.indexOf(moved) + moved.length },
        moveTo: { from: destination, to: destination },
      }),
      'move-1',
    ),
  ).toEqual({
    kind: 'move',
    id: 'move-1',
    from: doc.indexOf(moved),
    to: doc.indexOf(moved) + moved.length,
    oldText: moved,
    newText: moved,
    category: 'structure',
    selected: true,
    destination,
  })
})

test('inlineChangeForPendingAgentChange rebases a live move destination from its current insertAfter anchor', () => {
  const moved = 'Move me.'
  const firstAnchor = 'Anchor one.'
  const secondAnchor = 'Anchor two.'
  const original = `# Draft\n\n${moved}\n\n${firstAnchor}\n\n${secondAnchor}\n`
  const current = `# Draft\n\n${firstAnchor}\n\n${secondAnchor}\n\n${moved}\n`
  const staleDestination = original.indexOf(firstAnchor) + firstAnchor.length
  const currentDestination = current.indexOf(firstAnchor) + firstAnchor.length

  expect(
    inlineChangeForPendingAgentChange(
      current,
      change({
        id: 'move-1',
        editClass: 'move',
        category: 'structure',
        summary: 'Move after the first anchor.',
        oldText: moved,
        newText: moved,
        moveFrom: { from: original.indexOf(moved), to: original.indexOf(moved) + moved.length },
        moveTo: { from: staleDestination, to: staleDestination },
      }),
      null,
      { path: 'draft.md', text: moved, insertAfter: firstAnchor, summary: 'Move after the first anchor.' },
    ),
  ).toMatchObject({
    kind: 'move',
    from: current.indexOf(moved),
    to: current.indexOf(moved) + moved.length,
    destination: currentDestination,
  })
  expect(currentDestination).not.toBe(staleDestination)
})

test('inlineChangeForPendingAgentChange re-derives a rebased move against the post-accept document', () => {
  const doc = '# Draft\n\nAnchor one.\n\nAnchor two.\n\nMove me.\n'
  const moved = 'Move me.'

  expect(
    inlineChangeForPendingAgentChange(
      doc,
      change({
        id: 'remaining-move',
        editClass: 'move',
        category: 'structure',
        oldText: moved,
        newText: moved,
        moveFrom: { from: 35, to: 43 },
        moveTo: { from: 20, to: 20 },
        anchor: { from: 9, to: 20 },
      }),
      null,
      { path: 'draft.md', text: moved, insertAfter: 'Anchor one.', summary: 'Move after the first anchor.' },
    ),
  ).toMatchObject({
    kind: 'move',
    from: 35,
    to: 43,
    destination: 20,
  })
})

test('inlineChangeForPendingAgentChange renders a superseded move from its host-rebased recorded coordinates', () => {
  const moved = 'Move me.'
  const firstAnchor = 'Anchor one.'
  const secondAnchor = 'Anchor two.'
  const current = `# Draft\n\n${firstAnchor}\n\n${secondAnchor}\n\n${moved}\n`

  const rendered = inlineChangeForPendingAgentChange(
    current,
    change({
      id: 'move-superseded',
      editClass: 'move',
      category: 'structure',
      oldText: moved,
      newText: moved,
      moveFrom: { from: current.indexOf(moved), to: current.indexOf(moved) + moved.length },
      moveTo: { from: current.indexOf(firstAnchor) + firstAnchor.length, to: current.indexOf(firstAnchor) + firstAnchor.length },
    }),
    null,
  )

  expect(rendered).toMatchObject({
    kind: 'move',
    from: current.indexOf(moved),
    to: current.indexOf(moved) + moved.length,
    destination: current.indexOf(firstAnchor) + firstAnchor.length,
  })
})

test('inlineChangeForPendingAgentChange skips unresolved move endpoints gracefully', () => {
  const doc = 'One\n\nTwo\n'
  expect(
    inlineChangeForPendingAgentChange(
      doc,
      change({
        editClass: 'move',
        category: 'structure',
        oldText: 'Missing paragraph.',
        newText: 'Missing paragraph.',
        moveTo: { from: 4, to: 4 },
      }),
      null,
    ),
  ).toBeNull()

  expect(
    inlineChangeForPendingAgentChange(
      doc,
      change({
        editClass: 'move',
        category: 'structure',
        oldText: 'One',
        newText: 'One',
        moveTo: { from: 99, to: 99 },
      }),
      null,
    ),
  ).toBeNull()
})
