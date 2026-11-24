// Signing in, signing out and saving a key change Accounts and keys, so their bridle.auth channels are
// answered only for the Settings window (shared settings, 2026-10-20; the check is the shared package's
// isSettingsWindowSender, given the whole event). The provider list and the event stream stay open to
// every window: the agent panel and the Guide show who is connected. A credential an editor action
// mints (a Collection's reply keys) is not here: it stays with the editor.
/** The bridle.auth channels that change a sign-in or a key: only the Settings window may call them. */
export const SETTINGS_ONLY_AUTH_CHANNELS: ReadonlySet<string> = new Set([
  'bridle.auth:login', 'bridle.auth:cancel', 'bridle.auth:respond', 'bridle.auth:set-api-key', 'bridle.auth:logout',
])

/** ipcMain as the auth registration sees it: its mutating handlers refuse any sender but the Settings window. */
export function settingsWindowOnlyAuth<T extends { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void; removeHandler(channel: string): void }>(
  ipc: T,
  isSettingsSender: (event: unknown) => boolean,
): { handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void; removeHandler(channel: string): void } {
  return {
    handle(channel, listener) {
      if (!SETTINGS_ONLY_AUTH_CHANNELS.has(channel)) { ipc.handle(channel, listener); return }
      ipc.handle(channel, (event: unknown, ...args: unknown[]) => {
        if (!isSettingsSender(event)) throw new Error('Sign in and keys are changed in Settings › Accounts and keys.')
        return listener(event, ...args)
      })
    },
    removeHandler: (channel) => ipc.removeHandler(channel),
  }
}
