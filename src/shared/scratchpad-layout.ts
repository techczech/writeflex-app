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
}

export const DOCK_WIDTH = 560
export const MIN_BOX = { w: 420, h: 320 } as const
/** The panel's header stays below the window's own title bar. */
export const TOP_INSET = 48

export function defaultLayout(viewport: { w: number; h: number }): ScratchLayout {
  const w = Math.min(700, Math.max(MIN_BOX.w, viewport.w - 80))
  const h = Math.min(800, Math.max(MIN_BOX.h, viewport.h - 140))
  return { mode: 'collapsed', restore: 'float', box: clampBox({ x: viewport.w - w - 30, y: 90, w, h }, viewport) }
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
    return { mode, restore, box }
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
export function dock(layout: ScratchLayout): ScratchLayout { return { ...layout, mode: 'docked', restore: 'docked' } }
export function float(layout: ScratchLayout): ScratchLayout { return { ...layout, mode: 'float', restore: 'float' } }
