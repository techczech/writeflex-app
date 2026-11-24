import { randomUUID } from 'node:crypto'
import { withWidgetLead, WIDGET_PAGE_POLICY } from '../shared/widget-document'
import { trustedRenderer } from './renderer-boundary'
import { WIDGET_MAX_BYTES } from './widget-file'

// A capability remains available for the life of the mounted widget. Moving an iframe in the DOM
// creates a new browsing context and Chromium must be able to fetch the same document again.
const documents = new Map<string, { html: string; owner: Electron.WebContents }>()
const watched = new WeakSet<Electron.WebContents>()
const documentKey = (url: string): string => url.split('#', 1)[0]!

export function ownsWidgetDocument(owner: Electron.WebContents, url: string): boolean {
  return documents.get(documentKey(url))?.owner === owner
}

export function registerWidgetProtocol(protocol: Electron.Protocol, ipcMain: Electron.IpcMain): void {
  const issue = (event: Electron.IpcMainEvent, html: unknown): string | null => {
    if (!trustedRenderer(event, 'editor') || typeof html !== 'string' || Buffer.byteLength(html) > WIDGET_MAX_BYTES) return null
    const owner = event.sender
    if ([...documents.values()].filter(entry => entry.owner === owner).length >= 64) return null
    if (!watched.has(owner)) {
      watched.add(owner)
      const clear = () => { for (const [url, entry] of documents) if (entry.owner === owner) documents.delete(url) }
      owner.once('destroyed', clear)
      owner.on('render-process-gone', clear)
      owner.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
        if (isMainFrame) clear()
      })
    }
    const url = `wf-widget://document/${randomUUID()}`
    documents.set(url, { html, owner })
    return url
  }
  ipcMain.on('widget:document-url', (event, html: unknown) => { event.returnValue = issue(event, html) })
  ipcMain.on('widget:release-document-url', (event, url: unknown) => {
    if (typeof url === 'string' && trustedRenderer(event, 'editor') && ownsWidgetDocument(event.sender, url)) documents.delete(documentKey(url))
  })

  protocol.handle('wf-widget', request => {
    const document = documents.get(documentKey(request.url))
    if (!document || document.owner.isDestroyed() || request.method !== 'GET' || (request.destination && request.destination !== 'iframe')) {
      return new Response(null, { status: 404 })
    }
    return new Response(withWidgetLead(document.html, { ownDocument: true }), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `${WIDGET_PAGE_POLICY}; sandbox allow-scripts allow-forms`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
      },
    })
  })
}
