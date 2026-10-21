/**
 * The widget block's DOM and life (interactive-widgets-in-documents, ticket 03): the sealed frame
 * (widget-frame.ts) with the caption bar under it. Knows nothing of CodeMirror; the editor's widget
 * class (live-preview-widgets.ts) hosts `dom` and calls `dispose()`.
 *
 *   const block = createWidgetBlock({ documentPath, rawPath, source, returnFocus, onCaptionPress })
 *   block.dom        // stage (the frame) + caption bar; a ring and a hint while the widget is engaged
 *   block.reload()   // re-read the file and remount the frame
 *   block.dispose()
 *
 * A file that is missing or refused shows its source line as plain text (ticket 04 gives it notices).
 * A change to the file on disk (the window's file-change events, one subscription shared by every
 * block) reloads the block and shows "Reloaded" in the bar for two seconds.
 */
import { mountWidgetFrame, type WidgetFrame } from './widget-frame'
import { isStandardWidgetPath } from './standard-widget-model'

/** The window event a standard widget's Edit button sends; the app opens the widget's Source and preview tab. */
export const EDIT_STANDARD_WIDGET_EVENT = 'writeflex:edit-standard-widget'

/** The stage's height until the page reports its own. */
export const WIDGET_STAGE_HEIGHT = 'min(340px, 70vh)'
/** The block never grows past this share of the editor's visible height (locked drawing, state 09). */
export const WIDGET_HEIGHT_CAP = 0.7
// The last reported height of each widget, so a block that is unmounted and mounted again (scrolled far
// out of view) comes back at its height rather than jumping.
const lastHeights = new Map<string, number>()
/** The stage height for a reported content height, capped at 70% of the visible editor. */
export function widgetStageHeight(reported: number, visible: number): number {
  return Math.max(1, Math.min(Math.round(reported), Math.floor(visible * WIDGET_HEIGHT_CAP)))
}
export const RELOADED_MS = 2000

export type WidgetBlockOptions = {
  /** The document's workspace path, and the path exactly as typed in its embed line. */
  documentPath: string
  rawPath: string
  /** The embed line as typed: what a widget that cannot run shows. */
  source: string
  /** Put the keyboard back in the editor at its cursor. */
  returnFocus: () => void
  /** A press on the caption bar's own area: the editor puts its cursor on the block. */
  onCaptionPress?: () => void
}

export type WidgetBlock = {
  readonly dom: HTMLElement
  readonly engaged: boolean
  reload(): Promise<void>
  dispose(): void
}

