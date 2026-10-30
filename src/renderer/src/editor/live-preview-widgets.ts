import { layoutOf } from '../../../shared/markdown/frontmatter-edit'
import { metadataRows } from '../../../shared/document-metadata'
import { mountFrontmatterEditor } from './object-editors/frontmatter-editor'
import { metadataWorkspace } from './metadata-view-state'
import { WidgetType, type EditorView } from '@codemirror/view'
import { LanguageDescription, type Language } from '@codemirror/language'
import { classHighlighter, highlightCode } from '@lezer/highlight'
import { languages } from '@codemirror/language-data'
import type { QueryResult, QueryRow } from '../../../preload'
import { QUERY_SORTABLE_FIELDS, compactQuerySummary, formatQueryDate, queryStatusBadgeClass, rewriteQuerySortLine, type QuerySortableField } from './query-object'
import { sanitiseSvg } from '../../../shared/sanitise-svg'
import { sameMetadataProposals } from './metadata-proposals'
import type { MetadataProposal } from '../app/metadata-proposal'

// The full language-data registry (Codex's sandbox couldn't install it; the coordinator swapped the
// three-language stopgap for the real thing). Every description lazy-loads its parser on first use.
export const sourceCodeLanguages = languages

async function languageFor(name: string): Promise<Language | null> {
  const description = LanguageDescription.matchLanguageName(sourceCodeLanguages, name, true)
  return description ? (await description.load()).language : null
}

async function highlightInto(code: HTMLElement, source: string, language: string): Promise<void> {
  const lang = await languageFor(language).catch(() => null)
  if (!lang || !code.isConnected) return
  code.textContent = ''
  highlightCode(
    source,
    lang.parser.parse(source),
    classHighlighter,
    (text, classes) => {
      if (!classes) code.appendChild(document.createTextNode(text))
      else { const span = document.createElement('span'); span.className = classes; span.textContent = text; code.appendChild(span) }
    },
    () => code.appendChild(document.createTextNode('\n')),
  )
}

export type ParsedTable = { header: string[]; rows: string[][] }

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'))
}

export function parseGfmTable(source: string): ParsedTable | null {
  const lines = source.trimEnd().split('\n')
  if (lines.length < 2 || !lines[0].includes('|')) return null
  const header = cells(lines[0])
  const separator = cells(lines[1])
  if (header.length === 0 || separator.length !== header.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) return null
  const rows = lines.slice(2).map(cells)
  if (rows.some((row) => row.length !== header.length)) return null
  return { header, rows }
}

// Async widgets (mermaid/markmap) remember their rendered height per source, so re-renders reserve
// the space instantly instead of collapsing to a placeholder and jumping the page around the caret
// (C4 review find: the jump moved a table out from under a double-click mid-flight).
const asyncHeights = new Map<string, number>()
function reserveHeight(shell: HTMLElement, source: string): void {
  shell.style.minHeight = `${asyncHeights.get(source) ?? 120}px`
}
function recordHeight(shell: HTMLElement, source: string): void {
  shell.style.minHeight = ''
  const height = shell.offsetHeight
  if (height > 0) asyncHeights.set(source, height)
}

/**
 * Run `render` once `el` has a resolvable non-zero width — immediately if it already does, else on the
 * first ResizeObserver tick that gives it width (then stop observing). markmap's fit() reads the SVG's
 * `100%` width through d3-zoom's defaultExtent (SVGLength), which THROWS "Could not resolve relative
 * length" when the block is not laid out (a background tab, a collapsed pane, a pre-layout measure).
 * That throw runs on a d3-timer tick, so it escapes the caller's try/catch — the only safe fix is to
 * not render into an unsized block. Returns a disposer so callers can stop observing if torn down.
 */
function whenSized(el: HTMLElement, render: () => void): () => void {
  if (el.clientWidth > 0) { render(); return () => {} }
  const observer = new ResizeObserver(() => {
    if (el.clientWidth > 0) { observer.disconnect(); render() }
  })
  observer.observe(el)
  return () => observer.disconnect()
}

