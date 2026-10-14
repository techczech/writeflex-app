import { test, expect } from 'bun:test'
import type { Version } from '../../src/preload'
import {
  enterHistoricalView,
  returnToCurrent,
  restoreHistoricalView,
} from '../../src/renderer/src/app/historical-view'
import * as historicalViewModule from '../../src/renderer/src/app/historical-view'
import type { SessionSummary } from '../../src/renderer/src/app/session-history'

const version: Version = {
  id: 'v_first',
  path: 'draft.md',
  name: 'First draft',
  author: { name: 'Dominik Lukeš' },
  ts: 1000,
  snapshotId: 'snapshot-first',
}

test('entering historical view shows old content read-only without mutating the live buffer', () => {
  const view = enterHistoricalView({
    version,
    historicalContent: '# Draft\n\nOld text.\n',
    liveContent: '# Draft\n\nLive text.\n',
  })

  expect(view.displayContent).toBe('# Draft\n\nOld text.\n')
  expect(view.liveContent).toBe('# Draft\n\nLive text.\n')
  expect(view.readOnly).toBe(true)
})
test('returning to current restores the saved live buffer', () => {
  const view = enterHistoricalView({
    version,
    historicalContent: '# Draft\n\nOld text.\n',
    liveContent: '# Draft\n\nLive text.\n',
  })

  expect(returnToCurrent(view)).toEqual({
    path: 'draft.md',
    content: '# Draft\n\nLive text.\n',
  })
})

test('restoring a historical view prepares an explicit replacement with pre-restore content', () => {
  const view = enterHistoricalView({
    version,
    historicalContent: '# Draft\n\nOld text.\n',
    liveContent: '# Draft\n\nLive text.\n',
  })

  expect(restoreHistoricalView(view)).toEqual({
    path: 'draft.md',
    versionId: 'v_first',
    snapshotId: 'snapshot-first',
    replacementContent: '# Draft\n\nOld text.\n',
    preRestoreContent: '# Draft\n\nLive text.\n',
  })
})

test('session recall distinguishes the exact live session from a past Working session', () => {
  const classify = (historicalViewModule as typeof historicalViewModule & {
    sessionRecallKind?: (session: SessionSummary, currentSessionId: string | undefined) => 'current' | 'past'
  }).sessionRecallKind
  expect(typeof classify).toBe('function')
  if (!classify) return

  const live: SessionSummary = {
    sessionId: 'live-session',
    startedAt: 1000,
    count: 1,
    state: 'pending',
    versionStamp: null,
  }
  const pastWorking = { ...live, sessionId: 'past-working' }

  expect(classify(live, 'live-session')).toBe('current')
  expect(classify(pastWorking, 'live-session')).toBe('past')
})

test('session historical view returns the live document byte-identically', () => {
  const enterSession = (historicalViewModule as typeof historicalViewModule & {
    enterSessionHistoricalView?: (input: {
      session: SessionSummary
      path: string
      historicalContent: string
      liveContent: string
      records: []
      version: Version | null
    }) => Parameters<typeof returnToCurrent>[0]
  }).enterSessionHistoricalView
  expect(typeof enterSession).toBe('function')
  if (!enterSession) return

  const liveContent = '# Draft\r\n\r\nLive bytes.  \r\n'
  const view = enterSession({
    session: { sessionId: 'past', startedAt: 1000, count: 1, state: 'settled', versionStamp: 'v1' },
    path: 'draft.md',
    historicalContent: '# Draft\n\nOld bytes.\n',
    liveContent,
    records: [],
    version,
  })

  expect(returnToCurrent(view)).toEqual({ path: 'draft.md', content: liveContent })
})
