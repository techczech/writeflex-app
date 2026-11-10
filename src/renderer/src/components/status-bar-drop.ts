// A status-bar chip that does not fit is dropped whole: the wrapper (.sb-cue-fit) clips it by wrapping it below a zero-width
// spacer. Clipping alone leaves it in the focus order, so Tab would reach an invisible chip and scroll the wrapper; a dropped
// chip is made inert (not focusable, not announced) here, from the same measurement the layout already makes.
export type DropWrapper = {
  querySelector: (selector: string) => { getBoundingClientRect: () => { top: number } } | null
  getBoundingClientRect: () => { top: number }
  inert: boolean
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

/** The wrapper's chip sits on a later line than the wrapper's own top: it did not fit. */
export function isChipDropped(wrapper: DropWrapper): boolean {
  const chip = wrapper.querySelector('.sb-cue')
  if (!chip) return false
  return chip.getBoundingClientRect().top - wrapper.getBoundingClientRect().top > 1
}

/** Marks every drop-whole wrapper under `bar` inert while its chip is dropped. Returns how many are dropped. */
export function syncDroppedChips(bar: { querySelectorAll: (selector: string) => Iterable<DropWrapper> }): number {
  let dropped = 0
  for (const wrapper of bar.querySelectorAll('.sb-cue-fit')) {
    const drop = isChipDropped(wrapper)
    wrapper.inert = drop
    if (drop) wrapper.setAttribute('aria-hidden', 'true'); else wrapper.removeAttribute('aria-hidden')
    if (drop) dropped += 1
  }
  return dropped
}

export type DropBar = { querySelectorAll: (selector: string) => Iterable<DropWrapper> }
/** Everything whose size can change a drop-whole chip's room: the bar's own slots and the chips' wrappers. The bar itself is observed by the caller. */
export const DROP_OBSERVED = ':scope > .sb-notice-slot, :scope > .sb-folio-slot, :scope > .sb-scratchpad-slot, :scope > .sb-cue-fit'