function hint(): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = 'lp-enter-hint'
  el.textContent = '↵ edit'
  return el
}

abstract class LivePreviewWidget extends WidgetType {
  // `selected` rides on the WIDGET (outline + hint via class), never as a line decoration — a line
  // decoration inside a block-replaced range crashes CM's tile walker (C1 review find, 2026-07-11).
  constructor(readonly source: string, readonly selected: boolean) { super() }
  protected shell(kind: string): HTMLDivElement {
    const shell = document.createElement('div')
    shell.className = `lp-block lp-${kind}${this.selected ? ' lp-selected' : ''}`
    shell.dataset.livePreviewBlock = kind
    shell.appendChild(hint())
    return shell
  }
  ignoreEvent(event: Event): boolean { return event.type !== 'mousedown' && event.type !== 'dblclick' }
}

export class ImageWidget extends LivePreviewWidget {
  constructor(source: string, readonly url: string, readonly alt: string, selected: boolean) { super(source, selected) }
  eq(other: WidgetType): boolean { return other instanceof ImageWidget && other.source === this.source && other.url === this.url && other.selected === this.selected }
  toDOM(): HTMLElement {
    const shell = this.shell('image')
    const image = document.createElement('img')
    image.src = this.url
    image.alt = this.alt
    image.loading = 'lazy'
    image.addEventListener('error', () => {
      shell.classList.add('lp-render-failed')
      shell.replaceChildren(hint(), document.createTextNode(this.source))
    })
    shell.appendChild(image)
    return shell
  }
}

export class TableWidget extends LivePreviewWidget {
  constructor(source: string, selected: boolean) { super(source, selected) }
  eq(other: WidgetType): boolean { return other instanceof TableWidget && other.source === this.source && other.selected === this.selected }
  toDOM(): HTMLElement {
    const shell = this.shell('table')
    const parsed = parseGfmTable(this.source)
    if (!parsed) { shell.classList.add('lp-render-failed'); shell.textContent = this.source; return shell }
    const table = document.createElement('table')
    table.className = 'gfm-style'
    const thead = table.createTHead().insertRow()
    const fill = (cell: HTMLElement, value: string): void => { value.split(/<br\s*\/?>|\n/gi).forEach((part, index) => { if (index) cell.append(document.createElement('br')); cell.append(document.createTextNode(part)) }) }
    parsed.header.forEach((value) => { const th = document.createElement('th'); fill(th, value); thead.appendChild(th) })
    const body = table.createTBody()
    parsed.rows.forEach((row) => { const tr = body.insertRow(); row.forEach((value) => { const td = tr.insertCell(); fill(td, value) }) })
    shell.appendChild(table)
    return shell
  }
}

export class FrontmatterWidget extends LivePreviewWidget {
  constructor(source: string, selected: boolean, readonly pending: boolean, readonly documentPath: string | null = null, private readonly editMetadata?: (view: EditorView) => void, readonly proposals: readonly MetadataProposal[] = []) { super(source, selected) }
  eq(other: WidgetType): boolean { return other instanceof FrontmatterWidget && other.source === this.source && other.selected === this.selected && other.pending === this.pending && other.documentPath === this.documentPath && sameMetadataProposals(other.proposals, this.proposals) }
  private panel?: ReturnType<typeof mountFrontmatterEditor>
  toDOM(view: EditorView): HTMLElement {
    this.panel?.destroy?.()
    this.panel = undefined
    const shell = this.shell('frontmatter')
    if (this.pending) shell.append(Object.assign(document.createElement('span'), { className: 'lp-pending-review', textContent: 'pending review' }))
    const layout = layoutOf(this.source)
    const inner = layout ? this.source.slice(layout.openEnd, layout.closeStart).replace(/\r?\n$/, '') : this.source
    const editMetadata = (): void => { this.editMetadata?.(view) }
    if (!metadataRows(inner).some(row => row.editable)) {
      const note = document.createElement('span'); note.textContent = 'unparseable — press ↵'
      const raw = document.createElement('pre'); raw.textContent = inner
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Edit fields'; edit.setAttribute('aria-label', 'Edit document metadata')
      edit.addEventListener('click', editMetadata)
      shell.append(note, raw, edit)
      return shell
    }
    this.panel = mountFrontmatterEditor(inner, { workspace: metadataWorkspace(view.dom), path: this.documentPath, readonly: true, edit: editMetadata })
    shell.append(this.panel.element)
    markProposedFields(shell, this.panel.element, this.proposals)
    return shell
  }
  ignoreEvent(event: Event): boolean { return !!(event.target as HTMLElement)?.closest('button,input,select,.metadata-help') || super.ignoreEvent(event) }
  destroy(): void { this.panel?.destroy?.() }

}

