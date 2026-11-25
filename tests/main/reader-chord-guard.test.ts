import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { eventToChord, nativeEditRoleChord } from '../../src/renderer/src/app/shortcuts'

test('Reader forwarding cannot run native Edit chords on the hidden main editor', () => {
  const source = readFileSync('src/renderer/src/app/App.tsx', 'utf8')
  // Slice the callback by its own start and dependency list, not by a neighbouring comment.
  const start = source.indexOf('const runReaderChord = useCallback(')
  const endMarker = '}, [overlayOpenRef])'
  const end = source.indexOf(endMarker, start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  const callback = source.slice(start, end + endMarker.length)
  const js = ts.transpile(callback + '\nreturn runReaderChord', { target: ts.ScriptTarget.ES2022 })
  const runs: string[] = []
  const index = new Map(['⌘A', '⌘Z', '⇧⌘Z', '⌘X', '⌘C', '⌘V', '⌥⇧⌘V', '⌃⌘S'].map(key => [key, () => runs.push(key)]))
  const run = new Function('useCallback', 'overlayOpenRef', 'eventToChord', 'nativeEditRoleChord', 'appChordIndexRef', js)((fn: unknown) => fn, { current: false }, eventToChord, nativeEditRoleChord, { current: index })
  for (const [key, code, extra] of [['a', 'KeyA', {}], ['z', 'KeyZ', {}], ['z', 'KeyZ', { shiftKey: true }], ['x', 'KeyX', {}], ['c', 'KeyC', {}], ['v', 'KeyV', {}], ['v', 'KeyV', { altKey: true, shiftKey: true }]]) run({ key, code, metaKey: true, ...extra })
  expect(runs).toEqual([])
  run({ key: 's', code: 'KeyS', metaKey: true, ctrlKey: true })
  expect(runs).toEqual(['⌃⌘S'])
})
