/**
 * The Plan's own whole-order changes: "Sort by chapter number", "Add all from this folder", and their Undo.
 * These functions write nothing themselves: every write is `reorderParts` or `adoptParts` in plan.ts, with all
 * of their guards, exactly as the Plan's single move and adopt are; the Undo of an Add all writes back the exact
 * documents that Add found (folio-add-undo.ts).
 *
 * Unlike the Outline's routes (folio-running-order.ts) they do not need the manifest to agree with the Index
 * Note, or a manifest at all: in the Plan, the Index Note's running order is the order, and the manifest
 * follows it when there is one. A part with no file yet is a part like any other: it keeps its place.
 *
 * What they add to the Plan writes:
 * - One hold of the Folio's lock (plan-lock.ts) around the whole request.
 * - The caller names the running order it was looking at, as every part's title and file (`expected`). It
 *   must be the Plan's order on the first read and again on the read the write is made from
 *   (`PlanWriteOptions.verifyPlan`). Otherwise the request is refused as stale and nothing is written.
 *
 * A Folio with a manifest and no Index Note file has no Plan to write. Its requests go to the Outline's
 * manifest-only routes, by path, under the same lock; they write the manifest only and never create an
 * Index Note. Which of the two a request is, is decided inside the lock, on whether the Index Note exists.
 */

import { indexNoteExists } from './folio-manifest-order'
import { addFolioPieces, reorderFolioPieces, type RunningOrderOutcome } from './folio-running-order'
import { recordingAdd, undoRecordedAdd } from './folio-add-undo'
import { folioPieces } from './folio'
import { adoptParts, PlanWrittenButNotReRead, UNNAMEABLE_REFUSAL, readPlan, reorderParts, type Plan, type PlanWriteOptions } from './plan'
import { withPlanLock } from './plan-lock'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import { isFrontMatterRole, orderAfterAdd } from '../shared/folio-front-matter'
import {
  STALE_PLAN_MESSAGE,
  notNamedSentence,
  planMessageFor,
  distinctPaths,
  samePlanParts,
  type PlanAddInput,
  type PlanOrderResult,
  type PlanPartKey,
  type PlanRemoveAddedInput,
  type PlanReorderInput,
} from '../shared/folio-running-order'

/** As `RunningOrderOutcome`: `plan` is the Plan a write left, `manifestOnly` a manifest-only write, `writtenIndex` the Index Note written. */
export type PlanOrderOutcome = { result: PlanOrderResult; plan: Plan | null; manifestOnly?: true; writtenIndex?: string }

const NOT_A_NEW_ORDER = 'That is not a new order for this running order. Nothing was changed.'
const NO_PLAN = 'This folder’s Index Note could not be read, so its running order cannot be changed.'
const NOT_ADDABLE = 'Only files in this folder that are in neither the running order nor the manifest can be added this way. Nothing was added.'

/** Thrown by `verifyPlan` when the Plan the write read is not the one the caller saw. */
class StaleOrder extends Error {}

const refused = (message: string): PlanOrderOutcome => ({ result: { ok: false, stale: false, message }, plan: null })
const stale = (message: string): PlanOrderOutcome => ({ result: { ok: false, stale: true, message }, plan: null })
const plain = (ws: Workspace, error: unknown): string => withoutAbsolutePaths(error instanceof Error ? error.message : String(error), ws.root)

export const planPartKeys = (plan: Pick<Plan, 'parts'>): PlanPartKey[] => plan.parts.map((part) => ({ title: part.title, path: part.path }))

const done = (written: Plan): PlanOrderOutcome => ({ result: { ok: true, changed: true, parts: planPartKeys(written) }, plan: written, writtenIndex: written.indexPath })
const madeUnread = (error: PlanWrittenButNotReRead, parts: PlanPartKey[]): PlanOrderOutcome => ({ result: { ok: true, changed: true, parts }, plan: null, writtenIndex: error.indexPath })
const fileNames = (paths: readonly string[]): string[] => paths.map((path) => path.slice(path.lastIndexOf('/') + 1))
/** A successful Add that left some asked files out: it says which, and why (`notNamedSentence`). */
function withSkipped(outcome: PlanOrderOutcome, skipped: readonly string[]): PlanOrderOutcome {
  if (!skipped.length || !outcome.result.ok) return outcome
  return { ...outcome, result: { ...outcome.result, skipped: [...skipped], note: notNamedSentence(fileNames(skipped), false) } }
}

function assertKeys(expected: readonly PlanPartKey[], paths: readonly string[] = []): void {
  for (const path of paths) assertRelativeWorkspacePath(path)
  for (const part of expected) if (part.path !== null) assertRelativeWorkspacePath(part.path)
}

