import { expect, test } from 'bun:test'
import { rankPaletteEntries, type RankableEntry } from '../../src/renderer/src/components/CommandPalette'

const GROUP = 'Collect and plan'
const make = (label: string, group = GROUP, keywords: string[] = []): RankableEntry<string> & { order: number } => ({
  item: label,
  label,
  searchable: [label, group, ...keywords].join(' '),
  fallback: undefined,
  order: 0,
})
const entries = (): RankableEntry<string>[] =>
  [
    make('Open Board'),
    make('Open Plan'),
    make('Start a plan'),
    make('Make a Folio'),
    make('Bold', 'Format', ['strong']),
    make('Toggle theme', 'Look', ['plan b']),
  ].map((entry, order) => ({ ...entry, order }))

test('"Open Plan" ranks Open Plan above Open Board', () => {
  const out = rankPaletteEntries('Open Plan', entries())
  expect(out[0]).toBe('Open Plan')
  expect(out.indexOf('Open Board')).toBeGreaterThan(0)
})

test('"plan" lists every label match before any group-only match', () => {
  const out = rankPaletteEntries('plan', entries())
  const labelHits = ['Open Plan', 'Start a plan']
  expect(out.slice(0, 2).sort()).toEqual([...labelHits].sort())
  for (const name of ['Open Board', 'Make a Folio', 'Toggle theme']) expect(out.indexOf(name)).toBeGreaterThan(1)
})

test('"board" puts Open Board first', () => {
  expect(rankPaletteEntries('board', entries())[0]).toBe('Open Board')
})

test('a group name still lists the group\'s commands', () => {
  const out = rankPaletteEntries('collect and plan', entries())
  for (const name of ['Open Board', 'Open Plan', 'Start a plan', 'Make a Folio']) expect(out).toContain(name)
})

test('a keyword-only match still appears', () => {
  expect(rankPaletteEntries('strong', entries())).toEqual(['Bold'])
})
