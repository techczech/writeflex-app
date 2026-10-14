import { expect, test } from 'bun:test'
import { materialiseSeed, wikilinkRanges } from '../../src/renderer/src/editor/wikilinks'

test('classifies live and dead wikilinks while preserving display text', () => {
  expect(wikilinkRanges('See [[Target]] and [[Missing|the idea]].', [
    { target: 'Target', display: 'Target', to: 'target.md' },
    { target: 'Missing', display: 'the idea', to: null },
  ])).toEqual([
    { from: 4, to: 14, target: 'Target', display: 'Target', path: 'target.md', dead: false, ambiguous: undefined },
    { from: 19, to: 39, target: 'Missing', display: 'the idea', path: null, dead: true, ambiguous: undefined },
  ])
})

test('parse failures stay visible as a designed invalid idea-link state', () => {
  expect(wikilinkRanges('[[|]] [[ ]] [[Open', [])).toEqual([
    { from: 0, to: 5, target: '', display: 'Untitled idea', path: null, dead: true, invalid: true, ambiguous: undefined },
    { from: 6, to: 11, target: '', display: 'Untitled idea', path: null, dead: true, invalid: true, ambiguous: undefined },
  ])
})

test('materialisation strips markdown extensions and never uses a bare filename as the gist', () => {
  const [link] = wikilinkRanges('[[walk-sample.md]]', [])
  expect(materialiseSeed('[[walk-sample.md]]', link)).toEqual({ title: 'walk-sample', gist: '' })

  const [contextual] = wikilinkRanges('A useful thought about [[walk-sample.md]].', [])
  expect(materialiseSeed('A useful thought about [[walk-sample.md]].', contextual)).toEqual({
    title: 'walk-sample',
    gist: 'A useful thought about walk-sample.',
  })
})