/** The read every Plan request starts from, under the lock: the Plan must be exactly the one the caller saw. */
async function seenPlan(ws: Workspace, dir: string, expected: readonly PlanPartKey[], staleMessage: string): Promise<Plan | PlanOrderOutcome> {
  const plan = await readPlan(ws, dir)
  if (!plan) return refused(NO_PLAN)
  if (!samePlanParts(planPartKeys(plan), expected)) return stale(staleMessage)
  return plan
}
const isOutcome = (value: Plan | PlanOrderOutcome): value is PlanOrderOutcome => 'result' in value

/** The check a Plan write makes against its own read: still exactly the running order the caller saw, and whatever else the request depends on. */
function verifier(expected: readonly PlanPartKey[], alsoHolds: (fresh: Plan) => boolean = () => true): PlanWriteOptions['verifyPlan'] {
  return (fresh: Plan): void => {
    if (!samePlanParts(planPartKeys(fresh), expected) || !alsoHolds(fresh)) throw new StaleOrder()
  }
}

/** A Folio with no Index Note: the running order is the manifest's, which only lists files. */
const expectedPaths = (expected: readonly PlanPartKey[]): string[] | null =>
  expected.every((part) => part.path !== null) ? expected.map((part) => part.path as string) : null

/** An Outline manifest-only answer, said the Plan's way. Titles are the caller's where it named the file. */
function fromManifestOnly(outcome: RunningOrderOutcome, expected: readonly PlanPartKey[]): PlanOrderOutcome {
  const titles = new Map(expected.flatMap((part) => (part.path ? [[part.path, part.title] as const] : [])))
  const keys = (paths: readonly string[]): PlanPartKey[] => paths.map((path) => ({ title: titles.get(path) ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, ''), path }))
  const { result } = outcome
  const mapped: PlanOrderResult = result.ok
    ? {
        ok: true,
        changed: result.changed,
        parts: keys(result.order),
        ...(result.undoToken ? { undoToken: result.undoToken } : {}),
        ...(result.skipped ? { skipped: result.skipped, note: result.note } : {}),
      }
    : { ok: false, stale: result.stale, message: planMessageFor(result.message) }
  return { result: mapped, plan: outcome.plan, ...(outcome.manifestOnly ? { manifestOnly: true as const } : {}), ...(outcome.writtenIndex ? { writtenIndex: outcome.writtenIndex } : {}) }
}

function isPermutation(order: readonly number[], count: number): boolean {
  return order.length === count && new Set(order).size === count && order.every((index) => Number.isInteger(index) && index >= 0 && index < count)
}

/**
 * Put the whole running order in `order` (`order[k]` = the index into `expected` of the part that goes to
 * position k), in one write through `reorderParts`. Sort by chapter number and its Undo. Parts with no file
 * are moved like any other; Sort's order leaves them where they are (shared/folio-chapter-order.ts).
 */
export async function reorderPlanParts(ws: Workspace, dir: string, input: Omit<PlanReorderInput, 'dir'>, options: PlanWriteOptions = {}): Promise<PlanOrderOutcome> {
  const { order, expected } = input
  assertKeys(expected)
  if (!isPermutation(order, expected.length)) return refused(NOT_A_NEW_ORDER)
  const target = order.map((index) => expected[index])
  return withPlanLock(ws, dir, async () => {
    if (!indexNoteExists(ws, dir)) {
      const paths = expectedPaths(expected)
      if (!paths) return stale(STALE_PLAN_MESSAGE)
      return fromManifestOnly(await reorderFolioPieces(ws, dir, { order: order.map((index) => paths[index]), expected: paths }, options), expected)
    }
    const seen = await seenPlan(ws, dir, expected, STALE_PLAN_MESSAGE)
    if (isOutcome(seen)) return seen
    if (order.every((from, to) => from === to)) return { result: { ok: true, changed: false, parts: [...expected] }, plan: null }
    try {
      return done(await reorderParts(ws, dir, [...order], { ...options, verifyPlan: verifier(expected) }))
    } catch (error) {
      if (error instanceof PlanWrittenButNotReRead) return madeUnread(error, target)
      if (error instanceof StaleOrder) return stale(STALE_PLAN_MESSAGE)
      return refused(plain(ws, error))
    }
  })
}

/**
 * Add files at the end of the running order, in the order given, in one write (`adoptParts`). A file can be
 * added only if the Plan lists it as an unlisted file the manifest does not already carry: the files the
 * Add-all sheet offers (shared/folio-add-all.ts), asked again on this read.
 */
