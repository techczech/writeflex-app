import { editMetadataInner, metadataOriginals, metadataRows, metadataSummary, type MetadataRow } from '../../../../shared/document-metadata'
import { METADATA_REGISTRY, metadataEntry, type MetadataValues, type MetadataEntry } from '../../../../shared/metadata-registry'
import { metadataCollapsed, setMetadataCollapsed, METADATA_VIEW_EVENT } from '../metadata-view-state'
import type { MountedEditor } from './shell'

export type MetadataPanelOptions = { lineEnding?: string; workspace?: string; path?: string | null; readonly?: boolean; edit?: () => void; vocabulary?: () => Promise<MetadataValues> }
let nextId = 0
let ignoredListsForgotten = false
/** Earlier builds kept a per-document "ignored keys" list in localStorage for a review box that no longer exists; nothing in documents. */
function forgetIgnoredKeyLists(): void {
  if (ignoredListsForgotten) return
  ignoredListsForgotten = true
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith('writeflex:metadata:ignored:')) stale.push(key) }
    for (const key of stale) localStorage.removeItem(key)
  } catch { /* No storage: nothing to forget. */ }
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el
}
const button = (text: string, label: string, run: () => void): HTMLButtonElement => {
  const el = node('button', '', text); el.type = 'button'; el.setAttribute('aria-label', label); el.addEventListener('click', run); return el
}

