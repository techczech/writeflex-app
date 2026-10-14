import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, CornerUpLeft, Glasses, Send, Sparkles, StickyNote, Trash2 } from 'lucide-react'
import type { Change } from '../../../preload'
import {
  HeldCard,
  OtherChangeRow,
  ProvisionalCard,
  QuietFixRow,
  changeCategoryLabel,
  isDeletionChange,
  isInsertionChange,
  relativeTime,
  type ChangeCardActions,
} from './change-cards'

export type ReviewPaneProps = {
  /** Every Change in the active run/document. The pane filters and groups it in document order. */
  changes: Change[]
  /** The linked selection (App-owned so the editor and pane share it). */
  selectedId: string | null
  /** Batch accept the whole pending run, or only its insertions / only its deletions. */
  onAcceptAll: () => void
  onAcceptInsertions: () => void
  onAcceptDeletions: () => void
  /** Multi-select: accept / reject an arbitrary chosen set of changes together. */
  onAcceptMany: (ids: string[]) => void
  onRejectMany: (ids: string[]) => void
  /** Settle this document's pending writer records by status only. */
  onAcceptSession: (changes: Change[]) => void
  /** Active document identity and run-scoped open time for the locked session copy. */
  sessionDocumentPath?: string | null
  sessionOpenedAt?: number
  /** Run-level actions (the pinned run bar, approved review-run-actions v1-A). */
  onDiscard: () => void
  onSendBack: (note: string) => void
  /** Pending agent changes whose original text drifted out of the buffer (no inline rendering). */
  unanchoredIds?: string[]
  /** Hand a drifted change back to the agent to redo against the current text. */
  onRevise?: (id: string) => void
  /** Reopen a mistakenly rejected change to pending. */
  onReopen?: (id: string) => void
  initialQuietOpen?: boolean
  initialQuietHidden?: boolean
} & ChangeCardActions

/** The pending-run buckets the review surface groups changes into (quiet / held / provisional / yours /
 *  other), shared with the dock header's counts. */
export function reviewBuckets(changes: Change[]): {
  quietFixes: Change[]
  heldChanges: Change[]
  provisionalChanges: Change[]
  writerChanges: Change[]
  otherWorkingChanges: Change[]
  acceptedChanges: Change[]
  rejectedChanges: Change[]
} {
  const quietFixes = changes.filter((change) => change.editClass === 'copy' && change.status !== 'rejected')
  const heldChanges = changes.filter((change) => change.status === 'held')
  const provisionalChanges = changes.filter(
    (change) => change.status === 'pending' && change.provenance === 'agent' && (change.editClass === 'content' || change.editClass === 'insert'),
  )
  // Pending only: once folded (accepted) an edit leaves the "to fold" list and stays in the ledger for
  // the next version. otherWorkingChanges is pending-only too, so a folded edit never leaks there.
  const writerChanges = changes.filter(
    (change) => change.provenance === 'writer' && change.editClass !== 'copy' && change.status === 'pending',
  )
  const used = new Set([
    ...quietFixes.map((change) => change.id),
    ...heldChanges.map((change) => change.id),
    ...provisionalChanges.map((change) => change.id),
    ...writerChanges.map((change) => change.id),
  ])
  const otherWorkingChanges = changes.filter((change) => !used.has(change.id) && change.status === 'pending')
  const acceptedChanges = changes.filter((change) => change.status === 'accepted' && change.editClass !== 'copy')
  // Rejected AGENT proposals fold away with a Reopen escape hatch (a mis-click is not a one-way door).
  // A rejected writer edit already reverted the buffer text, so reopening it has nothing to restore.
  const rejectedChanges = changes.filter((change) => change.status === 'rejected' && change.provenance !== 'writer')
  return { quietFixes, heldChanges, provisionalChanges, writerChanges, otherWorkingChanges, acceptedChanges, rejectedChanges }
}

/**
 * The working-changes review surface (foundation-v2): quiet-folded copy edits, held pairs, provisional
 * cards (agent proposals + your edits, same verbs), batch accept, and checkbox multi-select.
 */
