import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const useDOMLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect
const PANELS = '.sb-disclosure-popover, .sb-event-list, [data-testid="review-count-menu"], .rbp, .explicit-session-menu, .sb-agent-skill-popover, .apu-update-pop, .sb-notice-slot [role="dialog"]'

function triggerFor(panel: HTMLElement, bar: HTMLElement): HTMLButtonElement | null {
  for (let parent = panel.parentElement; parent && parent !== bar; parent = parent.parentElement) {
    const trigger = parent.querySelector<HTMLButtonElement>(':scope > button[aria-expanded="true"]')
    if (trigger) return trigger
  }
  return null
}

export function statusPopoverPlacement(
  anchor: Pick<DOMRect, 'top' | 'bottom' | 'right'>,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const inset = 8
  const gap = 8
  const above = Math.max(0, anchor.top - inset - gap)
  const below = Math.max(0, viewport.height - anchor.bottom - inset - gap)
  const putAbove = size.height <= above || above >= below
  const maxHeight = putAbove ? above : below
  return {
    left: Math.max(inset, Math.min(anchor.right - size.width, viewport.width - inset - size.width)),
    top: putAbove ? Math.max(inset, anchor.top - gap - Math.min(size.height, maxHeight)) : anchor.bottom + gap,
    maxHeight,
  }
}

/** Own geometry and dismissal for every status-bar panel, including the externally owned Sync slot. */
export function useStatusBarPopovers(barRef: RefObject<HTMLDivElement>, close: (restore: boolean, trigger?: HTMLButtonElement | null) => void): void {
  const closeRef = useRef(close)
  closeRef.current = close

  useDOMLayoutEffect(() => {
    const bar = barRef.current
    if (!bar) return
    let frame = 0
    let active: HTMLElement | null = null
    const resize = new ResizeObserver(() => schedule())
    const place = (): void => {
      const panel = bar.querySelector<HTMLElement>(PANELS)
      if (active !== panel) {
        if (active) resize.unobserve(active)
        active = panel
        if (panel) resize.observe(panel)
      }
      if (!panel) return
      const width = window.innerWidth
      const height = window.innerHeight
      const anchor = (triggerFor(panel, bar) ?? bar).getBoundingClientRect()
      panel.dataset.statusPopup = ''
      panel.style.setProperty('--status-popup-width', `${Math.max(1, width - 16)}px`)
      const rect = panel.getBoundingClientRect()
      const placement = statusPopoverPlacement(anchor, {
        width: rect.width,
        height: panel.scrollHeight + panel.offsetHeight - panel.clientHeight,
      }, { width, height })
      panel.style.setProperty('--status-popup-left', `${placement.left}px`)
      panel.style.setProperty('--status-popup-top', `${placement.top}px`)
      panel.style.setProperty('--status-popup-height', `${placement.maxHeight}px`)
      const submenu = panel.parentElement?.querySelector<HTMLElement>('.rcm-sub')
      if (submenu) {
        submenu.dataset.statusPopup = ''
        submenu.style.setProperty('--status-popup-width', `${Math.max(1, width - 16)}px`)
        const subWidth = submenu.getBoundingClientRect().width
        const left = placement.left >= subWidth + 12 ? placement.left - subWidth - 4 : placement.left + rect.width + 4
        submenu.style.setProperty('--status-popup-left', `${Math.max(8, Math.min(left, width - subWidth - 8))}px`)
        submenu.style.setProperty('--status-popup-top', `${placement.top}px`)
        submenu.style.setProperty('--status-popup-height', `${height - placement.top - 8}px`)
      }
    }
    const schedule = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => { frame = 0; place() })
    }
    const mutations = new MutationObserver(place)
    mutations.observe(bar, { childList: true, subtree: true })
    resize.observe(bar)
    place()
    window.addEventListener('resize', schedule)
    const outside = (event: PointerEvent): void => {
      const panel = bar.querySelector<HTMLElement>(PANELS)
      const target = event.target
      if (panel && target instanceof Node && !panel.contains(target) && !panel.closest('[data-review-count-menu]')?.contains(target) && !triggerFor(panel, bar)?.contains(target)) {
        closeRef.current(false)
      }
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
      const panel = bar.querySelector<HTMLElement>(PANELS)
      if (!panel) return
      const focusedSurface = event.target instanceof Element
        ? event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
        : null
      if (focusedSurface && (!bar.contains(focusedSurface) || focusedSurface.matches('.rcm-sub'))) return
      if ([...document.querySelectorAll('[aria-modal="true"], dialog[open]')]
        .some(modal => !bar.contains(modal) && modal.getClientRects().length > 0)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeRef.current(true, triggerFor(panel, bar))
    }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', escape, true)
    return () => {
      window.removeEventListener('resize', schedule)
      window.removeEventListener('keydown', escape, true)
      document.removeEventListener('pointerdown', outside, true)
      mutations.disconnect()
      resize.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [barRef])
}
