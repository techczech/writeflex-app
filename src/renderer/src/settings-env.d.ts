import type { SettingsBridge } from '@app-patterns/settings-electron'
import type { WriteFlexSettingsApi } from '../../preload/settings-api'

declare global {
  interface Window {
    /** Only in the Settings window (preload/settings.ts). */
    bridleSettings: SettingsBridge
    /** Only in the Settings window (preload/settings.ts): WriteFlex's custom pages. */
    writeflexSettings: WriteFlexSettingsApi
  }
}

export {}
