import type { CollectionRow } from '../../../preload'
import { BOARD_STATUS_ORDER } from '../../../shared/collection-status'
export type CollectionFilters = { query: string; searchIn: 'all' | 'title'; statuses: string[]; purposes: string[]; tags: string[]; modified: 'any' | '7' | '30' }
export const EMPTY_COLLECTION_FILTERS: CollectionFilters = { query: '', searchIn: 'all', statuses: [], purposes: [], tags: [], modified: 'any' }
export type CollectionGroup = 'none' | 'status' | 'purpose' | 'month'
export type PreparedCollectionRow = { row: CollectionRow; title: string; text: string; snippetSource: string; snippetText: string }
export type CollectionHit = { row: CollectionRow; snippet: string | null }
export function prepareCollectionRows(rows: CollectionRow[]): PreparedCollectionRow[] {
  return rows.map(row => {
    const snippetSource = (row.searchText ?? '').replace(/^\s*#{1,6}\s.*$/gm, '')
    return { row, title: `${row.title ?? row.name}`.toLocaleLowerCase(), text: (row.searchText ?? '').toLocaleLowerCase(), snippetSource, snippetText: snippetSource.toLocaleLowerCase() }
  })
}
export function filterCollectionRows(rows: PreparedCollectionRow[], filters: CollectionFilters, now = Date.now()): CollectionHit[] {
  const terms = filters.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  const selected = (values: string[], value: string) => values.length === 0 || values.includes(value)
  return rows.flatMap(({ row, title, text, snippetSource, snippetText }) => {
    if (!selected(filters.statuses, row.status || 'Unsorted') || !selected(filters.purposes, row.purpose || 'Unspecified')) return []
    if (filters.tags.length && !filters.tags.some(tag => row.tags?.includes(tag))) return []
    if (filters.modified !== 'any' && row.modified < now - Number(filters.modified) * 86_400_000) return []
    if (!terms.every(term => title.includes(term) || (filters.searchIn === 'all' && text.includes(term)))) return []
    let snippet: string | null = null
    if (terms.length && filters.searchIn === 'all') {
      const bodyTerm = terms.find(term => snippetText.includes(term))
      if (bodyTerm) {
        const at = snippetText.indexOf(bodyTerm)
        const source = snippetSource
        const before = source.slice(0, at).search(/[^.!?\n]*$/)
        const start = Math.max(before, at - 100)
        const tail = source.slice(at).search(/[.!?\n]/)
        const end = Math.min(tail < 0 ? source.length : at + tail + 1, at + 180)
        snippet = `${start > before ? '…' : ''}${source.slice(start, end).trim()}${end < source.length && end === at + 180 ? '…' : ''}`
      }
    }
    return [{ row, snippet }]
  })
}
export function groupCollectionRows(rows: CollectionHit[], by: CollectionGroup): Array<{ label: string; rows: CollectionHit[] }> {
  if (by === 'none') return [{ label: '', rows }]
  const groups = new Map<string, CollectionHit[]>()
  for (const hit of rows) {
    const date = new Date(hit.row.modified)
    const key = by === 'status' ? hit.row.status || 'Unsorted' : by === 'purpose' ? hit.row.purpose || 'Unspecified' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(hit)
  }
  const keys = [...groups.keys()].sort((a, b) => {
    if (by === 'month') return b.localeCompare(a)
    if (by === 'status') {
      const ai = (BOARD_STATUS_ORDER as readonly string[]).indexOf(a), bi = (BOARD_STATUS_ORDER as readonly string[]).indexOf(b)
      if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
    }
    return a.localeCompare(b)
  })
  return keys.map(key => ({ label: by === 'month' ? new Date(`${key}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : key, rows: groups.get(key)! }))
}
