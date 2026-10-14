import { Compartment, Facet, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { readAloudPositionOf } from './read-aloud'
import { typewriterFollowExtension } from './typewriter-follow'

/**
 * Line focus and Ruler (docs/design/2026-10-07-ruler-and-line-focus): two reading aids drawn as an
 * overlay layer above the editor. They are NOT focus modes: they combine with every mode and with
 * read-aloud, never touch the document, its decorations, its layout or its selection, and never take
 * pointer events (pointer-events: none on the layer; the margin handle is React, outside it).
 *
 * Both work on VISUAL lines. Each measure reads the rects of a handful of rendered lines around the
 * focus line (in a requestMeasure cycle) and positions four absolutely placed rectangles. Nothing is
 * computed over the document, so a keystroke costs the same in a ten-line note and a book.
 */

// ---------------------------------------------------------------------------
// Settings, normalisers and labels
// ---------------------------------------------------------------------------

export type LineFollow = 'cursor' | 'typewriter' | 'read-aloud' | 'by-hand'
export type LineFocusSize = 1 | 3 | 5
export type LineFocusDim = 'light' | 'medium' | 'dark'
export type RulerCovers = 'thin' | '1' | '3' | '5' | 'below'

export type LineFocusConfig = { on: boolean; size: LineFocusSize; dim: LineFocusDim; follow: LineFollow }
export type RulerConfig = { on: boolean; covers: RulerCovers; opacity: number; follow: LineFollow }
export type LineOverlayConfig = { lineFocus: LineFocusConfig; ruler: RulerConfig }

export const LINE_OVERLAY_SETTINGS = {
  lineFocusOn: 'editor.lineFocus.on',
  lineFocusSize: 'editor.lineFocus.size',
  lineFocusDim: 'editor.lineFocus.dim',
  lineFocusFollow: 'editor.lineFocus.follow',
  rulerOn: 'editor.ruler.on',
  rulerCovers: 'editor.ruler.covers',
  rulerOpacity: 'editor.ruler.opacity',
  rulerFollow: 'editor.ruler.follow',
} as const

export const RULER_OPACITY_MIN = 10
export const RULER_OPACITY_MAX = 100
export const RULER_OPACITY_STEP = 5
export const RULER_OPACITY_DEFAULT = 35

export const LINE_FOLLOW_NAMES: Record<LineFollow, string> = { cursor: 'Cursor', typewriter: 'Typewriter', 'read-aloud': 'Read-aloud', 'by-hand': 'By hand' }
export const LINE_FOLLOWS: LineFollow[] = ['cursor', 'typewriter', 'read-aloud', 'by-hand']
export const LINE_FOCUS_SIZES: LineFocusSize[] = [1, 3, 5]
export const LINE_FOCUS_DIMS: LineFocusDim[] = ['light', 'medium', 'dark']
export const LINE_FOCUS_DIM_NAMES: Record<LineFocusDim, string> = { light: 'Light', medium: 'Medium', dark: 'Dark' }
export const RULER_COVERS: RulerCovers[] = ['thin', '1', '3', '5', 'below']
export const RULER_COVER_NAMES: Record<RulerCovers, string> = { thin: 'Thin rule', '1': '1 line', '3': '3 lines', '5': '5 lines', below: 'All below' }

export const DEFAULT_LINE_OVERLAY: LineOverlayConfig = {
  lineFocus: { on: false, size: 3, dim: 'medium', follow: 'cursor' },
  ruler: { on: false, covers: '3', opacity: RULER_OPACITY_DEFAULT, follow: 'cursor' },
}

export function normaliseLineFollow(value: unknown): LineFollow {
  return value === 'read-aloud' || value === 'by-hand' || value === 'typewriter' ? value : 'cursor'
}
export function normaliseLineFocusSize(value: unknown): LineFocusSize {
  const n = Number(value)
  return n === 1 || n === 5 ? n : 3
}
export function normaliseLineFocusDim(value: unknown): LineFocusDim {
  return value === 'light' || value === 'dark' ? value : 'medium'
}
export function normaliseRulerCovers(value: unknown): RulerCovers {
  const text = String(value)
  return text === 'thin' || text === '1' || text === '5' || text === 'below' ? text : '3'
}
/** Opacity percent, clamped to 10-100 and snapped to the slider's 5% grid. */
export function normaliseRulerOpacity(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(n)) return RULER_OPACITY_DEFAULT
  const snapped = Math.round(n / RULER_OPACITY_STEP) * RULER_OPACITY_STEP
  return Math.max(RULER_OPACITY_MIN, Math.min(RULER_OPACITY_MAX, snapped))
}

