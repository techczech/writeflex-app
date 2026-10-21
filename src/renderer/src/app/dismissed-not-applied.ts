/**
 * The closed changes the writer dismissed from "could not be applied", kept per Collection in this
 * browser's storage with the app's other per-Collection view state (recents, sidebar folds, the Board's
 * view choices): a convenience, never content. Dismissing hides a record from the dock; the ledger and
 * its `.writeflex` folder are not touched. Every read and write tolerates storage being unavailable.
 */
const KEY = 'writeflex.dismissedNotApplied:'
/** The most ids kept per Collection; the oldest are dropped first. */
export const DISMISSED_LIMIT = 2000

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadDismissed(root: string, store: Store | null = defaultStore()): string[] {
  try {
    const raw = store?.getItem(`${KEY}${root}`)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** The list with `ids` added (no repeats), newest last, capped at the limit. */
export function withDismissed(current: readonly string[], ids: readonly string[]): string[] {
  const merged = [...current.filter((id) => !ids.includes(id)), ...ids]
  return merged.slice(-DISMISSED_LIMIT)
}

export function saveDismissed(root: string, ids: readonly string[], store: Store | null = defaultStore()): void {
  try {
    if (ids.length === 0) store?.removeItem(`${KEY}${root}`)
    else store?.setItem(`${KEY}${root}`, JSON.stringify(ids))
  } catch {
    // Storage unavailable: the dismissal lasts until the window reloads.
  }
}
