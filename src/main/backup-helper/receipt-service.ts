/**
 * Editor receipts as main runs them (locked plan §3, §10, §12, §13): the receipts lane beside the
 * unchanged protocol-1 control connection (service.ts, connection.ts). Off unless the trusted trial
 * configuration is enabled; with the disabled trial nothing here reads userData, opens a socket or
 * changes a save.
 *
 * - Identity: at start, the durable client id and the next client epoch (made durable before any
 *   connection), and this process's writer incarnation from the process table; no writer identity means
 *   no non-atomic write is ever authorised.
 * - Owners: main mints a random owner for each window binding (window, folder, vault) and stamps it on
 *   every receipt and save; the renderer never names one. A reload, a crashed renderer, a closed window or
 *   a folder bound again retires the binding; the next call gets a new owner. A late reply for a retired owner
 *   changes only the outbox, which is by document identity, never a live answer.
 * - Lifetimes: each request takes its window's lifetime synchronously on entry and checks it again after
 *   every await. The renderer holds the lifetime's opaque token (the `lifetime` request, for the folder it
 *   shows) and sends it with every call; a call without a token, or whose token is not the current lifetime's,
 *   is refused (a save gets no receipt) before anything is stored. A request whose lifetime was retired meanwhile never gets the next lifetime's owner, never
 *   answers live, and its save handle admits no non-atomic write; what it already stamped stays in the outbox
 *   under its own owner.
 * - Requests: strictly checked arguments; the path is a vault-relative path in the window's own folder,
 *   which must be a registered vault (the Git worktree root, trial-config.ts). Malformed input is refused,
 *   never thrown.
 * - Saves: `beginSave` records the save intent durably before the save writes; `saved` makes the bytes'
 *   durability proof (file and folder synced, read back, blob computed from what was read) and only then
 *   owes the flush. The copy fallback of an exclusive create is authorised only by an exact durable write
 *   start within 2 s; otherwise the complete bytes are held durably off the vault and the save refuses.
 * - Status: one receipt status read after the renderer's captured view arrives, then §12/§13.7
 *   (receipt-coverage.ts). `protectionClaim` stays false with all three limits until A2 maps the states.
 *
 * Nothing here starts, stops or inspects a helper process, and nothing writes outside userData except
 * through the Workspace's own save.
 */
import { realpathSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { DocRef } from '@app-patterns/vault-sync'
import { connectReceipts, type ConnectReceiptsOptions } from '@app-patterns/vault-sync/helper'
import {
  BACKUP_HELPER_LIMITS, BACKUP_RECEIPT_EARLIEST_AT, BACKUP_RECEIPT_MAX_DOCS,
  type BackupReceiptEditAnswer, type BackupReceiptLifetimeAnswer, type BackupReceiptStatusAnswer,
} from '../../shared/backup-helper'
import type { SaveReceiptHandle } from '../save-receipt-gate'
import { gitBlobOid, gitBlobOids, readDurableBytes } from './durable-file'
import { OutboxDamaged, OutboxStore } from './outbox-store'
import { computeCoverage, type CapturedDoc } from './receipt-coverage'
import { nextClientIdentity, randomHex32, writerIncarnation, type ClientIdentity } from './receipt-identity'
import { ReceiptStream, type ReceiptsPort } from './receipt-stream'
import { BACKUP_HELPER_TRIAL_DISABLED, type BackupHelperTrial } from './trial-config'

/** The save's 2 000 ms budget for an exact durable write start (§10.3). */
export const WRITE_START_BUDGET_MS = 2_000

export type ReceiptSender = { id: number; mainFrame: boolean }

/** A save's receipt in main: the Workspace's handle plus the completion main reports after the save. */
export type MainSaveReceipt = SaveReceiptHandle & {
  /** The save returned `written` for `absolute`: the durability barrier, then the flush is owed. */
  saved(absolute: string, written: string): Promise<void>
  /** The save threw: nothing of it is durable. */
  failed(): Promise<void>
}

export type BackupReceiptService = {
  /** This window's lifetime token, only while its folder is `root` (the folder the renderer shows). */
  lifetime(sender: ReceiptSender, args: readonly unknown[]): Promise<BackupReceiptLifetimeAnswer>
  reportEdit(sender: ReceiptSender, args: readonly unknown[]): Promise<BackupReceiptEditAnswer>
  status(sender: ReceiptSender, args: readonly unknown[]): Promise<BackupReceiptStatusAnswer>
  /** Null when no receipt applies: trial off, no metadata, a folder not enrolled, receipts unusable. */
  beginSave(senderId: number, root: string, path: string, meta: unknown): Promise<MainSaveReceipt | null>
  /** For an exclusive create without a receipt: `refuse` in an enrolled folder. */
  nonAtomicPolicy(root: string): 'copy' | 'refuse'
  /** The window's page was replaced, crashed or closed: its owner is retired. */
  retireSender(senderId: number): void
  dispose(): void
  /** Settles once identity loading has finished (it may have failed). */
  readonly ready: Promise<void>
  /** @internal The stream of a vault, once opened. */
  streamFor(vault: string): Promise<ReceiptStream | null>
}

export type BackupReceiptServiceOptions = {
  trial?: BackupHelperTrial
  /** `userData/backup-receipts`. */
  receiptsDir: string
  /** The workspace root bound to this window now, or null. Main's own state; never renderer input. */
  windowRoot: (senderId: number) => string | null
  resolveReal?: (path: string) => Promise<string>
  resolveRealSync?: (path: string) => string
  connect?: (socketPath: string, options: ConnectReceiptsOptions) => Promise<ReceiptsPort>
  startTime?: (pid: number) => Promise<number | null>
  identity?: (dir: string) => Promise<ClientIdentity>
  host?: string
  pid?: number
  mintOwner?: () => string
  /** The opaque lifetime token (random, 32 hex); tests may fix it. */
  mintLifetime?: () => string
  now?: () => number
  requestTimeoutMs?: number
  retryMs?: (attempt: number) => number
  startBudgetMs?: number
}

const limits = () => ({ protectionClaim: false as const, limits: [...BACKUP_HELPER_LIMITS] })

type Obj = Record<string, unknown>
const plain = (x: unknown, keys: readonly string[]): Obj | null => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const have = Object.keys(x).sort().join(',')
  return have === [...keys].sort().join(',') ? (x as Obj) : null
}
const whole = (x: unknown, min: number): x is number => Number.isSafeInteger(x) && (x as number) >= min
/** A vault-relative path as the helper accepts it (receipt-ledger.ts receiptPath). */
export function receiptPathOk(x: unknown): x is string {
  if (typeof x !== 'string' || x === '' || x.includes('\0') || x.includes('\\') || x.startsWith('/')) return false
  if (x.split('/').some((p) => p === '' || p === '.' || p === '..')) return false
  return Buffer.byteLength(x, 'utf8') <= 1024
}
function docInput(x: unknown, minGen: number): { path: string; docEpoch: number; gen: number } | null {
  const v = plain(x, ['path', 'docEpoch', 'gen'])
  if (!v || !receiptPathOk(v.path) || !whole(v.docEpoch, 0) || !whole(v.gen, minGen)) return null
  return { path: v.path, docEpoch: v.docEpoch, gen: v.gen }
}
const EARLIEST_AT = BACKUP_RECEIPT_EARLIEST_AT
const TOKEN = /^[0-9a-f]{32}$/
/**
 * The call metadata (shared BackupReceiptCallMeta): `lifetime` is required and must be a token's shape (a
 * call without one names no lifetime and is refused, so it can never take the lifetime main holds at its
 * entry); `at`, optional, a whole wall time from EARLIEST_AT. The time kept is the earlier of `at` and main's own time at the call's
 * entry: a renderer reading taken when the edit was made keeps a delayed call's original time (a later
 * arrival or a forward jump of the wall clock adds nothing), and no reading can name a time after the call
 * reached main. A malformed field refuses the whole call.
 */
