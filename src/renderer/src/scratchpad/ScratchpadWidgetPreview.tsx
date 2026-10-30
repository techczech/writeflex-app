import { useEffect, useRef, useState } from 'react'
import type { ScratchItem } from '../../../shared/scratchpad-items'
import { mountWidgetFrame } from '../widgets/widget-frame'

/** Nothing mounts until the writer presses Run. Main reads the widget once and checks those
 *  exact bytes (prepareWidgetPreview); the sealed frame mounts the returned page and nothing
 *  else — there is no second, unchecked read on this path. */
export function ScratchpadWidgetPreview({ item, root }: { item: ScratchItem; root: string | null }): JSX.Element {
  const container = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const [run, setRun] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!run || !root) return
    let disposed = false
    let mounted: ReturnType<typeof mountWidgetFrame> | null = null
    const bridge = window.writeflex.scratchpad
    void (async () => {
      const prepared = item.source === 'document'
        ? await bridge.prepareWidgetPreview({ root, origin: item.origin.path, markdown: item.markdown, from: item.document!.from, to: item.document!.to })
        : await bridge.prepareWidgetPreview({ root, id: item.id })
      if (!prepared.ok) throw new Error(prepared.error)
      // The checked bytes belong to the current payload main reports. If this panel snapshot is
      // stale, refuse and let the writer refresh rather than running a different widget.
      if (prepared.markdown !== item.markdown) throw new Error('This widget changed since the panel was refreshed. Refresh the Scratchpad and run it again.')
      if (!disposed && container.current) mounted = mountWidgetFrame({ container: container.current, html: prepared.html, title: prepared.title, returnFocus: () => button.current?.focus() })
    })().catch((error: Error) => { if (!disposed) setError(error.message) })
    return () => { disposed = true; mounted?.dispose() }
  }, [run, root, item.id, item.markdown, item.origin.path, item.origin.base])
  return <div className="sp-widget-preview">
    <p>This widget runs sealed, with no network or access to your document.</p>
    <button ref={button} type="button" disabled={!root || (item.external ? !!item.external.incompatible : !!item.problem)} onClick={() => { setError(null); setRun(on => !on) }}>{run ? 'Stop widget' : 'Run widget'}</button>
    {error ? <p className="sp-problem">{error}</p> : null}
    <div className="sp-widget-frame" ref={container} />
  </div>
}
