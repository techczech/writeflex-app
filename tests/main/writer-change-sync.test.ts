import { expect, test } from 'bun:test'
import { syncWriterChanges } from '../../src/renderer/src/app/writer-change-sync'
import type { Change, NewChange } from '../../src/preload'
import type { WriterPendingChange } from '../../src/renderer/src/editor/writer-review'

const change = (overrides: Partial<Change>): Change => ({
  id: 'c_existing',
  path: 'draft.md',
  ts: 1,
  provenance: 'writer',
  editClass: 'content',
  category: 'wording',
  summary: 'Your insertion',
  oldText: '',
  newText: 'fresh',
  status: 'pending',
  isCorrection: false,
  anchor: { from: 1, to: 6 },
  ...overrides,
})

test('syncWriterChanges updates an already flushed writer row from live marks', async () => {
  const pathMap = new Map([['wr_local', 'c_existing']])
  const pending: WriterPendingChange[] = [
    {
      localId: 'wr_local',
      oldText: '',
      newText: 'freshly shifted',
      anchor: { from: 4, to: 19 },
      createdAt: 10,
    },
  ]
  const added: NewChange[] = []
  const updated: Array<{ id: string; input: NewChange }> = []

  const ids = await syncWriterChanges({
    path: 'draft.md',
    pending,
    pathMap,
    addChange: async (input) => {
      added.push(input)
      return change({ id: 'c_added', ...input })
    },
    updateWriterChange: async (id, input) => {
      updated.push({ id, input })
      return change({ id, ...input })
    },
  })

  expect(ids).toEqual(['c_existing'])
  expect(added).toEqual([])
  expect(updated).toEqual([
    {
      id: 'c_existing',
      input: {
        path: 'draft.md',
        provenance: 'writer',
        editClass: 'content',
        category: 'wording',
        summary: 'Your insertion',
        oldText: '',
        newText: 'freshly shifted',
        anchor: { from: 4, to: 19 },
        isCorrection: false,
      },
    },
  ])
})

test('syncWriterChanges stamps the per-document writer session onto new and updated records (ADR-0025 §3)', async () => {
  const pending: WriterPendingChange[] = [
    { localId: 'wr_new', oldText: '', newText: 'added', anchor: { from: 0, to: 5 }, createdAt: 1 },
    { localId: 'wr_old', oldText: 'x', newText: 'y', anchor: { from: 6, to: 7 }, createdAt: 2 },
  ]
  const seen: NewChange[] = []
  await syncWriterChanges({
    path: 'draft.md',
    pending,
    pathMap: new Map([['wr_old', 'c_existing']]),
    sessionId: 'ws_session_1',
    addChange: async (input) => { seen.push(input); return change({ id: 'c_added', ...input }) },
    updateWriterChange: async (id, input) => { seen.push(input); return change({ id, ...input }) },
  })
  expect(seen).toHaveLength(2)
  expect(seen.every((input) => input.sessionId === 'ws_session_1')).toBe(true)
})

test('syncWriterChanges omits sessionId when none is supplied (backward compatible)', async () => {
  const seen: NewChange[] = []
  await syncWriterChanges({
    path: 'draft.md',
    pending: [{ localId: 'wr_a', oldText: '', newText: 'z', anchor: { from: 0, to: 1 }, createdAt: 1 }],
    pathMap: new Map(),
    addChange: async (input) => { seen.push(input); return change({ id: 'c_added', ...input }) },
    updateWriterChange: async (id, input) => { seen.push(input); return change({ id, ...input }) },
  })
  expect('sessionId' in seen[0]!).toBe(false)
})
