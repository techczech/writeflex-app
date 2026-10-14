import { expect, test } from 'bun:test'
import {
  READING_HIGHLIGHT_COLOURS,
  completeAreaCapture,
  initialReadingRoomMarkState,
  leaveReadingRoomMarkMode,
  markStatus,
  readingRoomTool,
  selectAreaMode,
  selectHighlightColour,
  selectHighlightMode,
} from '../../src/renderer/src/reading-room-marks'

test('starts in persistent Yellow Highlight mode and exposes the accepted five colours', () => {
  const state = initialReadingRoomMarkState()

  expect(state).toEqual({ colour: 'yellow', mode: 'highlight' })
  expect(READING_HIGHLIGHT_COLOURS).toEqual({
    cyan: { label: 'Cyan', value: '#2ea8e5' },
    green: { label: 'Green', value: '#5fb236' },
    rose: { label: 'Rose', value: '#ff6666' },
    violet: { label: 'Violet', value: '#a28ae5' },
    yellow: { label: 'Yellow', value: '#ffd400' },
  })
  expect(readingRoomTool(state)).toEqual({ color: '#ffd400', type: 'highlight' })
  expect(markStatus(state)).toBe(
    'Highlight mode · Yellow. Drag over text to keep marking with this colour. Escape leaves the mode.',
  )
})

test('changing colour keeps Highlight active and updates the reader tool', () => {
  const state = selectHighlightColour(selectAreaMode(initialReadingRoomMarkState()), 'cyan')

  expect(state).toEqual({ colour: 'cyan', mode: 'highlight' })
  expect(readingRoomTool(state)).toEqual({ color: '#2ea8e5', type: 'highlight' })
  expect(selectHighlightMode(state)).toEqual(state)
})

test('Area is armed once and completion or Escape returns the reader to pointer mode', () => {
  const area = selectAreaMode(selectHighlightColour(initialReadingRoomMarkState(), 'rose'))

  expect(area).toEqual({ colour: 'rose', mode: 'area' })
  expect(readingRoomTool(area)).toEqual({ color: '#ff6666', type: 'image' })
  expect(markStatus(area)).toBe('Drag a rectangle over a chart or table. Escape cancels.')
  expect(completeAreaCapture(area)).toEqual({ colour: 'rose', mode: null })
  expect(readingRoomTool(completeAreaCapture(area))).toEqual({ type: 'pointer' })
  expect(markStatus(leaveReadingRoomMarkMode(area))).toBeNull()
})
