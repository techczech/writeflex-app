import type { ChangeSet, Text } from '@codemirror/state'
import type { LayoutCard } from './margin-layout'
import type { MarginCard, MarginModel } from './margin-model'

/** Margin and text column, in px. The margin is 372 in the locked drawing (ticket 01): the focused card's four actions fit on one line. */
export const MARGIN_WIDTH = 372
/**
 * The margin sits beside the text only while the editor leaves at least this much for the text column next to it
 * (ADR-0046 amendment, 2026-10-19: decided by the room left for the text, given the panes open now, not by the window
 * width; was windows from 1150 px). Otherwise the cards go inline, and the writer's choice of Margin is kept for when
 * the room returns.
 */
export const MARGIN_MIN_TEXT_WIDTH = 400

/**
 * The room left for the text column beside the margin: the editor pane's width (the scroller, whose own width does not
 * change with the margin's padding) less the margin. It counts the text column's own side gutters.
 */
export function textRoomBesideMargin(editorWidth: number): number {
  return Math.round(editorWidth) - MARGIN_WIDTH
}

/** Whether the margin fits beside the text. Unknown room (nothing measured yet) counts as fitting. */
export function marginFits(textRoom: number | null): boolean {
  return textRoom === null || textRoom >= MARGIN_MIN_TEXT_WIDTH
}
/** Space left under the last card before the next paragraph. */
export const UNDER_SPACER_GAP = 12
/** A card folded by the writer is one line high. */
export const FOLDED_CARD_HEIGHT = 36
export const DEFAULT_CARD_HEIGHT = 150

/** The paragraph a position is in: where its blank-line-delimited block starts. Equal keys = same paragraph. */
export function paragraphKey(document: string, pos: number): number {
  return document.lastIndexOf('\n\n', Math.max(0, Math.min(pos, document.length) - 1))
}

/**
 * `paragraphKey` read from the editor's own document tree, so a keystroke never copies the whole text. Returns the same
 * number for the same position as `paragraphKey` on `doc.toString()`: the offset of the nearest "\n\n" at or before the
 * position, which is the newline before the nearest empty line (one that is not the last), or -1.
 */
export function paragraphKeyAt(doc: Text, pos: number): number {
  const limit = Math.max(1, Math.min(pos, doc.length))
  let line = doc.lineAt(Math.min(limit, doc.length))
  for (;;) {
    if (line.from <= limit && line.from > 0 && line.length === 0 && line.number < doc.lines) return line.from - 1
    if (line.number <= 1) return -1
    line = doc.line(line.number - 1)
  }
}

/** What an editor update must tell the margin to decide whether any card can have moved (a `ViewUpdate` has all of it). */
export type MarginUpdate = {
  docChanged: boolean
  /** The measured line heights changed (not the same as `geometryChanged`, which CodeMirror also raises for every edit). */
  heightChanged: boolean
  /** Other lines are drawn than the edit alone would leave (the old viewport mapped through the change is not the new one). */
  viewportMoved: boolean
  changes: ChangeSet
  startState: { doc: { lines: number } }
  state: { doc: Text }
}

/** The viewport the margin last saw, and the document its offsets count in. */
export type SeenViewport = { from: number; to: number; doc: Text }

/**
 * Whether other lines are drawn than the edit alone would leave: the viewport last seen, mapped through the update's
 * change, is not the viewport now. The last-seen offsets count in the document they were read from; when the editor's
 * state was replaced since (a version shown, a restore, Compare), the update's change counts in another document, and
 * mapping through it would read past its end. A replaced document draws other lines, so it counts as moved.
 */
export function viewportMovedSince(
  was: SeenViewport | null,
  update: { changes: ChangeSet; startState: { doc: Text } },
  port: { from: number; to: number },
): boolean {
  if (!was || was.doc !== update.startState.doc) return true
  return update.changes.mapPos(was.from, -1) !== port.from || update.changes.mapPos(was.to, 1) !== port.to
}

/**
 * Whether an editor update can have moved a card's passage. Moving a passage needs the line heights to change (a
 * different number of lines, a wrap that gave way, a new viewport) or an edit inside a line that holds a passage
 * (its words can wrap differently). An edit elsewhere, such as a character typed in a line with no passage, moves
 * nothing, so the margin does not measure. `positions` are where the passages stood before the update.
 */
export function updateMovesCards(update: MarginUpdate, positions: readonly number[]): boolean {
  if (update.viewportMoved || update.heightChanged) return true
  if (!update.docChanged) return false
  const doc = update.state.doc
  if (update.startState.doc.lines !== doc.lines) return true
  if (positions.length === 0) return false
  // Positions past the end of the text the change starts from were read from another document (the editor's state was
  // replaced since the margin last rendered); they cannot be mapped, and the cards will be placed afresh.
  if (positions.some((pos) => pos > update.changes.length)) return true
  const mapped = positions.map((pos) => update.changes.mapPos(pos, 1))
  let moved = false
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    if (moved) return
    const start = doc.lineAt(Math.min(fromB, doc.length)).from
    const end = doc.lineAt(Math.min(toB, doc.length)).to
    if (mapped.some((pos) => pos >= start && pos <= end)) moved = true
  })
  return moved
}