/**
 * Line focus and Ruler never run together (the user 7 October evening). When both are on, `prefer`
 * stays on and the other goes off; with no preference (persisted state, hydration in any key order)
 * Line focus wins.
 */
export function resolveExclusive(config: LineOverlayConfig, prefer: 'lineFocus' | 'ruler' = 'lineFocus'): LineOverlayConfig {
  if (!config.lineFocus.on || !config.ruler.on) return config
  return prefer === 'ruler'
    ? { ...config, lineFocus: { ...config.lineFocus, on: false } }
    : { ...config, ruler: { ...config.ruler, on: false } }
}

/** The whole persisted choice, read through a key lookup (the settings store or a test map). */
export function readLineOverlayConfig(get: (key: string) => unknown): LineOverlayConfig {
  return resolveExclusive({
    lineFocus: {
      on: get(LINE_OVERLAY_SETTINGS.lineFocusOn) === true,
      size: normaliseLineFocusSize(get(LINE_OVERLAY_SETTINGS.lineFocusSize)),
      dim: normaliseLineFocusDim(get(LINE_OVERLAY_SETTINGS.lineFocusDim)),
      follow: normaliseLineFollow(get(LINE_OVERLAY_SETTINGS.lineFocusFollow)),
    },
    ruler: {
      on: get(LINE_OVERLAY_SETTINGS.rulerOn) === true,
      covers: normaliseRulerCovers(get(LINE_OVERLAY_SETTINGS.rulerCovers)),
      opacity: normaliseRulerOpacity(get(LINE_OVERLAY_SETTINGS.rulerOpacity)),
      follow: normaliseLineFollow(get(LINE_OVERLAY_SETTINGS.rulerFollow)),
    },
  })
}

/** One persisted key applied to a config (null = the key reverted to unset → its default). Unknown keys return null. */
export function applyLineOverlaySetting(config: LineOverlayConfig, key: string, value: unknown): LineOverlayConfig | null {
  const v = value === null ? undefined : value
  const D = DEFAULT_LINE_OVERLAY
  switch (key) {
    case LINE_OVERLAY_SETTINGS.lineFocusOn: return { ...config, lineFocus: { ...config.lineFocus, on: v === true } }
    case LINE_OVERLAY_SETTINGS.lineFocusSize: return { ...config, lineFocus: { ...config.lineFocus, size: v === undefined ? D.lineFocus.size : normaliseLineFocusSize(v) } }
    case LINE_OVERLAY_SETTINGS.lineFocusDim: return { ...config, lineFocus: { ...config.lineFocus, dim: v === undefined ? D.lineFocus.dim : normaliseLineFocusDim(v) } }
    case LINE_OVERLAY_SETTINGS.lineFocusFollow: return { ...config, lineFocus: { ...config.lineFocus, follow: normaliseLineFollow(v) } }
    case LINE_OVERLAY_SETTINGS.rulerOn: return { ...config, ruler: { ...config.ruler, on: v === true } }
    case LINE_OVERLAY_SETTINGS.rulerCovers: return { ...config, ruler: { ...config.ruler, covers: v === undefined ? D.ruler.covers : normaliseRulerCovers(v) } }
    case LINE_OVERLAY_SETTINGS.rulerOpacity: return { ...config, ruler: { ...config.ruler, opacity: normaliseRulerOpacity(v) } }
    case LINE_OVERLAY_SETTINGS.rulerFollow: return { ...config, ruler: { ...config.ruler, follow: normaliseLineFollow(v) } }
    default: return null
  }
}

/** Status-bar chips: `Line focus · 3 lines`, `Ruler · 3 lines · 35%`. */
export function lineFocusChipLabel(config: LineFocusConfig): string {
  return `Line focus · ${config.size} ${config.size === 1 ? 'line' : 'lines'}${followChipSuffix(config.follow)}`
}
export function rulerChipLabel(config: RulerConfig): string {
  const covers = RULER_COVER_NAMES[config.covers].toLowerCase()
  const base = config.covers === 'thin' ? `Ruler · ${covers}` : `Ruler · ${covers} · ${config.opacity}%`
  return `${base}${followChipSuffix(config.follow)}`
}
/** Only the explicit choices that change how the band moves are named in the chip. */
function followChipSuffix(follow: LineFollow): string {
  return follow === 'by-hand' ? ' · by hand' : follow === 'typewriter' ? ' · typewriter' : ''
}

