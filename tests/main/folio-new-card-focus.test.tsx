import { expect, test } from 'bun:test'
import { chromium } from 'playwright'

// Real React DOM and Chromium focus, using the browser unit-test route already used
// by assistant-turns.test.tsx. The virtual entry keeps the synthetic fixture here.
const harness = `
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { NewCard } from '../../src/renderer/src/components/FolioRoomOrder'
const other = document.createElement('button')
other.textContent = 'Previously focused control'
const host = document.createElement('div')
document.body.append(other, host)
other.focus()
const root = createRoot(host)
const frames = new Map()
let nextFrame = 0
let closes = 0
window.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame }
window.cancelAnimationFrame = id => { frames.delete(id) }
const props = { parts: [], busy: false, onOpen() {}, onClose() { closes++ }, onAdd: async () => true }
const snapshot = () => ({
  focused: document.activeElement === host.querySelector('input'),
  otherFocused: document.activeElement === other,
  hasInput: !!host.querySelector('input'),
  pending: frames.size,
  closes,
})
window.newCardFocus = {
  render(open, row = false) {
    flushSync(() => root.render(createElement(NewCard, { ...props, open, row })))
    return snapshot()
  },
  escape() {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let bubbled = 0
    const onBubble = () => { bubbled++ }
    document.addEventListener('keydown', onBubble)
    document.activeElement.dispatchEvent(event)
    document.removeEventListener('keydown', onBubble)
    return { ...snapshot(), prevented: event.defaultPrevented, bubbled }
  },
  dispose(unmount) {
    flushSync(() => { if (unmount) root.unmount(); else root.render(createElement(NewCard, { ...props, open: false })) })
    other.focus()
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
    return { ...snapshot(), callbacksAfterClose: pending.length }
  },
}
`

type Snapshot = { focused: boolean; otherFocused: boolean; hasInput: boolean; pending: number; closes: number }
declare global {
  interface Window {
    newCardFocus: {
      render: (open: boolean, row?: boolean) => Snapshot
      escape: () => Snapshot & { prevented: boolean; bubbled: number }
      dispose: (unmount: boolean) => Snapshot & { callbacksAfterClose: number }
    }
  }
}

test('New card focus is ready at opening commit in cards and Outline, with no stale frame after close or unmount', async () => {
  const result = await Bun.build({
    entrypoints: [import.meta.path], target: 'browser', format: 'iife',
    plugins: [{
      name: 'folio-new-card-focus-fixture',
      setup(build) {
        build.onLoad({ filter: /folio-new-card-focus\.test\.tsx$/ }, () => ({ contents: harness, loader: 'tsx' }))
      },
    }],
  })
  expect(result.success).toBe(true)
  const bundle = await result.outputs[0].text()
  const browser = await chromium.launch({ headless: true })
  try {
    for (const row of [false, true]) for (const initiallyOpen of [true, false]) {
      const page = await browser.newPage()
      try {
        await page.setContent('<!doctype html><html><body></body></html>')
        await page.addScriptTag({ content: bundle })
        const receipt = await page.evaluate(({ row, initiallyOpen }) => {
          const otherInitiallyFocused = document.activeElement?.textContent === 'Previously focused control'
          const closed = initiallyOpen ? null : window.newCardFocus.render(false, row)
          const atCommit = window.newCardFocus.render(true, row)
          // No input.focus(), focus polling or released animation frame precedes Escape.
          return { row, initiallyOpen, otherInitiallyFocused, closed, atCommit, escape: window.newCardFocus.escape() }
        }, { row, initiallyOpen })
        expect(receipt.otherInitiallyFocused).toBe(true)
        if (!initiallyOpen) expect(receipt.closed).toEqual({ focused: false, otherFocused: true, hasInput: false, pending: 0, closes: 0 })
        expect(receipt.atCommit).toEqual({ focused: true, otherFocused: false, hasInput: true, pending: 0, closes: 0 })
        expect(receipt.escape).toEqual({ focused: true, otherFocused: false, hasInput: true, pending: 0, closes: 1, prevented: true, bubbled: 0 })
      } finally { await page.close() }
    }
    for (const unmount of [false, true]) {
      const page = await browser.newPage()
      try {
        await page.setContent('<!doctype html><html><body></body></html>')
        await page.addScriptTag({ content: bundle })
        const receipt = await page.evaluate(unmount => {
          window.newCardFocus.render(true)
          return window.newCardFocus.dispose(unmount)
        }, unmount)
        expect(receipt).toEqual({ focused: false, otherFocused: true, hasInput: false, pending: 0, closes: 0, callbacksAfterClose: 0 })
      } finally { await page.close() }
    }
  } finally { await browser.close() }
// This new test owns six fresh page fixtures, bundling and complete browser teardown.
}, 20_000)
