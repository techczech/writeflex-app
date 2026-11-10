import { type RefObject, useEffect, useRef } from 'react'

/**
 * Keep the keyboard inside a modal (Folio versions ticket 04, review item 5).
 *
 * A modal that only sits on top of the window leaves the rest of it reachable: Tab walked out of the Save sheet
 * into the Folio room, where an outline row's own key handler ran Delete and ⌥↑/⌥↓ although the sheet was up.
 * While `root` is mounted this hook:
 *   - marks everything outside it `inert` (the browser's own rule: not focusable, not clickable, not in the
 *     accessibility tree), by walking up from `root` and marking each ancestor's other children, and lifts exactly
 *     those marks when the modal goes;
 *   - keeps Tab and ⇧Tab cycling over the modal's own controls, and takes focus back to them if it ever lands elsewhere;
 *   - on dismissal, returns focus to the element that had it when the modal opened (if it is still in the page), unless
 *     something else has already taken focus by then (the sheet the choice hands over to puts it in its own field).
 *
 * `root` is the modal's outermost element (its backdrop), so the sheet and the click-away layer stay live.
 */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const focusablesIn = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => !element.hasAttribute('inert') && element.getClientRects().length > 0)

/** Where focus goes when the last modal of a chain closes: the choice hands it on to the sheet it opens. */
let handedOn: HTMLElement | null = null

export function useModalFocus(root: RefObject<HTMLElement | null>): void {
  // Read while rendering, before the modal's own autofocus: afterwards the active element is already inside the modal.
  const openerRef = useRef<HTMLElement | null | undefined>(undefined)
  if (openerRef.current === undefined) {
    // (No document when the modal is drawn to a string, as the unit tests do.)
    const active = typeof document === 'undefined' ? null : document.activeElement
    openerRef.current = active === null || !(active instanceof HTMLElement) ? null : active.closest('[data-modal-focus]') ? handedOn : active
  }
  useEffect(() => {
    const modal = root.current
    if (!modal) return
    const opener = openerRef.current ?? null
    modal.setAttribute('data-modal-focus', '')
    // Everything outside the modal becomes inert; elements already inert stay as they were found.
    const marked: HTMLElement[] = []
    let node: HTMLElement | null = modal
    while (node && node !== document.documentElement) {
      const parent: HTMLElement | null = node.parentElement
      if (!parent) break
      for (const sibling of Array.from(parent.children)) {
        if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert')) continue
        sibling.setAttribute('inert', '')
        marked.push(sibling)
      }
      node = parent
    }
    // A focused control that has just become inert gives up focus; start inside the modal if nothing there has it.
    if (!modal.contains(document.activeElement)) (focusablesIn(modal)[0] ?? modal).focus({ preventScroll: true })

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusablesIn(modal)
      if (items.length === 0) { event.preventDefault(); return }
      const first = items[0]
      const last = items[items.length - 1]
      const current = document.activeElement
      if (!(current instanceof HTMLElement) || !modal.contains(current)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }
    // Capture, on the window: before the Folio room's or the editor's own key handlers can see the key.
    window.addEventListener('keydown', onKey, true)
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof Node && !modal.contains(event.target)) (focusablesIn(modal)[0] ?? modal).focus({ preventScroll: true })
    }
    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn, true)
      for (const element of marked) element.removeAttribute('inert')
      const active = document.activeElement
      const free = !active || active === document.body || modal.contains(active)
      if (free && opener && opener.isConnected) { opener.focus({ preventScroll: true }); handedOn = null } else handedOn = opener
    }
  }, [root])
}