/** "Proposed by Claude Code: draft → final" on each field a waiting edit would change; a field it would add is listed under the panel. */
function markProposedFields(shell: HTMLElement, panel: HTMLElement, proposals: readonly MetadataProposal[]): void {
  if (proposals.length === 0) return
  const added: HTMLElement[] = []
  for (const proposal of proposals) {
    const line = document.createElement('p')
    line.className = 'metadata-proposal'
    line.dataset.metadataProposal = proposal.key
    line.dataset.cid = proposal.id
    const was = proposal.before === null ? '' : proposal.before
    const now = proposal.after === null ? 'removed' : proposal.after
    line.textContent = proposal.before === null
      ? `${proposal.key}: ${now} · proposed by ${proposal.by}`
      : `Proposed by ${proposal.by}: ${was || '(empty)'} → ${now || '(empty)'}`
    const field = [...panel.querySelectorAll<HTMLElement>('[data-metadata-key]')].find((element) => element.dataset.metadataKey === proposal.key)
    if (field && proposal.before !== null) {
      field.classList.add('has-proposal')
      field.append(line)
    } else added.push(line)
  }
  if (added.length > 0) {
    const list = document.createElement('div')
    list.className = 'metadata-proposals'
    list.append(...added)
    shell.append(list)
  }
}

export class CodeWidget extends LivePreviewWidget {
  constructor(source: string, readonly language: string, selected: boolean) { super(source, selected) }
  eq(other: WidgetType): boolean { return other instanceof CodeWidget && other.source === this.source && other.language === this.language && other.selected === this.selected }
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell('code')
    const label = document.createElement('span')
    label.className = 'lp-code-language'
    label.textContent = this.language || 'code'
    const copy = document.createElement('button')
    copy.type = 'button'; copy.className = 'lp-copy'; copy.textContent = 'Copy'; copy.setAttribute('aria-label', 'Copy code')
    const body = this.source.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
    copy.addEventListener('click', (event) => { event.stopPropagation(); void navigator.clipboard.writeText(body); view.focus() })
    const pre = document.createElement('pre')
    const code = document.createElement('code'); code.textContent = body; pre.appendChild(code)
    shell.append(label, copy, pre)
    void highlightInto(code, body, this.language)
    return shell
  }
}

function fenceBody(source: string): string {
  return source.replace(/^```[^\n]*\n?/, '').replace(/\n?```\s*$/, '')
}

