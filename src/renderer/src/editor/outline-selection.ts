import { StateEffect, StateField, type Extension, type StateCommand } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { deleteSections, headingIndexAt, moveSections, newHeadingEdit, sectionRoots, sectionSpan, shiftSections, type SectionsEdit } from './outline-sections'
import { extractOutline } from './outline'
import { EditorSelection } from '@codemirror/state'
import { lowerLineLevel, lowerSubtreeLevel, moveBlockDown, moveBlockUp, moveSubtreeDown, moveSubtreeUp, raiseLineLevel, raiseSubtreeLevel } from '@bridle/outline'

/**
 * The outline's several selected sections (outline package, ticket 17). The panel owns the picking; the
 * editor holds the result so the sections are tinted in the document and the structure chords can act on
 * all of them while the writer is typing. Values are heading start offsets, mapped through edits.
 */
export const setOutlineSelection = StateEffect.define<number[]>()

export const outlineSelectionField = StateField.define<number[]>({
  create: () => [],
  update(value, tr) {
    let next = tr.docChanged ? value.map((from) => tr.changes.mapPos(from, -1)) : value
    for (const effect of tr.effects) if (effect.is(setOutlineSelection)) next = effect.value
    return next
  },
})

const sectionTint = Decoration.line({ class: 'cm-outline-selected' })

const outlineSelectionDecorations = EditorView.decorations.compute([outlineSelectionField], (state): DecorationSet => {
  const picked = state.field(outlineSelectionField)
  if (picked.length === 0) return Decoration.none
  const doc = state.doc.toString()
  const lines: number[] = []
  for (const from of sectionRoots(doc, picked)) {
    const span = sectionSpan(doc, from)
    if (!span) continue
    const last = state.doc.lineAt(Math.max(span.from, Math.min(span.to - 1, state.doc.length))).number
    for (let n = state.doc.lineAt(span.from).number; n <= last; n += 1) lines.push(state.doc.line(n).from)
  }
  return Decoration.set([...new Set(lines)].sort((a, b) => a - b).map((at) => sectionTint.range(at)))
})

export const outlineSelectionExtension: Extension = [outlineSelectionField, outlineSelectionDecorations]

type Target = Parameters<StateCommand>[0]

/** Dispatch a sections edit as ONE transaction (one undo step), keep the picks on the moved sections, and
 *  put the cursor on the first of them so the editor follows. */
export function dispatchSectionsEdit(target: Target, edit: SectionsEdit, userEvent: string, keepSelection = true): void {
  const first = edit.froms[0]
  target.dispatch(target.state.update({
    changes: edit.changes,
    effects: keepSelection ? setOutlineSelection.of(edit.froms) : setOutlineSelection.of([]),
    selection: first === undefined ? undefined : EditorSelection.cursor(first),
    scrollIntoView: true,
    userEvent,
  }))
}

export type SectionAction = 'promote' | 'demote' | 'moveUp' | 'moveDown'

/** Run a structure action on whole sections (the picks, or `froms`). Returns the sections' new heading
 *  offsets, or null when nothing changed. `keep` leaves the sections picked (tinted) afterwards. */
export function runSectionAction(target: Target, action: SectionAction | 'delete', froms: readonly number[], keep = true): number[] | null {
  const doc = target.state.doc.toString()
  const edit = action === 'promote' ? shiftSections(doc, froms, -1)
    : action === 'demote' ? shiftSections(doc, froms, 1)
      : action === 'moveUp' ? moveSections(doc, froms, 'up')
        : action === 'moveDown' ? moveSections(doc, froms, 'down')
          : deleteSections(doc, froms)
  if (!edit) return null
  dispatchSectionsEdit(target, edit, action === 'delete' ? 'delete.selection' : `outline.${action}`, keep && action !== 'delete')
  return edit.froms
}

/**
 * A structure command that acts on the outline's picked sections when there are several, and otherwise
 * behaves as its single-cursor form — so ⌥⌘ + arrows mean the same thing in the panel and while typing.
 */
export function withPickedSections(action: SectionAction, single: StateCommand): StateCommand {
  return (target) => {
    const picked = target.state.field(outlineSelectionField, false) ?? []
    if (picked.length > 1) {
      runSectionAction(target, action, picked)
      return true
    }
    return single(target)
  }
}

export const promoteLine = withPickedSections('promote', raiseLineLevel)
export const demoteLine = withPickedSections('demote', lowerLineLevel)
export const promoteSubtree = withPickedSections('promote', raiseSubtreeLevel)
export const demoteSubtree = withPickedSections('demote', lowerSubtreeLevel)
export const moveBlockUpPicked = withPickedSections('moveUp', moveBlockUp)
export const moveBlockDownPicked = withPickedSections('moveDown', moveBlockDown)
export const moveSubtreeUpPicked = withPickedSections('moveUp', moveSubtreeUp)
export const moveSubtreeDownPicked = withPickedSections('moveDown', moveSubtreeDown)

/** New heading before the cursor's section, or as its first subheading; the cursor lands in the new heading. */
export function newHeadingCommand(mode: 'before' | 'sub'): StateCommand {
  return (target) => {
    const doc = target.state.doc.toString()
    const headings = extractOutline(doc)
    const index = headingIndexAt(headings, target.state.selection.main.head)
    if (index === -1) return false
    const edit = newHeadingEdit(doc, headings[index].from, mode)
    if (!edit) return false
    target.dispatch(target.state.update({ changes: edit.changes, selection: EditorSelection.cursor(edit.cursor), scrollIntoView: true, userEvent: 'input.outline' }))
    return true
  }
}
