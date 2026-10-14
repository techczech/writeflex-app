/**
 * Insert widget picker: an Enter pressed before the file list has arrived is queued (one at most) and
 * inserts the first row when the list lands. Esc, typing in the filter, or an empty list drop it.
 */
export type PendingEnter = boolean

export type EnterAction<T> = { pending: PendingEnter; choose: T | null }

/** Enter pressed. `loaded` is false while the list is still on its way. */
export function pressEnter<T>(loaded: boolean, selectedRow: T | undefined): EnterAction<T> {
  if (!loaded) return { pending: true, choose: null }
  return { pending: false, choose: selectedRow ?? null }
}

/** The list arrived. Inserts the first row only if an Enter was waiting; an empty list does nothing. */
export function listArrived<T>(pending: PendingEnter, files: readonly T[]): EnterAction<T> {
  return { pending: false, choose: pending ? files[0] ?? null : null }
}

/** Esc or typing in the filter. */
export function cancelEnter(): PendingEnter {
  return false
}
