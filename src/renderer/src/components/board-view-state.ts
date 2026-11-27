/**
 * The Board's per-collection view choices, kept in this browser's storage: a convenience, never
 * content. Every read and write tolerates storage being unavailable (the Board then uses defaults).
 */

const OFFCUTS_HIDDEN = 'writeflex.board.offcutsHidden:'
const SOURCES_COLLAPSED = 'writeflex.board.sourcesCollapsed:'

export function offcutsHidden(dir: string): boolean {
  try {
    return localStorage.getItem(`${OFFCUTS_HIDDEN}${dir}`) === '1'
  } catch {
    return false
  }
}

export function setOffcutsHidden(dir: string, hidden: boolean): void {
  try {
    if (hidden) localStorage.setItem(`${OFFCUTS_HIDDEN}${dir}`, '1')
    else localStorage.removeItem(`${OFFCUTS_HIDDEN}${dir}`)
  } catch {
    // Storage unavailable: the choice lasts until the Board remounts.
  }
}

/** An explicit choice wins over the default based on the Collection's source count. */
export function sourcesVisibility(dir: string): boolean | null {
  const key = `${SOURCES_COLLAPSED}${dir}`
  try {
    if (sessionStorage.getItem(key) === 'expanded') return true
    return localStorage.getItem(key) === '1' ? false : null
  } catch {
    return null
  }
}

export function setSourcesCollapsed(dir: string, collapsed: boolean): void {
  const key = `${SOURCES_COLLAPSED}${dir}`
  try {
    if (collapsed) {
      sessionStorage.removeItem(key)
      localStorage.setItem(key, '1')
    } else {
      sessionStorage.setItem(key, 'expanded')
      localStorage.removeItem(key)
    }
  } catch {
    // Storage unavailable: the choice lasts until the Board remounts.
  }
}

const COLUMN_ORDER = 'writeflex.board.columnOrder:'
export function columnOrder(dir: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`${COLUMN_ORDER}${dir}`) ?? '[]')
    return Array.isArray(value) && value.every((s) => typeof s === 'string') ? [...new Set(value)] : []
  } catch { return [] }
}
export function setColumnOrder(dir: string, order: string[]): void {
  try { localStorage.setItem(`${COLUMN_ORDER}${dir}`, JSON.stringify(order)) } catch { /* Session only when storage is unavailable. */ }
}
export function orderColumns<T extends { status: string }>(columns: T[], order: string[]): T[] {
  const rank = new Map(order.map((s, i) => [s.toLowerCase(), i]))
  return [...columns].sort((a, b) => (rank.get(a.status.toLowerCase()) ?? Infinity) - (rank.get(b.status.toLowerCase()) ?? Infinity))
}
export function moveColumn(order: string[], status: string, direction: -1 | 1): string[] {
  const from = order.indexOf(status), to = from + direction
  const next = [...order]
  if (from >= 0 && to >= 0 && to < next.length) [next[from], next[to]] = [next[to], next[from]]
  return next
}
