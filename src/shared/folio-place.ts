/**
 * Where one file sits in its Folio, worked out from facts the main process has already resolved:
 * the Folio's pieces in order, and the path of its Index Note. Pure, so main (which gathers the facts)
 * and the tests share one rule. The line above the text and the title-bar button read the result.
 */

/** 'piece' = listed in the running order; 'index' = the Index Note and not itself a piece;
 *  'unlisted' = inside the Folio's folder but not in its running order. */
export type FolioPlaceKind = 'piece' | 'index' | 'unlisted'

export type FolioPlaceFacts = {
  kind: FolioPlaceKind
  /** 1-based, in the list with repeats removed; null unless kind is 'piece'. */
  position: number | null
  /** Pieces in the running order, repeats removed. */
  total: number
  previous: string | null
  /** For the Index Note, the first piece. */
  next: string | null
}

/** A piece listed twice keeps its first position. */
export function uniquePieces(pieces: readonly string[]): string[] {
  return [...new Set(pieces)]
}

export function folioPlaceFacts(path: string, pieces: readonly string[], indexNote: string): FolioPlaceFacts {
  const order = uniquePieces(pieces)
  const at = order.indexOf(path)
  if (at >= 0) {
    return { kind: 'piece', position: at + 1, total: order.length, previous: order[at - 1] ?? null, next: order[at + 1] ?? null }
  }
  if (path === indexNote) return { kind: 'index', position: null, total: order.length, previous: null, next: order[0] ?? null }
  return { kind: 'unlisted', position: null, total: order.length, previous: null, next: null }
}

/** What the renderer receives: the facts plus the Folio and the neighbours' titles. */
export type FolioPlace = {
  /** The Folio's folder, workspace-relative ('' = the workspace root). */
  dir: string
  name: string
  kind: FolioPlaceKind
  position: number | null
  total: number
  previous: { path: string; title: string } | null
  next: { path: string; title: string } | null
}
