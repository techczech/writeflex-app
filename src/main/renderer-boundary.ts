import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { decideNavigation } from './navigation'

const documents = new WeakMap<WebContents, { url: string; role: 'editor' | 'settings' }>()

export function registerRenderer(contents: WebContents, url: string, role: 'editor' | 'settings'): void {
  documents.set(contents, { url, role })
  contents.on('will-attach-webview', event => event.preventDefault())
}

export function trustedRenderer(event: IpcMainEvent | IpcMainInvokeEvent, role?: 'editor' | 'settings'): boolean {
  const document = documents.get(event.sender)
  const frame = event.senderFrame
  return Boolean(document && (!role || document.role === role) && frame && frame === event.sender.mainFrame
    && decideNavigation(document.url, frame.url) === 'allow')
}
