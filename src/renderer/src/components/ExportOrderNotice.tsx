// The out-of-step line of the export sheet and the Share page (spec-folio-room-data-model § 8 D-ORD-3): a Folio whose
// manifest (what export and sharing read) does not follow its running order (the Index Note). No mockup frame draws
// it; it takes each sheet's existing notice style (the export sheet's amber line, the Share page's problem panel).
// The room's banner (ticket 10) reuses `useExportOrderCheck` and the shared wording.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { manifestCreatedSentence } from '../../../shared/folio-room-order'
import {
  EXPORT_ANYWAY,
  EXPORT_ORDER_REPAIR,
  EXPORT_ORDER_REPAIRED,
  exportOrderLine,
  type ExportOrderCheck,
} from '../../../shared/export-order-agreement'

export type ExportOrderState = {
  /** The line to show, or null (none, dismissed with Export anyway, or not read yet). */
  line: { lines: string[]; repair: boolean } | null
  /** Said after a repair or a refusal; null otherwise. */
  said: { ok: boolean; text: string } | null
  busy: boolean
  /** Pieces export writes after a successful repair (the sheet's count follows); null until then. */
  pieces: number | null
  repair: () => void
  dismiss: () => void
}

/**
 * Reads where only the latest one counts: `read` hands out a new token, and an answer that arrives after a newer read
 * (or after `cancel`) is dropped, never applied. The Share page reads again on every reload of its view, so an older
 * read that resolves late would otherwise draw a line that is no longer true.
 */
export function latestReads<T>(fetch: (dir: string) => Promise<T>, apply: (value: T) => void): { read: (dir: string) => Promise<void>; cancel: () => void } {
  let token = 0
  return {
    read: async (dir) => {
      const mine = ++token
      const value = await fetch(dir)
      if (mine === token) apply(value)
    },
    cancel: () => { token += 1 },
  }
}

/**
 * The Folio in `dir`'s agreement, read when the sheet opens (and on `refreshKey`), and the repair. Reading writes
 * nothing (I-4); only Make export follow the running order writes, and only the manifest. A refused repair says why
 * and reads the agreement again, so the line shows what is true now. A new `dir` starts afresh: nothing said,
 * dismissed or counted for the last Folio carries over, and its late answers are dropped.
 */
export function useExportOrderCheck(
  dir: string | null,
  refreshKey: unknown = null,
  /** The line for a check (the room's adds the Index-only line, folio-room-order.ts `roomOrderLine`). Default: the sheets'. */
  lineFor: (check: ExportOrderCheck) => ExportOrderState['line'] = (check) => exportOrderLine(check.agreement, check.unreadableMessage),
): ExportOrderState {
  const [check, setCheck] = useState<ExportOrderCheck | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<ExportOrderState['said']>(null)
  const [pieces, setPieces] = useState<number | null>(null)
  const reader = useMemo(() => latestReads((at: string) => window.writeflex.plan.exportOrder(at).catch(() => null), setCheck), [])
  // Bumped whenever `dir` changes or the hook goes away: a repair's answer for an earlier generation is dropped.
  const generation = useRef(0)

  useEffect(() => {
    generation.current += 1
    setCheck(null)
    setDismissed(false)
    setSaid(null)
    setPieces(null)
    setBusy(false)
    return () => {
      generation.current += 1
      reader.cancel()
    }
  }, [dir, reader])

  useEffect(() => {
    if (dir === null) return
    void reader.read(dir)
  }, [dir, refreshKey, reader])

  const repair = useCallback((): void => {
    if (dir === null || check === null || busy) return
    const at = generation.current
    setBusy(true)
    setSaid(null)
    void window.writeflex.plan.alignManifest(dir, check.expected)
      .then((result) => {
        if (generation.current !== at) return
        if (result.ok) {
          setPieces(result.pieces)
          // Said only when the manifest was changed; the read that follows shows whether a line is still due.
          // A repair that made the manifest (the room's Index-only line) says so, as the room's first order write does.
          setSaid(result.changed ? { ok: true, text: check.agreement.kind === 'no-manifest' ? manifestCreatedSentence(result.notInRunningOrder) : EXPORT_ORDER_REPAIRED } : null)
        } else setSaid({ ok: false, text: result.message })
      })
      .catch(() => { if (generation.current === at) setSaid({ ok: false, text: 'WriteFlex could not change the export order. Nothing was changed. Try again.' }) })
      .finally(() => {
        if (generation.current !== at) return
        setBusy(false)
        void reader.read(dir)
      })
  }, [busy, check, dir, reader])

  const line = check && !dismissed ? lineFor(check) : null
  return { line, said, busy, pieces, repair, dismiss: () => setDismissed(true) }
}

/** The export sheet's line, in its amber notice style. `onExportAnyway` runs the export as the manifest has it. */
export function ExportOrderNotice({ state, onExportAnyway, disabled = false }: { state: Pick<ExportOrderState, 'line' | 'said' | 'busy' | 'repair'>; onExportAnyway: () => void; disabled?: boolean }): JSX.Element | null {
  const { line, said, busy, repair } = state
  if (!line && !said) return null
  return (
    <>
      {line && (
        <div className="export-warn export-order" role="note" data-testid="export-order-notice">
          <TriangleAlert className="icon" aria-hidden="true" />
          <div className="export-order-body">
            {line.lines.map((text, index) => (index === 0 ? <b key={text}>{text}</b> : <div key={text}>{text}</div>))}
            {line.repair && (
              <div className="export-order-actions">
                <button type="button" className="btn small export-order-repair" disabled={busy || disabled} onClick={repair}>{busy ? 'Changing the export order…' : EXPORT_ORDER_REPAIR}</button>
                <button type="button" className="btn ghost small" disabled={busy || disabled} onClick={onExportAnyway}>{EXPORT_ANYWAY}</button>
              </div>
            )}
          </div>
        </div>
      )}
      {said && <p className={said.ok ? 'export-done' : 'export-error'} role={said.ok ? 'status' : 'alert'} data-testid="export-order-said">{said.text}</p>}
    </>
  )
}

/** The Share page's line, as one of its problem panels. Export anyway leaves sharing in the manifest's order and closes the line. */
export function ShareOrderPanel({ state }: { state: ExportOrderState }): JSX.Element | null {
  const { line, said, busy, repair, dismiss } = state
  if (!line && !said) return null
  return (
    <div className="shr-panel problem" data-problem="export-order" data-testid="share-order-notice">
      <div className="shr-panel-h"><TriangleAlert className="icon" aria-hidden="true" /><span>{line ? line.lines[0] : 'Export order'}</span></div>
      <div className="shr-panel-b">
        {line && line.lines.slice(1).map((text) => <p key={text} className="shr-p">{text}</p>)}
        {said && <p className="shr-p" role={said.ok ? 'status' : 'alert'} data-testid="export-order-said">{said.text}</p>}
        {line?.repair && (
          <div className="shr-row">
            <button type="button" className="shr-btn small export-order-repair" disabled={busy} onClick={repair}>{busy ? 'Changing the export order…' : EXPORT_ORDER_REPAIR}</button>
            <button type="button" className="shr-btn small" disabled={busy} onClick={dismiss}>{EXPORT_ANYWAY}</button>
          </div>
        )}
      </div>
    </div>
  )
}
