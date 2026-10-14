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
  resolveChange: (id: string, action: 'accept' | 'reject') => Promise<{ applied: boolean; file?: FileReadResult; message?: string }>
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
  reconcileAppliedFile: (file: FileReadResult) => void
  /** Main wrote this open document and the editor took the text as an undoable edit: the returned
   *  file is the saved baseline and the buffer's standing goes to the unsaved registry. */
  documentWrittenByMain: (file: FileReadResult) => void
  focusComposer: (text?: string) => void
  setChangesOpen: (open: boolean) => void
  selectChange: (id: string) => void
  settleChange: (id: string, advance: boolean) => void
}

export type ReviewActions = {
  acceptChange: (id: string, advance?: boolean) => Promise<boolean>
  acceptAndNext: (id: string) => Promise<boolean>
  rejectChange: (id: string) => Promise<boolean>
  holdChange: (id: string) => Promise<boolean>
  acceptAllPending: () => void
  acceptInsertions: () => void
  acceptDeletions: () => void
  acceptMany: (ids: string[]) => void
  rejectMany: (ids: string[]) => void
  discardRun: () => void
  sendRunBack: (note: string) => void
  reviseChange: (id?: string) => void
  /** Reopen a mistakenly rejected change to pending (the mis-click must not be a one-way door). */
  reopenChange: (id: string) => void
  onInlineAction: (id: string, act: InlineAction) => void
}

/** Keep the last inline projection on the post-reconcile document, regardless of IPC push order. */
export async function reconcileResolvedFile(
  file: FileReadResult,
  reconcileAppliedFile: (file: FileReadResult) => void,
  refreshInlineChangesAfterReconcile: () => Promise<void>,
): Promise<void> {
  reconcileAppliedFile(file)
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
    documentWrittenByMain,
    focusComposer,
    setChangesOpen,
    selectChange,
    settleChange,
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
      const res = await ledger.resolveChange(id, 'accept')
      if (!res.applied) {
        flash(res.message ?? 'This suggestion is no longer live — ask the agent to redo the edit.')
        return false
      }
      handleAgentWorkspaceChange()
      const recorded = change ? editorRef.current?.recordSuggestionResolution(change.path, id, 'accept', res.file?.content) === true : false
      // As acceptSuggestion: without this the baseline stays at the pre-accept text, and undoing the
      // accept reads as "equals the disk" while the disk holds the accepted text.
      if (recorded && res.file) documentWrittenByMain(res.file)
      if (recorded) await refreshInlineChangesAfterReconcile()
      else if (res.file) await reconcileResolvedFile(res.file, reconcileAppliedFile, refreshInlineChangesAfterReconcile)
      else await reloadChanges()
      if (res.message) flash(res.message)
      settleChange(id, advance)
      return true
    },
    [suggestionForChange, changes, acceptSuggestion, isWriterChange, resolveWriterEditById, ledger, editorRef, handleAgentWorkspaceChange, reconcileAppliedFile, documentWrittenByMain, refreshInlineChangesAfterReconcile, reloadChanges, flash, settleChange],
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
      const res = await ledger.resolveChange(id, 'reject')
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
    [suggestionForChange, changes, rejectSuggestion, isWriterChange, resolveWriterEditById, ledger, editorRef, reconcileAppliedFile, refreshInlineChangesAfterReconcile, reloadChanges, flash, settleChange],
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
      for (const id of ids) await acceptChange(id)
      await reloadChanges()
      flash(ids.length === 1 ? 'Accepted 1 change' : `Accepted ${ids.length} changes`)
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
      for (const id of sorted) {
        if (action === 'accept') await acceptChange(id)
        else await rejectChange(id)
      }
      await reloadChanges()
      flash(`${action === 'accept' ? 'Accepted' : 'Rejected'} ${sorted.length} change${sorted.length === 1 ? '' : 's'}`)
    },
    [dockChanges, acceptChange, rejectChange, reloadChanges, flash],
  )
  const acceptMany = useCallback((ids: string[]) => void resolveMany(ids, 'accept'), [resolveMany])
  const rejectMany = useCallback((ids: string[]) => void resolveMany(ids, 'reject'), [resolveMany])

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
      flash('Notes returned to the agent composer')
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
    (id: string) => {
      void (async () => {
        await ledger.setChangeStatus(id, 'pending')
        await reloadChanges()
        flash('Suggestion reopened')
      })()
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
