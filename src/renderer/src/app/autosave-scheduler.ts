/**
 * When the app's autosave writes each open document (ADR-0012/0013 tier 1; automatic-backup groundwork,
 * _TASK-LOG/2026-10-24-vault-backup-autosave.md). Two timers per path:
 *
 * - The quiet save: 700 ms after the last request (typing re-arms it), as before.
 * - The deadline: anchored at the path's OLDEST edit not yet on disk, and never moved by later typing, so
 *   continuous typing still reaches the disk. It fires `leadMs` before the 60 s budget, so a normal save
 *   has completed (not merely started) within 60 s of that edit.
 *
 * What is owed is read from the owner's receipts (save-receipts.ts), never from a timer or a promise: an
 * edit adds a mark (its gen and time) unless a mark not yet captured by a save already stands; a `flushed`
 * completion clears the marks up to the gen that save captured, and nothing else clears them. Typing during
 * a save is a newer mark, owed in its own right. A save that does not flush (refused, threw, readback
 * mismatch, a standing notice) keeps every mark and its age; the next attempt is no sooner than `retryMs`
 * later unless new typing asks for a quiet save first. After a refusal by main, a disk that changed under
 * the buffer or a readback that differs, the deadline writes nothing more until the writer types again (a
 * refused empty save makes a rescue copy; the others wait for the writer's answer to a notice): it only
 * checks, every `retryMs`, whether the path was settled meanwhile. A write that threw is retried.
 *
 * Cancelling a path's quiet save (a route writes it itself) or switching tabs never drops what is owed:
 * the deadline stays armed. When it fires on a path the owner calls saved (a Reload, a route settled it),
 * the marks go without a write. The scheduler grants no authority: `flush` is the app's ordinary autosave,
 * which writes nothing under an unanswered changed-on-disk notice.
 *
 * Two times: a mark keeps its receipt's wall-clock `at` (what `owed` and `oldestUnflushedAt` report, comparable
 * with the receipts), and the elapsed time the scheduler saw it (`clock.elapsed`, monotonic). Every budget,
 * deadline and retry is reckoned on elapsed time, the time the timers run on, so moving the wall clock
 * (backwards or forwards, during a save or between) neither postpones nor hurries a deadline.
 *
 * Pure: no React, no IPC. The clock is a port, so a test drives it.
 */
import type { SaveOutcome, SaveReceiptPort } from './save-receipts'

export const AUTOSAVE_QUIET_MS = 700
export const AUTOSAVE_DEADLINE_MS = 60_000
export const AUTOSAVE_DEADLINE_LEAD_MS = 10_000
export const AUTOSAVE_RETRY_MS = 15_000

/** Outcomes after which only new typing sends the write again (repeating it unasked changes nothing, or
 *  makes another rescue copy). */
const WAIT_FOR_TYPING: ReadonlySet<SaveOutcome> = new Set<SaveOutcome>(['refused-by-main', 'disk-changed', 'readback-mismatch'])

