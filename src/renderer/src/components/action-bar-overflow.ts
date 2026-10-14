/**
 * Whole-group overflow for the action bar (ADR-0040): in a narrow window groups never break across
 * the fold. What does not fit moves WHOLE into the trailing … menu, right to left; the … exists
 * only when something is actually inside it.
 *
 * The planner is pure arithmetic so it can be checked at any width without a window. Its inputs are
 * CUMULATIVE widths read from a hidden row laid out exactly like the live one — measuring positions
 * rather than element widths is what makes flex gaps and separator margins count themselves, and
 * measuring a hidden copy is what stops a group that has already folded away from measuring zero.
 */

export type OverflowInput = {
  /** Usable width of the bar's row, inside its padding. */
  available: number
  /** Width consumed by the first n groups WITH the separators between them, for n = 1…groups. */
  prefixWidths: readonly number[]
  /** What the … costs when it exists: its separator, its button, and the gaps around them. */
  overflowChunk: number
  /** What the always-present trailing controls cost. */
  tailChunk: number
}

/** How many leading groups stay on the bar; the rest go into the … menu, in bar order. */
export type OverflowPlan = { visible: number; overflowing: number }

/** Width needed to show the first `visible` groups, with the … reserved when some remain. */
export function widthNeeded(input: OverflowInput, visible: number): number {
  const prefix = visible === 0 ? 0 : (input.prefixWidths[visible - 1] ?? 0)
  const hidden = input.prefixWidths.length - visible
  return prefix + (hidden > 0 ? input.overflowChunk : 0) + input.tailChunk
}

/**
 * The most leading groups that fit. Falls to zero visible groups — at that width the bar is the …
 * and the configure control, which is still a working bar rather than a clipped row.
 */
export function planGroupOverflow(input: OverflowInput): OverflowPlan {
  const total = input.prefixWidths.length
  if (total === 0) return { visible: 0, overflowing: 0 }
  // Nothing has been measured yet (first paint): show everything rather than flashing an empty bar.
  if (input.available <= 0) return { visible: total, overflowing: 0 }
  for (let visible = total; visible > 0; visible -= 1) {
    if (widthNeeded(input, visible) <= input.available) return { visible, overflowing: total - visible }
  }
  return { visible: 0, overflowing: total }
}
