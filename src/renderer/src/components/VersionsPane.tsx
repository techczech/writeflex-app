import { Fragment, useCallback, useMemo, useState } from 'react'
import { ArrowLeftRight, CircleCheck, Clock3, Pencil, RotateCcw, Save } from 'lucide-react'
import type { Change, Version, VersionCompareEndpointId } from '../../../preload'
import {
  sessionsByVersionStamp,
  sessionsForDocument,
  type SessionSummary,
} from '../app/session-history'

function relativeDate(ts: number): string {
  const delta = Date.now() - ts
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour
  if (delta < minute) return 'just now'
  if (delta < hour) {
    const n = Math.max(1, Math.round(delta / minute))
    return `${n} min${n === 1 ? '' : 's'} ago`
  }
  if (delta < day) {
    const n = Math.max(1, Math.round(delta / hour))
    return `${n} hour${n === 1 ? '' : 's'} ago`
  }
  if (delta < 14 * day) {
    const n = Math.max(1, Math.round(delta / day))
    return `${n} day${n === 1 ? '' : 's'} ago`
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(ts))
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'W'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase()
}

function dockChangesLabel(total: number): string {
  if (total === 0) return 'No pending changes'
  return `${total} pending change${total === 1 ? '' : 's'}`
}

export type VersionsPaneProps = {
  versions: Version[]
  /** The full Change history — per-version change counts are derived from its version stamps. */
  allChanges: Change[]
  /** Pending-change count shown on the Working node. */
  pendingCount: number
  historicalVersionId?: string | null
  onViewSession: (session: SessionSummary) => void
  onViewVersion: (version: Version) => void
  /** Restore this version as the current document (same flow as the view banner's Restore). */
  onRestoreVersion: (version: Version) => void
  onOpenCompare: (fromId: VersionCompareEndpointId, toId: VersionCompareEndpointId) => void
  onRenameVersion: (id: string, name: string) => void
  onReturnToCurrent: () => void
  onSaveVersion: () => void
}

function SessionRow({
  session,
  onViewSession,
}: {
  session: SessionSummary
  onViewSession: (session: SessionSummary) => void
}): JSX.Element {
  const settled = session.state === 'settled'
  const StateIcon = settled ? CircleCheck : Clock3

  return (
    <div
      className={`session-row ${session.state}`}
      onClick={() => onViewSession(session)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.target === event.currentTarget) onViewSession(session)
      }}
      tabIndex={0}
      role="button"
      title={`View ${settled ? 'settled' : 'pending'} session`}
    >
      <span className="spine-sub-node" aria-hidden="true" />
      <span className="session-state" aria-label={`${settled ? 'Settled' : 'Pending'} session`}>
        <StateIcon className="icon" aria-hidden="true" />
      </span>
      <span className="session-label">Session · {relativeDate(session.startedAt)}</span>
      <span className="vcount">{session.count}</span>
    </div>
  )
}

/**
 * The version spine (ADR-0016): Working on top, each named/authored version below (click = view as-of,
 * pencil/name = rename in place), Compare, and the Save version commit gesture.
 */
