import { expect, test } from 'bun:test'
import { EditorSelection, EditorState } from '@codemirror/state'
import { closeBracketsKeymap, insertBracket } from '@codemirror/autocomplete'
import { baseExtensions } from '../../src/renderer/src/editor/setup'
import { insertMarkdownLinkFromClipboard, toggleBold, toggleItalic } from '../../src/renderer/src/editor/commands'
import { concealedMarkupRanges, type EditorViewMode } from '../../src/renderer/src/editor/view-mode'
import { setWriterMode } from '../../src/renderer/src/editor/writer-review'

function state(doc: string, anchor: number, head = anchor, viewMode: EditorViewMode = 'clean'): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: baseExtensions({ onDocChanged: () => {}, initialViewMode: viewMode }),
  })
}

function typeBracket(current: EditorState, bracket: string): EditorState {
  const transaction = insertBracket(current, bracket)
  return transaction ? transaction.state : current.update({ changes: { from: current.selection.main.from, to: current.selection.main.to, insert: bracket }, selection: { anchor: current.selection.main.from + bracket.length } }).state
}

test('closeBrackets uses the WriteFlex Markdown pair configuration', () => {
  const config = state('', 0).languageDataAt('closeBrackets', 0)[0]
  expect(config).toEqual({ brackets: ['(', '[', '{', "'", '"', '`'] })
})

test('closeBrackets wraps a selection and keeps the inner text selected', () => {
  const next = typeBracket(state('alpha', 0, 5), '(')
  expect(next.doc.toString()).toBe('(alpha)')
  expect(next.sliceDoc(next.selection.main.from, next.selection.main.to)).toBe('alpha')
})

test('formatting preserves the document and resulting selection in Reviewing mode across Clean, Markup, and Raw', () => {
  const commands = [
    { name: 'bold', command: toggleBold, formatted: 'alpha **bravo** charlie', wrapped: 'alpha (**bravo**) charlie' },
    { name: 'italic', command: toggleItalic, formatted: 'alpha *bravo* charlie', wrapped: 'alpha (*bravo*) charlie' },
    { name: 'link', command: insertMarkdownLinkFromClipboard('not a url'), formatted: 'alpha [bravo]() charlie', wrapped: 'alpha [bravo](()) charlie' },
  ] as const

  for (const viewMode of ['clean', 'markup', 'raw'] as const) {
    for (const { name, command, formatted, wrapped } of commands) {
      let current = state('alpha bravo charlie', 6, 11, viewMode)
      current = current.update({ effects: setWriterMode.of('reviewing') }).state
      expect(command({ state: current, dispatch: (transaction) => { current = transaction.state } }), `${viewMode} ${name}`).toBe(true)
      expect(current.doc.toString(), `${viewMode} ${name}`).toBe(formatted)
      const expectedSelection = name === 'link'
        ? { from: formatted.indexOf(')'), to: formatted.indexOf(')'), text: '' }
        : { from: 6, to: formatted.indexOf(' charlie'), text: formatted.slice(6, formatted.indexOf(' charlie')) }
      expect(
        {
          from: current.selection.main.from,
          to: current.selection.main.to,
          text: current.sliceDoc(current.selection.main.from, current.selection.main.to),
        },
        `${viewMode} ${name} resulting selection`,
      ).toEqual(expectedSelection)
      expect(concealedMarkupRanges(current), `${viewMode} ${name} selected element is revealed`).toEqual([])
      current = typeBracket(current, '(')
      expect(current.doc.toString(), `${viewMode} ${name} + parenthesis`).toBe(wrapped)
    }
  }
})

test('closeBrackets inserts, steps through the generated closer, and Backspace removes a fresh pair', () => {
  const opened = typeBracket(state('', 0), '"')
  expect(opened.doc.toString()).toBe('""')
  expect(opened.selection.main.head).toBe(1)
  const stepped = typeBracket(opened, '"')
  expect(stepped.doc.toString()).toBe('""')
  expect(stepped.selection.main.head).toBe(2)

  let paired = typeBracket(state('', 0), '(')
  const backspace = closeBracketsKeymap.find((binding) => binding.key === 'Backspace')?.run
  expect(backspace).toBeFunction()
  expect(backspace!({ state: paired, dispatch: (transaction) => { paired = transaction.state } })).toBe(true)
  expect(paired.doc.toString()).toBe('')
})

test("apostrophes inside and at the end of words type naturally; a quote after punctuation can open", () => {
  expect(typeBracket(state('don', 3), "'").doc.toString()).toBe("don'")
  expect(typeBracket(state('writers', 7), "'").doc.toString()).toBe("writers'")
  expect(typeBracket(state('Sentence.', 9), "'").doc.toString()).toBe("Sentence.''")
})