/** Where the paragraph a position is in ends: before its blank line, or at the end of the document. */
export function paragraphEnd(document: string, pos: number): number {
  const at = Math.max(0, Math.min(pos, document.length))
  const blank = document.indexOf('\n\n', at)
  const end = blank === -1 ? document.length : blank
  return Math.max(at, document.slice(0, end).replace(/\s+$/, '').length)
}

export function effectiveMarginView(preferred: 'margin' | 'under', textRoom: number | null): 'margin' | 'under' {
  return preferred === 'margin' && marginFits(textRoom) ? 'margin' : 'under'
}

export type MeasuredCards = {
  /** Top of each card's passage in scroller-content coordinates. */
  anchorTops: ReadonlyMap<string, number>
  /** Last measured height of each card fully drawn. */
  heights: ReadonlyMap<string, number>
  /** The lowest a card may start: below the top of the margin. */
  floor: number
  foldedIds: ReadonlySet<string>
}

/** The layout engine's input from the model's cards and what was measured in the DOM. */
export function layoutCardsFor(cards: MarginCard[], document: string, measured: MeasuredCards): LayoutCard[] {
  const out: LayoutCard[] = []
  for (const card of cards) {
    const top = measured.anchorTops.get(card.id)
    if (top === undefined) continue
    out.push({
      id: card.id,
      paragraph: paragraphKey(document, card.anchor.from),
      anchorTop: Math.max(top, measured.floor),
      passageTop: top,
      floor: measured.floor,
      height: measured.foldedIds.has(card.id) ? FOLDED_CARD_HEIGHT : measured.heights.get(card.id) ?? DEFAULT_CARD_HEIGHT,
    })
  }
  return out
}

/** The paragraph key of the items with no known paragraph: they sit together at the top of the margin. */
export const TOP_PARAGRAPH = 'top'

/**
 * One thing the margin draws, in the order it lays them out (ticket 06): a card at its words, a settled row
 * where its words stand now, an item that could not be placed at its paragraph. `pos` is null for an item
 * with no known paragraph (top of the margin, under the filter line). `row`: a settled row, one line.
 */
export type MarginEntry = { id: string; pos: number | null; row?: true }

/** Everything the margin draws, top items first, then in document order (cards before rows at one place). */
export function marginEntriesOf(model: Pick<MarginModel, 'cards' | 'settled' | 'unplaced'> & Partial<Pick<MarginModel, 'mode'>>): MarginEntry[] {
  const placed: Array<MarginEntry & { tie: number }> = []
  const top: MarginEntry[] = []
  // In Settled today (ticket 08) the settled items are full cards, measured like any card; otherwise one-line rows.
  const asRow = model.mode !== 'settled'
  model.cards.forEach((card, index) => placed.push({ id: card.id, pos: card.anchor.from, tie: index }))
  model.settled.forEach((row, index) => {
    const pos = row.anchor?.from ?? row.at
    if (pos === null) top.push({ id: row.id, pos: null, ...(asRow ? { row: true as const } : {}) })
    else placed.push({ id: row.id, pos, ...(asRow ? { row: true as const } : {}), tie: model.cards.length + index })
  })
  model.unplaced.forEach((item, index) => {
    if (item.at === null) top.push({ id: item.id, pos: null })
    else placed.push({ id: item.id, pos: item.at, tie: model.cards.length + model.settled.length + index })
  })
  placed.sort((a, b) => a.pos! - b.pos! || a.tie - b.tie)
  return [...top, ...placed.map(({ tie: _tie, ...entry }) => entry)]
}

/** The layout engine's input for every entry. An item with no known paragraph sits at the floor (top of the margin). */
export function layoutEntriesFor(entries: readonly MarginEntry[], document: string, measured: MeasuredCards): LayoutCard[] {
  const out: LayoutCard[] = []
  for (const entry of entries) {
    const top = entry.pos === null ? measured.floor : measured.anchorTops.get(entry.id)
    if (top === undefined) continue
    out.push({
      id: entry.id,
      paragraph: entry.pos === null ? TOP_PARAGRAPH : paragraphKey(document, entry.pos),
      anchorTop: Math.max(top, measured.floor),
      passageTop: top,
      floor: measured.floor,
      height: entry.row ? FOLDED_CARD_HEIGHT : measured.foldedIds.has(entry.id) ? FOLDED_CARD_HEIGHT : measured.heights.get(entry.id) ?? DEFAULT_CARD_HEIGHT,
      ...(entry.row ? { row: true } : {}),
    })
  }
  return out
}
