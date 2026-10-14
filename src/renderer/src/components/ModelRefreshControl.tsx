import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { describeModelRefresh, lastCheckedLine, type ModelsChecked } from '../../../shared/model-refresh'

/**
 * The small "Refresh models" control (fix 04), shared by the chat model picker and Settings → Model.
 * It asks Bridle for a forced refresh, then shows the result ("3 new models", "Up to date", or why it
 * failed) and the last-checked line. The model lists themselves update through agent:models-changed.
 */
export function ModelRefreshControl({ checked }: { checked: ModelsChecked | null }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Keep "5 min ago" honest while the control stays on screen.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      setResult(describeModelRefresh(await window.writeflex.refreshModels()))
    } catch (error: unknown) {
      setResult(`Couldn't refresh: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
      setNow(Date.now())
    }
  }

  return (
    <div className="model-refresh" role="group" aria-label="Model list">
      <button type="button" className="ghost" disabled={busy} onClick={() => { void refresh() }} title="Ask the providers for their current models">
        <RefreshCw className={busy ? 'icon sm spin' : 'icon sm'} aria-hidden="true" />
        {busy ? 'Refreshing…' : 'Refresh models'}
      </button>
      <span className="model-refresh-copy">
        {result && <small role="status">{result}</small>}
        <small>{lastCheckedLine(checked, now)}</small>
      </span>
    </div>
  )
}
