/**
 * The margin layout engine. Pure: card anchors and heights in, card tops and fold states out.
 *
 * Cards sit level with their passage, one paragraph at a time. When a card would land more than
 * `maxDrift` below its passage (or would push the next paragraph's first card more than `maxDrift`
 * below that paragraph), the paragraph folds in steps: threads to one line, then one stack of one-line
 * rows ("N items on this paragraph"), then one folded line. A single card skips the stack and folds to
 * one line. A card the writer opened stays open. While the writer types nothing folds, stacks or opens,
 * and cards move only by whole lines.
 *
 * A settled row (ticket 06: an item settled during this visit) is always one line: `row` beside its words,
 * a row of the stack when its paragraph stacks, and part of the folded line when it folds. It counts as
 * one of its paragraph's items.
 */

export type MarginFold = 'open' | 'thread-line' | 'stack' | 'line' | 'row'

export type LayoutCard = {
  id: string
  /** Cards sharing a paragraph key are folded together. Keys need only be equal or not. */
  paragraph: string | number
  /** Top of the passage, in margin coordinates. Cards arrive in document order. */
  anchorTop: number
  /** Height with the card fully drawn. */
  height: number
  /** A thread (has replies) can fold to one line before the paragraph stacks. */
  isThread?: boolean
  /** The passage's true top, before any floor. Typing moves a card by this, so a floor that moves does not move it. */
  passageTop?: number
  /** The lowest top a card may take (below the top of the margin). Re-applied on every pass, both ways. */
  floor?: number
  /** A settled row: one line at every step, never opened. */
  row?: boolean
}

export type LayoutOptions = {
  maxDrift?: number
  gap?: number
  lineHeight?: number
  /** Height of a one-line row (thread line, stack row, folded line). */
  rowHeight?: number
  stackHeadHeight?: number
}

export type LayoutInput = {
  cards: LayoutCard[]
  /** Ids of cards the writer opened; they stay open. */
  openIds?: ReadonlySet<string>
  /** True while the writer is typing: freeze folds, move by whole lines. */
  typing?: boolean
  /** The layout drawn last, needed while typing. */
  previous?: MarginLayout | null
  options?: LayoutOptions
}

export type Placement = {
  id: string
  paragraph: string | number
  top: number
  height: number
  fold: MarginFold
  anchorTop: number
  /** In a folded line the paragraph's cards are not drawn individually. */
  hidden: boolean
  /** The top before the floor was applied. Typing moves this, then the floor is re-applied. */
  base?: number
  /** The passage's true top (before any floor), the reference for typing moves. */
  passage?: number
}
export type GroupFold = 'full' | 'threads' | 'stack' | 'line'
export type ParagraphGroup = { paragraph: string | number; fold: GroupFold; top: number; bottom: number; count: number }
export type MarginLayout = { placements: Placement[]; groups: ParagraphGroup[] }

export const DEFAULT_LAYOUT: Required<LayoutOptions> = { maxDrift: 120, gap: 8, lineHeight: 24, rowHeight: 24, stackHeadHeight: 24 }

type Plan = { fold: GroupFold; placements: Placement[]; top: number; bottom: number; drift: number }

function paragraphsOf(cards: LayoutCard[]): LayoutCard[][] {
  const groups: LayoutCard[][] = []
  for (const card of cards) {
    const last = groups[groups.length - 1]
    if (last && last[0].paragraph === card.paragraph) last.push(card)
    else groups.push([card])
  }
  return groups
}

/** The top a card would take with no floor: a card the floor pushed down goes back to its passage. */
function baseTopOf(card: LayoutCard, top: number): number {
  const passage = card.passageTop ?? card.anchorTop
  return top === card.anchorTop && passage < card.anchorTop ? passage : top
}

