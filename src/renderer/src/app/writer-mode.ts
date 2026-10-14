import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { AttributedChange, Change, NewChange } from '../../../preload'
import type { EditorHandle } from '../components/EditorPane'
import { writerReviewModeForContent, type WriterPendingChange, type WriterReviewMode } from '../editor/writer-review'
import { syncWriterChanges } from './writer-change-sync'

const writerModeKey = (root: string, path: string): string => `wf:writer-mode:${root}:${path}`

/** The ledger-facing calls writer-mode makes — same seam idea as ReviewLedgerPort: one contract to
 *  re-point when the change ledger moves upstream into Bridle. */
export type WriterLedgerPort = {
  addChange: (input: NewChange) => Promise<Change>
  updateWriterChange: (id: string, input: NewChange) => Promise<Change>
  setChangeStatus: (id: string, status: 'pending' | 'accepted' | 'rejected' | 'held') => Promise<unknown>
}

export type WriterModeDeps = {
  ledger: WriterLedgerPort
  /** The active document path (null when none) and its synchronous mirror. */
  active: string | null
  activeRef: RefObject<string | null>
  root: string | null | undefined
  editorRef: RefObject<EditorHandle | null>
  reloadChanges: () => Promise<unknown>
  flash: (message: string) => void
}

export type WriterMode = {
  writerMode: WriterReviewMode
  setWriterMode: (mode: WriterReviewMode) => void
  /** The mode a file opens in: per-session memo → per-workspace persistence → content default. */
  modeForFile: (path: string, content: string) => WriterReviewMode
  /** Record the buffer's pending tracked edits into the ledger (debounce target + save-version step). */
  flushWriterChanges: (path: string) => Promise<string[]>
  /** The editor's change callback: memo the latest set and debounce a flush. */
  onWriterReviewChanged: (path: string, changes: WriterPendingChange[]) => void
  /** Fold tracked edits into Drafting while keeping their ledger records pending. */
  foldWriterEdits: (path: string) => Promise<void>
  /** The writer's explicit mode switch (⌥⌘M / toolbar), with the Drafting fold + persistence. */
  changeWriterMode: (mode: WriterReviewMode) => void
  /** Start a fresh writer session for a document on demand (ADR-0025 §3). New records join the new span. */
  startNewSession: (path: string) => void
  /** When this run's per-document writer session opened, for the Review panel's elapsed-time copy. */
  openedAtForFile: (path: string) => number | undefined
  /** The active run-scoped session identity, without minting a session for an unopened document. */
  currentSessionIdForFile: (path: string) => string | undefined
  /** Cancel a debounced flush (save-version flushes explicitly and must not race the timer). */
  cancelPendingFlush: () => void
  /** Drop a file's memoised writer-change state after its edits are settled into a version. */
  clearFileWriterState: (path: string) => void
  /** Per-path localId↔storeId table — review actions map store ids back to editor marks through this. */
  recordedWriterChanges: MutableRefObject<Map<string, Map<string, string>>>
}

/** Settle pending writer records without reconciling, folding, saving, or otherwise touching text. */
export async function acceptWriterSessionChanges(
  changes: Change[],
  ledger: Pick<WriterLedgerPort, 'setChangeStatus'>,
): Promise<void> {
  for (const change of changes) {
    if (change.provenance === 'writer' && change.editClass !== 'copy' && change.status === 'pending') {
      await ledger.setChangeStatus(change.id, 'accepted')
    }
  }
}

/** Return an accepted ledger record to the live pending pile. This never touches editor or file text. */
export async function revertWriterChangeToActive(
  change: Change,
  ledger: Pick<WriterLedgerPort, 'setChangeStatus'>,
): Promise<void> {
  await ledger.setChangeStatus(change.id, 'pending')
}

type ChangeWithComparedOriginal = Change & Partial<Pick<AttributedChange, 'compareOldText'>>
type ScratchpadWriter = { add: (origin: string, text: string) => Promise<unknown> }

