/**
 * The title-conflict buttons' write path (title-conflict buttons, 2026-10-19): the Plan's and the Outline's
 * "Use heading as title" / "Use title as heading" for one part, the Plan header's "… for all N", and the
 * Undo of each. The text of every fix is shared/title-conflict.ts; this module only reads, checks and writes.
 *
 * - Main process only. A file is read with the guarded read (a document of the opened Collection, never a
 *   link, never outside the root), and written with `saveFileOverRead` (`documentOnly`), over exactly the
 *   bytes read, and only when they are the version the caller saw (`fingerprint`): another version on
 *   disk refuses with "This file changed since you looked. Look again and retry." and writes nothing.
 * - The caller takes a checkpoint before each write (`beforeWrite`), as `setPartHeadingMode` does.
 * - Every successful call leaves ONE Undo step, however many files it wrote: the text each file held before,
 *   kept here in main and named to the renderer only by an opaque token. Undo puts each file back only while
 *   it still holds what the fix wrote (compared byte for byte and by the guarded write's fingerprint); a
 *   file changed since is left as it is and named in the answer.
 */

import { randomUUID } from 'node:crypto'
import { fingerprintOf, fingerprintOfRead, readDocumentFile } from './guarded-document-read'
import { ChangedSinceRead, DocumentChangedError, type Workspace } from './workspace'
import { PartChangedError } from './folio-part-proposals'
import { withTitleFixed, type TitleFixDirection } from '../shared/title-conflict'

export const CHANGED_SINCE_LOOKED = 'This file changed since you looked. Look again and retry.'

/** One file a fix wrote: what it held before and what the fix left. */
export type TitleFixWrite = { path: string; before: string; after: string }

export type TitleFixRequest = { path: string; fingerprint: string }

/** The answer of a fix: what was written and the Undo step's token (null when nothing was written), and each
 *  file that was not, with why. `message` alone: nothing was written. */
export type TitleFixAnswer =
  | { ok: true; written: string[]; skipped: Array<{ path: string; message: string }>; undo: string | null }
  | { ok: false; message: string }

export type TitleUndoAnswer = { ok: true; restored: string[]; kept: Array<{ path: string; message: string }> } | { ok: false; message: string }

const MAX_UNDO_STEPS = 20
const steps = new WeakMap<Workspace, Map<string, TitleFixWrite[]>>()

function remember(ws: Workspace, writes: TitleFixWrite[]): string | null {
  if (writes.length === 0) return null
  const held = steps.get(ws) ?? new Map<string, TitleFixWrite[]>()
  steps.set(ws, held)
  const token = randomUUID()
  held.set(token, writes)
  while (held.size > MAX_UNDO_STEPS) held.delete(held.keys().next().value as string)
  return token
}

const plainMessage = (error: unknown, fallback: string): string => (error instanceof Error && error.message ? error.message : fallback)

/** Fix one file's conflict in `direction` over the version `fingerprint` names. Throws `PartChangedError` when it is not that version. */
async function fixOne(
  ws: Workspace,
  request: TitleFixRequest,
  direction: TitleFixDirection,
  part: boolean,
  beforeWrite: (path: string) => Promise<void>,
): Promise<TitleFixWrite> {
  const read = await readDocumentFile(ws, request.path)
  const seen = fingerprintOfRead(read)
  if (seen !== request.fingerprint) throw new PartChangedError(request.path, read.content)
  const fixed = withTitleFixed(read.content, request.path, direction, { part })
  if (!fixed.ok) throw new Error(fixed.message)
  await beforeWrite(request.path)
  try {
    await ws.saveFileOverRead(request.path, fixed.next, read.content, { documentOnly: true, expect: { fingerprint: seen } })
  } catch (error) {
    if (error instanceof ChangedSinceRead) throw new PartChangedError(request.path, error.diskText)
    if (error instanceof DocumentChangedError) throw new PartChangedError(request.path)
    throw error
  }
  return { path: request.path, before: read.content, after: fixed.next }
}

/**
 * Fix each named file in `direction`, in order, as one step. A file that changed since it was looked at, or
 * whose fix is refused, is skipped with its reason; the others are written. One file asked: its refusal is the answer.
 */
export async function fixTitleConflicts(
  ws: Workspace,
  requests: readonly TitleFixRequest[],
  direction: TitleFixDirection,
  options: { part: boolean; beforeWrite: (path: string) => Promise<void> },
): Promise<TitleFixAnswer> {
  const writes: TitleFixWrite[] = []
  const skipped: Array<{ path: string; message: string }> = []
  for (const request of requests) {
    try {
      writes.push(await fixOne(ws, request, direction, options.part, options.beforeWrite))
    } catch (error) {
      skipped.push({ path: request.path, message: error instanceof PartChangedError ? CHANGED_SINCE_LOOKED : plainMessage(error, 'Could not change this file.') })
    }
  }
  if (requests.length === 1 && writes.length === 0) return { ok: false, message: skipped[0].message }
  return { ok: true, written: writes.map((write) => write.path), skipped, undo: remember(ws, writes) }
}

/**
 * Undo the step `token` names: each file goes back to what it held before the fix, but only while it holds
 * exactly what the fix wrote. The step is used up either way (a second Undo of it does nothing).
 */
export async function undoTitleFix(ws: Workspace, token: string, beforeWrite: (path: string) => Promise<void>): Promise<TitleUndoAnswer> {
  const held = steps.get(ws)
  const writes = held?.get(token)
  if (!held || !writes) return { ok: false, message: 'There is no title change to undo.' }
  held.delete(token)
  const restored: string[] = []
  const kept: Array<{ path: string; message: string }> = []
  for (const write of writes) {
    try {
      const read = await readDocumentFile(ws, write.path)
      const seen = fingerprintOfRead(read)
      if (read.content !== write.after || seen !== fingerprintOf(write.after)) {
        kept.push({ path: write.path, message: 'It changed after the title change, so it was left as it is.' })
        continue
      }
      await beforeWrite(write.path)
      await ws.saveFileOverRead(write.path, write.before, read.content, { documentOnly: true, expect: { fingerprint: seen } })
      restored.push(write.path)
    } catch (error) {
      kept.push({ path: write.path, message: error instanceof ChangedSinceRead || error instanceof DocumentChangedError
        ? 'It changed after the title change, so it was left as it is.'
        : plainMessage(error, 'It could not be put back.') })
    }
  }
  return { ok: true, restored, kept }
}

/** @internal Tests: forget every Undo step. */
export function forgetTitleFixSteps(ws: Workspace): void {
  steps.delete(ws)
}
