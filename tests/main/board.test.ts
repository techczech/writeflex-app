import { expect, test } from 'bun:test'
import type { QueryRow } from '../../src/preload'
import { boardAge, boardOffcuts, boardSources, groupBoardRows, isOffcutKey, isSourceKey, offcutKey, offcutOrigin, sourceKey } from '../../src/renderer/src/components/board-projection'

const row = (path: string, status: string | null, date: string | null = null): QueryRow => ({
  path,
  title: path,
  status,
  description: null,
  date,
  words: 10,
  agentAuthored: false,
  provenance: { title: 'derived', status: status === 'Unsorted' ? 'derived' : 'written', date: date ? 'written' : 'derived' },
  scrapCount: 0,
  sourceCount: 0,
})

test('Board groups every piece once, with unknown written stages appended alphabetically', () => {
  const columns = groupBoardRows([
    row('published.md', 'published'),
    row('idea.md', 'idea'),
    row('editing.md', 'EDITING'),
    row('waiting.md', 'waiting'),
    row('draft.md', 'draft'),
    row('bare.md', 'Unsorted'),
  ])

  expect(columns.map((column) => column.status)).toEqual([
    'Unsorted',
    'idea',
    'note gathering',
    'in progress',
    'editing',
    'ready',
    'published',
    'draft',
    'waiting',
  ])
  expect(columns.map((column) => column.rows.map((piece) => piece.path))).toEqual([
    ['bare.md'], ['idea.md'], [], [], ['editing.md'], [], ['published.md'], ['draft.md'], ['waiting.md'],
  ])
})

test('Board assigns every Piece exactly once when Turkish locale folding would change ASCII I', () => {
  const original = String.prototype.toLocaleLowerCase
  String.prototype.toLocaleLowerCase = function emulatedTurkishFold(): string {
    return String(this).replace(/I/g, 'ı').replace(/İ/g, 'i').toLowerCase()
  }
  try {
    const columns = groupBoardRows([row('idea.md', 'IDEA')])
    expect(columns.flatMap((column) => column.rows).map((piece) => piece.path)).toEqual(['idea.md'])
    expect(columns.find((column) => column.status === 'idea')?.rows.map((piece) => piece.path)).toEqual(['idea.md'])
  } finally {
    String.prototype.toLocaleLowerCase = original
  }
})

test('Board derives today, relative age, idea-stub, and over-90-day stall truth', () => {
  const now = new Date('2026-07-16T12:00:00Z')
  expect(boardAge(row('today.md', 'editing', '2026-07-16'), now)).toEqual({ label: 'today', days: 0, stalled: false })
  expect(boardAge(row('nine.md', 'editing', '2026-07-07'), now)).toEqual({ label: '9d', days: 9, stalled: false })
  expect(boardAge(row('old.md', 'editing', '2026-04-16'), now)).toEqual({ label: '91d', days: 91, stalled: true })
  expect(boardAge(row('stub.md', 'idea'), now)).toEqual({ label: 'stub', days: null, stalled: false })
  expect(boardAge(row('dateless.md', 'ready'), now)).toEqual({ label: '—', days: null, stalled: false })
})

