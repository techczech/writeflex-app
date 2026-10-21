import { useCallback, useEffect, useState } from 'react'
import { TriangleAlert } from 'lucide-react'

/**
 * The notice shown when a Collection opens with a widget step that moved documents left unfinished by a crash or a
 * quit (main: standard-widgets/step-journal.ts). It names what was left in plain words. Nothing happens by itself:
 *   - a step stopped before its last part: Clean up removes only the step's own files (each only while unchanged)
 *     and puts back the links it had changed; Not now hides the notice until the Collection is opened again;
 *   - a step stopped in its last part (the documents are in their new place): OK puts the notice away; nothing on
 *     disk changes, and the old copies still standing are named for the writer to remove.
 */
type LeftoverStep = Awaited<ReturnType<Window['writeflex']['standardWidgetLeftoverSteps']>>[number]

export type WidgetStepLeftoverNoticeProps = {
  /** The open Collection; the notice reads again when it changes. */
  root: string | null
  /** The outcome of a Clean up, said in the status line. */
  onStatus: (message: string) => void
  /** Files changed on disk by a Clean up: the app refreshes its listing. */
  onChanged?: () => void
}

export function WidgetStepLeftoverNotice({ root, onStatus, onChanged }: WidgetStepLeftoverNoticeProps): JSX.Element | null {
  const [steps, setSteps] = useState<LeftoverStep[]>([])
  const [busy, setBusy] = useState(false)
  const read = useCallback(async () => {
    if (!root) { setSteps([]); return }
    try { setSteps(await window.writeflex.standardWidgetLeftoverSteps()) } catch { setSteps([]) }
  }, [root])
  useEffect(() => { void read() }, [read])

  const step = steps[0]
  if (!step) return null
  const hide = (): void => setSteps((current) => current.filter((other) => other.id !== step.id))
  const cleanUp = async (): Promise<void> => {
    setBusy(true)
    try {
      const result = await window.writeflex.cleanUpStandardWidgetStep(step.id)
      onStatus(result.message)
      onChanged?.()
      if (result.ok) hide()
      else await read()
    } finally { setBusy(false) }
  }
  const forget = async (): Promise<void> => {
    setBusy(true)
    try { await window.writeflex.forgetStandardWidgetStep(step.id); hide() } finally { setBusy(false) }
  }
  return (
    <div className="external-change-banner widget-step-leftover" role="status" aria-live="polite" data-testid="widget-step-leftover">
      <TriangleAlert className="icon" aria-hidden="true" />
      <span className="external-change-copy">
        <strong>{step.phase === 'copying' ? 'A widget step was not finished' : 'A widget step was nearly finished'}</strong>
        <span data-testid="widget-step-leftover-message">{step.message}</span>
      </span>
      <span className="external-change-actions">
        {step.phase === 'copying' ? (
          <>
            <button className="cbtn" type="button" disabled={busy} onClick={hide}>Not now</button>
            <button className="cbtn primary" type="button" disabled={busy} onClick={() => void cleanUp()} data-testid="widget-step-clean-up">Clean up</button>
          </>
        ) : (
          <button className="cbtn primary" type="button" disabled={busy} onClick={() => void forget()} data-testid="widget-step-forget">OK</button>
        )}
      </span>
    </div>
  )
}
