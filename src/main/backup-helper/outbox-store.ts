/**
 * The durable receipt outbox of one vault (locked plan §13.1): `userData/backup-receipts/<vault>.json`,
 * plus held document bytes under `userData/backup-receipts/held/<vault>/<intent>.bin` (§10.4).
 *
 * Every change is one `commit`: the mutation runs on a copy, the copy is checked by the same strict parser
 * that loads the file, and only after the replacement is durable (temporary file synced, renamed, folder
 * synced) does the copy become the store's value. A failed commit leaves the previous value in place, so
 * nothing main acts on is ever ahead of the disk. Commits run one at a time, in call order.
 *
 * What it holds, and why each part is never dropped silently:
 * - `nextSeq`/`ackedThrough` and `sent`: the one seq source of this receipt stream. A seq is assigned with
 *   its exact body in one commit before the body goes on the wire; its result is stored before the
 *   acknowledgement moves past it. A sent entry without a result is resent identically, before any later
 *   seq.
 * - `docs`: per document identity (owner, ownerEpoch, docEpoch, path) the debt main still owes the helper
 *   (`unreported`), the live edit references from durable results, the save intents with their phase and
 *   the last bytes main itself made durable for that document. Debt is kept until a durable result
 *   consumes it; a row that cannot be stored sets `overflowSince`, which nothing in A1 clears.
 * - `held`: complete bytes main could not publish safely (§10.4), kept until an exact durable publication.
 *   At most MAX_HELD; a hold beyond that names nothing new and sets `overflowSince` instead.
 * - `stopped`: the stream needs an explicit recovery (an uncertain reconciliation); nothing is sent.
 *
 * A file that does not parse is never replaced: the store refuses to open (OutboxDamaged) and the caller
 * reports coverage unknown. Nothing here talks to the helper.
 */
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocRef, ReceiptResult } from '@app-patterns/vault-sync'
import type { SeqBody } from '@app-patterns/vault-sync/helper'
import { ensurePrivateDir, syncDirectory, writeFileDurable, type BlobOids, type ObjectFormat } from './durable-file'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** A sequenced request as stored: everything the helper hashes. `ackedThrough` is added when it is sent. */
export type ReceiptBody = DistributiveOmit<SeqBody, 'ackedThrough'>
export type SentEntry = { seq: number; body: ReceiptBody; result: ReceiptResult | null }

export type IntentPhase =
  /** The save is under way; nothing durable yet. */
  | 'pending-ref'
  /** An authorised non-atomic copy is under way: a destination descriptor may be open. */
  | 'writing'
  /** The bytes were synced and read back; the flush is owed. */
  | 'durable-bytes'
  /** Every destination descriptor of this intent is closed (or was never opened); the abandon is owed. */
  | 'closed-abandoned'
  | 'flush-sent' | 'abandon-sent'
  /** The bytes went to the held store instead of the vault; nothing was published. */
  | 'held'

export type IntentRow = {
  intent: string
  gen: number
  /** When the save started (or the oldest unreported edit it carries), never refreshed. */
  at: number
  editRef: number | null
  /** The seq of the noteEdit sent for this intent's ref, while its result is outstanding. */
  refSeq: number | null
  start: 'wanted' | 'sent' | null
  writeRef: number | null
  blob: BlobOids | null
  phase: IntentPhase
  retries: number
  /** The client epoch of the process that made the intent. */
  epoch: number
}

export type DocEntry = {
  doc: DocRef
  path: string
  /** Edits not yet carried by any sent noteEdit: the highest gen and the oldest time. */
  unreported: { throughGen: number; at: number } | null
  editRefs: { seq: number; throughGen: number; at: number }[]
  intents: IntentRow[]
  /** The last bytes main made durable for this document (its own recorded blob, §12). */
  saved: { gen: number; blob: BlobOids; at: number } | null
  /**
   * The last flush the helper applied for this document, with the oldest edit age it covers (never the time
   * it was published): blob-bound debt until a capture proves it. An outbox written before `at` existed does
   * not parse (OutboxDamaged; the file is left as it is): its debt age is unknown, never silently reset.
   */
  flushed: { gen: number; blobOid: string; seq: number; at: number } | null
  /** Why this document's receipts can no longer be reconciled (a refusal main cannot repair). */
  uncertain: string | null
}

