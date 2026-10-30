import { expect, test } from 'bun:test'
import { chromium } from 'playwright'

// Exercise the real hook, React state, pointer listeners and browser storage together.
// The in-memory entry needs no app, fixture files or additional dependencies.
const harness = `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { usePaneLayout, rightPaneTabsFor } from '../../src/renderer/src/app/pane-layout'
const host = document.createElement('div')
document.body.append(host)
let root
let pane
let deps
function Harness() {
  pane = usePaneLayout(deps)
  return createElement('div', { style: { width: pane.rightPaneWidth } })
}
const render = () => flushSync(() => root.render(createElement(Harness)))
const snapshot = () => ({
  tab: pane.rightTab, width: pane.rightPaneWidth, collapsed: pane.rightPaneCollapsed,
  ordinaryStored: localStorage.getItem('wf:rightPaneWidth'),
  scratchpadStored: localStorage.getItem('wf:scratchpadPaneWidth'),
})
window.paneWidthHarness = {
  reset(saved = {}) {
    if (root) flushSync(() => root.unmount())
    localStorage.clear()
    for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value)
    deps = { viewportWidth: 1200, scratchpadDocked: false, guideShown: false, onLeftTabOpened() {}, onRightTabOpened() {} }
    root = createRoot(host)
    render()
    return snapshot()
  },
  mode(docked, viewportWidth = 1200) { deps = { ...deps, scratchpadDocked: docked, viewportWidth }; render(); return snapshot() },
  open(tab) { flushSync(() => pane.openRightTab(tab)); return snapshot() },
  collapse() { flushSync(() => pane.collapseRightPane()); return snapshot() },
  cycle(direction) { flushSync(() => pane.cycleRightTab(direction, rightPaneTabsFor(deps.guideShown))); return snapshot() },
  begin() { pane.startPaneResize('right')({ clientX: 600, preventDefault() {} }) },
  move(x) { flushSync(() => window.dispatchEvent(new PointerEvent('pointermove', { clientX: x }))); return snapshot() },
  end() { window.dispatchEvent(new PointerEvent('pointerup')); return snapshot() },
}
`

type WidthSnapshot = {
  tab: string; width: number; collapsed: boolean
  ordinaryStored: string | null; scratchpadStored: string | null
}
type WidthHarness = {
  reset: (saved?: Record<string, string>) => WidthSnapshot
  mode: (docked: boolean, viewportWidth?: number) => WidthSnapshot
  open: (tab: string) => WidthSnapshot
  collapse: () => WidthSnapshot
  cycle: (direction: 1 | -1) => WidthSnapshot
  begin: () => void
  move: (x: number) => WidthSnapshot
  end: () => WidthSnapshot
}