function planParagraph(group: LayoutCard[], fold: GroupFold, from: number, openIds: ReadonlySet<string>, o: Required<LayoutOptions>): Plan {
  const first = group[0]
  const placements: Placement[] = []
  let cursor = from
  let drift = 0
  const put = (card: LayoutCard, top: number, height: number, state: MarginFold, hidden = false, base: number = top): void => {
    placements.push({ id: card.id, paragraph: card.paragraph, top, height, fold: state, anchorTop: card.anchorTop, hidden, base, passage: card.passageTop ?? card.anchorTop })
  }
  if (fold === 'line') {
    // One folded line for the whole paragraph; opened cards still draw open below it.
    const top = Math.max(first.anchorTop, cursor)
    drift = top - first.anchorTop
    cursor = top + o.rowHeight + o.gap
    // A paragraph with one item folds to that item's own line (frame `many`), not to "1 items on this paragraph".
    if (group.length === 1 && !openIds.has(first.id)) {
      put(first, top, o.rowHeight, first.row ? 'row' : 'line')
      return { fold, placements, top, bottom: cursor, drift }
    }
    for (const card of group) {
      if (openIds.has(card.id) && !card.row) { put(card, cursor, card.height, 'open'); cursor += card.height + o.gap } else put(card, top, 0, 'line', true)
    }
    return { fold, placements, top, bottom: cursor, drift }
  }
  if (fold === 'stack') {
    const top = Math.max(first.anchorTop, cursor)
    drift = top - first.anchorTop
    cursor = top + o.stackHeadHeight
    for (const card of group) {
      const open = openIds.has(card.id) && !card.row
      const height = open ? card.height : o.rowHeight
      put(card, cursor, height, open ? 'open' : 'stack')
      cursor += height
    }
    return { fold, placements, top, bottom: cursor + o.gap, drift }
  }
  const top = Math.max(first.anchorTop, cursor)
  for (const card of group) {
    const open = openIds.has(card.id) && !card.row
    const line = fold === 'threads' && card.isThread && !open
    const cardTop = Math.max(card.anchorTop, cursor)
    // An opened card is allowed to sit far below its passage; it never triggers folding.
    if (!open) drift = Math.max(drift, cardTop - card.anchorTop)
    const height = line || card.row ? o.rowHeight : card.height
    put(card, cardTop, height, card.row ? 'row' : line ? 'thread-line' : 'open', false, baseTopOf(card, cardTop))
    cursor = cardTop + height + o.gap
  }
  return { fold, placements, top, bottom: cursor, drift }
}

function ladder(group: LayoutCard[]): GroupFold[] {
  const steps: GroupFold[] = ['full']
  if (group.some((card) => card.isThread)) steps.push('threads')
  if (group.length > 1) steps.push('stack')
  steps.push('line')
  return steps
}

function crowdingPass(input: LayoutInput, o: Required<LayoutOptions>): MarginLayout {
  const openIds = input.openIds ?? new Set<string>()
  const paragraphs = paragraphsOf(input.cards)
  const placements: Placement[] = []
  const groups: ParagraphGroup[] = []
  let cursor = Number.NEGATIVE_INFINITY
  paragraphs.forEach((group, index) => {
    const next = paragraphs[index + 1]?.[0]
    const steps = ladder(group)
    let chosen: Plan | null = null
    for (const fold of steps) {
      const plan = planParagraph(group, fold, cursor, openIds, o)
      chosen = plan
      if (plan.drift > o.maxDrift) continue
      // Would this paragraph push the next paragraph's first card past the limit?
      if (next && !openIds.has(next.id) && Math.max(next.anchorTop, plan.bottom) - next.anchorTop > o.maxDrift) continue
      break
    }
    const plan = chosen as Plan
    placements.push(...plan.placements)
    groups.push({ paragraph: group[0].paragraph, fold: plan.fold, top: plan.top, bottom: plan.bottom, count: group.length })
    cursor = plan.bottom
  })
  return { placements, groups }
}

function stateHeight(card: LayoutCard, fold: MarginFold, o: Required<LayoutOptions>): number {
  return fold === 'thread-line' || fold === 'stack' || fold === 'row' ? o.rowHeight : fold === 'line' ? 0 : card.height
}

function placedBelowFloor(base: number, card: LayoutCard): number {
  return card.floor === undefined ? base : Math.max(base, card.floor)
}

/** While typing: keep every fold, move each card by the passage's movement rounded to whole lines. */
function typingPass(input: LayoutInput, previous: MarginLayout, o: Required<LayoutOptions>): MarginLayout {
  const before = new Map(previous.placements.map((p) => [p.id, p]))
  const placements: Placement[] = input.cards.map((card) => {
    const prior = before.get(card.id)
    if (!prior) {
      // An arrival is placed level with its passage, whole-line snapped, and drawn full.
      const passage = card.passageTop ?? card.anchorTop
      const base = Math.round(passage / o.lineHeight) * o.lineHeight
      return { id: card.id, paragraph: card.paragraph, top: placedBelowFloor(base, card), height: card.height, fold: 'open', anchorTop: card.anchorTop, hidden: false, base, passage }
    }
    // Typing moves the card by the passage's movement, in whole lines, from where it was without the floor.
    // The current floor is then re-applied, so a top that shrank brings the card back up at once.
    const passage = card.passageTop ?? card.anchorTop
    const priorPassage = prior.passage ?? prior.anchorTop
    const shift = Math.round((passage - priorPassage) / o.lineHeight) * o.lineHeight
    const base = (prior.base ?? prior.top) + shift
    return {
      id: card.id,
      paragraph: card.paragraph,
      top: placedBelowFloor(base, card),
      height: stateHeight(card, prior.fold, o) || prior.height,
      fold: prior.fold,
      anchorTop: card.anchorTop,
      hidden: prior.hidden,
      base,
      passage,
    }
  })
  const groups = previous.groups
    .map((group) => {
      const own = placements.filter((p) => p.paragraph === group.paragraph)
      if (own.length === 0) return null
      const top = Math.min(...own.map((p) => p.top))
      return { ...group, count: own.length, top, bottom: Math.max(...own.map((p) => p.top + p.height), top) }
    })
    .filter((g): g is ParagraphGroup => g !== null)
  return { placements, groups }
}

