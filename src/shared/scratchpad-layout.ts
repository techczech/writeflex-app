// Where the floating Scratchpad sits: floating (a box the writer drags and resizes), docked as the right
// rail's Scratchpad tab, or collapsed to a pill. Pure: the renderer persists the JSON and clamps it to
// the window. Ported from TalkWeaver src/shared/scratchpad-layout.ts at 994e5981 (ADR-0050, inherited C1);
// WriteFlex keeps its header clear of the toolbar row (TOP_INSET).

export type ScratchMode = 'float' | 'docked' | 'collapsed'
export interface ScratchBox { x: number; y: number; w: number; h: number }
export interface ScratchLayout {
  mode: ScratchMode
  /** The mode the pill expands back to (float or docked). */
  restore: 'float' | 'docked'
  box: ScratchBox
  /** The person chose Float (the panel's Float button): only then may the expanded panel overlay the text (house rule R7). Layouts saved before the flag count a float as chosen; only a fresh default is false. */
  floated?: boolean
}

export const DOCK_WIDTH = 560
export const MIN_BOX = { w: 420, h: 320 } as const
/** The panel's header stays below the window's own title bar. */
export const TOP_INSET = 48

export function defaultLayout(viewport: { w: number; h: number }): ScratchLayout {
  const w = Math.min(700, Math.max(MIN_BOX.w, viewport.w - 80))
  const h = Math.min(800, Math.max(MIN_BOX.h, viewport.h - 140))
  return { mode: 'collapsed', restore: 'float', box: clampBox({ x: viewport.w - w - 30, y: 90, w, h }, viewport), floated: false }
}

/** Keeps the box inside the window: at least the minimum size, no larger than the window, header reachable. */
export function clampBox(box: ScratchBox, viewport: { w: number; h: number }): ScratchBox {
  const w = Math.round(Math.min(Math.max(box.w, MIN_BOX.w), Math.max(MIN_BOX.w, viewport.w)))
  const h = Math.round(Math.min(Math.max(box.h, MIN_BOX.h), Math.max(MIN_BOX.h, viewport.h - TOP_INSET)))
  const x = Math.round(Math.min(Math.max(box.x, 0), Math.max(0, viewport.w - w)))
  const y = Math.round(Math.min(Math.max(box.y, TOP_INSET), Math.max(TOP_INSET, viewport.h - 60)))
  return { x, y, w, h }
}

/** Reads what was stored; anything odd falls back to the default for this window. */
export function parseLayout(raw: string | null, viewport: { w: number; h: number }): ScratchLayout {
  const fallback = defaultLayout(viewport)
  if (!raw) return fallback
  try {
    const value = JSON.parse(raw) as Partial<ScratchLayout> | null
    if (!value || typeof value !== 'object') return fallback
    const mode: ScratchMode = value.mode === 'float' || value.mode === 'docked' || value.mode === 'collapsed' ? value.mode : fallback.mode
    const restore = value.restore === 'docked' ? 'docked' : 'float'
    const b = value.box
    const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
    const box = b && finite(b.x) && finite(b.y) && finite(b.w) && finite(b.h) ? clampBox(b, viewport) : fallback.box
    // An explicit flag is kept as saved. A layout saved before the flag existed (absent, not false) that floats, or comes back to
    // floating, was the person's choice then: it counts as an explicit float and is never docked for them (S1).
    const floated = typeof value.floated === 'boolean' ? value.floated : mode === 'float' || restore === 'float'
    return { mode, restore, box, floated }
  } catch { return fallback }
}

/** Collapse remembers where to come back to; expanding returns there. */
export function collapse(layout: ScratchLayout): ScratchLayout {
  return layout.mode === 'collapsed' ? layout : { ...layout, mode: 'collapsed', restore: layout.mode }
}
export function expand(layout: ScratchLayout): ScratchLayout {
  return layout.mode === 'collapsed' ? { ...layout, mode: layout.restore } : layout
}
/** The toolbar toggle: pill ⇄ the last open mode. */
export function toggle(layout: ScratchLayout): ScratchLayout {
  return layout.mode === 'collapsed' ? expand(layout) : collapse(layout)
}
export function dock(layout: ScratchLayout): ScratchLayout { return { ...layout, mode: 'docked', restore: 'docked', floated: false } }
/** The explicit Float choice: from here the panel may overlay the text where there is no room beside it. */
export function float(layout: ScratchLayout): ScratchLayout { return { ...layout, mode: 'float', restore: 'float', floated: true } }

/** House rule R3: the editor keeps at least this share of the window. A panel beside the text may not take it below. */
export const BESIDE_EDITOR_MIN_SHARE = 0.55
/** The widest the Scratchpad opens beside the text; wider boxes the writer has dragged are kept for floating over it. */
export const BESIDE_MAX_WIDTH = 520

export interface BesidePlace { left: number; top: number; width: number; height: number }

/**
 * Where the expanded Scratchpad sits BESIDE the text rather than over it (house rule R7: a float never covers text by
 * default), or null where the window is too narrow for that and it must overlay. `editor` is the editor column as it
 * would be with nothing reserved for the panel; the panel takes its right-hand end and the text keeps what is left, which
 * must stay at least 55% of the window (R3). Pure: the renderer measures and applies it.
 */
export function besideFit(input: { viewportWidth: number; editor: { left: number; right: number; top: number; bottom: number }; preferredWidth: number }): BesidePlace | null {
  const { viewportWidth, editor } = input
  if (!(viewportWidth > 0) || !(editor.right > editor.left) || !(editor.bottom > editor.top)) return null
  const width = Math.round(Math.max(MIN_BOX.w, Math.min(input.preferredWidth, BESIDE_MAX_WIDTH)))
  if ((editor.right - editor.left - width) / viewportWidth < BESIDE_EDITOR_MIN_SHARE) return null
  return { left: Math.round(editor.right - width), top: Math.round(editor.top), width, height: Math.round(editor.bottom - editor.top) }
}
