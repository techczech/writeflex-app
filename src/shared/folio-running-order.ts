/**
 * Changing a Folio's running order from the Outline: the pure rules main and the renderer share.
 * Nothing here touches a file. Every change names pieces by PATH, never by index, because an index
 * only means something against one read of the Plan and the Outline's list comes from another.
 */

/** What a running-order change asks main to do, by path. `expected` is the running order the caller was looking at. */
export type MovePieceInput = { dir: string; path: string; beforePath: string | null; expected: string[] }
export type AddPiecesInput = { dir: string; paths: string[]; expected: string[] }
export type RemoveAddedInput = { dir: string; paths: string[]; expected: string[] }

/**
 * What main answers. `stale` = the running order is no longer what the caller saw. `partial` is set only
 * by an Undo of an Add that stopped part-way: exactly which pieces were taken out again, which are still
 * in the running order, and the running order as it now stands.
 */
export type RunningOrderResult =
  | { ok: true; changed: boolean; order: string[] }
  | { ok: false; stale: boolean; message: string; partial?: { removed: string[]; remaining: string[]; order: string[] } }

export const STALE_ORDER_MESSAGE = 'The running order changed. The Outline has been refreshed.'
export const STALE_ADD_MESSAGE = STALE_ORDER_MESSAGE
export const STALE_UNDO_MESSAGE = 'Could not undo: the running order has changed since.'
/** A Folio the Outline cannot change exactly: the refusal from main, and the line the Outline shows instead of its controls. */
export const OUTLINE_UNSAFE_MESSAGE = 'This Folio has entries the Outline cannot move safely. Open the Plan to change its order.'
export const ORDER_IN_PLAN_LINE = 'Change this Folio’s order in the Plan.'

export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index])
}

/**
 * Where a piece goes, as indices into a list of the Plan's parts (`null` = a part with no file yet).
 * `from` is the piece's index; `to` is its index once it is taken out and put back, which is what
 * `movePart` takes. `beforePath` null = after the last part that has a file. Null when the move is
 * not well defined: the piece or `beforePath` is missing or listed more than once, (`beforePath` being the piece itself is a move in place).
 */
export function resolveMove(parts: ReadonlyArray<string | null>, path: string, beforePath: string | null): { from: number; to: number } | null {
  const count = (target: string): number => parts.filter((part) => part === target).length
  if (count(path) !== 1) return null
  const from = parts.indexOf(path)
  if (beforePath === path) return { from, to: from }
  if (beforePath !== null && count(beforePath) !== 1) return null
  const remaining = parts.filter((_, index) => index !== from)
  let to: number
  if (beforePath !== null) to = remaining.indexOf(beforePath)
  else {
    let last = -1
    remaining.forEach((part, index) => { if (part !== null) last = index })
    to = last + 1
  }
  return { from, to }
}

/** A move that leaves the order as it is (dropped in place). */
export function isInPlace(parts: ReadonlyArray<string | null>, path: string, beforePath: string | null): boolean {
  const move = resolveMove(parts, path, beforePath)
  return move !== null && move.from === move.to
}

/** The piece that follows `path` in the order, or null when it is last (what Undo of a move puts it back before). */
export function successorOf(order: readonly string[], path: string): string | null {
  const at = order.indexOf(path)
  return at >= 0 ? order[at + 1] ?? null : null
}

/** One place for a piece to land: `slot` runs 0..n, slot k = before the piece now at index k, slot n = at the end. */
export type PieceBox = { top: number; bottom: number }

/**
 * Which slot a pointer at `y` points at. `boxes` are the pieces' boxes (the piece row with its headings
 * when expanded), in order. The upper half of a box is the slot before it, the lower half the slot after.
 * Above the first box is slot 0; below the last, slot n.
 */
export function slotAt(boxes: readonly PieceBox[], y: number): number {
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index]
    if (y < box.top + (box.bottom - box.top) / 2) return index
    if (y < box.bottom) return index + 1
  }
  return boxes.length
}

/** What a slot means for the piece at `source`: nothing (in place), or the path it goes before and its new 1-based place. */
export function dropFor(order: readonly string[], source: number, slot: number): { inPlace: true } | { inPlace: false; beforePath: string | null; position: number } {
  if (slot === source || slot === source + 1) return { inPlace: true }
  return { inPlace: false, beforePath: order[slot] ?? null, position: slot > source ? slot : slot + 1 }
}

/** The floating label during a drag. */
export const dragLabel = (title: string, position: number, total: number): string => `Move ${title} to ${position} of ${total}`

