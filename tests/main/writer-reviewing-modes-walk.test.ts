import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { history } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'
import {
  documentTextForPersistence,
  foldReviewingChanges,
  pendingWriterChanges,
  revisionDecorationsVisible,
  visibleWriterMarks,
  writerReviewing,
  type WriterReviewMode,
} from '../../src/renderer/src/editor/writer-review'

// The logic of tests/e2e/writer-reviewing-modes.spec.ts without Electron: the editor's Drafting and Reviewing
// modes on the e2e's own documents. The drawn marks (.writer-change.you-ins), the Margin's count menu and
// the Save version dialog are the renderer's; whether an edit is a plain change, a struck deletion or
// nothing at all is decided here.
const open = (doc: string, mode: WriterReviewMode): EditorState => EditorState.create({
  doc,
  extensions: [markdown({ extensions: [GFM] }), history(), writerReviewing({ initialMode: mode })],
})
const type = (state: EditorState, at: number, text: string): EditorState =>
  state.update({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: 'input.type' }).state
const slice = (state: EditorState, mark: { from: number; to: number }): string => state.doc.sliceString(mark.from, mark.to)

describe('Drafting', () => {
  test('keeps edits plain: the buffer is the file, nothing is drawn, and the change is recorded for later', () => {
    let state = open('', 'drafting')
    state = type(state, 0, 'Plain drafting text')
    expect(state.doc.toString()).toBe('Plain drafting text')
    expect(revisionDecorationsVisible(state)).toBe(false)
    expect(visibleWriterMarks(state)).toEqual([]) // no .you-ins, no .you-del, no margin cards
    expect(documentTextForPersistence(state)).toBe('Plain drafting text')
    expect(pendingWriterChanges(state).map((change) => change.newText).join('')).toBe('Plain drafting text')
  })

  test('typing at the end of the draft records one pending writer change on its own text', () => {
    const initial = 'The draft.\n'
    let state = open(initial, 'drafting')
    state = type(state, 'The draft.'.length, ' More text.')
    expect(state.doc.toString()).toBe('The draft. More text.\n') // the file text
    const pending = pendingWriterChanges(state)
    expect(pending.length).toBeGreaterThan(0)
    for (const change of pending) expect(state.doc.sliceString(change.anchor.from, change.anchor.to)).toBe(change.newText)
    expect(pending.map((change) => change.newText).join('')).toBe(' More text.')
  })
})

describe('the Margin\'s Accept session keeps the writer\'s history and changes no document text', () => {
  let root: string
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'wf-writer-modes-')) })
  afterEach(() => rm(root, { recursive: true, force: true }))

  test('every recorded writer change is accepted in place: same ids, same count, same buffer', async () => {
    let state = open('The draft.\n', 'drafting')
    state = type(state, 'The draft.'.length, ' More text.')
    const store = new ChangeStore(new Workspace(root))
    for (const change of pendingWriterChanges(state)) {
      await store.add({ path: 'draft.md', provenance: 'writer', editClass: null, summary: 'typed', oldText: change.oldText, newText: change.newText, anchor: change.anchor, isCorrection: false })
    }
    const before = await store.list({ path: 'draft.md', provenance: 'writer' })
    expect(before.some((change) => change.status === 'pending')).toBe(true)
    const buffer = state.doc.toString()

    for (const change of before) await store.setReviewStatus(change.id, 'accepted') // Accept all

    const after = await store.list({ path: 'draft.md', provenance: 'writer' })
    expect(after.map((change) => change.id)).toEqual(before.map((change) => change.id))
    expect(after.every((change) => change.status === 'accepted')).toBe(true)
    expect(state.doc.toString()).toBe(buffer)
    expect(documentTextForPersistence(state)).toBe('The draft. More text.\n')
  })
})

describe('Reviewing', () => {
  test('shows writer insertions and a struck deletion, then folding them back leaves the clean text with nothing drawn', () => {
    let state = open('The old draft.\n', 'reviewing')
    expect(revisionDecorationsVisible(state)).toBe(true)
    state = type(state, 0, 'New ')
    // Strike the ORIGINAL first word: a tracked deletion keeps the text in the buffer, marked old.
    state = state.update({ changes: { from: 4, to: 7 }, selection: { anchor: 4 }, userEvent: 'delete.selection' }).state

    const marks = visibleWriterMarks(state)
    expect(marks.filter((mark) => mark.role === 'new').map((mark) => slice(state, mark))).toEqual(['New '])
    expect(marks.filter((mark) => mark.role === 'old').map((mark) => slice(state, mark))).toEqual(['The'])
    expect(state.doc.toString()).toContain('The old draft.') // struck, not gone
    expect(documentTextForPersistence(state)).toBe('New  old draft.\n') // what the file would hold: insertion in, deletion out

    // Save version folds the session into the named version: no marks remain, the struck word is removed.
    state = state.update(foldReviewingChanges(state)).state
    expect(visibleWriterMarks(state)).toEqual([])
    expect(state.doc.toString()).toBe('New  old draft.\n')
  })
})