/** True while an overlay that is on follows the typewriter line: the text must scroll to it. */
export function wantsTypewriterFollow(config: LineOverlayConfig): boolean {
  return (config.lineFocus.on && config.lineFocus.follow === 'typewriter') || (config.ruler.on && config.ruler.follow === 'typewriter')
}

// ---------------------------------------------------------------------------
// Pure geometry (unit-tested in tests/main/line-overlay.test.ts)
// ---------------------------------------------------------------------------

/** A vertical extent in pixels, relative to the top of the scroller's visible area. */
export type LineRect = { top: number; bottom: number }

/**
 * Close the gaps between consecutive visual lines (leading, paragraph spacing) so a band or a ruler
 * edge falls halfway between two lines rather than on a glyph box. The outer ends grow by half the
 * neighbouring gap. `lines` run top to bottom.
 */
export function tileLines(lines: readonly LineRect[]): LineRect[] {
  const tiled = lines.map((line) => ({ ...line }))
  for (let i = 0; i < lines.length - 1; i++) {
    const middle = (lines[i].bottom + lines[i + 1].top) / 2
    tiled[i].bottom = middle
    tiled[i + 1].top = middle
  }
  if (lines.length > 1) {
    tiled[0].top -= Math.max(0, (lines[1].top - lines[0].bottom) / 2)
    tiled[lines.length - 1].bottom += Math.max(0, (lines[lines.length - 1].top - lines[lines.length - 2].bottom) / 2)
  }
  return tiled
}

/** Clamp to the visible area [0, height]; null when nothing of the rect is visible. */
export function clampRect(rect: LineRect, height: number): LineRect | null {
  const top = Math.max(0, rect.top)
  const bottom = Math.min(height, rect.bottom)
  return bottom > top ? { top, bottom } : null
}

/**
 * The Line focus band: `size` visual lines centred on line `focus` (1 line = the focus line, 3 = one
 * each side, 5 = two each side). Near the ends of the list it keeps what exists.
 */
export function bandRect(lines: readonly LineRect[], focus: number, size: LineFocusSize, height: number): LineRect | null {
  if (focus < 0 || focus >= lines.length) return null
  const tiled = tileLines(lines)
  const reach = (size - 1) / 2
  const first = Math.max(0, focus - reach)
  const last = Math.min(lines.length - 1, focus + reach)
  return clampRect({ top: tiled[first].top, bottom: tiled[last].bottom }, height)
}

/** The two dimmed areas: everything above the band and everything below it, within the viewport. */
export function dimRects(band: LineRect | null, height: number): { above: LineRect | null; below: LineRect | null } {
  if (!band) return { above: null, below: null }
  return { above: clampRect({ top: 0, bottom: band.top }, height), below: clampRect({ top: band.bottom, bottom: height }, height) }
}

export type RulerShape = { kind: 'rule' | 'bar'; top: number; bottom: number }

/**
 * The Ruler directly under line `focus`. A thin rule sits on the line's lower edge and covers
 * nothing. 1/3/5 cover that many visual lines below; "all below" covers everything to the bottom of
 * the viewport. The focus line and everything above stay uncovered.
 */
export function rulerShape(lines: readonly LineRect[], focus: number, covers: RulerCovers, height: number): RulerShape | null {
  if (focus < 0 || focus >= lines.length) return null
  const tiled = tileLines(lines)
  const edge = tiled[focus].bottom
  if (covers === 'thin') {
    const rule = clampRect({ top: edge - 1, bottom: edge + 1 }, height)
    return rule && { kind: 'rule', ...rule }
  }
  let bottom: number
  if (covers === 'below') bottom = height
  else {
    const last = Math.min(lines.length - 1, focus + Number(covers))
    if (last <= focus) return null
    bottom = tiled[last].bottom
  }
  const bar = clampRect({ top: edge, bottom }, height)
  return bar && { kind: 'bar', ...bar }
}

/**
 * Where the margin handle sits for a Ruler: ON the ruler, never on the focus line above it. A thin
 * rule: the rule. A covering ruler: the centre of its first covered line. With nothing below the
 * focus line it sits on the line's lower edge. Clamped to the viewport.
 */