/** The registry rendered, over a private draft of the live object editor's source; no filesystem writes. */
export function mountFrontmatterEditor(source: string, options: MetadataPanelOptions = {}): MountedEditor {
  let inner = source, collapsed = metadataCollapsed(options.workspace ?? ''), systemOpen = false, destroyed = false
  const initialKeys = new Set(metadataRows(source).map(row => row.key))
  // Each field as this edit session found it: its type and bytes, never re-read after a keystroke.
  const originals = metadataOriginals(source)
  const addedFields = new Set<string>()
  let vocabulary: MetadataValues = {}
  const controller = new AbortController(), id = `metadata-${++nextId}`, workspace = options.workspace ?? ''
  forgetIgnoredKeyLists()
  const root = node('section', 'metadata-panel fme'); root.setAttribute('aria-label', 'Document metadata')
  const header = node('div', 'metadata-head')
  const summary = node('span', 'metadata-summary')
  const toggle = button('', 'Collapse metadata', () => setMetadataCollapsed(workspace, !collapsed))
  toggle.className = 'metadata-toggle'; toggle.setAttribute('aria-controls', `${id}-fields`)
  header.append(toggle, node('span', 'metadata-heading', 'Metadata'), summary)
  const body = node('div', 'metadata-body'); body.id = `${id}-fields`
  const message = node('div', 'metadata-message'); message.setAttribute('role', 'status')
  const updateSummary = (): void => { summary.textContent = metadataSummary(inner) }
  const apply = (key: string, value: string | string[] | null): void => {
    try {
      const clearNew = value === '' && !initialKeys.has(key)
      inner = editMetadataInner(inner, key, clearNew ? null : value, options.lineEnding, originals.get(key) ?? null)
      if (clearNew && !source.endsWith('\n') && inner.endsWith('\n')) inner = inner.replace(/\r?\n$/, '')
      message.textContent = ''; updateSummary()
    }
    catch (error) { message.textContent = error instanceof Error ? error.message : 'Use Edit as Markup to change this value.' }
  }
  const updateCollapse = (): void => {
    body.hidden = collapsed; root.classList.toggle('is-collapsed', collapsed)
    toggle.textContent = collapsed ? '›' : '⌄'; toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.setAttribute('aria-label', collapsed ? 'Show metadata' : 'Collapse metadata')
  }
  window.addEventListener(METADATA_VIEW_EVENT, ((event: CustomEvent<{ workspace: string; collapsed: boolean }>) => {
    if (event.detail.workspace === workspace) { flushTags(); collapsed = event.detail.collapsed; updateCollapse() }
  }) as EventListener, { signal: controller.signal })

  const addOptions = (input: HTMLInputElement, field: MetadataEntry): void => {
    const list = node('datalist'); list.id = `${id}-${field.key}-values`; input.setAttribute('list', list.id)
    const used = new Set<string>()
    for (const value of [...(field.suggestions ?? []), ...(vocabulary[field.key] ?? []).map(v => v.value)]) {
      if (used.has(value)) continue; used.add(value)
      const option = node('option'); option.value = value; list.append(option)
    }
    input.after(list)
  }
  const flushTags = (): void => {
    for (const input of root.querySelectorAll<HTMLInputElement>('input[data-metadata-tags]')) {
      const value = input.value.trim(), key = input.dataset.metadataTags!
      if (!value) continue
      const current = metadataRows(inner).find(row => row.key === key)?.value ?? []
      input.value = ''
      apply(key, [...new Set([...(Array.isArray(current) ? current : current ? [current] : []), value])])
    }
  }
  const render = (): void => {
    flushTags()
    body.replaceChildren(); updateSummary()
    const rows = metadataRows(inner)
    // Keys WriteFlex does not know are the writer's own: always kept, shown after the known fields.
    // One field per key; every opaque entry gets its own row, even when two read the same.
    const unknownRows = rows.filter((r, i) => !metadataEntry(r.key) && (r.opaque || rows.findIndex(o => o.key === r.key) === i))
    const grid = node('div', 'metadata-grid')
    const fields = METADATA_REGISTRY.filter(e => !e.system && (rows.some(r => r.key === e.key) || (!options.readonly && (e.primary || addedFields.has(e.key)))))
    const renderField = (field: MetadataEntry): HTMLElement => {
      const row = rows.find(r => r.key === field.key), value = row?.value ?? ''
      const box = node('div', `metadata-field${field.key === 'title' || field.key === 'standfirst' || field.list ? ' metadata-wide' : ''}`)
      const label = node('label', '', field.label); label.htmlFor = `${id}-${field.key}`
      const help = node('span', 'metadata-help', 'ⓘ'); help.tabIndex = 0; help.setAttribute('role', 'note'); help.title = field.explanation; help.setAttribute('aria-label', field.explanation)
      const explanation = node('span', 'sr-only', field.explanation); explanation.id = `${id}-${field.key}-help`
      box.append(label, help, explanation)
      if (options.readonly) { box.append(node('div', 'metadata-value', row?.editable ? (Array.isArray(value) ? value.join(' · ') : value) || '—' : 'Structured value · Edit as Markup')); return box }
      if (row && (!row.editable || rows.filter(r => r.key === field.key).length > 1)) {
        box.append(node('p', 'metadata-structured', 'Structured or duplicate value · Edit as Markup')); return box
      }
      if (field.options) {
        const select = node('select'); select.id = label.htmlFor; select.setAttribute('aria-label', `Value for ${field.key}`); select.setAttribute('aria-describedby', explanation.id)
        const empty = node('option', '', 'Default'); empty.value = ''; select.append(empty)
        for (const option of field.options) { const opt = node('option', '', option.label); opt.value = option.value; opt.title = option.explanation; select.append(opt) }
        if (value && !field.options.some(o => o.value === value)) { const own = node('option', '', `${value} (current)`); own.value = String(value); select.append(own) }
        select.value = String(value); select.addEventListener('change', () => apply(field.key, select.value || null)); box.append(select)
      } else if (field.list) {
        const chips = node('div', 'metadata-chips')
        const values = Array.isArray(value) ? value : value ? [value] : []
        for (const [index, item] of values.entries()) {
          const chip = node('span', 'chip', item)
          chip.append(button('×', `Remove ${item} from ${field.label.toLowerCase()}`, () => { apply(field.key, values.filter((_, n) => index !== n)); render(); root.querySelector<HTMLInputElement>(`#${id}-${field.key}`)?.focus() })); chips.append(chip)
        }
        const input = node('input'); input.id = label.htmlFor; input.setAttribute('aria-label', `Add value to ${field.key}`); input.setAttribute('aria-describedby', explanation.id); input.placeholder = 'Add a value…'; input.dataset.metadataTags = field.key
        const append = (): void => { const item = input.value.trim(); if (!item) return; input.value = ''; apply(field.key, [...new Set([...values, item])]); render(); root.querySelector<HTMLInputElement>(`#${id}-${field.key}`)?.focus() }
        input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); append() } })
        // Never rebuild a focused input from blur/change: CodeMirror may be removing this widget.
        // serialise flushes an unsubmitted tag into the same undoable document commit.
        chips.append(input); box.append(chips); addOptions(input, field)
      } else {
        const input = node('input'); input.id = label.htmlFor; input.value = String(value); input.setAttribute('aria-label', `Value for ${field.key}`); input.setAttribute('aria-describedby', explanation.id); input.autocomplete = 'off'
        input.placeholder = field.key === 'date' || field.key === 'due' ? 'YYYY-MM-DD' : 'Not set'
        input.addEventListener('input', () => apply(field.key, input.value)); box.append(input); addOptions(input, field)
      }
      return box
    }
    /** A key outside the registry: a plain scalar is a text field; a list, map or duplicate is shown read-only. */
    const renderOwnField = (row: MetadataRow, inputId: string): HTMLElement => {
      const key = row.key, matches = rows.filter(r => r.key === key), value = row.value
      const box = node('div', 'metadata-field metadata-own')
      if (row.opaque) {
        // An entry with no plain key (`[a]: x`, `? key`): its first line, so nothing in the front matter is hidden.
        box.classList.add('metadata-opaque')
        box.append(node('label', '', row.valueText.length > 60 ? `${row.valueText.slice(0, 59)}…` : row.valueText), node('p', 'metadata-structured', 'Edit as Markup to change'))
        return box
      }
      box.dataset.metadataKey = key
      const label = node('label', '', key); label.htmlFor = inputId; box.append(label)
      const shown = Array.isArray(value) ? value.join(' · ') : value
      if (matches.length > 1) { box.append(node('p', 'metadata-structured', 'Duplicate key · Edit as Markup')); return box }
      if (!row.editable) {
        // A one-line value the field parser cannot own (a dotted key, say) is still shown as written.
        const oneLine = !/\n./.test(inner.slice(row.from, row.to)) && row.valueText
        if (oneLine) box.append(node('div', 'metadata-value', row.valueText))
        box.append(node('p', 'metadata-structured', oneLine ? 'Edit as Markup to change' : 'Structured value · Edit as Markup')); return box
      }
      if (Array.isArray(value)) { box.append(node('div', 'metadata-value', shown || '—'), node('p', 'metadata-structured', 'List · Edit as Markup to change')); return box }
      if (options.readonly) { box.append(node('div', 'metadata-value', shown || '—')); return box }
      const input = node('input'); input.id = inputId; input.value = value; input.setAttribute('aria-label', `Value for ${key}`); input.autocomplete = 'off'; input.placeholder = 'Not set'
      input.addEventListener('input', () => apply(key, input.value)); box.append(input)
      return box
    }
    for (const field of fields) grid.append(renderField(field))
    for (const [index, own] of unknownRows.entries()) grid.append(renderOwnField(own, `${id}-own-${index}`))
    body.append(grid)
    if (!options.readonly) {
      const add = node('select', 'metadata-add'); add.setAttribute('aria-label', 'Add metadata field')
      const placeholder = node('option', '', '+ Add a field'); placeholder.value = ''; add.append(placeholder)
      for (const field of METADATA_REGISTRY.filter(e => !e.system && !fields.includes(e))) { const opt = node('option', '', field.label); opt.value = field.key; add.append(opt) }
      add.addEventListener('change', () => { if (!add.value) return; const field = metadataEntry(add.value)!; addedFields.add(field.key); render(); root.querySelector<HTMLInputElement>(`#${id}-${field.key}`)?.focus() }); body.append(add)
    }
    // Only keys the registry marks as written by WriteFlex itself; any other key is shown as a field.
    const system = rows.filter(r => metadataEntry(r.key)?.system)
    if (system.length) {
      const section = node('div', 'metadata-system')
      const reveal = button(`${systemOpen ? '🔓' : '🔒'} System fields · ${system.length}`, 'Reveal system metadata', () => { systemOpen = !systemOpen; render(); root.querySelector<HTMLButtonElement>('[aria-label="Reveal system metadata"]')?.focus() }); reveal.setAttribute('aria-expanded', String(systemOpen)); section.append(reveal)
      if (systemOpen) {
        section.append(node('p', '', 'WriteFlex manages these values. Use Edit as Markup for deliberate changes.'))
        for (const row of system) { const line = node('div', 'metadata-system-row'); line.append(node('span', '', metadataEntry(row.key)?.label ?? row.key), node('span', '', row.editable ? String(row.value) : 'Structured value')); section.append(line) }
      }
      body.append(section)
    }
    if (options.readonly) body.append(button('Edit fields', 'Edit document metadata', () => options.edit?.()))
    body.append(message)
  }
  root.append(header, body); render(); updateCollapse()
  const loader = options.vocabulary ?? (() => window.writeflex?.metadataValues?.(options.path ?? undefined) ?? Promise.resolve({}))
  if (!options.readonly) void loader().then(values => {
    if (destroyed) return; vocabulary = values
    // Populate lists in place: a slow main-process scan never replaces a focused draft field.
    for (const field of METADATA_REGISTRY) {
      const input = root.querySelector<HTMLInputElement>(`input#${id}-${field.key}`)
      if (input) { root.querySelector(`#${id}-${field.key}-values`)?.remove(); addOptions(input, field) }
    }
  }).catch(() => { if (!destroyed) message.textContent = 'Workspace suggestions could not be read. You can still type a value.' })
  return { element: root, serialise: () => { flushTags(); return inner }, focus: () => { if (collapsed) toggle.focus(); else (root.querySelector<HTMLInputElement>('[aria-label="Value for title"]') ?? toggle).focus() }, destroy: () => { destroyed = true; controller.abort() } }
}
