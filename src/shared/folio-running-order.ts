/**
 * Changing a Folio's running order from the Outline: the pure rules main and the renderer share.
 * Nothing here touches a file. Every change names pieces by PATH, never by index, because an index
 * only means something against one read of the Plan and the Outline's list comes from another.
 */

/** What a running-order change asks main to do, by path. `expected` is the running order the caller was looking at. */
export type MovePieceInput = { dir: string; path: string; beforePath: string | null; expected: string[] }
export type AddPiecesInput = { dir: string; paths: string[]; expected: string[] }
/** Undo of an Add, by the token main returned for it (`undoToken`); main checks the Folio's documents are exactly as that Add left them. */
export type RemoveAddedInput = { dir: string; token: string }
/** Put the whole running order in `order` (a permutation of `expected`) in one write, by path. The Plan's Sort uses `PlanReorderInput` instead. */
export type ReorderPiecesInput = { dir: string; order: string[]; expected: string[] }

/**
 * The Plan's own running-order changes (Sort by chapter number, Add all from this folder, and their Undo).
 * The Plan names parts by position, and a part may have no file yet, so the running order the caller saw
 * is every part's title and file (`expected`): main refuses when the Plan is not exactly that any more.
 */
export type PlanPartKey = { title: string; path: string | null }
/** `order[k]` is the index (into `expected`) of the part that goes to position k. */
export type PlanReorderInput = { dir: string; order: number[]; expected: PlanPartKey[] }
export type PlanAddInput = { dir: string; paths: string[]; expected: PlanPartKey[] }
export type PlanRemoveAddedInput = { dir: string; token: string }
/** What main answers to them. `parts` is the running order after the change; `undoToken` as for `RunningOrderResult`. */
export type PlanOrderResult =
  | { ok: true; changed: boolean; parts: PlanPartKey[]; undoToken?: string; skipped?: string[]; note?: string }
  | { ok: false; stale: boolean; message: string }

export function samePlanParts(a: readonly PlanPartKey[], b: readonly PlanPartKey[]): boolean {
  return a.length === b.length && a.every((part, index) => part.title === b[index].title && part.path === b[index].path)
}
const ORDER_CHANGED = 'The running order changed.'
export const STALE_PLAN_MESSAGE = `${ORDER_CHANGED} The Folio outline has been refreshed.`
/** A role chosen on a card whose place in the running order is now another part's: refused, nothing written. */
export const STALE_ROLE_MESSAGE = `${ORDER_CHANGED} That part’s role was not changed. Nothing else was changed.`
/** A role chosen on a card that reads exactly like another card (same title, file, gloss, role and tags): refused, nothing written. */
export const AMBIGUOUS_ROLE_MESSAGE = 'Two cards in the running order read the same, so the role cannot be set on just one of them. Give one a different gloss first. Nothing was changed.'
/** Put back on a row that is no longer the file the owner saw (another writer changed the list meanwhile): refused, nothing written. */
export const STALE_PUT_BACK_MESSAGE = 'The files not in the outline changed. Look again: that file was not put back. Nothing else was changed.'

/**
 * A running-order card as the owner saw it, everything its line says: title, file (null = not written yet),
 * gloss, role and tags. Two unwritten cards with one title differ in the rest of their line (review round 2).
 */
export type PlanCardKey = PlanPartKey & { gloss: string | null; role: string; tags: string[] }

export function samePlanCard(a: PlanCardKey, b: PlanCardKey): boolean {
  return a.title === b.title && a.path === b.path && a.gloss === b.gloss && a.role === b.role
    && a.tags.length === b.tags.length && a.tags.every((tag, at) => tag === b.tags[at])
}

/**
 * Whether the card at `index` of `parts` is still `expected` and no other card reads the same. Null when it
 * is; otherwise the refusal to show. The role menu's check, run under the Folio's lock.
 */
export function planCardRefusal(parts: readonly PlanCardKey[], index: number, expected: PlanCardKey): string | null {
  const part = parts[index]
  if (!part || !samePlanCard(part, expected)) return STALE_ROLE_MESSAGE
  if (parts.filter((other) => samePlanCard(other, expected)).length > 1) return AMBIGUOUS_ROLE_MESSAGE
  return null
}

/**
 * Whether the "Not in the outline" row at `index` is still the file the owner saw (by file and title). Null
 * when it is; otherwise the refusal to show. Put back's check, run under the Folio's lock (review round 2 P1).
 */
export function unlistedRowRefusal(unlisted: readonly PlanPartKey[], index: number, expected: PlanPartKey): string | null {
  const row = unlisted[index]
  if (!row || expected.path === null || row.path !== expected.path || row.title !== expected.title) return STALE_PUT_BACK_MESSAGE
  if (unlisted.filter((other) => other.path === expected.path).length > 1) return STALE_PUT_BACK_MESSAGE
  return null
}

/**
 * An Add asked for files no running-order line can name alone (their title and their path both unholdable, or
 * shared): those are not added. The sentence names them; `refusal` when none of the asked files went in.
 */
