import type { SettingValue } from '../../preload'

export function applyReadingRoomSetting(
  key: string,
  value: SettingValue | null,
  setSide: (side: 'left' | 'right') => void,
): boolean {
  if (key === 'readingRoom.open') {
    // Kept as an inert stored value for compatibility with existing settings files.
    return true
  }
  if (key === 'readingRoom.side') {
    setSide(value === 'right' ? 'right' : 'left')
    return true
  }
  return false
}
