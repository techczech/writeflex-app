/**
 * The Folio room's order writes (ticket 11; spec-folio-room-data-model § 8 D-ORD-1/2, § 9 D-WRITE-1, § 2 D-PART-2):
 * reorder (a card or Outline row dragged, ⌥↑↓, and the Undo of each), New card and its Undo. Every function takes the
 * room's pinned view (`FolioWorkspace`), never a bare Workspace, so each file it writes is physically inside the Folio
 * (I-2), and writes through the Plan's existing routes only:
 *
 * - Reorder is one call of the whole-order route `reorderPlanParts` (plan-running-order.ts → `reorderParts`) with
 *   `expected` = the running order as the room showed it and `createManifest: true`. A Folio with no Index Note takes
 *   that route's manifest-only branch (the order stays manifest-only). Refused before anything is read while two
 *   running-order lines share a title (D-PART-2): the key `{ title, path }` cannot tell two unwritten "Results" apart.
 *   The route checks `expected` again on the read the write is made from, so the order it writes is the one shown.
 * - New card is one `insertPart` (an unwritten plan line at the end of the running order) with `createManifest` and,
 *   for a Folio with no Index Note file, `createsIndexNote` (spec § 12). Refused when its title is a part's already,
 *   is the name of the Index Note or of a file under Not in the outline (title or file name), or would name any other
 *   file once written (so the card is always unwritten), or when the running order is not `expected`: each judged on
 *   the read the write is made from, before anything is written (review S-1, S-5).
 * - A write that creates the manifest says so (`manifestCreated`), with the files that manifest keeps in export and
 *   the running order does not list (`notInRunningOrder`, ticket 06's rule made visible, review S-2), read again
 *   after the write (a read, I-4).
 * - The Undo of New card is one `removePart` of that line, only while the running order is exactly the one New card
 *   left (`expected`) and the line is still that unwritten card.
 *
 * Every refusal is an answer (`ok: false`) in plain words with nothing written; the Plan writers commit only over the
 * bytes they read (I-6). Nothing here reads the disk for its own sake, so a refusal before the write reads nothing more.
 */

import { posix } from 'node:path'
import { MANIFEST_NAME } from './folio'
import type { FolioWorkspace } from './folio-workspace'
import { readExportOrderAgreement } from './folio-order-assessment'
import { insertPart, PlanWrittenButNotReRead, removePart, type Plan, type PlanPart, type PlanWriteOptions } from './plan'
import { planPartKeys, reorderPlanParts, type PlanOrderOutcome } from './plan-running-order'
import type { Workspace } from './workspace'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import { STALE_PLAN_MESSAGE, samePlanParts, type PlanPartKey } from '../shared/folio-running-order'
import {
  NEW_CARD_INDEX_NOTE, clashRefusal, clashingTitle, newCardFileRefusal, newCardLooseRefusal, newCardTitle,
  type NewCardFolio, type RoomCardResult, type RoomOrderResult,
} from '../shared/folio-room-order'

/** A room reorder's answer and what main tells the open views (as `PlanOrderOutcome`). */
export type RoomOrderOutcome = Omit<PlanOrderOutcome, 'result'> & { result: RoomOrderResult }
/** New card's answer, and the Plan it left (null: refused, or written and not read again). */
export type RoomCardOutcome = { result: RoomCardResult; plan: Plan | null; writtenIndex?: string }

const STALE_CARD = 'The running order changed. The room has been refreshed; nothing was changed.'
const NOT_THAT_CARD = 'That card is no longer the new card that was added, so it was not taken out. Nothing was changed.'

/** Thrown inside `verifyPlan` to refuse; caught below and answered in plain words. */
class RoomRefusal extends Error {
  constructor(message: string, readonly stale: boolean) { super(message) }
}

const plain = (fws: FolioWorkspace, error: unknown): string => withoutAbsolutePaths(error instanceof Error ? error.message : String(error), fws.root)
const manifestOf = (dir: string): string => (dir === '' ? MANIFEST_NAME : posix.join(dir, MANIFEST_NAME))

/** What New card compares a title with on the write's own read: Not in the outline and the Index Note (`newCardTitle`). */
const folioOf = (plan: Plan): NewCardFolio => ({
  notInOutline: plan.unlisted.map((part) => ({ title: part.title, path: part.path })),
  indexNote: plan.indexNoteAbsent ? null : { path: plan.indexPath },
})

/** The new card's line resolves to a file (its title, file name or alias names one): refused, in the words for that file. */
function refuseWrittenCard(part: PlanPart, plan: Plan): void {
  const path = part.path
  if (path === null) return
  if (path === plan.indexPath) throw new RoomRefusal(NEW_CARD_INDEX_NOTE, false)
  const name = posix.basename(path)
  throw new RoomRefusal(plan.unlisted.some((loose) => loose.path === path) ? newCardLooseRefusal(name) : newCardFileRefusal(name), false)
}

/**
 * After a write that created the manifest: the files it lists that the running order does not (ticket 06 keeps them in
 * export, after the written parts). A fresh read, writing nothing (I-4); empty when it cannot be read.
 */
export async function notInRunningOrderNow(ws: Workspace, dir: string): Promise<string[]> {
  try {
    const read = await readExportOrderAgreement(ws, dir)
    return read?.agreement.kind === 'disagree' ? [...read.agreement.notInRunningOrder] : []
  } catch {
    return []
  }
}