export async function addPlanParts(ws: Workspace, dir: string, input: Omit<PlanAddInput, 'dir'>, options: PlanWriteOptions = {}): Promise<PlanOrderOutcome> {
  const paths = distinctPaths(input.paths)
  const { expected } = input
  assertKeys(expected, paths)
  if (paths.length === 0) return refused('There is no file to add.')
  // Its Undo is tied to this Add: the documents before and after it are kept under this same hold (folio-add-undo.ts).
  return withPlanLock(ws, dir, () => recordingAdd(ws, dir, async (): Promise<PlanOrderOutcome> => {
    if (!indexNoteExists(ws, dir)) {
      const seenPaths = expectedPaths(expected)
      if (!seenPaths) return stale(STALE_PLAN_MESSAGE)
      return fromManifestOnly(await addFolioPieces(ws, dir, { paths, expected: seenPaths }, options), expected)
    }
    const seen = await seenPlan(ws, dir, expected, STALE_PLAN_MESSAGE)
    if (isOutcome(seen)) return seen
    if (paths.some((path) => seen.parts.some((part) => part.path === path))) return stale(STALE_PLAN_MESSAGE)
    const rows = paths.map((path) => seen.unlisted.findIndex((part) => part.path === path && part.manifestBacked === false && (!part.putBackRefusal || part.putBackRefusal === UNNAMEABLE_REFUSAL)))
    if (rows.some((index) => index < 0)) return refused(NOT_ADDABLE)
    // A file no running-order line can name alone (`UNNAMEABLE_REFUSAL`) is not added: named, and the rest go in.
    const skipped = paths.filter((_, at) => seen.unlisted[rows[at]].putBackRefusal === UNNAMEABLE_REFUSAL)
    if (skipped.length === paths.length) return refused(notNamedSentence(fileNames(skipped), true))
    const taking = paths.filter((path) => !skipped.includes(path))
    const indices = rows.filter((_, at) => !skipped.includes(paths[at]))
    const added = indices.map((index) => ({ title: seen.unlisted[index].title, path: seen.unlisted[index].path }))
    const stillThere = (fresh: Plan): boolean => indices.every((index, at) => fresh.unlisted[index]?.path === taking[at] && fresh.unlisted[index]?.manifestBacked === false && !fresh.unlisted[index]?.putBackRefusal)
    try {
      return withSkipped(done(await adoptParts(ws, dir, indices, { ...options, verifyPlan: verifier(expected, stillThere) })), skipped)
    } catch (error) {
      if (error instanceof PlanWrittenButNotReRead) {
        // Where adoptParts put them (ADR-0046): front matter at the end of its block, the rest at the end.
        const frontAdded = new Set(indices.filter((index) => isFrontMatterRole(seen.unlisted[index].role)).map((index) => seen.unlisted[index].path))
        const isFront = (part: PlanPartKey): boolean => {
          const at = expected.indexOf(part)
          return at >= 0 ? isFrontMatterRole(seen.parts[at]?.role) : frontAdded.has(part.path)
        }
        return withSkipped(madeUnread(error, orderAfterAdd(expected, added, isFront)), skipped)
      }
      if (error instanceof StaleOrder) return stale(STALE_PLAN_MESSAGE)
      return refused(plain(ws, error))
    }
  }))
}

/**
 * Undo of an Add all, by the token that Add returned (folio-add-undo.ts): the Folio's Index Note and manifest must
 * hold exactly what that Add left, and both are written back to exactly what they held before it, under one hold
 * of the lock. Anything else is refused as stale and nothing is written. A Folio with no Index Note is the same:
 * its manifest alone goes back.
 */
export async function removeAddedPlanParts(ws: Workspace, dir: string, input: Omit<PlanRemoveAddedInput, 'dir'>, options: PlanWriteOptions = {}): Promise<PlanOrderOutcome> {
  return withPlanLock(ws, dir, async () => {
    const undone = await undoRecordedAdd(ws, dir, input.token, options)
    if (!undone.ok) {
      const refusal = undone.stale ? stale(undone.message) : refused(undone.message)
      // A split Undo (one document changed, its take-back failed) still tells the buffers and the collection, as a success does.
      if (undone.wroteIndex && undone.indexPath) return { ...refusal, writtenIndex: undone.indexPath }
      if (undone.wroteManifest) return { ...refusal, manifestOnly: true }
      return refusal
    }
    if (!undone.indexExists) {
      const order = (await folioPieces(ws, dir).catch(() => null))?.pieces ?? []
      return fromManifestOnly({ result: { ok: true, changed: true, order }, plan: null, manifestOnly: true }, [])
    }
    const plan = await readPlan(ws, dir).catch(() => null)
    return plan ? done(plan) : { result: { ok: true, changed: true, parts: [] }, plan: null, writtenIndex: undone.indexPath }
  })
}
