import { useEffect, useRef, useState } from 'react'
import { AlertCircle, BookOpenCheck, ClipboardPaste } from 'lucide-react'
import { CAPTURE_KINDS, CAPTURE_KIND_LABELS, type CaptureKind, type CaptureResponse } from '../../../shared/research-capture'
import { humanReadableError } from '../error-text'
import { isCaptureSubmitShortcut } from './IdeaCapture'

type Props = {
  /** The open Piece's path, or the folder whose Plan is open; main finds the Folio or folder from it. */
  project: string
  /** The editor's selection when the sheet was raised: the body starts as this. */
  selection: string
  /** Render seam and test seam: the call into main. */
  capture?: (request: { project: string; title: string; kind: CaptureKind; prompt?: string; body: string }) => Promise<CaptureResponse>
  readClipboard?: () => string
  onFiled: (file: string) => void
  onClose: () => void
}

const projectName = (project: string): string => project.split('/').filter(Boolean).at(-1)?.replace(/\.md$/i, '') ?? 'this Workspace'

/**
 * "Capture to research…": files one reusable unit — Title, Kind, an optional Prompt and the Body (the selection,
 * or pasted) — through the main-process verb that runs `scout capture`. The sheet shows no path of its own; the
 * App says where the file went. A refusal stays in the sheet in the sentence main gives, with the text kept.
 *
 * Keyboard: Title has focus; Tab runs Title, Kind, Prompt, Body, Use clipboard, Cancel, Capture. ⌘↵ captures, Esc closes.
 */
export function CaptureResearchSheet({ project, selection, capture, readClipboard, onFiled, onClose }: Props): JSX.Element {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<CaptureKind>('evidence')
  const [prompt, setPrompt] = useState('')
  const [body, setBody] = useState(selection)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { titleRef.current?.focus() }, [])

  const ready = title.trim() !== '' && body.trim() !== '' && !busy
  const file = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    setProblem(null)
    try {
      const call = capture ?? window.writeflex.captureResearch
      const result = await call({ project, title: title.trim(), kind, ...(prompt.trim() ? { prompt: prompt.trim() } : {}), body })
      if (result.ok) onFiled(result.file)
      else { setProblem(result.message); setBusy(false) }
    } catch (error) {
      setProblem(humanReadableError(error, 'The capture could not be filed, so nothing was captured.'))
      setBusy(false)
    }
  }
  const useClipboard = (): void => {
    const text = (readClipboard ?? window.writeflex.clipboardText)()
    if (text !== '') setBody(text)
    else setProblem('The clipboard has no text.')
  }

  return <div className="overlay open capture-overlay" onMouseDown={() => { if (!busy) onClose() }}>
    <form className="capture-sheet" role="dialog" aria-modal="true" aria-labelledby="research-capture-title" data-testid="capture-research-sheet"
      onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => event.preventDefault()} onKeyDown={(event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose() }
        else if (isCaptureSubmitShortcut(event)) { event.preventDefault(); void file() }
      }}>
      <div className="cap-head"><BookOpenCheck aria-hidden="true" /><span className="c-t" id="research-capture-title">Capture to research</span><span className="c-ctx">for <b>{projectName(project)}</b></span></div>
      <div className="cap-body">
        <label className="cap-field"><span>Title</span><input ref={titleRef} className="input title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name what you are keeping" /></label>
        <label className="cap-field"><span>Kind</span>
          <select className="input" value={kind} onChange={(event) => setKind(event.target.value as CaptureKind)}>
            {CAPTURE_KINDS.map((choice) => <option key={choice} value={choice}>{CAPTURE_KIND_LABELS[choice]}</option>)}
          </select>
        </label>
        <label className="cap-field"><span>Prompt (optional)</span><input className="input" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="The question that produced it" /></label>
        <label className="cap-field"><span>Body</span><textarea className="input gist" value={body} onChange={(event) => setBody(event.target.value)} placeholder="The table, the quote with its source, the paragraph" /></label>
        {problem && <div className="cap-dup" role="alert"><AlertCircle aria-hidden="true" /> <span>{problem}</span></div>}
      </div>
      <div className="cap-foot">
        <button type="button" className="btn" data-action="use-clipboard" disabled={busy} onClick={useClipboard}><ClipboardPaste className="icon sm" aria-hidden="true" />Use clipboard</button>
        <span className="sp" />
        <button type="button" className="btn" data-action="cancel" disabled={busy} onClick={onClose}>Cancel <kbd>esc</kbd></button>
        <button type="button" className="btn primary" data-action="capture" disabled={!ready} onClick={() => void file()}>Capture <kbd>⌘↵</kbd></button>
      </div>
    </form>
  </div>
}
