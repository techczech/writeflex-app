import { test, expect } from 'bun:test'
import { saveCursor, loadCursor } from '../../src/renderer/src/editor/cursor-memory'

function fakeStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) }
}

test('round-trips cursor per root+path', () => {
  const storage = fakeStorage()
  saveCursor(storage, '/w1', 'a.md', { head: 42, scrollTop: 100 })
  expect(loadCursor(storage, '/w1', 'a.md')).toEqual({ head: 42, scrollTop: 100 })
  expect(loadCursor(storage, '/w2', 'a.md')).toBeNull()
})

test('corrupt entries return null', () => {
  const storage = fakeStorage()
  storage.setItem('writeflex:cursor:/w:x.md', '{nope')
  expect(loadCursor(storage, '/w', 'x.md')).toBeNull()
})

test('loadCursor rejects malformed shapes', () => {
  const storage = fakeStorage()
  storage.setItem('writeflex:cursor:/w:x.md', JSON.stringify({ head: 'nope', scrollTop: 2 }))
  expect(loadCursor(storage, '/w', 'x.md')).toBeNull()
  storage.setItem('writeflex:cursor:/w:y.md', JSON.stringify({ head: 5 }))
  expect(loadCursor(storage, '/w', 'y.md')).toBeNull()
})

function throwingStorage() {
  return {
    getItem: (): string | null => { throw new Error('quota / security error') },
    setItem: (): void => { throw new Error('quota / security error') }
  }
}

test('saveCursor with a throwing storage does not throw', () => {
  expect(() => saveCursor(throwingStorage(), '/w', 'a.md', { head: 1, scrollTop: 2 })).not.toThrow()
})

test('loadCursor with a throwing storage returns null', () => {
  expect(loadCursor(throwingStorage(), '/w', 'a.md')).toBeNull()
})
