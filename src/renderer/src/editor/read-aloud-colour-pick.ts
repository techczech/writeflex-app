/**
 * The Custom… colour picker fires an input event on every drag tick. Each tick applies the colour
 * live without a changelog row; the pick ends on the picker's `change` event (or after the colour has
 * stopped changing for `delay` ms) and writes ONE logged entry whose old value is the colour from
 * before the pick began, so Reset goes back to it.
 */
export type ColourPick = { tick(value: string): void; commit(): void }

export function createColourPick(options: {
  /** The colour currently stored (read when a pick begins). */
  read: () => string
  /** Store and apply `value`; `log` says whether it earns a changelog entry. */
  apply: (value: string, log: boolean) => void
  setTimer?: (callback: () => void, delay: number) => unknown
  clearTimer?: (handle: unknown) => void
  delay?: number
}): ColourPick {
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const delay = options.delay ?? 800
  let origin: string | null = null
  let latest = ''
  let timer: unknown = null

  const commit = (): void => {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (origin === null) return
    const before = origin
    origin = null
    if (latest === before) return
    // The store logs old → new from what it holds: put the pre-pick colour back (silently), then
    // write the final one with a log, so the single entry reads before → after.
    options.apply(before, false)
    options.apply(latest, true)
  }

  return {
    tick(value) {
      if (origin === null) origin = options.read()
      latest = value
      options.apply(value, false)
      if (timer !== null) clearTimer(timer)
      timer = setTimer(commit, delay)
    },
    commit,
  }
}
