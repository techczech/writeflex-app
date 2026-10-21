/**
 * The Undo of a running-order Add (the Outline's Add, the Plan's Add all, and the manifest-only Add of a Folio with
 * no Index Note), tied to that Add and nothing else.
 *
 * At Add time, under the Folio's lock, main keeps the exact text of the Folio's two documents (the Index Note and
 * the manifest) before and after the Add, "absent" for a file that was not there, and hands the renderer a token
 * for that record. An Undo names the token. It is made only when the record is this Folio's (workspace root and
 * folder, by folio-dir.ts's one spelling) and both documents hold, byte for byte, exactly what the Add left; it
 * then writes each back to exactly what it held before (or removes a document the Add created). Any other state, an
 * unknown token, or one already used, is refused with STALE_UNDO_MESSAGE and nothing is written. So an Undo can
 * never take out a part no Add put in, and it restores the documents exactly (heading, numbering, layout).
 *
 * The pristine-copy backups (`.writeflex-backup`) are never touched by an Undo: that a backup was absent before the
 * Add and present after it does not prove the Add made it, and a stray backup is harmless where deleting someone
 * else's is not.
 *
 * The record is kept in memory only: the last ADD_UNDO_KEPT Adds per Folio. A record goes when it is used, or when
 * newer Adds push it out. A restart forgets them all, as it forgets the renderer's Undo step.
 *
 * Writes: `beforeIndexWrite` / `beforeManifestWrite` (the history checkpoints) are called first, as for every Plan
 * write. Then each write is made only while BOTH documents hold what they must at that step, compared after the
 * checkpoints and again in the tick of the rename (or the unlink). The Index Note goes first, then the manifest; if
 * a later step fails or finds a document changed, what this Undo wrote is taken back (each only while it still
 * holds what the Undo wrote) and the Undo is refused. A document that could not be taken back is named in the
 * refusal (`wroteIndex` / `wroteManifest`) so the caller still tells open buffers about it.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { MANIFEST_NAME, indexNotePath } from './folio'
import { folioKey } from './folio-dir'
import type { PlanWriteOptions } from './plan'
import type { Workspace } from './workspace'
import { STALE_UNDO_MESSAGE } from '../shared/folio-running-order'
import { withoutAbsolutePaths } from '../shared/plain-error-text'

/** How many Adds per Folio keep their Undo record (older ones are dropped, oldest first). */
export const ADD_UNDO_KEPT = 8

/** A document's text, or null when no file is there. */
type Text = string | null
/** The Folio's two documents at one instant: the Index Note and the manifest, by path. */
export type FolioDocuments = { indexPath: string; manifestPath: string; texts: ReadonlyMap<string, Text> }

type AddRecord = { folio: string; before: FolioDocuments; after: FolioDocuments }

const records = new Map<string, AddRecord>()

const folioOf = (ws: Pick<Workspace, 'root'>, dir: string): string => {
  const key = folioKey(ws.root, dir)
  return `${key.root}\u0000${key.dir}`
}

function textNow(ws: Workspace, path: string): Text {
  try {
    return readFileSync(ws.absolute(path), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`"${path.split('/').at(-1) ?? path}" could not be read, so nothing was written over it.`)
  }
}

/** The Folio's documents as they are now. Call it under the Folio's lock. */
export function readFolioDocuments(ws: Workspace, dir: string): FolioDocuments {
  const indexPath = indexNotePath(ws, dir)
  const manifestPath = dir === '' ? MANIFEST_NAME : `${dir}/${MANIFEST_NAME}`
  const texts = new Map<string, Text>()
  for (const path of [indexPath, manifestPath]) texts.set(path, textNow(ws, path))
  return { indexPath, manifestPath, texts }
}

/** Keep the record of one Add (`before` and `after` read under the lock it was made in) and return its token; null when the Add changed neither document. */
export function recordAdd(ws: Pick<Workspace, 'root'>, dir: string, before: FolioDocuments, after: FolioDocuments): string | null {
  const changed = [before.indexPath, before.manifestPath].some((path) => before.texts.get(path) !== after.texts.get(path))
  if (!changed) return null
  const folio = folioOf(ws, dir)
  const token = randomUUID()
  records.set(token, { folio, before, after })
  const mine = [...records.entries()].filter(([, record]) => record.folio === folio)
  for (const [old] of mine.slice(0, Math.max(0, mine.length - ADD_UNDO_KEPT))) records.delete(old)
  return token
}