/** The `manifestCreated` fields of an answer: the flag, and the files not in the running order when there are any. */
async function manifestCreatedFields(ws: Workspace, dir: string): Promise<{ manifestCreated: true; notInRunningOrder?: string[] }> {
  const strays = await notInRunningOrderNow(ws, dir)
  return { manifestCreated: true, ...(strays.length > 0 ? { notInRunningOrder: strays } : {}) }
}

/**
 * Put the running order in `order` (`order[k]` = the index into `expected` of the part that goes to k): a drag, ⌥↑↓,
 * or the Undo of one (its `order` the inverse, its `expected` the order the write left). `manifestCreated` when this
 * write made the Folio's manifest (an Index-only Folio, D-ORD-2).
 */
export async function reorderRoomParts(fws: FolioWorkspace, input: { order: number[]; expected: PlanPartKey[] }, options: PlanWriteOptions = {}): Promise<RoomOrderOutcome> {
  const clash = clashingTitle(input.expected.map((part) => part.path ?? part.title))
  if (clash !== null) return { result: { ok: false, stale: false, message: clashRefusal(clash) }, plan: null }
  // Read on the write's own read, under the Folio's lock: whether a manifest was there before this write.
  let manifestBefore: boolean | null = null
  const outcome = await reorderPlanParts(fws, fws.folioDir, { order: input.order, expected: input.expected }, {
    ...options,
    // One plan load (spec folio-workspace § 5): the room reads itself once after the write.
    readAgain: false,
    createManifest: true,
    verifyPlan: (_plan, loaded) => { manifestBefore = loaded.manifestExists },
  })
  const created = outcome.result.ok && outcome.result.changed && manifestBefore === false
  return created ? { ...outcome, result: { ...outcome.result, ...await manifestCreatedFields(fws, fws.folioDir) } } : outcome
}

/** New card: the unwritten part `title` at the end of the running order, only while the running order is `expected`. */
export async function addRoomCard(fws: FolioWorkspace, input: { title: string; expected: PlanPartKey[] }, options: PlanWriteOptions = {}): Promise<RoomCardOutcome> {
  const checked = newCardTitle(input.title, input.expected)
  if (!checked.ok) return { result: { ok: false, stale: false, message: checked.message }, plan: null }
  const { title } = checked
  const at = input.expected.length
  let manifestBefore: boolean | null = null
  try {
    const plan = await insertPart(fws, fws.folioDir, at, { title }, {
      ...options,
      readAgain: false,
      createsIndexNote: true,
      createManifest: true,
      verifyPlan: (fresh, loaded) => {
        if (!samePlanParts(planPartKeys(fresh), input.expected)) throw new RoomRefusal(STALE_CARD, true)
        const again = newCardTitle(title, fresh.parts, folioOf(fresh))
        if (!again.ok) throw new RoomRefusal(again.message, false)
        manifestBefore = loaded.manifestExists
      },
      verifyInsertedPart: refuseWrittenCard,
    })
    const index = plan.parts.findIndex((part) => part.title === title && part.path === null)
    const created = await manifestCreatedBy(fws, manifestBefore)
    return { result: { ok: true, parts: planPartKeys(plan), index: index < 0 ? at : index, ...created }, plan, writtenIndex: plan.indexPath }
  } catch (error) {
    if (error instanceof RoomRefusal) return { result: { ok: false, stale: error.stale, message: error.message }, plan: null }
    if (error instanceof PlanWrittenButNotReRead) {
      // Written, and not read again: the manifest sentence is still said when this write created it (review T-4).
      const parts = [...input.expected, { title, path: null }]
      return { result: { ok: true, parts, index: at, ...await manifestCreatedBy(fws, manifestBefore) }, plan: null, writtenIndex: error.indexPath }
    }
    return { result: { ok: false, stale: false, message: plain(fws, error) }, plan: null }
  }
}

/** The `manifestCreated` fields when the write found no manifest (`before` false) and one is there now; else none. */
async function manifestCreatedBy(fws: FolioWorkspace, before: boolean | null): Promise<{ manifestCreated?: true; notInRunningOrder?: string[] }> {
  if (before !== false || !await fws.readFile(manifestOf(fws.folioDir)).then(() => true, () => false)) return {}
  return manifestCreatedFields(fws, fws.folioDir)
}

/** The Undo of New card: take out the unwritten line `title` at `index`, only while the running order is `expected` (what New card left). */
export async function removeRoomCard(fws: FolioWorkspace, input: { index: number; title: string; expected: PlanPartKey[] }, options: PlanWriteOptions = {}): Promise<RoomOrderOutcome> {
  const { index, title, expected } = input
  const named = expected[index]
  if (!Number.isInteger(index) || !named || named.title !== title || named.path !== null) {
    return { result: { ok: false, stale: true, message: NOT_THAT_CARD }, plan: null }
  }
  try {
    const plan = await removePart(fws, fws.folioDir, index, {
      ...options,
      readAgain: false,
      verifyPlan: (fresh) => {
        if (!samePlanParts(planPartKeys(fresh), expected)) throw new RoomRefusal(STALE_PLAN_MESSAGE, true)
      },
    })
    return { result: { ok: true, changed: true, parts: planPartKeys(plan) }, plan, writtenIndex: plan.indexPath }
  } catch (error) {
    if (error instanceof RoomRefusal) return { result: { ok: false, stale: error.stale, message: error.message }, plan: null }
    if (error instanceof PlanWrittenButNotReRead) {
      return { result: { ok: true, changed: true, parts: expected.filter((_, at) => at !== index) }, plan: null, writtenIndex: error.indexPath }
    }
    return { result: { ok: false, stale: false, message: plain(fws, error) }, plan: null }
  }
}