test('docked Scratchpad width has an independent preference, viewport cap and captured resize destination', async () => {
  const result = await Bun.build({
    entrypoints: [import.meta.path], target: 'browser', format: 'iife',
    plugins: [{ name: 'pane-width-hook-fixture', setup(build) {
      build.onLoad({ filter: /pane-layout-width\.test\.ts$/ }, () => ({ contents: harness, loader: 'tsx' }))
    } }],
  })
  expect(result.success).toBe(true)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    try {
      // An origin is required for localStorage; serve only this synthetic empty document.
      await page.route('http://pane-width.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }))
      await page.goto('http://pane-width.test/')
      await page.addScriptTag({ content: await result.outputs[0].text() })
      const receipts = await page.evaluate(() => {
        // Fixture methods are browser-bundled; no input, app or content service is mocked.
        const h = (window as unknown as { paneWidthHarness: WidthHarness }).paneWidthHarness
        const initial = h.reset()
        const floating = h.open('scratchpad')
        const docked = h.mode(true)
        h.begin(); const resizing = h.move(660); const resized = h.end()
        const collapsedMode = h.mode(false)
        const redocked = h.mode(true)
        const agent = h.open('agent')
        h.begin(); h.move(560); const agentResized = h.end()
        h.open('scratchpad'); const capped = h.mode(true, 700)
        h.begin(); const capNoDrag = h.end()
        const expanded = h.mode(true)
        h.collapse(); const cycled = h.cycle(1); const cycledBack = h.cycle(-1)
        h.begin(); const switchedDuringDrag = h.open('agent'); const movedAfterSwitch = h.move(620); const finishedAfterSwitch = h.end()
        const scratchpadAfterSwitch = h.open('scratchpad')
        h.begin(); h.move(2000); const minimum = h.end()
        h.begin(); h.move(-2000); const maximum = h.end()
        const tinyCap = h.mode(true, 200)
        const restored = h.mode(true)
        const reloadedAgent = h.reset({ 'wf:rightPaneWidth': '410', 'wf:scratchpadPaneWidth': '465' })
        h.mode(true); const reloadedScratchpad = h.open('scratchpad')
        const reloadedFloating = h.mode(false)
        h.reset({ 'wf:rightPaneWidth': '360', 'wf:scratchpadPaneWidth': '561' }); h.mode(true)
        const invalidSavedScratchpad = h.open('scratchpad')
        return { initial, floating, docked, resizing, resized, collapsedMode, redocked, agent, agentResized, capped, capNoDrag, expanded, cycled, cycledBack, switchedDuringDrag, movedAfterSwitch, finishedAfterSwitch, scratchpadAfterSwitch, minimum, maximum, tinyCap, restored, reloadedAgent, reloadedScratchpad, reloadedFloating, invalidSavedScratchpad }
      })
      expect(receipts.initial).toMatchObject({ tab: 'agent', width: 340 })
      expect(receipts.floating).toMatchObject({ tab: 'scratchpad', width: 340 })
      expect(receipts.docked).toMatchObject({ width: 560 })
      expect(receipts.resizing).toMatchObject({ width: 500, scratchpadStored: null, ordinaryStored: null })
      expect(receipts.resized).toMatchObject({ width: 500, scratchpadStored: '500', ordinaryStored: null })
      expect(receipts.collapsedMode.width).toBe(340)
      expect(receipts.redocked.width).toBe(500)
      expect(receipts.agent.width).toBe(340)
      expect(receipts.agentResized).toMatchObject({ width: 380, ordinaryStored: '380', scratchpadStored: '500' })
      expect(receipts.capped).toMatchObject({ width: 420, scratchpadStored: '500' })
      expect(receipts.capNoDrag).toMatchObject({ width: 420, scratchpadStored: '500' })
      expect(receipts.expanded.width).toBe(500)
      expect(receipts.cycled).toMatchObject({ tab: 'agent-notes', width: 380, collapsed: false })
      expect(receipts.cycledBack).toMatchObject({ tab: 'scratchpad', width: 500 })
      expect(receipts.switchedDuringDrag.width).toBe(380)
      expect(receipts.movedAfterSwitch.width).toBe(380)
      expect(receipts.finishedAfterSwitch).toMatchObject({ ordinaryStored: '380', scratchpadStored: '480' })
      expect(receipts.scratchpadAfterSwitch.width).toBe(480)
      expect(receipts.minimum).toMatchObject({ width: 200, scratchpadStored: '200' })
      expect(receipts.maximum).toMatchObject({ width: 560, scratchpadStored: '560' })
      expect(receipts.tinyCap).toMatchObject({ width: 120, scratchpadStored: '560' })
      expect(receipts.restored.width).toBe(560)
      expect(receipts.reloadedAgent.width).toBe(410)
      expect(receipts.reloadedScratchpad.width).toBe(465)
      expect(receipts.reloadedFloating.width).toBe(410)
      expect(receipts.invalidSavedScratchpad.width).toBe(560)
    } finally { await page.close() }
  } finally { await browser.close() }
}, 20_000)