export type HeldEntry = { intent: string; path: string; doc: DocRef; gen: number; blob: BlobOids; at: number; file: string }

export type Outbox = {
  v: 2
  clientId: string
  vault: string
  recordId: string | null
  streamId: string | null
  objectFormat: ObjectFormat | null
  nextSeq: number
  ackedThrough: number
  sent: SentEntry[]
  docs: DocEntry[]
  held: HeldEntry[]
  overflowSince: number | null
  stopped: { reason: string; at: number } | null
}

export const MAX_OUTBOX_DOCS = 10_000
export const MAX_INTENTS_PER_DOC = 16
export const MAX_LOCAL_EDIT_REFS = 8
export const MAX_SENT = 16
export const MAX_HELD = 1_000

export class OutboxDamaged extends Error {
  override readonly name = 'OutboxDamaged'
}

const HEX32 = /^[0-9a-f]{32}$/
const OID = (format: ObjectFormat) => (format === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/)
const VAULT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

type Obj = Record<string, unknown>
const bad = (what: string): never => { throw new OutboxDamaged(`receipt outbox: ${what}`) }
function obj(x: unknown, keys: readonly string[], what: string): Obj {
  if (!x || typeof x !== 'object' || Array.isArray(x)) bad(`${what} is not an object`)
  const v = x as Obj
  const have = Object.keys(v).sort().join(',')
  if (have !== [...keys].sort().join(',')) bad(`${what} has other fields`)
  return v
}
const int = (x: unknown, min: number, what: string): number => (Number.isSafeInteger(x) && (x as number) >= min ? (x as number) : bad(`${what} is not a whole number ≥ ${min}`))
const intOrNull = (x: unknown, min: number, what: string): number | null => (x === null ? null : int(x, min, what))
const hex32 = (x: unknown, what: string): string => (typeof x === 'string' && HEX32.test(x) ? x : bad(`${what} is not 32 hex`))
const oneOf = <T extends string>(x: unknown, allowed: readonly T[], what: string): T => ((allowed as readonly unknown[]).includes(x) ? (x as T) : bad(`${what} is unknown`))
const text = (x: unknown, max: number, what: string): string => (typeof x === 'string' && x.length > 0 && x.length <= max ? x : bad(`${what} is not text`))
function receiptPath(x: unknown, what: string): string {
  if (typeof x !== 'string' || x === '' || x.includes('\0') || x.startsWith('/') || x.split('/').some((p) => p === '' || p === '.' || p === '..') || Buffer.byteLength(x) > 1024) bad(`${what} is not a vault-relative path`)
  return x as string
}
const docRef = (x: unknown, what: string): DocRef => {
  const v = obj(x, ['owner', 'ownerEpoch', 'docEpoch'], what)
  return { owner: hex32(v.owner, `${what}.owner`), ownerEpoch: int(v.ownerEpoch, 1, `${what}.ownerEpoch`), docEpoch: int(v.docEpoch, 0, `${what}.docEpoch`) }
}
const blobs = (x: unknown, what: string): BlobOids => {
  const v = obj(x, ['sha1', 'sha256'], what)
  if (typeof v.sha1 !== 'string' || !OID('sha1').test(v.sha1) || typeof v.sha256 !== 'string' || !OID('sha256').test(v.sha256)) bad(`${what} is not a pair of blob ids`)
  return { sha1: v.sha1 as string, sha256: v.sha256 as string }
}
const anyOid = (x: unknown, what: string): string => (typeof x === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x) ? x : bad(`${what} is not a blob id`))

const SEQD = ['method', 'vault', 'seq']
const BODY_KEYS: Record<ReceiptBody['method'], readonly string[]> = {
  noteEdit: [...SEQD, 'path', 'doc', 'throughGen', 'at'],
  noteWriteStart: [...SEQD, 'path', 'doc', 'gen', 'intent', 'writer', 'at'],
  noteFlush: [...SEQD, 'path', 'doc', 'gen', 'intent', 'editRef', 'writeRef', 'blobOid'],
  noteWriteAbandon: [...SEQD, 'path', 'doc', 'gen', 'intent', 'writeRef'],
  adopt: [...SEQD, 'path', 'from', 'to'],
}

