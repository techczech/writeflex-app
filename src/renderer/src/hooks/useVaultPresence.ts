import { useEffect, useState } from 'react'

/**
 * Whether this window's root is a vault: `null` until the first read, then true/false. Follows the
 * vault store's `vault:changed` push, so a vault made by the Make-vault sheet (or removed or arriving
 * from another Mac) is reflected without reopening the window.
 */
export function useVaultPresence(root: string | null | undefined): boolean | null {
  const [isVault, setIsVault] = useState<boolean | null>(null)
  useEffect(() => {
    if (!root) { setIsVault(null); return }
    let live = true
    void window.writeflex.vault.get().then(
      (vault) => { if (live) setIsVault(vault !== null) },
      () => { if (live) setIsVault(false) },
    )
    const off = window.writeflex.vault.onChanged((event) => { if (live) setIsVault(event.vault !== null) })
    return () => { live = false; off() }
  }, [root])
  return isVault
}