export function ReviewPane({
  changes,
  selectedId,
  onSelect,
  onAccept,
  onAcceptNext,
  onReject,
  onHold,
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
  onRevertToActive,
  onSendOriginalToScratchpad,
  initialQuietOpen = false,
  initialQuietHidden = false,
}: ReviewPaneProps): JSX.Element {
  const [quietOpen, setQuietOpen] = useState(initialQuietOpen)
  const [quietHidden, setQuietHidden] = useState(initialQuietHidden)
  const [selectedForBatch, setSelectedForBatch] = useState<ReadonlySet<string>>(() => new Set())
  const [notesOpen, setNotesOpen] = useState(false)
  const [note, setNote] = useState('')

  const { quietFixes, heldChanges, provisionalChanges, writerChanges, otherWorkingChanges, acceptedChanges, rejectedChanges } = useMemo(
    () => reviewBuckets(changes),
    [changes],
  )
  const [rejectedOpen, setRejectedOpen] = useState(false)
  const sessionFilename = useMemo(() => {
    if (!sessionDocumentPath) return 'this document'
    const cut = Math.max(sessionDocumentPath.lastIndexOf('/'), sessionDocumentPath.lastIndexOf('\\'))
    return sessionDocumentPath.slice(cut + 1)
  }, [sessionDocumentPath])

  // The pending run for batch accept — every reviewable pending change (moves excluded; they replay
  // differently). insertion/deletion counts drive the by-kind buttons and hide them when not a subset.
  const pendingRun = useMemo(
    () => changes.filter((change) => !change.snapshotId && change.status === 'pending' && change.editClass !== 'move'),
    [changes],
  )
  const insertionCount = useMemo(() => pendingRun.filter(isInsertionChange).length, [pendingRun])
  const deletionCount = useMemo(() => pendingRun.filter(isDeletionChange).length, [pendingRun])

  // Multi-select works on the reviewable cards (agent proposals + your edits). Prune the selection to
  // what's still present so a resolved change never lingers as a phantom selection.
  const selectableIds = useMemo(
    () => new Set([...provisionalChanges, ...writerChanges].map((c) => c.id)),
    [provisionalChanges, writerChanges],
  )
  useEffect(() => {
    setSelectedForBatch((prev) => {
      const next = new Set([...prev].filter((id) => selectableIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [selectableIds])
  const toggleBatchSelect = useCallback((id: string) => {
    setSelectedForBatch((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearBatchSelect = useCallback(() => setSelectedForBatch(new Set()), [])
  const acceptSelected = useCallback(() => { onAcceptMany([...selectedForBatch]); clearBatchSelect() }, [onAcceptMany, selectedForBatch, clearBatchSelect])
  const rejectSelected = useCallback(() => { onRejectMany([...selectedForBatch]); clearBatchSelect() }, [onRejectMany, selectedForBatch, clearBatchSelect])

  // Run-level keyboard paths, mirroring the run bar exactly: ⇧⌘A accepts (all, or the selection when
  // one exists) · ⇧⌘⌫ discards (run, or the selection) · ⇧⌘R opens send-back. Registered HERE — the
  // one mounted review surface — not in ChangeDock, whose two embedded instances used to
  // double-register the handler.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || e.altKey) return
      if (e.key.toLowerCase() === 'r') {
        e.preventDefault()
        setNotesOpen(true)
      } else if (e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (selectedForBatch.size > 0) acceptSelected()
        else if (pendingRun.length > 0) onAcceptAll()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (selectedForBatch.size > 0) rejectSelected()
        else onDiscard()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onDiscard, onAcceptAll, acceptSelected, rejectSelected, selectedForBatch, pendingRun])

  const cardActions = { onSelect, onAccept, onAcceptNext, onReject, onHold, onRevertToActive, onSendOriginalToScratchpad }
  const unanchored = useMemo(() => new Set(unanchoredIds ?? []), [unanchoredIds])
  const provisional = (change: Change): JSX.Element => (
    <ProvisionalCard
      key={change.id}
      change={change}
      selected={selectedId === change.id}
      picked={selectedForBatch.has(change.id)}
      onTogglePick={toggleBatchSelect}
      unanchored={unanchored.has(change.id)}
      onRevise={onRevise}
      {...cardActions}
    />
  )

  if (changes.length === 0) {
    return (
      <div className="dock-empty calm">
        <Sparkles className="icon" aria-hidden="true" />
        <p>No working changes.</p>
        <span>Tracked edits and agent proposals will gather here when there is something to review.</span>
      </div>
    )
  }

  return (
    <section className="working-changes" aria-label="Working changes">
      <div className="worklbl">
        <span>Working changes</span>
        {quietFixes.length > 0 && (
          <button type="button" id="hidequiet" onClick={() => setQuietHidden((value) => !value)}>
            {quietHidden ? 'Show quiet fixes' : 'Hide quiet fixes'}
          </button>
        )}
      </div>

      {/* The top bar carries the SELECTION status and the by-kind subsets; whole-run accept and the
          run-level actions live in the pinned run bar below (approved review-run-actions v1-A). */}
      {selectedForBatch.size > 0 ? (
        <div className="batch-bar selecting" role="group" aria-label="Selected changes">
          <span className="batch-count">{selectedForBatch.size} selected</span>
          <button type="button" className="batch-btn ghost" onClick={clearBatchSelect} title="Clear the selection">
            Clear
          </button>
        </div>
      ) : pendingRun.length >= 2 && (insertionCount > 0 || deletionCount > 0) ? (
        <div className="batch-bar" role="group" aria-label="Accept changes by kind">
          {insertionCount > 0 && insertionCount < pendingRun.length && (
            <button type="button" className="batch-btn" onClick={onAcceptInsertions} title="Accept only the insertions">
              Insertions {insertionCount}
            </button>
          )}
          {deletionCount > 0 && deletionCount < pendingRun.length && (
            <button type="button" className="batch-btn" onClick={onAcceptDeletions} title="Accept only the deletions">
              Deletions {deletionCount}
            </button>
          )}
        </div>
      ) : null}

      {quietFixes.length > 0 && !quietHidden && (
        <>
          <button
            type="button"
            className={`quietrow${quietOpen ? ' open' : ''}`}
            id="quietrow"
            onClick={() => setQuietOpen((value) => !value)}
            aria-expanded={quietOpen}
            aria-controls="quietlist"
          >
            <Check className="icon" aria-hidden="true" />
            <span><b>{quietFixes.length} quiet fixes</b> · typos &amp; grammar, {quietFixes.some((f) => f.status === 'pending') ? 'fold in when you save — click to review' : 'applied'}</span>
            <ChevronRight className="chev" aria-hidden="true" />
          </button>
          {quietOpen && (
            <div className="quietlist open" id="quietlist">
              {quietFixes.map((change) => (
                <QuietFixRow key={change.id} change={change} onSelect={onSelect} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
              ))}
            </div>
          )}
        </>
      )}

      {heldChanges.map((change) => (
        <HeldCard key={change.id} change={change} selected={selectedId === change.id} onSelect={onSelect} onAccept={onAccept} onAcceptNext={onAcceptNext} onReject={onReject} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
      ))}
      {provisionalChanges.map(provisional)}

      {writerChanges.length > 0 && (
        <section className="your-folded rv-session">
          <div className="rv-session-head">
            <div className="rv-title"><Glasses className="icon sm" aria-hidden="true" />Unreviewed edits</div>
            <div className="rv-sub">
              Pending edits to <b>{sessionFilename}</b>.
            </div>
          </div>
          {/* Your own edits review exactly like an agent proposal: Keep old / Change to new / Hold both,
              one at a time. "Change to new" folds the edit into the document; "Keep old" reverts it. */}
          {writerChanges.map(provisional)}
          <div className="rv-foot">
            <button type="button" className="rv-accept" onClick={() => onAcceptSession(writerChanges)}>
              <Check className="icon" aria-hidden="true" />
              Accept session
            </button>
            <div className="rv-note">Settles this session. <b>Your text is unchanged</b> — it was final the moment you typed it. Reject is the only thing that rewrites.</div>
          </div>
        </section>
      )}

      {otherWorkingChanges.length > 0 && (
        <section className="other-review-changes">
          <div className="ylabel">Other review edits</div>
          {otherWorkingChanges.map((change) => (
            <OtherChangeRow key={change.id} change={change} selected={selectedId === change.id} onSelect={onSelect} onAccept={onAccept} onAcceptNext={onAcceptNext} onReject={onReject} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
          ))}
        </section>
      )}

      {acceptedChanges.length > 0 && (
        <section className="other-review-changes accepted-changes">
          <div className="ylabel">Accepted edits</div>
          {acceptedChanges.map((change) => (
            <OtherChangeRow key={change.id} change={change} selected={selectedId === change.id} onSelect={onSelect} onAccept={onAccept} onAcceptNext={onAcceptNext} onReject={onReject} onRevertToActive={onRevertToActive} onSendOriginalToScratchpad={onSendOriginalToScratchpad} />
          ))}
        </section>
      )}

      {rejectedChanges.length > 0 && (
        <>
          <button
            type="button"
            className={`quietrow rejectedrow${rejectedOpen ? ' open' : ''}`}
            onClick={() => setRejectedOpen((value) => !value)}
            aria-expanded={rejectedOpen}
          >
            <Trash2 className="icon" aria-hidden="true" />
            <span><b>{rejectedChanges.length} rejected</b> · reopen if that was a mistake</span>
            <ChevronRight className="chev" aria-hidden="true" />
          </button>
          {rejectedOpen && (
            <div className="quietlist open">
              {[...rejectedChanges].sort((a, b) => b.ts - a.ts).map((change) => (
                <div key={change.id} className="rejected-row" data-cid={change.id}>
                  <button type="button" className="rejected-main" onClick={() => onSelect(change.id)} title="Show in text">
                    <span className="rejected-kicker">{changeCategoryLabel(change)} · {relativeTime(change.ts)}</span>
                    <span className="rejected-diff"><s>{change.oldText || '—'}</s> <i>{change.newText || '—'}</i></span>
                  </button>
                  {onReopen && (
                    <button type="button" className="ca reopen" onClick={() => onReopen(change.id)}>Reopen</button>
                  )}
                  <button type="button" className="ca" onClick={() => void onSendOriginalToScratchpad(change)}>
                    <StickyNote className="icon" aria-hidden="true" />
                    Send original to Scratchpad
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* The pinned run foot (approved review-run-actions v1-A): run-level actions, always at the pane's
          foot, morphing to act on the SELECTION when one exists. Send back expands its notes inline,
          hugging the bar inside the same sticky block. */}
      <div className="run-foot">
      {notesOpen && (
        <div className="run-notes">
          <textarea
            value={note}
            autoFocus
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
                setNote('')
              }}
              disabled={note.trim() === ''}
            >
              <Send className="icon" aria-hidden="true" />
              Send to agent
            </button>
          </div>
        </div>
      )}
      <div className="run-bar" role="group" aria-label="Run actions">
        {selectedForBatch.size > 0 ? (
          <>
            <button type="button" className="runb keep" onClick={acceptSelected} title="Accept the selected changes (⇧⌘A)">
              <Check className="icon" aria-hidden="true" />
              Accept selected ({selectedForBatch.size})
            </button>
            <button type="button" className="runb danger" onClick={rejectSelected} title="Reject the selected changes (⇧⌘⌫)">
              <Trash2 className="icon" aria-hidden="true" />
              Discard selected
            </button>
          </>
        ) : (
          <>
            <button type="button" className="runb keep" onClick={onAcceptAll} disabled={pendingRun.length === 0} title="Accept every pending change (⇧⌘A)">
              <Check className="icon" aria-hidden="true" />
              Accept all {pendingRun.length}
            </button>
            <button type="button" className="runb danger" onClick={onDiscard} disabled={pendingRun.length === 0} title="Reject the whole pending run (⇧⌘⌫)">
              <Trash2 className="icon" aria-hidden="true" />
              Discard run
            </button>
          </>
        )}
        <button type="button" className="runb sendback" onClick={() => setNotesOpen((open) => !open)} title="Return notes to the agent before saving (⇧⌘R)">
          <CornerUpLeft className="icon" aria-hidden="true" />
          Send back
        </button>
      </div>
      </div>
    </section>
  )
}
