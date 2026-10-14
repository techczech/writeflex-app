import { Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, showTooltip, type Tooltip } from '@codemirror/view'

export type WikilinkCompletionPiece = { title: string | null; name: string }
export type WikilinkPickerMatch = { label: string; detail?: string; piece: WikilinkCompletionPiece }
export type WikilinkPickerTarget = { from: number; query: string }

export type WikilinkPickerState = {
  open: boolean
  from: number
  query: string
  matches: WikilinkPickerMatch[]
  activeIndex: number
}

const CLOSED_PICKER: WikilinkPickerState = { open: false, from: 0, query: '', matches: [], activeIndex: 0 }

function basename(name: string): string {
  return name.replace(/\.(?:md|markdown|mdx)$/i, '')
}

/** Locate the target half of the nearest unclosed wikilink on the caret's current line. */
export function detectWikilinkPickerTarget(doc: string, head: number): WikilinkPickerTarget | null {
  if (head < 2 || head > doc.length) return null
  const lineStart = doc.lastIndexOf('\n', head - 1) + 1
  const beforeCaret = doc.slice(lineStart, head)
  const opener = beforeCaret.lastIndexOf('[[')
  if (opener < 0) return null
  const query = beforeCaret.slice(opener + 2)
  if (query.includes(']]') || query.includes('|')) return null
  return { from: lineStart + opener + 2, query }
}

/** Build the WriteFlex picker rows and perform its collection matching without CM autocomplete. */
export function wikilinkPickerMatches(pieces: WikilinkCompletionPiece[], query: string): WikilinkPickerMatch[] {
  const needle = query.trim().toLocaleLowerCase()
  return pieces
    .map((piece) => {
      const stem = basename(piece.name)
      const label = piece.title?.trim() || stem
      return {
        label,
        ...(label.toLocaleLowerCase() === stem.toLocaleLowerCase() ? {} : { detail: stem }),
        piece,
      }
    })
    .filter((match) => !needle || match.label.toLocaleLowerCase().includes(needle) || match.detail?.toLocaleLowerCase().includes(needle))
    .sort((a, b) => a.label.localeCompare(b.label) || (a.detail ?? '').localeCompare(b.detail ?? ''))
}

export function wikilinkCompletionEdit(doc: string, from: number, to: number, label: string): { from: number; to: number; insert: string; anchor: number } {
  // Completing the target half of [[Target|display]] must leave the writer's display text intact.
  if (doc[to] === '|') return { from, to, insert: label, anchor: from + label.length }
  const closesAtCursor = doc.slice(to, to + 2) === ']]'
  const insert = `${label}]]`
  return { from, to: closesAtCursor ? to + 2 : to, insert, anchor: from + insert.length }
}

function pickerState(state: EditorState, previous: WikilinkPickerState, pieces: () => WikilinkCompletionPiece[]): WikilinkPickerState {
  const selection = state.selection.main
  if (!selection.empty) return CLOSED_PICKER
  const target = detectWikilinkPickerTarget(state.doc.toString(), selection.head)
  if (!target) return CLOSED_PICKER
  const matches = wikilinkPickerMatches(pieces(), target.query)
  if (!matches.length) return CLOSED_PICKER
  const activeIndex = previous.open && previous.from === target.from
    ? Math.min(previous.activeIndex, matches.length - 1)
    : 0
  return { open: true, ...target, matches, activeIndex }
}

/** A WriteFlex-owned `[[` Piece picker with deterministic synchronous key handling. */
export function wikilinkPicker(pieces: () => WikilinkCompletionPiece[]): Extension {
  const moveActive = StateEffect.define<number>()
  const dismissPicker = StateEffect.define<null>()

  let field: StateField<WikilinkPickerState>

  const acceptMatch = (view: EditorView, index: number): boolean => {
    const value = view.state.field(field)
    const match = value.open ? value.matches[index] : undefined
    if (!match) return false
    const edit = wikilinkCompletionEdit(view.state.doc.toString(), value.from, view.state.selection.main.head, match.label)
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.anchor },
      effects: dismissPicker.of(null),
      scrollIntoView: true,
    })
    return true
  }

  const tooltip = (value: WikilinkPickerState): Tooltip | null => value.open ? {
    pos: value.from,
    above: false,
    arrow: false,
    create(view) {
      const dom = document.createElement('div')
      dom.className = 'wl-picker'
      dom.setAttribute('role', 'listbox')
      dom.setAttribute('aria-label', 'Collection Pieces')
      value.matches.forEach((match, index) => {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = `wl-picker-row${index === value.activeIndex ? ' active' : ''}`
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', index === value.activeIndex ? 'true' : 'false')
        const title = document.createElement('span')
        title.className = 'wl-picker-title'
        title.textContent = match.label
        row.append(title)
        if (match.detail) {
          const detail = document.createElement('span')
          detail.className = 'wl-picker-detail'
          detail.textContent = match.detail
          row.append(detail)
        }
        row.addEventListener('mousedown', (event) => {
          event.preventDefault()
          acceptMatch(view, index)
        })
        dom.append(row)
      })
      return { dom }
    },
  } : null

  field = StateField.define<WikilinkPickerState>({
    create(state) {
      return pickerState(state, CLOSED_PICKER, pieces)
    },
    update(value, transaction) {
      let next = pickerState(transaction.state, value, pieces)
      for (const effect of transaction.effects) {
        if (effect.is(dismissPicker)) next = CLOSED_PICKER
        else if (effect.is(moveActive) && next.open) {
          const activeIndex = (next.activeIndex + effect.value + next.matches.length) % next.matches.length
          next = { ...next, activeIndex }
        }
      }
      return next
    },
    provide: (pickerField) => showTooltip.compute([pickerField], (state) => tooltip(state.field(pickerField))),
  })

  const whenOpen = (view: EditorView, action: (value: WikilinkPickerState) => void): boolean => {
    const value = view.state.field(field)
    if (!value.open) return false
    action(value)
    return true
  }

  return [
    field,
    // Prec.highest, not high: editingKeymap (which spreads outlinerKeymap's Tab->insertTab fallback)
    // is also Prec.high and registered earlier, so at equal precedence it wins Tab and the picker's
    // accept never fires. Each handler returns false when the picker is closed (acceptMatch/whenOpen),
    // so raising precedence only claims these keys while the picker is open — normal Tab/Enter survive.
    Prec.highest(keymap.of([
      { key: 'ArrowDown', run: (view) => whenOpen(view, () => view.dispatch({ effects: moveActive.of(1) })) },
      { key: 'ArrowUp', run: (view) => whenOpen(view, () => view.dispatch({ effects: moveActive.of(-1) })) },
      { key: 'Enter', run: (view) => acceptMatch(view, view.state.field(field).activeIndex) },
      { key: 'Tab', run: (view) => acceptMatch(view, view.state.field(field).activeIndex) },
      { key: 'Escape', run: (view) => whenOpen(view, () => view.dispatch({ effects: dismissPicker.of(null) })) },
    ])),
  ]
}
