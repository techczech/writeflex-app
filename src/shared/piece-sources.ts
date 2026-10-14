/**
 * A piece's sources, listed and cited (docs/design/2026-09-27-scraps-and-sources-on-the-board, frame 5):
 * the piece's frontmatter `sources:` list merged with what its text cites. Shared by main (the matcher,
 * the `sources.list` verb) and the renderer (the list popover).
 */

/** `listed`: only in the `sources:` list. `cited`: cited in the text, not listed. `both`: each. */
export type SourceStatus = 'listed' | 'cited' | 'both'

export type SourceListEntry = {
  title: string
  /** Null when a listed entry names no file in the collection. */
  path: string | null
  status: SourceStatus
  /** How many times the text cites it: wikilinks plus matched author–year citations. */
  cited: number
  links: number
  authorYear: number
}

/** An author–year citation that more than one research note fits; it is shown, never counted. */
export type AmbiguousCitation = {
  text: string
  count: number
  candidates: Array<{ path: string; title: string }>
}

export type AuthorYearAvailability = {
  /** Research notes carrying both author and year in their frontmatter. */
  notesWithMetadata: number
  notesTotal: number
  /** False when no note carries both: only wikilinks counted. */
  available: boolean
  /** The sentence the list shows about it; null when matching ran on every research note. */
  message: string | null
}

export type PieceSourceListing = {
  piece: string
  pieceTitle: string
  /** The collection the piece was read in; "Add to sources" passes it to the attach. */
  dir: string
  entries: SourceListEntry[]
  ambiguous: AmbiguousCitation[]
  authorYearMatching: AuthorYearAvailability
}

/** The line under a source's title in the list (frame 5). */
export function sourceStatusLine(entry: Pick<SourceListEntry, 'status' | 'cited'>): string {
  if (entry.status === 'listed') return 'listed'
  if (entry.status === 'both') return `listed · cited ${entry.cited}×`
  return 'cited in the text, not listed'
}
