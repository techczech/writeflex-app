import { join } from 'node:path'

/** Import surface for isolated main-process probes. Each probe supplies its own IPC, app and I/O seams. */
export const electronMainStandIn = {
  BrowserWindow: class {
    static getFocusedWindow(): null { return null }
    static getAllWindows(): never[] { return [] }
  },
  webFrameMain: { fromId: () => null },
  nativeTheme: { shouldUseDarkColors: false, on: () => {}, removeListener: () => {} },
  Menu: {},
  net: {},
  session: {},
}

/** Use the real settings contract with the probe's throwaway user-data directory. */
export async function settingsForIpcTest(profile: string) {
  const { SettingsStore } = await import('../../src/main/settings')
  return new SettingsStore(join(profile, 'settings.json'))
}
