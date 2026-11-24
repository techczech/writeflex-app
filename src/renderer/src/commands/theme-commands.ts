import type { SettingValue } from '../../../preload'
import { THEME_SETTING, type ThemeValue } from '../../../shared/appearance'

export const THEME_COMMANDS = [
  { id: 'appearance.darkTheme', label: 'Use dark theme', value: 'dark', keywords: ['dark', 'theme', 'appearance', 'night'] },
  { id: 'appearance.lightTheme', label: 'Use light theme', value: 'light', keywords: ['light', 'theme', 'appearance', 'day'] },
  { id: 'appearance.systemTheme', label: 'Match system', value: 'system', keywords: ['system', 'theme', 'appearance', 'macOS'] },
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
