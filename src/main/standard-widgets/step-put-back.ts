/**
 * Putting back a widget step that moved documents (the own-folder step of Create and insert): its automatic
 * rollback, its undo and the clean-up of a step stopped by a crash. Step-specific on purpose: the shared
 * operation-rollback.ts keeps its behaviour for every other caller.
 *
 * Every put-back is guarded like the step's own writes: a file is written again only by the guarded write
 * (`writeInWidgetFolder`: no-follow staging, `documentOnly`) into the very folder the step recorded for it (same
 * device and inode, checked again in the tick of the commit), and a file the step made is removed only after the
 * same folder check, a no-follow walk finding a plain file, and its bytes being exactly what the step left, all in
 * the tick of the unlink. A folder swapped for a link, here or outside the Workspace, is never written through.
 *
 * Order: every file the step rewrote or removed is put back first (newest first); only then are the files it made
 * removed. If anything could not be put back, nothing the step made is removed: a moved document is never left in
 * neither place.
 */
import { createHash } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { join, posix } from 'node:path'
import { walkNoFollowSync } from '../widget-file'
import { NameTaken, type OperationWrite, type Workspace } from '../workspace'
import { OutputChangedSinceRead, writeInWidgetFolder } from './build'
import { folderIdentity, operationSeams } from './step-folders'

export type FolderId = { dev: number; ino: number }
/** What the step left at `path`: its text, or (from a journal) the SHA-256 of its bytes; null when it removed it. */
export type LeftState = { text: string } | { sha256: string } | null
/** One file of the step: what it held before (null: nothing) and what the step left. */
export type StepChange = {
  path: string
  before: string | null
  after: LeftState
  /** For a file the step made: checked in the tick of its unlink, after its own checks, just before it is removed.
   *  A reason refuses the removal and stops every removal after it (Clean up: the copy's original must still be
   *  there, unchanged). */
  guard?: () => string | null
}

export type PutBackOutcome = {
  restored: string[]
  /** Changed after the step wrote them: left as they are. */
  changed: string[]
  failed: Array<{ path: string; reason: string }>
  /** Files the step made, kept because something before them could not be put back. */
  kept: string[]
}

const parentOf = (path: string): string => (posix.dirname(path) === '.' ? '' : posix.dirname(path))
export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** Per path: the text before the step's first write and what its last write left. A write the Workspace could not
 *  record as text is `unknown`: never put back. */
export function stepChanges(log: readonly OperationWrite[]): Array<StepChange & { unknown?: true }> {
  const byPath = new Map<string, StepChange & { unknown?: true }>()
  for (const write of log) {
    const known = byPath.get(write.path)
    const after: LeftState = write.after === null ? null : { text: write.after }
    if (write.unknown || known?.unknown) byPath.set(write.path, { path: write.path, before: null, after: null, unknown: true })
    else if (known) known.after = after
    else byPath.set(write.path, { path: write.path, before: write.before, after })
  }
  return [...byPath.values()].filter((change) => change.unknown || !(change.before === null && change.after === null) && !(change.after !== null && 'text' in change.after && change.after.text === change.before))
}

/** The order a step is put back in: rewritten and removed files (newest first), then the files it made (newest first). */
export function putBackOrder<T extends StepChange>(changes: readonly T[]): T[] {
  const newestFirst = [...changes].reverse()
  return [...newestFirst.filter((change) => change.before !== null), ...newestFirst.filter((change) => change.before === null)]
}

function bytesAt(realRoot: string, path: string): Buffer | null {
  try { return readFileSync(join(realRoot, ...path.split('/'))) } catch { return null }
}
const holdsLeft = (bytes: Buffer, left: Exclude<LeftState, null>): boolean => ('text' in left ? bytes.equals(Buffer.from(left.text, 'utf8')) : sha256(bytes) === left.sha256)

