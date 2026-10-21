import { expect, test } from 'bun:test'
import { isWriterTyping, layoutMargin, layoutUnder, underPassageFolds, type LayoutCard, type MarginLayout } from '../../src/renderer/src/app/margin-layout'

const card = (id: string, paragraph: number, anchorTop: number, height = 100, isThread = false): LayoutCard => ({ id, paragraph, anchorTop, height, isThread })

function worstDrift(layout: MarginLayout, cards: LayoutCard[]): number {
  const by = new Map(cards.map((c) => [c.id, c]))
  return Math.max(...layout.placements.map((p) => (p.hidden ? layout.groups.find((g) => g.paragraph === p.paragraph)!.top : p.top) - by.get(p.id)!.anchorTop))
}

test('cards with room sit level with their passage', () => {
  const cards = [card('a', 1, 0), card('b', 2, 300)]
  const layout = layoutMargin({ cards })
  expect(layout.placements.map((p) => [p.top, p.fold])).toEqual([[0, 'open'], [300, 'open']])
})

test('five items on one paragraph fold to a stack and stay within 120 px of the passage', () => {
  const cards = [1, 2, 3, 4, 5].map((n) => card(`c${n}`, 1, 40))
  const layout = layoutMargin({ cards })
  expect(layout.groups[0].fold).toBe('stack')
  expect(layout.placements.every((p) => p.fold === 'stack')).toBe(true)
  expect(worstDrift(layout, cards)).toBeLessThanOrEqual(120)
})

test('threads fold to one line before the paragraph stacks', () => {
  const cards = [card('a', 1, 0, 100, true), card('b', 1, 0, 100, true), card('c', 1, 0, 60)]
  const layout = layoutMargin({ cards })
  expect(layout.groups[0].fold).toBe('threads')
  expect(layout.placements.map((p) => p.fold)).toEqual(['thread-line', 'thread-line', 'open'])
  expect(worstDrift(layout, cards)).toBeLessThanOrEqual(120)
})

test('a single crowded card folds to one line, and a paragraph that crowds even as a stack folds to one line', () => {
  const lone = [card('x', 1, 0, 400), card('y', 2, 10, 400)]
  const layoutLone = layoutMargin({ cards: lone })
  expect(layoutLone.groups[0].fold).toBe('line')
  // Ticket 06 (frame `many`): a lone item folds to its own one-line row, drawn, not a "1 items" head.
  const lonePlaced = layoutLone.placements.find((p) => p.id === 'x')!
  expect(lonePlaced.hidden).toBe(false)
  expect(lonePlaced.fold).toBe('line')
  expect(lonePlaced.height).toBe(24)

  const heavy = [card('p', 1, 0, 100), card('q', 1, 0, 100), card('r', 1, 0, 100), card('s', 2, 10, 100)]
  const layoutHeavy = layoutMargin({ cards: heavy, options: { stackHeadHeight: 60, rowHeight: 60 } })
  expect(layoutHeavy.groups[0].fold).toBe('line')
})

test('a card the writer opened stays open even when it pushes the rest down', () => {
  const cards = [card('a', 1, 0, 300), card('b', 1, 0, 300)]
  const layout = layoutMargin({ cards, openIds: new Set(['b']) })
  expect(layout.placements.find((p) => p.id === 'b')!.fold).toBe('open')
  expect(layout.placements.find((p) => p.id === 'b')!.height).toBe(300)
})

test('while typing no card changes fold and cards move by whole lines only', () => {
  const cards = [1, 2, 3, 4, 5].map((n) => card(`c${n}`, 1, 40))
  const settled = layoutMargin({ cards })
  const moved = cards.map((c) => ({ ...c, anchorTop: c.anchorTop + 31 }))
  const typing = layoutMargin({ cards: moved, typing: true, previous: settled })
  expect(typing.placements.map((p) => p.fold)).toEqual(settled.placements.map((p) => p.fold))
  typing.placements.forEach((p, i) => {
    const delta = p.top - settled.placements[i].top
    expect(delta % 24).toBe(0)
    expect(delta).toBe(24)
  })
  // A pause ends typing: the crowding pass runs again against the new positions.
  const after = layoutMargin({ cards: moved, typing: false, previous: typing })
  expect(after.groups[0].fold).toBe('stack')
  expect(after.groups[0].top).toBe(71)
})

test('typing does not fold a newly crowded paragraph; the pass after the pause does', () => {
  const calm = [card('a', 1, 0, 130), card('b', 2, 150, 130)]
  const settled = layoutMargin({ cards: calm })
  const crowded = [card('a', 1, 0, 130), card('b', 2, 0, 130)]
  const typing = layoutMargin({ cards: crowded, typing: true, previous: settled })
  expect(typing.placements.every((p) => p.fold === 'open')).toBe(true)
  const after = layoutMargin({ cards: crowded })
  expect(after.placements.some((p) => p.fold !== 'open')).toBe(true)
})

