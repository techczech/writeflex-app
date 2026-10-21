import { expect, test } from 'bun:test'
import { EditorState, Text } from '@codemirror/state'
import type { Change } from '../../src/preload'
import { paragraphKey, paragraphKeyAt, updateMovesCards } from '../../src/renderer/src/app/margin-geometry'
import { buildMarginModels, makeAnchorResolver } from '../../src/renderer/src/app/margin-model'
import { marginPerf, resetMarginPerf } from '../../src/renderer/src/app/margin-perf'

// 0.24 ticket 16: the margin resolves changes once per document revision, reads no whole-document text per keystroke,
// and knows which editor updates can move a card.

const DOC = Array.from({ length: 40 }, (_, i) => `Line ${i} has words to find.${i % 5 === 4 ? '\n' : ''}`).join('\n')
const change = (id: string, oldText: string, over: Partial<Change> = {}): Change => ({
  id, path: 'draft.md', ts: 1, provenance: 'agent', editClass: 'content', category: 'wording', summary: id,
  oldText, newText: `${oldText}!`, status: 'pending', isCorrection: false, ...over,
})
const changes = Array.from({ length: 30 }, (_, i) => change(`c${i}`, `Line ${i} has words`))

test('one model build resolves each change once, and the unfiltered facts come from the same resolution', () => {
  resetMarginPerf()
  const resolver = makeAnchorResolver(DOC)
  const { model, unfiltered } = buildMarginModels({ changes, document: DOC, view: 'margin', resolver, filter: { kinds: new Set(['note']) } })
  expect(marginPerf.builds).toBe(1)
  expect(marginPerf.resolves).toBe(30)
  expect(model.cards).toHaveLength(0)
  expect(unfiltered.cards).toHaveLength(30)
  // Asking again for the same text (a selection moved) resolves nothing more.
  buildMarginModels({ changes, document: DOC, view: 'margin', resolver, selectedId: 'c3' })
  expect(marginPerf.resolves).toBe(30)
  expect(marginPerf.builds).toBe(2)
})

test('with no filter and no mode the model is the unfiltered result', () => {
  const { model, unfiltered } = buildMarginModels({ changes, document: DOC, view: 'margin' })
  expect(unfiltered).toBe(model)
})

test('a resolver made for other text is not used', () => {
  resetMarginPerf()
  buildMarginModels({ changes, document: DOC, view: 'margin', resolver: makeAnchorResolver('something else') })
  expect(marginPerf.resolves).toBe(30)
})

test('paragraphKeyAt agrees with paragraphKey on the whole text for every position', () => {
  const samples = ['', '\n', '\n\n', '\n\n\nabc', 'a\n\nb\n\n\nc\n', 'one\ntwo\n\nthree', DOC, 'x\n\n']
  for (const text of samples) {
    const doc = Text.of(text.split('\n'))
    for (let pos = 0; pos <= text.length + 1; pos += 1) expect([text, pos, paragraphKeyAt(doc, pos)]).toEqual([text, pos, paragraphKey(text, pos)])
  }
})

function update(text: string, from: number, to: number, insert: string) {
  const start = EditorState.create({ doc: text })
  const tr = start.update({ changes: { from, to, insert } })
  return { docChanged: true, viewportMoved: false, heightChanged: false, changes: tr.changes, startState: start, state: tr.state }
}

test('a character typed in a line with no passage moves nothing; in a passage line, a new line or new geometry, it may', () => {
  const at = (needle: string): number => DOC.indexOf(needle)
  const positions = [at('Line 3 has')]
  // A character typed on line 30, far from the passage.
  expect(updateMovesCards(update(DOC, at('Line 30'), at('Line 30'), 'x'), positions)).toBe(false)
  // A character typed in the passage's own line may wrap it differently.
  expect(updateMovesCards(update(DOC, at('Line 3 has') + 5, at('Line 3 has') + 5, 'x'), positions)).toBe(true)
  // A new line moves everything below.
  expect(updateMovesCards(update(DOC, at('Line 30'), at('Line 30'), '\n'), positions)).toBe(true)
  // A measured height change, or a new viewport.
  expect(updateMovesCards({ ...update(DOC, 0, 0, 'x'), heightChanged: true }, [])).toBe(true)
  expect(updateMovesCards({ ...update(DOC, 0, 0, 'x'), viewportMoved: true }, [])).toBe(true)
  // A selection-only update moves nothing.
  expect(updateMovesCards({ ...update(DOC, 0, 0, 'x'), docChanged: false }, positions)).toBe(false)
})
