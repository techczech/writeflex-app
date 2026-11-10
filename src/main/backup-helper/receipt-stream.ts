/**
 * One vault's receipt stream as main runs it (locked plan §7, §13): the outbox's one seq source, sent
 * strictly in order over the receipts lane, one request on the wire at a time.
 *
 * - Work is derived from the durable outbox, never from memory: a seq is assigned to an exact body in one
 *   commit before the body is written to the socket. A body without a durable result is resent with the
 *   same seq, identically, before any later seq. A result is stored, its effect applied to the local
 *   document rows and the acknowledgement advanced in one commit; only the next request tells the helper.
 * - Save-bound work goes first (§6 priority): a save's flush, an owed abandon, a wanted write start, the
 *   edit reference a save needs. A document's own unreported edits are sent only while nothing of it is
 *   registered with the helper (its first unflushed age is already there).
 * - No-seq errors (§7 table) keep the body and retry later; a body the helper can never accept (bad
 *   request, out of scope) is withdrawn, its seq reused, its document marked uncertain. `retired`,
 *   `conflict`, `out-of-order` and `ack-ahead` stop the stream (persisted): debt and bytes stay, coverage
 *   stays unknown, and nothing is reset.
 * - Reconnect negotiates with openStream: the retained stream with equal identities resumes; a stream the
 *   helper proves new (rebased, another streamId) rebases (§13.4): unacknowledged bodies are void there,
 *   live refs are dropped, debt is re-reported, and durable bytes still verified on disk are flushed again.
 *   A retained stream whose identities differ from the outbox's is rejoined only when the outbox owes
 *   nothing; otherwise the stream stops for explicit recovery.
 * - A non-atomic write is authorised only by a durable `write-started` result for this intent, received on
 *   this connection, under this record, while its waiter is still waiting (§10.2). A result that arrives
 *   after the waiter gave up turns into an owed abandon: the destination was never opened.
 *
 * Nothing here starts, stops or inspects a helper process.
 */
import type { DocRef, OpenStreamResult, ReceiptResult, ReceiptStatusView, WantedDoc, WriterIncarnation } from '@app-patterns/vault-sync'
import { ReceiptsClientError, type ReceiptReply, type ReceiptsClient, type SeqBody } from '@app-patterns/vault-sync/helper'
import { type BlobOids } from './durable-file'
import { randomHex32 } from './receipt-identity'
import {
  MAX_HELD, MAX_INTENTS_PER_DOC, MAX_LOCAL_EDIT_REFS, MAX_OUTBOX_DOCS, sameDocRef,
  type DocEntry, type IntentRow, type Outbox, type OutboxStore, type ReceiptBody,
} from './outbox-store'

export type ReceiptsPort = Pick<ReceiptsClient, 'openStream' | 'send' | 'status' | 'closed' | 'close'>

export type LaneState =
  /** Not connected; a connection is made when there is work or a status request. */
  | 'offline' | 'connecting' | 'open'
  /** The helper refused the lane or the stream (an older helper, activation, another record format). */
  | 'unavailable'
  /** The stream needs explicit recovery; nothing is sent. */
  | 'stopped'

export type StreamOptions = {
  vault: string
  store: OutboxStore
  clientEpoch: number
  writer: WriterIncarnation | null
  connect: () => Promise<ReceiptsPort>
  now?: () => number
  /** Per request on the wire. Default 5 s. */
  requestTimeoutMs?: number
  /** Wait before the next attempt after a failure. Default 2 s doubling to 30 s. */
  retryMs?: (attempt: number) => number
  /** Rebase: whether the document at `path` still holds exactly these durable bytes. */
  verifyDurable?: (path: string, blob: BlobOids) => Promise<boolean>
}

/** One save of one document, from before its bytes are written until they are flushed or held. */
export type SaveIntent = {
  readonly intent: string
  /** Ask for the exact write start a non-atomic copy needs; false unless it arrived within `budgetMs`. */
  requestStart(budgetMs: number): Promise<boolean>
  /** The bytes are durable (synced, read back): the flush is owed. */
  durable(blob: BlobOids): Promise<void>
  /** An authorised copy ended with these durable bytes. */
  copied(blob: BlobOids): Promise<void>
  /** An authorised copy failed after its descriptors were closed: the abandon is owed. */
  copyClosed(): Promise<void>
  /** Take the hold route: these complete bytes are stored durably off the vault first. */
  hold(bytes: Uint8Array, blob: BlobOids): Promise<void>
  /** The save did not complete: nothing of it is durable. */
  failed(): Promise<void>
}

const RETRYABLE = new Set(['busy', 'window-full', 'pressure', 'ledger-full', 'clock-ahead', 'internal', 'stopping', 'outcome-unknown'])
const WITHDRAW = new Set(['bad-request', 'out-of-scope', 'unknown-method'])
const STOP = new Set(['retired', 'conflict', 'out-of-order', 'ack-ahead'])

const defaultRetry = (attempt: number): number => Math.min(2_000 * 2 ** attempt, 30_000)

