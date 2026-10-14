import { expect, test } from 'bun:test'
import type { SettingValue } from '../../src/preload'

test('the Reading Room settings applier keeps open inert while still applying side', async () => {
  const module = await import('../../src/renderer/src/reading-room-settings').catch(() => ({}))
  const apply = (module as Record<string, unknown>).applyReadingRoomSetting
  expect(typeof apply).toBe('function')

  const sides: Array<'left' | 'right'> = []
  const run = apply as (
    key: string,
    value: SettingValue | null,
    setSide: (side: 'left' | 'right') => void,
  ) => boolean

  expect(run('readingRoom.open', true, (side) => sides.push(side))).toBe(true)
  expect(sides).toEqual([])
  expect(run('readingRoom.side', 'right', (side) => sides.push(side))).toBe(true)
  expect(sides).toEqual(['right'])
  expect(run('appearance.theme', 'dark', (side) => sides.push(side))).toBe(false)
})
