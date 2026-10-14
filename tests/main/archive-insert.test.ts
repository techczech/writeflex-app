import { expect, test } from 'bun:test'
import { markdown } from '@codemirror/lang-markdown'
import { history, undo } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { archiveLinkInsert, archiveLinkMarkdown, archiveQuoteBlock, archiveQuoteInsert, citationLineOf } from '../../src/renderer/src/editor/archive-insert'
import { markdownLinkAt } from '../../src/renderer/src/editor/markdown-link-open'

const LINK = 'writeflex://open?path=%2Farchive%2Fd%2Frepaved.md&line=36'
const LINE = `— Dominik Lukeš, *Repaved paths and generative metaphors: Expressing human purposes with technology*, 23 June 2016 · [archive](${LINK}) · [public](https://medium.com/p/x)`
const QUOTE = 'But being open to repaving once new paths are trodden is the most important thing.'
const CLI = `> ${QUOTE}\n\n${LINE}\n`
const BLOCK = `> ${QUOTE}\n\n${LINE}`

function at(doc: string, cursor: number): EditorState {
  return EditorState.create({ doc, selection: { anchor: cursor }, extensions: [history()] })
}

function apply(state: EditorState, spec: ReturnType<typeof archiveQuoteInsert>): EditorState {
  return state.update(spec).state
}

test('the block is the CLI citation verbatim; a widened quote keeps the CLI citation line', () => {
  expect(citationLineOf(CLI)).toBe(LINE)
  expect(archiveQuoteBlock(CLI, QUOTE, QUOTE)).toBe(BLOCK)
  expect(archiveQuoteBlock(CLI, QUOTE, `Before.\n${QUOTE} After.`)).toBe(`> Before.\n> ${QUOTE} After.\n\n${LINE}`)
})

test('after a written line the block takes its own lines and the caret lands on the empty line after it', () => {
  const doc = '# Talk\nAs I wrote in 2016:\nNext paragraph.'
  const state = apply(at(doc, doc.indexOf(':') - 3), archiveQuoteInsert(at(doc, doc.indexOf(':') - 3), BLOCK))
  expect(state.doc.toString()).toBe(`# Talk\nAs I wrote in 2016:\n${BLOCK}\n\nNext paragraph.`)
  const caret = state.doc.lineAt(state.selection.main.head)
  expect(caret.text).toBe('')
  expect(state.doc.line(caret.number - 1).text).toBe(LINE)
})

test('on an empty line the block takes that line; at the end of the draft a fresh empty line follows', () => {
  const doc = 'As I wrote in 2016:\n'
  const state = apply(at(doc, doc.length), archiveQuoteInsert(at(doc, doc.length), BLOCK))
  expect(state.doc.toString()).toBe(`As I wrote in 2016:\n${BLOCK}\n`)
  expect(state.selection.main.head).toBe(state.doc.length)
  const end = 'Last line'
  const appended = apply(at(end, 4), archiveQuoteInsert(at(end, 4), BLOCK))
  expect(appended.doc.toString()).toBe(`Last line\n${BLOCK}\n`)
  expect(appended.selection.main.head).toBe(appended.doc.length)
})

test('an empty line already after the caret line is reused, not doubled', () => {
  const doc = 'Intro.\n\nNext.'
  const state = apply(at(doc, 2), archiveQuoteInsert(at(doc, 2), BLOCK))
  expect(state.doc.toString()).toBe(`Intro.\n${BLOCK}\n\nNext.`)
  expect(state.doc.lineAt(state.selection.main.head).text).toBe('')
  expect(state.doc.lineAt(state.selection.main.head).number).toBe(5)
})

test('the insert never lands inside frontmatter', () => {
  const doc = '---\ntitle: Talk\n---\nBody.'
  const state = apply(at(doc, 5), archiveQuoteInsert(at(doc, 5), BLOCK))
  expect(state.doc.toString().startsWith('---\ntitle: Talk\n---\n')).toBe(true)
  expect(state.doc.toString()).toContain(`Body.\n${BLOCK}`)
})

test('one ⌘Z removes the quote and its citation together, and nothing typed before it', () => {
  let state = at('As I wrote', 10)
  state = state.update({ changes: { from: 10, insert: ' in 2016:' }, selection: { anchor: 19 }, userEvent: 'input.type' }).state
  state = apply(state, archiveQuoteInsert(state, BLOCK))
  let undone = state
  undo({ state: undone, dispatch: (tr) => { undone = tr.state } })
  expect(undone.doc.toString()).toBe('As I wrote in 2016:')
})

test('link only: the full title as text, the archive link for writing, the public URL otherwise', () => {
  expect(archiveLinkMarkdown({ title: 'Repaved paths [draft]', link: LINK, publicUrl: 'https://medium.com/p/x' }))
    .toBe(`[Repaved paths \\[draft\\]](${LINK})`)
  expect(archiveLinkMarkdown({ title: 'On connectionism', link: 'file:///works/x.md', publicUrl: 'https://example.org/a' }))
    .toBe('[On connectionism](https://example.org/a)')
  const state = at('As I wrote in 2016 in ', 22)
  const next = state.update(archiveLinkInsert(state, '[Repaved](x)')).state
  expect(next.doc.toString()).toBe('As I wrote in 2016 in [Repaved](x)')
  expect(next.selection.main.head).toBe(next.doc.length)
})

test('the archive link in an inserted citation is found at a position inside it', () => {
  const state = EditorState.create({ doc: BLOCK, extensions: [markdown()] })
  const inside = BLOCK.indexOf('[archive]') + 3
  expect(markdownLinkAt(state, inside)).toBe(LINK)
  expect(markdownLinkAt(state, BLOCK.indexOf('[public]') + 2)).toBe('https://medium.com/p/x')
  expect(markdownLinkAt(state, 3)).toBeNull()
})
