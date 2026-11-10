import { expect, test } from 'bun:test'
import { fitSidebars, initialSidebars, paneDragBounds, planSidebars, readRightSidebarChoice, readSidebarTurn, takeTurns, writeRightSidebarChoice, writeSidebarTurn } from '../../src/renderer/src/app/pane-layout'

const base = { narrow: true, leftCollapsed: false, rightCollapsed: false, seenLeftCollapsed: false, seenRightCollapsed: false, autoLeft: false, autoRight: false }

test('narrowing with both open lends the right sidebar; widening gives it back', () => {
  const narrowed = takeTurns(base)
  expect(narrowed).toMatchObject({ closeRight: true, autoRight: true, closeLeft: false })
  const widened = takeTurns({ ...base, narrow: false, rightCollapsed: true, seenRightCollapsed: true, autoRight: true })
  expect(widened).toMatchObject({ openRight: true, autoRight: false })
})

test('opening one sidebar closes the other and lends it; opening a lent one by hand clears the loan', () => {
  expect(takeTurns({ ...base, leftCollapsed: false, rightCollapsed: false, seenRightCollapsed: true })).toMatchObject({ closeLeft: true, autoLeft: true })
  expect(takeTurns({ ...base, seenLeftCollapsed: true })).toMatchObject({ closeRight: true, autoRight: true })
  const byHand = takeTurns({ ...base, rightCollapsed: false, seenRightCollapsed: true, autoRight: true, leftCollapsed: true, seenLeftCollapsed: true })
  expect(byHand.autoRight).toBe(false)
  expect(byHand.closeLeft).toBe(false)
})

test('a sidebar the person closed is not reopened on widening', () => {
  expect(takeTurns({ ...base, narrow: false, rightCollapsed: true, seenRightCollapsed: true })).toMatchObject({ openRight: false })
})

test('the fit planner keeps going until the editor has 55%: a 560 px right sidebar at 1260 px closes, not just a narrower left (Sol S5)', () => {
  const both = { viewportWidth: 1260, leftWidth: 268, rightWidth: 560, leftOpen: true, rightOpen: true, lastOpened: null }
  const fit = fitSidebars(both)
  expect(fit.closeRight).toBe(true)
  expect(fit.closeLeft).toBe(false)
  expect((1260 - fit.leftWidth) / 1260).toBeGreaterThanOrEqual(0.55)
  // The person has just opened the right one: the left closes instead.
  expect(fitSidebars({ ...both, lastOpened: 'right' })).toMatchObject({ closeLeft: true, closeRight: false })
  // Where narrowing the left is enough, nothing closes; it gives up only what the editor needs (567 - 340 = 227 px).
  expect(fitSidebars({ ...both, rightWidth: 340 })).toEqual({ leftWidth: 227, closeLeft: false, closeRight: false })
})

test('the take-turns choice is kept for the next start; the other sidebar starts lent (Sol S4)', () => {
  expect(initialSidebars(true, 'right')).toEqual({ leftCollapsed: true, rightCollapsed: false, autoLeft: true, autoRight: false })
  expect(initialSidebars(true, null)).toEqual({ leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: true })
  expect(initialSidebars(false, 'right')).toEqual({ leftCollapsed: false, rightCollapsed: false, autoLeft: false, autoRight: false })
  // Started with the right open: the first take-turns pass changes nothing, and widening gives the left back.
  const start = initialSidebars(true, 'right')
  const first = takeTurns({ narrow: true, leftCollapsed: start.leftCollapsed, rightCollapsed: start.rightCollapsed, seenLeftCollapsed: start.leftCollapsed, seenRightCollapsed: start.rightCollapsed, autoLeft: start.autoLeft, autoRight: start.autoRight })
  expect(first).toMatchObject({ closeLeft: false, closeRight: false, openLeft: false, openRight: false, autoLeft: true })
  expect(takeTurns({ narrow: false, leftCollapsed: true, rightCollapsed: false, seenLeftCollapsed: true, seenRightCollapsed: false, autoLeft: true, autoRight: false })).toMatchObject({ openLeft: true })
})

test('the right sidebar is closed at the first open and then follows the person\'s remembered choice (R6)', () => {
  // Never chosen: closed in a wide window, closed (and not a loan) in a narrow one.
  expect(initialSidebars(false, null, null)).toEqual({ leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: false })
  expect(initialSidebars(true, null, null)).toEqual({ leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: false })
  // Chosen open: open in a wide window; in a narrow one the left shows and the right is lent back on widening.
  expect(initialSidebars(false, null, 'open')).toEqual({ leftCollapsed: false, rightCollapsed: false, autoLeft: false, autoRight: false })
  expect(initialSidebars(true, null, 'open')).toEqual({ leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: true })
  expect(initialSidebars(true, 'right', 'open')).toEqual({ leftCollapsed: true, rightCollapsed: false, autoLeft: true, autoRight: false })
  // An explicit close beats the older take-turns preference (Sol S1).
  expect(initialSidebars(true, 'right', 'closed')).toEqual({ leftCollapsed: false, rightCollapsed: true, autoLeft: false, autoRight: false })
  expect(initialSidebars(true, 'right', null)).toMatchObject({ leftCollapsed: false, rightCollapsed: true })
  // Chosen closed stays closed.
  expect(initialSidebars(false, null, 'closed')).toMatchObject({ rightCollapsed: true })
})

test('the right sidebar choice is stored only when the person changes it, and read back after a restart', () => {
  const store = new Map<string, string>()
  const saved = globalThis.localStorage
  globalThis.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } } as Storage
  try {
    expect(readRightSidebarChoice()).toBeNull()
    writeRightSidebarChoice('open')
    expect(readRightSidebarChoice()).toBe('open')
    writeRightSidebarChoice('closed')
    expect(readRightSidebarChoice()).toBe('closed')
    store.set('wf:rightSidebar', 'anything else')
    expect(readRightSidebarChoice()).toBeNull()
  } finally {
    globalThis.localStorage = saved
  }
})

