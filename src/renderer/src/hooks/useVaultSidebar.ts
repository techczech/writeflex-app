import { useEffect, useState } from 'react'
import type { VaultIndex } from '../../../shared/vault-index'
import type { VaultView } from '../../../shared/vault'

/**
 * The window root's vault (name, status map) and vault index (works, hidden set, labels), both null when the
 * root is not a vault. The previous index stays on screen until a new one arrives, so labels and the hidden
 * set update in place.
 */
export function useVaultSidebar(root: string): { vault: VaultView | null; index: VaultIndex | null } {
  const [vault, setVault] = useState<VaultView | null>(null)
  const [index, setIndex] = useState<VaultIndex | null>(null)

  useEffect(() => {
    const bridge = window.writeflex
    if (!bridge?.vault || !bridge.getVaultIndex) return undefined
    let live = true
    setVault(null)
    setIndex(null)
    const loadIndex = (): void => {
      void bridge.getVaultIndex().then((next) => { if (live) setIndex(next) }).catch(() => undefined)
    }
    void bridge.vault.get().then((next) => { if (live) { setVault(next); if (next) loadIndex() } }).catch(() => undefined)
    const offVault = bridge.vault.onChanged((event) => {
      if (!live) return
      setVault(event.vault)
      if (event.vault) loadIndex()
      else setIndex(null)
    })
    const offIndex = bridge.onVaultIndexChanged((next) => { if (live) setIndex(next) })
    return () => { live = false; offVault(); offIndex() }
  }, [root])

  return { vault, index }
}