/** The flash, the live region, and the Undo texts. The live-region wording is the spec's; the flash is shorter. */
export const movedFlash = (title: string, position: number, total: number): string => `Moved ${title} to ${position} of ${total}`
export const movedAnnouncement = (title: string, position: number, total: number): string => `${title} moved to position ${position} of ${total}.`
export const addedFlash = (titles: readonly string[]): string =>
  titles.length === 1 ? `Added ${titles[0]} to the running order` : `Added ${titles.length} pieces to the running order`
export const addedAnnouncement = (titles: readonly string[], position: number, total: number): string =>
  titles.length === 1 ? `${titles[0]} added to the running order, position ${position} of ${total}.` : `${titles.length} pieces added to the running order.`
/** Undo of a move puts the ORDER back (a numbered Index Note is renumbered 1, 2, 3 by every Plan write, so its bytes may differ). */
export const undoneAnnouncement = (title: string, position: number, total: number): string => `Order restored. ${title} is back at position ${position} of ${total}.`
export const undoneAddAnnouncement = (count: number): string => (count === 1 ? 'Undone. 1 piece is out of the running order again.' : `Undone. ${count} pieces are out of the running order again.`)

/** The tooltip and the accessible name of an Add button. */
export const addTooltip = (title: string): string => `Add ${title} to the end of the running order`
export const addName = (title: string): string => `Add ${title} to the running order`
export const addAllTooltip = (count: number): string => `Add all ${count} to the end of the running order, in file-name order`
export const gripName = (title: string): string => `Drag to move ${title} in the running order`

/** One step the Undo flash can take back: the last change only, never a history. */
export type RunningOrderUndo =
  | { kind: 'move'; dir: string; path: string; title: string; before: string | null; after: string[] }
  | { kind: 'add'; dir: string; paths: string[]; titles: string[]; after: string[] }

/**
 * Which Folio an Undo step belongs to: the workspace root and the Folio's folder. The step is kept, offered
 * and run only for that Folio.
 */
export function folioScope(root: string | null, dir: string): string {
  return `${root ?? ''}\u0000${dir}`
}

/** Whether a step made for `stepScope` is kept while `openScope` is the Folio on screen (null = no Folio is open, as between two files). */
export function undoStepKept(stepScope: string, openScope: string | null): boolean {
  return openScope === null || openScope === stepScope
}

/** Whether a step made for `stepScope` may be offered and run: only while its own Folio is the one on screen. */
export function undoStepUsable(stepScope: string, openScope: string | null): boolean {
  return openScope === stepScope
}

/** The paths a main-side Add may take, in the order the caller gave, once duplicates are dropped. */
export function distinctPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)]
}

/** The row with keyboard focus in the Folio part, if any. */
export type FocusedFolioRow = { path: string; kind: 'piece' | 'also' } | null

export type CommandOutline = { pieces: ReadonlyArray<{ path: string; title: string }>; also: ReadonlyArray<{ path: string; title: string; addable?: boolean }> }

/**
 * What a keyless running-order command acts on: the focused row of the right kind, else the open file.
 * The answer is a path and, for a move, the piece it goes before (null = the end); or the sentence to say instead.
 */
export function commandTarget(
  command: 'up' | 'down' | 'add',
  focused: FocusedFolioRow,
  activePath: string | null,
  outline: CommandOutline,
): { path: string; title: string; beforePath: string | null } | { message: string } {
  if (command === 'add') {
    const path = focused?.kind === 'also' ? focused.path : activePath
    const file = outline.also.find((item) => item.path === path)
    if (!file) return { message: 'Focus a file under Also in this folder, or open one, to add it to the running order.' }
    if (!file.addable) return { message: `${file.title} cannot join the running order: covers, Index Notes and underscore-prefixed files are never part of a Folio.` }
    return { path: file.path, title: file.title, beforePath: null }
  }
  const path = focused?.kind === 'piece' ? focused.path : activePath
  const at = outline.pieces.findIndex((item) => item.path === path)
  if (at < 0) return { message: 'Focus a piece of the running order, or open one, to move it.' }
  const title = outline.pieces[at].title
  if (command === 'up') {
    return at === 0 ? { message: `${title} is already first in the running order.` } : { path: outline.pieces[at].path, title, beforePath: outline.pieces[at - 1].path }
  }
  return at === outline.pieces.length - 1
    ? { message: `${title} is already last in the running order.` }
    : { path: outline.pieces[at].path, title, beforePath: outline.pieces[at + 2]?.path ?? null }
}
