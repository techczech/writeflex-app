import type { Change } from '../preload'
import { OUTSIDE_SOURCES, OUTSIDE_SOURCE_LABELS, type OutsideChangeFields, type OutsideSource } from './outside-source'

export type OutsideGrouping = 'source' | 'kind' | 'folder'
export type BatchTarget = { id: string; path: string }
export type BatchIssue = BatchTarget & { reason: string }
export type BatchResult = { decided: number; left: BatchIssue[] }
export type OutsideReviewGroup = { key: string; title: string; detail?: string; missing?: true; changes: Change[] }

type BatchEligibility = Pick<Change, 'status' | 'provenance' | 'snapshotId'> & OutsideChangeFields

export function pendingOutsideBatchChange(change: BatchEligibility): change is BatchEligibility & { outsideSource: OutsideSource } {
  return change.status === 'pending' && change.provenance === 'agent' && !change.snapshotId &&
    change.outsideRefused !== true && change.outsideSource !== undefined &&
    change.outsideSource !== 'reader' && OUTSIDE_SOURCES.includes(change.outsideSource)
}

export function outsideReviewKind(change: Change): string {
  if (change.frontmatter) return 'Summary / front matter'
  // Older requests carry an authored summary and often the generic content class. Recognise explicit
  // labels in that summary. The bucket is for triage and the preview remains the authority for review.
  const label = change.summary.trim()
  if (change.category === 'reference' || /^(?:(?:add|fix|update|remove|correct) (?:a |the )?)?(?:references?|citations?|bibliography)\b/i.test(label)) return 'Reference'
  if (change.editClass === 'copy' || /^(?:copy[- ]?edit(?:ing)?|proofread(?:ing)?|typos?)\b/i.test(label)) return 'Copy-edit'
  return 'Prose / research'
}

export function groupOutsideReview(changes: readonly Change[], by: OutsideGrouping, missing: ReadonlySet<string>): OutsideReviewGroup[] {
  const groups = new Map<string, OutsideReviewGroup>()
  const gone: OutsideReviewGroup = { key: 'missing', title: 'Documents no longer found', missing: true, changes: [] }
  for (const change of changes) {
    if (!pendingOutsideBatchChange(change)) continue
    const source = change.outsideSource
    if (missing.has(change.path)) {
      gone.changes.push(change)
      continue
    }
    const folder = change.path.split('/').slice(0, -1).join('/')
    const run = change.sessionId ?? change.outsideRequest?.id
    const title = by === 'source' ? OUTSIDE_SOURCE_LABELS[source]
      : by === 'kind' ? outsideReviewKind(change) : folder || 'Workspace root'
    const key = by === 'source' ? JSON.stringify([by, source, run ?? null]) : JSON.stringify([by, title])
    const detail = by === 'source'
      ? change.sessionId ? `Run ${change.sessionId}` : run ? `Request ${run}` : 'Run not recorded'
      : undefined
    let group = groups.get(key)
    if (!group) {
      group = { key, title, detail, changes: [] }
      groups.set(key, group)
    }
    group.changes.push(change)
  }
  return [...groups.values(), ...(gone.changes.length ? [gone] : [])]
}
