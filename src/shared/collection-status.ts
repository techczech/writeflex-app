/** Canonical Collection pipeline order shared by the query engine and its renderer projections. */
export const REFERENCE_STATUS_ORDER = ['idea', 'note gathering', 'in progress', 'editing', 'ready', 'published'] as const
export type ReferenceStatus = (typeof REFERENCE_STATUS_ORDER)[number]

/** Derived stage for a Piece whose written status is absent or empty (ADR-0034). */
export const UNSORTED_STATUS = 'Unsorted' as const
export const BOARD_STATUS_ORDER = [UNSORTED_STATUS, ...REFERENCE_STATUS_ORDER] as const
export type BoardStatus = string

/** Board lanes accept collection-specific names; only reject shapes unsafe as a compact YAML scalar. */
export function normaliseCollectionStatus(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid Collection status.')
  const status = value.trim()
  if (
    status === '' || status.length > 64 || /[\r\n\u0085\u2028\u2029]/.test(status)
    || /^["':]|["':]$/.test(status)
    || /:\s|\s:/.test(status)
  ) throw new Error('Invalid Collection status.')
  return status
}
