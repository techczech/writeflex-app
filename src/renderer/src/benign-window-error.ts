const BENIGN = 'ResizeObserver loop completed with undelivered notifications.'

/** The one browser notice that arrives as a window 'error' event but breaks nothing: a layout observer that could not deliver every notification in one frame. Matched exactly, not as a family. */
export function isBenignWindowError(message: unknown): boolean {
  return message === BENIGN
}