export function rulerHandleY(lines: readonly LineRect[], focus: number, covers: RulerCovers, height: number): number | null {
  if (focus < 0 || focus >= lines.length) return null
  const tiled = tileLines(lines)
  let y: number
  if (covers === 'thin' || focus + 1 >= lines.length) y = tiled[focus].bottom
  else y = (tiled[focus + 1].top + tiled[focus + 1].bottom) / 2
  return Math.max(0, Math.min(height, y))
}

/** How many lines each overlay needs on each side of the focus line, for the line collector. */
export function linesNeeded(config: LineOverlayConfig): { above: number; below: number } {
  let above = 0
  let below = 0
  if (config.lineFocus.on) {
    above = Math.max(above, (config.lineFocus.size - 1) / 2)
    below = Math.max(below, (config.lineFocus.size - 1) / 2)
  }
  if (config.ruler.on && config.ruler.covers !== 'thin' && config.ruler.covers !== 'below') below = Math.max(below, Number(config.ruler.covers))
  return { above, below }
}

// ---------------------------------------------------------------------------
// Follow-source state machine (pure)
// ---------------------------------------------------------------------------

/** What By hand remembers between measures: where the mouse pointer last was over the text. */
export type FollowState = { pointerY: number | null }
export const INITIAL_FOLLOW: FollowState = { pointerY: null }

export type FollowEvent =
  /** The pointer moved over the text (y relative to the scroller top). Only By hand listens. */
  | { type: 'pointer'; y: number; byHand: boolean }
  /** The margin handle moved or nudged, or the fixed line changed: that position wins over the pointer. */
  | { type: 'handle' }
  /** A follow pill changed: start from the stored position again. */
  | { type: 'follow-changed' }

export function reduceFollow(state: FollowState, event: FollowEvent): FollowState {
  switch (event.type) {
    case 'pointer':
      return event.byHand ? { pointerY: event.y } : state
    case 'handle':
    case 'follow-changed':
      return state.pointerY === null ? state : { pointerY: null }
  }
}

export type AnchorInput = {
  follow: LineFollow
  /** The caret's document position. */
  head: number
  /** The spoken source position, or null when nothing is being read. */
  spoken: number | null
  state: FollowState
  /** The stored by-hand height, a fraction of the visible height (the fixed line). */
  fixedLine: number
  height: number
  /**
   * The margin handle is being dragged and the line is not by-hand: the handle's focus-line height as a
   * fraction of the visible height. The aid tracks it through the by-hand path (a height) while the caret
   * stays put; null when no drag is running.
   */
  drag?: number | null
}
/**
 * By hand remembers WHICH line it chose, not just a height. A stored height that falls on (or within
 * a pixel of) the halfway point between two lines would otherwise resolve to either neighbour on the
 * next measure (a scrollbar, a font load, scroll-past-end room), and the band would jump a line.
 * The lock holds the document position inside the chosen line and the height it was chosen for.
 */
export type HandLock = { sourceY: number; pos: number; side: -1 | 1 }

/**
 * The height to resolve this measure with: the centre of the locked line while the source height is
 * unchanged and the line is still measurable, else the source height itself (a new pointer position
 * or a moved handle chooses afresh). `centreOf` returns the line's centre, or null when unmeasurable.
 */
export function handY(lock: HandLock | null, sourceY: number, centreOf: (lock: HandLock) => number | null): number {
  if (lock && lock.sourceY === sourceY) {
    const centre = centreOf(lock)
    if (centre !== null) return centre
  }
  return sourceY
}

/** Index of the line holding `y` (top inclusive); in a gap, the nearest, ties going to the upper line. */
export function pickLine(lines: readonly LineRect[], y: number): number {
  const inside = lines.findIndex((line) => y >= line.top && y < line.bottom)
  if (inside >= 0) return inside
  let best = -1
  let bestDistance = Infinity
  lines.forEach((line, i) => {
    const distance = y < line.top ? line.top - y : y - line.bottom
    if (distance < bestDistance) { bestDistance = distance; best = i }
  })
  return best
}

/** `lock: false` = a plain height every measure (Typewriter): the band never re-attaches to a line. */
export type Anchor = { kind: 'pos'; pos: number } | { kind: 'y'; y: number; lock?: false }

