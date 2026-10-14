import { expect, test } from 'bun:test'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import type { Change, NewChange } from '../../src/preload'
import type { EditorHandle } from '../../src/renderer/src/components/EditorPane'
import { useWriterMode, type WriterMode } from '../../src/renderer/src/app/writer-mode'
import {
  deriveCleanWriterDocument,
  foldReviewingChanges,
  materialiseDraftingChanges,
  pendingWriterChanges,
  writerReviewing,
  writerReviewModeOf,
} from '../../src/renderer/src/editor/writer-review'

function draftingState(doc = ''): EditorState {
  return EditorState.create({
    doc,
    extensions: [markdown({ extensions: [GFM] }), writerReviewing({ initialMode: 'drafting' })],
  })
}

function typeText(state: EditorState, text: string): EditorState {
  let next = state
  for (const char of text) {
    const at = next.selection.main.head
    next = next.update({
      changes: { from: at, insert: char },
      selection: { anchor: at + char.length },
      userEvent: 'input.type',
    }).state
  }
  return next
}

test('Drafting reveal and fold preserve the session for an identical second reveal', () => {
  const initial = 'Alpha old text and tail.\n\nBeta remove this.'
  const oldFrom = initial.indexOf('old')
  const tailFrom = initial.indexOf('tail')
  const removeFrom = initial.indexOf('remove ')
  const drafted = draftingState(initial).update({
    changes: [
      { from: oldFrom, to: oldFrom + 'old'.length, insert: 'new' },
      { from: tailFrom, insert: 'bright ' },
      { from: removeFrom, to: removeFrom + 'remove '.length },
    ],
  }).state
  const cleanDraft = 'Alpha new text and bright tail.\n\nBeta this.'
  const capture = pendingWriterChanges(drafted)
  const ledger = capture.map((record) => ({ localId: record.localId, status: 'pending' as const }))

  expect(drafted.doc.toString()).toBe(cleanDraft)
  expect(capture).toHaveLength(3)
  expect(capture.map(({ oldText, newText }) => ({ oldText, newText }))).toEqual([
    { oldText: 'old', newText: 'new' },
    { oldText: '', newText: 'bright ' },
    { oldText: 'remove ', newText: '' },
  ])

  const reviewing = drafted.update(materialiseDraftingChanges(drafted)).state
  const firstReveal = pendingWriterChanges(reviewing)

  expect(writerReviewModeOf(reviewing)).toBe('reviewing')
  expect(reviewing.doc.toString()).toBe('Alpha oldnew text and bright tail.\n\nBeta remove this.')
  expect(firstReveal.map(({ localId, oldText, newText }) => ({ localId, oldText, newText }))).toEqual(
    capture.map(({ localId, oldText, newText }) => ({ localId, oldText, newText })),
  )
  expect(deriveCleanWriterDocument(reviewing.doc.toString(), firstReveal)).toBe(cleanDraft)

  const folded = reviewing.update(foldReviewingChanges(reviewing)).state

  expect(writerReviewModeOf(folded)).toBe('drafting')
  expect(folded.doc.toString()).toBe(cleanDraft)
  expect(pendingWriterChanges(folded)).toEqual(capture)
  expect(ledger.every((record) => record.status === 'pending')).toBe(true)

  const revealedAgain = folded.update(materialiseDraftingChanges(folded)).state

  expect(revealedAgain.doc.toString()).toBe(reviewing.doc.toString())
  expect(pendingWriterChanges(revealedAgain)).toEqual(firstReveal)
})

test('ten paragraphs and one list keep their structural grain through reveal and fold', () => {
  const paragraphs = Array.from({ length: 10 }, (_, index) => `Paragraph ${index + 1}.`).join('\n\n')
  const list = Array.from({ length: 6 }, (_, index) => `- Item ${index + 1}`).join('\n')
  const drafted = typeText(draftingState(), `${paragraphs}\n\n${list}`)
  const capture = pendingWriterChanges(drafted)

  expect(capture).toHaveLength(11)

  const reviewing = drafted.update(materialiseDraftingChanges(drafted)).state
  const folded = reviewing.update(foldReviewingChanges(reviewing)).state

  expect(deriveCleanWriterDocument(reviewing.doc.toString(), pendingWriterChanges(reviewing))).toBe(drafted.doc.toString())
  expect(folded.doc.toString()).toBe(drafted.doc.toString())
  expect(pendingWriterChanges(folded)).toEqual(capture)
  expect(pendingWriterChanges(folded)).toHaveLength(11)
})