/** Put back one file of the step (see the module note). */
export async function putBackOne(ws: Workspace, realRoot: string, change: StepChange, folders: ReadonlyMap<string, FolderId>): Promise<'restored' | 'changed' | { reason: string; stop?: true }> {
  const folder = parentOf(change.path)
  const id = folders.get(folder)
  if (!id) return { reason: `${folder || 'the Workspace folder'} was not recorded by the step, so it could not be checked` }
  const walked = walkNoFollowSync(realRoot, change.path)
  // Already as it was before the step (an earlier, stopped put-back): nothing to do.
  if (change.before === null ? walked.kind === 'missing' : walked.kind === 'file' && bytesAt(realRoot, change.path)?.equals(Buffer.from(change.before, 'utf8'))) return 'restored'
  try {
    operationSeams.beforePutBack?.(change.path)
    if (change.before === null) {
      // Made by the step: removed only from the very folder, only a plain file, only over what the step left; all in
      // the tick of the unlink.
      const left = change.after
      if (left === null) return 'restored'
      const now = folderIdentity(realRoot, folder)
      if (!now || now.dev !== id.dev || now.ino !== id.ino) return { reason: `${folder || 'The Workspace folder'} changed since the step, so it was not reached` }
      if (walkNoFollowSync(realRoot, change.path).kind !== 'file') return { reason: 'it is no longer a plain file' }
      const bytes = bytesAt(realRoot, change.path)
      if (!bytes || !holdsLeft(bytes, left)) return 'changed'
      const refused = change.guard?.()
      if (refused) return { reason: refused, stop: true }
      ws.assertWritable()
      ws.recordOwnWrite(change.path)
      unlinkSync(join(realRoot, ...change.path.split('/')))
      return 'restored'
    }
    if (change.after === null) {
      // Removed by the step: made again, as a new file, only in the very folder it was removed from.
      await writeInWidgetFolder(ws, realRoot, folder, id, change.path, change.before, { exclusive: true })
      return 'restored'
    }
    if (!('text' in change.after)) return { reason: 'what the step wrote in it is not known' }
    await writeInWidgetFolder(ws, realRoot, folder, id, change.path, change.before, { basis: Buffer.from(change.after.text, 'utf8') })
    return 'restored'
  } catch (error) {
    if (error instanceof NameTaken || error instanceof OutputChangedSinceRead) return 'changed'
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Put back every file of a failed or stopped step: first everything it rewrote or removed, then, only when all of
 * that was put back, the files it made. Never stops at a failure among the first group (putting more back is
 * always safer); never removes a made file after one.
 */
export async function putBackStep(ws: Workspace, realRoot: string, changes: ReadonlyArray<StepChange & { unknown?: true }>, folders: ReadonlyMap<string, FolderId>): Promise<PutBackOutcome> {
  const outcome: PutBackOutcome = { restored: [], changed: [], failed: [], kept: [] }
  await ws.outsideCallRecords(async () => {
    const unknown = changes.filter((change) => change.unknown)
    for (const change of unknown) outcome.failed.push({ path: change.path, reason: 'what it held before could not be read' })
    let blocked = unknown.length > 0
    for (const change of putBackOrder(changes.filter((change) => !change.unknown))) {
      if (change.before === null && blocked) {
        // Something the step rewrote or removed was not put back: what it made stays, so nothing is lost.
        if (walkNoFollowSync(realRoot, change.path).kind !== 'missing') outcome.kept.push(change.path)
        continue
      }
      const done = await putBackOne(ws, realRoot, change, folders)
      if (done === 'restored') outcome.restored.push(change.path)
      else if (done === 'changed') outcome.changed.push(change.path)
      else outcome.failed.push({ path: change.path, reason: done.reason })
      if (done !== 'restored' && change.before !== null) blocked = true
      // A removal its guard refused: no further file the step made is removed.
      if (typeof done === 'object' && done.stop) blocked = true
    }
  })
  return outcome
}

const named = (paths: string[]): string => (paths.length <= 2 ? paths.join(' and ') : `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`)

/** The failed step's sentence: "Nothing was changed: <reason>" when everything was put back; otherwise the reason
 *  and what was left, and why. */
export function putBackMessage(reason: string, outcome: PutBackOutcome, leftFolders: Array<{ path: string; reason: string }> = []): string {
  if (!outcome.changed.length && !outcome.failed.length && !outcome.kept.length && !leftFolders.length) return `Nothing was changed: ${reason}`
  const parts = [`The change was not completed: ${reason}`]
  if (outcome.changed.length) {
    const one = outcome.changed.length === 1
    parts.push(`${named(outcome.changed)} changed on disk after WriteFlex wrote ${one ? 'it' : 'them'}, so ${one ? 'it was' : 'they were'} left as ${one ? 'it is' : 'they are'}.`)
  }
  for (const failure of [...outcome.failed, ...leftFolders]) parts.push(`${failure.path} could not be put back (${failure.reason.replace(/[.\s]+$/, '')}), so it was left as it is.`)
  if (outcome.kept.length) parts.push(`So that nothing is lost, ${named(outcome.kept)} ${outcome.kept.length === 1 ? 'was' : 'were'} kept.`)
  if (outcome.restored.length) parts.push(`${named(outcome.restored)} ${outcome.restored.length === 1 ? 'was' : 'were'} put back.`)
  return parts.join(' ')
}
