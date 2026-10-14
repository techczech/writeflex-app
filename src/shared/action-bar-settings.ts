/**
 * The action bar's persisted state (ADR-0040).
 *
 * Visibility is one global app setting, remembered across restarts. Every open window shows
 * the same bar: a toggle in one window reaches the others through the `settings:changed` broadcast,
 * so two windows can never disagree.
 *
 * The value lives in the app-level settings store (`src/main/settings.ts` →
 * `userData/settings.json`, under `values`). Its NAME lives here, in shared, so the main process
 * and the renderer that reads it cannot drift apart. Ticket A2's ordered command list persists
 * beside it in the same file, under its own key.
 */

/** The settings key holding the action bar's visibility. Global, not per window. */
export const ACTION_BAR_VISIBLE_KEY = 'chrome.actionBarVisible'

/**
 * Shown until the writer hides it. The bar IS the feature, so a first launch after the upgrade
 * shows it; hiding is one click and is then remembered for every window and every restart.
 */
export const ACTION_BAR_VISIBLE_DEFAULT = true

/** The label the settings changelog records for a visibility change. */
export const ACTION_BAR_VISIBLE_LABEL = 'Action bar'

/** Read the stored value tolerantly: anything that is not a boolean means "never set". */
export function actionBarVisibleFrom(stored: unknown): boolean {
  return typeof stored === 'boolean' ? stored : ACTION_BAR_VISIBLE_DEFAULT
}

// ---- The ordered command list (ticket A2) -------------------------------------------------------
//
// What is ON the bar, and in what order, persists BESIDE the visibility boolean in the same
// app-level settings file, under its own key — global to the app exactly as visibility is, and
// riding the same `settings:changed` broadcast, so a second window redraws its bar the moment the
// sheet changes one here and two windows can never disagree.
//
// The stored value is a JSON array of strings: a registry command id, or the separator token. It is
// deliberately NOT the group structure the drawing shows — grouping IS the separators, so a writer
// dragging a separator is editing the same one list rather than a second, shadow model of it.
//
// The DEFAULT set is not here. It stays one array in `action-bar-commands.ts` (the renderer, where
// the icons live); this module only ever takes it as a fallback argument. One default list, one
// place — striking a verb through is still an edit to that array and never a refactor.

/** The settings key holding the bar's ordered items. Global, beside the visibility boolean. */
export const ACTION_BAR_ITEMS_KEY = 'chrome.actionBarItems'

/** The label the settings changelog records for a change to the bar's contents. */
export const ACTION_BAR_ITEMS_LABEL = 'Action bar commands'

/**
 * The item that draws a group boundary. `|` can never collide with a command id (registry ids are
 * dotted identifiers), so a stored list needs no escaping and no second field to tell the two apart.
 */
export const ACTION_BAR_SEPARATOR = '|'

/** Is this stored item a separator rather than a command id? */
export function isActionBarSeparator(item: string): boolean {
  return item === ACTION_BAR_SEPARATOR
}

/**
 * Read the stored list, or null when there is nothing usable in it.
 *
 * THE STORED LIST IS NEVER ALLOWED TO BREAK THE BAR. Not a string, not JSON, not an array, or an
 * array with no usable string in it — every one of those reads as "never set", and the caller falls
 * back to the drawn default rather than rendering an empty row. A list that parses keeps only its
 * string entries; a number or an object among them is dropped rather than poisoning the whole list.
 *
 * An id naming a command this build no longer has is NOT dropped here: it is dropped later, when the
 * list is resolved against the commands this window can run (`resolveActionBarItems`). Keeping it in
 * storage means a command that comes back — or one that is simply unavailable in this window's
 * context — returns to the writer's bar in its old place rather than being quietly forgotten.
 */
export function parseActionBarItems(stored: unknown): string[] | null {
  if (typeof stored !== 'string' || stored.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const items = parsed.filter((item): item is string => typeof item === 'string' && item !== '')
  // Nothing usable is damage, not a decision: a writer who wants no bar hides the bar.
  if (items.every((item) => isActionBarSeparator(item))) return null
  return items
}

/** What to write back: the list as stored, exactly as `parseActionBarItems` reads it. */
export function serialiseActionBarItems(items: readonly string[]): string {
  return JSON.stringify([...items])
}

/** The writer's list if there is one, else the drawn default the caller passes in. */
export function actionBarItemsFrom(stored: unknown, fallback: readonly string[]): string[] {
  return parseActionBarItems(stored) ?? [...fallback]
}