export const docKey = (doc: DocRef, path: string): string => `${doc.owner}/${doc.ownerEpoch}/${doc.docEpoch}/${path}`
export const findDoc = (o: Outbox, doc: DocRef, path: string): DocEntry | undefined => o.docs.find((d) => d.path === path && sameDocRef(d.doc, doc))

type StartWaiter = { state: 'waiting' | 'granted' | 'refused' | 'expired'; resolve: (ok: boolean) => void }

/** Thrown by the hold route when the held table is full: nothing names the bytes, the overflow floor and the debt stay. */
export class HeldCapacityFull extends Error {
  override readonly name = 'HeldCapacityFull'
}

/** Unreported debt of `d` through `gen` since `at` (the oldest time kept). */
function foldUnreported(d: DocEntry, gen: number, at: number): void {
  d.unreported = d.unreported ? { throughGen: Math.max(d.unreported.throughGen, gen), at: Math.min(d.unreported.at, at) } : { throughGen: gen, at }
}

/**
 * A save intent about to go without completing: its gen and original age stay as the document's unreported
 * debt unless a sent edit or a live edit reference already carries them to the helper.
 */
function keepIntentDebt(d: DocEntry, i: IntentRow): void {
  if (i.editRef === null && i.refSeq === null) foldUnreported(d, i.gen, i.at)
}

/** An intent takes an older age it now covers. A reference bound with a younger age is let go: a new edit
 *  with the older age goes first (the helper keeps the older time of equal gens), then the flush. An edit
 *  already on the wire (`refSeq`) is answered as sent but does not bind (#applyResult checks its age). */
function lowerAge(i: IntentRow, at: number): void {
  if (at >= i.at) return
  i.at = at
  if (i.phase === 'durable-bytes' || i.phase === 'pending-ref') i.editRef = null
}

/** A document's flushed save as a rebase verified it: its own values, copied, never the live row. */
type FlushedTuple = { path: string; gen: number; blob: BlobOids; blobOid: string; seq: number; at: number; savedAt: number }

function flushedTuple(d: DocEntry): FlushedTuple {
  const f = d.flushed!, s = d.saved!
  return { path: d.path, gen: f.gen, blob: { sha1: s.blob.sha1, sha256: s.blob.sha256 }, blobOid: f.blobOid, seq: f.seq, at: f.at, savedAt: s.at }
}

/** Whether `d` still holds exactly the flushed save `t` was verified for (doc, path, gen, blob, original age). */
function sameFlushedTuple(t: FlushedTuple, d: DocEntry): boolean {
  const f = d.flushed, s = d.saved
  return !!f && !!s && d.path === t.path
    && f.gen === t.gen && f.blobOid === t.blobOid && f.seq === t.seq && f.at === t.at
    && s.gen === t.gen && s.at === t.savedAt && s.blob.sha1 === t.blob.sha1 && s.blob.sha256 === t.blob.sha256
}

export class ReceiptStream {
  readonly vault: string
  #state: LaneState = 'offline'
  #conn: ReceiptsPort | null = null
  #closed = false
  #pumping = false
  #again = false
  #attempt = 0
  #retryAt = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  /** The one connection attempt and openStream negotiation in flight, shared by the pump and status. */
  #opening: Promise<boolean> | null = null
  /** Raised by close and stop: an attempt begun before then never publishes its connection. */
  #lifetime = 0
  readonly #starts = new Map<string, StartWaiter>()
  readonly #o: Required<Omit<StreamOptions, 'verifyDurable'>> & Pick<StreamOptions, 'verifyDurable'>
  /** Settles when the stream has nothing more to send now (tests and shutdown wait on it). */
  #idle: Promise<void> = Promise.resolve()
  #ready: Promise<void>

