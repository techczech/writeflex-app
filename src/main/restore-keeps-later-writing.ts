/**
 * Restoring a checkpoint never deletes writing added after it (upkeep ticket 03).
 *
 * When WriteFlex creates a file, the checkpoint before the write records it as absent, and Bridle's
 * restore planner (vendored @bridle/core 0.17.0) deletes such a file whatever it now holds. Automatic
 * saves never snapshot (ADR-0013 tier 1), so prose typed into the file since is nowhere in history:
 * the delete would lose it for good. The upstream fix belongs to Bridle; until then `gatedSnapshots`
 * refuses the WHOLE restore before anything is changed (as Bridle itself refuses on a stale plan) when
 * a file it would delete holds bytes WriteFlex never recorded.
 *
 * What counts as recorded: the bytes of the file's newest snapshot in the journal (a saved version, a
 * later step's snapshot), or bytes the caller vouches it wrote itself (the undo desks hash the text they
 * wrote, never a re-read). A file that cannot be read is never proven, so it is kept.
 *
 * Where it is judged. Bridle's `restoreTo` plans, then carries the plan out; its private planning step
 * is wrapped on the store instance (`guardRestorePlans`) so the guard judges the very plan that runs,
 * reading each file at the end of planning and checking it still has the identity, size and link count
 * the plan expects. Bridle checks that same identity again just before each delete, so a save that
 * replaces the file (a new inode) or changes its size after the guard read stops the restore instead.
 * Residual window, other processes only (this app's saves hold the Collection's write turn): an
 * in-place rewrite of the same length into the same inode between the guard's read and the unlink.
 * When the wrapping is not available (a store without Bridle's planning step), the same judgement runs
 * from the journal just before `restoreTo` (`refuseRestoreOverLaterWriting`).
 *
 * Electron-free.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { ABSENT_HASH, RestoreRefusedError, type JournalEntry } from '@bridle/core'

/** A file the caller wrote, by absolute path, with the SHA-256 (hex) of the bytes it wrote. */
export type WrittenFile = { file: string; sha256: string }

/** The reason Bridle's refusal carries when this guard refuses; restore-failure.ts words it for the writer. */
export const LATER_WRITING = 'it holds writing added after this point, which putting it back would delete'

type Origin = 'turn' | 'host'
type Identity = { dev: bigint; ino: bigint; size: bigint; nlink: bigint }

/** Whether the file at `real` may be deleted: it holds bytes the journal's newest snapshot of `file` or
 *  the caller recorded, and (when the plan gives one) still has the identity the plan found. A file
 *  that is gone is left to Bridle (nothing to lose); any other failure to read it keeps it. */
async function provenWritten(real: string, recorded: ReadonlySet<string>, expected?: Identity): Promise<boolean> {
  let bytes: Buffer
  try {
    const before = await lstat(real, { bigint: true })
    if (!before.isFile()) return true // Not a plain file: Bridle refuses it on its own.
    bytes = await readFile(real)
    const after = await lstat(real, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== BigInt(bytes.length)) return false
    if (expected && (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size || after.nlink !== expected.nlink)) return false
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
  }
  return recorded.has(createHash('sha256').update(bytes).digest('hex'))
}

/** The hashes recorded for `file`: its newest snapshot in the journal and what the caller vouches it wrote. */
function recordedFor(entries: readonly JournalEntry[], written: readonly WrittenFile[], file: string): Set<string> {
  const hashes = new Set(written.filter((entry) => entry.file === file).map((entry) => entry.sha256))
  const newest = entries.findLast((entry) => entry.kind === 'snapshot' && entry.file === file)
  if (newest?.kind === 'snapshot' && newest.hash !== ABSENT_HASH) hashes.add(newest.hash)
  return hashes
}

const refusal = (restorePointId: string, kept: string[]) => new RestoreRefusedError(restorePointId, kept.map((path) => ({ path, reason: LATER_WRITING })), { reason: LATER_WRITING })

/**
 * Fallback: the files the restore of `restorePointId` would delete although they hold bytes WriteFlex
 * never recorded, worked out from the journal as Bridle's planner does (every snapshot after the point,
 * of the `origin` asked for, each file put back to its earliest such snapshot).
 */
export async function refuseRestoreOverLaterWriting(
  entries: readonly JournalEntry[],
  restorePointId: string,
  opts: { origin?: Origin; written?: readonly WrittenFile[] } = {},
): Promise<void> {
  const point = entries.findIndex((entry) => entry.kind === 'restore-point' && entry.id === restorePointId)
  if (point < 0) return // Bridle's own "unknown restore point" stands.
  const inOrigin = (origin: Origin | undefined) => !opts.origin || (origin ?? 'turn') === opts.origin
  const earliest = new Map<string, string>()
  for (const entry of entries.slice(point + 1)) {
    if (entry.kind === 'snapshot' && inOrigin(entry.origin) && !earliest.has(entry.file)) earliest.set(entry.file, entry.hash)
  }
  const kept: string[] = []
  for (const [file, hash] of earliest) {
    if (hash === ABSENT_HASH && !(await provenWritten(file, recordedFor(entries, opts.written ?? [], file)))) kept.push(file)
  }
  if (kept.length) throw refusal(restorePointId, kept)
}

type PlanOperation = {
  kind: string
  source?: { record?: string }
  target?: { path?: string; real?: string }
  expected?: { state?: string } & Partial<Identity>
}
type Plan = { kind: string; operations?: readonly PlanOperation[] }
type GuardedStore = { entries(): Promise<JournalEntry[]> }

/** Per store instance: the restores asked for through `gatedSnapshots`, by restore point, with what the caller vouches it wrote. */
const guarded = new WeakMap<object, Map<string, readonly WrittenFile[]>>()

/**
 * Wrap Bridle's planning step on `store` so a restore asked for through `gatedSnapshots` is refused
 * when its plan deletes later writing. Answers the map to register such restores in, or null when the
 * store has no such step (then use `refuseRestoreOverLaterWriting`). Restores this app did not ask for
 * (Bridle's own turn undo) pass unjudged.
 */
export function guardRestorePlans(store: GuardedStore): Map<string, readonly WrittenFile[]> | null {
  const known = guarded.get(store)
  if (known) return known
  const step = Object.getOwnPropertySymbols(Object.getPrototypeOf(store) ?? {}).find((symbol) => symbol.description === 'planRestore')
  const original = step && (store as unknown as Record<symbol, unknown>)[step]
  if (!step || typeof original !== 'function') return null
  const asked = new Map<string, readonly WrittenFile[]>()
  Object.defineProperty(store, step, {
    configurable: true,
    writable: true,
    value: async function (this: unknown, restorePointId: string, opts?: unknown): Promise<unknown> {
      const plan = await (original as (id: string, opts?: unknown) => Promise<Plan>).call(this, restorePointId, opts)
      const written = asked.get(restorePointId)
      if (written === undefined || plan?.kind !== 'plan') return plan
      const entries = await store.entries()
      const kept: string[] = []
      for (const operation of plan.operations ?? []) {
        if (operation.kind !== 'delete' || operation.source?.record !== 'snapshot') continue
        const file = operation.target?.path ?? ''
        const real = operation.target?.real ?? file
        const expected = operation.expected?.state === 'file' ? operation.expected as Identity : undefined
        if (!(await provenWritten(real, recordedFor(entries, written, file), expected))) kept.push(file)
      }
      return kept.length ? { kind: 'refusal', restorePointId, unknownRestorePoint: false, refusals: kept.map((path) => ({ path, reason: LATER_WRITING })) } : plan
    },
  })
  guarded.set(store, asked)
  return asked
}
