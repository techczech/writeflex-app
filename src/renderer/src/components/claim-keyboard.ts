/**
 * Claim the keyboard for a panel that has just been raised, and keep claiming until it sticks.
 *
 * One `focus()` on mount is not enough inside the Reading Room: raising the Shelf or the Highlights view
 * over a live document competes with the reader, which takes focus back a frame or two later, and with the
 * settings write that opening the Room performs. A panel that does not hold the keyboard silently loses
 * "type to filter", which is its whole interaction — so this watches over a short bounded window and
 * re-claims whenever the keyboard has been taken away, rather than trusting one successful focus().
 *
 * Returns a teardown function for the effect that called it.
 */
export function claimKeyboard(
  target: () => HTMLInputElement | null,
  { attempts = 16, everyMs = 40 }: { attempts?: number; everyMs?: number } = {},
): () => void {
  let cancelled = false
  let remaining = attempts
  let timer: number | undefined
  let frame: number | undefined

  const held = (): boolean => {
    const element = target()
    return !!element && document.activeElement === element
  }

  // Deliberately does NOT stop at the first success. Raising a panel hides the document view in the same
  // commit, and hiding a subtree that holds focus resets the active element to the body AFTERWARDS — so a
  // claim that succeeded and then stopped loses the keyboard a frame later. Keep watching for the whole
  // window and re-claim whenever it has been taken away.
  const claim = (): void => {
    if (cancelled) return
    const element = target()
    if (element && !held()) {
      element.focus()
      element.select()
    }
    if ((remaining -= 1) <= 0) return
    timer = window.setTimeout(claim, everyMs)
  }

  claim()
  frame = window.requestAnimationFrame(claim)
  return () => {
    cancelled = true
    if (timer !== undefined) window.clearTimeout(timer)
    if (frame !== undefined) window.cancelAnimationFrame(frame)
  }
}
