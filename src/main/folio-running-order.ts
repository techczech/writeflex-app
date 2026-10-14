/**
 * Changing a Folio's running order from the Outline, by path. These functions write nothing themselves:
 * every write is `movePart`, `adoptParts` or `removePart` in plan.ts, with all of their guards.
 *
 * What they add:
 * - One hold of the Folio's lock (plan-lock.ts) around the whole request: its read, its checks and its
 *   write or writes. No other Plan write in this process lands in between.
 * - The Folio must be one the Outline can change exactly (folio-order-assessment.ts): otherwise the
 *   request is refused and the owner is sent to the Plan.
 * - The caller names the running order it was looking at (`expected`). It must be the manifest's order
 *   and the Index Note's order, both, on the first read and again on the very read the write is made
 *   from (`PlanWriteOptions.verifyPlan`). Otherwise the request is refused as stale.
 * - `requireManifestWrite`: a write that would change the Index Note and not the manifest is refused
 *   before anything is written.
 *
 * A refusal writes nothing. An error from the write itself is answered as a refusal carrying the Plan
 * write's own sentence, with no absolute path in it. One error is not a refusal: `PlanWrittenButNotReRead`
 * (plan.ts), a write that was made and whose Plan could not be read again. It is answered as a change that
 * was made, with the running order the write was asked for, which every check before it established.
 *
 * A Folio with a manifest and NO Index Note file (every Folio "Make a Folio" has just made) has one
 * document. Its three routes go to folio-manifest-order.ts instead, under the same lock, with the same
 * `expected` check and the same refusals; they write the manifest only and never create an Index Note.
 * Which of the two a request is, is decided inside the lock, on whether the Index Note file exists.
 */

import { assessOutlineOrder, presentInFolio, readOutlineOrder, type OutlineOrderReason } from './folio-order-assessment'
import {
  appendManifestEntries,
  indexNoteExists,
  manifestOnlyAddable,
  moveManifestEntry,
  readManifestOnly,
  removeManifestTail,
  type ManifestOnlyRead,
} from './folio-manifest-order'
import { adoptParts, movePart, PlanWrittenButNotReRead, removePart, type Plan, type PlanLoadedManifest, type PlanWriteOptions } from './plan'
import { withPlanLock } from './plan-lock'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import {
  OUTLINE_UNSAFE_MESSAGE,
  STALE_ADD_MESSAGE,
  STALE_ORDER_MESSAGE,
  STALE_UNDO_MESSAGE,
  distinctPaths,
  resolveMove,
  sameOrder,
  type AddPiecesInput,
  type MovePieceInput,
  type RemoveAddedInput,
  type RunningOrderResult,
} from '../shared/folio-running-order'

/**
 * `plan` is the Plan a two-document write left; `manifestOnly` is set when a Folio with no Index Note had
 * its manifest written. `writtenIndex` is the Index Note's path whenever a two-document write was made,
 * including one whose Plan could not be read again afterwards (`plan` is then null, and `result` still
 * says the change was made): the caller tells the open buffers from it.
 */
export type RunningOrderOutcome = { result: RunningOrderResult; plan: Plan | null; manifestOnly?: true; writtenIndex?: string }

const NOT_ADDABLE = (count: number, asked: number): string =>
  `${count === 1 && asked === 1 ? 'That file cannot' : 'Those files cannot all'} be added: only Markdown files directly in the folder the Folio takes its pieces from, that are not covers, Index Notes or underscore-prefixed files, can join the running order. Nothing was added.`
const NO_MANIFEST = 'This folder’s running order follows its file names until the Folio has a manifest. Open the Plan to change it.'
const NO_INDEX = 'This Folio’s Index Note could not be read, so its running order cannot be changed here.'

/** Thrown by a check that finds the running order is not what the caller was shown. */
class StaleOrder extends Error {}

const refused = (message: string, plan: Plan | null = null): RunningOrderOutcome => ({ result: { ok: false, stale: false, message }, plan })
const stale = (message: string): RunningOrderOutcome => ({ result: { ok: false, stale: true, message }, plan: null })

const refusalFor = (reason: OutlineOrderReason): string =>
  reason === 'no-index' ? NO_INDEX : reason === 'no-manifest' ? NO_MANIFEST : OUTLINE_UNSAFE_MESSAGE

