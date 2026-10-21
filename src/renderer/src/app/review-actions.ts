import { useCallback } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { Change, FileReadResult, Suggestion } from '../../../preload'
import type { EditorHandle } from '../components/EditorPane'
import type { InlineAction } from '../editor/inline-changes'
import type { WriterChangeResolution } from '../editor/writer-review'
import { findLiveSuggestionForChange } from './change-suggestion-match'
import { isDeletionChange, isInsertionChange } from '../components/change-cards'

/**
 * The ledger-facing calls the review actions make. This is deliberately the ONE seam between the review
 * UI and the change ledger's backing store: when the ledger moves upstream into Bridle (and its API
 * evolves), only this contract and App's one-line binding change — no handler logic.
 */
export type ReviewLedgerPort = {
  resolveChange: (id: string, action: 'accept' | 'reject') => Promise<{ applied: boolean; file?: FileReadResult; written?: string; message?: string; changedOnDisk?: { path: string; diskText: string | null } }>
  setChangeStatus: (id: string, status: 'pending' | 'accepted' | 'rejected' | 'held') => Promise<unknown>
}

export type ReviewActionDeps = {
  ledger: ReviewLedgerPort
  /** The active file's Change list (dock-gated) and the full list the handlers search. */
  changes: Change[]
  dockChanges: Change[]
  /** Live staged suggestions — a Change with a live suggestion resolves through the suggestion pipeline. */
  suggestions: Suggestion[]
  editorRef: RefObject<EditorHandle | null>
  /** Per-path localId↔storeId table for writer edits (owned by App's writer-change sync). */
  recordedWriterChanges: MutableRefObject<Map<string, Map<string, string>>>
  acceptSuggestion: (s: Suggestion, change: Change) => Promise<boolean>
  rejectSuggestion: (s: Suggestion, change: Change) => Promise<boolean>
  savePath: (path: string) => Promise<boolean>
  reloadChanges: () => Promise<unknown>
  /** Re-list Changes + Suggestions and project them after a resolved file has reached the buffer. */
  refreshInlineChangesAfterReconcile: () => Promise<void>
  flash: (message: string) => void
  handleAgentWorkspaceChange: () => void
  reconcileAppliedFile: (file: FileReadResult) => void | Promise<void>
  /** An accept of a change in `path`, as a route of the document owner (App.tsx, parcel 2a): the buffer is
   *  written until saved, `resolve` runs holding the document's queue, and the result reaches the buffer
   *  (the receipt as the baseline when the editor took it as an undoable edit, else a reconcile).
   *  `not-saved`: the buffer could not be saved first, and nothing was asked of main. */
  acceptThroughOwner: <A extends { applied: boolean; file?: FileReadResult; written?: string; message?: string }>(path: string, id: string, resolve: () => Promise<A>) =>
    Promise<{ status: 'acted'; result: A; recorded: boolean } | { status: 'not-saved'; message: string }>
  /** Run a call to main that resolves a change in `path` in the document's queue, in order with the rest. */
  inDocumentQueue: <T>(path: string, run: () => Promise<T>) => Promise<T>
  focusComposer: (text?: string) => void
  setChangesOpen: (open: boolean) => void
  selectChange: (id: string) => void
  settleChange: (id: string, advance: boolean) => void
  /** An Accept main refused because the change could not be placed (ticket 14): the item still waits, and its card
   *  says "Could not be applied" with this reason (ticket 06). Not called when the buffer could not be saved first. */
  onAcceptRefused?: (id: string, reason: string) => void
}

/** A few of a change's words, for naming it in a message. */
function wordsForMessage(change: Change | undefined): string {
  const text = (change?.oldText || change?.newText || change?.summary || '').replace(/\s+/g, ' ').trim()
  return `“${text.length > 40 ? `${text.slice(0, 40)}…` : text}”`
}

/**
 * What a batch Accept says (ticket 06, from 14): only the changes that were applied are counted, and the ones that
 * could not be applied are named (at most three, then how many more). Never "Accepted N" over refusals.
 */
export function acceptedSummary(accepted: number, refused: readonly string[]): string {
  const counted = accepted === 1 ? 'Accepted 1 change' : `Accepted ${accepted} changes`
  if (refused.length === 0) return counted
  const named = refused.slice(0, 3).join(', ')
  const rest = refused.length > 3 ? ` and ${refused.length - 3} more` : ''
  const failed = `${refused.length} could not be applied: ${named}${rest}`
  return accepted === 0 ? `Nothing was accepted. ${failed}.` : `${counted}. ${failed}.`
}

