import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class ReaderPublicationRecoveryError extends Error {
  constructor(readonly authority: string, cause: unknown, rollback: unknown) {
    super(`Reader main publication failed and rollback failed; last usable bundle retained at ${authority}. Publication is blocked until the development watcher is closed and that directory is restored.`, { cause: new AggregateError([cause, rollback]) })
  }
}

function validateBundle(stage: string, candidate: string): void {
  for (const member of readdirSync(stage, { withFileTypes: true })) {
    const source = join(stage, member.name), target = join(candidate, member.name)
    if (member.isDirectory()) validateBundle(source, target)
    else if (!member.isFile() || !readFileSync(source).equals(readFileSync(target))) {
      throw new Error(`Reader main staged bundle validation failed: ${source}`)
    }
  }
}

/** Trusted development paths only. Return owned recovery storage for watcher cleanup. */
export function publishReaderMain(stage: string, output: string, io = { copy: cpSync, rename: renameSync }): string {
  mkdirSync(dirname(output), { recursive: true })
  // Same parent/filesystem as the live directory: no cross-device rename fallback.
  const work = mkdtempSync(join(dirname(output), '.reader-publication-'))
  const next = join(work, 'next'), previous = join(work, 'previous')
  let retained = false
  try {
    mkdirSync(next)
    if (existsSync(output)) io.copy(output, next, { recursive: true })
    io.copy(stage, next, { recursive: true })
    validateBundle(stage, next)
    const hadPrevious = existsSync(output)
    if (hadPrevious) io.rename(output, previous)
    try { io.rename(next, output) }
    catch (error) {
      if (hadPrevious) {
        try { io.rename(previous, output) }
        catch (rollback) {
          retained = true
          throw new ReaderPublicationRecoveryError(previous, error, rollback)
        }
      }
      throw error
    }
    // Keep the old generation until closeWatcher. Cleanup cannot turn a completed
    // commit into a refusal, or destroy retained authority after rollback failure.
    return work
  } catch (error) {
    if (!retained) rmSync(work, { recursive: true, force: true })
    throw error
  }
}
