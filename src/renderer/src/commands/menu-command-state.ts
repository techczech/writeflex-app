/** Child views own these checks. Publishing never copies their state into an App-side toggle. */
export function commandCheckStore() {
  const owners = new Map<symbol, Readonly<Record<string, boolean>>>()
  const listeners = new Set<() => void>()
  let current: Readonly<Record<string, boolean>> = {}
  function update(): void {
    const next = Object.assign({}, ...owners.values()) as Record<string, boolean>
    if (JSON.stringify(current) === JSON.stringify(next)) return
    current = next
    for (const listener of listeners) listener()
  }
  return {
    publish(checks: Readonly<Record<string, boolean>>): () => void {
      const owner = Symbol()
      owners.set(owner, checks); update()
      return () => { owners.delete(owner); update() }
    },
    subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } },
    snapshot: () => current,
  }
}
export const menuCommandChecks = commandCheckStore()

/** Trailing debounce: `schedule` restarts the wait, `flush` publishes now (and cancels the wait). */
export function createDebouncedPublisher(publish: () => void, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined } }
  return {
    schedule(): void { cancel(); timer = setTimeout(() => { timer = undefined; publish() }, delayMs) },
    flush(): void { cancel(); publish() },
    cancel,
  }
}