export function notNamedSentence(names: readonly string[], refusal: boolean): string {
  const quoted = names.map((name) => `“${name}”`)
  const list = quoted.length <= 1 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`
  const subject = names.length === 1 ? `${list} was not added: no running-order line can name it` : `${list} were not added: no running-order line can name them`
  return `${subject}, because the title has a character a line cannot hold (# | or ]]) or another file here shares it, and the path cannot stand in. Rename ${names.length === 1 ? 'it' : 'them'} to add ${names.length === 1 ? 'it' : 'them'}.${refusal ? ' Nothing was added.' : ''}`
}

/**
 * What main answers. `stale` = the running order is no longer what the caller saw. `skipped`/`note`: on an Add, the
 * asked files that were not added and the sentence that names them (`notNamedSentence`); the rest were added. `undoToken` is set on a
 * successful Add: the Undo of that Add names it (folio-add-undo.ts).
 */
export type RunningOrderResult =
  | { ok: true; changed: boolean; order: string[]; undoToken?: string; skipped?: string[]; note?: string }
  | { ok: false; stale: boolean; message: string }

export const STALE_ORDER_MESSAGE = `${ORDER_CHANGED} The Outline has been refreshed.`
export const STALE_ADD_MESSAGE = STALE_ORDER_MESSAGE

/**
 * An Outline refusal said the Plan's way, for a Plan request answered by the Outline's manifest-only route:
 * the Outline's stale sentence becomes the Plan's; every other sentence names no surface and is kept.
 */
export function planMessageFor(outlineMessage: string): string {
  return outlineMessage === STALE_ORDER_MESSAGE ? STALE_PLAN_MESSAGE : outlineMessage
}
export const STALE_UNDO_MESSAGE = 'Could not undo: the running order has changed since.'
/** A Folio the Outline cannot change exactly: the refusal from main, and the line the Outline shows instead of its controls. */
export const OUTLINE_UNSAFE_MESSAGE = 'This Folio has entries the Outline cannot move safely. Open the Folio outline to change its order.'
/** Why a "Not in the outline" row's Put back is off. */
export const putBackWhy = (planOnly: boolean): string => (planOnly ? 'Order is changed in the Folio outline' : 'Put back from the Folio outline')

export const ORDER_IN_PLAN_LINE = 'Change this Folio’s order in the Folio outline.'

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
export const sortedAnnouncement = (count: number): string => `Sorted by chapter number. ${count} parts in the running order.`
export const sortedFlash = (count: number): string => `Sorted ${count} parts by chapter number.`
export const undoneSortAnnouncement = 'Undone. The running order is back as it was before the sort.'
export const undoneAddAnnouncement = (count: number): string => (count === 1 ? 'Undone. 1 piece is out of the running order again.' : `Undone. ${count} pieces are out of the running order again.`)

/** The tooltip and the accessible name of an Add button. */
export const addTooltip = (title: string): string => `Put ${title} back at the end of the running order`
export const addName = (title: string): string => `Put ${title} back in the running order`
export const addAllTooltip = (count: number): string => `Add all ${count} to the end of the running order, in chapter order`
export const gripName = (title: string): string => `Drag to move ${title} in the running order`

/** One step the Undo flash can take back: the last change only, never a history. */
export type RunningOrderUndo =
  | { kind: 'move'; dir: string; path: string; title: string; before: string | null; after: string[] }
  | { kind: 'add'; dir: string; paths: string[]; titles: string[]; after: string[]; token: string }
  | { kind: 'plan-reorder'; dir: string; order: number[]; after: PlanPartKey[] }
  | { kind: 'plan-add'; dir: string; paths: string[]; titles: string[]; after: PlanPartKey[]; token: string }

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

/**
 * The same two rules when more than one Folio is on screen (the open file's, in the Outline, and the one whose
 * Plan is shown): kept while none is on screen or its own is one of them; usable only while its own is one of them.
 */
export function undoStepKeptAmong(stepScope: string, openScopes: readonly string[]): boolean {
  return openScopes.length === 0 ? undoStepKept(stepScope, null) : openScopes.some((scope) => undoStepKept(stepScope, scope))
}

export function undoStepUsableAmong(stepScope: string, openScopes: readonly string[]): boolean {
  return openScopes.some((scope) => undoStepUsable(stepScope, scope))
}

/**
 * Whether the Undo may be offered and run now. While a Plan is shown (`planScope` not null) it covers the
 * Outline, so only a step made for the Plan's own Folio is usable; a step from the open file's Folio waits
 * (it is still kept, by `undoStepKeptAmong`) until the Plan is closed. Without a Plan: `undoStepUsable`.
 */
export function undoStepUsableOnScreen(stepScope: string, openScope: string | null, planScope: string | null): boolean {
  return planScope !== null ? stepScope === planScope : undoStepUsable(stepScope, openScope)
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
    if (!file) return { message: 'Focus a file under Not in the outline, or open one, to add it to the running order.' }
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

/**
 * `commandTarget` for Move up / Move down when the running order has front matter (ADR-0046): a piece moves only
 * among the pieces on its side of the boundary (front matter, or the contents), never across it. A front-matter
 * piece moved past the last front matter goes before the first contents piece, not to the end.
 */
export function blockCommandTarget(
  command: 'up' | 'down',
  focused: FocusedFolioRow,
  activePath: string | null,
  outline: { pieces: ReadonlyArray<{ path: string; title: string; frontMatter?: boolean }>; also: CommandOutline['also'] },
): { path: string; title: string; beforePath: string | null } | { message: string } {
  const path = focused?.kind === 'piece' ? focused.path : activePath
  const piece = outline.pieces.find((item) => item.path === path)
  if (!piece) return commandTarget(command, focused, activePath, outline)
  const front = piece.frontMatter === true
  const group = outline.pieces.filter((item) => (item.frontMatter === true) === front)
  const target = commandTarget(command, focused, activePath, { ...outline, pieces: group })
  if ('message' in target || target.beforePath !== null || !front) return target
  return { ...target, beforePath: outline.pieces.find((item) => item.frontMatter !== true)?.path ?? null }
}
