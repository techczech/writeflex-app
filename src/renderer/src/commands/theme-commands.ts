/**
 * Theme commands (Requirement: "I don't know how to switch to dark theme — no command for
 * it."). Palette-only, keyless: they set `appearance.theme` through the ONE settings write path, so
 * persistence, the changelog and the boot-time apply (App applySetting / windows.ts background)
 * keep working. The setting holds 'light' | 'dark' only, so there is no follow-system command.
 */
import type { SettingValue } from '../../../preload'

export const THEME_SETTING = 'appearance.theme'
export type ThemeValue = 'light' | 'dark'

export const THEME_COMMANDS = [
  { id: 'appearance.darkTheme', label: 'Use dark theme', value: 'dark', keywords: ['dark', 'theme', 'appearance', 'night'] },
  { id: 'appearance.lightTheme', label: 'Use light theme', value: 'light', keywords: ['light', 'theme', 'appearance', 'day'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; value: ThemeValue; keywords: readonly string[] }>

export type ThemeCommandId = (typeof THEME_COMMANDS)[number]['id']

type SettingSetter = (key: string, value: SettingValue | null, label: string) => void

/** Run one theme command against the settings setter; false when `id` is not a theme command. */
export function runThemeCommand(id: string, set: SettingSetter): boolean {
  const command = THEME_COMMANDS.find((entry) => entry.id === id)
  if (!command) return false
  set(THEME_SETTING, command.value, 'Theme')
  return true
}