function icon(paths: string[], className = 'i'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

const QUERY_ICON = ['M5 3v16h16', 'm5 16 6-6 4 4 6-7']
const EDIT_ICON = ['M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z', 'm15 5 4 4']
const CHECK_ICON = ['m5 12 5 5L20 7']
const ERROR_ICON = ['M12 9v4', 'M12 17h.01', 'M10.3 3.7 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z']
const EMPTY_ICON = ['M4 6h16', 'M4 12h16', 'M4 18h10']
const AGENT_ICON = ['M12 8V4H8', 'M4 8h16v12H4z', 'M2 14h2', 'M20 14h2', 'M9 13v2', 'M15 13v2']
const SORT_ICON = ['m6 9 6 6 6-6']

type QueryBlock = { from: number; to: number; source: string }
type QueryWidgetActions = {
  edit(view: EditorView): void
  sort(view: EditorView, replacement: string): void
}

function queryBlockReplacement(source: string, inner: string): string {
  const opening = /^```[^\n]*/.exec(source)?.[0] ?? '```query'
  const finalBreak = source.endsWith('\n') ? '\n' : ''
  return `${opening}\n${inner.replace(/\n+$/, '')}\n\`\`\`${finalBreak}`
}

function queryHead(source: string, onEdit: () => void): HTMLElement {
  const head = document.createElement('div'); head.className = 'qobj-head'
  const tag = document.createElement('span'); tag.className = 'q-tag'; tag.append(icon(QUERY_ICON), document.createTextNode('Query'))
  const summary = document.createElement('span'); summary.className = 'q-src'
  const parts = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (parts.length === 0) summary.textContent = 'all pieces'
  parts.forEach((part, index) => {
    if (index) summary.append(document.createTextNode(' · '))
    const match = /^([^:]+):(.*)$/.exec(part)
    if (!match) { summary.append(document.createTextNode(part)); return }
    summary.append(document.createTextNode(`${match[1]}:`))
    const value = document.createElement('b'); value.textContent = match[2]; summary.append(value)
  })
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'q-edit'; edit.setAttribute('aria-label', 'Edit query source')
  edit.append(icon(EDIT_ICON, 'i xs'), document.createTextNode('Edit source ↵'))
  edit.addEventListener('click', (event) => { event.stopPropagation(); onEdit() })
  head.append(tag, summary, edit)
  return head
}

function queryFoot(count: number): HTMLElement {
  const foot = document.createElement('div'); foot.className = 'qobj-foot'
  foot.append(icon(CHECK_ICON, 'i xs'), document.createTextNode(`${count} ${count === 1 ? 'piece' : 'pieces'} · derived from frontmatter · updates as files change`))
  return foot
}

function loadingQueryObject(source: string, onEdit: () => void): HTMLElement {
  const object = document.createElement('div'); object.className = 'qobj qloading'; object.setAttribute('aria-busy', 'true')
  const body = document.createElement('div'); body.className = 'qloading-body'
  for (const width of ['78%', '62%', '70%']) { const line = document.createElement('span'); line.className = 'qloading-line'; line.style.width = width; body.appendChild(line) }
  object.append(queryHead(source, onEdit), body)
  return object
}

function emptyQueryObject(source: string, onEdit: () => void): HTMLElement {
  const object = document.createElement('div'); object.className = 'qobj'
  const empty = document.createElement('div'); empty.className = 'qempty'
  const title = document.createElement('strong'); title.textContent = 'No pieces match this query'
  const summary = document.createElement('span'); summary.className = 'qempty-src'; summary.textContent = compactQuerySummary(source)
  empty.append(icon(EMPTY_ICON, 'i'), title, summary)
  object.append(queryHead(source, onEdit), empty, queryFoot(0))
  return object
}

function sourceLines(source: string, offendingLine: number): HTMLElement {
  const sourceView = document.createElement('div'); sourceView.className = 'qsrc'
  const lines = source.split(/\r?\n/)
  if (lines.length === 1 && lines[0] === '') lines[0] = '— empty query source'
  lines.forEach((line, index) => {
    const row = document.createElement('div')
    if (index + 1 === offendingLine) row.classList.add('bad')
    const match = /^([^:]+):(.*)$/.exec(line)
    if (!match) row.textContent = line
    else {
      const key = document.createElement('span'); key.className = 'k'; key.textContent = `${match[1]}:`
      const value = document.createElement('span'); value.className = 'v'; value.textContent = match[2]
      row.append(key, value)
    }
    sourceView.appendChild(row)
  })
  return sourceView
}

function errorQueryObject(source: string, line: number, message: string, onEdit: () => void): HTMLElement {
  const object = document.createElement('div'); object.className = 'qobj err'
  const prose = document.createElement('div'); prose.className = 'm'
  const match = /^(Line \d+:)\s*(.*)$/.exec(message)
  if (match) { const pill = document.createElement('b'); pill.textContent = match[1]; prose.append(pill, document.createTextNode(` ${match[2]}`)) }
  else prose.textContent = message
  const diagnosis = document.createElement('div'); diagnosis.className = 'qmsg'; diagnosis.append(icon(ERROR_ICON, 'i'), prose)
  object.append(queryHead(source, onEdit), sourceLines(source, line), diagnosis)
  return object
}

function statusBadge(status: string | null): HTMLElement {
  const badge = document.createElement('span'); badge.className = `sbadge ${queryStatusBadgeClass(status)}`
  const dot = document.createElement('span'); dot.className = 'sdot'
  badge.append(dot, document.createTextNode(status ?? '—'))
  return badge
}

function queryRow(row: QueryRow): HTMLTableRowElement {
  const tr = document.createElement('tr')
  if (row.agentAuthored) tr.dataset.agentAuthored = 'true'
  const title = document.createElement('td'); title.className = 'qt-title'; title.append(document.createTextNode(row.title))
  if (row.agentAuthored) {
    const marker = document.createElement('span'); marker.className = 'qt-agent'; marker.title = 'Agent-authored piece'; marker.setAttribute('aria-label', 'Agent-authored piece'); marker.appendChild(icon(AGENT_ICON, 'i xs')); title.appendChild(marker)
  }
  const status = document.createElement('td'); status.appendChild(statusBadge(row.status))
  const description = document.createElement('td'); description.className = 'qt-desc'
  if (row.description) description.textContent = row.description
  else { description.classList.add('missing'); description.textContent = '— no description yet' }
  const date = document.createElement('td'); date.className = 'qt-date'; date.textContent = formatQueryDate(row.date)
  tr.append(title, status, description, date)
  return tr
}

function renderedQueryObject(result: Extract<QueryResult, { ok: true }>, onEdit: () => void, onSort: (field: QuerySortableField) => void): HTMLElement {
  const object = document.createElement('div'); object.className = 'qobj'
  const table = document.createElement('table'); table.className = 'qtable'
  const header = table.createTHead().insertRow()
  for (const label of ['Title', 'Status', 'Description', 'Date'] as const) {
    const th = document.createElement('th')
    const field = label.toLowerCase() as QuerySortableField
    if ((QUERY_SORTABLE_FIELDS as readonly string[]).includes(field)) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = label
      button.addEventListener('click', (event) => { event.stopPropagation(); onSort(field) })
      if (result.query.sort?.field === field) {
        th.classList.add('active')
        const chevron = icon(SORT_ICON, 'i sort')
        if (result.query.sort.direction === 'asc') chevron.classList.add('asc')
        button.appendChild(chevron)
      }
      th.appendChild(button)
    } else th.textContent = label
    header.appendChild(th)
  }
  const body = table.createTBody(); result.rows.forEach((row) => body.appendChild(queryRow(row)))
  object.append(queryHead(result.source, onEdit), table, queryFoot(result.rows.length))
  return object
}