/** Typewriter follow probes this far below the fixed line's top edge, so the line placed there is the one picked. */
export const TYPEWRITER_PROBE_PX = 2

/** Where the focus line comes from: a document position (cursor, read-aloud) or a height (by hand). */
export function resolveAnchor(input: AnchorInput): Anchor {
  // Dragging the handle under Follow = Cursor: same positioning as By hand, the caret waits for the drop.
  if (input.follow === 'cursor' && input.drag != null) return { kind: 'y', y: input.drag * input.height }
  switch (input.follow) {
    case 'cursor':
      return { kind: 'pos', pos: input.head }
    case 'typewriter':
      // The band sits on the fixed line; the text is scrolled to it (typewriter-follow.ts), never the reverse.
      return { kind: 'y', y: input.fixedLine * input.height + TYPEWRITER_PROBE_PX, lock: false }
    case 'read-aloud':
      // Nothing is being read: the aid stays useful by following the caret rather than vanishing.
      return input.spoken === null ? { kind: 'pos', pos: input.head } : { kind: 'pos', pos: input.spoken }
    case 'by-hand':
      return { kind: 'y', y: input.state.pointerY ?? input.fixedLine * input.height }
  }
}

// ---------------------------------------------------------------------------
// The overlay layer (CodeMirror)
// ---------------------------------------------------------------------------

export type LineOverlayHandle = {
  /** Centre of the band's focus line, a fraction of the visible height; null while hidden. */
  focusFraction: number | null
  /** Where the margin handle belongs: the band's focus line for Line focus, ON the ruler for Ruler. */
  handleFraction: number | null
  /** One visual line as a fraction of the visible height (the handle's ↑/↓ step). */
  lineFraction: number
}

type FacetValue = {
  config: LineOverlayConfig
  /** By-hand resting height (the fixed line). */
  fixedLine: number
  /** A live handle drag under Follow = Cursor (fraction of the visible height), else null. */
  drag: number | null
  report?: (handle: LineOverlayHandle) => void
}

const overlayFacet = Facet.define<FacetValue, FacetValue>({
  combine: (values) => values[0] ?? { config: DEFAULT_LINE_OVERLAY, fixedLine: 0.33, drag: null },
})

/** Test seam: what a measure inspected. A keystroke must not scale with the document. */
export const lineOverlayStats = { measures: 0, elementsInspected: 0, docScans: 0 }

function overlayActive(config: LineOverlayConfig): boolean {
  return config.lineFocus.on || config.ruler.on
}

/** Merge client rects that share a text line into one box per visual line. */
function visualRects(el: HTMLElement): Array<{ top: number; bottom: number }> {
  const range = document.createRange()
  range.selectNodeContents(el)
  const boxes = Array.from(range.getClientRects())
    .filter((rect) => rect.height > 0)
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom)
  const lines: Array<{ top: number; bottom: number }> = []
  for (const rect of boxes) {
    const last = lines[lines.length - 1]
    const centre = (rect.top + rect.bottom) / 2
    if (last && centre < last.bottom && centre > last.top) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
    } else lines.push({ top: rect.top, bottom: rect.bottom })
  }
  return lines
}

function isBlankLine(el: Element): boolean {
  return !el.classList.contains('cm-line') || (el.textContent ?? '').trim() === ''
}

/** Visual lines of `el`, or its own box when it has no text (a blank line the caret is on). */
function linesOf(el: HTMLElement, includeBlank: boolean): Array<{ top: number; bottom: number }> {
  lineOverlayStats.elementsInspected++
  if (isBlankLine(el)) {
    if (!includeBlank) return []
    const box = el.getBoundingClientRect()
    return box.height > 0 ? [{ top: box.top, bottom: box.bottom }] : []
  }
  return visualRects(el)
}

/**
 * The visual lines around `y` (client coordinates) inside `el`, with the index of the one holding
 * `y`. Walks sibling `.cm-line`s only until `above` and `below` extra lines exist; each side also
 * gets one more line so the tiling of the used lines has both neighbours.
 */
