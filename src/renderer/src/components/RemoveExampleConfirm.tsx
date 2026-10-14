import { useEffect, useRef, useState } from 'react'
import { Check, Compass, Folder, Pin, Trash2 } from 'lucide-react'
import type { ExampleRemovalPreview } from '../../../preload'

/**
 * "Remove the example?" (ADR-0043, ticket 10; mockup-onboarding-hifi-v2 states 27 and 30): the one
 * confirmation behind Remove on the start screen's Example collection row and on the Guide's first
 * screen inside the example. Three bounded lists: what is moved to the Bin, what is taken off the
 * start screen, what is kept.
 *
 * The folder and the count are not fixed text. Main reads both when the confirmation opens
 * (`getExampleRemovalPreview`): the folder as it is on disk and the files in it at that moment,
 * because WriteFlex does not prove the folder at that path is the one it made. This component names
 * no path and sends none: confirming gives back the token that came with the preview, and main acts
 * only on the token it gave this window, while the folder is still as it was shown.
 *
 * A refusal, before or after confirming, is one sentence from main, shown here; nothing has changed.
 */
export const REMOVE_EXAMPLE_TEXT = {
  open: 'Remove the example…',
  title: 'Remove the example?',
  lead: 'The Example collection folder is moved to the Bin. Your files stay. What you have tried and read is kept.',
  deletedBar: 'Moved to the Bin',
  files: (count: number): string =>
    count === 1 ? '1 file, with anything you typed in it' : `${count.toLocaleString('en-GB')} files, with anything you typed in them`,
  offBar: 'Taken off the start screen',
  off: ['Guide and Example collection'],
  keptBar: 'Kept',
  kept: ['Every folder and file of your own', 'What you have tried and read in the Guide', 'Your settings and shortcuts'],
  cancel: 'Cancel',
  ok: 'Remove the example',
  close: 'Close',
  /** The status-bar flash in every window that has one, once the folder is in the Bin. */
  removedFlash: 'Example collection moved to the Bin. Settings → Get started brings it back.',
} as const

export type RemoveExampleConfirmProps = {
  onClose: () => void
  /** Render seam: the preview as already read, so the confirmation can be drawn without the preload bridge. */
  initial?: ExampleRemovalPreview
  /** Render seam: a refusal that followed confirming. */
  initialRefusal?: string
}

export function RemoveExampleConfirm({ onClose, initial, initialRefusal }: RemoveExampleConfirmProps): JSX.Element | null {
  const T = REMOVE_EXAMPLE_TEXT
  const [preview, setPreview] = useState<ExampleRemovalPreview | null>(initial ?? null)
  const [refusal, setRefusal] = useState<string | null>(initialRefusal ?? null)
  const [busy, setBusy] = useState(false)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (initial) return
    let live = true
    void window.writeflex.getExampleRemovalPreview().then(
      (next) => { if (live) setPreview(next) },
      () => { if (live) setPreview({ ok: false, message: 'The Example collection could not be read, so nothing was changed.' }) },
    )
    return () => { live = false }
  }, [initial])
  // Focus opens on Cancel: Return on a freshly opened confirmation removes nothing.
  useEffect(() => { if (preview) cancelRef.current?.focus() }, [preview])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busy) onClose()
      } else if (event.key === 'Tab') {
        // Two buttons at most: keep Tab inside the confirmation.
        const buttons = [...(sheetRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        if (buttons.length === 0) return
        event.preventDefault()
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[(at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onClose])

  const confirm = (): void => {
    if (busy || !preview?.ok) return
    setBusy(true)
    setRefusal(null)
    void window.writeflex.removeExample(preview.token).then(
      (result) => {
        if (result.ok) { onClose(); return }
        setRefusal(result.message)
        // The token is used up by any answer. Read the folder again so the person sees it as it is now;
        // confirming again then acts on what is shown.
        void window.writeflex.getExampleRemovalPreview().then(
          (next) => { setPreview(next); setBusy(false) },
          () => { setPreview({ ok: false, message: 'The Example collection could not be read, so nothing was changed.' }); setBusy(false) },
        )
      },
      // The example's own window closes under this call when the removal succeeds; a rejection that
      // reaches a window still open is shown as it would be for any refusal.
      () => { setRefusal('The Example collection could not be moved to the Bin, so nothing was changed.'); setBusy(false) },
    )
  }

  if (preview === null) return null // nothing is drawn until main has read the folder
  return (
    <div className="overlay confirm-overlay" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <div ref={sheetRef} className="sheet confirm" role="alertdialog" aria-modal="true" aria-labelledby="remove-example-title" aria-describedby="remove-example-lead" data-testid="remove-example-confirm">
        <div className="cf-head">
          <span className="cf-ico" aria-hidden="true"><Trash2 className="icon" /></span>
          <h2 id="remove-example-title">{T.title}</h2>
        </div>
        {preview.ok ? (
          <>
            <p className="cf-lead" id="remove-example-lead">{T.lead}</p>
            <div className="cf-box del" data-list="bin">
              <div className="cf-bar"><Trash2 className="icon sm" aria-hidden="true" />{T.deletedBar}</div>
              <div className="cf-row">
                <Folder className="icon sm" aria-hidden="true" />
                <span><b>{preview.folder}</b><small>{T.files(preview.files)}</small></span>
              </div>
            </div>
            <div className="cf-box off" data-list="off">
              <div className="cf-bar"><Pin className="icon sm" aria-hidden="true" />{T.offBar}</div>
              {T.off.map((line) => <div className="cf-row" key={line}><Compass className="icon sm" aria-hidden="true" /><span>{line}</span></div>)}
            </div>
            <div className="cf-box keep" data-list="kept">
              <div className="cf-bar"><Check className="icon sm" aria-hidden="true" />{T.keptBar}</div>
              {T.kept.map((line) => <div className="cf-row" key={line}><Check className="icon sm" aria-hidden="true" /><span>{line}</span></div>)}
            </div>
            {refusal !== null && <p className="cf-refusal" role="alert">{refusal}</p>}
            <div className="cf-foot">
              <button ref={cancelRef} type="button" className="btn" disabled={busy} onClick={onClose}>{T.cancel}<kbd>esc</kbd></button>
              <button type="button" className="btn danger" data-action="remove-example" disabled={busy} onClick={confirm}><Trash2 className="icon sm" aria-hidden="true" />{T.ok}</button>
            </div>
          </>
        ) : (
          <>
            <p className="cf-lead cf-refusal" id="remove-example-lead" role="alert">{preview.message}</p>
            <div className="cf-foot">
              <button ref={cancelRef} type="button" className="btn" onClick={onClose}>{T.close}<kbd>esc</kbd></button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
