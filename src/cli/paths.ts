import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The folder Electron calls `userData` for WriteFlex (appData/writeflex-desktop, or -beta for the beta
 * app: main/app-variant.ts), worked out without Electron so `writeflex settings` finds the same
 * settings-v2.json as the app. WRITEFLEX_DATA_DIR overrides it (tests, and a run against a copy).
 */
export function userDataDir(
  variantDir: 'writeflex-desktop' | 'writeflex-desktop-beta' = 'writeflex-desktop',
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): string {
  const override = env['WRITEFLEX_DATA_DIR']?.trim()
  if (override) return override
  if (platform === 'darwin') return join(env['HOME'] || homedir(), 'Library', 'Application Support', variantDir)
  if (platform === 'win32') return join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), variantDir)
  return join(env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), variantDir)
}