export type ReviewActions = {
  acceptChange: (id: string, advance?: boolean) => Promise<boolean>
  acceptAndNext: (id: string) => Promise<boolean>
  rejectChange: (id: string) => Promise<boolean>
  holdChange: (id: string) => Promise<boolean>
  acceptAllPending: () => void
  acceptInsertions: () => void
  acceptDeletions: () => void
  /** Resolves when every id is resolved (one at a time, in document order), the list reloaded and the toast shown. */
  acceptMany: (ids: string[]) => Promise<void>
  rejectMany: (ids: string[]) => Promise<void>
  discardRun: () => void
  sendRunBack: (note: string) => void
  reviseChange: (id?: string) => void
  /** Reopen a mistakenly rejected change to pending (the mis-click must not be a one-way door). `message`
   *  replaces the "Suggestion reopened" notice (a caller that reopens because something else failed says why). */
  reopenChange: (id: string, message?: string) => Promise<void>
  onInlineAction: (id: string, act: InlineAction) => void
}

/** Keep the last inline projection on the post-reconcile document, regardless of IPC push order. */
export async function reconcileResolvedFile(
  file: FileReadResult,
  reconcileAppliedFile: (file: FileReadResult) => void | Promise<void>,
  refreshInlineChangesAfterReconcile: () => Promise<void>,
): Promise<void> {
  await reconcileAppliedFile(file)
  await refreshInlineChangesAfterReconcile()
}

/**
 * The review-action domain: every way a change gets resolved — singly (accept/reject/hold, routed by who
 * made it), in batches (all / by kind / multi-select), as a whole run (discard / send back), or handed
 * back to the agent for amendment (revise). Extracted from App.tsx as the first step of the incremental
 * decomposition; behaviour is unchanged, the handlers just live with their domain.
 */