function callMeta(v: Obj, entry: number): { lifetime: string; at: number } | null {
  if (typeof v.lifetime !== 'string' || !TOKEN.test(v.lifetime)) return null
  if (v.at !== undefined && !whole(v.at, EARLIEST_AT)) return null
  return { lifetime: v.lifetime, at: v.at === undefined ? entry : Math.min(v.at as number, entry) }
}
/** Exactly `keys`, plus the call metadata keys (callMeta requires `lifetime`). */
const withMeta = (x: unknown, keys: readonly string[]): Obj | null => {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const extra = Object.keys(x).filter((k) => !keys.includes(k))
  return extra.every((k) => k === 'lifetime' || k === 'at') && keys.every((k) => k in x) ? (x as Obj) : null
}
/** An edit report: the document, its lifetime token and optionally the time of its oldest unreported edit. */
function editInput(x: unknown, entry: number): { path: string; docEpoch: number; gen: number; at: number; lifetime: string } | null {
  const v = withMeta(x, ['path', 'docEpoch', 'gen'])
  const doc = v ? docInput({ path: v.path, docEpoch: v.docEpoch, gen: v.gen }, 1) : null
  const meta = v ? callMeta(v, entry) : null
  return doc && meta ? { ...doc, ...meta } : null
}
function saveInput(x: unknown, entry: number): { docEpoch: number; gen: number; at: number; lifetime: string } | null {
  const v = withMeta(x, ['docEpoch', 'gen'])
  const meta = v ? callMeta(v, entry) : null
  return v && meta && whole(v.docEpoch, 0) && whole(v.gen, 0) ? { docEpoch: v.docEpoch, gen: v.gen, ...meta } : null
}

type Binding = { owner: string; ownerEpoch: number; real: string; vault: string }
/**
 * One window's request authority: the folder it had when a request arrived and, once enrolled, its owner.
 * Taken synchronously at request entry, before any await. Retirement (reload, crashed renderer, closed
 * window, a folder bound again) marks it retired: a request that began under it can still store the facts it
 * already stamped with its owner, but it never gets an owner of a later lifetime and never answers live.
 */
type Lifetime = { root: string; retired: boolean; binding: Binding | null; token: string }
type Stale = 'window-closed' | 'window-root-changed' | 'owner-replaced'

