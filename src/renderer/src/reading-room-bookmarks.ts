import type { ReaderViewState } from '@readflex/reader-embed'

type ReadingBookmarkRestorer = {
  navigateToViewState(state: ReaderViewState): Promise<void>
}

const READING_BOOKMARK_COLOURS = ['#75aab4', '#e0bd58', '#c9867c'] as const

/** A Reading Bookmark stores a complete reader view, not an annotation position. */
export function restoreReadingBookmark(
  reader: ReadingBookmarkRestorer,
  position: ReaderViewState,
): Promise<void> {
  return reader.navigateToViewState(position)
}

/** Thumb colours distinguish saved places and never follow the active highlighting tool. */
export function readingBookmarkColour(index: number): string {
  return READING_BOOKMARK_COLOURS[index % READING_BOOKMARK_COLOURS.length]
}
