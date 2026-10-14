/** The file export reuses the editor's opaque-origin frame and complete document seal. */
import { widgetFrameAttributes, widgetPageTitle, withWidgetLead } from './widget-document'

const attribute = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export function exportedWidget(html: string): string {
  const title = widgetPageTitle(html) || 'Interactive widget'
  const attrs = widgetFrameAttributes().map(([key, value]) => `${key}="${attribute(value)}"`).join(' ')
  return `<figure class="wf-export-widget" style="margin:1.5em 0;max-width:100%;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden"><figcaption>${attribute(title)}</figcaption><iframe ${attrs} title="${attribute(title)}" style="display:block;width:100%;height:640px;border:0" srcdoc="${attribute(withWidgetLead(html))}"></iframe></figure>`
}

/** A file reader needs only height updates, never the app keyboard/IPC bridge. A frame can affect only
 * its own bounded height. Source identity, a fresh per-frame token and rate limit reject stray messages.
 * Installed before the frames are parsed so no ready message can race the listener.
 *
 * A page that is as tall as its own frame (`min-height:100vh`) with a margin that leaks past its body
 * reports the frame's height plus that margin; fitting the frame to it makes the next report larger,
 * without end. That loop is recognised by its length, not by one step: 12 reports in a row that each
 * ask for a taller frame, each within 400ms of the one before, with no pause and no report that asks
 * for the same or a smaller height in between. The frame then goes back to its default height and
 * stops following reports (its content still scrolls inside it). A widget that grows a few times and
 * stops never reaches 12 and keeps its content height. 12 is below the 20 reports a second the rate
 * limit lets through, so the loop is caught before the limit can leave the frame at a stretched height. */
export const WIDGET_EXPORT_RUNTIME = `<script>
(() => {
  const states = new WeakMap();
  window.addEventListener('message', event => {
    const d = event.data;
    if (!d || typeof d !== 'object' || d.wf !== 'writeflex-widget' || d.v !== 1) return;
    const frame = Array.from(document.querySelectorAll('.wf-export-widget iframe')).find(f => f.contentWindow === event.source);
    if (!frame) return;
    let state = states.get(frame);
    if (d.k === 'ready' && !state && Object.keys(d).length === 3) {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
      state = {token, since: performance.now(), count: 0, at: 0, run: 0, fixed: false}; states.set(frame, state);
      frame.contentWindow.postMessage({wf:'writeflex-widget',v:1,k:'hello',t:token}, '*');
    } else if (state && d.k === 'height' && Object.keys(d).length === 5 && d.t === state.token && Number.isInteger(d.h) && d.h >= 40 && d.h <= 20000) {
      const now = performance.now();
      if (now - state.since >= 1000) { state.since = now; state.count = 0; }
      if (++state.count > 20 || state.fixed) return;
      const grew = d.h > (parseFloat(frame.style.height) || 640);
      state.run = grew ? (now - state.at < 400 ? state.run + 1 : 1) : 0;
      state.at = now;
      if (state.run >= 12) { state.fixed = true; frame.style.height = '640px'; return; }
      frame.style.height = d.h + 'px';
    }
  });
})();
</script>`
