/** Hidden automation must never show, restore or focus a native window. */
export function e2eHidden(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.WRITEFLEX_E2E === '1'
}

type FocusableWindow = { isDestroyed(): boolean; focus(): void }
type MainWindow = FocusableWindow & { show(): void }
type RestorableWindow = FocusableWindow & { isMinimized(): boolean; restore(): void }

export function focusWindow(window: FocusableWindow): void {
  if (e2eHidden() || window.isDestroyed()) return
  window.focus()
}

/** Shared by the Settings frame menu and its custom-page command IPC. */
export function openMain(window: MainWindow): void {
  if (e2eHidden() || window.isDestroyed()) return
  window.show()
  window.focus()
}

/** Bring a second-instance request forward, including a minimised window. */
export function focusAnyWindow(windows: readonly RestorableWindow[]): void {
  if (e2eHidden()) return
  const [window] = windows
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.focus()
}