  constructor(options: StreamOptions) {
    this.vault = options.vault
    this.#o = { now: Date.now, requestTimeoutMs: 5_000, retryMs: defaultRetry, ...options }
    if (this.#o.store.value.stopped) this.#state = 'stopped'
    this.#ready = this.#normaliseEarlierProcess().catch(() => undefined)
  }

  get state(): LaneState { return this.#state }
  get outbox(): Outbox { return this.#o.store.value }
  get writer(): WriterIncarnation | null { return this.#o.writer }

  /**
   * An earlier process's intents (§13.5): a save that never reached `writing` never opened a destination,
   * so an outstanding write start of it becomes an owed abandon; `writing` stays guarded (never completion
   * evidence); durable bytes and closed abandons stay owed as they are. Whatever the save's bytes did, its
   * gen and original age stay owed by its own (earlier) owner: folded into that document's unreported debt,
   * in the same commit that lets the intent go, unless a sent edit or live reference already carries them.
   */
  async #normaliseEarlierProcess(): Promise<void> {
    const epoch = this.#o.clientEpoch
    const stale = this.#o.store.value.docs.some((d) => d.intents.some((i) => i.epoch < epoch && i.phase === 'pending-ref'))
    if (!stale) return
    await this.#o.store.commit((o) => {
      for (const d of o.docs) {
        d.intents = d.intents.filter((i) => {
          if (i.epoch >= epoch || i.phase !== 'pending-ref') return true
          keepIntentDebt(d, i)
          if (i.start === 'sent') { i.phase = 'closed-abandoned'; i.start = null; return true }
          return false
        })
      }
    })
  }

  /** The renderer's edit (stamped by main): kept as unreported debt, sent when nothing of it is registered. */
  async reportEdit(doc: DocRef, path: string, gen: number, at: number): Promise<void> {
    await this.#ready
    await this.#o.store.commit((o) => {
      const d = this.#ensureDoc(o, doc, path, at)
      if (!d) return
      const known = Math.max(d.flushed?.gen ?? -1, ...d.editRefs.map((r) => r.throughGen), ...d.intents.map((i) => i.gen))
      if (gen <= known && d.unreported === null) return
      foldUnreported(d, gen, at)
    })
    this.wake()
  }

  /** Records a save intent durably before the save writes anything. Null when the outbox cannot hold it. */
  async beginSave(doc: DocRef, path: string, gen: number, at: number): Promise<SaveIntent | null> {
    await this.#ready
    const intent = randomHex32()
    const made = await this.#o.store.commit((o) => {
      const d = this.#ensureDoc(o, doc, path, at)
      if (!d || d.intents.length >= MAX_INTENTS_PER_DOC) {
        o.overflowSince = Math.min(o.overflowSince ?? at, at)
        return false
      }
      const age = d.unreported ? Math.min(d.unreported.at, at) : at
      // Only a reference that carries this save's oldest age may stand for it.
      const ref = d.editRefs.find((r) => r.throughGen === gen && r.at <= age)
      d.intents.push({
        intent, gen, at: age,
        editRef: ref?.seq ?? null, refSeq: null, start: null, writeRef: null, blob: null, phase: 'pending-ref', retries: 0, epoch: this.#o.clientEpoch,
      })
      return true
    })
    if (!made) return null
    this.wake()
    return this.#intentHandle(doc, path, intent)
  }

  #intentHandle(doc: DocRef, path: string, intent: string): SaveIntent {
    const edit = (change: (row: IntentRow, d: DocEntry, o: Outbox) => void) => this.#o.store.commit((o) => {
      const d = findDoc(o, doc, path)
      const row = d?.intents.find((i) => i.intent === intent)
      if (d && row) change(row, d, o)
    }).then(() => this.wake())
    return {
      intent,
      requestStart: (budgetMs) => this.#requestStart(doc, path, intent, budgetMs),
      durable: (blob) => this.#published(doc, path, intent, blob),
      copied: (blob) => this.#published(doc, path, intent, blob),
      // The edit is still unsaved: its debt stays with the document while the abandon is owed.
      copyClosed: () => edit((row, d) => { if (row.phase === 'writing' || row.phase === 'pending-ref') keepIntentDebt(d, row); row.phase = 'closed-abandoned'; row.start = null }),
      hold: (bytes, blob) => this.#hold(doc, path, intent, bytes, blob),
      failed: () => edit((row, d) => {
        // Nothing of this save is durable, but its edit is still owed: the debt stays before the intent goes.
        if (row.phase === 'pending-ref' || row.phase === 'writing') keepIntentDebt(d, row)
        // An outstanding write start may still be granted: the abandon then says no destination was opened.
        if (row.start === 'sent' || row.writeRef !== null) { row.phase = 'closed-abandoned'; row.start = null; return }
        if (row.phase === 'pending-ref') d.intents = d.intents.filter((i) => i !== row)
      }),
    }
  }

  async #requestStart(doc: DocRef, path: string, intent: string, budgetMs: number): Promise<boolean> {
    if (!this.#o.writer || this.#closed || this.#state === 'stopped' || this.#state === 'unavailable') return false
    let wanted = false
    try {
      wanted = await this.#o.store.commit((o) => {
        const row = findDoc(o, doc, path)?.intents.find((i) => i.intent === intent)
        if (!row || row.phase !== 'pending-ref' || row.start !== null) return false
        row.start = 'wanted'
        return true
      })
    } catch { return false }
    if (!wanted) return false
    return new Promise<boolean>((resolve) => {
      const waiter: StartWaiter = { state: 'waiting', resolve }
      this.#starts.set(intent, waiter)
      const timer = setTimeout(() => {
        if (waiter.state !== 'waiting') return
        waiter.state = 'expired'
        if (this.#starts.get(intent) === waiter) this.#starts.delete(intent)
        resolve(false)
      }, budgetMs)
      const done = waiter.resolve
      waiter.resolve = (ok) => { clearTimeout(timer); if (this.#starts.get(intent) === waiter) this.#starts.delete(intent); done(ok) }
      this.wake()
    })
  }

  /** Durable bytes of this intent's gen: the flush is owed, and held bytes it supersedes may go. */
  async #published(doc: DocRef, path: string, intent: string, blob: BlobOids): Promise<void> {
    const at = this.#o.now()
    const superseded = await this.#o.store.commit((o) => {
      const d = findDoc(o, doc, path)
      const row = d?.intents.find((i) => i.intent === intent)
      if (!d || !row) return []
      row.phase = 'durable-bytes'
      row.blob = blob
      row.start = null
      d.saved = { gen: row.gen, blob, at }
      // An older save of this document whose flush is not on the wire yet is covered by this one's (a flush of
      // gen covers every gen up to it): it goes, and its age stays with this intent.
      const older = d.intents.filter((i) => i !== row && i.phase === 'durable-bytes' && i.gen < row.gen && i.writeRef === null)
      for (const i of older) lowerAge(row, i.at)
      d.intents = d.intents.filter((i) => !older.includes(i))
      // This exact document published a gen at least as new, durably: older held bytes of it are superseded,
      // and their original ages stay with this publication's flush until it is captured.
      const gone = o.held.filter((h) => h.path === path && sameDocRef(h.doc, doc) && h.gen <= row.gen && h.intent !== intent)
      for (const h of gone) lowerAge(row, h.at)
      o.held = o.held.filter((h) => !gone.includes(h))
      return gone.map((h) => h.intent)
    })
    for (const held of superseded) await this.#o.store.removeHeld(held)
    this.wake()
  }

  async #hold(doc: DocRef, path: string, intent: string, bytes: Uint8Array, blob: BlobOids): Promise<void> {
    // The replacement bytes are durable first; only then does the outbox name them and let older ones go.
    const file = await this.#o.store.writeHeld(intent, bytes)
    const at = this.#o.now()
    // If this commit fails, the outbox does not name these bytes; they are not lost, but nothing points at them,
    // and the intent stays for the save's own failure to keep its debt.
    const outcome = await this.#o.store.commit((o): { full: true } | { full: false; superseded: string[] } => {
      const d = findDoc(o, doc, path)
      const row = d?.intents.find((i) => i.intent === intent)
      const gen = row?.gen ?? 0
      const gone = o.held.filter((h) => h.path === path && sameDocRef(h.doc, doc) && h.gen <= gen)
      // The replacement keeps the oldest age it stands for, that of every held save it supersedes included.
      const age = Math.min(row?.at ?? at, ...gone.map((h) => h.at))
      // Room is checked before anything is let go: a full table keeps every held entry, and the new bytes'
      // debt stays as the document's unreported debt plus a durable overflow floor (cleared only by U1).
      if (o.held.length - gone.length >= MAX_HELD) {
        o.overflowSince = Math.min(o.overflowSince ?? age, age)
        if (d && row) keepIntentDebt(d, row)
        return { full: true }
      }
      o.held = o.held.filter((h) => !gone.includes(h))
      o.held.push({ intent, path, doc, gen, blob, at: age, file: file.split('/').at(-1)! })
      if (d && row) {
        // A write start already on the wire may still be granted: then the abandon is owed (never opened).
        if (row.start === 'sent' || row.writeRef !== null) { row.phase = 'closed-abandoned'; row.start = null }
        else d.intents = d.intents.filter((i) => i !== row)
      }
      return { full: false, superseded: gone.map((h) => h.intent) }
    })
    // The bytes stay on disk under their intent's name (removed only by a later reconciliation).
    if (outcome.full) throw new HeldCapacityFull(`${path}: the held store is full; the save's debt and the overflow floor are kept.`)
    for (const held of outcome.superseded) await this.#o.store.removeHeld(held)
    this.wake()
  }

  #ensureDoc(o: Outbox, doc: DocRef, path: string, at: number): DocEntry | null {
    const found = findDoc(o, doc, path)
    if (found) return found
    if (o.docs.length >= MAX_OUTBOX_DOCS) {
      o.overflowSince = Math.min(o.overflowSince ?? at, at)
      return null
    }
    const d: DocEntry = { doc: { ...doc }, path, unreported: null, editRefs: [], intents: [], saved: null, flushed: null, uncertain: null }
    o.docs.push(d)
    return d
  }

  /** Read-only receipt status for `want`, on the live lane only. */
  async status(want: readonly WantedDoc[]): Promise<ReceiptReply<ReceiptStatusView> | null> {
    await this.#ready
    if (!(await this.#ensureOpen())) return null
    const conn = this.#conn
    if (!conn) return null
    try {
      return await conn.status(this.vault, want, { timeoutMs: this.#o.requestTimeoutMs })
    } catch {
      return null
    }
  }

  /** Asks for the work to run now (it runs one batch at a time). */
  wake(): void {
    if (this.#closed) return
    if (this.#pumping) { this.#again = true; return }
    this.#pumping = true
    this.#idle = (async () => {
      try {
        await this.#ready
        do {
          this.#again = false
          await this.#drain()
        } while (this.#again && !this.#closed)
      } catch {
        this.#schedule()
      } finally {
        this.#pumping = false
      }
    })()
  }

  /** Settles once the stream has sent everything it can send now. */
  async settled(): Promise<void> {
    for (let i = 0; i < 100 && this.#pumping; i++) await this.#idle
  }

  close(): void {
    this.#closed = true
    this.#lifetime += 1
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    try { this.#conn?.close() } catch { /* already closed */ }
    this.#conn = null
    for (const waiter of [...this.#starts.values()]) if (waiter.state === 'waiting') { waiter.state = 'refused'; waiter.resolve(false) }
  }

  #schedule(): void {
    if (this.#closed || this.#timer) return
    const delay = this.#o.retryMs(this.#attempt)
    this.#attempt = Math.min(this.#attempt + 1, 16)
    this.#retryAt = this.#o.now() + delay
    this.#timer = setTimeout(() => { this.#timer = null; this.#retryAt = 0; this.wake() }, delay)
    this.#timer.unref?.()
  }

  #dropConnection(): void {
    const conn = this.#conn
    this.#conn = null
    if (this.#state === 'open' || this.#state === 'connecting') this.#state = 'offline'
    try { conn?.close() } catch { /* already closed */ }
  }

  async #stop(reason: string): Promise<void> {
    await this.#o.store.commit((o) => { o.stopped ??= { reason, at: this.#o.now() } }).catch(() => undefined)
    this.#state = 'stopped'
    this.#lifetime += 1
    this.#dropConnection()
    for (const waiter of [...this.#starts.values()]) if (waiter.state === 'waiting') { waiter.state = 'refused'; waiter.resolve(false) }
  }

  async #drain(): Promise<void> {
    for (;;) {
      if (this.#closed) return
      if (this.#o.store.value.stopped) { this.#state = 'stopped'; return }
      if (!(await this.#ensureOpen())) return
      const first = this.#o.store.value.sent[0]
      const entry: { seq: number; body: ReceiptBody } | null = first ?? (await this.#assignNext())
      if (!entry) return
      const next = await this.#send(entry.seq, entry.body)
      if (next === 'later') { this.#schedule(); return }
      if (next === 'stop') return
      if (next === 'applied') this.#attempt = 0
    }
  }

  /** The live connection, or one shared attempt to make it: connect and openStream together, published only once open. */
  #ensureOpen(): Promise<boolean> {
    if (this.#conn) return Promise.resolve(true)
    if (this.#opening) return this.#opening
    if (this.#closed || this.#state === 'stopped') return Promise.resolve(false)
    if (this.#o.now() < this.#retryAt) return Promise.resolve(false)
    const opening = this.#open().finally(() => { if (this.#opening === opening) this.#opening = null })
    this.#opening = opening
    return opening
  }

  async #open(): Promise<boolean> {
    const lifetime = this.#lifetime
    const current = () => !this.#closed && this.#lifetime === lifetime && this.#state !== 'stopped'
    this.#state = 'connecting'
    let conn: ReceiptsPort
    try {
      conn = await this.#o.connect()
    } catch (error) {
      if (!current()) return false
      this.#state = error instanceof ReceiptsClientError && error.code === 'unavailable' ? 'unavailable' : 'offline'
      this.#refuseWaiters()
      this.#schedule()
      return false
    }
    // This attempt owns the connection until it is published as `#conn`: every other way out closes it, once.
    let owned: ReceiptsPort | null = conn
    try {
      if (!current()) return false
      let outcome: 'open' | 'unavailable' | 'stopped'
      try {
        outcome = await this.#negotiate(conn)
      } catch {
        // The negotiation's own outbox commit failed (storage): nothing is published, the debt stays durable
        // where it was, and the attempt is retried after the usual wait.
        if (current()) { this.#state = 'offline'; this.#refuseWaiters(); this.#schedule() }
        return false
      }
      if (outcome !== 'open' || !current()) {
        if (outcome === 'unavailable' && current()) { this.#state = 'unavailable'; this.#refuseWaiters(); this.#schedule() }
        return false
      }
      this.#conn = conn
      owned = null
      this.#state = 'open'
      // The wait is reset by an applied result only: a helper that accepts connections and then loses every
      // reply must not be asked again in a tight loop.
      void conn.closed.then(() => {
        if (this.#conn !== conn) return
        this.#conn = null
        if (this.#state === 'open') this.#state = 'offline'
        if (!this.#closed) this.wake()
      })
      return true
    } finally {
      if (owned) { try { owned.close() } catch { /* closed */ } }
    }
  }

  #refuseWaiters(): void {
    for (const waiter of [...this.#starts.values()]) if (waiter.state === 'waiting') { waiter.state = 'refused'; waiter.resolve(false) }
  }

  /** openStream: resume the retained stream, take a stream the helper proves new, or stop. */
  async #negotiate(conn: ReceiptsPort, rejoined = false): Promise<'open' | 'unavailable' | 'stopped'> {
    const o = this.#o.store.value
    let reply: ReceiptReply<OpenStreamResult>
    try {
      reply = await conn.openStream({ vault: this.vault, knownRecordId: o.recordId, knownStreamId: o.streamId, nextSeq: o.nextSeq, ackedThrough: o.ackedThrough }, { timeoutMs: this.#o.requestTimeoutMs })
    } catch {
      return 'unavailable'
    }
    if (!reply.ok) {
      const stream = reply.error.stream
      if (reply.error.code === 'stream-required' && stream && !rejoined) {
        // A retained stream with other identities: rejoined only when this outbox owes nothing at all.
        const owesNothing = o.sent.length === 0 && o.held.length === 0 && o.docs.length === 0 && o.overflowSince === null
        if (!owesNothing || stream.appliedThrough !== stream.ackedThrough) { await this.#stop('a retained stream does not match this outbox'); return 'stopped' }
        await this.#o.store.commit((d) => {
          d.recordId = stream.recordId; d.streamId = stream.streamId
          d.nextSeq = stream.appliedThrough + 1; d.ackedThrough = stream.appliedThrough
        })
        return this.#negotiate(conn, true)
      }
      return 'unavailable'
    }
    const r = reply.result
    if (r.recordId === o.recordId && r.streamId === o.streamId && !r.rebased) {
      // Retained: the helper may have applied sent bodies (their cached results come back on resend), never more.
      if (r.appliedThrough < o.ackedThrough || r.appliedThrough > o.nextSeq - 1 || r.ackedThrough > o.ackedThrough || (o.objectFormat !== null && o.objectFormat !== r.objectFormat)) {
        await this.#stop('the retained stream counters do not match this outbox')
        return 'stopped'
      }
      if (o.objectFormat === null) await this.#o.store.commit((d) => { d.objectFormat = r.objectFormat })
      return 'open'
    }
    if (r.rebased && r.streamId !== o.streamId && r.base === o.nextSeq - 1 && r.appliedThrough === r.base && r.ackedThrough === r.base) {
      await this.#rebase(r)
      return 'open'
    }
    await this.#stop('the helper answered openStream with a stream this outbox cannot reconcile')
    return 'stopped'
  }

  /**
   * §13.4: a stream the helper proves new. Debt is kept and re-reported; nothing unacknowledged carries over.
   * A flush the old stream applied is void there too, but its blob was not yet proven captured: that debt is
   * folded back before the proof goes. Bytes still verified on disk get a fresh edit and flush with their
   * original age (or ride on a newer verified save of the same document); otherwise the debt stays unreported.
   */
  async #rebase(r: OpenStreamResult): Promise<void> {
    const before = this.#o.store.value
    const verified = new Set<string>()
    // The exact flushed save each verification read, kept across the awaits: the commit rebuilds a flush only
    // from this tuple, and only while the document still holds exactly it (a save published meanwhile does not).
    const flushedOnDisk = new Map<string, FlushedTuple>()
    const format = before.objectFormat
    for (const d of before.docs) {
      for (const i of d.intents) {
        if ((i.phase === 'durable-bytes' || i.phase === 'flush-sent') && i.blob && this.#o.verifyDurable) {
          try { if (await this.#o.verifyDurable(d.path, i.blob)) verified.add(i.intent) } catch { /* not verified: local debt */ }
        }
      }
      const f = d.flushed
      if (f && d.saved && format && d.saved.gen === f.gen && d.saved.blob[format] === f.blobOid && this.#o.verifyDurable) {
        const tuple = flushedTuple(d)
        try { if (await this.#o.verifyDurable(tuple.path, tuple.blob)) flushedOnDisk.set(docKey(d.doc, d.path), tuple) } catch { /* not verified: local debt */ }
      }
    }
    await this.#o.store.commit((o) => {
      const first = o.streamId === null
      o.recordId = r.recordId
      o.streamId = r.streamId
      o.objectFormat = r.objectFormat
      o.sent = []
      o.ackedThrough = o.nextSeq - 1
      if (first) return
      for (const d of o.docs) {
        const debt = (gen: number, at: number) => foldUnreported(d, gen, at)
        for (const ref of d.editRefs) debt(ref.throughGen, ref.at)
        d.editRefs = []
        const f = d.flushed
        if (f) {
          const riders = d.intents.filter((i) => verified.has(i.intent) && i.gen >= f.gen)
          if (riders.length > 0) for (const i of riders) i.at = Math.min(i.at, f.at)
          else {
            const tuple = flushedOnDisk.get(docKey(d.doc, d.path))
            if (tuple && sameFlushedTuple(tuple, d) && d.intents.length < MAX_INTENTS_PER_DOC) {
              const again = randomHex32()
              verified.add(again)
              d.intents.push({ intent: again, gen: tuple.gen, at: tuple.at, editRef: null, refSeq: null, start: null, writeRef: null, blob: { ...tuple.blob }, phase: 'durable-bytes', retries: 0, epoch: this.#o.clientEpoch })
            } else debt(f.gen, f.at)
          }
        }
        d.flushed = null
        d.intents = d.intents.filter((i) => {
          if (i.phase === 'writing') { d.uncertain ??= 'a write was in progress when the stream was replaced'; i.writeRef = null; return true }
          if (i.phase === 'closed-abandoned' || i.phase === 'abandon-sent') return false
          i.editRef = null; i.refSeq = null; i.writeRef = null; i.start = null
          if (verified.has(i.intent)) { i.phase = 'durable-bytes'; return true }
          debt(i.gen, i.at)
          return i.phase === 'pending-ref'
        })
      }
    })
  }

  /** The next request, from durable state, assigned its seq and stored with its body in one commit. */
  async #assignNext(): Promise<{ seq: number; body: ReceiptBody } | null> {
    const writer = this.#o.writer
    const vault = this.vault
    return this.#o.store.commit((o) => {
      if (o.sent.length > 0 || o.stopped || !o.objectFormat) return null
      const seq = o.nextSeq
      const assign = (body: ReceiptBody): { seq: number; body: ReceiptBody } => {
        o.sent.push({ seq, body, result: null })
        o.nextSeq = seq + 1
        return { seq, body }
      }
      const format = o.objectFormat
      // Save-bound work first, in document order.
      for (const d of o.docs) {
        if (d.uncertain) continue
        for (const i of d.intents) {
          if (i.phase === 'durable-bytes' && i.blob && i.editRef !== null) {
            i.phase = 'flush-sent'
            return assign({ method: 'noteFlush', vault, seq, path: d.path, doc: { ...d.doc }, gen: i.gen, intent: i.intent, editRef: i.editRef, writeRef: i.writeRef, blobOid: i.blob[format] })
          }
          if (i.phase === 'closed-abandoned' && i.writeRef !== null) {
            i.phase = 'abandon-sent'
            return assign({ method: 'noteWriteAbandon', vault, seq, path: d.path, doc: { ...d.doc }, gen: i.gen, intent: i.intent, writeRef: i.writeRef })
          }
          if (i.phase === 'pending-ref' && i.start === 'wanted' && writer && i.epoch === this.#o.clientEpoch) {
            i.start = 'sent'
            return assign({ method: 'noteWriteStart', vault, seq, path: d.path, doc: { ...d.doc }, gen: i.gen, intent: i.intent, writer: { ...writer }, at: i.at })
          }
          if ((i.phase === 'pending-ref' || i.phase === 'durable-bytes') && i.editRef === null && i.refSeq === null) {
            i.refSeq = seq
            const at = d.unreported ? Math.min(d.unreported.at, i.at) : i.at
            if (d.unreported && d.unreported.throughGen <= i.gen) d.unreported = null
            return assign({ method: 'noteEdit', vault, seq, path: d.path, doc: { ...d.doc }, throughGen: i.gen, at })
          }
        }
      }
      for (const d of o.docs) {
        if (d.uncertain || !d.unreported || d.editRefs.length > 0 || d.intents.length > 0) continue
        const { throughGen, at } = d.unreported
        d.unreported = null
        return assign({ method: 'noteEdit', vault, seq, path: d.path, doc: { ...d.doc }, throughGen, at })
      }
      return null
    })
  }

  async #send(seq: number, body: ReceiptBody): Promise<'applied' | 'next' | 'later' | 'stop'> {
    const conn = this.#conn
    if (!conn) return 'later'
    const request = { ...body, ackedThrough: this.#o.store.value.ackedThrough } as SeqBody
    let reply: ReceiptReply<ReceiptResult>
    try {
      reply = await conn.send(request, { timeoutMs: this.#o.requestTimeoutMs })
    } catch (error) {
      // Not sent, or sent without an intact reply: the identical body goes again with the same seq.
      // One immediate reconnect; after that the usual wait.
      void error
      this.#dropConnection()
      if (this.#attempt === 0) { this.#attempt = 1; return 'next' }
      return 'later'
    }
    if (reply.ok) {
      await this.#applyResult(seq, body, reply.result)
      return 'applied'
    }
    const code = reply.error.code
    if (STOP.has(code)) { await this.#stop(`the helper answered ${code}`); return 'stop' }
    if (WITHDRAW.has(code)) {
      // The helper stored nothing for this seq: the body is withdrawn and the seq is free again.
      await this.#o.store.commit((o) => {
        if (o.sent[0]?.seq !== seq) return
        o.sent.shift()
        o.nextSeq = seq
        const d = 'doc' in body ? findDoc(o, body.doc, body.path) : undefined
        if (d) d.uncertain = `the helper refused a receipt (${code})`
      })
      return 'next'
    }
    if (RETRYABLE.has(code)) return 'later'
    if (code === 'superseded') { this.#state = 'unavailable'; this.#closed = true; this.#dropConnection(); this.#refuseWaiters(); return 'stop' }
    // Session errors (stream-required, activation-refused, unsupported-ledger, ...): reconnect and negotiate again.
    this.#dropConnection()
    this.#state = 'unavailable'
    this.#refuseWaiters()
    return 'later'
  }

  /** Stores the result, applies it to the document row and advances the acknowledgement, in one commit. */
  async #applyResult(seq: number, body: ReceiptBody, result: ReceiptResult): Promise<void> {
    const waiter = body.method === 'noteWriteStart' ? this.#starts.get(body.intent) : undefined
    let granted = false
    try {
      await this.#o.store.commit((o) => {
        if (o.sent[0]?.seq !== seq) throw new Error('the result does not answer the first unacknowledged seq')
        o.sent.shift()
        o.ackedThrough = seq
        if (body.method === 'adopt') return
        const d = findDoc(o, body.doc, body.path)
        if (!d) return
        if ('refused' in result) return this.#refused(o, d, body, result.refused, waiter)
        switch (result.ok) {
          case 'edit': {
            d.editRefs = d.editRefs.filter((r) => !result.retiredRefs.includes(r.seq))
            if (body.method === 'noteEdit') d.editRefs.push({ seq, throughGen: body.throughGen, at: body.at })
            while (d.editRefs.length > MAX_LOCAL_EDIT_REFS) d.editRefs.shift()
            for (const i of d.intents) {
              // The sent body is answered as it was, but it binds only if it carries the intent's oldest age: an
              // age lowered while it was on the wire (a held or coalesced save it now covers) needs a new edit.
              if (i.refSeq === seq) { i.refSeq = null; i.editRef = body.method === 'noteEdit' && body.at <= i.at ? seq : null }
              else if (i.editRef !== null && result.retiredRefs.includes(i.editRef)) i.editRef = null
            }
            break
          }
          case 'write-started': {
            if (body.method !== 'noteWriteStart') break
            const row = d.intents.find((i) => i.intent === body.intent)
            if (waiter && waiter.state === 'waiting' && row && row.phase === 'pending-ref' && result.recordId === o.recordId) {
              waiter.state = 'granted'
              granted = true
              row.phase = 'writing'
              row.writeRef = seq
              row.start = null
            } else if (row) {
              // Granted after the save gave up: the destination was never opened.
              row.writeRef = seq
              row.start = null
              if (row.phase !== 'writing') row.phase = 'closed-abandoned'
            } else {
              d.intents.push({ intent: body.intent, gen: body.gen, at: body.at, editRef: null, refSeq: null, start: null, writeRef: seq, blob: null, phase: 'closed-abandoned', retries: 0, epoch: this.#o.clientEpoch })
            }
            break
          }
          case 'flushed': {
            if (body.method !== 'noteFlush') break
            // Blob-bound debt keeps the oldest age it covers (§8.3) until the helper captures it: this save's,
            // that of the edit references it consumes, and that of a flush it coalesces with.
            const row = d.intents.find((i) => i.intent === body.intent)
            const covered = [row?.at, ...d.editRefs.filter((r) => r.throughGen <= body.gen).map((r) => r.at)].filter((t): t is number => typeof t === 'number')
            if (covered.length === 0) d.uncertain ??= 'a flushed save lost its age'
            const from = covered.length > 0 ? Math.min(...covered) : (d.saved?.at ?? this.#o.now())
            d.intents = d.intents.filter((i) => i.intent !== body.intent)
            if (d.flushed && d.flushed.gen > body.gen) d.flushed.at = Math.min(d.flushed.at, from)
            else d.flushed = { gen: body.gen, blobOid: body.blobOid, seq, at: Math.min(from, d.flushed?.at ?? from) }
            d.editRefs = d.editRefs.filter((r) => r.throughGen > body.gen)
            if (d.unreported && d.unreported.throughGen <= body.gen) d.unreported = null
            break
          }
          case 'write-abandoned': {
            if (body.method === 'noteWriteAbandon') d.intents = d.intents.filter((i) => i.intent !== body.intent)
            break
          }
          default: break
        }
      })
    } catch (error) {
      if (waiter && waiter.state === 'granted') { waiter.state = 'refused'; waiter.resolve(false) }
      throw error
    }
    // Resolving an expired waiter again changes nothing: its save already took the hold route.
    if (waiter) waiter.resolve(granted)
  }

  #refused(o: Outbox, d: DocEntry, body: ReceiptBody, code: string, waiter: StartWaiter | undefined): void {
    void o
    if (body.method === 'noteWriteStart') {
      if (waiter && waiter.state === 'waiting') waiter.state = 'refused'
      const row = d.intents.find((i) => i.intent === body.intent)
      if (row) {
        row.start = null
        if (row.phase === 'closed-abandoned' && row.writeRef === null) d.intents = d.intents.filter((i) => i !== row)
      }
      return
    }
    if (body.method === 'noteFlush' && (code === 'gen-mismatch' || code === 'ref-invalid')) {
      const row = d.intents.find((i) => i.intent === body.intent)
      if (row) {
        // The bytes are unchanged: a new exact-gen reference, then the flush again (§13.2), a bounded number of times.
        row.editRef = null
        row.refSeq = null
        row.phase = 'durable-bytes'
        row.retries += 1
        if (row.retries > 3) d.uncertain = `the helper kept refusing this document's flush (${code})`
      }
      d.editRefs = d.editRefs.filter((r) => r.seq !== body.editRef)
      return
    }
    if (body.method === 'noteEdit') {
      for (const i of d.intents) if (i.refSeq === body.seq) i.refSeq = null
    }
    d.uncertain = `the helper refused a receipt (${code})`
  }
}
