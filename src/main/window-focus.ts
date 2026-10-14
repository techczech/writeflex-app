export type FocusForwardingWindow = {
  on(event: 'focus', listener: () => void): unknown
  webContents: {
    isDestroyed(): boolean
    send(channel: 'window:focused'): unknown
  }
}

/**
 * Forward Electron's application-window focus, not the renderer window's DOM focus. A same-origin
 * reader iframe blurs and refocuses the top-level DOM window during ordinary reading; BrowserWindow
 * focus changes only when WriteFlex itself becomes frontmost.
 */
export function forwardBrowserWindowFocus(window: FocusForwardingWindow): void {
  window.on('focus', () => {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send('window:focused')
    }
  })
}
