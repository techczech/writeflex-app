import { isolateHistory } from '@codemirror/commands'
import { StateEffect, StateField, type StateCommand } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, showTooltip, type DecorationSet, type Tooltip } from '@codemirror/view'
import { flagSelectionEdit } from '../../../shared/markdown/flag-edit'
import { FLAG_KINDS, findFlags, type FlagKind } from '../../../shared/markdown/flags'

export const FLAG_LABELS: Record<FlagKind, string> = { 'needs-citation': 'Needs citation', rewrite: 'Rewrite', 'check-fact': 'Check fact', expand: 'Expand' }
export const FLAG_NOTICE = 'writeflex:flag-notice'
const menu = StateEffect.define<boolean>()
const report = (error: unknown): void => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FLAG_NOTICE, { detail: error instanceof Error ? error.message : String(error) })) }

export function flagSelection(kind: FlagKind): StateCommand {
  return ({ state, dispatch }) => {
    try {
      if (state.readOnly) return false
      const range = state.selection.main
      const edit = flagSelectionEdit(state.doc.toString(), range.from, range.to, kind)
      dispatch(state.update({ changes: edit, selection: { anchor: edit.from + 2, head: edit.from + edit.insert.indexOf('==<!--') }, effects: menu.of(false), annotations: isolateHistory.of('full'), userEvent: 'input.flag', scrollIntoView: true }))
      return true
    } catch (error) { report(error); return false }
  }
}

export const clearFlagAtCursor: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  const range = state.selection.main
  const flag = findFlags(state.doc.toString()).find(flag => flag.from <= range.from && flag.to >= range.to)
  if (!flag) { report('Put the cursor in a flagged passage first.'); return false }
  dispatch(state.update({ changes: [{ from: flag.from, to: flag.wordsFrom }, { from: flag.wordsTo, to: flag.to }], selection: { anchor: flag.from }, effects: menu.of(false), annotations: isolateHistory.of('full'), userEvent: 'input.flag' }))
  return true
}
export const openFlagMenu: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false
  dispatch(state.update({ effects: menu.of(true) }))
  return true
}

const flagMenu = StateField.define<boolean>({
  create: () => false,
  update(value, tr) { for (const effect of tr.effects) if (effect.is(menu)) return effect.value; return tr.docChanged || tr.selection ? false : value },
  provide: field => showTooltip.computeN([field], state => {
    if (!state.field(field)) return []
    return [{ pos: state.selection.main.head, above: false, strictSide: false, create(view) {
      const dom = document.createElement('div')
      dom.className = 'wf-flag-menu'
      dom.setAttribute('role', 'menu')
      dom.setAttribute('aria-label', 'Flag the selection')
      const inside = findFlags(view.state.doc.toString()).some(flag => flag.from <= view.state.selection.main.from && flag.to >= view.state.selection.main.to)
      FLAG_KINDS.forEach((kind, at) => {
        const button = document.createElement('button')
        button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = `${at + 1}  ${FLAG_LABELS[kind]}`
        button.onmousedown = event => event.preventDefault()
        button.onclick = () => { applyKind(view, kind, inside); view.focus() }
        dom.append(button)
      })
      if (inside) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Clear flag'; button.setAttribute('role', 'menuitem')
        button.onmousedown = event => event.preventDefault(); button.onclick = () => { clearFlagAtCursor(view); view.focus() }; dom.append(button)
      }
      return { dom }
    } } satisfies Tooltip]
  }),
})
function applyKind(view: EditorView, kind: FlagKind, inside: boolean): boolean {
  if (!inside) return flagSelection(kind)(view)
  const range = view.state.selection.main
  const flag = findFlags(view.state.doc.toString()).find(flag => flag.from <= range.from && flag.to >= range.to)
  if (!flag || view.state.readOnly) return false
  view.dispatch({ changes: { from: flag.wordsTo + 2, to: flag.to, insert: `<!--flag:${kind}-->` }, effects: menu.of(false), annotations: isolateHistory.of('full'), userEvent: 'input.flag' })
  return true
}
class FlagTag extends WidgetType {
  constructor(readonly kind: FlagKind) { super() }
  eq(other: FlagTag): boolean { return other.kind === this.kind }
  toDOM(): HTMLElement { const tag = document.createElement('span'); tag.className = `wf-flag-tag ${this.kind}`; tag.textContent = FLAG_LABELS[this.kind]; return tag }
}
const decorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  atomics = Decoration.none
  constructor(view: EditorView) { this.decorations = this.read(view) }
  update(update: import('@codemirror/view').ViewUpdate): void { if (update.docChanged) this.decorations = this.read(update.view) }
  read(view: EditorView): DecorationSet {
    const marks = findFlags(view.state.doc.toString()).filter(flag => !flag.inTable).flatMap(flag => [
      Decoration.mark({ class: `wf-flag-words ${flag.kind}` }).range(flag.wordsFrom, flag.wordsTo),
      Decoration.replace({ widget: new FlagTag(flag.kind) }).range(flag.wordsTo + 2, flag.to),
    ])
    this.atomics = Decoration.set(findFlags(view.state.doc.toString()).filter(flag => !flag.inTable).map(flag => Decoration.replace({}).range(flag.wordsTo + 2, flag.to)), true)
    return Decoration.set(marks, true)
  }
}, { decorations: value => value.decorations, provide: plugin => EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomics ?? Decoration.none) })

export const flagEditing = [flagMenu, decorations, keymap.of([
  ...FLAG_KINDS.map((kind, at) => ({ key: String(at + 1), run: (view: EditorView) => { if (!view.state.field(flagMenu)) return false; applyKind(view, kind, findFlags(view.state.doc.toString()).some(flag => flag.from <= view.state.selection.main.from && flag.to >= view.state.selection.main.to)); return true } })),
  { key: 'Escape', run: (view: EditorView) => { if (!view.state.field(flagMenu)) return false; view.dispatch({ effects: menu.of(false) }); return true } },
])]
