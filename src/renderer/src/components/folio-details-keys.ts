/**
 * The one "typing in a field" check of the Details card, for both ways Undo arrives: the physical ⌘Z (the card's
 * keydown) and Edit ▸ Undo from the menu (Sol round 2, finding 6). While it holds, Undo is the field's own text undo;
 * otherwise it undoes the card's last change.
 */

/** The part of an element the check reads (a real DOM element in the app; a stand-in in tests). */
export type DetailsFocus = { dataset: { folioDetail?: string }; closest: (selector: string) => unknown }

/**
 * True while `focused` is a picker's own box (anything inside `.fd-pop`, its filter input above all), or a typed field
 * (title, standfirst) holding typing not committed yet (`drafts[field] !== null`).
 */
export function typingInDetails(focused: DetailsFocus | null | undefined, drafts: Readonly<Record<'title' | 'standfirst', string | null>>): boolean {
  if (!focused) return false
  if (focused.closest('.fd-pop') !== null) return true
  const field = focused.dataset.folioDetail
  return (field === 'title' || field === 'standfirst') && drafts[field] !== null
}
