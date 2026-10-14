/**
 * TEST-ONLY: mount a widget without the editor block, for the ticket 02 gate set. Installed on
 * `window.__writeflexE2E`, which exists only under WRITEFLEX_E2E=1 (main.tsx), the same seam the other
 * e2e hooks use. It goes through the real path: main's `widget:read` and `mountWidgetFrame`. Ticket 03
 * puts the block in the editor; this host is a plain box pinned to the window's corner.
 */
import { mountWidgetFrame, setWidgetFocusRuleForTest, type WidgetFrame } from './widget-frame'

type E2EApi = NonNullable<Window['__writeflexE2E']>

export function installWidgetE2EMount(api: E2EApi): void {
  const mounted = new Map<number, { widget: WidgetFrame; host: HTMLElement }>()
  let next = 1

  api.mountWidget = async ({ documentPath, rawPath, height }) => {
    const result = await window.writeflex.readWidget(documentPath, rawPath)
    if (!result.ok) return { ok: false, reason: result.reason }
    const host = document.createElement('div')
    host.dataset.testid = 'e2e-widget-host'
    host.style.cssText = `position:fixed;right:16px;bottom:16px;width:420px;height:${height ?? 300}px;z-index:2147483646;background:#fff;box-shadow:0 0 0 1px #888`
    document.body.appendChild(host)
    const widget = mountWidgetFrame({
      container: host,
      html: result.html,
      title: result.title || rawPath,
      returnFocus: () => window.__writeflexE2E?.focusEditor?.(),
    })
    widget.frame.style.cssText = 'display:block;width:100%;height:100%;border:0'
    const id = next
    next += 1
    mounted.set(id, { widget, host })
    return { ok: true, id, title: result.title }
  }
  api.setWidgetFocusRule = (on) => setWidgetFocusRuleForTest(on)
  api.widgetState = (id) => {
    const entry = mounted.get(id)
    return entry ? { engaged: entry.widget.engaged, stopped: entry.widget.stopped, mounted: true } : { engaged: false, stopped: false, mounted: false }
  }
  api.engageWidget = (id) => mounted.get(id)?.widget.engage()
  api.disengageWidget = (id) => mounted.get(id)?.widget.disengage()
  api.disposeWidget = (id) => {
    const entry = mounted.get(id)
    if (!entry) return
    entry.widget.dispose()
    entry.host.remove()
    mounted.delete(id)
  }
}
