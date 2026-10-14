import { expect, test } from 'bun:test'
import { planCommandForEvent, planEventChord } from '../../src/renderer/src/plan/plan-shortcuts'

const key = (value: string, code: string, extra = {}) => ({
  key: value,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...extra,
})

test('Plan shortcuts recognise the contextual bare keys that the app-wide chord parser excludes', () => {
  expect(planEventChord(key('n', 'KeyN'))).toBe('N')
  expect(planEventChord(key('a', 'KeyA'))).toBe('A')
  expect(planEventChord(key('Enter', 'Enter'))).toBe('↵')
  expect(planEventChord(key('N', 'KeyN', { shiftKey: true }))).toBeNull()
})

test('Plan shortcuts retain modified movement and removal chords', () => {
  expect(planEventChord(key('ArrowUp', 'ArrowUp', { altKey: true }))).toBe('⌥↑')
  expect(planEventChord(key('Backspace', 'Backspace', { metaKey: true }))).toBe('⌘⌫')
})

test('the real Plan shortcut matcher routes the adopt key and its override to adopt', () => {
  expect(planCommandForEvent(key('a', 'KeyA'), {})).toBe('adopt')
  expect(planCommandForEvent(key('a', 'KeyA'), { 'plan.adoptPart': 'Z' })).toBeNull()
  expect(planCommandForEvent(key('z', 'KeyZ'), { 'plan.adoptPart': 'Z' })).toBe('adopt')
})