function body(x: unknown, seq: number, vault: string, what: string): ReceiptBody {
  const method = oneOf((x as Obj | null)?.method, Object.keys(BODY_KEYS) as ReceiptBody['method'][], `${what}.method`)
  const v = obj(x, BODY_KEYS[method], what)
  if (v.seq !== seq || v.vault !== vault) bad(`${what} names another seq or vault`)
  receiptPath(v.path, `${what}.path`)
  switch (method) {
    case 'noteEdit': docRef(v.doc, `${what}.doc`); int(v.throughGen, 0, `${what}.throughGen`); int(v.at, 0, `${what}.at`); break
    case 'noteWriteStart': {
      docRef(v.doc, `${what}.doc`); int(v.gen, 0, `${what}.gen`); hex32(v.intent, `${what}.intent`); int(v.at, 0, `${what}.at`)
      const w = obj(v.writer, ['host', 'pid', 'startedAt', 'clientEpoch'], `${what}.writer`)
      text(w.host, 255, `${what}.writer.host`); int(w.pid, 1, `${what}.writer.pid`); int(w.startedAt, 0, `${what}.writer.startedAt`); int(w.clientEpoch, 1, `${what}.writer.clientEpoch`)
      break
    }
    case 'noteFlush': docRef(v.doc, `${what}.doc`); int(v.gen, 0, `${what}.gen`); hex32(v.intent, `${what}.intent`); int(v.editRef, 1, `${what}.editRef`); intOrNull(v.writeRef, 1, `${what}.writeRef`); anyOid(v.blobOid, `${what}.blobOid`); break
    case 'noteWriteAbandon': docRef(v.doc, `${what}.doc`); int(v.gen, 0, `${what}.gen`); hex32(v.intent, `${what}.intent`); int(v.writeRef, 1, `${what}.writeRef`); break
    case 'adopt': docRef(v.from, `${what}.from`); docRef(v.to, `${what}.to`); break
  }
  return structuredClone(v) as ReceiptBody
}

/** A stored result: the reply the client already checked against its request; here only its envelope. */
function result(x: unknown, seq: number, what: string): ReceiptResult {
  if (!x || typeof x !== 'object' || Array.isArray(x)) bad(`${what} is not an object`)
  const v = x as Obj
  if (v.seq !== seq || v.durable !== true || typeof v.recordId !== 'string' || !HEX32.test(v.recordId) || !Number.isSafeInteger(v.epoch)) bad(`${what} is not a durable result for its seq`)
  if (!('ok' in v) && !('refused' in v)) bad(`${what} is neither applied nor refused`)
  return structuredClone(v) as ReceiptResult
}

const PHASES: readonly IntentPhase[] = ['pending-ref', 'writing', 'durable-bytes', 'closed-abandoned', 'flush-sent', 'abandon-sent', 'held']

function intentRow(x: unknown, what: string): IntentRow {
  const v = obj(x, ['intent', 'gen', 'at', 'editRef', 'refSeq', 'start', 'writeRef', 'blob', 'phase', 'retries', 'epoch'], what)
  return {
    intent: hex32(v.intent, `${what}.intent`), gen: int(v.gen, 0, `${what}.gen`), at: int(v.at, 0, `${what}.at`),
    editRef: intOrNull(v.editRef, 1, `${what}.editRef`), refSeq: intOrNull(v.refSeq, 1, `${what}.refSeq`),
    start: v.start === null ? null : oneOf(v.start, ['wanted', 'sent'] as const, `${what}.start`),
    writeRef: intOrNull(v.writeRef, 1, `${what}.writeRef`), blob: v.blob === null ? null : blobs(v.blob, `${what}.blob`),
    phase: oneOf(v.phase, PHASES, `${what}.phase`), retries: int(v.retries, 0, `${what}.retries`), epoch: int(v.epoch, 1, `${what}.epoch`),
  }
}

