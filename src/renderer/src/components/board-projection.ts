import type { Offcut, QueryRow, SourceUser } from '../../../preload'
import { BOARD_STATUS_ORDER, UNSORTED_STATUS } from '../../../shared/collection-status'
import { queryStatusBadgeClass } from '../editor/query-object'

export type BoardColumn = {
  status: string
  badgeClass: string
  rows: QueryRow[]
}

export type BoardAge = { label: string; days: number | null; stalled: boolean }

/** Third projection of the query engine: bucket its rows without reading or parsing files again. */
export function groupBoardRows(rows: QueryRow[], retainedStatuses: Iterable<string> = []): BoardColumn[] {
  // Scraps files and research notes are material, not pieces: their scraps are the Offcuts column and
  // the notes are the Sources rail, never cards.
  const pipelineRows = rows.filter((row) => !row.agentAuthored && row.material === undefined)
  const known = new Set<string>(BOARD_STATUS_ORDER.map((status) => status.toLowerCase()))
  const unknownByKey = new Map<string, string>()
  for (const raw of [...retainedStatuses, ...pipelineRows.map((row) => row.status ?? '')]) {
    const status = raw.trim()
    const referenceKey = status.toLowerCase()
    const userKey = status.toLowerCase()
    if (status && !known.has(referenceKey) && !unknownByKey.has(userKey)) {
      unknownByKey.set(userKey, status)
    }
  }
  const unknown = [...unknownByKey.values()].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
  return [...BOARD_STATUS_ORDER, ...unknown].map((status) => ({
    status,
    badgeClass: queryStatusBadgeClass(status),
    rows: pipelineRows.filter((row) => (row.status?.trim() || UNSORTED_STATUS).toLowerCase() === status.toLowerCase()),
  }))
}

/** Calendar-day age from ISO frontmatter truth. Invalid dates stay deliberately unknown. */
export function boardAge(row: QueryRow, now = new Date()): BoardAge {
  if (!row.date) return { label: row.status?.trim().toLowerCase() === 'idea' ? 'stub' : '—', days: null, stalled: false }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row.date)
  if (!match) return { label: row.date, days: null, stalled: false }
  const then = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const parsed = new Date(then)
  if (parsed.getUTCFullYear() !== Number(match[1]) || parsed.getUTCMonth() !== Number(match[2]) - 1 || parsed.getUTCDate() !== Number(match[3])) {
    return { label: row.date, days: null, stalled: false }
  }
  if (row.status?.trim().toLowerCase() === 'unsorted') {
    return {
      label: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(parsed),
      days: Math.max(0, Math.floor((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86_400_000)),
      stalled: false,
    }
  }
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.max(0, Math.floor((today - then) / 86_400_000))
  return { label: days === 0 ? 'today' : `${days}d`, days, stalled: row.provenance.date === 'written' && days > 90 }
}

/** Every scrap in the Collection, as the Offcuts column lists it: scraps files in path order, each in file
 *  order, then the floating Scratchpad's waiting items by their piece. */
export function boardOffcuts(rows: QueryRow[]): Offcut[] {
  return [
    ...rows.filter((row) => row.material === 'scraps').flatMap((row) => row.offcuts ?? []),
    ...rows.flatMap((row) => row.looseOffcuts ?? []),
  ]
}

/** The Board's selection key for an offcut (a piece is selected by its path). */
export function offcutKey(offcut: Pick<Offcut, 'scrapsPath' | 'id'>): string {
  return `offcut:${offcut.scrapsPath}#${offcut.id}`
}

export function isOffcutKey(key: string | null): boolean {
  return key !== null && key.startsWith('offcut:')
}

/** Three-letter months as the locked design writes them ("12 Sep"); ICU's en-GB says "Sept". */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "from How humans hallucinate · 3 Aug" (frame 1); the year shows when it is not this year's. */
export function offcutOrigin(offcut: Pick<Offcut, 'originTitle' | 'cutOn'>, now = new Date()): string {
  const match = offcut.cutOn ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(offcut.cutOn) : null
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined
  if (!match || !month) return `from ${offcut.originTitle}`
  const year = Number(match[1]) !== now.getFullYear() ? ` ${match[1]}` : ''
  return `from ${offcut.originTitle} · ${Number(match[3])} ${month}${year}`
}

/** A source as the Sources rail lists it (locked design frame 1): a research note and the pieces using it. */
export type BoardSource = { path: string; title: string; usedBy: SourceUser[] }

/** The Collection's research notes for the Sources rail: the ones in use first, then the unused, each by title. */
export function boardSources(rows: QueryRow[]): BoardSource[] {
  return rows
    .filter((row) => row.material === 'research')
    .map((row) => ({ path: row.path, title: row.title, usedBy: row.usedBy ?? [] }))
    .sort((a, b) => Number(a.usedBy.length === 0) - Number(b.usedBy.length === 0) || a.title.localeCompare(b.title) || a.path.localeCompare(b.path))
}

/** The Board's selection key for a source in the rail. */
export function sourceKey(source: Pick<BoardSource, 'path'>): string {
  return `source:${source.path}`
}

export function isSourceKey(key: string | null): boolean {
  return key !== null && key.startsWith('source:')
}