export function createBackupReceiptService(options: BackupReceiptServiceOptions): BackupReceiptService {
  const trial = options.trial ?? BACKUP_HELPER_TRIAL_DISABLED
  if (!trial.enabled) {
    return {
      lifetime: async () => ({ state: 'disabled' }),
      reportEdit: async () => ({ state: 'disabled' }),
      status: async () => ({ state: 'disabled' }),
      beginSave: async () => null,
      nonAtomicPolicy: () => 'copy',
      retireSender: () => undefined,
      dispose: () => undefined,
      ready: Promise.resolve(),
      streamFor: async () => null,
    }
  }
  const now = options.now ?? Date.now
  const resolveReal = options.resolveReal ?? realpath
  const resolveRealSync = options.resolveRealSync ?? realpathSync
  const connect = options.connect ?? ((socketPath, opts) => connectReceipts(socketPath, opts))
  const mintOwner = options.mintOwner ?? randomHex32
  const mintLifetime = options.mintLifetime ?? randomHex32
  const budget = options.startBudgetMs ?? WRITE_START_BUDGET_MS
  const realOf = new Map<string, string>([...trial.vaults].map(([real, vault]) => [vault, real]))
  const lifetimes = new Map<number, Lifetime>()
  const streams = new Map<string, Promise<ReceiptStream | null>>()
  let identity: ClientIdentity | null = null
  let writer: Awaited<ReturnType<typeof writerIncarnation>> = null
  let disposed = false

  const ready = (async () => {
    identity = await (options.identity ?? nextClientIdentity)(options.receiptsDir)
    writer = await writerIncarnation(identity.clientEpoch, {
      startTime: options.startTime ?? (async () => null),
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.pid !== undefined ? { pid: options.pid } : {}),
    })
  })().catch(() => { identity = null; writer = null })

  const rootOf = (senderId: number): string | null => { try { return options.windowRoot(senderId) } catch { return null } }

  function retire(senderId: number): void {
    const life = lifetimes.get(senderId)
    if (life) { life.retired = true; lifetimes.delete(senderId) }
  }

  /** At request entry, synchronously: this window's lifetime for its folder now (a new one after a change). */
  function enter(senderId: number): Lifetime | null {
    const root = rootOf(senderId)
    const current = lifetimes.get(senderId)
    if (current && current.root === root) return current
    retire(senderId)
    if (!root) return null
    const life: Lifetime = { root, retired: false, binding: null, token: mintLifetime() }
    lifetimes.set(senderId, life)
    return life
  }

  /** Why `life` no longer speaks for this window, checked without awaiting. A changed folder retires it. */
  function staleNow(senderId: number, life: Lifetime): Stale | null {
    if (disposed) return 'window-closed'
    if (life.retired || lifetimes.get(senderId) !== life) return 'owner-replaced'
    if (rootOf(senderId) !== life.root) { retire(senderId); return 'window-root-changed' }
    return null
  }

  async function enrolled(root: string): Promise<{ real: string; vault: string } | null> {
    let real: string
    try { real = await resolveReal(root) } catch { return null }
    const vault = trial.enabled ? trial.vaults.get(real) : undefined
    return vault ? { real, vault } : null
  }

  /** The lifetime's owner, minted once; null (and retired) when its folder now resolves to another vault. */
  function bindingOf(senderId: number, life: Lifetime, place: { real: string; vault: string }, epoch: number): Binding | null {
    life.binding ??= { owner: mintOwner(), ownerEpoch: epoch, ...place }
    if (life.binding.real === place.real && life.binding.vault === place.vault) return life.binding
    retire(senderId)
    return null
  }

  /** The final check before a live answer: the folder resolved again, then everything rechecked after that await. */
  async function staleness(senderId: number, life: Lifetime, binding: Binding): Promise<Stale | null> {
    const before = staleNow(senderId, life)
    if (before) return before
    let real: string | null
    try { real = await resolveReal(life.root) } catch { real = null }
    const after = staleNow(senderId, life)
    if (after) return after
    if (real !== binding.real || !trial.enabled || trial.vaults.get(real) !== binding.vault) { retire(senderId); return 'window-root-changed' }
    return null
  }

  function streamFor(vault: string): Promise<ReceiptStream | null> {
    let made = streams.get(vault)
    if (!made) {
      made = (async () => {
        await ready
        const id = identity
        if (!id || disposed || !trial.enabled) return null
        let store: OutboxStore
        try {
          store = await OutboxStore.open(options.receiptsDir, vault, id.clientId)
        } catch (error) {
          if (error instanceof OutboxDamaged) return null
          throw error
        }
        const real = realOf.get(vault)!
        const socketPath = trial.socketPath
        const client = trial.client
        const timeoutMs = trial.connectTimeoutMs
        const me = writer
        return new ReceiptStream({
          vault, store, clientEpoch: id.clientEpoch, writer: me,
          connect: () => connect(socketPath, { client, clientId: id.clientId, clientEpoch: id.clientEpoch, writer: me, timeoutMs }),
          now,
          ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
          ...(options.retryMs ? { retryMs: options.retryMs } : {}),
          verifyDurable: async (path, blob) => {
            const bytes = await readDurableBytes(join(real, path))
            const format = store.value.objectFormat ?? 'sha1'
            return gitBlobOid(bytes, format) === blob[format]
          },
        })
      })().catch(() => null)
      streams.set(vault, made)
    }
    return made
  }

  /**
   * `live` is the save's window lifetime: once it is retired or its folder changed, no non-atomic write is
   * admitted (a start already granted then owes its abandon through the hold route). Facts of the save
   * itself are still recorded, under the owner it was stamped with.
   */
  function saveHandle(intent: NonNullable<Awaited<ReturnType<ReceiptStream['beginSave']>>>, live: () => boolean): MainSaveReceipt {
    let reported = false
    return {
      async nonAtomicCreate(bytes) {
        const blob = gitBlobOids(bytes)
        if (live() && (await intent.requestStart(budget)) && live()) {
          return {
            kind: 'copy',
            // The Workspace asks again in the tick of the copy: the lifetime may have been retired since.
            admit: () => live(),
            refused: async () => { reported = true; await intent.hold(bytes, blob) },
            copied: async (absolute) => {
              reported = true
              try {
                const back = await readDurableBytes(absolute)
                if (Buffer.compare(back, Buffer.from(bytes)) === 0) { await intent.copied(gitBlobOids(back)); return }
              } catch { /* not durable as written: the write is over all the same */ }
              await intent.copyClosed()
            },
            copyFailed: async () => { reported = true; await intent.copyClosed() },
          }
        }
        // No exact durable start in time: the complete bytes go off the vault first; nothing is copied.
        await intent.hold(bytes, blob)
        reported = true
        return { kind: 'held' }
      },
      async saved(absolute, written) {
        if (reported) return
        reported = true
        try {
          const back = await readDurableBytes(absolute)
          if (Buffer.compare(back, Buffer.from(written, 'utf8')) === 0) { await intent.durable(gitBlobOids(back)); return }
        } catch { /* the bytes are not proven durable: no flush, the debt stays */ }
        await intent.failed().catch(() => undefined)
      },
      async failed() {
        if (reported) { await intent.failed().catch(() => undefined); return }
        reported = true
        await intent.failed().catch(() => undefined)
      },
    }
  }

  return {
    ready,
    streamFor,

    async lifetime(sender, args) {
      if (disposed) return { state: 'stale', reason: 'window-closed' }
      if (!sender.mainFrame) return { state: 'refused', reason: 'not-main-frame' }
      if (args.length !== 1) return { state: 'refused', reason: 'unexpected-arguments' }
      const v = plain(args[0], ['root'])
      if (!v || typeof v.root !== 'string' || v.root === '') return { state: 'refused', reason: 'bad-request' }
      // Synchronously, the lifetime main holds for this window now. Only for the folder the renderer shows: a
      // renderer still showing a folder main has left gets no token, so none of its calls can name the new one.
      const life = enter(sender.id)
      if (!life) return { state: 'not-registered' }
      if (life.root !== v.root) return { state: 'stale', reason: 'window-root-changed' }
      return { state: 'bound', lifetime: life.token }
    },

    async reportEdit(sender, args) {
      // Entry: main's time and the window's lifetime, before anything is awaited. The edit's own time is the
      // renderer's original reading, never later than this entry (callMeta).
      const entry = now()
      if (disposed) return { state: 'stale', reason: 'window-closed' }
      if (!sender.mainFrame) return { state: 'refused', reason: 'not-main-frame' }
      if (args.length !== 1) return { state: 'refused', reason: 'unexpected-arguments' }
      const input = editInput(args[0], entry)
      if (!input) return { state: 'refused', reason: 'bad-request' }
      const at = input.at
      const life = enter(sender.id)
      if (!life) return { state: 'not-registered' }
      // Sent under a lifetime main has since retired (another folder, a reloaded page, the same folder bound
      // again): refused before anything is stored, so it never becomes the replacement owner's debt.
      if (input.lifetime !== life.token) return { state: 'stale', reason: 'owner-replaced' }
      const place = await enrolled(life.root)
      const early = staleNow(sender.id, life)
      if (early) return { state: 'stale', reason: early }
      if (!place) return { state: 'not-registered' }
      await ready
      const unready = staleNow(sender.id, life)
      if (unready) return { state: 'stale', reason: unready }
      if (!identity) return { state: 'unavailable', reason: 'no-identity' }
      const binding = bindingOf(sender.id, life, place, identity.clientEpoch)
      if (!binding) return { state: 'stale', reason: 'window-root-changed' }
      const stream = await streamFor(place.vault)
      const opened = staleNow(sender.id, life)
      if (opened) return { state: 'stale', reason: opened }
      if (!stream) return { state: 'unavailable', reason: 'outbox-damaged' }
      const doc: DocRef = { owner: binding.owner, ownerEpoch: binding.ownerEpoch, docEpoch: input.docEpoch }
      try {
        await stream.reportEdit(doc, input.path, input.gen, at)
      } catch {
        return { state: 'unavailable', reason: 'not-stored' }
      }
      // Stored under its own owner either way; only a live window hears that it was noted.
      const late = staleNow(sender.id, life)
      if (late) return { state: 'stale', reason: late }
      return { state: 'noted', owner: binding.owner }
    },

    async status(sender, args) {
      if (disposed) return { state: 'stale', reason: 'window-closed' }
      if (!sender.mainFrame) return { state: 'refused', reason: 'not-main-frame' }
      if (args.length !== 1) return { state: 'refused', reason: 'unexpected-arguments' }
      // The lifetime token is required: a status without one is refused before it can take the lifetime main
      // holds at its entry.
      const v = plain(args[0], ['docs', 'lifetime'])
      if (v && (typeof v.lifetime !== 'string' || !TOKEN.test(v.lifetime))) return { state: 'refused', reason: 'bad-request' }
      const list = v && Array.isArray(v.docs) && v.docs.length >= 1 && v.docs.length <= BACKUP_RECEIPT_MAX_DOCS ? v.docs.map((d) => docInput(d, 0)) : null
      if (!list || list.some((d) => d === null)) return { state: 'refused', reason: 'bad-request' }
      const life = enter(sender.id)
      if (!life) return { state: 'not-registered' }
      if (v!.lifetime !== life.token) return { state: 'stale', reason: 'owner-replaced' }
      const place = await enrolled(life.root)
      const early = staleNow(sender.id, life)
      if (early) return { state: 'stale', reason: early }
      if (!place) return { state: 'not-registered' }
      await ready
      const unready = staleNow(sender.id, life)
      if (unready) return { state: 'stale', reason: unready }
      if (!identity) return { state: 'unavailable', reason: 'no-identity', observedAt: now(), ...limits() }
      const binding = bindingOf(sender.id, life, place, identity.clientEpoch)
      if (!binding) return { state: 'stale', reason: 'window-root-changed' }
      const stream = await streamFor(place.vault)
      const opened = staleNow(sender.id, life)
      if (opened) return { state: 'stale', reason: opened }
      if (!stream) return { state: 'unavailable', reason: 'outbox-damaged', observedAt: now(), ...limits() }
      const want: CapturedDoc[] = list.map((d) => ({ path: d!.path, doc: { owner: binding.owner, ownerEpoch: binding.ownerEpoch, docEpoch: d!.docEpoch }, gen: d!.gen }))
      const reply = await stream.status(want.map((w) => ({ path: w.path, doc: { ...w.doc } })))
      // The last await before the answer.
      const stale = await staleness(sender.id, life, binding)
      if (stale) return { state: 'stale', reason: stale }
      // Checked again here, in the tick that answers: the lifetime may have been retired while `staleness`
      // resolved. Nothing below awaits, so this check holds when the answer is returned.
      const final = staleNow(sender.id, life) ?? (life.binding === binding ? null : 'owner-replaced')
      if (final) return { state: 'stale', reason: final }
      const view = reply && reply.ok && reply.result.recordId === stream.outbox.recordId ? reply.result : null
      const coverage = computeCoverage({ lane: stream.state, outbox: stream.outbox, view, want })
      return { state: 'reported', observedAt: now(), lane: stream.state, covered: coverage.covered, docs: coverage.docs, uncertainty: coverage.uncertainty, ...limits() }
    },

    async beginSave(senderId, root, path, meta) {
      // Entry: main's time and the window's lifetime, before anything is awaited. The save's debt time is the
      // original time of the oldest edit its bytes carry that is not yet on disk, never later than this (callMeta).
      const entry = now()
      if (disposed || meta === undefined) return null
      const input = saveInput(meta, entry)
      if (!input || !receiptPathOk(path)) return null
      const at = input.at
      const life = enter(senderId)
      if (!life || life.root !== root) return null
      // Metadata without a token (saveInput) or from a retired lifetime: the save goes ahead as before, with no
      // receipt under this owner.
      if (input.lifetime !== life.token) return null
      const place = await enrolled(root)
      if (!place || staleNow(senderId, life)) return null
      await ready
      if (!identity || staleNow(senderId, life)) return null
      const binding = bindingOf(senderId, life, place, identity.clientEpoch)
      if (!binding) return null
      const stream = await streamFor(place.vault)
      if (!stream || staleNow(senderId, life)) return null
      const doc: DocRef = { owner: binding.owner, ownerEpoch: binding.ownerEpoch, docEpoch: input.docEpoch }
      const intent = await stream.beginSave(doc, path, input.gen, at).catch(() => null)
      // From here the intent is durable under its owner; the handle keeps the lifetime's authority.
      return intent ? saveHandle(intent, () => staleNow(senderId, life) === null) : null
    },

    nonAtomicPolicy(root) {
      if (!trial.enabled) return 'copy'
      return trial.vaults.has(resolveRealSync(root)) ? 'refuse' : 'copy'
    },

    retireSender(senderId) {
      retire(senderId)
    },

    dispose() {
      disposed = true
      for (const id of [...lifetimes.keys()]) retire(id)
      for (const made of streams.values()) void made.then((s) => s?.close())
    },
  }
}
