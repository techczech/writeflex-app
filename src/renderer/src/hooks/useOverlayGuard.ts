import { type MutableRefObject, useCallback, useEffect, useRef, useState } from 'react'

/**
 * The overlays this window can raise. Only ONE is ever open at a time (the mockup's
 * `closeOverlays()` before every open); 'files'/'commands' are the two modes of the command
 * palette (Task 13), 'settings'/'cheatsheet' arrive in Task 17. A plain string keeps the guard
 * agnostic of which surfaces exist so later tasks add their own without touching this hook.
 */
export type OverlayId = 'files' | 'commands' | 'settings' | 'cheatsheet' | 'version' | 'capture' | 'materialise' | 'skills' | 'focus' | 'goal' | 'export' | 'folderPiece' | 'widgetPicker' | 'sessionStarter' | 'statusDisclosure' | 'statusEvents'

export type OverlayGuard = {
  /** The overlay currently raised, or null. Reactive — drives conditional rendering of the sheet. */
  active: OverlayId | null
  /**
   * True while ANY overlay is open, held in a ref so the window's capture-phase keydown handlers
   * (⇧⌘O / ⌘T / ⌃⇥ / ⌘⇧P) can read it SYNCHRONOUSLY at the instant a key fires and stand down —
   * the M1 key-ownership rule the T8 review earmarked. A ref, not state, because those handlers are
   * registered once (stable deps) and must see the live value without re-subscribing on every open.
   */
  isOpenRef: MutableRefObject<boolean>
  /** Raise `id` (replacing any other open overlay). Updates the ref before the state so a shortcut
   *  fired in the same tick already sees an overlay as open. */
  open: (id: OverlayId) => void
  /** Dismiss whatever is open; global shortcuts resume ownership on the next keydown. */
  close: () => void
}

/**
 * Shared overlay key-ownership guard (Task 13, reused by Tasks 15/17). One instance lives in App;
 * every surface that raises a sheet routes through it so exactly one overlay is open and the
 * window's own capture-phase shortcuts stand down behind it. The sheet owns the keyboard while it
 * is up (focus lives in its input, so CM6 never sees the keystrokes and the global handlers bail on
 * `isOpenRef`).
 */
export function useOverlayGuard(): OverlayGuard {
  const [active, setActive] = useState<OverlayId | null>(null)
  const isOpenRef = useRef(false)

  const open = useCallback((id: OverlayId) => {
    isOpenRef.current = true
    setActive(id)
  }, [])
  const close = useCallback(() => {
    isOpenRef.current = false
    setActive(null)
  }, [])

  // Reset on unmount: the ref that the window's capture-phase shortcuts read is plain (not state),
  // so an unmount-while-open must clear it or a stale `true` could wedge those guarded shortcuts.
  useEffect(
    () => () => {
      isOpenRef.current = false
      setActive(null)
    },
    [],
  )

  return { active, isOpenRef, open, close }
}
