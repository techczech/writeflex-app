/**
 * The editor's side of the backup receipts (locked plan §13): what the renderer tells main about one
 * window's edits and saves, and the per-document states main answers. Main owns everything else: it stamps
 * the owner of this window's binding, keeps the durable outbox and speaks to the helper
 * (main/backup-helper/receipt-service.ts). One adapter per App root; nothing here is a protection claim.
 *
 * - Lifetime: every call carries the opaque token main issued for this window's binding of the folder this
 *   adapter shows (`api.lifetime(root)`, asked once on activation and again after main answers `stale`).
 *   Main refuses a call whose token is not its current lifetime, before anything is stored, so a call sent
 *   under a folder, page or binding main has since retired never becomes the replacement's debt. Main gives
 *   no token for another folder; this module never names an owner.
 * - Edits: one report per debt episode of a document, never per keystroke. The first edit after main last
 *   heard of the document's debt (or after a save flushed what main heard) arms one shared timer,
 *   RECEIPT_REPORT_DELAY_MS later and not moved by later typing; it then reports the latest gen with `at`,
 *   the original wall time of the oldest owed edit (originalAt below). Further typing in the episode costs a
 *   map write: main already holds the debt and its oldest time, and the save carries the newer gens.
 * - Saves: `saveMeta` gives file:save the epoch and gen the owner captured with the bytes (never the gen of
 *   now), the token and the original time of the oldest edit those bytes carry that is not yet on disk. That
 *   time comes from the autosave scheduler's marks (autosave-scheduler.ts owedSince), the one record of owed
 *   edits; this module keeps only the time an episode began, as a fallback. No token yet: no metadata, and
 *   the save goes ahead as before without a receipt.
 * - Calls in flight: at most MAX_PENDING_RECEIPT_CALLS calls of one window port (lifetime, reports, status,
 *   across documents and across the adapters of successive roots) are unresolved in main at once, and at most
 *   one report per document. A slot is held until main's call itself settles, however long: a deadline only
 *   stops a Sync read waiting for a status answer, it never frees a slot. Edits while a document's report is
 *   unresolved only move its latest gen; the debt keeps its original time. At most one status job (the wait
 *   for a token and the status call) of an adapter is unresolved, until it actually settles: a status asked
 *   meanwhile is not started and proves nothing, and a job whose caller stopped waiting (its deadline), or
 *   whose adapter was deactivated or edited since, never starts main's status call.
 * - Answers: `noted` means main stored the debt durably, nothing more. `disabled` or `not-registered` turns
 *   the adapter off for good (no reports, no metadata, no status, no timer): its root is not in the trial.
 *   `stale` drops the token. Any other answer or a rejection changes nothing and schedules nothing; the next
 *   edit, flushed save or save metadata carries the debt again. No retry timer, no queue per edit.
 * - Status: `captured()` is the set of documents edited in this window (path, epoch, latest gen), taken in
 *   the turn a Sync view is captured, or null while any of them has edits no flushed save carries (then
 *   nothing could be proven and main is not asked); `proves` says whether main's answer shows every one of them
 *   remote-verified at that gen with main's own proof. Anything else (an omitted document, another gen, a
 *   lane not open, `covered: false`) proves nothing. `lastStatus()` (diagnostics) is cleared by any edit,
 *   save, move or deactivation, so it never describes an earlier set of gens as the current one.
 *
 * Times (plan §3 `at`, the original wall time, never refreshed): the renderer, main and the helper read the
 * same machine's wall clock. An edit's receipt carries the wall time read when it was made; this module and
 * the scheduler also keep the monotonic time they saw it. The time sent is the earlier of that original
 * reading and (wall now − monotonic age): a later delivery, a retry or a forward jump of the wall clock after
 * the edit never makes it younger; a backward jump makes it earlier (older debt, the conservative side). Main
 * keeps the earlier of this and its own time at the call's entry. A wall clock that was wrong when the edit
 * was made is not corrected; the monotonic clock may not run during sleep, which only makes the second
 * candidate later, never the result.
 *
 * Bounded: MAX_TRACKED_PATHS documents; past that the adapter reports nothing new and proves nothing.
 *
 * Enrolment changes (`rebind`): main replaces its receipt instance when the enrolled folders change, so
 * this window's lifetime and owner end even when its own folder is unchanged. The same adapter keeps its
 * documents, gens and the original time of every owed edit; rebind drops the token, forgets what the old
 * owner was told and reports every document still owed again, once, through the same shared call slots
 * (with `at` from the scheduler's marks, as for any report). While main is changing the enrolment it
 * answers `refused: reconfiguring`, which changes nothing here. Only `disabled`/`not-registered` from the
 * new instance turns the adapter off. A root change still makes a new adapter (App).
 */
