import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CornerUpLeft, Save, Send, Sparkles, Trash2, X } from 'lucide-react'
import type { Change, Version, VersionCompareEndpointId } from '../../../preload'
import { summariseRun } from '../../../engine'
import { ReviewPane, reviewBuckets } from './ReviewPane'
import { VersionsPane } from './VersionsPane'
import type { SessionSummary } from '../app/session-history'

const DOCK_MIN = 320
const DOCK_MAX = 560

const PROVENANCE_LABEL = {
  agent: 'agent',
  writer: 'yours',
  reviewer: 'reviewer',
} as const

export type ChangeDockProps = {
  /** Every Change in the active run/document. The panel filters and groups it in document order. */
  changes: Change[]
  /** The linked selection (App-owned so the editor and dock share it). */
  selectedId: string | null
  onSelect: (id: string) => void
  onAccept: (id: string) => void | Promise<boolean>
  onAcceptNext: (id: string) => void | Promise<boolean>
  onReject: (id: string) => void | Promise<boolean>
  onHold: (id: string) => void | Promise<boolean>
  onRevertToActive: (change: Change) => void | Promise<void>
  onSendOriginalToScratchpad: (change: Change) => void | Promise<void>
  /** Batch accept the whole pending run, or only its insertions / only its deletions. */
  onAcceptAll: () => void
  onAcceptInsertions: () => void
  onAcceptDeletions: () => void
  /** Multi-select: accept / reject an arbitrary chosen set of changes together. */
  onAcceptMany: (ids: string[]) => void
  onRejectMany: (ids: string[]) => void
  onAcceptSession: (changes: Change[]) => void
  sessionDocumentPath?: string | null
  sessionOpenedAt?: number
  onDiscard: () => void
  onSendBack: (note: string) => void
  /** Pending agent changes whose original text drifted out of the buffer — badged, not mystery cards. */
  unanchoredIds?: string[]
  /** Hand a drifted change back to the agent to redo against the current text. */
  onRevise?: (id: string) => void
  /** Reopen a mistakenly rejected change to pending. */
  onReopen?: (id: string) => void
  onSaveVersion: () => void
  onViewSession: (session: SessionSummary) => void
  onViewVersion: (version: Version) => void
  onRestoreVersion: (version: Version) => void
  onOpenCompare: (fromId: VersionCompareEndpointId, toId: VersionCompareEndpointId) => void
  onRenameVersion: (id: string, name: string) => void
  onReturnToCurrent: () => void
  onClose: () => void
  versions: Version[]
  allChanges: Change[]
  historicalVersionId?: string | null
  initialQuietOpen?: boolean
  initialQuietHidden?: boolean
  surface?: 'full' | 'review' | 'versions'
}

/**
 * The Review & Versions dock: a thin composition over ReviewPane (working changes) and VersionsPane
 * (the version spine). The tabbed chrome renders each pane embedded (`surface: 'review' | 'versions'`);
 * `'full'` is the original standalone dock (resizable aside with header/footer run actions), kept for
 * the pre-tabs layout and its tests.
 */
