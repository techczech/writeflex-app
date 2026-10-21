/**
 * The production Trash mover for Node mode, where Electron's `shell.trashItem` does not exist: the
 * system's own `/usr/bin/trash` (macOS 15 and later), else Finder through `osascript`, with the path
 * passed as an argument, never spliced into a script. There is no fallback that deletes.
 *
 * THE WAIT IS BOUNDED. The command line holds the Collection's owner lock while the system moves the
 * item, and a mover that never answers (Finder waiting on a permission prompt) would hold it for
 * ever. After the limit the child is killed and no longer listened to (bounded-child.ts).
 *
 * WHAT IS KNOWN THEN, and so what is said. A move to the Trash is one step for the system: the item
 * is in place or it is gone, never half moved. So the place is looked at once the wait is over. Gone:
 * the move happened and that is reported as done. Still there: it was not moved, and that is the
 * refusal. With `/usr/bin/trash` the killed child was the mover, so nothing more will happen. With
 * Finder the request may still be standing in Finder after `osascript` is killed, so the refusal
 * does not promise that nothing will change: it says the item is in place NOW, and that if the system
 * finishes later the item will be in the Trash, from where it can be put back.
 */
import { existsSync, lstatSync } from 'node:fs'
import { runBounded, type BoundedOptions } from '../bounded-child'
import { CliError } from './operation'

export type TrashMover = (absolute: string) => Promise<void>

/** How long the system is given to move one item to the Trash. */
export const TRASH_WAIT_MS = 20_000

/** @internal Test seams: another program in place of the system's mover, and the limit without the clock. */
export type TrashSeams = { command?: { file: string; args: string[]; finishesLater?: boolean }; expired?: BoundedOptions['expired']; platform?: NodeJS.Platform }

const stillThere = (absolute: string): boolean => {
  try { lstatSync(absolute); return true } catch { return false }
}

export function trashMover(seams: TrashSeams = {}): TrashMover {
  return async (absolute) => {
    if ((seams.platform ?? process.platform) !== 'darwin') throw new Error('Moving to the Trash from the command line is available on macOS only.')
    const viaFinder = !seams.command && !existsSync('/usr/bin/trash')
    const { file, args } = seams.command ?? (viaFinder
      ? { file: '/usr/bin/osascript', args: ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', '-e', 'end run', absolute] }
      : { file: '/usr/bin/trash', args: [absolute] })
    const run = await runBounded(file, args, { timeoutMs: TRASH_WAIT_MS, ...(seams.expired ? { expired: seams.expired } : {}) })
    if (run.kind === 'exited' && run.code === 0) return
    if (run.kind === 'timed-out') {
      // One step for the system: in place or gone. Gone means it was moved before the wait ran out.
      if (!stillThere(absolute)) return
      const later = viaFinder || seams.command?.finishesLater
        ? ' Finder was asked and may still carry the move out: if it does, the item will be in the Trash, from where it can be put back.'
        : ' The move was stopped, so it will not happen later.'
      throw new CliError(`${absolute} could not be moved to the Trash in time (the system did not answer within ${TRASH_WAIT_MS / 1000} seconds). It is still where it was.${later}`)
    }
    throw new Error(run.kind === 'exited' ? run.stderr.trim() || `${file} ended with status ${run.code ?? 'unknown'}.` : run.message)
  }
}

export const systemTrash: TrashMover = trashMover()
