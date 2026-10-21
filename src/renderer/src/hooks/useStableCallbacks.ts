import { useMemo, useRef } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (...args: any[]) => any>

/**
 * The same handlers under identities that never change, each calling the latest one it was given.
 * For handing callbacks to a memoised child (the Files tree, 0.24.1 R6) without re-rendering it every
 * time the parent's closures are rebuilt. The set of keys is fixed by the first render; the latest
 * handlers are taken during render, so a child's effects and events always call the current ones.
 */
export function useStableCallbacks<T extends Handlers>(handlers: T): T {
  const latest = useRef(handlers)
  latest.current = handlers
  return useMemo(() => {
    const stable: Handlers = {}
    for (const key of Object.keys(latest.current)) stable[key] = (...args: unknown[]) => latest.current[key](...args)
    return stable as T
  }, [])
}