export type AutosaveClock = {
  /** Wall-clock time (as the receipts' `at`). */
  now(): number
  /** Monotonic elapsed time, on which `setTimeout` runs; absent: `now` serves (a fake clock that never jumps). */
  elapsed?(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type AutosaveSchedulerPorts = {
  /** The app's autosave of one path (it may decline, e.g. under a notice). Its result is not read: the
   *  receipts say what reached the disk. */
  flush(path: string): Promise<unknown>
  /** The owner's view: nothing owed for the path (no newer gen, nothing in flight, unknown or noticed). */
  isSaved(path: string): boolean
  clock?: AutosaveClock
  quietMs?: number
  deadlineMs?: number
  leadMs?: number
  retryMs?: number
}

/** `at`: the edit receipt's wall time; `t`: the elapsed time the scheduler saw it, which the budget runs from. */
type Mark = { gen: number; at: number; t: number }
type PathState = {
  path: string
  epoch?: number
  marks: Mark[]
  /** The highest gen a save of this epoch has captured. */
  captured: number
  quiet: unknown
  deadline: unknown
  /** Elapsed time the deadline attempt is due. */
  deadlineAt?: number
  /** A quiet save is waiting (requested, not yet fired). */
  requested: boolean
  running: boolean
  again: boolean
  /** Counts `flushed` completions, so an attempt can tell whether it flushed. */
  flushes: number
  /** No deadline attempt before this elapsed time (set after an attempt that did not flush). */
  notBefore?: number
  /** The last write was refused in a way only new typing should repeat (WAIT_FOR_TYPING). */
  holdUntilEdit: boolean
}

const systemClock: AutosaveClock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export type AutosaveScheduler = ReturnType<typeof createAutosaveScheduler>

export function createAutosaveScheduler(ports: AutosaveSchedulerPorts) {
  const clock = ports.clock ?? systemClock
  const elapsed = (): number => (clock.elapsed ? clock.elapsed() : clock.now())
  const quietMs = ports.quietMs ?? AUTOSAVE_QUIET_MS
  const budget = (ports.deadlineMs ?? AUTOSAVE_DEADLINE_MS) - (ports.leadMs ?? AUTOSAVE_DEADLINE_LEAD_MS)
  const retryMs = ports.retryMs ?? AUTOSAVE_RETRY_MS
  const states = new Map<string, PathState>()

  const stateOf = (path: string): PathState => {
    let st = states.get(path)
    if (!st) {
      st = { path, marks: [], captured: -1, quiet: null, deadline: null, requested: false, running: false, again: false, flushes: 0, holdUntilEdit: false }
      states.set(path, st)
    }
    return st
  }
  const clearQuiet = (st: PathState): void => {
    if (st.quiet !== null) clock.clearTimeout(st.quiet)
    st.quiet = null
    st.requested = false
  }
  const clearDeadline = (st: PathState): void => {
    if (st.deadline !== null) clock.clearTimeout(st.deadline)
    st.deadline = null
    delete st.deadlineAt
  }
  const forgetIfIdle = (st: PathState): void => {
    if (st.marks.length === 0 && !st.requested && !st.running && st.deadline === null && states.get(st.path) === st) {
      states.delete(st.path)
    }
  }
  /** Same epoch as the state, or the state's first: a record made again starts its gens again. */
  const adopt = (st: PathState, epoch: number): boolean => {
    if (st.epoch === undefined || st.epoch === epoch) {
      st.epoch = epoch
      return true
    }
    return false
  }

  /** The deadline, from the oldest mark: armed once and left alone by typing. */
  const armDeadline = (st: PathState): void => {
    const oldest = st.marks[0]
    if (!oldest) {
      clearDeadline(st)
      forgetIfIdle(st)
      return
    }
    if (st.running) return // armed again when the attempt ends
    const at = Math.max(oldest.t + budget, st.notBefore ?? -Infinity)
    if (st.deadline !== null && st.deadlineAt === at) return
    clearDeadline(st)
    st.deadlineAt = at
    st.deadline = clock.setTimeout(() => {
      st.deadline = null
      delete st.deadlineAt
      fire(st, 'deadline')
    }, Math.max(0, at - elapsed()))
  }

  const fire = (st: PathState, why: 'quiet' | 'deadline'): void => {
    if (st.running) {
      st.again = true
      return
    }
    clearQuiet(st)
    clearDeadline(st)
    if (why === 'deadline' && st.marks.length > 0 && ports.isSaved(st.path)) {
      // Settled without a save of this scheduler's (a Reload, a route's own write): nothing owed now.
      st.marks = []
      forgetIfIdle(st)
      return
    }
    if (why === 'deadline' && st.holdUntilEdit) {
      // Refused in a way repeating would not mend: owed still, with its age; checked again later.
      st.notBefore = elapsed() + retryMs
      armDeadline(st)
      return
    }
    st.running = true
    const flushesBefore = st.flushes
    let attempt: Promise<unknown>
    try { attempt = ports.flush(st.path) } catch { attempt = Promise.resolve() }
    void Promise.resolve(attempt).catch(() => undefined).then(() => {
      st.running = false
      if (st.flushes === flushesBefore && st.marks.length > 0) st.notBefore = elapsed() + retryMs
      if (states.get(st.path) !== st) return // moved or disposed meanwhile
      if (st.again) {
        st.again = false
        fire(st, 'quiet')
        return
      }
      armDeadline(st)
      forgetIfIdle(st)
    })
  }

  const receipts: SaveReceiptPort = {
    edited(receipt) {
      const st = stateOf(receipt.path)
      if (!adopt(st, receipt.epoch)) {
        st.epoch = receipt.epoch
        st.marks = []
        st.captured = -1
        delete st.notBefore
      }
      st.holdUntilEdit = false
      const last = st.marks.at(-1)
      if (!last || st.captured >= last.gen) st.marks.push({ gen: receipt.gen, at: receipt.at, t: elapsed() })
      armDeadline(st)
    },
    saveStarted(receipt) {
      const st = states.get(receipt.path)
      if (!st || !adopt(st, receipt.epoch)) return
      st.captured = Math.max(st.captured, receipt.gen)
    },
    saveCompleted(receipt) {
      const st = states.get(receipt.path)
      if (!st || !adopt(st, receipt.epoch)) return
      if (receipt.outcome !== 'flushed' || receipt.gen === undefined) {
        if (WAIT_FOR_TYPING.has(receipt.outcome)) st.holdUntilEdit = true
        return
      }
      const upTo = receipt.gen
      st.flushes += 1
      st.holdUntilEdit = false
      st.marks = st.marks.filter((mark) => mark.gen > upTo)
      delete st.notBefore
      armDeadline(st)
    },
  }

  /** The quiet save, re-armed. */
  const request = (path: string): void => {
    const st = stateOf(path)
    if (st.quiet !== null) clock.clearTimeout(st.quiet)
    st.requested = true
    st.quiet = clock.setTimeout(() => {
      st.quiet = null
      if (!st.requested) return
      fire(st, 'quiet')
    }, quietMs)
    armDeadline(st)
  }

  return {
    /** Feed the owner's receipts here. */
    receipts,
    /** The writer typed (or the buffer otherwise needs writing): the quiet save, re-armed. */
    request,
    /** Tab switch, window blur: every waiting quiet save, now. */
    flushPending(): void {
      for (const st of [...states.values()]) if (st.requested) fire(st, 'quiet')
    },
    /** A route writes the path itself: its quiet save is dropped. What it owes, and the deadline, stay. */
    cancel(path: string): void {
      const st = states.get(path)
      if (!st) return
      clearQuiet(st)
      forgetIfIdle(st)
    },
    /** The close's flush writes every buffer: every quiet save is dropped. What is owed stays. */
    cancelQuiet(): void {
      for (const st of [...states.values()]) {
        clearQuiet(st)
        forgetIfIdle(st)
      }
    },
    /** The owner took the buffer at `from` to `to` (a rename, a move): what it owes goes with it. */
    moved(from: string, to: string): void {
      if (from === to) return
      const st = states.get(from)
      if (!st) return
      states.delete(from)
      const wasRequested = st.requested
      clearQuiet(st)
      clearDeadline(st)
      const existing = states.get(to)
      if (existing) {
        clearQuiet(existing)
        clearDeadline(existing)
      }
      st.path = to
      states.set(to, st)
      if (wasRequested) request(to)
      else armDeadline(st)
    },
    /** When the oldest edit of the path not yet confirmed on disk was made; undefined: nothing owed. */
    oldestUnflushedAt(path: string): number | undefined {
      return states.get(path)?.marks[0]?.at
    },
    /**
     * Read-only, for the editor receipts (backup-helper-receipts.ts): the oldest edit of this epoch not yet
     * confirmed on disk, when its gen is at most `throughGen` (a save carrying that gen carries it): its
     * receipt's wall time `at`, as read when the edit was made, and its age on the elapsed clock now.
     * Undefined otherwise. Never moves a timer or a mark.
     */
    owedSince(path: string, epoch: number, throughGen: number): { at: number; ageMs: number } | undefined {
      const st = states.get(path)
      const oldest = st?.epoch === epoch ? st.marks[0] : undefined
      return oldest && oldest.gen <= throughGen ? { at: oldest.at, ageMs: Math.max(0, elapsed() - oldest.t) } : undefined
    },
    /** Every path owing a write, with the time of its oldest unconfirmed edit. */
    owed(): Array<{ path: string; since: number }> {
      const out: Array<{ path: string; since: number }> = []
      for (const st of states.values()) if (st.marks[0]) out.push({ path: st.path, since: st.marks[0].at })
      return out
    },
    /** When the path's deadline attempt is due, in elapsed time (tests, diagnostics). */
    deadlineOf(path: string): number | undefined {
      return states.get(path)?.deadlineAt
    },
    /** Every timer cleared (the app unmounted). */
    dispose(): void {
      for (const st of states.values()) {
        clearQuiet(st)
        clearDeadline(st)
      }
      states.clear()
    },
  }
}