export class QueryWidget extends LivePreviewWidget {
  constructor(readonly block: QueryBlock, selected: boolean, readonly actions: QueryWidgetActions) { super(block.source, selected) }
  eq(other: WidgetType): boolean { return other instanceof QueryWidget && other.source === this.source && other.selected === this.selected && other.block.from === this.block.from && other.block.to === this.block.to }
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell('query')
    const inner = fenceBody(this.source)
    let generation = 0
    let disposed = false
    const edit = (): void => this.actions.edit(view)
    const replaceObject = (object: HTMLElement): void => {
      if (disposed || !shell.isConnected) return
      shell.querySelector(':scope > .qobj')?.replaceWith(object)
    }
    const evaluate = async (): Promise<void> => {
      const request = ++generation
      try {
        const result = await window.writeflex.collection.query('', inner)
        if (disposed || request !== generation) return
        if (!result.ok) replaceObject(errorQueryObject(result.source, result.error.line, result.error.humanReadable, edit))
        else if (result.rows.length === 0) replaceObject(emptyQueryObject(result.source, edit))
        else replaceObject(renderedQueryObject(result, edit, (field) => {
          const rewritten = rewriteQuerySortLine(inner, field)
          this.actions.sort(view, queryBlockReplacement(this.source, rewritten))
        }))
      } catch (error) {
        if (disposed || request !== generation) return
        replaceObject(errorQueryObject(inner, 1, error instanceof Error ? error.message : String(error), edit))
      }
    }
    shell.appendChild(loadingQueryObject(inner, edit))
    const unsubscribe = window.writeflex.collection.onChanged(() => { void evaluate() })
    ;(shell as HTMLElement & { __wfDispose?: () => void }).__wfDispose = () => { disposed = true; generation += 1; unsubscribe() }
    void evaluate()
    return shell
  }
  ignoreEvent(event: Event): boolean {
    if ((event.target as HTMLElement | null)?.closest('button')) return true
    return super.ignoreEvent(event)
  }
  destroy(dom: HTMLElement): void {
    ;(dom as HTMLElement & { __wfDispose?: () => void }).__wfDispose?.()
  }
}

