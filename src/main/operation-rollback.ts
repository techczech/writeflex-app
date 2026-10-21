/**
 * The rollback of a multi-file operation that failed part-way (R7 in
 * docs/plans/saving-over-an-outside-change/spec-save-only-over-the-version-you-saw.md).
 *
 * A rollback restores only files the operation actually wrote (recorded by
 * `Workspace.recordingOperationWrites`), and only while each still holds exactly the text the operation
 * wrote. A file the operation never wrote, or one changed since it wrote it, is left as it is and named.
 * A refusal before the first write therefore restores nothing.
 *
 * Each put-back is checked again where it commits: a rewrite by `saveFileOverRead` with the written text
 * as its basis (in the tick of the rename), a created file removed by `removeFileOverRead` against the
 * written text (in the tick of the unlink), a removed file made again only by an exclusive create.
 */

import { DiskChangedUnderBuffer, NameTaken, SavedButNotReadBack, type OperationWrite, type Workspace } from './workspace'

export type RollbackOutcome = {
  /** Files put back as they were before the operation. */
  restored: string[]
  /** Files left as they are because they changed after the operation wrote them. */
  changed: string[]
  /** Files that could not be put back for another reason, with that reason. */
  failed: Array<{ path: string; reason: string }>
}

/** Per path: the text before the operation's first write of it, and the text its last write left. */
function netWrites(log: readonly OperationWrite[]): OperationWrite[] {
  const byPath = new Map<string, OperationWrite>()
  for (const write of log) {
    const known = byPath.get(write.path)
    if (!known) byPath.set(write.path, { ...write })
    else if (write.unknown || known.unknown) byPath.set(write.path, { path: write.path, before: null, after: null, unknown: true })
    else known.after = write.after
  }
  return [...byPath.values()]
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Undo `log` (latest file first), each file only over the text the operation left in it. */
export async function rollBackOperationWrites(ws: Workspace, log: readonly OperationWrite[]): Promise<RollbackOutcome> {
  const outcome: RollbackOutcome = { restored: [], changed: [], failed: [] }
  // The rollback's writes are not the operation's, nor receipts or refusals of the call that asked for it.
  await ws.outsideCallRecords(async () => {
    for (const write of netWrites(log).reverse()) {
      if (write.unknown) {
        outcome.failed.push({ path: write.path, reason: 'what it held before could not be read' })
        continue
      }
      if (write.before === write.after) continue
      try {
        if (write.after === null) {
          // Removed by the operation: made again only where nothing has appeared since.
          await ws.saveFileOver(write.path, write.before as string, { kind: 'create' }, { allowExplicitEmpty: true })
        } else if (write.before === null) {
          ws.removeFileOverRead(write.path, write.after)
        } else {
          await ws.saveFileOverRead(write.path, write.before, write.after, { allowExplicitEmpty: true })
        }
        outcome.restored.push(write.path)
      } catch (error) {
        if (error instanceof SavedButNotReadBack) outcome.restored.push(write.path)
        else if (error instanceof DiskChangedUnderBuffer || error instanceof NameTaken) outcome.changed.push(write.path)
        else outcome.failed.push({ path: write.path, reason: reasonOf(error) })
      }
    }
  })
  return outcome
}

function named(paths: string[]): string {
  return paths.length <= 2 ? paths.join(' and ') : `${paths.slice(0, -1).join(', ')} and ${paths.at(-1)}`
}

/**
 * The failed operation's sentence: "Nothing was changed: <reason>" when everything it wrote was put back
 * (or it wrote nothing); otherwise the reason, then which files were left as they are and why.
 */
export function rollbackMessage(reason: string, outcome: RollbackOutcome): string {
  if (!outcome.changed.length && !outcome.failed.length) return `Nothing was changed: ${reason}`
  const parts = [`The change was not completed: ${reason}`]
  if (outcome.changed.length) {
    const one = outcome.changed.length === 1
    parts.push(`${named(outcome.changed)} changed on disk after WriteFlex wrote ${one ? 'it' : 'them'}, so ${one ? 'it was' : 'they were'} left as ${one ? 'it is' : 'they are'}.`)
  }
  for (const failure of outcome.failed) parts.push(`${failure.path} could not be put back (${failure.reason.replace(/[.\s]+$/, '')}), so it was left as it is.`)
  if (outcome.restored.length) parts.push(`${named(outcome.restored)} ${outcome.restored.length === 1 ? 'was' : 'were'} put back.`)
  return parts.join(' ')
}
