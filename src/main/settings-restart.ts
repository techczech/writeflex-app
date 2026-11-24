import type { RecallableClose } from './restart-windows'

type SettingsWindow = { isDestroyed(): boolean; once(event: 'closed', callback: () => void): unknown; close(): void }

/** Settings has no document-close guard; include its normal close in the updater's existing commit. */
export function closeSettingsForRestart(window: SettingsWindow | null): RecallableClose[] {
  if (!window || window.isDestroyed()) return []
  const closed = new Promise<boolean>((resolve) => {
    window.once('closed', () => resolve(true))
    try { window.close() } catch { resolve(false) }
  })
  return [{ closed, abandon: () => false }]
}
