import type { Change } from '../../../preload'

export type SessionSummary = {
  sessionId: string
  startedAt: number
  count: number
  state: 'pending' | 'settled'
  versionStamp: string | null
}

export function sessionsForDocument(changes: Change[]): SessionSummary[] {
  const recordsBySession = new Map<string, Change[]>()

  for (const change of changes) {
    if (change.provenance !== 'writer' || change.editClass === 'copy' || !change.sessionId) continue
    const records = recordsBySession.get(change.sessionId) ?? []
    records.push(change)
    recordsBySession.set(change.sessionId, records)
  }

  return [...recordsBySession.entries()].map(([sessionId, records]) => {
    const latest = records.reduce((current, record) => record.ts >= current.ts ? record : current)

    return {
      sessionId,
      startedAt: Math.min(...records.map((record) => record.ts)),
      count: records.length,
      state: records.every((record) => record.status === 'accepted') ? 'settled' : 'pending',
      // A session should normally carry one stamp. If records disagree, the latest record owns it.
      versionStamp: latest.versionId ?? latest.snapshotId ?? null,
    }
  })
}

export function sessionsByVersionStamp(
  summaries: SessionSummary[],
): Map<string | null, SessionSummary[]> {
  const buckets = new Map<string | null, SessionSummary[]>()

  for (const summary of summaries) {
    const sessions = buckets.get(summary.versionStamp) ?? []
    sessions.push(summary)
    buckets.set(summary.versionStamp, sessions)
  }

  return buckets
}