test('the writer counts as typing for 2 seconds, or until the caret leaves the paragraph', () => {
  const state = { lastEditAt: 1000, editParagraph: 3, caretParagraph: 3 }
  expect(isWriterTyping(state, 2500)).toBe(true)
  expect(isWriterTyping(state, 3000)).toBe(false)
  expect(isWriterTyping({ ...state, caretParagraph: 4 }, 1500)).toBe(false)
  expect(isWriterTyping({ lastEditAt: null, editParagraph: null, caretParagraph: 3 }, 1500)).toBe(false)
})

test('under the passage, three or more cards on a paragraph stack unless opened', () => {
  const cards = [{ id: 'a', paragraph: 1 }, { id: 'b', paragraph: 1 }, { id: 'c', paragraph: 1 }, { id: 'd', paragraph: 2 }, { id: 'e', paragraph: 2 }]
  const folds = underPassageFolds(cards, new Set(['b']))
  expect([...folds.values()]).toEqual(['stack', 'open', 'stack', 'open', 'open'])
})

test('while typing, a floor that shrinks brings the card back up to its passage, and a floor that grows still pushes it down', () => {
  // The head is tall: the floor (364) sits under the passage (273), so the card is pushed down to the floor.
  const tall = layoutMargin({ cards: [{ id: 'p', paragraph: 1, anchorTop: 364, height: 150, passageTop: 273, floor: 364 }] })
  expect(tall.placements[0].top).toBe(364)
  // The head shrinks (floor 226) while the writer types: the card goes back to its passage at once, not at the pause.
  const shrunk = layoutMargin({ cards: [{ id: 'p', paragraph: 1, anchorTop: 273, height: 150, passageTop: 273, floor: 226 }], typing: true, previous: tall })
  expect(shrunk.placements[0].top).toBe(273)
  // The head grows again past the passage: the floor pushes the card down even while typing.
  const grown = layoutMargin({ cards: [{ id: 'p', paragraph: 1, anchorTop: 400, height: 150, passageTop: 273, floor: 400 }], typing: true, previous: shrunk })
  expect(grown.placements[0].top).toBe(400)
})

// Geometry recorded from the live editor (scroller coordinates, 18.5px prose at 1.75 line height = 32px lines), a seven-card
// review of the locked "many items on one paragraph" frame: one agent edit on the first paragraph, five items on the effort
// paragraph, a reader note on the last.
const RECORDED = [
  card('agent-1', 10, 150, 150),
  card('agent-2', 70, 640, 150), card('priya', 70, 640, 130), card('tomas', 70, 672, 120), card('jonas', 70, 672, 110), card('claude', 70, 704, 120),
  card('marta', 90, 800, 140),
]

test('recorded geometry: the first paragraph stays level, the five items stack, the next paragraph keeps its own place', () => {
  const layout = layoutMargin({ cards: RECORDED })
  const fold = (id: string) => layout.placements.find((p) => p.id === id)!.fold
  expect(fold('agent-1')).toBe('open')
  expect(layout.groups.find((g) => g.paragraph === 70)!.fold).toBe('stack')
  expect(layout.groups.find((g) => g.paragraph === 70)!.count).toBe(5)
  for (const id of ['agent-2', 'priya', 'tomas', 'jonas', 'claude']) expect(fold(id)).toBe('stack')
  // The stack's rows do not overlap each other or the next paragraph's card.
  const rows = layout.placements.filter((p) => p.paragraph === 70).sort((a, b) => a.top - b.top)
  rows.slice(1).forEach((p, i) => expect(p.top).toBeGreaterThanOrEqual(rows[i].top + rows[i].height))
  const marta = layout.placements.find((p) => p.id === 'marta')!
  expect(marta.top).toBeGreaterThanOrEqual(rows[rows.length - 1].top + rows[rows.length - 1].height)
  expect(marta.top - 800).toBeLessThanOrEqual(120)
})

test('recorded geometry: a card the writer opens in the stack stays open and the next card moves down', () => {
  const closed = layoutMargin({ cards: RECORDED })
  const opened = layoutMargin({ cards: RECORDED, openIds: new Set(['agent-2']) })
  expect(opened.placements.find((p) => p.id === 'agent-2')!.fold).toBe('open')
  expect(opened.placements.find((p) => p.id === 'priya')!.fold).toBe('stack')
  expect(opened.placements.find((p) => p.id === 'marta')!.top).toBeGreaterThan(closed.placements.find((p) => p.id === 'marta')!.top)
})