export function useReviewActions(deps: ReviewActionDeps): ReviewActions {
  const {
    ledger,
    changes,
    dockChanges,
    suggestions,
    editorRef,
    recordedWriterChanges,
    acceptSuggestion,
    rejectSuggestion,
    savePath,
    reloadChanges,
    refreshInlineChangesAfterReconcile,
    flash,
    handleAgentWorkspaceChange,
    reconcileAppliedFile,
    acceptThroughOwner,
    inDocumentQueue,
    focusComposer,
    setChangesOpen,
    selectChange,
    settleChange,
    onAcceptRefused,
  } = deps

  const suggestionForChange = useCallback(
    (id: string): Suggestion | undefined => findLiveSuggestionForChange(changes, suggestions, id),
    [changes, suggestions],
  )

  // A writer edit lives as a track-change mark in the buffer, so resolving it means collapsing that mark
  // (accept keeps new, reject restores old, hold keeps both) — the agent accept path only touches the
  // ledger and would leave the tracking on the page. Map the store id back to the editor mark via the
  // per-path localId↔storeId table, resolve in the buffer, record the decision, and persist the result.
  const resolveWriterEditById = useCallback(
    async (id: string, action: WriterChangeResolution): Promise<boolean> => {
      const change = changes.find((c) => c.id === id)
      if (!change) return false
      const pathMap = recordedWriterChanges.current.get(change.path)
      const localId = pathMap ? [...pathMap.entries()].find(([, storeId]) => storeId === id)?.[0] : undefined
      if (localId) {
        editorRef.current?.resolveWriterChange(change.path, localId, action)
        pathMap?.delete(localId)
      }
      await ledger.setChangeStatus(id, action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'held')
      if (action !== 'hold') await savePath(change.path) // accept/reject change the buffer text; persist it
      await reloadChanges()
      return true
    },
    [changes, ledger, editorRef, recordedWriterChanges, savePath, reloadChanges],
  )
  const isWriterChange = useCallback((id: string) => changes.find((c) => c.id === id)?.provenance === 'writer', [changes])

  const acceptChange = useCallback(
    async (id: string, advance = false): Promise<boolean> => {
      const s = suggestionForChange(id)
      const change = changes.find((candidate) => candidate.id === id)
      if (s) {
        const resolved = change ? await acceptSuggestion(s, change) : false
        if (resolved) settleChange(id, advance)
        return resolved
      }
      if (isWriterChange(id)) {
        const resolved = await resolveWriterEditById(id, 'accept')
        if (resolved) settleChange(id, advance)
        return resolved
      }
      // As acceptSuggestion: the buffer and the baseline take what main wrote, not the readback (Muse M2,
      // round 2). Without this the baseline stays at the pre-accept text, and undoing the accept reads
      // as "equals the disk" while the disk holds the accepted text. With no Change on record here there
      // is no document to hold: main is asked directly.
      let res: Awaited<ReturnType<ReviewLedgerPort['resolveChange']>>
      let recorded = false
      if (change) {
        const accepted = await acceptThroughOwner(change.path, id, () => ledger.resolveChange(id, 'accept'))
        if (accepted.status !== 'acted') {
          flash(accepted.message)
          return false
        }
        res = accepted.result
        recorded = accepted.recorded
      } else {
        res = await ledger.resolveChange(id, 'accept')
      }
      if (!res.applied) {
        const reason = res.message ?? 'This suggestion is no longer live — ask the agent to redo the edit.'
        flash(reason)
        onAcceptRefused?.(id, reason)
        return false
      }
      handleAgentWorkspaceChange()
      if (recorded) await refreshInlineChangesAfterReconcile()
      else if (res.file && !change) await reconcileResolvedFile(res.file, reconcileAppliedFile, refreshInlineChangesAfterReconcile)
      else if (res.file) await refreshInlineChangesAfterReconcile() // reconciled in the owner's route
      else await reloadChanges()
      if (res.message) flash(res.message)
      settleChange(id, advance)
      return true
    },
    [suggestionForChange, changes, acceptSuggestion, isWriterChange, resolveWriterEditById, ledger, handleAgentWorkspaceChange, reconcileAppliedFile, acceptThroughOwner, refreshInlineChangesAfterReconcile, reloadChanges, flash, settleChange, onAcceptRefused],
  )
  const acceptAndNext = useCallback((id: string) => acceptChange(id, true), [acceptChange])
  const rejectChange = useCallback(
    async (id: string): Promise<boolean> => {
      const s = suggestionForChange(id)
      const change = changes.find((candidate) => candidate.id === id)
      if (s) {
        const resolved = change ? await rejectSuggestion(s, change) : false
        if (resolved) settleChange(id, false)
        return resolved
      }
      if (isWriterChange(id)) {
        const resolved = await resolveWriterEditById(id, 'reject')
        if (resolved) settleChange(id, false)
        return resolved
      }
      const res = change ? await inDocumentQueue(change.path, () => ledger.resolveChange(id, 'reject')) : await ledger.resolveChange(id, 'reject')
      if (!res.applied) {
        flash(res.message ?? 'This suggestion is no longer live — ask the agent to redo the edit.')
        return false
      }
      const recorded = change ? editorRef.current?.recordSuggestionResolution(change.path, id, 'reject') === true : false
      if (recorded) await refreshInlineChangesAfterReconcile()
      else if (res.file) await reconcileResolvedFile(res.file, reconcileAppliedFile, refreshInlineChangesAfterReconcile)
      else await reloadChanges()
      flash(res.message ?? 'Suggestion discarded')
      settleChange(id, false)
      return true
    },
    [suggestionForChange, changes, rejectSuggestion, isWriterChange, resolveWriterEditById, ledger, editorRef, inDocumentQueue, reconcileAppliedFile, refreshInlineChangesAfterReconcile, reloadChanges, flash, settleChange],
  )
  const holdChange = useCallback(
    async (id: string): Promise<boolean> => {
      // A card that creates a file has no "both readings" to hold open: Hold does nothing there.
      if (changes.find((c) => c.id === id)?.newFile) return false
      if (isWriterChange(id)) return resolveWriterEditById(id, 'hold')
      await ledger.setChangeStatus(id, 'held')
      await reloadChanges()
      flash('Held both readings')
      return true
    },
    [changes, isWriterChange, resolveWriterEditById, ledger, reloadChanges, flash],
  )

  // Batch accept: resolve every pending change matching a predicate, in document order, one at a time so
  // each agent edit re-anchors against the buffer the previous accept left behind. "Accept all" is the
  // whole batch; the by-kind variants let the writer take just the insertions or just the deletions.
  const acceptPendingWhere = useCallback(
    async (pred: (c: Change) => boolean): Promise<void> => {
      const ids = dockChanges
        .filter((c) => c.status === 'pending' && c.editClass !== 'move' && pred(c))
        .map((c) => c.id)
      if (ids.length === 0) return
      let accepted = 0
      const refused: string[] = []
      for (const id of ids) {
        if (await acceptChange(id)) accepted += 1
        else refused.push(wordsForMessage(dockChanges.find((c) => c.id === id)))
      }
      await reloadChanges()
      flash(acceptedSummary(accepted, refused))
    },
    [dockChanges, acceptChange, reloadChanges, flash],
  )
  const acceptAllPending = useCallback(() => void acceptPendingWhere(() => true), [acceptPendingWhere])
  const acceptInsertions = useCallback(() => void acceptPendingWhere(isInsertionChange), [acceptPendingWhere])
  const acceptDeletions = useCallback(() => void acceptPendingWhere(isDeletionChange), [acceptPendingWhere])

  // Multi-select: resolve an arbitrary set of chosen changes together, in document order so each accept
  // re-anchors against the buffer the previous one left. One reload + one toast for the whole set.
  const resolveMany = useCallback(
    async (ids: string[], action: 'accept' | 'reject'): Promise<void> => {
      if (ids.length === 0) return
      const order = new Map(dockChanges.map((c, i) => [c.id, i]))
      const sorted = [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      let done = 0
      const refused: string[] = []
      for (const id of sorted) {
        const ok = action === 'accept' ? await acceptChange(id) : await rejectChange(id)
        if (ok) done += 1
        else refused.push(wordsForMessage(dockChanges.find((c) => c.id === id)))
      }
      await reloadChanges()
      // Only what was settled is counted; an Accept that could not be applied is named, never counted.
      flash(action === 'accept' ? acceptedSummary(done, refused) : `Rejected ${done} change${done === 1 ? '' : 's'}${refused.length > 0 ? `. ${refused.length} could not be declined.` : ''}`)
    },
    [dockChanges, acceptChange, rejectChange, reloadChanges, flash],
  )
  const acceptMany = useCallback((ids: string[]) => resolveMany(ids, 'accept'), [resolveMany])
  const rejectMany = useCallback((ids: string[]) => resolveMany(ids, 'reject'), [resolveMany])

  const discardRun = useCallback(() => {
    void (async () => {
      const pending = dockChanges.filter((change) => change.status === 'pending')
      for (const change of pending) {
        if (!(await rejectChange(change.id))) return
      }
      setChangesOpen(false)
      flash(pending.length > 0 ? 'Run discarded' : 'No pending changes to discard')
    })()
  }, [dockChanges, rejectChange, setChangesOpen, flash])

  const sendRunBack = useCallback(
    (note: string) => {
      const trimmed = note.trim()
      if (!trimmed) return
      focusComposer(`Revise this review run before I save a version:\n\n${trimmed}`)
      flash('Comments returned to the agent composer')
    },
    [focusComposer, flash],
  )

  // Revise = amend a specific agent edit: pre-compose a request that names the edit and tells the agent to
  // retract it (suggestions.retract) and stage the correction, rather than piling a new edit on top. The writer
  // finishes the note. Without an id (or for a non-agent edit) it just focuses the composer.
  const reviseChange = useCallback(
    (id?: string) => {
      const change = id ? changes.find((c) => c.id === id) : undefined
      if (!change || change.provenance !== 'agent') {
        focusComposer()
        return
      }
      const clip = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text)
      const what = change.editClass === 'insert' || !change.oldText
        ? `the text you inserted (“${clip(change.newText)}”)`
        : !change.newText
          ? `your deletion of “${clip(change.oldText)}”`
          : `your edit changing “${clip(change.oldText)}” to “${clip(change.newText)}”`
      focusComposer(`Revise ${what} in ${change.path}: retract it with suggestions.retract, then stage the corrected version. My note — `)
    },
    [changes, focusComposer],
  )
  // A mistaken rejection reopens to pending: the proposal returns as a provisional card (and inline,
  // when its text still anchors). The live suggestion is gone by then; accept replays the stored edit.
  const reopenChange = useCallback(
    async (id: string, message?: string): Promise<void> => {
      await ledger.setChangeStatus(id, 'pending')
      await reloadChanges()
      flash(message ?? 'Suggestion reopened')
    },
    [ledger, reloadChanges, flash],
  )
  const onInlineAction = useCallback(
    (id: string, act: InlineAction) => {
      if (act === 'accept') void acceptChange(id)
      else if (act === 'reject') void rejectChange(id)
      else {
        selectChange(id)
        reviseChange(id)
      }
    },
    [acceptChange, rejectChange, reviseChange, selectChange],
  )

  return {
    acceptChange,
    acceptAndNext,
    rejectChange,
    holdChange,
    acceptAllPending,
    acceptInsertions,
    acceptDeletions,
    acceptMany,
    rejectMany,
    discardRun,
    sendRunBack,
    reviseChange,
    reopenChange,
    onInlineAction,
  }
}
