import { afterEach, expect, test } from 'bun:test'
import { abandonEarlyChords, EARLY_CHORD_LIMIT, holdEarlyChords, releaseEarlyChords, resetEarlyChordsForTest, stopHoldingEarlyChords, type EarlyChord } from '../../src/renderer/src/app/early-chords'

// A stand-in window: the listeners the holder adds, and a way to send it a key or a blur.
function fakeWindow() {
  const listeners = new Map<string, Set<(event: object) => void>>()
  const target = {
    addEventListener(type: string, fn: (event: object) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn) },
    removeEventListener(type: string, fn: (event: object) => void) { listeners.get(type)?.delete(fn) },
  }
  return {
    target: target as unknown as EventTarget,
    count: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
    send(type: string, event: object = {}) { for (const fn of listeners.get(type) ?? []) fn(event) },
  }
}
const key = (code: string, extra: Record<string, unknown> = {}) => ({ key: code.replace(/^Key/, '').toLowerCase(), code, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, ...extra })
const released = (): EarlyChord[] => { const out: EarlyChord[] = []; releaseEarlyChords((c) => out.push(c)); return out }
afterEach(() => resetEarlyChordsForTest())

test('a ⌘ chord pressed before the app listens is delivered once, in order, and the holder then detaches', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  win.send('keydown', key('KeyK', { shiftKey: true }))
  win.send('keydown', key('KeyP', { shiftKey: true }))
  expect(released().map((c) => c.code)).toEqual(['KeyK', 'KeyP'])
  expect(win.count()).toBe(0)
  expect(released()).toEqual([])
})

test('a key typed while an input method composes is never held, even when its physical code reads as ⌘W', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  win.send('keydown', key('KeyW', { key: 'Process', isComposing: true }))
  win.send('keydown', key('KeyW', { keyCode: 229 }))
  win.send('keydown', key('KeyP', { shiftKey: true, isComposing: true }))
  expect(released()).toEqual([])
})

test('dead keys, auto-repeats, bare modifiers, unmodified typing and keys aimed at a text field are not held', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  const field = { closest: (selector: string) => (selector.includes('textarea') ? {} : null) }
  win.send('keydown', key('KeyE', { key: 'Dead', altKey: true }))
  win.send('keydown', key('KeyK', { shiftKey: true, repeat: true }))
  win.send('keydown', key('MetaLeft', { key: 'Meta' }))
  win.send('keydown', key('KeyA', { metaKey: false }))
  win.send('keydown', key('KeyK', { shiftKey: true, target: field }))
  expect(released()).toEqual([])
})

test('Escape or the window losing focus forgets the held chords, also after the app listens', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  win.send('keydown', key('KeyP', { shiftKey: true }))
  win.send('blur')
  win.send('keydown', key('KeyK', { shiftKey: true }))
  stopHoldingEarlyChords()
  win.send('keydown', { key: 'Escape', code: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false })
  expect(released()).toEqual([])
})

test('once the app listens, later chords are its own and are not held as well', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  win.send('keydown', key('KeyP', { shiftKey: true }))
  stopHoldingEarlyChords()
  win.send('keydown', key('KeyK', { shiftKey: true }))
  expect(released().map((c) => c.code)).toEqual(['KeyP'])
})

test('the held set is bounded', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  for (let i = 0; i < 12; i += 1) win.send('keydown', key('KeyK', { shiftKey: true }))
  expect(released()).toHaveLength(EARLY_CHORD_LIMIT)
})

test('the recovery screen abandons the holder: it listens no more, holds nothing and delivers nothing later', () => {
  const win = fakeWindow()
  holdEarlyChords(win.target)
  for (let i = 0; i < 12; i += 1) win.send('keydown', key('F2', { key: 'F2' }))
  win.send('keydown', key('KeyP', { shiftKey: true }))
  abandonEarlyChords()
  expect(win.count()).toBe(0)
  win.send('keydown', key('KeyK', { shiftKey: true }))
  expect(released()).toEqual([])
  holdEarlyChords(win.target)
  expect(win.count()).toBe(0)
})