/** Forget every record (tests; a workspace closed). */
export function forgetAddUndoRecords(): void {
  records.clear()
}

/**
 * `wroteIndex` / `wroteManifest` on a refusal: that document was left changed by this Undo (its write went in and
 * could not be taken back), so the caller tells open buffers and the collection about it as it does on success.
 */
export type AddUndoOutcome =
  | { ok: true; indexPath: string; wroteIndex: boolean; indexExists: boolean }
  | { ok: false; stale: boolean; message: string; indexPath?: string; wroteIndex?: boolean; wroteManifest?: boolean }

const STALE: AddUndoOutcome = { ok: false, stale: true, message: STALE_UNDO_MESSAGE }

/** Thrown when a document is not what this Undo expects it to hold at that step. */
class Changed extends Error {
  constructor() { super(STALE_UNDO_MESSAGE) }
}
const isChanged = (error: unknown): boolean => error instanceof Changed || (error instanceof Error && error.message === STALE_UNDO_MESSAGE)

/**
 * Undo the Add `token` names in the Folio at `dir`. The caller holds the Folio's lock (plan-lock.ts). Refused, with
 * nothing written, unless the record is this Folio's and both documents hold exactly what that Add left.
 *
 * Before each write, after the awaited checkpoint and again in the tick of the rename (or the unlink), BOTH
 * documents are compared with what they must hold at that step: the one about to be written with the Add's after
 * text, the other with its after text (not written yet) or its before text (written already). A document the Add
 * left as it was, or absent, is compared too (it must still be so). The same comparison is made once more before
 * the token is used up. On any difference nothing more is written, what this Undo wrote is taken back (each only
 * while it still holds what the Undo wrote), and the Undo is refused as stale; the token stays usable only when
 * nothing was written, or after a plain write failure whose take-back left both documents as the Add left them.
 */
