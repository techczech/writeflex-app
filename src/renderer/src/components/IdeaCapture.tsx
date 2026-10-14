import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Lightbulb, Plus } from 'lucide-react'
import type { CollectionTarget, StubPreview } from '../../../preload'

type Props = {
  dir: string
  from?: string
  onCreated: (path: string, target: CollectionTarget | undefined) => void
  onOpenExisting: (path: string, target: CollectionTarget | undefined) => void
  onClose: () => void
  onError: (message: string) => void
}

export function isCaptureSubmitShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey)
}

export function IdeaCapture({ dir, from, onCreated, onOpenExisting, onClose, onError }: Props): JSX.Element {
  const [title, setTitle] = useState('')
  const [gist, setGist] = useState('')
  const [targets, setTargets] = useState<CollectionTarget[]>([])
  const [windowId, setWindowId] = useState<number | undefined>()
  const [preview, setPreview] = useState<StubPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement | null>(null)
  const selected = useMemo(() => targets.find((target) => target.windowId === windowId) ?? targets.find((target) => target.current), [targets, windowId])
  const currentWindow = selected?.current !== false
  const source = currentWindow && from ? { from } : {}
  const targetDir = currentWindow ? dir : ''

  useEffect(() => {
    void window.writeflex.collection.targets().then((items) => {
      setTargets(items)
      setWindowId(items.find((item) => item.current)?.windowId ?? items[0]?.windowId)
    }).catch(() => onError('Could not list open Collections.'))
    titleRef.current?.focus()
  }, [onError])

  useEffect(() => {
    if (!title.trim()) { setPreview(null); return }
    let cancelled = false
    const timer = window.setTimeout(() => {
      void window.writeflex.collection.previewStub({ dir: targetDir, ...source, title, gist, ...(windowId === undefined ? {} : { windowId }) })
        .then((value) => { if (!cancelled) setPreview(value) })
        .catch(() => { if (!cancelled) setPreview(null) })
    }, 120)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [dir, from, title, gist, windowId])

  const create = async (createAnyway = false): Promise<void> => {
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const result = await window.writeflex.collection.createStub({ dir: targetDir, ...source, title, gist, createAnyway, ...(windowId === undefined ? {} : { windowId }) })
      if (result.created) onCreated(result.path, selected)
      else setPreview((value) => value ? { ...value, existing: result.existing } : value)
    } catch {
      onError('Could not save this idea.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="overlay open capture-overlay" onMouseDown={onClose}>
    <form className="capture-sheet" role="dialog" aria-modal="true" aria-labelledby="capture-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => event.preventDefault()} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      else if (isCaptureSubmitShortcut(event)) { event.preventDefault(); void create(false) }
    }}>
      <div className="cap-head"><Lightbulb aria-hidden="true" /><span className="c-t" id="capture-title">Capture an idea</span><span className="c-ctx">into {targets.length > 1 ? <select aria-label="Capture into Collection" value={windowId} onChange={(event) => setWindowId(Number(event.target.value))}>{targets.map((target) => <option key={target.windowId} value={target.windowId}>{target.name}</option>)}</select> : <span className="sbadge">{selected?.name ?? 'this Collection'}</span>}</span></div>
      <div className="cap-body">
        <label className="cap-field"><span>Title</span><input ref={titleRef} className="input title" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Name the idea" /></label>
        <label className="cap-field"><span>Gist</span><textarea className="input gist" value={gist} onChange={(event) => setGist(event.target.value)} placeholder="What is the thought?" /></label>
        {!!preview?.existing.length && <div className="cap-dup" role="alert"><AlertCircle aria-hidden="true" /> <span>A Piece with this title already exists. <button type="button" className="link" onClick={() => onOpenExisting(preview.existing[0], selected)}>Open it instead</button> — or <button type="button" className="link" onClick={() => void create(true)}>keep this as a separate idea</button>.</span></div>}
        {preview && <div className="cap-preview">{preview.explanation}</div>}
      </div>
      <div className="cap-foot"><span className="hint"><kbd>⌘⇧N</kbd> from anywhere</span><span className="sp" /><span className="hint">returns you to <b>{from?.split('/').at(-1)?.replace(/\.md$/i, '') ?? 'your writing'}</b></span><button className="btn" type="button" onClick={onClose}>Cancel <kbd>esc</kbd></button><button className="btn primary" type="button" onClick={() => void create(false)} disabled={!title.trim() || busy || !!preview?.existing.length}><Plus aria-hidden="true" /> Save idea <kbd>⌘↵</kbd></button></div>
    </form>
  </div>
}