export function collectLines(el: HTMLElement, y: number, above: number, below: number): { lines: Array<{ top: number; bottom: number }>; focus: number } | null {
  const own = linesOf(el, true)
  if (own.length === 0) return null
  const focus = pickLine(own, y)
  const up: Array<{ top: number; bottom: number }> = own.slice(0, focus).reverse()
  const down: Array<{ top: number; bottom: number }> = own.slice(focus + 1)
  for (let sibling = el.previousElementSibling as HTMLElement | null; sibling && up.length < above + 1; sibling = sibling.previousElementSibling as HTMLElement | null) {
    if (!sibling.classList.contains('cm-line')) continue
    up.push(...linesOf(sibling, false).reverse())
  }
  for (let sibling = el.nextElementSibling as HTMLElement | null; sibling && down.length < below + 1; sibling = sibling.nextElementSibling as HTMLElement | null) {
    if (!sibling.classList.contains('cm-line')) continue
    down.push(...linesOf(sibling, false))
  }
  const lines = [...up.slice(0, above + 1).reverse(), own[focus], ...down.slice(0, below + 1)]
  return { lines, focus: Math.min(above + 1, up.length) }
}

type Layer = {
  root: HTMLElement
  dimAbove: HTMLElement
  dimBelow: HTMLElement
  band: HTMLElement
  ruler: HTMLElement
}

function makeLayer(): Layer {
  const root = document.createElement('div')
  root.className = 'wf-line-overlay'
  root.setAttribute('aria-hidden', 'true')
  const mk = (className: string, testid: string): HTMLElement => {
    const el = document.createElement('div')
    el.className = className
    el.dataset.testid = testid
    el.style.display = 'none'
    root.appendChild(el)
    return el
  }
  return {
    root,
    dimAbove: mk('wf-lo-dim wf-lo-dim-above', 'line-focus-dim-above'),
    dimBelow: mk('wf-lo-dim wf-lo-dim-below', 'line-focus-dim-below'),
    band: mk('wf-lo-band', 'line-focus-band'),
    ruler: mk('wf-lo-ruler', 'ruler'),
  }
}

function place(el: HTMLElement, rect: { top: number; bottom: number } | null): void {
  if (!rect) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'block'
  el.style.top = `${rect.top}px`
  el.style.height = `${rect.bottom - rect.top}px`
}

type Measured = {
  left: number
  top: number
  width: number
  height: number
  focusLineHeight: number
  focusCentre: number | null
  handleCentre: number | null
  band: LineRect | null
  above: LineRect | null
  below: LineRect | null
  ruler: RulerShape | null
}

