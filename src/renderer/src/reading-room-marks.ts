import type { ReaderToolInput } from '@readflex/reader-embed'

export const READING_HIGHLIGHT_COLOURS = {
  yellow: { label: 'Yellow', value: '#ffd400' },
  cyan: { label: 'Cyan', value: '#2ea8e5' },
  rose: { label: 'Rose', value: '#ff6666' },
  green: { label: 'Green', value: '#5fb236' },
  violet: { label: 'Violet', value: '#a28ae5' },
} as const

export type ReadingHighlightColour = keyof typeof READING_HIGHLIGHT_COLOURS
export type ReadingRoomMarkMode = 'area' | 'highlight' | null
export type ReadingRoomMarkState = {
  colour: ReadingHighlightColour
  mode: ReadingRoomMarkMode
}

export function initialReadingRoomMarkState(): ReadingRoomMarkState {
  return { colour: 'yellow', mode: 'highlight' }
}

export function selectHighlightMode(state: ReadingRoomMarkState): ReadingRoomMarkState {
  return state.mode === 'highlight' ? state : { ...state, mode: 'highlight' }
}

export function selectHighlightColour(
  state: ReadingRoomMarkState,
  colour: ReadingHighlightColour,
): ReadingRoomMarkState {
  return { ...state, colour, mode: 'highlight' }
}

export function selectAreaMode(state: ReadingRoomMarkState): ReadingRoomMarkState {
  return { ...state, mode: 'area' }
}

export function leaveReadingRoomMarkMode(state: ReadingRoomMarkState): ReadingRoomMarkState {
  return { ...state, mode: null }
}

export function completeAreaCapture(state: ReadingRoomMarkState): ReadingRoomMarkState {
  return state.mode === 'area' ? leaveReadingRoomMarkMode(state) : state
}

export function readingRoomTool(state: ReadingRoomMarkState): ReaderToolInput {
  if (state.mode === 'highlight') {
    return { color: READING_HIGHLIGHT_COLOURS[state.colour].value, type: 'highlight' }
  }
  if (state.mode === 'area') {
    return { color: READING_HIGHLIGHT_COLOURS[state.colour].value, type: 'image' }
  }
  return { type: 'pointer' }
}

export function markStatus(state: ReadingRoomMarkState): string | null {
  if (state.mode === 'highlight') {
    const colour = READING_HIGHLIGHT_COLOURS[state.colour].label
    return `Highlight mode · ${colour}. Drag over text to keep marking with this colour. Escape leaves the mode.`
  }
  if (state.mode === 'area') {
    return 'Drag a rectangle over a chart or table. Escape cancels.'
  }
  return null
}