import {
  BACKUP_RECEIPT_EARLIEST_AT, BACKUP_RECEIPT_MAX_DOCS,
  type BackupReceiptDocInput, type BackupReceiptEditAnswer, type BackupReceiptEditInput,
  type BackupReceiptLifetimeAnswer, type BackupReceiptSaveInput, type BackupReceiptStatusAnswer,
} from '../../../shared/backup-helper'
import type { EditReceipt, SaveCompletionReceipt, SaveIdentity, SaveReceiptPort } from './save-receipts'

export const MAX_TRACKED_PATHS = 10_000
/** How long the first edit of an episode waits before it is reported (coalescing, not a debounce). */
export const RECEIPT_REPORT_DELAY_MS = 1_000
/** No status read waits longer than this for main: under the Sync read's own 10 s bound
 *  (helper-sync-adapter.ts), so a slow receipt answer settles as "not proven" and never fails that read. */
export const RECEIPT_CALL_TIMEOUT_MS = 5_000
/** Receipt calls of one window port unresolved in main at once, all kinds and documents together. */
export const MAX_PENDING_RECEIPT_CALLS = 4

export type ReceiptApi = {
  lifetime(root: string): Promise<BackupReceiptLifetimeAnswer>
  reportEdit(doc: BackupReceiptEditInput): Promise<BackupReceiptEditAnswer>
  status(docs: BackupReceiptDocInput[], lifetime: string): Promise<BackupReceiptStatusAnswer>
}

