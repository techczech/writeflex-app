import { useLayoutEffect } from 'react'
import { themePreference, usesDarkTheme } from '../../../shared/appearance'

export function useAppearance(value: unknown, onApplied?: () => void): void {
  const theme = themePreference(value)
  useLayoutEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = usesDarkTheme(theme, media.matches)
      const root = document.documentElement
      if (dark) root.dataset.theme = 'dark'
      else delete root.dataset.theme
      onApplied?.()
    }

    apply()
    if (theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme, onApplied])
}
