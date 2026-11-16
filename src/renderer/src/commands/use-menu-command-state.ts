import { useEffect, useSyncExternalStore } from 'react'
import { menuCommandChecks } from './menu-command-state'

/** Data from a mounted surface; disposal withdraws that surface's checks. */
export function useMenuCommandChecks(checks: Readonly<Record<string, boolean>>): void {
  const serialised = JSON.stringify(checks)
  useEffect(() => menuCommandChecks.publish(JSON.parse(serialised)), [serialised])
}
export function useLiveMenuChecks(): Readonly<Record<string, boolean>> {
  return useSyncExternalStore(menuCommandChecks.subscribe, menuCommandChecks.snapshot)
}
