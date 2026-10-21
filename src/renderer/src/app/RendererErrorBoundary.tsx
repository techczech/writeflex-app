import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { saveUnsavedText, unsavedFileNames, unsavedStatus, unsavedTextForClipboard, watchUnsaved } from './unsaved-text'

export function errorParts(value: unknown): { message: string; stack: string } {
  if (value instanceof Error) return { message: value.message || 'Unknown renderer error', stack: value.stack ?? '' }
  return { message: typeof value === 'string' ? value : 'Unknown renderer error', stack: '' }
}

export async function reportRendererError(value: unknown): Promise<void> {
  const error = errorParts(value)
  try { await window.writeflex.reportRendererError({ ...error, url: window.location.href }) } catch (loggingError) {
    console.error('[WriteFlex] Could not persist renderer error.', loggingError)
  }
}

/**
 * The screen shown in place of a broken app. It claims the text is safe only when the page's record
 * of unsaved text (unsaved-text.ts) holds nothing and no write is in flight. While the save made on
 * the error is running it says so; if text is left that could not be written it names the files and
 * offers the text for the clipboard, because Reload discards what the page still holds.
 */
export function RendererErrorSurface({ error }: { error: unknown }) {
  const parts = errorParts(error)
  const details = [parts.message, parts.stack, window.location.href].filter(Boolean).join('\n\n')
  const [status, setStatus] = useState(unsavedStatus)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const read = (): void => setStatus(unsavedStatus())
    read()
    return watchUnsaved(read)
  }, [])
  const unsavedLeft = !status.saving && status.documents.length > 0
  const heading = status.safe
    ? 'Something broke — your text is safe on disk'
    : unsavedLeft ? 'Something broke — some text could not be saved' : 'Something broke — saving your text…'
  const copyUnsaved = (): void => {
    void navigator.clipboard.writeText(unsavedTextForClipboard(status.documents)).then(() => setCopied(true), () => setCopied(false))
  }
  return (
    <main className="renderer-error" role="alert" aria-live="assertive">
      <section className="renderer-error-card">
        <div className="renderer-error-mark" aria-hidden="true">!</div>
        <p className="renderer-error-eyebrow">WriteFlex recovered the window</p>
        <h1>{heading}</h1>
        <p className="renderer-error-message">{parts.message}</p>
        {status.copies.map((copy) => (
          <p className="renderer-error-recovery-copy" key={copy.copyPath}>
            {copy.path.split('/').at(-1) ?? copy.path} changed on disk, so it was left as it is. Your text was
            saved beside it as {copy.copyPath.split('/').at(-1) ?? copy.copyPath}.
          </p>
        ))}
        {unsavedLeft && (
          <p className="renderer-error-unsaved">
            WriteFlex could not save your latest text in {unsavedFileNames(status.documents)}. Copy it before you reload:
            reloading discards it.{copied ? ' Copied.' : ''}
          </p>
        )}
        <div className="renderer-error-actions">
          {unsavedLeft && <button className="primary" onClick={copyUnsaved}>Copy unsaved text</button>}
          <button className={unsavedLeft ? undefined : 'primary'} onClick={() => void window.writeflex.reloadRenderer()}>Reload</button>
          <button onClick={() => void navigator.clipboard.writeText(details)}>Copy details</button>
        </div>
        {parts.stack && <details><summary>Technical details</summary><pre>{parts.stack}</pre></details>}
      </section>
    </main>
  )
}

type Props = { children: ReactNode }
type State = { error: unknown | null }

export class RendererErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: unknown): State { return { error } }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const parts = errorParts(error)
    void reportRendererError(new Error(`${parts.message}${info.componentStack ? `\nReact component stack:${info.componentStack}` : ''}`, { cause: error }))
    // The app below this boundary has been unmounted with its buffers: write the text kept outside it.
    void saveUnsavedText()
  }

  render(): ReactNode {
    return this.state.error ? <RendererErrorSurface error={this.state.error} /> : this.props.children
  }
}
