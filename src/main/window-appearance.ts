import { nativeTheme } from 'electron'
import { usesDarkTheme } from '../shared/appearance'

export function windowBackgrounds(preference: unknown): { editor: string; settings: string } {
  return usesDarkTheme(preference, nativeTheme.shouldUseDarkColors)
    ? { editor: '#1a1a1e', settings: '#212124' }
    : { editor: '#f6f5f1', settings: '#ececf0' }
}