type IconNode = Array<[string, Record<string, string>]>
// lucide-react geometry (app-window, rotate-cw, external-link, check), drawn without React.
const ICONS: Record<string, IconNode> = {
  appWindow: [['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }], ['path', { d: 'M10 4v4' }], ['path', { d: 'M2 8h20' }], ['path', { d: 'M6 4v4' }]],
  reload: [['path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
  external: [['path', { d: 'M15 3h6v6' }], ['path', { d: 'M10 14 21 3' }], ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  pencil: [['path', { d: 'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z' }], ['path', { d: 'm15 5 4 4' }]],
}
function icon(name: keyof typeof ICONS, size = 15): SVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  for (const [key, value] of Object.entries({ width: String(size), height: String(size), viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value)
  for (const [tag, attributes] of ICONS[name]) {
    const part = document.createElementNS(ns, tag)
    for (const [key, value] of Object.entries(attributes)) part.setAttribute(key, value)
    svg.appendChild(part)
  }
  return svg
}

function button(label: string, title: string, glyph: SVGElement, testid: string, onClick: () => void): HTMLButtonElement {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'wf-widget-button'
  el.title = title
  el.setAttribute('aria-label', label)
  el.dataset.testid = testid
  const text = document.createElement('span')
  text.textContent = label
  el.append(glyph, text)
  // The bar's buttons never take the editor's selection or focus with the press.
  el.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation() })
  el.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); onClick() })
  return el
}

/** `dir/` joined to a typed path, `.` and `..` folded; the form the file-change events use. */
export function widgetWorkspacePath(documentPath: string, rawPath: string): string {
  const parts = documentPath.split('/').slice(0, -1)
  for (const part of rawPath.trim().split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

const fileNameOf = (path: string): string => path.split('/').pop() || path

type Internal = { path: () => string[]; changed: () => void }
const live = new Set<Internal>()
let unsubscribe: (() => void) | null = null

function track(entry: Internal): () => void {
  live.add(entry)
  if (!unsubscribe && typeof window !== 'undefined' && window.writeflex?.onFileChangedOnDisk) {
    unsubscribe = window.writeflex.onFileChangedOnDisk((paths) => {
      const changed = new Set(paths.map((path) => path.replace(/\\/g, '/')))
      for (const item of [...live]) if (item.path().some((candidate) => changed.has(candidate))) item.changed()
    })
  }
  return () => {
    live.delete(entry)
    if (live.size === 0 && unsubscribe) { unsubscribe(); unsubscribe = null }
  }
}

export function createWidgetBlock(options: WidgetBlockOptions): WidgetBlock {
  const dom = document.createElement('div')
  dom.className = 'wf-widget-block'
  dom.dataset.widgetBlock = 'true'
  dom.dataset.widgetState = 'loading'

  const stage = document.createElement('div')
  stage.className = 'wf-widget-stage'
  stage.style.height = WIDGET_STAGE_HEIGHT
  const hint = document.createElement('span')
  hint.className = 'wf-widget-esc-hint'
  hint.textContent = 'Esc returns to the text'

  const bar = document.createElement('div')
  bar.className = 'wf-widget-bar'
  const nameEl = document.createElement('strong')
  nameEl.className = 'wf-widget-title'
  nameEl.textContent = fileNameOf(options.rawPath)
  const pathEl = document.createElement('span')
  pathEl.className = 'wf-widget-path'
  pathEl.textContent = options.rawPath
  const reloaded = document.createElement('span')
  reloaded.className = 'wf-widget-reloaded'
  reloaded.hidden = true
  const reloadedText = document.createElement('span')
  reloadedText.textContent = 'Reloaded'
  reloaded.append(icon('check', 13), reloadedText)
  const spacer = document.createElement('span')
  spacer.className = 'wf-widget-spacer'
  let relativePath = ''
  const reloadButton = button('Reload', 'Reload the widget from its file', icon('reload'), 'widget-reload', () => { void reload() })
  const openButton = button('Open file', 'Open the HTML file in your browser', icon('external'), 'widget-open-file', () => {
    void window.writeflex.openWidgetFile(options.documentPath, options.rawPath).catch(() => {})
  })
  bar.append(icon('appWindow'), nameEl, pathEl, reloaded, spacer, reloadButton)
  // A widget the record browser made (visualisations/<name>/widget.html) can be reopened in Source and preview.
  if (isStandardWidgetPath(options.rawPath)) {
    bar.append(button('Edit', 'Edit this record browser: its source file, fields and preview', icon('pencil'), 'widget-edit', () => {
      window.dispatchEvent(new CustomEvent(EDIT_STANDARD_WIDGET_EVENT, { detail: { documentPath: options.documentPath, rawPath: options.rawPath } }))
    }))
  }
  bar.append(openButton)
  bar.addEventListener('mousedown', () => options.onCaptionPress?.())
  // Short on room, the labels drop to icons (CSS `.is-narrow`); a size watch rather than a container query, which
  // changes how the editor lays the block out for arrow-key movement.
  // The bar's own width is not the room it has (its buttons hold it open), so the editor's width counts too.
  const NARROW_BAR = 430
  let watchedContent: Element | null = null
  let narrowFrame: number | null = null // measured a frame later: changing the bar inside the observer's callback loops it
  const measureNarrow = (): void => {
    const content = bar.closest('.cm-editor')
    if (content && content !== watchedContent) { watchedContent = content; narrowWatch?.observe(content) }
    const room = Math.min(bar.clientWidth || Infinity, content?.clientWidth || Infinity)
    bar.classList.toggle('is-narrow', Number.isFinite(room) && room > 0 && room < NARROW_BAR)
  }
  const narrowWatch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (narrowFrame === null) narrowFrame = requestAnimationFrame(() => { narrowFrame = null; if (!disposed) measureNarrow() }) })
  narrowWatch?.observe(bar)

  const failed = document.createElement('div')
  failed.className = 'wf-widget-source'
  failed.textContent = options.source

  dom.append(stage, hint, bar)

  const heightKey = `${options.documentPath}\u0000${options.rawPath}`
  let reportedHeight = lastHeights.get(heightKey) ?? 0
  const visibleHeight = (): number => dom.closest<HTMLElement>('.cm-scroller')?.clientHeight || window.innerHeight
  const applyHeight = (): void => {
    if (reportedHeight > 0) stage.style.height = `${widgetStageHeight(reportedHeight, visibleHeight())}px`
  }
  applyHeight()
  window.addEventListener('resize', applyHeight)

  let frame: WidgetFrame | null = null
  let disposed = false
  let generation = 0
  let reloadedTimer: ReturnType<typeof setTimeout> | null = null

  const unmount = (): void => {
    frame?.dispose()
    frame = null
    stage.replaceChildren()
    dom.classList.remove('is-engaged')
  }

  function showFailed(): void {
    unmount()
    dom.dataset.widgetState = 'failed'
    dom.replaceChildren(failed)
  }

  async function load(): Promise<boolean> {
    const mine = ++generation
    let result: Awaited<ReturnType<typeof window.writeflex.readWidget>>
    try { result = await window.writeflex.readWidget(options.documentPath, options.rawPath) } catch { result = { ok: false, reason: 'missing' } }
    if (disposed || mine !== generation) return false
    if (!result.ok) { showFailed(); return false }
    relativePath = result.relativePath
    if (dom.dataset.widgetState === 'failed') dom.replaceChildren(stage, hint, bar)
    unmount()
    nameEl.textContent = result.title || fileNameOf(options.rawPath)
    try {
      frame = mountWidgetFrame({
        container: stage,
        html: result.html,
        title: result.title || fileNameOf(options.rawPath),
        returnFocus: options.returnFocus,
        onEngagedChange: (engaged) => dom.classList.toggle('is-engaged', engaged),
        onHeight: (height) => { reportedHeight = height; lastHeights.set(heightKey, height); applyHeight() },
      })
    } catch { showFailed(); return false }
    dom.dataset.widgetState = 'running'
    return true
  }

  async function reload(): Promise<void> { await load() }

  function showReloaded(): void {
    reloaded.hidden = false
    if (reloadedTimer) clearTimeout(reloadedTimer)
    reloadedTimer = setTimeout(() => { reloaded.hidden = true; reloadedTimer = null }, RELOADED_MS)
  }

  const untrack = track({
    path: () => [widgetWorkspacePath(options.documentPath, options.rawPath), relativePath].filter(Boolean),
    changed: () => { void load().then((ok) => { if (ok && !disposed) showReloaded() }) },
  })
  void load()
  // A widget file in a folder the workspace watcher ignores gets a watch of its own while this block shows it.
  const watchable = typeof window.writeflex?.watchWidget === 'function'
  if (watchable) void window.writeflex.watchWidget(options.documentPath, options.rawPath).catch(() => {})

  return {
    dom,
    get engaged() { return frame?.engaged ?? false },
    reload,
    dispose() {
      if (disposed) return
      disposed = true
      untrack()
      narrowWatch?.disconnect()
      if (narrowFrame !== null) cancelAnimationFrame(narrowFrame)
      if (watchable) void window.writeflex.unwatchWidget(options.documentPath, options.rawPath).catch(() => {})
      window.removeEventListener('resize', applyHeight)
      if (reloadedTimer) clearTimeout(reloadedTimer)
      unmount()
    },
  }
}
