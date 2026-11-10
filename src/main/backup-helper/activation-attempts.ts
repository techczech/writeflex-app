/**
 * Durable record of unfinished Turn on attempts (`userData/backup-helper/activation-attempts.json`, 0600).
 *
 * An enable writes its attempt here, synced, BEFORE it asks the helper to turn the engine switch on and
 * before it publishes its registration entry; it is removed only when the attempt was accepted completely
 * or its undo really finished. So a crash, or a disk that keeps failing while the attempt is undone, leaves
 * the attempt on disk, and the next start (enrolment.ts startup) treats the folder as unfinished: never as
 * accepted. The registrations file alone is never authority for an attempt named here.
 *
 * - One record per attempt: its id, the folder, the exact entry it publishes (with that id) and the entry it
 *   replaces (null when the folder had none). Nothing else: no general event journal.
 * - At most MAX_ATTEMPTS records; a full file refuses a new attempt instead of growing.
 * - Strict: a file that is not a regular private file of this user (0600, no link), not this schema, or not
 *   exactly valid is damaged. A damaged file is never overwritten and serves nothing (enrolment.ts).
 * - Updates are conditional, as for the registrations: re-read, and replace only if the file still has the
 *   bytes the change was computed from, checked synchronously immediately before the rename. Writers are
 *   this process's serialised enrolment operations (one app instance per userData).
 * - Acceptance (enrolment.ts): an attempt is accepted at the rename that removes its record, admitted by
 *   the enable's binding synchronously immediately before that rename. `holds` reads the file back when
 *   the rename's own outcome is unknown.
 */
import { lstatSync, readFileSync } from 'node:fs'
import { lstat, readFile } from 'node:fs/promises'
import { WriteRefused, writeFileDurable } from './durable-file'

export const MAX_ATTEMPTS = 32
const ATTEMPT_ID = /^[0-9a-f]{32}$/
const TRIES = 3

export type AttemptRecord<E> = { attempt: string; root: string; entry: E; prior: E | null; at: number }
export type LoadedAttempts<E> = { state: 'ok'; attempts: AttemptRecord<E>[]; text: string | null } | { state: 'damaged' }
export type AttemptsUpdate = 'written' | 'unchanged' | 'damaged' | 'full' | 'conflict'

type Entry = { root: string; attempt?: string }

export function createActivationAttempts<E extends Entry>(options: { file: string; ensureDir: () => Promise<void>; parseEntry: (value: unknown) => E | null }) {
  const { file } = options
  const uid = process.getuid?.()

  function parse(text: string): AttemptRecord<E>[] | null {
    let value: unknown
    try { value = JSON.parse(text) } catch { return null }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const v = value as Record<string, unknown>
    if (v.schema !== 1 || !Array.isArray(v.attempts) || v.attempts.length > MAX_ATTEMPTS) return null
    const out: AttemptRecord<E>[] = []
    const ids = new Set<string>()
    for (const item of v.attempts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const r = item as Record<string, unknown>
      const entry = options.parseEntry(r.entry)
      const prior = r.prior === null ? null : options.parseEntry(r.prior)
      if (typeof r.attempt !== 'string' || !ATTEMPT_ID.test(r.attempt) || ids.has(r.attempt) || typeof r.root !== 'string' || !Number.isSafeInteger(r.at)) return null
      if (!entry || entry.attempt !== r.attempt || entry.root !== r.root || (r.prior !== null && (!prior || prior.root !== r.root))) return null
      ids.add(r.attempt)
      out.push({ attempt: r.attempt, root: r.root, entry, prior, at: r.at as number })
    }
    return out
  }

  const privateFile = (info: { isFile(): boolean; uid: number; mode: number }): boolean => info.isFile() && (uid === undefined || info.uid === uid) && (info.mode & 0o077) === 0

  async function load(): Promise<LoadedAttempts<E>> {
    let text: string
    try {
      if (!privateFile(await lstat(file))) return { state: 'damaged' }
      text = await readFile(file, 'utf8')
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'ok', attempts: [], text: null } : { state: 'damaged' }
    }
    const attempts = parse(text)
    return attempts ? { state: 'ok', attempts, text } : { state: 'damaged' }
  }

  /** Synchronous: the file still has the bytes `text` (null: still absent). */
  function unchanged(text: string | null): boolean {
    try { return privateFile(lstatSync(file)) && readFileSync(file, 'utf8') === text } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' && text === null
    }
  }

  /**
   * Conditional replacement; errors of the write itself (WriteOutcomeUnknown included) are thrown. `admit`
   * is asked with the byte check, synchronously immediately before the rename: no throws WriteRefused.
   */
  async function update(change: (attempts: AttemptRecord<E>[]) => AttemptRecord<E>[] | null | 'full', admit?: () => boolean): Promise<AttemptsUpdate> {
    for (let i = 0; i < TRIES; i++) {
      const current = await load()
      if (current.state === 'damaged') return 'damaged'
      const next = change(current.attempts)
      if (next === 'full') return 'full'
      if (next === null) return 'unchanged'
      let moved = false
      try {
        await options.ensureDir()
        await writeFileDurable(file, `${JSON.stringify({ schema: 1, attempts: next }, null, 2)}\n`, () => { moved = !unchanged(current.text); return !moved && (!admit || admit()) })
        return 'written'
      } catch (error) {
        if (!(error instanceof WriteRefused) || !moved) throw error
      }
    }
    return 'conflict'
  }

  return {
    load,
    /** Records an attempt before any of its effects. Only 'written' allows the attempt to go on. */
    add: (record: AttemptRecord<E>): Promise<AttemptsUpdate> =>
      update((attempts) => (attempts.length >= MAX_ATTEMPTS ? 'full' : [...attempts, record])),
    /** Removes the records `which` names (an accepted or completely undone attempt, or a folder turned off). */
    retire: (which: (record: AttemptRecord<E>) => boolean, admit?: () => boolean): Promise<AttemptsUpdate> =>
      update((attempts) => (attempts.some(which) ? attempts.filter((r) => !which(r)) : null), admit),
    /**
     * Synchronous read-back of whether `attempt` is still recorded: 'held' (recorded, or the file is
     * damaged, which serves nothing), 'released' (readable, not recorded), 'unknown' (cannot be read now).
     */
    holds(attempt: string): 'held' | 'released' | 'unknown' {
      let text: string
      try {
        if (!privateFile(lstatSync(file))) return 'held'
        text = readFileSync(file, 'utf8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'released' : 'unknown'
      }
      const attempts = parse(text)
      return !attempts || attempts.some((r) => r.attempt === attempt) ? 'held' : 'released'
    },
  }
}

export type ActivationAttempts<E extends Entry> = ReturnType<typeof createActivationAttempts<E>>
