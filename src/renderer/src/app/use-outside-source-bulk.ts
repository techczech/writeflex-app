import { useCallback, useMemo, useRef, useState } from 'react'
import type { OutsideBulkAccept, OutsideSource } from '../../../preload'
import type { ReviewAsk } from '../components/ReviewBulkPopovers'
import { acceptResult, declineResult, sourceBulkQuestion, type OutsideSourceRow, type SourceBulkAction, type SourceBulkResult } from './outside-source-bulk'

/**
 * Accept all / Decline all from one source, across the collection: the sheet's state and its two runs.
 *  - Decline all: `rejectOutsideChanges({ source })`, one write of the ledger (changes.ts `rejectOutside`).
 *  - Accept all: main accepts every waiting change of the source in documents this window does not hold,
 *    each by the single Accept (`acceptOutsideChanges`); the changes in documents the window holds come
 *    back in order and are accepted here one at a time through `acceptInWindow`, the single click's own
 *    route (saved first, then main writes, the editor takes the text as an undoable edit).
 * Nothing runs before the writer confirms; the sheet then shows what was done until it is closed.
 */
export type OutsideSourceBulkPorts = {
  rows: OutsideSourceRow[]
  /** Whether this window holds the document (an open tab, or a buffer it has read). */
  isOpen(path: string): boolean
  /** One change accepted through the window's accept route, as a single click does it. */
  acceptInWindow(path: string, id: string): Promise<{ applied: boolean; message?: string }>
  /** After a run: the ledger, the inline marks and the workspace views read again. */
  afterRun(): Promise<void> | void
  restoreFocus(): void
  flash(message: string): void
}

type SheetState = { action: SourceBulkAction; source: OutsideSource; running: boolean; result: SourceBulkResult | null; frozen: OutsideSourceRow | null }

export function useOutsideSourceBulk(ports: OutsideSourceBulkPorts): { ask: ReviewAsk | null; open: (action: SourceBulkAction, source?: OutsideSource) => void } {
  const [state, setState] = useState<SheetState | null>(null)
  const portsRef = useRef(ports)
  portsRef.current = ports
  const open = useCallback((action: SourceBulkAction, source?: OutsideSource) => {
    const { rows, flash } = portsRef.current
    const row = rows.find((candidate) => candidate.source === source) ?? rows[0]
    if (!row) { flash('Nothing from outside is waiting.'); return }
    setState({ action, source: row.source, running: false, result: null, frozen: null })
  }, [])
  const close = useCallback(() => {
    setState((current) => (current?.running ? current : null))
    portsRef.current.restoreFocus()
  }, [])
  const run = useCallback(async (action: SourceBulkAction, row: OutsideSourceRow) => {
    const { isOpen, acceptInWindow, afterRun } = portsRef.current
    let result: SourceBulkResult
    try {
      if (action === 'decline') {
        const { rejected } = await window.writeflex.rejectOutsideChanges({ source: row.source })
        result = declineResult(row.label, rejected)
      } else {
        const outcome: OutsideBulkAccept = await window.writeflex.acceptOutsideChanges({ source: row.source, open: row.paths.filter(isOpen) })
        let openAccepted = 0
        const openLeft: OutsideBulkAccept['left'] = []
        const openFiles: string[] = []
        // In order, one at a time: each is the single click's accept, so each waits for the one before.
        for (const item of outcome.open) {
          const answer = await acceptInWindow(item.path, item.id)
          if (answer.applied) {
            openAccepted += 1
            if (!openFiles.includes(item.path)) openFiles.push(item.path)
          } else openLeft.push({ ...item, reason: answer.message ?? 'It could not be placed.' })
        }
        result = acceptResult(row.label, outcome, openAccepted, openLeft, openFiles)
      }
    } catch (error) {
      result = { title: error instanceof Error ? error.message : `Could not ${action} the changes from ${row.label}.`, lines: [] }
    }
    try { await afterRun() } catch { /* the views read again on the next change */ }
    setState((current) => (current ? { ...current, running: false, result } : current))
  }, [])
  const ask = useMemo<ReviewAsk | null>(() => {
    if (!state) return null
    const row = state.frozen ?? ports.rows.find((candidate) => candidate.source === state.source)
    if (!row) return null
    const openCount = row.paths.filter(ports.isOpen).length
    return {
      kind: 'outside-source',
      sheet: {
        action: state.action,
        rows: state.frozen ? [state.frozen] : ports.rows,
        source: row.source,
        question: sourceBulkQuestion(row, state.action, openCount),
        running: state.running,
        result: state.result,
        onPickSource: (source) => setState((current) => (current && !current.running && !current.result ? { ...current, source } : current)),
        onConfirm: () => {
          if (state.running || state.result) return
          // The row as confirmed: the counts on the sheet stay as they were asked about while the run changes the ledger.
          setState({ ...state, running: true, frozen: row })
          void run(state.action, row)
        },
        onCancel: close,
      },
    }
  }, [state, ports.rows, ports.isOpen, run, close])
  return { ask, open }
}