function docEntry(x: unknown, what: string): DocEntry {
  const v = obj(x, ['doc', 'path', 'unreported', 'editRefs', 'intents', 'saved', 'flushed', 'uncertain'], what)
  const list = (y: unknown, max: number, w: string): unknown[] => (Array.isArray(y) && y.length <= max ? y : bad(`${w} is not a bounded list`))
  return {
    doc: docRef(v.doc, `${what}.doc`),
    path: receiptPath(v.path, `${what}.path`),
    unreported: v.unreported === null ? null : (() => { const u = obj(v.unreported, ['throughGen', 'at'], `${what}.unreported`); return { throughGen: int(u.throughGen, 0, `${what}.unreported.throughGen`), at: int(u.at, 0, `${what}.unreported.at`) } })(),
    editRefs: list(v.editRefs, MAX_LOCAL_EDIT_REFS, `${what}.editRefs`).map((r, i) => { const e = obj(r, ['seq', 'throughGen', 'at'], `${what}.editRefs[${i}]`); return { seq: int(e.seq, 1, 'seq'), throughGen: int(e.throughGen, 0, 'throughGen'), at: int(e.at, 0, 'at') } }),
    intents: list(v.intents, MAX_INTENTS_PER_DOC, `${what}.intents`).map((r, i) => intentRow(r, `${what}.intents[${i}]`)),
    saved: v.saved === null ? null : (() => { const s = obj(v.saved, ['gen', 'blob', 'at'], `${what}.saved`); return { gen: int(s.gen, 0, 'gen'), blob: blobs(s.blob, `${what}.saved.blob`), at: int(s.at, 0, 'at') } })(),
    flushed: v.flushed === null ? null : (() => { const f = obj(v.flushed, ['gen', 'blobOid', 'seq', 'at'], `${what}.flushed`); return { gen: int(f.gen, 0, 'gen'), blobOid: anyOid(f.blobOid, 'blobOid'), seq: int(f.seq, 1, 'seq'), at: int(f.at, 0, 'at') } })(),
    uncertain: v.uncertain === null ? null : text(v.uncertain, 200, `${what}.uncertain`),
  }
}

/** The strict reader: every field known, typed and bounded, the counters consistent. */
export function parseOutbox(x: unknown, expected: { clientId: string; vault: string }): Outbox {
  const v = obj(x, ['v', 'clientId', 'vault', 'recordId', 'streamId', 'objectFormat', 'nextSeq', 'ackedThrough', 'sent', 'docs', 'held', 'overflowSince', 'stopped'], 'outbox')
  if (v.v !== 2) bad('version is not 2')
  if (v.clientId !== expected.clientId || v.vault !== expected.vault) bad('the file belongs to another client or vault')
  const nextSeq = int(v.nextSeq, 1, 'nextSeq')
  const ackedThrough = int(v.ackedThrough, 0, 'ackedThrough')
  if (ackedThrough > nextSeq - 1) bad('acknowledged past the last assigned seq')
  if (!Array.isArray(v.sent) || v.sent.length > MAX_SENT) bad('sent is not a bounded list')
  const sent = (v.sent as unknown[]).map((s, i): SentEntry => {
    const e = obj(s, ['seq', 'body', 'result'], `sent[${i}]`)
    const seq = int(e.seq, 1, `sent[${i}].seq`)
    if (seq !== ackedThrough + 1 + i) bad('sent seqs are not the contiguous seqs after the acknowledgement')
    return { seq, body: body(e.body, seq, expected.vault, `sent[${i}].body`), result: e.result === null ? null : result(e.result, seq, `sent[${i}].result`) }
  })
  if (sent.length > 0 && sent.at(-1)!.seq !== nextSeq - 1) bad('sent does not end at the last assigned seq')
  if (sent.length === 0 && ackedThrough !== nextSeq - 1) bad('assigned seqs are missing from sent')
  if (!Array.isArray(v.docs) || v.docs.length > MAX_OUTBOX_DOCS) bad('docs is not a bounded list')
  if (!Array.isArray(v.held) || v.held.length > MAX_HELD) bad('held is not a bounded list')
  return {
    v: 2, clientId: expected.clientId, vault: expected.vault,
    recordId: v.recordId === null ? null : hex32(v.recordId, 'recordId'),
    streamId: v.streamId === null ? null : hex32(v.streamId, 'streamId'),
    objectFormat: v.objectFormat === null ? null : oneOf(v.objectFormat, ['sha1', 'sha256'] as const, 'objectFormat'),
    nextSeq, ackedThrough, sent,
    docs: (v.docs as unknown[]).map((d, i) => docEntry(d, `docs[${i}]`)),
    held: (v.held as unknown[]).map((h, i) => {
      const e = obj(h, ['intent', 'path', 'doc', 'gen', 'blob', 'at', 'file'], `held[${i}]`)
      return { intent: hex32(e.intent, 'intent'), path: receiptPath(e.path, 'path'), doc: docRef(e.doc, 'doc'), gen: int(e.gen, 0, 'gen'), blob: blobs(e.blob, 'blob'), at: int(e.at, 0, 'at'), file: text(e.file, 100, 'file') }
    }),
    overflowSince: intOrNull(v.overflowSince, 0, 'overflowSince'),
    stopped: v.stopped === null ? null : (() => { const s = obj(v.stopped, ['reason', 'at'], 'stopped'); return { reason: text(s.reason, 200, 'stopped.reason'), at: int(s.at, 0, 'stopped.at') } })(),
  }
}