export function layoutMargin(input: LayoutInput): MarginLayout {
  const o = { ...DEFAULT_LAYOUT, ...input.options }
  if (input.typing && input.previous) return typingPass(input, input.previous, o)
  return crowdingPass(input, o)
}

/** Under the passage there is no vertical alignment: three or more cards on one paragraph become a stack. */
export function underPassageFolds(cards: Array<{ id: string; paragraph: string | number }>, openIds: ReadonlySet<string> = new Set()): Map<string, 'open' | 'stack'> {
  const sizes = new Map<string | number, number>()
  for (const card of cards) sizes.set(card.paragraph, (sizes.get(card.paragraph) ?? 0) + 1)
  return new Map(cards.map((card) => [card.id, (sizes.get(card.paragraph) ?? 0) >= 3 && !openIds.has(card.id) ? 'stack' : 'open']))
}

export type UnderPlacement = { id: string; paragraph: string | number; top: number; height: number; fold: 'open' | 'stack' | 'row' }
export type UnderGroup = { paragraph: string | number; fold: 'full' | 'stack'; top: number; bottom: number; count: number }
export type UnderLayout = { placements: UnderPlacement[]; groups: UnderGroup[] }

/**
 * Under the passage. Each paragraph's cards sit in a column directly under the paragraph (`anchorTop` is where that
 * space starts, the text's own flow supplies it), one after another. Three or more cards on one paragraph become
 * a stack of one-line rows under "N items on this paragraph" unless opened. While the writer types every card
 * keeps the state it had, so nothing folds or opens mid-sentence; the text itself carries the cards down, a line at a time.
 */
export function layoutUnder(input: Pick<LayoutInput, 'cards' | 'openIds' | 'typing'> & { previous?: UnderLayout | null; options?: LayoutOptions }): UnderLayout {
  const o = { ...DEFAULT_LAYOUT, ...input.options }
  const openIds = input.openIds ?? new Set<string>()
  const settled = underPassageFolds(input.cards, openIds)
  const before = new Map((input.previous?.placements ?? []).map((p) => [p.id, p.fold]))
  const foldOf = (id: string): 'open' | 'stack' => {
    const fold = input.typing && input.previous ? before.get(id) ?? 'open' : settled.get(id) ?? 'open'
    return fold === 'row' ? 'open' : fold
  }
  const placements: UnderPlacement[] = []
  const groups: UnderGroup[] = []
  for (const group of paragraphsOf(input.cards)) {
    const stacked = group.some((card) => foldOf(card.id) === 'stack')
    let cursor = group[0].anchorTop + (stacked ? o.stackHeadHeight : 0)
    for (const card of group) {
      // A settled row (ticket 06) is one line: a row of the stack when its paragraph stacks.
      const fold: UnderPlacement['fold'] = card.row ? (stacked ? 'stack' : 'row') : foldOf(card.id)
      const height = fold === 'open' ? card.height : o.rowHeight
      placements.push({ id: card.id, paragraph: card.paragraph, top: cursor, height, fold })
      cursor += height + (fold === 'stack' ? 0 : o.gap)
    }
    groups.push({ paragraph: group[0].paragraph, fold: stacked ? 'stack' : 'full', top: group[0].anchorTop, bottom: cursor, count: group.length })
  }
  return { placements, groups }
}

export const TYPING_PAUSE_MS = 2000

export type TypingState = {
  /** Time of the writer's last edit, or null when none yet. */
  lastEditAt: number | null
  /** The paragraph that edit was in. */
  editParagraph: string | number | null
  /** The paragraph the caret is in now. */
  caretParagraph: string | number | null
}

/**
 * The writer counts as typing from an edit until 2 seconds pass or the caret leaves the paragraph it
 * edited. The crowding pass runs again as soon as this turns false.
 */
export function isWriterTyping(state: TypingState, now: number, pauseMs: number = TYPING_PAUSE_MS): boolean {
  if (state.lastEditAt === null) return false
  if (now - state.lastEditAt >= pauseMs) return false
  return state.caretParagraph === state.editParagraph
}