let mermaidReady: Promise<typeof import('mermaid')> | null = null
export const MERMAID_CONFIG = { startOnLoad: false, theme: 'neutral' as const, suppressErrorRendering: true }
function mermaidLibrary(): Promise<typeof import('mermaid')> {
  mermaidReady ??= import('mermaid').then((module) => {
    module.default.initialize(MERMAID_CONFIG)
    return module
  })
  return mermaidReady
}

export class MermaidWidget extends LivePreviewWidget {
  eq(other: WidgetType): boolean { return other instanceof MermaidWidget && other.source === this.source && other.selected === this.selected }
  toDOM(): HTMLElement {
    const shell = this.shell('mermaid')
    reserveHeight(shell, this.source)
    const placeholder = document.createElement('span')
    placeholder.className = 'lp-rendering'; placeholder.textContent = 'rendering diagram…'
    shell.appendChild(placeholder)
    const body = fenceBody(this.source)
    void mermaidLibrary().then(async ({ default: mermaid }) => {
      const id = `writeflex-mermaid-${crypto.randomUUID()}`
      const sweepOrphans = (): void => {
        document.getElementById(id)?.remove()
        document.querySelectorAll<HTMLElement>('[id]').forEach((node) => {
          if (/^d[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(node.id)) node.remove()
        })
      }
      try {
        const { svg } = await mermaid.render(id, body)
        if (shell.isConnected) { shell.innerHTML = `${hint().outerHTML}${svg}`; requestAnimationFrame(() => recordHeight(shell, this.source)) }
      } catch (error) {
        sweepOrphans()
        if (!shell.isConnected) return
        const source = document.createElement('pre'); source.textContent = this.source
        const message = document.createElement('div'); message.className = 'lp-render-error'; message.textContent = error instanceof Error ? error.message : String(error)
        shell.replaceChildren(hint(), source, message)
      }
    }).catch((error) => {
      const message = document.createElement('div'); message.className = 'lp-render-error'; message.textContent = error instanceof Error ? error.message : String(error)
      shell.replaceChildren(hint(), document.createTextNode(this.source), message)
    })
    return shell
  }
}

export class SvgWidget extends LivePreviewWidget {
  eq(other: WidgetType): boolean { return other instanceof SvgWidget && other.source === this.source && other.selected === this.selected }
  toDOM(): HTMLElement {
    const shell = this.shell('svg')
    reserveHeight(shell, this.source)
    const placeholder = document.createElement('span'); placeholder.className = 'lp-rendering'; placeholder.textContent = 'rendering SVG…'
    shell.appendChild(placeholder)
    const result = sanitiseSvg(fenceBody(this.source))
    whenSized(shell, () => {
      if (!shell.isConnected) return
      if ('error' in result) {
        const source = document.createElement('pre'); source.textContent = this.source
        const message = document.createElement('div'); message.className = 'lp-render-error'; message.textContent = result.error
        shell.replaceChildren(hint(), source, message)
      } else {
        shell.innerHTML = `${hint().outerHTML}${result.svg}`
        requestAnimationFrame(() => recordHeight(shell, this.source))
      }
    })
    return shell
  }
}

// Equal widgets can inherit an existing DOM shell from another WidgetType instance.
const markmapDisposers = new WeakMap<HTMLElement, () => void>()

export class MarkmapWidget extends LivePreviewWidget {
  eq(other: WidgetType): boolean { return other instanceof MarkmapWidget && other.source === this.source && other.selected === this.selected }
  toDOM(view: EditorView): HTMLElement {
    const shell = this.shell('markmap')
    reserveHeight(shell, this.source)
    const placeholder = document.createElement('span'); placeholder.className = 'lp-rendering'; placeholder.textContent = 'rendering diagram…'
    shell.appendChild(placeholder)
    let disposed = false
    let stopSizing = (): void => {}
    let map: import('markmap-view').Markmap | undefined
    // CM removes/destroys this shell when its replacement block no longer exists. Checking the
    // owning content DOM also rejects completion after an editor/pane has been replaced.
    const current = (): boolean => !disposed && shell.isConnected && view.contentDOM.contains(shell)
    const releaseMap = (previous = map): void => {
      if (previous === map) map = undefined
      if (!previous) return
      // destroy() disconnects observers but does not cancel d3's queued transition ticks.
      previous.svg.interrupt()
      previous.svg.selectAll('*').interrupt()
      previous.destroy()
    }
    const fail = (error: unknown): void => {
      if (!current()) return
      releaseMap()
      const source = document.createElement('pre'); source.textContent = this.source
      const message = document.createElement('div'); message.className = 'lp-render-error'; message.textContent = error instanceof Error ? error.message : String(error)
      shell.replaceChildren(hint(), source, message)
    }
    markmapDisposers.set(shell, () => {
      disposed = true
      stopSizing()
      releaseMap()
    })
    const body = fenceBody(this.source)
    void Promise.all([import('markmap-lib'), import('markmap-view')]).then(([{ Transformer }, { Markmap }]) => {
      if (!current()) return
      const { root } = new Transformer().transform(body)
      stopSizing = whenSized(shell, () => {
        // ResizeObserver invokes this outside the import promise's catch.
        void (async () => {
          if (!current()) return
          const width = shell.clientWidth
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          svg.setAttribute('width', '100%'); svg.setAttribute('height', '340')
          shell.replaceChildren(hint(), svg)
          // Passing data to create() launches an unobserved setData -> fit chain. Own it instead.
          // An explicit extent prevents d3's timer from resolving a detached SVG's 100% length.
          const rendered = Markmap.create(svg, { zoom: false, pan: false })
          map = rendered
          rendered.zoom.extent([[0, 0], [width, 340]])
          try {
            await rendered.setData(root)
            if (!current()) return
            await rendered.fit()
            if (!current()) return
          } finally {
            // setData itself awaits a frame. If destroy ran during that await, sweep any
            // transitions/observers it installed when it resumed on the detached SVG.
            if (!current()) releaseMap(rendered)
          }
          requestAnimationFrame(() => {
            if (!current()) return
            try { recordHeight(shell, this.source) } catch (error) { fail(error) }
          })
        })().catch(fail)
      })
    }).catch(fail)
    return shell
  }
  destroy(dom: HTMLElement): void {
    markmapDisposers.get(dom)?.()
    markmapDisposers.delete(dom)
  }
}