class LineOverlayPlugin {
  private readonly layer = makeLayer()
  private follow: FollowState = INITIAL_FOLLOW
  private config: LineOverlayConfig = DEFAULT_LINE_OVERLAY
  private fixedLine = -1
  private lastReport = ''
  /** By hand: the line each overlay chose, keyed by overlay. */
  private readonly locks = new Map<string, HandLock>()
  private readonly onPointer = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return
    const value = this.view.state.facet(overlayFacet)
    const { lineFocus, ruler } = value.config
    const byHand = (lineFocus.on && lineFocus.follow === 'by-hand') || (ruler.on && ruler.follow === 'by-hand')
    if (!byHand) return
    // Only over the text: the scrollbar and margins are not the page.
    const content = this.view.contentDOM.getBoundingClientRect()
    if (event.clientX < content.left || event.clientX > content.right) return
    this.follow = reduceFollow(this.follow, { type: 'pointer', y: event.clientY - this.view.scrollDOM.getBoundingClientRect().top, byHand })
    this.schedule()
  }
  private readonly onScroll = (): void => this.schedule()

  constructor(private readonly view: EditorView) {
    view.dom.appendChild(this.layer.root)
    view.scrollDOM.addEventListener('pointermove', this.onPointer, { passive: true })
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
    this.sync(view.state)
    this.schedule()
  }

  update(update: ViewUpdate): void {
    const value = update.state.facet(overlayFacet)
    const changed = update.startState.facet(overlayFacet) !== value
    if (update.docChanged) for (const lock of this.locks.values()) lock.pos = update.changes.mapPos(lock.pos)
    if (changed) this.sync(update.state)
    if (changed || update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.heightChanged
      || readAloudPositionOf(update.startState) !== readAloudPositionOf(update.state)) {
      this.schedule()
    }
  }

  destroy(): void {
    this.view.scrollDOM.removeEventListener('pointermove', this.onPointer)
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
    this.layer.root.remove()
  }

  /** A new config or fixed line: the handle and the follow pills outrank a remembered pointer position. */
  private sync(state: EditorState): void {
    const value = state.facet(overlayFacet)
    if (value.fixedLine !== this.fixedLine) this.follow = reduceFollow(this.follow, { type: 'handle' })
    if (value.config.lineFocus.follow !== this.config.lineFocus.follow || value.config.ruler.follow !== this.config.ruler.follow) {
      this.follow = reduceFollow(this.follow, { type: 'follow-changed' })
    }
    this.fixedLine = value.fixedLine
    this.config = value.config
    const { lineFocus, ruler } = value.config
    const root = this.layer.root
    root.dataset.lineFocus = lineFocus.on ? `${lineFocus.size}` : ''
    root.dataset.ruler = ruler.on ? ruler.covers : ''
    root.style.setProperty('--lo-ruler-opacity', String(ruler.opacity / 100))
    root.dataset.dim = lineFocus.dim
  }

  private schedule(): void {
    this.view.requestMeasure<Measured | null>({
      key: this,
      read: (view) => this.measure(view),
      write: (measured, view) => this.apply(measured, view),
    })
  }

  private anchorLine(view: EditorView, slot: string, follow: LineFollow, height: number, scrollerTop: number, need: { above: number; below: number }) {
    const anchor = resolveAnchor({
      follow,
      head: view.state.selection.main.head,
      spoken: readAloudPositionOf(view.state),
      state: this.follow,
      fixedLine: this.fixedLine,
      height,
      drag: view.state.facet(overlayFacet).drag,
    })
    let el: HTMLElement | null = null
    let y: number
    if (anchor.kind === 'pos') {
      const coords = view.coordsAtPos(anchor.pos, view.state.selection.main.assoc >= 0 ? 1 : -1) ?? view.coordsAtPos(anchor.pos)
      if (!coords) return null
      y = (coords.top + coords.bottom) / 2
      const found = view.domAtPos(anchor.pos).node
      const node = found.nodeType === 1 ? (found as Element) : found.parentElement
      el = node?.closest<HTMLElement>('.cm-line') ?? null
    } else {
      y = scrollerTop + (anchor.lock === false ? anchor.y : handY(this.locks.get(slot) ?? null, anchor.y, (lock) => {
        if (lock.pos > view.state.doc.length) return null
        const coords = view.coordsAtPos(lock.pos, lock.side)
        return coords ? (coords.top + coords.bottom) / 2 - scrollerTop : null
      }))
      const content = view.contentDOM.getBoundingClientRect()
      const pos = view.posAtCoords({ x: content.left + content.width / 2, y }, false)
      const found = view.domAtPos(pos).node
      const node = found.nodeType === 1 ? (found as Element) : found.parentElement
      el = node?.closest<HTMLElement>('.cm-line') ?? null
    }
    if (!el) return null
    const collected = collectLines(el, y, need.above, need.below)
    if (!collected) return null
    const lines = collected.lines.map((line) => ({ top: line.top - scrollerTop, bottom: line.bottom - scrollerTop }))
    if (anchor.kind === 'y') {
      const lock = this.locks.get(slot)
      if (anchor.lock === false) this.locks.delete(slot)
      else if (!lock || lock.sourceY !== anchor.y) this.lockLine(view, slot, anchor.y, collected.lines[collected.focus])
    } else this.locks.delete(slot)
    return { lines, focus: collected.focus }
  }

  /** Remember the line chosen for this source height, by a position inside it. */
  private lockLine(view: EditorView, slot: string, sourceY: number, line: { top: number; bottom: number }): void {
    const content = view.contentDOM.getBoundingClientRect()
    const centre = (line.top + line.bottom) / 2
    const pos = view.posAtCoords({ x: content.left + content.width / 2, y: centre }, false)
    const inLine = (side: -1 | 1): boolean => {
      const coords = view.coordsAtPos(pos, side)
      if (!coords) return false
      const c = (coords.top + coords.bottom) / 2
      return c >= line.top && c < line.bottom
    }
    const side: -1 | 1 | null = inLine(1) ? 1 : inLine(-1) ? -1 : null
    if (side === null) this.locks.delete(slot)
    else this.locks.set(slot, { sourceY, pos, side })
  }

  private measure(view: EditorView): Measured | null {
    lineOverlayStats.measures++
    const { config } = view.state.facet(overlayFacet)
    if (!overlayActive(config)) return null
    const scroller = view.scrollDOM.getBoundingClientRect()
    const frame = view.dom.getBoundingClientRect()
    const height = view.scrollDOM.clientHeight
    const need = linesNeeded(config)
    const out: Measured = {
      left: scroller.left - frame.left,
      top: scroller.top - frame.top,
      width: view.scrollDOM.clientWidth,
      height,
      focusLineHeight: 0,
      focusCentre: null,
      handleCentre: null,
      band: null,
      above: null,
      below: null,
      ruler: null,
    }
    let focusSet = false
    if (config.lineFocus.on) {
      const found = this.anchorLine(view, 'lineFocus', config.lineFocus.follow, height, scroller.top, { above: need.above, below: need.below })
      if (found) {
        out.band = bandRect(found.lines, found.focus, config.lineFocus.size, height)
        const dims = dimRects(out.band, height)
        out.above = dims.above
        out.below = dims.below
        const tiled = tileLines(found.lines)[found.focus]
        out.focusCentre = (tiled.top + tiled.bottom) / 2
        out.focusLineHeight = tiled.bottom - tiled.top
        out.handleCentre = out.focusCentre
        focusSet = true
      }
    }
    if (config.ruler.on) {
      const found = this.anchorLine(view, 'ruler', config.ruler.follow, height, scroller.top, { above: 0, below: need.below })
      if (found) {
        out.ruler = rulerShape(found.lines, found.focus, config.ruler.covers, height)
        out.handleCentre = rulerHandleY(found.lines, found.focus, config.ruler.covers, height)
        if (!focusSet) {
          const tiled = tileLines(found.lines)[found.focus]
          out.focusCentre = (tiled.top + tiled.bottom) / 2
          out.focusLineHeight = tiled.bottom - tiled.top
        }
      }
    }
    return out
  }

  private apply(measured: Measured | null, view: EditorView): void {
    const layer = this.layer
    if (!measured) {
      place(layer.dimAbove, null)
      place(layer.dimBelow, null)
      place(layer.band, null)
      place(layer.ruler, null)
      this.report(view, null, null, 0, 0)
      return
    }
    const style = layer.root.style
    style.left = `${measured.left}px`
    style.top = `${measured.top}px`
    style.width = `${measured.width}px`
    style.height = `${measured.height}px`
    place(layer.dimAbove, measured.above)
    place(layer.dimBelow, measured.below)
    place(layer.band, measured.band)
    layer.ruler.className = `wf-lo-ruler ${measured.ruler?.kind === 'rule' ? 'is-rule' : 'is-bar'}`
    place(layer.ruler, measured.ruler)
    this.report(view, measured.focusCentre, measured.handleCentre, measured.focusLineHeight, measured.height)
  }

  private report(view: EditorView, centre: number | null, handle: number | null, lineHeight: number, height: number): void {
    const report = view.state.facet(overlayFacet).report
    if (!report) return
    const focusFraction = centre === null || height <= 0 ? null : Math.round((centre / height) * 1000) / 1000
    const lineFraction = height > 0 ? Math.round((lineHeight / height) * 1000) / 1000 : 0
    const handleFraction = handle === null || height <= 0 ? null : Math.round((handle / height) * 1000) / 1000
    const key = `${focusFraction}|${handleFraction}|${lineFraction}`
    if (key === this.lastReport) return
    this.lastReport = key
    report({ focusFraction, handleFraction, lineFraction })
  }
}

const overlayPlugin = ViewPlugin.fromClass(LineOverlayPlugin)

/** Empty by default (setup.ts); setLineOverlay reconfigures it in place, the focus-mode pattern. */
export const lineOverlayCompartment = new Compartment()

export function lineOverlayExtension(requested: LineOverlayConfig, fixedLine: number, report?: (handle: LineOverlayHandle) => void, drag: number | null = null): Extension {
  const config = resolveExclusive(requested)
  if (!overlayActive(config)) return []
  return [overlayFacet.of({ config, fixedLine, drag, report }), overlayPlugin, wantsTypewriterFollow(config) ? typewriterFollowExtension() : []]
}

export function setLineOverlay(view: EditorView, config: LineOverlayConfig, fixedLine: number, report?: (handle: LineOverlayHandle) => void, drag: number | null = null): void {
  view.dispatch({ effects: lineOverlayCompartment.reconfigure(lineOverlayExtension(config, fixedLine, report, drag)) })
}

export function lineOverlayActive(config: LineOverlayConfig): boolean {
  return overlayActive(config)
}
