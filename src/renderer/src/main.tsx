import { createRoot } from 'react-dom/client'
import { MARKDOWN_CSS } from '@bridle/react'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/archive-dock.css'
import './styles/sharing.css'
import './styles/folio-room.css'
import './styles/scratchpad.css'
import App from './app/App'
import { RendererErrorBoundary, RendererErrorSurface, reportRendererError } from './app/RendererErrorBoundary'
import { installWidgetE2EMount } from './widgets/widget-e2e-mount'
import { isBenignWindowError } from './benign-window-error'
import { installUnsavedText, saveUnsavedText, type UnsavedTextApi } from './app/unsaved-text'

// Even a damaged renderer template gets the recovery surface instead of an unhandled pre-React throw.
const rootElement = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
const root = createRoot(rootElement)
const showFatal = (error: unknown): void => {
  void reportRendererError(error)
  root.render(<RendererErrorSurface error={error} />)
  // The app and its buffers are about to go: write the text kept outside the React tree now. What
  // cannot be written stays held, and a close of this window then asks before it loses it.
  void saveUnsavedText()
}

// The page's record of unsaved text and its standing answer to a close request, in place before the
// app mounts and after it breaks. (Subscribing here is also what tells main that the app has started in
// this page: the preload reports the first close listener.)
// Test-only: writes made from that record can be made to fail, to stand for a disk that will not take them.
let recoveryWritesFail = false
const unsavedTextApi: UnsavedTextApi = {
  saveFile: (path, content, basis) => (recoveryWritesFail ? Promise.reject(new Error('Simulated recovery write failure')) : window.writeflex.saveFile(path, content, basis)),
  onCloseRequested: (fn) => window.writeflex.onCloseRequested(fn),
  acknowledgeClose: () => window.writeflex.acknowledgeClose(),
  closeWindow: (options) => window.writeflex.closeWindow(options),
  closeUnsaved: () => window.writeflex.closeUnsaved(),
}
installUnsavedText(unsavedTextApi)

window.addEventListener('error', (event) => {
  if (isBenignWindowError(event.message)) { console.warn(event.message); return }
  showFatal(event.error ?? new Error(event.message))
})
window.addEventListener('unhandledrejection', (event) => showFatal(event.reason))

if (window.writeflex.e2eEnabled) {
  window.__writeflexE2E = {
    throwRendererError: () => queueMicrotask(() => { throw new Error('Forced renderer failure for e2e') }),
    // A write hook: only in an unpackaged e2e run (shared/e2e-write-hooks.ts).
    ...(window.writeflex.e2eWriteHooks ? { setRecoveryWrites: (behaviour: 'normal' | 'fail') => { recoveryWritesFail = behaviour === 'fail' } } : {}),
  }
  installWidgetE2EMount(window.__writeflexE2E)
}

root.render(
  <>
    <style>{MARKDOWN_CSS}</style>
    <RendererErrorBoundary><App /></RendererErrorBoundary>
  </>,
)