export async function undoRecordedAdd(ws: Workspace, dir: string, token: string, options: PlanWriteOptions = {}): Promise<AddUndoOutcome> {
  const record = typeof token === 'string' ? records.get(token) : undefined
  if (!record || record.folio !== folioOf(ws, dir)) return STALE
  const { before, after } = record
  const [indexPath, manifestPath] = [after.indexPath, after.manifestPath]
  const indexAfter = after.texts.get(indexPath) ?? null
  const indexBefore = before.texts.get(indexPath) ?? null
  const manifestAfter = after.texts.get(manifestPath) ?? null
  const manifestBefore = before.texts.get(manifestPath) ?? null
  const writeIndex = indexAfter !== indexBefore
  const writeManifest = manifestAfter !== manifestBefore
  const couldNot = (error: unknown): AddUndoOutcome => ({ ok: false, stale: false, message: `Could not undo. ${reasonOf(ws, error)} Nothing was changed.` })

  /** Both documents hold `index` and `manifest` now (read now, byte for byte); throws Changed otherwise. */
  const holds = (index: Text, manifest: Text): void => {
    if (textNow(ws, indexPath) !== index || textNow(ws, manifestPath) !== manifest) throw new Changed()
  }
  /** Write `path` from `from` to `to` (null: remove it), only while both documents hold `index` / `manifest`, checked before and in the commit tick. */
  const write = async (path: string, from: Text, to: Text, index: Text, manifest: Text): Promise<void> => {
    holds(index, manifest)
    if (to === null) {
      ws.removeFileOverRead(path, from as string)
      return
    }
    await ws.saveFileWithoutReadBack(path, to, { allowExplicitEmpty: true, beforeCommit: () => holds(index, manifest) })
  }
  /** Put `path` back from what this Undo wrote (`wrote`) to what the Add left (`left`), only while it still holds `wrote`. */
  const takeBack = async (path: string, wrote: Text, left: Text): Promise<boolean> => {
    try {
      if (textNow(ws, path) !== wrote) return false
      if (left === null) ws.removeFileOverRead(path, wrote as string)
      else await ws.saveFileWithoutReadBack(path, left, { allowExplicitEmpty: true, beforeCommit: () => { if (textNow(ws, path) !== wrote) throw new Changed() } })
      return true
    } catch { return false }
  }

  try { holds(indexAfter, manifestAfter) } catch (error) {
    return isChanged(error) ? STALE : couldNot(error)
  }
  if (writeIndex && indexAfter !== null) await options.beforeIndexWrite?.(indexPath)
  if (writeManifest && manifestAfter !== null) await options.beforeManifestWrite?.(manifestPath)

  let indexWritten = false
  let manifestWritten = false
  let failure: unknown = null
  try {
    if (writeIndex) {
      await write(indexPath, indexAfter, indexBefore, indexAfter, manifestAfter)
      indexWritten = true
    }
    if (writeManifest) {
      await write(manifestPath, manifestAfter, manifestBefore, indexBefore, manifestAfter)
      manifestWritten = true
    }
    holds(indexBefore, manifestBefore)
  } catch (error) {
    failure = error
  }
  if (failure === null) {
    records.delete(token)
    return { ok: true, indexPath, wroteIndex: writeIndex, indexExists: indexBefore !== null }
  }

  const changedMeanwhile = isChanged(failure)
  if (!indexWritten && !manifestWritten) return changedMeanwhile ? STALE : couldNot(failure)
  // Something was written: take it back, the manifest first (the later write), then the Index Note.
  const manifestLeft = manifestWritten && !(await takeBack(manifestPath, manifestBefore, manifestAfter))
  const indexLeft = indexWritten && !(await takeBack(indexPath, indexBefore, indexAfter))
  // The token survives only a plain write failure whose rollback completed: both documents hold exactly what the Add
  // left again. The documents changed under this Undo, or a rollback that failed (a split state): it is used up, so
  // it cannot revive later should the files come to hold the Add's after-text again.
  const rolledBack = !indexLeft && !manifestLeft && (() => { try { holds(indexAfter, manifestAfter); return true } catch { return false } })()
  if (changedMeanwhile || !rolledBack) records.delete(token)
  const reason = changedMeanwhile ? 'The running order changed meanwhile.' : reasonOf(ws, failure)
  if (!indexLeft && !manifestLeft) return changedMeanwhile ? STALE : { ok: false, stale: false, message: `Could not undo. ${reason} Nothing was changed.` }
  const left = indexLeft && manifestLeft
    ? 'The Index Note and the Folio manifest were both put back as they were before the Add, but something else changed one of them meanwhile'
    : indexLeft
      ? 'The Index Note was put back as it was before the Add, the Folio manifest was not'
      : 'The Folio manifest was put back as it was before the Add, the Index Note was not'
  return {
    ok: false,
    stale: false,
    message: `Could not undo. ${reason} ${left}; check both in the Folio outline.`,
    indexPath,
    wroteIndex: indexLeft,
    wroteManifest: manifestLeft,
  }
}

function reasonOf(ws: Workspace, error: unknown): string {
  const text = withoutAbsolutePaths(error instanceof Error ? error.message : String(error), ws.root)
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`
}

/**
 * Run one Add (`run`, which writes under the Folio's lock the caller holds) between two reads of the Folio's
 * documents, and give its answer the token of the record kept for it. An answer that already carries one (an
 * Add that went through another route, which recorded it) is left as it is.
 */
export async function recordingAdd<T extends { result: { ok: boolean; changed?: boolean; undoToken?: string } }>(ws: Workspace, dir: string, run: () => Promise<T>): Promise<T> {
  // A document that cannot be read leaves the Add without an Undo; it never fails the Add (the write decides that).
  const read = (): FolioDocuments | null => { try { return readFolioDocuments(ws, dir) } catch { return null } }
  const before = read()
  const outcome = await run()
  const { result } = outcome
  if (!before || !result.ok || result.changed === false || result.undoToken) return outcome
  const after = read()
  const token = after ? recordAdd(ws, dir, before, after) : null
  return token ? { ...outcome, result: { ...result, undoToken: token } } : outcome
}
