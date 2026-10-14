import { expect, test } from 'bun:test'
import {
  readingBookmarkColour,
  restoreReadingBookmark,
} from '../../src/renderer/src/reading-room-bookmarks'

test('a Reading Bookmark navigates the live reader to its saved view', async () => {
  const restored: Array<Record<string, unknown>> = []
  const position = { pageIndex: 4, scale: 1.25, scrollMode: 0 }

  await restoreReadingBookmark({
    navigateToViewState: async (state) => { restored.push(state) },
  }, position)

  expect(restored).toEqual([position])
})

test('bookmark thumb colours are stable and independent of the active highlight colour', () => {
  expect([
    readingBookmarkColour(0),
    readingBookmarkColour(1),
    readingBookmarkColour(2),
    readingBookmarkColour(3),
  ]).toEqual(['#75aab4', '#e0bd58', '#c9867c', '#75aab4'])
})
