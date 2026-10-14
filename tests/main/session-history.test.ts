import { expect, test } from 'bun:test'
import type { Change } from '../../src/preload'
import {
  sessionsByVersionStamp,
  sessionsForDocument,
} from '../../src/renderer/src/app/session-history'

const change = (id: string, over: Partial<Change> = {}): Change => ({
  id,
  path: 'draft.md',
  ts: 1,
  provenance: 'writer',
  editClass: 'content',
  category: 'wording',
  summary: id,
  oldText: 'old',
  newText: 'new',
  status: 'pending',
  isCorrection: false,
  ...over,
})

test('derives writer sessions and buckets versioned and Working summaries', () => {
  const summaries = sessionsForDocument([
    change('settled_later', {
      ts: 400,
      status: 'accepted',
      sessionId: 'session_settled',
      versionId: 'version_2',
    }),
    change('settled_earlier', {
      ts: 200,
      status: 'accepted',
      sessionId: 'session_settled',
      snapshotId: 'older_snapshot',
    }),
    change('pending_earlier', {
      ts: 300,
      status: 'accepted',
      sessionId: 'session_pending',
    }),
    change('pending_later', {
      ts: 500,
      status: 'pending',
      sessionId: 'session_pending',
    }),
    change('without_session', { ts: 100 }),
    change('agent_record', { provenance: 'agent', sessionId: 'session_agent' }),
    change('copy_record', { editClass: 'copy', sessionId: 'session_copy' }),
  ])

  expect(summaries).toEqual([
    {
      sessionId: 'session_settled',
      startedAt: 200,
      count: 2,
      state: 'settled',
      versionStamp: 'version_2',
    },
    {
      sessionId: 'session_pending',
      startedAt: 300,
      count: 2,
      state: 'pending',
      versionStamp: null,
    },
  ])

  const buckets = sessionsByVersionStamp(summaries)
  expect(buckets.get('version_2')).toEqual([summaries[0]])
  expect(buckets.get(null)).toEqual([summaries[1]])
  expect([...buckets.keys()]).toEqual(['version_2', null])
})