export function emptyOutbox(clientId: string, vault: string): Outbox {
  return { v: 2, clientId, vault, recordId: null, streamId: null, objectFormat: null, nextSeq: 1, ackedThrough: 0, sent: [], docs: [], held: [], overflowSince: null, stopped: null }
}

export const sameDocRef = (a: DocRef, b: DocRef): boolean => a.owner === b.owner && a.ownerEpoch === b.ownerEpoch && a.docEpoch === b.docEpoch

export class OutboxStore {
  #value: Outbox
  #chain: Promise<unknown> = Promise.resolve()

  private constructor(readonly file: string, readonly heldDir: string, value: Outbox) {
    this.#value = value
  }

  /** Opens the vault's outbox (a fresh one when there is none). A file that does not parse throws OutboxDamaged and is left as it is. */
  static async open(dir: string, vault: string, clientId: string): Promise<OutboxStore> {
    if (!VAULT.test(vault)) throw new OutboxDamaged('receipt outbox: the vault id is not a registered-vault id')
    await ensurePrivateDir(dir)
    const file = join(dir, `${vault}.json`)
    const heldDir = join(dir, 'held', vault)
    let value: Outbox
    try {
      const raw = await readFile(file, 'utf8')
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { throw new OutboxDamaged('receipt outbox: the file is not JSON') }
      value = parseOutbox(parsed, { clientId, vault })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error instanceof OutboxDamaged ? error : new OutboxDamaged(`receipt outbox: ${(error as Error).message}`)
      value = emptyOutbox(clientId, vault)
    }
    return new OutboxStore(file, heldDir, value)
  }

  /** A copy of the durable value: what the disk holds now. */
  get value(): Outbox {
    return structuredClone(this.#value)
  }

  /** Runs `mutate` on a copy, checks it and makes it durable; then it becomes the value. */
  commit<T>(mutate: (draft: Outbox) => T): Promise<T> {
    const run = this.#chain.then(async () => {
      const draft = structuredClone(this.#value)
      const out = mutate(draft)
      const checked = parseOutbox(JSON.parse(JSON.stringify(draft)), { clientId: draft.clientId, vault: draft.vault })
      await writeFileDurable(this.file, `${JSON.stringify(checked)}\n`)
      this.#value = checked
      return out
    })
    this.#chain = run.catch(() => undefined)
    return run
  }

  heldFile(intent: string): string {
    return join(this.heldDir, `${hex32(intent, 'intent')}.bin`)
  }

  /** Writes held bytes durably (before the outbox names them). */
  async writeHeld(intent: string, bytes: Uint8Array): Promise<string> {
    await ensurePrivateDir(this.heldDir)
    const file = this.heldFile(intent)
    await writeFileDurable(file, bytes)
    return file
  }

  /** Removes held bytes the outbox no longer names. Only after that commit is durable. */
  async removeHeld(intent: string): Promise<void> {
    await unlink(this.heldFile(intent)).catch(() => {})
    await syncDirectory(this.heldDir).catch(() => {})
  }
}
