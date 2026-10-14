import { REFERENCE_STATUS_ORDER } from '../../../shared/collection-status'

export const QUERY_SORTABLE_FIELDS = ['title', 'status', 'date'] as const
export type QuerySortableField = typeof QUERY_SORTABLE_FIELDS[number]

const STATUS_BADGES = new Map<(typeof REFERENCE_STATUS_ORDER)[number], string>([
  [REFERENCE_STATUS_ORDER[0], 'idea'],
  [REFERENCE_STATUS_ORDER[1], 'note'],
  [REFERENCE_STATUS_ORDER[2], 'prog'],
  [REFERENCE_STATUS_ORDER[3], 'edit'],
  [REFERENCE_STATUS_ORDER[4], 'ready'],
  [REFERENCE_STATUS_ORDER[5], 'pub'],
])

export function queryStatusBadgeClass(status: string | null): string {
  if (!status) return 'neutral'
  return STATUS_BADGES.get(status.trim().toLowerCase() as (typeof REFERENCE_STATUS_ORDER)[number]) ?? 'neutral'
}

export function formatQueryDate(value: string | null): string {
  if (!value) return '—'
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) return value
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
}

const DEFAULT_DIRECTION: Record<QuerySortableField, 'asc' | 'desc'> = { title: 'asc', status: 'asc', date: 'desc' }

/** Persist a header sort in the portable query source. Description is intentionally not in the type. */
export function rewriteQuerySortLine(source: string, field: QuerySortableField): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const trailing = source.endsWith(newline)
  const lines = source === '' ? [] : source.replace(/\r\n/g, '\n').split('\n')
  if (trailing) lines.pop()
  const index = lines.findIndex((line) => /^\s*sort\s*:/i.test(line))
  const active = index < 0 ? null : /^\s*sort\s*:\s*(title|status|date|words)\s+(asc|desc)\s*$/i.exec(lines[index])
  const direction = active?.[1].toLowerCase() === field.toLowerCase()
    ? (active[2].toLowerCase() === 'asc' ? 'desc' : 'asc')
    : DEFAULT_DIRECTION[field]
  const replacement = `sort: ${field} ${direction}`
  if (index < 0) lines.push(replacement)
  else lines[index] = replacement
  return `${lines.join(newline)}${trailing ? newline : ''}`
}

export function compactQuerySummary(source: string): string {
  return source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join(' · ') || 'all pieces'
}