export function ChangeDock({
  changes,
  selectedId,
  onSelect,
  onAccept,
  onAcceptNext,
  onReject,
  onHold,
  onRevertToActive,
  onSendOriginalToScratchpad,
  onAcceptAll,
  onAcceptInsertions,
  onAcceptDeletions,
  onAcceptMany,
  onRejectMany,
  onAcceptSession,
  sessionDocumentPath,
  sessionOpenedAt,
  onDiscard,
  onSendBack,
  unanchoredIds,
  onRevise,
  onReopen,
  onSaveVersion,
  onViewSession,
  onViewVersion,
  onRestoreVersion,
  onOpenCompare,
  onRenameVersion,
  onReturnToCurrent,
  onClose,
  versions,
  allChanges,
  historicalVersionId,
  initialQuietOpen = false,
  initialQuietHidden = false,
  surface = 'full',
}: ChangeDockProps): JSX.Element {
  const [notesOpen, setNotesOpen] = useState(false)
  const [note, setNote] = useState('')
  const [width, setWidth] = useState(384)
  const asideRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!selectedId) return
    listRef.current?.querySelector(`[data-cid="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  // ⇧⌘R / ⇧⌘⌫ live in ReviewPane's run bar now (one mounted instance) — registering them here ran the
  // handler once per embedded dock instance, firing run actions twice per keypress.

  const summary = useMemo(() => summariseRun(changes), [changes])
  const buckets = useMemo(() => reviewBuckets(changes), [changes])

  const onSplitterDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = asideRef.current?.getBoundingClientRect().width ?? width
    const move = (ev: PointerEvent): void => {
      const next = Math.max(DOCK_MIN, Math.min(DOCK_MAX, startW + (startX - ev.clientX)))
      setWidth(next)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.style.cursor = 'col-resize'
  }, [width])

  const provenanceSummary = (['agent', 'reviewer'] as const)
    .filter((key) => summary.byProvenance[key] > 0)
    .map((key) => `${summary.byProvenance[key]} ${PROVENANCE_LABEL[key]}`)
    .join(' · ')

  const versionsSection = (
    <VersionsPane
      versions={versions}
      allChanges={allChanges}
      pendingCount={summary.total}
      historicalVersionId={historicalVersionId}
      onViewSession={onViewSession}
      onViewVersion={onViewVersion}
      onRestoreVersion={onRestoreVersion}
      onOpenCompare={onOpenCompare}
      onRenameVersion={onRenameVersion}
      onReturnToCurrent={onReturnToCurrent}
      onSaveVersion={onSaveVersion}
    />
  )

  const reviewSection = (
    <ReviewPane
      changes={changes}
      selectedId={selectedId}
      onSelect={onSelect}
      onAccept={onAccept}
      onAcceptNext={onAcceptNext}
      onReject={onReject}
      onHold={onHold}
      onRevertToActive={onRevertToActive}
      onSendOriginalToScratchpad={onSendOriginalToScratchpad}
      onAcceptAll={onAcceptAll}
      onAcceptInsertions={onAcceptInsertions}
      onAcceptDeletions={onAcceptDeletions}
      onAcceptMany={onAcceptMany}
      onRejectMany={onRejectMany}
      onAcceptSession={onAcceptSession}
      sessionDocumentPath={sessionDocumentPath}
      sessionOpenedAt={sessionOpenedAt}
      onDiscard={onDiscard}
      onSendBack={onSendBack}
      unanchoredIds={unanchoredIds}
      onRevise={onRevise}
      onReopen={onReopen}
      initialQuietOpen={initialQuietOpen}
      initialQuietHidden={initialQuietHidden}
    />
  )

  if (surface !== 'full') {
    return (
      <div className={`change-dock embedded ${surface === 'versions' ? 'versions-only' : 'review-only'}`} aria-label={surface === 'versions' ? 'Versions' : 'Working changes'}>
        <div className="rlist cardlist" ref={listRef}>
          {surface === 'versions' ? versionsSection : reviewSection}
          <div className="comments-lane" aria-hidden="true" />
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="dock-splitter" onPointerDown={onSplitterDown} role="separator" aria-label="Resize Changes panel" />
      <aside className="change-dock review-dock" ref={asideRef} style={{ width }} aria-label="Review and save version">
        <header className="rhead">
          <div className="top">
            <h2>
              <Sparkles className="icon spark" aria-hidden="true" />
              Review &amp; save version
            </h2>
            <button className="dock-close x" onClick={onClose} title="Keep reviewing in the text" aria-label="Close Changes">
              <X className="icon" aria-hidden="true" />
            </button>
          </div>
          <p className="sub">
            Keep / Change settle into the version; held pairs carry across. <b>{buckets.provisionalChanges.length} provisional</b>
            {buckets.quietFixes.length > 0 ? <> · <b>{buckets.quietFixes.length} quiet</b></> : null}
            {buckets.heldChanges.length > 0 ? <> · <b>{buckets.heldChanges.length} held</b></> : null}
            {provenanceSummary ? <> · <b>{provenanceSummary}</b></> : null}
            {summary.yours > 0 ? <> · <b>{summary.yours} yours</b></> : null}
          </p>
        </header>

        <div className="rlist cardlist" ref={listRef}>
          {versionsSection}
          {reviewSection}
          <div className="comments-lane" aria-hidden="true" />
        </div>

        <footer className="rfoot">
          {notesOpen && (
            <div className="notes open">
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What should the agent change before you save?"
                aria-label="Notes for the agent"
              />
              <div className="nrow">
                <button className="btn ghost" type="button" onClick={() => setNotesOpen(false)}>Cancel</button>
                <button
                  className="btn send"
                  type="button"
                  onClick={() => {
                    onSendBack(note)
                    setNotesOpen(false)
                  }}
                  disabled={note.trim() === ''}
                >
                  <Send className="icon" aria-hidden="true" />
                  Send to agent
                </button>
              </div>
            </div>
          )}
          <div className="frow">
            <button className="btn danger" type="button" onClick={onDiscard} title="Reject the pending run">
              <Trash2 className="icon" aria-hidden="true" />
              Discard <kbd>⇧⌘⌫</kbd>
            </button>
            <button className="btn" type="button" onClick={() => setNotesOpen(true)}>
              <CornerUpLeft className="icon" aria-hidden="true" />
              Send back <kbd>⇧⌘R</kbd>
            </button>
            <button className="btn primary" type="button" onClick={onSaveVersion}>
              <Save className="icon" aria-hidden="true" />
              Save version <kbd>⇧⌘S</kbd>
            </button>
          </div>
        </footer>
      </aside>
    </>
  )
}
