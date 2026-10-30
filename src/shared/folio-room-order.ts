/**
 * The Folio room's order writes, as plain data (ticket 11; spec-folio-room-data-model § 2 D-PART-2, § 8 D-ORD-2/3, § 9,
 * § 12): the permutation a drag or ⌥↑↓ asks for, the title-clash refusal, the New card title check, and the sentences
 * the room says. Pure: nothing here reads or writes a file. Main (folio-room-writes.ts) makes every decision again on
 * its own read under the Folio's lock; the renderer uses these to ask and to word the answer.
 */

import { exportOrderLine, type ExportOrderCheck } from './export-order-agreement'
import { isAgentInstructionsName } from './folio-agent-files'
import { isRoomSupportName } from './folio-part-name'
import { titleKey } from './folio-room'
import type { PlanOrderResult, PlanPartKey } from './folio-running-order'

/** Said by the first room write that creates the Folio's manifest (D-ORD-2), and by the Index-only banner's repair. */
export const MANIFEST_CREATED = 'This Folio now has a manifest, so export and sharing follow its running order.'
/** The Index-only banner (spec § 12): an Index Note with a running order and no manifest. */
export const INDEX_ONLY_BANNER = 'Export and sharing follow file names until this Folio’s order is written'
/** The banner's button, the same words as the export sheet's (D-ORD-3). */
export { EXPORT_ORDER_REPAIR } from './export-order-agreement'

/** D-PART-2: an order write (drag, ⌥↑↓, Undo of either) refused while two running-order lines share a title. */
export const clashRefusal = (title: string): string =>
  `Two parts are called ‘${title}’. Rename one before changing the running order. Nothing was changed.`
/** New card refused: its title is already a part's (D-PART-2). */
export const newCardClashRefusal = (title: string): string =>
  `A part called ‘${title}’ is already in the running order. Give the new card another title. Nothing was added.`
export const NEW_CARD_NEEDS_TITLE = 'Type a title for the new card. Nothing was added.'
/** A title no running-order line can hold (`serialisePlanLine`: `#`, `|`, `]]` or a line break). */
export const NEW_CARD_TITLE_UNWRITABLE = 'A part title cannot hold #, |, ]] or a line break. Nothing was added.'

/** New card refused: its title names a file already in the Folio, listed under Not in the outline (review S-1). */
export const newCardLooseRefusal = (name: string): string =>
  `A file called ${name} is already in this Folio under Not in the outline. Drag it into the order instead of making a new card.`
/** New card refused: its title is the Index Note's own name (review S-5). */
export const NEW_CARD_INDEX_NOTE = 'That title is the name of the Folio’s own Index Note. Choose another title.'
/** New card refused: its title is the name of a file the Folio keeps for itself (manifest, notes, map, agent instructions). */
export const NEW_CARD_RESERVED = 'That title is the name of a file this Folio keeps for itself. Choose another title.'
/** New card refused: its title already names some other file in the Folio, so the line would not be an unwritten card. */
export const newCardFileRefusal = (name: string): string => `A file called ${name} is already in this Folio. Choose another title.`

/** What New card compares a title with besides the running order: the Folio's loose files and its Index Note. */
export type NewCardFolio = {
  /** The files listed under Not in the outline: each one's derived title and its path. */
  notInOutline: ReadonlyArray<{ title: string; path: string | null }>
  /** The Folio's Index Note (its path, and its title when known), or null when it has none yet. */
  indexNote: { path: string; title?: string | null } | null
}

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
const fileStem = (path: string): string => fileName(path).replace(/\.(?:md|markdown|mdx)$/i, '')

/** The sentence refusing `title` as the name of one of the Folio's files (`folio`), or null. Judged by the title key. */
function folioNameRefusal(title: string, folio: NewCardFolio): string | null {
  const key = titleKey(title)
  const index = folio.indexNote
  if (index && (titleKey(fileStem(index.path)) === key || (index.title && titleKey(index.title) === key))) return NEW_CARD_INDEX_NOTE
  // A name no part can have: `_`-prefixed (Index Notes, the manifest and its siblings), agent instructions, room support files.
  if (title.startsWith('_') || isAgentInstructionsName(`${title}.md`) || isAgentInstructionsName(title) || isRoomSupportName(title) || isRoomSupportName(`${title}.md`)) return NEW_CARD_RESERVED
  const loose = folio.notInOutline.find((file) => file.path !== null && (titleKey(file.title) === key || titleKey(fileStem(file.path)) === key))
  return loose?.path ? newCardLooseRefusal(fileName(loose.path)) : null
}

