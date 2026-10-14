import { expect, test } from 'bun:test'
import { fitPaneTabs, type RightPaneTab } from '../../src/renderer/src/app/pane-layout'

/**
 * The right pane's tab fit (ticket 07, option D), on the widths the browser measures for the locked
 * pane-tab geometry (12px icon, 4px padding, chord zero-width at rest): what stays in the row and what
 * goes under "…", at the pane's narrowest, default and widest widths.
 */

const TABS: { id: RightPaneTab; width: number }[] = [
  { id: 'agent', width: 62.125 },
  { id: 'scratchpad', width: 91.25 },
  { id: 'review', width: 68.83 },
  { id: 'agent-notes', width: 94.42 },
  { id: 'versions', width: 77.72 },
]
const ALL = TABS.map((tab) => tab.id)
const GAP = 2
const MORE = 22
/** The row's width for its tabs: the pane less its 1px border and the row's 7px side padding. */
const inside = (pane: number): number => pane - 1 - 14
const fit = (pane: number, active: RightPaneTab) =>
  fitPaneTabs({ tabs: TABS, available: inside(pane), gap: GAP, more: MORE, active })

test('at the widest pane all five tabs are in the row and there is no menu', () => {
  for (const active of ALL) expect(fit(560, active)).toEqual({ row: ALL, menu: [] })
})

test('at the default 340px pane the tabs that fit stay and the rest go under the menu', () => {
  expect(fit(340, 'agent')).toEqual({ row: ['agent', 'scratchpad', 'review'], menu: ['agent-notes', 'versions'] })
  expect(fit(340, 'review')).toEqual({ row: ['agent', 'scratchpad', 'review'], menu: ['agent-notes', 'versions'] })
  // The drawn case: Agent notes active takes Review's place, and Review joins Versions in the menu.
  expect(fit(340, 'agent-notes')).toEqual({ row: ['agent', 'scratchpad', 'agent-notes'], menu: ['review', 'versions'] })
  expect(fit(340, 'versions')).toEqual({ row: ['agent', 'scratchpad', 'versions'], menu: ['review', 'agent-notes'] })
})

test('the active tab is never in the menu, at any width from the narrowest to the widest', () => {
  for (let pane = 200; pane <= 560; pane += 1) {
    for (const active of ALL) {
      const { row, menu } = fit(pane, active)
      expect(row).toContain(active)
      expect(menu).not.toContain(active)
      // Every tab is in exactly one place, and both keep the tabs' order.
      expect([...row, ...menu].sort()).toEqual([...ALL].sort())
      expect(row).toEqual(ALL.filter((id) => row.includes(id)))
      expect(menu).toEqual(ALL.filter((id) => menu.includes(id)))
      // What is in the row fits beside the "…" whenever the menu exists.
      const used = row.reduce((sum, id, index) => sum + TABS.find((tab) => tab.id === id)!.width + (index ? GAP : 0), 0)
      expect(used + (menu.length ? GAP + MORE : 0)).toBeLessThanOrEqual(inside(pane) + 0.01)
    }
  }
})

test('a wider active tab displaces as many trailing tabs as it needs', () => {
  // At 200px Agent and Scratchpad fit; Agent notes is wider than Scratchpad and takes its place.
  expect(fit(200, 'agent')).toEqual({ row: ['agent', 'scratchpad'], menu: ['review', 'agent-notes', 'versions'] })
  expect(fit(200, 'agent-notes')).toEqual({ row: ['agent', 'agent-notes'], menu: ['scratchpad', 'review', 'versions'] })
  // Only one leading tab fits; a wide active tab replaces it.
  const tight = fitPaneTabs({ tabs: TABS, available: 100, gap: GAP, more: MORE, active: 'agent-notes' })
  expect(tight).toEqual({ row: ['agent-notes'], menu: ['agent', 'scratchpad', 'review', 'versions'] })
})

test('a row too narrow for anything still shows the active tab alone', () => {
  expect(fitPaneTabs({ tabs: TABS, available: 40, gap: GAP, more: MORE, active: 'review' })).toEqual({
    row: ['review'],
    menu: ['agent', 'scratchpad', 'agent-notes', 'versions'],
  })
})

test('the "…" is only paid for when something is hidden', () => {
  const total = TABS.reduce((sum, tab) => sum + tab.width, 0) + GAP * (TABS.length - 1)
  // Exactly enough for all five: no menu, although five plus the "…" would not fit.
  expect(fitPaneTabs({ tabs: TABS, available: total, gap: GAP, more: MORE, active: 'agent' }).menu).toEqual([])
  // A pixel short: the "…" appears, and the last tab, which no longer fits beside it, moves in.
  expect(fitPaneTabs({ tabs: TABS, available: total - 1, gap: GAP, more: MORE, active: 'agent' })).toEqual({
    row: ['agent', 'scratchpad', 'review', 'agent-notes'],
    menu: ['versions'],
  })
})

test('before the row is measured every tab is in it', () => {
  expect(fitPaneTabs({ tabs: TABS, available: 0, gap: GAP, more: MORE, active: 'versions' })).toEqual({ row: ALL, menu: [] })
})
