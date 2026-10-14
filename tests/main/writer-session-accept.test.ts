import { expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import type { AttributedChange, Change } from '../../src/preload'
import {
  acceptWriterSessionChanges,
  revertWriterChangeToActive,
  sendOriginalToScratchpad,
} from '../../src/renderer/src/app/writer-mode'
import { documentTextForPersistence, writerReviewing } from '../../src/renderer/src/editor/writer-review'

test('Accept session changes writer record statuses without changing buffer or persistence text', async () => {
  const beforeState = EditorState.create({
    doc: 'The final text exactly as typed.\n',
    extensions: [writerReviewing({ initialMode: 'drafting' })],
  })
  const beforeBuffer = beforeState.doc.toString()
  const beforePersistence = documentTextForPersistence(beforeState)
  const calls: Array<[string, string]> = []
  const changes: Change[] = [
    {
      id: 'writer_pending_1',
      path: 'notes/draft.md',
      ts: 1,
      provenance: 'writer',
      editClass: 'content',
      category: 'wording',
      summary: 'Writer edit',
      oldText: 'draft',
      newText: 'final',
      status: 'pending',
      isCorrection: false,
      sessionId: 'ws_1',
    },
  ]

  await acceptWriterSessionChanges(changes, {
    setChangeStatus: async (id, status) => { calls.push([id, status]) },
  })

  expect(calls).toEqual([['writer_pending_1', 'accepted']])
  expect(beforeState.doc.toString()).toBe(beforeBuffer)
  expect(documentTextForPersistence(beforeState)).toBe(beforePersistence)
})

test('Revert to active changes an accepted writer record to pending without changing any document bytes', async () => {
  const state = EditorState.create({
    doc: 'The final text exactly as typed.\n',
    extensions: [writerReviewing({ initialMode: 'drafting' })],
  })
  const beforeBuffer = state.doc.toString()
  const beforePersistence = documentTextForPersistence(state)
  const calls: Array<[string, string]> = []
  const change: Change = {
    id: 'writer_accepted_1',
    path: 'notes/draft.md',
    ts: 1,
    provenance: 'writer',
    editClass: 'content',
    category: 'wording',
    summary: 'Writer edit',
    oldText: 'draft',
    newText: 'final',
    status: 'accepted',
    isCorrection: false,
    sessionId: 'ws_1',
  }

  await revertWriterChangeToActive(change, {
    setChangeStatus: async (id, status) => { calls.push([id, status]) },
  })

  expect(calls).toEqual([['writer_accepted_1', 'pending']])
  expect(state.doc.toString()).toBe(beforeBuffer)
  expect(documentTextForPersistence(state)).toBe(beforePersistence)
})

test('Send original to Scratchpad prefers compareOldText, falls back to oldText, and changes no status or text', async () => {
  const state = EditorState.create({
    doc: 'The final text exactly as typed.\n',
    extensions: [writerReviewing({ initialMode: 'drafting' })],
  })
  const beforeBuffer = state.doc.toString()
  const beforePersistence = documentTextForPersistence(state)
  const change = {
    id: 'writer_accepted_2',
    path: 'notes/draft.md',
    ts: 1,
    provenance: 'writer',
    editClass: 'content',
    category: 'wording',
    summary: 'Writer edit',
    oldText: 'fallback original',
    newText: 'final',
    status: 'accepted',
    isCorrection: false,
    sessionId: 'ws_1',
    compareOldText: 'exact original wording',
  } satisfies Change & Partial<Pick<AttributedChange, 'compareOldText'>>
  const statusBefore = change.status
  const added: Array<[string, string]> = []

  await sendOriginalToScratchpad(change, {
    add: async (origin, text) => {
      added.push([origin, text])
      return null
    },
  })
  await sendOriginalToScratchpad({ ...change, id: 'writer_without_compare', compareOldText: undefined }, {
    add: async (origin, text) => {
      added.push([origin, text])
      return null
    },
  })

  expect(added).toEqual([
    ['notes/draft.md', 'exact original wording'],
    ['notes/draft.md', 'fallback original'],
  ])
  expect(change.status).toBe(statusBefore)
  expect(state.doc.toString()).toBe(beforeBuffer)
  expect(documentTextForPersistence(state)).toBe(beforePersistence)
})