test('repeating the active mode transform preserves its document and records', () => {
  const drafted = draftingState('The old draft.').update({
    changes: { from: 4, to: 7, insert: 'new' },
  }).state
  const reviewing = drafted.update(materialiseDraftingChanges(drafted)).state
  const reviewingAgain = reviewing.update(materialiseDraftingChanges(reviewing)).state

  expect(reviewingAgain.doc.toString()).toBe(reviewing.doc.toString())
  expect(pendingWriterChanges(reviewingAgain)).toEqual(pendingWriterChanges(reviewing))

  const folded = reviewing.update(foldReviewingChanges(reviewing)).state
  const foldedAgain = folded.update(foldReviewingChanges(folded)).state

  expect(foldedAgain.doc.toString()).toBe(folded.doc.toString())
  expect(pendingWriterChanges(foldedAgain)).toEqual(pendingWriterChanges(folded))
})

test('mode switching reveals Drafting and folds Reviewing without accepting ledger records', async () => {
  const path = 'draft.md'
  const pending = {
    localId: 'wr_roundtrip',
    oldText: 'old',
    newText: 'new',
    anchor: { from: 0, to: 3 },
    createdAt: 1,
  }
  const accepted: string[] = []
  let revealed = false
  let folded = false
  let settled = false
  let mode: WriterMode | null = null
  const stored = (input: NewChange): Change => ({
    id: 'c_roundtrip',
    ts: 1,
    status: 'pending',
    ...input,
  })
  const editor = {
    pendingWriterChanges: () => [pending],
    revealDraftingSession: () => { revealed = true },
    foldWriterChanges: () => { folded = true },
    settleWriterChanges: () => { settled = true },
  } as unknown as EditorHandle

  function Harness(): null {
    mode = useWriterMode({
      ledger: {
        addChange: async (input) => stored(input),
        updateWriterChange: async (_id, input) => stored(input),
        setChangeStatus: async (id, status) => { if (status === 'accepted') accepted.push(id) },
      },
      active: path,
      activeRef: { current: path },
      root: null,
      editorRef: { current: editor },
      reloadChanges: async () => undefined,
      flash: () => undefined,
    })
    return null
  }

  renderToString(createElement(Harness))
  expect(mode).not.toBeNull()

  await mode!.foldWriterEdits(path)
  mode!.changeWriterMode('reviewing')

  expect(folded).toBe(true)
  expect(settled).toBe(false)
  expect(accepted).toEqual([])
  expect(revealed).toBe(true)
})

test('opening and restarting a per-document writer session stamps its opened-at time', () => {
  let mode: WriterMode | null = null

  function Harness(): null {
    mode = useWriterMode({
      ledger: {
        addChange: async (input) => ({ id: 'unused', ts: 1, status: 'pending', ...input }),
        updateWriterChange: async (_id, input) => ({ id: 'unused', ts: 1, status: 'pending', ...input }),
        setChangeStatus: async () => undefined,
      },
      active: 'notes/draft.md',
      activeRef: { current: 'notes/draft.md' },
      root: null,
      editorRef: { current: null },
      reloadChanges: async () => undefined,
      flash: () => undefined,
    })
    return null
  }

  renderToString(createElement(Harness))
  const sessionMode = mode as unknown as WriterMode & { openedAtForFile: (path: string) => number | undefined }
  const beforeOpen = Date.now()
  sessionMode.modeForFile('notes/draft.md', '')
  const firstOpenedAt = sessionMode.openedAtForFile('notes/draft.md')
  const firstSessionId = sessionMode.currentSessionIdForFile('notes/draft.md')
  expect(firstOpenedAt).toBeGreaterThanOrEqual(beforeOpen)
  expect(firstSessionId).toStartWith('ws_')

  sessionMode.startNewSession('notes/draft.md')
  expect(sessionMode.openedAtForFile('notes/draft.md')).toBeGreaterThanOrEqual(firstOpenedAt!)
  expect(sessionMode.currentSessionIdForFile('notes/draft.md')).not.toBe(firstSessionId)

  sessionMode.clearFileWriterState('notes/draft.md')
  expect(sessionMode.openedAtForFile('notes/draft.md')).toBeUndefined()
  expect(sessionMode.currentSessionIdForFile('notes/draft.md')).toBeUndefined()
  sessionMode.modeForFile('notes/draft.md', '')
  expect(sessionMode.openedAtForFile('notes/draft.md')).toBeGreaterThanOrEqual(firstOpenedAt!)
  expect(sessionMode.currentSessionIdForFile('notes/draft.md')).not.toBe(firstSessionId)
})