test('recorded geometry: typing in the stacked paragraph keeps every fold and moves cards by whole lines only', () => {
  const settled = layoutMargin({ cards: RECORDED })
  // The writer types a line more into the effort paragraph: every passage from there down moves 32 px; the head floor is unchanged.
  const moved = RECORDED.map((c) => (c.paragraph === 10 ? c : { ...c, anchorTop: c.anchorTop + 32, passageTop: c.anchorTop + 32 }))
  const typing = layoutMargin({ cards: moved, typing: true, previous: settled })
  expect(typing.placements.map((p) => p.fold)).toEqual(settled.placements.map((p) => p.fold))
  typing.placements.forEach((p, i) => {
    const delta = p.top - settled.placements[i].top
    expect(delta % 24).toBe(0)
    expect(delta).toBeLessThanOrEqual(48)
  })
  // No card opened, and no card inside a stack was hidden.
  expect(typing.placements.some((p) => p.hidden)).toBe(false)
})

test('recorded geometry: threads fold to one line while a lone card elsewhere stays open', () => {
  const cards = [card('t1', 5, 100, 140, true), card('t2', 5, 100, 140, true), card('plain', 8, 420, 90)]
  const layout = layoutMargin({ cards })
  expect(layout.placements.map((p) => p.fold)).toEqual(['thread-line', 'thread-line', 'open'])
})

const under = (id: string, paragraph: number, anchorTop: number, height = 140): LayoutCard => ({ id, paragraph, anchorTop, height })

test('under the passage: one or two cards sit open one after another, directly under the paragraph', () => {
  const layout = layoutUnder({ cards: [under('a', 1, 200), under('b', 1, 200, 100), under('c', 2, 500)] })
  expect(layout.placements.map((p) => [p.id, p.top, p.fold])).toEqual([['a', 200, 'open'], ['b', 348, 'open'], ['c', 500, 'open']])
  expect(layout.groups[0].bottom).toBe(456)
})

test('under the passage: three or more cards stack under one head; opened rows draw in full; no overlap', () => {
  const cards = [under('a', 1, 200), under('b', 1, 200), under('c', 1, 200), under('d', 2, 600)]
  const stacked = layoutUnder({ cards })
  expect(stacked.groups[0].fold).toBe('stack')
  expect(stacked.placements.slice(0, 3).map((p) => [p.top, p.height])).toEqual([[224, 24], [248, 24], [272, 24]])
  const opened = layoutUnder({ cards, openIds: new Set(['b']) })
  expect(opened.placements.find((p) => p.id === 'b')).toMatchObject({ fold: 'open', height: 140 })
  expect(opened.placements.find((p) => p.id === 'c')!.top).toBe(224 + 24 + 140 + 8)
  expect(opened.groups[0].bottom).toBeLessThanOrEqual(600)
})

test('under the passage: while typing nothing folds or opens, whatever the count becomes', () => {
  const calm = layoutUnder({ cards: [under('a', 1, 200), under('b', 1, 200)] })
  const grown = [under('a', 1, 232), under('b', 1, 232), under('c', 1, 232)]
  const typing = layoutUnder({ cards: grown, typing: true, previous: calm })
  expect(typing.placements.every((p) => p.fold === 'open')).toBe(true)
  // The text carries the cards down a line at a time: the space starts where the paragraph's last line ends.
  expect(typing.placements[0].top).toBe(232)
  const after = layoutUnder({ cards: grown, typing: false, previous: typing })
  expect(after.groups[0].fold).toBe('stack')
})

// ---- ticket 06: settled rows and crowding ----

test('a settled row is one line beside its words and counts as one of its paragraph\'s items', () => {
  const cards: LayoutCard[] = [card('a', 1, 0, 100), { ...card('done', 1, 0, 100), row: true }, card('b', 2, 400)]
  const layout = layoutMargin({ cards })
  const done = layout.placements.find((p) => p.id === 'done')!
  expect(done.fold).toBe('row')
  expect(done.height).toBe(24)
  expect(layout.groups[0].count).toBe(2)
})

test('a settled row is a row of its paragraph\'s stack and never opens, even when asked to', () => {
  const cards: LayoutCard[] = [...[1, 2, 3, 4].map((n) => card(`c${n}`, 1, 40)), { ...card('done', 1, 40), row: true }]
  const layout = layoutMargin({ cards, openIds: new Set(['done', 'c2']) })
  expect(layout.groups[0].fold).toBe('stack')
  expect(layout.placements.find((p) => p.id === 'done')!.fold).toBe('stack')
  expect(layout.placements.find((p) => p.id === 'done')!.height).toBe(24)
  // The opened row opens in place inside the stack; the others stay one line.
  expect(layout.placements.find((p) => p.id === 'c2')!.fold).toBe('open')
  expect(layout.placements.filter((p) => p.fold === 'stack')).toHaveLength(4)
})

test('a lone settled row that has to fold stays a row', () => {
  const cards: LayoutCard[] = [{ ...card('done', 1, 0, 400), row: true }, card('y', 2, 10, 400)]
  const layout = layoutMargin({ cards })
  expect(layout.placements.find((p) => p.id === 'done')!.fold).toBe('row')
})
