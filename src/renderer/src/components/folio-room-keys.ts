/**
 * Which keydown targets the workspace's own keys may act on. The binder's TEXT section and the inspector are portals
 * drawn from inside the room, so their keys bubble through the room's handler; a button or field there is not the
 * cards or Outline the room's keys are about.
 */
type Targetish = { closest: (selector: string) => unknown } | null

/** The sidebar column (binder and inspector) the room draws into. */
export const SIDEBAR_SELECTOR = '.fr-sidebar'
/** A control that types: a field, a select, the editor. */
export const TYPING_SELECTOR = 'input, textarea, select, [contenteditable="true"], .cm-editor'
/** The cards and Outline lists (the room's `role="listbox"` parts list). */
export const PART_LIST_SELECTOR = '[role="listbox"]'

/** Whether the key came from a field or the editor. */
export function typedInField(target: Targetish): boolean {
  return target !== null && target.closest(TYPING_SELECTOR) !== null
}

/** Whether the key came from a control in the sidebar column (a binder row, an inspector button). */
export function pressedInSidebar(target: Targetish): boolean {
  return target !== null && target.closest(SIDEBAR_SELECTOR) !== null
}

/**
 * The room's selection keys (select all, Esc clearing the selection, Delete, Backspace, open the selected part) leave a
 * key typed in a field, and one pressed on a sidebar control, alone. The Folio command chords (N, ⌥↑, ⌥↓) still work from
 * a sidebar row, as the binder's rows are parts too.
 */
export function roomKeysIgnored(target: Targetish): boolean {
  return typedInField(target) || pressedInSidebar(target)
}

/** Delete and Backspace remove the selected parts only when focus is on the cards or Outline list itself. */
export function removeKeyApplies(target: Targetish): boolean {
  return target !== null && !roomKeysIgnored(target) && target.closest(PART_LIST_SELECTOR) !== null
}