test('the choice survives a restart through storage', () => {
  const store = new Map<string, string>()
  const saved = globalThis.localStorage
  globalThis.localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value) } } as Storage
  try {
    expect(readSidebarTurn()).toBeNull()
    writeSidebarTurn('right')
    expect(readSidebarTurn()).toBe('right')
  } finally {
    globalThis.localStorage = saved
  }
})

test('a sidebar the fit planner closes is lent: at 1800 px both open with the right at 560, down to 1260 px closes the right, back to 1800 px reopens it (Sol round 2, S5)', () => {
  type State = { leftCollapsed: boolean; rightCollapsed: boolean; seenLeftCollapsed: boolean; seenRightCollapsed: boolean; autoLeft: boolean; autoRight: boolean }
  const pass = (state: State, viewportWidth: number): { plan: ReturnType<typeof planSidebars>; next: State } => {
    const plan = planSidebars({ viewportWidth, leftWidth: 268, rightWidth: 560, ...state })
    const next = {
      leftCollapsed: plan.closeLeft ? true : plan.openLeft ? !state.leftCollapsed : state.leftCollapsed,
      rightCollapsed: plan.closeRight ? true : plan.openRight ? !state.rightCollapsed : state.rightCollapsed,
      seenLeftCollapsed: plan.seenLeftCollapsed, seenRightCollapsed: plan.seenRightCollapsed, autoLeft: plan.autoLeft, autoRight: plan.autoRight,
    }
    return { plan, next }
  }
  let state: State = { leftCollapsed: false, rightCollapsed: false, seenLeftCollapsed: false, seenRightCollapsed: false, autoLeft: false, autoRight: false }
  const wide = pass(state, 1800)
  expect(wide.plan).toMatchObject({ closeLeft: false, closeRight: false })
  state = wide.next
  const shrunk = pass(state, 1260)
  expect(shrunk.plan).toMatchObject({ closeRight: true, autoRight: true, closeLeft: false })
  state = shrunk.next
  // A second pass at the same width changes nothing (the loan is kept; both would not fit).
  const settled = pass(state, 1260)
  expect(settled.plan).toMatchObject({ openRight: false, closeLeft: false, autoRight: true })
  state = settled.next
  const widened = pass(state, 1800)
  expect(widened.plan).toMatchObject({ openRight: true, autoRight: false })
  expect(widened.next.rightCollapsed).toBe(false)
  // The left closed by the planner (the person had just opened the right) is lent the same way.
  const openedRight = planSidebars({ viewportWidth: 1260, leftWidth: 268, rightWidth: 560, leftCollapsed: false, rightCollapsed: false, seenLeftCollapsed: false, seenRightCollapsed: true, autoLeft: false, autoRight: false })
  expect(openedRight).toMatchObject({ closeLeft: true, autoLeft: true, closeRight: false })
  expect(planSidebars({ viewportWidth: 1800, leftWidth: 268, rightWidth: 560, leftCollapsed: true, rightCollapsed: false, seenLeftCollapsed: true, seenRightCollapsed: false, autoLeft: true, autoRight: false })).toMatchObject({ openLeft: true })
  // One the person closed is not reopened.
  expect(planSidebars({ viewportWidth: 1800, leftWidth: 268, rightWidth: 560, leftCollapsed: false, rightCollapsed: true, seenLeftCollapsed: false, seenRightCollapsed: true, autoLeft: false, autoRight: false })).toMatchObject({ openRight: false })
})

test('the left gives up only what the editor needs: at 1440 px with the right at 340 it shows 308 px, not 220', () => {
  expect(fitSidebars({ viewportWidth: 1440, leftWidth: 420, rightWidth: 340, leftOpen: true, rightOpen: true, lastOpened: null })).toEqual({ leftWidth: 308, closeLeft: false, closeRight: false })
  expect(fitSidebars({ viewportWidth: 1440, leftWidth: 280, rightWidth: 340, leftOpen: true, rightOpen: true, lastOpened: null })).toEqual({ leftWidth: 280, closeLeft: false, closeRight: false })
})

test('a drag stops where the editor would drop below 55%, so nothing snaps back or closes (Dominik, 6 Nov)', () => {
  // Left beside a 340 px right at 1440 px: up to 308 px.
  expect(paneDragBounds({ viewportWidth: 1440, otherShownWidth: 340 })).toEqual({ min: 200, max: 308 })
  // Right beside the left at its narrowest (220 px): up to 428 px; the fit planner then narrows the left.
  const right = paneDragBounds({ viewportWidth: 1440, otherShownWidth: 220 }).max
  expect(right).toBe(428)
  const plan = planSidebars({ viewportWidth: 1440, leftWidth: 300, rightWidth: right, leftCollapsed: false, rightCollapsed: false, seenLeftCollapsed: false, seenRightCollapsed: false, autoLeft: false, autoRight: false })
  expect(plan).toMatchObject({ closeLeft: false, closeRight: false })
  expect(fitSidebars({ viewportWidth: 1440, leftWidth: 300, rightWidth: right, leftOpen: true, rightOpen: true, lastOpened: null }).leftWidth).toBe(220)
  // Never wider than 560 px, never narrower than 200 px.
  expect(paneDragBounds({ viewportWidth: 2560, otherShownWidth: 0 }).max).toBe(560)
  expect(paneDragBounds({ viewportWidth: 600, otherShownWidth: 300 }).max).toBe(200)
})
