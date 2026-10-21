import { useCallback, useEffect, useRef, useState } from 'react'
import { readVaultSidebarPrefs, watchVaultSidebarPrefs, writeVaultSidebarPrefs, type VaultSidebarPrefs } from '../vault-sidebar'

/**
 * A vault root's sidebar choices (Writing only, Titles | File names), shared by every place that shows or
 * changes them: the sidebar's filter bar and the palette's `Writing only` / `Show titles in sidebar`.
 */
export function useVaultSidebarPrefs(root: string): [VaultSidebarPrefs, (patch: Partial<VaultSidebarPrefs>) => void] {
  const [prefs, setPrefs] = useState<VaultSidebarPrefs>(() => readVaultSidebarPrefs(root))
  const current = useRef(prefs)
  current.current = prefs
  useEffect(() => {
    const read = readVaultSidebarPrefs(root)
    current.current = read
    setPrefs(read)
    return watchVaultSidebarPrefs(root, (next) => { current.current = next; setPrefs(next) })
  }, [root])
  const choose = useCallback((patch: Partial<VaultSidebarPrefs>) => {
    writeVaultSidebarPrefs(root, { ...current.current, ...patch })
  }, [root])
  return [prefs, choose]
}