export function VersionsPane({
  versions,
  allChanges,
  pendingCount,
  historicalVersionId,
  onViewSession,
  onViewVersion,
  onRestoreVersion,
  onOpenCompare,
  onRenameVersion,
  onReturnToCurrent,
  onSaveVersion,
}: VersionsPaneProps): JSX.Element {
  const [renamingVersionId, setRenamingVersionId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const sessionBuckets = useMemo(
    () => sessionsByVersionStamp(sessionsForDocument(allChanges)),
    [allChanges],
  )

  const changeCountByVersion = useMemo(() => {
    const counts = new Map<string, number>()
    for (const change of allChanges) {
      const stamp = change.versionId ?? change.snapshotId
      if (!stamp) continue
      counts.set(stamp, (counts.get(stamp) ?? 0) + 1)
    }
    return counts
  }, [allChanges])

  const openCompare = useCallback(() => {
    if (versions.length === 0) return
    const from = versions.length >= 2 ? versions[1].id : versions[0].id
    const to = versions.length >= 2 ? versions[0].id : 'working'
    onOpenCompare(from, to)
  }, [onOpenCompare, versions])

  const beginRenameVersion = useCallback((version: Version) => {
    setRenamingVersionId(version.id)
    setRenameValue(version.name)
  }, [])
  const cancelRenameVersion = useCallback(() => {
    setRenamingVersionId(null)
    setRenameValue('')
  }, [])
  const submitRenameVersion = useCallback(() => {
    if (!renamingVersionId) return
    const name = renameValue.trim()
    if (!name) return
    onRenameVersion(renamingVersionId, name)
    setRenamingVersionId(null)
    setRenameValue('')
  }, [onRenameVersion, renameValue, renamingVersionId])

  return (
    <section className="version-spine" aria-label="Versions">
      <div className="spine-title">
        <span>Versions</span>
        <button type="button" onClick={openCompare} title="Compare versions" disabled={versions.length === 0}>
          <ArrowLeftRight className="icon" aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="working-version" onClick={onReturnToCurrent}>
        <span className="spine-node current" aria-hidden="true" />
        <span className="vcopy">
          <b>Working</b>
          <small>{dockChangesLabel(pendingCount)}</small>
        </span>
      </button>
      {(sessionBuckets.get(null) ?? []).map((session) => (
        <SessionRow key={session.sessionId} session={session} onViewSession={onViewSession} />
      ))}
      {versions.length > 0 ? (
        versions.map((version) => {
          const count = version.versionId ? changeCountByVersion.get(version.versionId) ?? 0 : 0
          const renaming = renamingVersionId === version.id
          const versionStamp = version.versionId ?? version.snapshotId
          const sessions = versionStamp ? sessionBuckets.get(versionStamp) ?? [] : []
          return (
            <Fragment key={version.id}>
              <div
                className={`version-row${historicalVersionId === version.id ? ' selected' : ''}`}
                onClick={() => onViewVersion(version)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) onViewVersion(version)
                }}
                tabIndex={0}
                role="button"
                title={renaming ? `Renaming ${version.name}` : `View ${version.name} read-only`}
              >
                <span className="spine-node" aria-hidden="true" />
                <span className="avatar">{initials(version.author.name)}</span>
                <span className="vcopy">
                  {renaming ? (
                    <input
                      className="version-rename-input"
                      value={renameValue}
                      autoFocus
                      aria-label="Version name"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          submitRenameVersion()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelRenameVersion()
                        }
                      }}
                      onBlur={submitRenameVersion}
                    />
                  ) : (
                    // Clicking the name opens the version; renaming uses only the pencil, so the row's centre never steals the click.
                    <b>{version.name}</b>
                  )}
                  <small>{version.author.name} · {relativeDate(version.ts)}</small>
                </span>
                <span className="vcount">{count}</span>
                <button
                  type="button"
                  className="version-rename"
                  onClick={(e) => {
                    e.stopPropagation()
                    beginRenameVersion(version)
                  }}
                  title={`Rename ${version.name}`}
                  aria-label={`Rename ${version.name}`}
                >
                  <Pencil className="icon" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="version-rename version-restore"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRestoreVersion(version)
                  }}
                  title={`Restore ${version.name} as the current document`}
                  aria-label={`Restore ${version.name}`}
                >
                  <RotateCcw className="icon" aria-hidden="true" />
                </button>
              </div>
              {sessions.map((session) => (
                <SessionRow key={session.sessionId} session={session} onViewSession={onViewSession} />
              ))}
            </Fragment>
          )
        })
      ) : (
        <div className="version-empty">No saved versions yet.</div>
      )}
      <button className="btn primary save-version-wide" type="button" onClick={onSaveVersion}>
        <Save className="icon" aria-hidden="true" />
        Save version <kbd>⇧⌘S</kbd>
      </button>
    </section>
  )
}