test('Board compares a metadata date with the local calendar day', () => {
  const previous = process.env.TZ
  process.env.TZ = 'Europe/London'
  try {
    expect(boardAge(row('yesterday.md', 'editing', '2026-08-01'), new Date('2026-08-01T23:30:00Z')).label).toBe('1d')
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('Board places Unsorted first and retains every derived-status Piece', () => {
  const columns = groupBoardRows([row('bare.md', 'Unsorted'), row('editing.md', 'editing')])

  expect(columns[0].status).toBe('Unsorted')
  expect(columns[0].rows.map((piece) => piece.path)).toEqual(['bare.md'])
})

test('Board excludes Agent notes while ordinary query populations retain them', () => {
  const note = row('agent-notes/discarded.md', null)
  note.agentAuthored = true
  const columns = groupBoardRows([row('draft.md', 'editing'), note])

  expect(columns.flatMap((column) => column.rows).map((piece) => piece.path)).toEqual(['draft.md'])
})

test('Board grouping retains a seen unknown lane after its last Piece moves out', () => {
  const first = groupBoardRows([row('draft.md', 'draft'), row('parked.md', 'parked')])
  const retained = first.map((column) => column.status)
  const afterMove = groupBoardRows([row('draft.md', 'parked'), row('parked.md', 'parked')], retained)

  expect(afterMove.find((column) => column.status === 'draft')?.rows).toEqual([])
  expect(afterMove.find((column) => column.status === 'parked')?.rows.map((piece) => piece.path)).toEqual(['draft.md', 'parked.md'])
})

test('an Unsorted card shows its derived date as a compact British calendar date', () => {
  expect(boardAge(row('bare.md', 'Unsorted', '2026-06-12'), new Date('2026-08-01T12:00:00Z')).label).toBe('12 Jun 2026')
})

test('a derived date shows age quietly and never produces stalled state', () => {
  const derived = row('imported.md', 'editing', '2020-01-01')
  derived.provenance.date = 'derived'
  expect(boardAge(derived, new Date('2026-08-01T12:00:00Z'))).toEqual({ label: '2404d', days: 2404, stalled: false })
})

test('a scraps file is never a card: its scraps are the Offcuts column, in file order', () => {
  const offcut = (id: string) => ({
    id, text: `text ${id}`, firstWords: `text ${id}`, suggestedName: `Text ${id}`, done: false,
    scrapsPath: 'c/scraps/a-SCRAPS.md', origin: 'c/a.md', originTitle: 'Alpha', cutOn: '2026-08-03',
  })
  const rows = [
    row('c/a.md', 'editing'),
    { ...row('c/scraps/a-SCRAPS.md', null), material: 'scraps' as const, offcuts: [offcut('s_1'), offcut('s_2')] },
  ]
  const columns = groupBoardRows(rows)
  expect(columns.flatMap((column) => column.rows.map((candidate) => candidate.path))).toEqual(['c/a.md'])
  expect(columns.find((column) => column.status === 'Unsorted')?.rows).toEqual([])
  expect(boardOffcuts(rows).map((item) => item.id)).toEqual(['s_1', 's_2'])
  expect(offcutKey(offcut('s_1'))).toBe('offcut:c/scraps/a-SCRAPS.md#s_1')
  expect(isOffcutKey('offcut:c/scraps/a-SCRAPS.md#s_1')).toBe(true)
  expect(isOffcutKey('c/a.md')).toBe(false)
})

test('an offcut says where it was cut from and when', () => {
  const now = new Date(Date.UTC(2026, 8, 27))
  expect(offcutOrigin({ originTitle: 'How humans hallucinate', cutOn: '2026-08-03' }, now)).toBe('from How humans hallucinate · 3 Aug')
  expect(offcutOrigin({ originTitle: 'Frames and scripts', cutOn: '2025-09-12' }, now)).toBe('from Frames and scripts · 12 Sep 2025')
  expect(offcutOrigin({ originTitle: 'Frames and scripts', cutOn: null }, now)).toBe('from Frames and scripts')
})

test('a research note is never a card, whatever its stage: it is a source in the rail', () => {
  const user = { path: 'c/a.md', title: 'Alpha' }
  const rows = [
    row('c/a.md', 'editing'),
    { ...row('c/research/minsky.md', null), title: 'Minsky, Frames', material: 'research' as const, usedBy: [] },
    { ...row('c/research/hall.md', 'ready'), title: 'Hall 1976 notes', material: 'research' as const, usedBy: [user] },
    { ...row('c/research/bartlett.md', null), title: 'Bartlett, Remembering', material: 'research' as const, usedBy: [user] },
  ]
  const columns = groupBoardRows(rows)
  expect(columns.flatMap((column) => column.rows.map((candidate) => candidate.path))).toEqual(['c/a.md'])
  expect(columns.find((column) => column.status === 'Unsorted')?.rows).toEqual([])
  // Used sources first, then the unused, each by title.
  expect(boardSources(rows).map((source) => source.title)).toEqual(['Bartlett, Remembering', 'Hall 1976 notes', 'Minsky, Frames'])
  expect(boardSources(rows)[0]).toEqual({ path: 'c/research/bartlett.md', title: 'Bartlett, Remembering', usedBy: [user] })
  expect(sourceKey({ path: 'c/research/hall.md' })).toBe('source:c/research/hall.md')
  expect(isSourceKey('source:c/research/hall.md')).toBe(true)
  expect(isSourceKey('c/a.md')).toBe(false)
  expect(isOffcutKey('source:c/research/hall.md')).toBe(false)
})
