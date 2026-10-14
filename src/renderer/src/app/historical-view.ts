import type { Version } from '../../../preload'
import type { WriterPendingChange } from '../editor/writer-review'
import type { SessionSummary } from './session-history'

type HistoricalViewBase = {
  path: string
  displayContent: string
  liveContent: string
  readOnly: true
}

export type VersionHistoricalView = HistoricalViewBase & {
  kind: 'version'
  version: Version
}

export type SessionHistoricalView = HistoricalViewBase & {
  kind: 'session'
  session: SessionSummary
  version: Version | null
  records: WriterPendingChange[]
}

export type HistoricalView = VersionHistoricalView | SessionHistoricalView

export type HistoricalViewInput = {
  version: Version
  historicalContent: string
  liveContent: string
}

export type RestoreHistoricalViewRequest = {
  path: string
  versionId: string
  snapshotId?: string
  replacementContent: string
  preRestoreContent: string
}

export function enterHistoricalView(input: HistoricalViewInput): VersionHistoricalView {
  return {
    kind: 'version',
    version: input.version,
    path: input.version.path,
    displayContent: input.historicalContent,
    liveContent: input.liveContent,
    readOnly: true,
  }
}

export function sessionRecallKind(
  session: SessionSummary,
  currentSessionId: string | undefined,
): 'current' | 'past' {
  return currentSessionId !== undefined && session.sessionId === currentSessionId ? 'current' : 'past'
}

export function enterSessionHistoricalView(input: {
  session: SessionSummary
  path: string
  historicalContent: string
  liveContent: string
  records: WriterPendingChange[]
  version: Version | null
}): SessionHistoricalView {
  return {
    kind: 'session',
    session: input.session,
    version: input.version,
    records: input.records,
    path: input.path,
    displayContent: input.historicalContent,
    liveContent: input.liveContent,
    readOnly: true,
  }
}

export function returnToCurrent(view: HistoricalView): { path: string; content: string } {
  return { path: view.path, content: view.liveContent }
}

export function restoreHistoricalView(view: VersionHistoricalView): RestoreHistoricalViewRequest {
  return {
    path: view.path,
    versionId: view.version.id,
    ...(view.version.snapshotId ? { snapshotId: view.version.snapshotId } : {}),
    replacementContent: view.displayContent,
    preRestoreContent: view.liveContent,
  }
}