const plain = (ws: Workspace, error: unknown): string =>
  withoutAbsolutePaths(error instanceof Error ? error.message : String(error), ws.root)

function assertPaths(paths: readonly string[]): void {
  for (const path of paths) assertRelativeWorkspacePath(path)
}

type Seen = { plan: Plan; order: string[] }
const isOutcome = (value: Seen | RunningOrderOutcome): value is RunningOrderOutcome => 'result' in value

/**
 * The first read of a request, under the lock: the Folio must be one the Outline can change, and its
 * running order must be the one the caller saw. A sound manifest in another order than `expected` is
 * stale whatever the Index Note says; a manifest in the expected order that the Index Note disagrees
 * with is a Folio for the Plan.
 */
async function seenOrRefusal(ws: Workspace, dir: string, expected: readonly string[], staleMessage: string): Promise<Seen | RunningOrderOutcome> {
  const { assessment, plan } = await readOutlineOrder(ws, dir)
  if (!assessment.ok) {
    if (assessment.manifestOrder && !sameOrder(assessment.manifestOrder, expected)) return stale(staleMessage)
    return refused(refusalFor(assessment.reason))
  }
  if (!sameOrder(assessment.order, expected)) return stale(staleMessage)
  return { plan: plan!, order: assessment.order }
}

/**
 * The check a Plan write makes against its own read: still a Folio the Outline can change, still in
 * exactly the order `expected` (the manifest's and the Index Note's, which the assessment has found
 * equal), and whatever else the caller's index depends on.
 */
function verifier(ws: Workspace, dir: string, expected: readonly string[], alsoHolds: (fresh: Plan) => boolean): PlanWriteOptions['verifyPlan'] {
  return async (fresh: Plan, loaded: PlanLoadedManifest): Promise<void> => {
    const again = assessOutlineOrder(fresh, loaded.manifest, await presentInFolio(ws, dir))
    if (!again.ok || !sameOrder(again.order, expected) || !alsoHolds(fresh)) throw new StaleOrder()
  }
}

const done = (written: Plan): RunningOrderOutcome => ({
  result: { ok: true, changed: true, order: written.parts.flatMap((part) => (part.path ? [part.path] : [])) },
  plan: written,
  writtenIndex: written.indexPath,
})

/** A write that was made and could not be read again: still a change that was made, in the order it was asked for. */
const madeUnread = (error: PlanWrittenButNotReRead, order: string[]): RunningOrderOutcome => ({
  result: { ok: true, changed: true, order },
  plan: null,
  writtenIndex: error.indexPath,
})

type ManifestSeen = ManifestOnlyRead & { assessment: { ok: true; order: string[] } }
const isManifestSeen = (value: ManifestSeen | RunningOrderOutcome): value is ManifestSeen => 'assessment' in value

/**
 * The one read of a manifest-only request, under the lock: the manifest must be one that can be changed
 * exactly, and its order must be the one the caller saw. The write is made from this same read.
 */
async function manifestSeenOrRefusal(ws: Workspace, dir: string, expected: readonly string[], staleMessage: string): Promise<ManifestSeen | RunningOrderOutcome> {
  const read = await readManifestOnly(ws, dir)
  if (!read.assessment.ok) return refused(read.assessment.reason === 'no-manifest' ? NO_MANIFEST : OUTLINE_UNSAFE_MESSAGE)
  if (!sameOrder(read.assessment.order, expected)) return stale(staleMessage)
  return read as ManifestSeen
}

const manifestDone = (order: string[]): RunningOrderOutcome => ({ result: { ok: true, changed: true, order }, plan: null, manifestOnly: true })

/** Run a manifest-only write; an error from it is a refusal with its own sentence. */
async function manifestWrite(ws: Workspace, write: () => Promise<string[]>, prefix = ''): Promise<RunningOrderOutcome> {
  try {
    return manifestDone(await write())
  } catch (error) {
    return refused(`${prefix}${plain(ws, error)}`)
  }
}