/** Salvage a ledger record's original wording through the existing scrap store without resolving it. */
export async function sendOriginalToScratchpad(
  change: ChangeWithComparedOriginal,
  scratchpad: ScratchpadWriter,
): Promise<unknown> {
  return scratchpad.add(change.path, change.compareOldText ?? change.oldText)
}

/**
 * The Drafting/Reviewing writer-mode domain (ADR-0016): which mode each file is in, how tracked writer
 * edits reach the ledger (debounced flush), and the fold that collapses tracking into settled text.
 */
export function useWriterMode(deps: WriterModeDeps): WriterMode {
  const { ledger, active, activeRef, root, editorRef, reloadChanges, flash } = deps

  const [writerMode, setWriterMode] = useState<WriterReviewMode>('drafting')
  const writerModes = useRef<Map<string, WriterReviewMode>>(new Map())
  const latestWriterChanges = useRef<Map<string, WriterPendingChange[]>>(new Map())
  const recordedWriterChanges = useRef<Map<string, Map<string, string>>>(new Map())
  const writerChangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ADR-0025 §3: a writer session is a per-document span, bounded by open→close and startable on demand.
  // Lazily minted on the first edit for a path and dropped when the file's state is cleared, so a
  // close+reopen (or settling into a version) begins a fresh span. Distinct from the agent's workspace
  // session (main/agent.ts); both share Change.sessionId at different granularities (the diary reconciles).
  const writerSessions = useRef<Map<string, string>>(new Map())
  const writerSessionOpenedAt = useRef<Map<string, number>>(new Map())
  const makeSessionId = (): string => `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  const currentSessionId = useCallback((path: string): string => {
    const existing = writerSessions.current.get(path)
    if (existing) {
      if (!writerSessionOpenedAt.current.has(path)) writerSessionOpenedAt.current.set(path, Date.now())
      return existing
    }
    const fresh = makeSessionId()
    writerSessions.current.set(path, fresh)
    writerSessionOpenedAt.current.set(path, Date.now())
    return fresh
  }, [])
  const startNewSession = useCallback((path: string) => {
    writerSessions.current.set(path, makeSessionId())
    writerSessionOpenedAt.current.set(path, Date.now())
  }, [])
  const openedAtForFile = useCallback((path: string) => writerSessionOpenedAt.current.get(path), [])
  const currentSessionIdForFile = useCallback((path: string) => writerSessions.current.get(path), [])

  const modeForFile = useCallback((path: string, content: string): WriterReviewMode => {
    // Opening a document begins its run-scoped session even before the first edit, so the Review panel
    // can say how long the document has been open. Re-activating a cached tab keeps the same session.
    currentSessionId(path)
    const memo = writerModes.current.get(path)
    if (memo) return memo
    const stored = typeof root === 'string' ? localStorage.getItem(writerModeKey(root, path)) : null
    const mode = stored === 'drafting' || stored === 'reviewing'
      ? stored
      : writerReviewModeForContent(content)
    writerModes.current.set(path, mode)
    return mode
  }, [root, currentSessionId])

  // SERIALISE flushes per path (2026-07-11 fragmentation bug): the sync awaits ledger writes before it
  // records each localId→storeId claim, so two overlapping flushes (debounce + save-version + fold can
  // all fire) each missed the claim and ADDED duplicate records for the same tracked edit. Each flush
  // now chains behind the previous one for its path and reads the pending set when it actually RUNS.
  const flushChains = useRef(new Map<string, Promise<string[]>>())
  const flushWriterChanges = useCallback((path: string): Promise<string[]> => {
    const run = async (): Promise<string[]> => {
      const pending = editorRef.current?.pendingWriterChanges(path) ?? latestWriterChanges.current.get(path) ?? []
      latestWriterChanges.current.set(path, pending)
      if (pending.length === 0) return []
      const pathMap = recordedWriterChanges.current.get(path) ?? new Map<string, string>()
      recordedWriterChanges.current.set(path, pathMap)
      const ids = await syncWriterChanges({
        path,
        pending,
        pathMap,
        sessionId: currentSessionId(path),
        addChange: ledger.addChange,
        updateWriterChange: ledger.updateWriterChange,
      })
      if (activeRef.current === path) await reloadChanges()
      return ids
    }
    const prev = flushChains.current.get(path) ?? Promise.resolve([])
    const next = prev.then(run, run)
    flushChains.current.set(path, next)
    void next.finally(() => {
      if (flushChains.current.get(path) === next) flushChains.current.delete(path)
    })
    return next
  }, [ledger, editorRef, activeRef, reloadChanges, currentSessionId])

  const onWriterReviewChanged = useCallback((path: string, changes: WriterPendingChange[]) => {
    latestWriterChanges.current.set(path, changes)
    if (writerChangeTimer.current) clearTimeout(writerChangeTimer.current)
    writerChangeTimer.current = setTimeout(() => {
      writerChangeTimer.current = null
      void flushWriterChanges(path)
    }, 700)
  }, [flushWriterChanges])

  const cancelPendingFlush = useCallback(() => {
    if (writerChangeTimer.current) {
      clearTimeout(writerChangeTimer.current)
      writerChangeTimer.current = null
    }
  }, [])

  useEffect(() => () => {
    if (writerChangeTimer.current) clearTimeout(writerChangeTimer.current)
  }, [])

  // Folding is a display operation under ADR-0025: record the marks, restore clean Drafting text, and
  // keep the records pending so Reviewing can reveal the same session again. Save-version still uses
  // settleWriterChanges separately because that operation really does settle a version boundary.
  const foldWriterEdits = useCallback(async (path: string): Promise<void> => {
    // Fold SYNCHRONOUSLY, before any await: changeWriterMode has just set the React writerMode, and the
    // EditorPane prop-sync effect pushes that into CM on the next render. If the fold waited on the async
    // flush first, that effect would flip CM's mode to 'drafting' before foldReviewingChanges ran, its
    // "must be reviewing" guard would bail, and Drafting would then persist the un-folded (struck) buffer
    // to disk. Folding here keeps CM in 'reviewing' until the transform itself switches it. The marks
    // become capture records, so flushing AFTER still records everything.
    editorRef.current?.foldWriterChanges(path)
    await flushWriterChanges(path)
    if (activeRef.current === path) await reloadChanges()
  }, [flushWriterChanges, editorRef, activeRef, reloadChanges])

  const changeWriterMode = useCallback((mode: WriterReviewMode) => {
    if (!active) return
    writerModes.current.set(active, mode)
    if (typeof root === 'string') localStorage.setItem(writerModeKey(root, active), mode)
    setWriterMode(mode)
    if (mode === 'drafting') void foldWriterEdits(active)
    else editorRef.current?.revealDraftingSession(active)
    flash(mode === 'reviewing' ? "Reviewing — showing this session's edits" : 'Drafting — edits recorded quietly')
  }, [active, root, flash, foldWriterEdits, editorRef])

  const clearFileWriterState = useCallback((path: string) => {
    latestWriterChanges.current.delete(path)
    recordedWriterChanges.current.delete(path)
    // Settling into a version (or closing the file) ends the session; the next edit mints a new span.
    writerSessions.current.delete(path)
    writerSessionOpenedAt.current.delete(path)
  }, [])

  return {
    writerMode,
    setWriterMode,
    modeForFile,
    flushWriterChanges,
    onWriterReviewChanged,
    foldWriterEdits,
    changeWriterMode,
    startNewSession,
    openedAtForFile,
    currentSessionIdForFile,
    cancelPendingFlush,
    clearFileWriterState,
    recordedWriterChanges,
  }
}
