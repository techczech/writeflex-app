import { useEffect, useRef, useState } from 'react'
import { Lightbulb, Plus } from 'lucide-react'
import type { StubPreview } from '../../../preload'

type Props = {
  dir: string
  from: string
  target: string
  gist: string
  onCreated: (path: string) => void
  onClose: () => void
  onError: (message: string) => void
}

export function IdeaMaterialise({ dir, from, target, gist, onCreated, onClose, onError }: Props): JSX.Element {
  const [preview, setPreview] = useState<StubPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const confirmRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.writeflex.collection.previewStub({ dir, from, title: target, gist })
      .then((value) => { if (!cancelled) setPreview(value) })
      .catch(() => { if (!cancelled) onError('Could not preview this Stub.') })
    return () => { cancelled = true }
  }, [dir, from, target, gist, onError])

  useEffect(() => { preview && confirmRef.current?.focus() }, [preview])

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await window.writeflex.collection.createStub({ dir, from, title: target, gist })
      if (result.created) onCreated(result.path)
      else onError(`A Piece named “${target}” now exists. Open it instead.`)
    } catch {
      onError('Could not materialise this Stub.')
    } finally {
      setBusy(false)
    }
  }

  return <div className="materialise-layer" onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose() }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void create() }
  }}>
    <section className="idea-pop" role="dialog" aria-modal="false" aria-labelledby="materialise-title">
      <div className="ip-head"><Lightbulb aria-hidden="true" /><span className="ip-t">Idea — not written yet</span><span className="ip-tag">dead link</span></div>
      <h2 className="ip-title" id="materialise-title">{target || 'Untitled idea'}</h2>
      <p className="ip-sub">{preview ? (preview.seeded ? 'No Piece with this title exists in the Collection. Materialise it as a Stub and this link goes live.' : preview.explanation) : 'Checking this Collection…'}</p>
      <div className="ip-act">
        <button ref={confirmRef} className="btn primary idea-action" type="button" disabled={!preview || busy} onClick={() => void create()}><Plus aria-hidden="true" /> Materialise stub <kbd>⌘↵</kbd></button>
        <button className="btn" type="button" onClick={onClose}>Dismiss</button>
      </div>
    </section>
    <aside className="stub-pane" aria-label="Stub preview">
      <div className="stub-head"><div className="sh-k"><Plus aria-hidden="true" /> Will create · {preview?.path ?? '…'}</div><h3>{target || 'Untitled idea'}</h3></div>
      <div className="stub-body"><pre>{preview?.content ?? 'Preparing preview…'}</pre></div>
      <div className="stub-foot"><button className="btn primary idea-action" type="button" disabled={!preview || busy} onClick={() => void create()}><Plus aria-hidden="true" /> Materialise stub</button></div>
    </aside>
  </div>
}
