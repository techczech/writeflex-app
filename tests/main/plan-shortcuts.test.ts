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

test('Folio outline shortcuts recognise the contextual bare keys that the app-wide chord parser excludes', () => {
  expect(planEventChord(key('n', 'KeyN'))).toBe('N')
  expect(planEventChord(key('a', 'KeyA'))).toBe('A')
  expect(planEventChord(key('Enter', 'Enter'))).toBe('↵')
  // Shift with a letter is the Folio outline's ⇧-key (⇧H, ⇧T), never a letter typed in a field: the outline's handler yields to those.
  expect(planEventChord(key('N', 'KeyN', { shiftKey: true }))).toBe('⇧N')
  expect(planCommandForEvent(key('N', 'KeyN', { shiftKey: true }), {})).toBeNull()
})

test('Folio outline keys: R is the role menu, H and T and ⇧H and ⇧T are the title buttons, each beside its ⌃⌥⌘ chord', () => {
  expect(planCommandForEvent(key('r', 'KeyR'), {})).toBe('role')
  expect(planCommandForEvent(key('h', 'KeyH'), {})).toBe('title-heading-to-title')
  expect(planCommandForEvent(key('t', 'KeyT'), {})).toBe('title-title-to-heading')
  expect(planCommandForEvent(key('H', 'KeyH', { shiftKey: true }), {})).toBe('titles-heading-to-title')
  expect(planCommandForEvent(key('T', 'KeyT', { shiftKey: true }), {})).toBe('titles-title-to-heading')
  expect(planCommandForEvent(key('h', 'KeyH', { metaKey: true, ctrlKey: true, altKey: true }), {})).toBe('title-heading-to-title')
  // A writer's own chord replaces both of the command's chords.
  expect(planCommandForEvent(key('h', 'KeyH'), { 'title.useHeadingAsTitle': '⌃⌥⌘J' })).toBeNull()
  expect(planCommandForEvent(key('d', 'KeyD'), {})).toBe('details')
})

test('Folio outline shortcuts retain modified movement and removal chords', () => {
  expect(planEventChord(key('ArrowUp', 'ArrowUp', { altKey: true }))).toBe('⌥↑')
  expect(planEventChord(key('Backspace', 'Backspace', { metaKey: true }))).toBe('⌘⌫')
})

test('the real Folio outline shortcut matcher routes the adopt key and its override to adopt', () => {
  expect(planCommandForEvent(key('a', 'KeyA'), {})).toBe('adopt')
  expect(planCommandForEvent(key('a', 'KeyA'), { 'plan.adoptPart': 'Z' })).toBeNull()
  expect(planCommandForEvent(key('z', 'KeyZ'), { 'plan.adoptPart': 'Z' })).toBe('adopt')
})