/** The first title (as written) that two or more of `titles` share under the Plan's title key, or null. */
export function clashingTitle(titles: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const title of titles) {
    const key = titleKey(title)
    if (seen.has(key)) return title
    seen.add(key)
  }
  return null
}

/**
 * The trimmed New card title, or the sentence that refuses it: empty, unwritable, a clash with a part in `parts`, or,
 * given `folio`, the name of the Index Note, of a file the Folio keeps for itself, or of a file under Not in the outline
 * (its derived title or its file name).
 */
export function newCardTitle(raw: string, parts: readonly Pick<PlanPartKey, 'title'>[], folio?: NewCardFolio): { ok: true; title: string } | { ok: false; message: string } {
  const title = raw.trim()
  if (title === '') return { ok: false, message: NEW_CARD_NEEDS_TITLE }
  if (title.includes(']]') || /[|#\r\n]/.test(title)) return { ok: false, message: NEW_CARD_TITLE_UNWRITABLE }
  if (parts.some((part) => titleKey(part.title) === titleKey(title))) return { ok: false, message: newCardClashRefusal(title) }
  const named = folio ? folioNameRefusal(title, folio) : null
  if (named) return { ok: false, message: named }
  return { ok: true, title }
}

/**
 * The whole-order permutation (`order[k]` = the index of the part that goes to position k) that moves the part at
 * `from` to position `to`, every other part keeping its order. Null when either is out of range or they are equal.
 */
export function moveOrder(count: number, from: number, to: number): number[] | null {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= count || to >= count || from === to) return null
  const order = Array.from({ length: count }, (_, index) => index)
  order.splice(from, 1)
  order.splice(to, 0, from)
  return order
}

/** Said after New card. */
export const newCardFlash = (title: string, position: number, total: number): string => `Added ${title} as an unwritten part, ${position} of ${total}`
/** Said after the Undo of New card. */
export const undoneNewCardAnnouncement = (title: string): string => `Undone. ${title} is out of the running order again.`
/**
 * The files a created manifest lists that the running order does not (ticket 06 keeps them in export, after the written
 * parts; review S-2): "1 file not in the running order stays in export, at the end: extra.md." Up to three names, then
 * "and n more". Empty when there are none.
 */
export function notInRunningOrderSentence(paths: readonly string[] | undefined): string {
  if (!paths || paths.length === 0) return ''
  const names = paths.slice(0, 3).map(fileName).join(', ')
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : ''
  return paths.length === 1
    ? `1 file not in the running order stays in export, at the end: ${names}.`
    : `${paths.length} files not in the running order stay in export, at the end: ${names}${more}.`
}
/** The manifest-created sentence, with the files not in the running order the new manifest keeps in export, if any. */
export const manifestCreatedSentence = (notInRunningOrder?: readonly string[]): string =>
  [MANIFEST_CREATED, notInRunningOrderSentence(notInRunningOrder)].filter(Boolean).join(' ')
/** A sentence with the manifest sentence after it when this write created the manifest. */
export const withManifestNote = (text: string, manifestCreated: boolean | undefined, notInRunningOrder?: readonly string[]): string => (
  manifestCreated ? `${text}. ${manifestCreatedSentence(notInRunningOrder)}` : text
)

/**
 * What main answers to a room order write: the Plan's answer, and whether this write created the manifest, with the
 * files that manifest lists and the running order does not (`notInRunningOrder`, set only with `manifestCreated`).
 */
export type RoomOrderResult = PlanOrderResult & { manifestCreated?: true; notInRunningOrder?: string[] }

/** What main answers to New card: the running order it left (for the Undo step) and where the card went. */
export type RoomCardResult =
  | { ok: true; parts: PlanPartKey[]; index: number; manifestCreated?: true; notInRunningOrder?: string[] }
  | { ok: false; stale: boolean; message: string }

/**
 * The room's banner for a Folio's export order (spec § 8 D-ORD-3 and § 12): the export sheet's out-of-step line, or
 * the Index-only line when the Folio has written parts and no manifest. Both offer Make export follow the running
 * order. Null: no banner.
 */
export function roomOrderLine(check: ExportOrderCheck | null, hasWrittenParts: boolean): { lines: string[]; repair: boolean } | null {
  if (!check) return null
  if (check.agreement.kind === 'no-manifest') return hasWrittenParts ? { lines: [INDEX_ONLY_BANNER], repair: true } : null
  return exportOrderLine(check.agreement, check.unreadableMessage)
}