/** Move one piece before another piece (null = to the end), through `movePart`. */
export async function moveFolioPiece(ws: Workspace, dir: string, input: Omit<MovePieceInput, 'dir'>, options: PlanWriteOptions = {}): Promise<RunningOrderOutcome> {
  const { path, beforePath, expected } = input
  assertPaths([path, ...(beforePath === null ? [] : [beforePath]), ...expected])
  return withPlanLock(ws, dir, async () => {
    if (!indexNoteExists(ws, dir)) {
      const read = await manifestSeenOrRefusal(ws, dir, expected, STALE_ORDER_MESSAGE)
      if (!isManifestSeen(read)) return read
      const order = read.assessment.order
      const move = resolveMove(order, path, beforePath)
      if (!move) return stale(STALE_ORDER_MESSAGE)
      if (move.from === move.to) return { result: { ok: true, changed: false, order }, plan: null }
      return manifestWrite(ws, () => moveManifestEntry(ws, dir, read, move.from, move.to, options))
    }
    const seen = await seenOrRefusal(ws, dir, expected, STALE_ORDER_MESSAGE)
    if (isOutcome(seen)) return seen
    const move = resolveMove(seen.order, path, beforePath)
    if (!move) return stale(STALE_ORDER_MESSAGE)
    if (move.from === move.to) return { result: { ok: true, changed: false, order: seen.order }, plan: null }
    const verifyPlan = verifier(ws, dir, expected, () => true)
    try {
      return done(await movePart(ws, dir, move.from, move.to, { ...options, verifyPlan, requireManifestWrite: true }))
    } catch (error) {
      if (error instanceof PlanWrittenButNotReRead) {
        const order = seen.order.filter((_, at) => at !== move.from)
        order.splice(move.to, 0, seen.order[move.from])
        return madeUnread(error, order)
      }
      if (error instanceof StaleOrder) return stale(STALE_ORDER_MESSAGE)
      return refused(plain(ws, error))
    }
  })
}

/**
 * Add files at the end, all in one write (`adoptParts`). A file can be added only if the Plan itself
 * lists it as an unlisted file that the manifest does not already carry; the Outline's "addable" mark
 * comes from the same list (folio-outline.ts), so the two cannot disagree.
 */
export async function addFolioPieces(ws: Workspace, dir: string, input: Omit<AddPiecesInput, 'dir'>, options: PlanWriteOptions = {}): Promise<RunningOrderOutcome> {
  const paths = distinctPaths(input.paths)
  const { expected } = input
  assertPaths([...paths, ...expected])
  if (paths.length === 0) return refused('There is no file to add.')
  return withPlanLock(ws, dir, async () => {
    if (!indexNoteExists(ws, dir)) {
      const read = await manifestSeenOrRefusal(ws, dir, expected, STALE_ADD_MESSAGE)
      if (!isManifestSeen(read)) return read
      if (paths.some((path) => read.assessment.order.includes(path))) return stale(STALE_ADD_MESSAGE)
      // The addable rule, asked again here on this read: the Outline's mark is only what was shown.
      const addable = new Set(await manifestOnlyAddable(ws, dir, read))
      const notAddable = paths.filter((path) => !addable.has(path)).length
      if (notAddable) return refused(NOT_ADDABLE(notAddable, paths.length))
      return manifestWrite(ws, () => appendManifestEntries(ws, dir, read, paths, options))
    }
    const seen = await seenOrRefusal(ws, dir, expected, STALE_ADD_MESSAGE)
    if (isOutcome(seen)) return seen
    if (paths.some((path) => seen.order.includes(path))) return stale(STALE_ADD_MESSAGE)
    const indices = paths.map((path) => seen.plan.unlisted.findIndex((part) => part.path === path && part.manifestBacked === false))
    const notAddable = indices.filter((index) => index < 0).length
    if (notAddable) return refused(NOT_ADDABLE(notAddable, paths.length))
    const verifyPlan = verifier(ws, dir, expected, (fresh) => indices.every((index, at) => fresh.unlisted[index]?.path === paths[at] && fresh.unlisted[index]?.manifestBacked === false))
    try {
      return done(await adoptParts(ws, dir, indices, { ...options, verifyPlan, requireManifestWrite: true }))
    } catch (error) {
      if (error instanceof PlanWrittenButNotReRead) return madeUnread(error, [...seen.order, ...paths])
      if (error instanceof StaleOrder) return stale(STALE_ADD_MESSAGE)
      return refused(plain(ws, error))
    }
  })
}

