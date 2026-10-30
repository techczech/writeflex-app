import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change, Version } from '../../src/preload'
import { VersionsPane } from '../../src/renderer/src/components/VersionsPane'

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

test('renders keyboard-focusable session rows beneath their version or Working parent', () => {
  const now = 1_800_000_000_000
  const originalNow = Date.now
  Date.now = () => now

  const version: Version = {
    id: 'version_row_2',
    path: 'draft.md',
    name: 'Second draft',
    author: { name: 'Dominik Lukeš' },
    ts: now - 60_000,
    versionId: 'version_2',
  }
  const viewedSessions: string[] = []

  try {
    const html = renderToStaticMarkup(
      <VersionsPane
        attachmentUndo={{ id: "multi-file-map", files: 3 }}
        activePath="draft.md"
        waitingHistory={[{ from: 'old.md', count: 2 }, { from: '.draft.md', count: 1 }]}
        versions={[version]}
        allChanges={[
          change('working_1', {
            ts: now - 120_000,
            sessionId: 'working_session',
          }),
          change('versioned_1', {
            ts: now - 3_600_000,
            status: 'accepted',
            sessionId: 'versioned_session',
            versionId: 'version_2',
          }),
          change('versioned_2', {
            ts: now - 3_540_000,
            status: 'accepted',
            sessionId: 'versioned_session',
            versionId: 'version_2',
          }),
        ]}
        pendingCount={1}
        onViewSession={(session) => viewedSessions.push(session.sessionId)}
        onViewVersion={() => {}}
        onRestoreVersion={() => {}}
        onOpenCompare={() => {}}
        onRenameVersion={() => {}}
        onReturnToCurrent={() => {}}
        onSaveVersion={() => {}}
      />,
    )

    const workingParent = html.indexOf('<b>Working</b>')
    const workingSession = html.indexOf('Session · 2 mins ago')
    const versionParent = html.indexOf('<b>Second draft</b>')
    const versionedSession = html.indexOf('Session · 1 hour ago')

    expect(workingParent).toBeGreaterThan(-1)
    expect(workingSession).toBeGreaterThan(workingParent)
    expect(versionParent).toBeGreaterThan(workingSession)
    expect(versionedSession).toBeGreaterThan(versionParent)
    expect(html.match(/class="session-row/g)).toHaveLength(2)
    expect(html.match(/tabindex="0"/g)).toHaveLength(3)
    expect(html).toContain('aria-label="Pending session"')
    expect(html).toContain('aria-label="Settled session"')
    expect(html).toContain('<span class="vcount">2</span>')
    expect(html).toContain('History waiting to be reattached (1 version, from .draft.md)')
    expect(html.match(/>Attach here<\/button>/g)).toHaveLength(2)
    expect(html).toContain('Undo history attachment (3 files)')
    expect(html).toContain('History waiting to be reattached (2 versions, from old.md)')
  } finally {
    Date.now = originalNow
  }
})
