import { useCallback, useLayoutEffect, useRef, useState } from 'react'

export type OutlineFocusRequest = {
  origin: Element | null
  finish: () => boolean
}

type PendingOutlineFocus = OutlineFocusRequest & { route: object }

/** The explicit Open Outline command owns a single handoff to its committed pane. */
export function useOutlineFocus(route: object, visible: boolean, openLeftTab: (tab: 'outline') => void) {
  const [request, setRequest] = useState<PendingOutlineFocus | null>(null)
  const pending = useRef<PendingOutlineFocus | null>(null)
  const openOutline = useCallback(() => {
    const next: PendingOutlineFocus = {
      route,
      origin: document.activeElement,
      finish: () => {
        if (pending.current !== next) return false
        pending.current = null
        setRequest(null)
        return true
      },
    }
    pending.current = next
    openLeftTab('outline')
    setRequest(next)
  }, [route, openLeftTab])

  const current = visible && request?.route === route ? request : null
  useLayoutEffect(() => {
    if (!request || pending.current !== request) return
    const retire = request.finish
    if (!current) {
      retire()
      return
    }
    document.addEventListener('focusin', retire, true)
    document.addEventListener('pointerdown', retire, true)
    window.addEventListener('blur', retire)
    return () => {
      document.removeEventListener('focusin', retire, true)
      document.removeEventListener('pointerdown', retire, true)
      window.removeEventListener('blur', retire)
    }
  }, [request, current])

  return { openOutline, focusRequest: current }
}
