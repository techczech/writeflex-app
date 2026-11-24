export const THEME_SETTING = 'appearance.theme'
export const DEFAULT_THEME = 'light'
export type ThemeValue = 'light' | 'dark' | 'system'

export function themePreference(value: unknown): ThemeValue {
  return value === 'dark' || value === 'system' ? value : DEFAULT_THEME
}

export function usesDarkTheme(value: unknown, systemIsDark: boolean): boolean {
  const theme = themePreference(value)
  return theme === 'dark' || (theme === 'system' && systemIsDark)
}
