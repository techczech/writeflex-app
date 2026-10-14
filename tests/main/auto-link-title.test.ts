import { test, expect } from 'bun:test'
import { isBareUrl, pasteReplacement } from '../../src/renderer/src/editor/auto-link-title'

// Salvaged verbatim from feature/m1-its-your-editor (tests/auto-link-title.test.ts); only the
// import path moved for the rebuild's tests/main/ layout (import depth ../../src). S9 amendment:
// auto-link-title returns as one of the user's Obsidian essential five (controller-added, flagged).
test('isBareUrl accepts single http(s) URLs only', () => {
  expect(isBareUrl('https://example.com/a?b=1')).toBe(true)
  expect(isBareUrl('http://x.io')).toBe(true)
  expect(isBareUrl('ftp://x.io')).toBe(false)
  expect(isBareUrl('see https://x.io')).toBe(false)
  expect(isBareUrl('https://x.io second')).toBe(false)
})

test('pasteReplacement wraps a selection without fetching', () => {
  const r = pasteReplacement('my label', 'https://x.io')
  expect(r.insert).toBe('[my label](https://x.io)')
  expect(r.titleTo).toBeNull()
})

test('pasteReplacement with no selection marks the URL text for title replacement', () => {
  const r = pasteReplacement('', 'https://x.io')
  expect(r.insert).toBe('[https://x.io](https://x.io)')
  expect(r.insert.slice(r.titleFrom, r.titleTo!)).toBe('https://x.io')
})
