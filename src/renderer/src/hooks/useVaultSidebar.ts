import { useCallback, useEffect, useMemo, useState } from 'react'
import type { VaultIndex } from '../../../shared/vault-index'
import { useVaultPresence } from './useVaultPresence'

type IndexView =
  | { status: 'loading' | 'failed'; index: null }
  | { status: 'ready'; index: VaultIndex }

const LOADING: IndexView = { status: 'loading', index: null }

export type VaultSidebarView = ReturnType<typeof useVaultSidebar>

/** The Files sidebar and palette share this index read for the window's current root. */
export function useVaultSidebar(root: string | null | undefined, listingReady: boolean) {
  const presence = useVaultPresence(root)
  const { vault } = presence
  const [retry, setRetry] = useState(0)
  const retryIndex = useCallback(() => setRetry((current) => current + 1), [])
  const [snapshot, setSnapshot] = useState<{ root: string; retry: number; view: IndexView } | null>(null)

  useEffect(() => {
    const bridge = window.writeflex
    // Let the first document and the Files listing finish before the index starts its own reads.
    if (!root || !listingReady || !vault || !bridge?.getVaultIndex) {
      setSnapshot(null)
      return
    }
    let live = true
    // A push can supersede the initial pull while its IPC call is still in flight.
    let pushed = false
    const publish = (index: VaultIndex | null): void => {
      setSnapshot({ root, retry, view: index ? { status: 'ready', index } : { status: 'failed', index: null } })
    }
    const off = bridge.onVaultIndexChanged((index) => {
      if (!live) return
      pushed = true
      publish(index)
    })
    void bridge.getVaultIndex().then(
      (index) => { if (live && !pushed) publish(index) },
      () => { if (live && !pushed) publish(null) },
    )
    return () => { live = false; off() }
  }, [root, listingReady, vault, retry])

  // Keep the same root's index during background updates. A root change or explicit retry starts pending.
  const view = listingReady && snapshot && snapshot.root === root && snapshot.retry === retry ? snapshot.view : LOADING
  const index = vault ? view.index : null
  const status = presence.status === 'vault' ? view.status : presence.status
  return useMemo(() => ({ vault, index, status, retryIndex }), [vault, index, status, retryIndex])
}