/**
 * Undo of an Add, in one hold of the lock: the pieces named must be exactly the last pieces of the
 * running order, in the order they were added, and the order must be as the Add left it; that is checked
 * before anything is removed. Each piece then goes through `removePart`, last first (the Plan's backstop
 * lets one write remove one part only). If a removal fails after others succeeded, the answer says
 * exactly which pieces were taken out and which remain (`partial`). A removal that was made and could not
 * be read again afterwards is a removal that was made: it is counted among the pieces taken out.
 *
 * Each `removePart` loads the Plan twice (its own read, and the Plan it returns), and a load lists the
 * workspace; the Plan each returns is reused for the next index, so there is no third load per piece.
 * Undo of a very large Add all is therefore still one workspace listing per piece, twice.
 */
export async function removeAddedFolioPieces(ws: Workspace, dir: string, input: Omit<RemoveAddedInput, 'dir'>, options: PlanWriteOptions = {}): Promise<RunningOrderOutcome> {
  const paths = distinctPaths(input.paths)
  const { expected } = input
  assertPaths([...paths, ...expected])
  if (paths.length === 0) return refused('There is nothing to undo.')
  return withPlanLock(ws, dir, async () => {
    if (!indexNoteExists(ws, dir)) {
      // One document, so the whole Undo is one write: all the named pieces go, or none does.
      const read = await manifestSeenOrRefusal(ws, dir, expected, STALE_UNDO_MESSAGE)
      if (!isManifestSeen(read)) return read
      const order = read.assessment.order
      if (paths.length > order.length || !sameOrder(order.slice(order.length - paths.length), paths)) return stale(STALE_UNDO_MESSAGE)
      return manifestWrite(ws, () => removeManifestTail(ws, dir, read, paths.length, options), 'Could not undo. ')
    }
    const seen = await seenOrRefusal(ws, dir, expected, STALE_UNDO_MESSAGE)
    if (isOutcome(seen)) return seen
    if (paths.length > seen.order.length || !sameOrder(seen.order.slice(seen.order.length - paths.length), paths)) return stale(STALE_UNDO_MESSAGE)
    const titles = new Map(seen.plan.parts.flatMap((part) => (part.path ? [[part.path, part.title] as const] : [])))
    let current = [...seen.order]
    let last: Plan | null = null
    let writtenIndex: string | undefined
    const removed: string[] = []
    for (const path of [...paths].reverse()) {
      // The assessment holds, so the Index Note lists exactly `current`: the piece is its last part.
      const index = current.length - 1
      const expectedNow = [...current]
      try {
        last = await removePart(ws, dir, index, {
          ...options,
          verifyPlan: verifier(ws, dir, expectedNow, (fresh) => fresh.parts[index]?.path === path),
          requireManifestWrite: true,
        })
        writtenIndex = last.indexPath
        current = current.slice(0, -1)
        removed.unshift(path)
      } catch (error) {
        if (error instanceof PlanWrittenButNotReRead) {
          // The removal was made; only the read after it failed. It counts, and the next removal makes its own read.
          last = null
          writtenIndex = error.indexPath
          current = current.slice(0, -1)
          removed.unshift(path)
          continue
        }
        const why = error instanceof StaleOrder ? 'The running order changed meanwhile.' : plain(ws, error)
        if (removed.length === 0) return error instanceof StaleOrder ? stale(STALE_UNDO_MESSAGE) : refused(`Could not undo. ${why}`)
        const remaining = paths.slice(0, paths.length - removed.length)
        const name = (p: string): string => titles.get(p) ?? p
        return {
          result: {
            ok: false,
            stale: false,
            message: `Undo stopped part-way. Taken out again: ${removed.map(name).join(', ')}. Still in the running order: ${remaining.map(name).join(', ')}. ${why}`,
            partial: { removed, remaining, order: current },
          },
          plan: last,
          ...(writtenIndex ? { writtenIndex } : {}),
        }
      }
    }
    return last ? done(last) : { result: { ok: true, changed: true, order: current }, plan: null, ...(writtenIndex ? { writtenIndex } : {}) }
  })
}
