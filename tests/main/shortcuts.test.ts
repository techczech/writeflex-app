import { expect, test } from 'bun:test'
import { formatShortcutKey, isCheatSheetShortcut, isThreadsSwitcherShortcut, isWriterModeToggleShortcut, skillChordIntent } from '../../src/renderer/src/app/shortcuts'

test('writer mode toggle matches physical KeyM under macOS Option remapping', () => {
  expect(isWriterModeToggleShortcut({
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    key: 'µ',
    code: 'KeyM',
  })).toBe(true)
})

test('writer mode toggle ignores the produced key when the physical key is not M', () => {
  expect(isWriterModeToggleShortcut({
    metaKey: true,
    ctrlKey: false,
    altKey: true,
    shiftKey: false,
    key: 'm',
    code: 'KeyN',
  })).toBe(false)
})

test('cheat-sheet shortcut recognises Command-slash and Command-question-mark', () => {
  expect(isCheatSheetShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: '?', code: 'Slash' })).toBe(true)
  expect(isCheatSheetShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: '?', code: 'Slash' })).toBe(true)
  expect(isCheatSheetShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: '/', code: 'Slash' })).toBe(true)
  expect(isCheatSheetShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: true, key: '?', code: 'Slash' })).toBe(false)
  expect(isCheatSheetShortcut({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: true, key: '?', code: 'Slash' })).toBe(false)
})

test('shifted punctuation renders as the produced question mark', () => {
  expect(formatShortcutKey('Mod-Shift-/')).toBe('⌘?')
  expect(formatShortcutKey('Shift-Mod-k')).toBe('⇧⌘K')
  expect(formatShortcutKey('Mod-/')).toBe('⌘/')
})

test('skill chords map physical digits one to three and Shift selects open-thread', () => {
  expect(skillChordIntent({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: '¡', code: 'Digit1' })).toEqual({ index: 0, openThread: false })
  expect(skillChordIntent({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: true, key: '⁄', code: 'Digit2' })).toEqual({ index: 1, openThread: true })
  expect(skillChordIntent({ metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, key: '3', code: 'Digit3' })).toEqual({ index: 2, openThread: false })
  expect(skillChordIntent({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: '1', code: 'Digit1' })).toBeNull()
  expect(skillChordIntent({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: '4', code: 'Digit4' })).toBeNull()
})

test('threads switcher uses the collision-free Control-Command-T chord', () => {
  expect(isThreadsSwitcherShortcut({ metaKey: true, ctrlKey: true, altKey: false, shiftKey: false, key: 't', code: 'KeyT' })).toBe(true)
  expect(isThreadsSwitcherShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: 't', code: 'KeyT' })).toBe(false)
  expect(isThreadsSwitcherShortcut({ metaKey: true, ctrlKey: true, altKey: false, shiftKey: true, key: 'T', code: 'KeyT' })).toBe(false)
})
