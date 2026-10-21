import { expect, test } from 'bun:test'
import { orderDashboard, type DashEntry, type DashSort, type DashSortKey } from '../../src/renderer/src/components/collection-order'

const e = (label: string, isFolder: boolean, extra: Partial<DashEntry<string>> = {}): DashEntry<string> =>
  ({ isFolder, label, purpose: null, status: null, modified: null, item: label, ...extra })

const entries = [
  e('zeta', false, { purpose: 'essay', status: 'draft', modified: 5 }),
  e('Alpha', true, { purpose: '3 pieces', modified: 9 }),
  e('mid', false, { purpose: 'brief', status: 'final', modified: 1 }),
  e('beta', true, { purpose: '10 pieces', status: 'idea', modified: 2 }),
  e('Folio work', true, { purpose: 'report', status: 'draft', modified: 7 }),
  e('bare', false),
]

const keys: DashSortKey[] = ['title', 'purpose', 'status', 'date']
const dirs: Array<'asc' | 'desc'> = ['asc', 'desc']

test('folders come before files under every column and direction', () => {
  for (const key of keys) for (const dir of dirs) {
    const out = orderDashboard(entries, { key, dir })
    const flags = out.map((x) => x.isFolder)
    expect(flags).toEqual([true, true, true, false, false, false])
    expect(out.length).toBe(entries.length)
  }
})

test('title sorts by the shown label, case-insensitive, each group alone', () => {
  const asc = orderDashboard(entries, { key: 'title', dir: 'asc' }).map((x) => x.label)
  expect(asc).toEqual(['Alpha', 'beta', 'Folio work', 'bare', 'mid', 'zeta'])
  const desc = orderDashboard(entries, { key: 'title', dir: 'desc' }).map((x) => x.label)
  expect(desc).toEqual(['Folio work', 'beta', 'Alpha', 'zeta', 'mid', 'bare'])
})

test('missing values go last within their group in both directions', () => {
  for (const dir of dirs) {
    const s: DashSort = { key: 'status', dir }
    const out = orderDashboard(entries, s).map((x) => x.label)
    expect(out[2]).toBe('Alpha') // the folder with no status is last of the folders
    expect(out[5]).toBe('bare') // the file with no status is last of the files
  }
})

test('modified sorts numerically within groups', () => {
  expect(orderDashboard(entries, { key: 'date', dir: 'desc' }).map((x) => x.label)).toEqual(['Alpha', 'Folio work', 'beta', 'zeta', 'mid', 'bare'])
  expect(orderDashboard(entries, { key: 'date', dir: 'asc' }).map((x) => x.label)).toEqual(['beta', 'Folio work', 'Alpha', 'mid', 'zeta', 'bare'])
})

test('purpose uses numeric collation so "3 pieces" precedes "10 pieces"', () => {
  const out = orderDashboard(entries.filter((x) => x.isFolder), { key: 'purpose', dir: 'asc' }).map((x) => x.label)
  expect(out).toEqual(['Alpha', 'beta', 'Folio work'])
})
