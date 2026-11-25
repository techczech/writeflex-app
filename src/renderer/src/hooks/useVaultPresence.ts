import { useEffect, useState } from 'react'
import type { VaultView } from '../../../shared/vault'

type VaultPresence =
  | { status: 'checking' | 'folder' | 'unavailable'; vault: null }
  | { status: 'vault'; vault: VaultView }

const CHECKING: VaultPresence = { status: 'checking', vault: null }

/** The vault tier of this window's root, including promotions and changes from disk. */
export function useVaultPresence(root: string | null | undefined): VaultPresence {
  const [snapshot, setSnapshot] = useState<{ root: string; presence: VaultPresence } | null>(null)

  useEffect(() => {
    if (!root || !window.writeflex?.vault) {
      setSnapshot(null)
      return
    }
    const bridge = window.writeflex.vault
    let live = true
    let changed = false
    const publish = (vault: VaultView | null): void => {
      setSnapshot({ root, presence: vault ? { status: 'vault', vault } : { status: 'folder', vault: null } })
    }
    setSnapshot({ root, presence: CHECKING })
    const off = bridge.onChanged(({ vault }) => {
      if (!live) return
      changed = true
      publish(vault)
    })
    void bridge.get().then(
      (vault) => { if (live && !changed) publish(vault) },
      () => { if (live && !changed) setSnapshot({ root, presence: { status: 'unavailable', vault: null } }) },
    )
    return () => { live = false; off() }
  }, [root])

  return snapshot && snapshot.root === root ? snapshot.presence : CHECKING
}