export type ReceiptClock = {
  /** Wall ms (Date.now). */
  now(): number
  /** Monotonic ms (performance.now). */
  elapsed(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type HelperReceiptOptions = {
  api?: ReceiptApi
  /** The folder this adapter's window shows (App's root): the only one main gives it a token for. */
  root?: string
  /** The autosave scheduler's oldest owed edit of this epoch at or below `throughGen`: its original wall
   *  time and its monotonic age now. */
  owedSince?(path: string, epoch: number, throughGen: number): { at: number; ageMs: number } | undefined
  clock?: ReceiptClock
  reportDelayMs?: number
  callTimeoutMs?: number
}

/** When an edit was made: the wall time read then, and the monotonic time seen then. */
type Since = { at: number; t: number }

type Doc = {
  epoch: number
  /** The latest gen edited. */
  gen: number
  /** The highest gen a flushed save of this epoch captured. */
  flushed: number
  /** The highest gen main answered `noted` for, under the current owner. */
  told: number
  /** The oldest edit of the episode main has not noted; kept through failed and unresolved reports. */
  since: Since | null
  /** Waiting for the shared timer to report it. */
  waiting: boolean
  /** A report of it is unresolved in main (holds a slot until main's call settles). */
  sending: boolean
}

export type HelperReceiptAdapter = SaveReceiptPort & {
  /** file:save metadata for the bytes the owner captured; undefined when receipts are off here or no token. */
  saveMeta(path: string, identity: SaveIdentity): BackupReceiptSaveInput | undefined
  /** The documents edited in this window as they are now; null when there are none or too many to ask. */
  captured(): BackupReceiptDocInput[] | null
  /** Main's receipt status for `docs`, bounded; null when not delivered (timeout, rejection, off, inactive). */
  status(docs: BackupReceiptDocInput[]): Promise<BackupReceiptStatusAnswer | null>
  /** The latest status answer main gave this adapter for the documents as they still are (diagnostics only,
   *  never proof); null once anything was edited, saved or moved since. */
  lastStatus(): BackupReceiptStatusAnswer | null
  /** The owner took the buffer at `from` to `to`: main knows nothing of it under the new path. */
  moved(from: string, to: string): void
  /** Receipts flow only while active (App's layout effect for this root). Inactive: nothing is sent and
   *  every late answer is dropped. */
  activate(): void
  deactivate(): void
  /** Main's enrolment changed: bind again and report again what is still owed, keeping original times. */
  rebind(): void
  readonly mode: 'unknown' | 'on' | 'off'
}

const systemClock: ReceiptClock = {
  now: () => Date.now(),
  elapsed: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** One window port's unresolved calls, shared by every adapter using it; `wake` runs when one settles. */
type Slots = { pending: number; wake: Set<() => void> }
const portSlots = new WeakMap<object, Slots>()
const slotsOf = (api: object): Slots => {
  let slots = portSlots.get(api)
  if (!slots) portSlots.set(api, slots = { pending: 0, wake: new Set() })
  return slots
}

/** True only when `answer` shows every captured document remote-verified at its captured gen. */
export function proves(docs: readonly BackupReceiptDocInput[], answer: BackupReceiptStatusAnswer | null): boolean {
  if (!answer || answer.state !== 'reported' || answer.lane !== 'open' || answer.covered !== true) return false
  if (docs.length === 0 || answer.docs.length !== docs.length) return false
  return docs.every((want, i) => {
    const got = answer.docs[i]!
    return got.path === want.path && got.docEpoch === want.docEpoch && got.gen === want.gen && got.state === 'remote-verified'
      && got.blobOid !== null && got.verifiedAt !== null && got.snapshot !== null
  })
}

export function createHelperReceiptAdapter(options: HelperReceiptOptions = {}): HelperReceiptAdapter {
  const api = options.root !== undefined ? options.api : undefined
  const root = options.root ?? ''
  const clock = options.clock ?? systemClock
  const delay = options.reportDelayMs ?? RECEIPT_REPORT_DELAY_MS
  const timeoutMs = options.callTimeoutMs ?? RECEIPT_CALL_TIMEOUT_MS
  const slots = api ? slotsOf(api) : null
  const docs = new Map<string, Doc>()
  let mode: 'unknown' | 'on' | 'off' = api ? 'unknown' : 'off'
  let active = true
  /** Bumped on deactivate: an answer from an earlier activation is dropped. */
  let generation = 0
  let overflow = false
  let timer: unknown = null
  let owner: string | null = null
  /** Main's token for this window's current lifetime, and the request for one while it is unresolved. */
  let token: string | null = null
  let binding: Promise<string | null> | null = null
  /** A report waited for a free slot: the next settled call schedules the timer again. */
  let starved = false
  let last: BackupReceiptStatusAnswer | null = null
  /** Bumped by every edit, save, move and deactivation: a status answer read before it is not current. */
  let version = 0
  /** A status job (token wait and status call) is unresolved; cleared only when it actually settles. */
  let statusJob = false

  const isOff = (): boolean => mode === 'off'
  const wake = (): void => {
    if (!starved || !active || mode === 'off') return
    starved = false
    schedule()
  }
  if (slots) slots.wake.add(wake)
  const turnOff = (): void => {
    mode = 'off'
    docs.clear()
    if (timer !== null) clock.clearTimeout(timer)
    timer = null
    token = null
    last = null
    slots?.wake.delete(wake)
  }
  /**
   * Starts main's call when a slot is free; null (nothing started) when all are taken. The slot is held
   * until the call itself settles; a rejection settles as null.
   */
  const call = <T>(run: () => Promise<T>): Promise<T | null> | null => {
    if (!slots || slots.pending >= MAX_PENDING_RECEIPT_CALLS) return null
    slots.pending += 1
    let started: Promise<T>
    try { started = Promise.resolve(run()) } catch (error) { started = Promise.reject(error) }
    const release = (): void => {
      slots.pending -= 1
      for (const next of [...slots.wake]) next()
    }
    return started.then((value) => { release(); return value }, () => { release(); return null })
  }
  /** Stops waiting after the call timeout (then `expired`); the call keeps its slot until it settles. */
  const deadline = <T>(pending: Promise<T | null>, expired: () => void): Promise<T | null> => new Promise((resolve) => {
    let done = false
    const handle = clock.setTimeout(() => { if (!done) { done = true; expired(); resolve(null) } }, timeoutMs)
    void pending.then((value) => { if (!done) { done = true; clock.clearTimeout(handle); resolve(value) } })
  })
  /** Main's token for the folder this adapter shows; null when main gives none now. */
  const bind = (): Promise<string | null> => {
    if (token !== null) return Promise.resolve(token)
    if (binding) return binding
    const mine = generation
    const started = call(() => api!.lifetime(root))
    if (!started) { starved = true; return Promise.resolve(null) }
    const made: Promise<string | null> = started.then((answer) => {
      if (binding === made) binding = null
      if (mine !== generation || !active || mode === 'off' || !answer) return null
      if (answer.state === 'disabled' || answer.state === 'not-registered') { turnOff(); return null }
      if (answer.state !== 'bound') return null
      token = answer.lifetime
      return token
    })
    binding = made
    return made
  }
  /**
   * The original wall time of the oldest owed edit of `path` at or below `throughGen` (the module comment,
   * Times); undefined when none is known (main then uses its own time at entry).
   */
  const originalAt = (path: string, epoch: number, throughGen: number, own: Since | null): number | undefined => {
    const now = clock.now()
    let at = Infinity
    const owed = options.owedSince?.(path, epoch, throughGen)
    if (owed) at = Math.min(owed.at, now - owed.ageMs)
    if (own) at = Math.min(at, own.at, now - Math.max(0, clock.elapsed() - own.t))
    const whole = Math.floor(at)
    return Number.isSafeInteger(whole) && whole >= BACKUP_RECEIPT_EARLIEST_AT ? whole : undefined
  }
  /** Main holds no open debt of ours for this document, and it was edited beyond what flushed. */
  const owes = (d: Doc): boolean => d.gen > d.flushed && d.told <= d.flushed && !d.waiting && !d.sending
  const schedule = (): void => {
    if (timer === null && active && mode !== 'off') timer = clock.setTimeout(fire, delay)
  }
  const arm = (d: Doc, at?: number): void => {
    d.since ??= { at: at ?? clock.now(), t: clock.elapsed() }
    d.waiting = true
    schedule()
  }
  const flush = (): void => {
    if (!active || mode === 'off') return
    if (token === null) {
      const mine = generation
      void bind().then((made) => {
        // A rebind or deactivation since: what it armed is its own.
        if (mine !== generation) return
        if (made !== null) { flush(); return }
        // No token now (main gives none, or no slot): the next edit arms again; a free slot wakes this.
        if (!starved && active) for (const d of docs.values()) d.waiting = false
      })
      return
    }
    for (const [path, d] of docs) {
      if (d.waiting && !d.sending && !send(path, d, token)) { starved = true; return }
    }
  }
  const fire = (): void => {
    timer = null
    flush()
  }
  const send = (path: string, d: Doc, lifetime: string): boolean => {
    const gen = d.gen
    const at = originalAt(path, d.epoch, gen, d.since)
    const mine = generation
    const started = call(() => api!.reportEdit({ path, docEpoch: d.epoch, gen, lifetime, ...(at !== undefined ? { at } : {}) }))
    if (!started) return false
    d.waiting = false
    d.sending = true
    void started.then((answer) => {
      // The document's slot is free once main's call settled, whatever became of this activation.
      if (docs.get(path) === d) d.sending = false
      // Sent under a binding since replaced (rebind): its answer is the old owner's; still owed is reported again.
      if (mine !== generation) { if (active && mode !== 'off' && docs.get(path) === d && owes(d)) arm(d); return }
      if (docs.get(path) !== d || mode === 'off' || !answer) return
      if (answer.state === 'disabled' || answer.state === 'not-registered') { turnOff(); return }
      if (answer.state === 'stale') { if (token === lifetime) token = null; return }
      if (answer.state !== 'noted') return
      mode = 'on'
      if (owner !== null && owner !== answer.owner) {
        // Main replaced this window's owner (the folder bound again): the new one heard of no other debt.
        for (const other of docs.values()) other.told = 0
      }
      owner = answer.owner
      d.told = Math.max(d.told, gen)
      d.since = null
      for (const other of docs.values()) if (owes(other)) arm(other)
    })
    return true
  }

  const docFor = (path: string, epoch: number): Doc | null => {
    const d = docs.get(path)
    if (d && d.epoch === epoch) return d
    if (!d && docs.size >= MAX_TRACKED_PATHS) { overflow = true; return null }
    // A record made again (new epoch) starts its gens again; main names it as another document.
    const made: Doc = { epoch, gen: 0, flushed: 0, told: 0, since: null, waiting: false, sending: false }
    docs.set(path, made)
    return made
  }

  return {
    get mode() { return mode },
    edited(receipt: EditReceipt) {
      if (mode === 'off') return
      const d = docFor(receipt.path, receipt.epoch)
      if (!d) return
      d.gen = receipt.gen
      version += 1
      last = null
      if (owes(d)) arm(d, receipt.at)
    },
    saveStarted() {
      // The save's identity travels with its bytes (saveMeta); nothing is reported here.
    },
    saveCompleted(receipt: SaveCompletionReceipt) {
      if (mode === 'off' || receipt.outcome !== 'flushed' || receipt.gen === undefined) return
      const d = docs.get(receipt.path)
      if (!d || d.epoch !== receipt.epoch) return
      d.flushed = Math.max(d.flushed, receipt.gen)
      version += 1
      last = null
      // Nothing of this episode is owed any more (a waiting or unresolved report still names its time).
      if (d.gen <= d.flushed && !d.waiting && !d.sending) d.since = null
      // Typing during the write is a new episode main has not heard of.
      if (owes(d)) arm(d)
    },
    saveMeta(path, identity) {
      if (mode === 'off' || !active || token === null) return undefined
      const d = docs.get(path)
      const at = originalAt(path, identity.docEpoch, identity.gen, d && d.epoch === identity.docEpoch ? d.since : null)
      return { docEpoch: identity.docEpoch, gen: identity.gen, lifetime: token, ...(at !== undefined ? { at } : {}) }
    },
    captured() {
      if (mode === 'off' || overflow || docs.size === 0 || docs.size > BACKUP_RECEIPT_MAX_DOCS) return null
      // A document with edits no flushed save carries cannot be remote-verified at its gen: nothing to ask
      // main (so typing never adds a receipt status call), and nothing is proven.
      const out: BackupReceiptDocInput[] = []
      for (const [path, d] of docs) {
        if (d.gen > d.flushed) return null
        out.push({ path, docEpoch: d.epoch, gen: d.gen })
      }
      return out
    },
    async status(want) {
      // One job at a time, held until it settles (not until its deadline): repeated reads while main or the
      // token is hung add no waiting work; this read proves nothing.
      if (mode === 'off' || !active || !api || statusJob) return null
      statusJob = true
      const mine = generation
      const asked = version
      let expired = false
      const job = (async (): Promise<{ answer: BackupReceiptStatusAnswer; lifetime: string } | null> => {
        try {
          const lifetime = await bind()
          // Not started for a caller that stopped waiting, an earlier activation or an older set of gens.
          if (lifetime === null || expired || mine !== generation || asked !== version) return null
          const started = call(() => api.status(want, lifetime))
          const got = started ? await started : null
          return got ? { answer: got, lifetime } : null
        } finally {
          statusJob = false
        }
      })()
      // One deadline over the token and the status: a Sync read never waits longer than the call timeout.
      const answer = await deadline(job, () => { expired = true })
      // Re-read after the await (`mode` may have turned off meanwhile).
      if (!answer || mine !== generation || !active || isOff()) return null
      if (answer.answer.state === 'disabled' || answer.answer.state === 'not-registered') turnOff()
      else if (answer.answer.state === 'stale' && token === answer.lifetime) token = null
      if (asked === version && !isOff()) last = answer.answer
      return answer.answer
    },
    lastStatus: () => last,
    moved(from, to) {
      const d = docs.get(from)
      if (!d || from === to) return
      docs.delete(from)
      version += 1
      last = null
      // Under `to`, main has no record of this document: it must hear of it and prove it afresh. Its
      // oldest edit keeps its original time.
      const moved: Doc = { ...d, told: 0, flushed: 0, sending: false }
      docs.set(to, moved)
      if (mode !== 'off' && !moved.waiting && moved.gen > 0) arm(moved)
      else if (moved.waiting) schedule()
    },
    activate() {
      if (!active) {
        active = true
        if (mode !== 'off') slots?.wake.add(wake)
      }
      if (mode === 'off') return
      // Asked now, so the first save already carries it.
      if (token === null) void bind()
      if ([...docs.values()].some((d) => d.waiting)) schedule()
    },
    rebind() {
      if (!api) return
      generation += 1
      version += 1
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
      token = null
      binding = null
      owner = null
      last = null
      starved = false
      // The new owner heard of nothing; a document whose report is unresolved is re-armed when it settles.
      for (const d of docs.values()) { d.told = 0; d.waiting = false }
      if (mode === 'off' && active) slots?.wake.add(wake)
      mode = 'unknown'
      if (!active) return
      for (const d of docs.values()) if (owes(d)) arm(d)
      void bind()
    },
    deactivate() {
      if (!active) return
      active = false
      generation += 1
      version += 1
      if (timer !== null) clock.clearTimeout(timer)
      timer = null
      token = null
      last = null
      starved = false
      slots?.wake.delete(wake)
      // Unresolved reports keep their slots and their documents' `sending` until main's calls settle.
    },
  }
}
