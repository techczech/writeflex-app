/**
 * Checks the backup helper's `status` and `syncNow` results before any of it leaves main.
 *
 * The helper's client checks the reply envelope; the result inside is the caller's to check
 * (helper protocol.ts). This module does that against the bounded views of helper status-view.ts:
 * every object has exactly its known fields, every list view is `{ count, items, omitted }` with
 * `omitted === count - items.length` and at most the helper's largest item limit, timestamps are
 * whole milliseconds no later than a minute past main's own clock, counts are whole and not
 * negative, snapshots are Git object ids, refs are Git ref names, the status names protocol 1
 * and paths are folder-relative. A cycle that says
 * "verified" must carry the proof the helper's worker requires: a captured snapshot, a pushed or
 * already-present branch and a verification of that same snapshot.
 *
 * It returns fresh objects built from the checked fields only. Anything else throws
 * ReplyCheckError; the caller drops the connection and reports a bad reply.
 */
import { BACKUP_HELPER_PROTOCOL } from '../../shared/backup-helper'
import type {
  BackupBlockReason, BackupBlockView, BackupCycleView, BackupEngineView, BackupHelperSummary, BackupVaultView, ListView,
} from '../../shared/backup-helper'

export class ReplyCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplyCheckError'
  }
}

/** helper status-view.ts VIEW_ITEM_LIMITS[0]. */
const MAX_LIST_ITEMS = 100
/** helper status-view.ts MAX_VIEW_MESSAGE plus its ellipsis; the worker's own messages are shorter. */
const MAX_MESSAGE = 501
const MAX_UNCERTAINTY = 64
const MAX_PATH = 4096
/** A helper on the same machine shares main's clock; this allows for the time the reply took. */
const FUTURE_TOLERANCE_MS = 60_000

/** helper protocol.ts VAULT_ID and backup-ref.ts ID. */
export const VAULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const ID = VAULT_ID
/** engine.ts REMOTE_NAME. */
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const REF_CHARS = /^refs\/[A-Za-z0-9._/-]{1,250}$/
const TOKEN = /^[a-z][a-z0-9:-]{0,80}$/
const VERSION = /^[\x20-\x7e]{1,100}$/

const BLOCK_REASONS: readonly BackupBlockReason[] = ['cloud-synced-location', 'not-enabled', 'enablement-stale', 'unsupported-remote', 'public-remote-unconfirmed', 'visibility-unknown', 'secret-found', 'scanner-unavailable', 'too-large-to-scan', 'unsupported-history', 'history-unavailable']
const SUMMARIES: readonly BackupHelperSummary[] = ['unknown', 'not-enabled', 'blocked', 'error', 'unprotected', 'no-known-unprotected-edits']
const OUTCOMES = ['verified', 'blocked', 'capture-failed', 'push-failed', 'verify-failed', 'no-snapshot', 'cancelled'] as const
const PUSH_STATES = ['pushed', 'up-to-date', 'blocked', 'rejected', 'failed', 'no-snapshot'] as const
const VERIFY_STATES = ['not-pushed', 'missing-on-remote', 'mismatch', 'failed', 'blocked'] as const
const ERROR_KINDS = ['push-rejected', 'push-failed', 'verify-failed', 'verify-mismatch', 'capture-failed'] as const
const HELPER_STATES = ['idle', 'cycling', 'stopping', 'stopped'] as const

const fail = (where: string, what: string): never => { throw new ReplyCheckError(`${where}: ${what}`) }

type Obj = Record<string, unknown>

/** An object with exactly these required and optional fields. */
function record(value: unknown, where: string, required: readonly string[], optional: readonly string[] = []): Obj {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(where, 'not an object')
  const v = value as Obj
  for (const key of Object.keys(v)) if (!required.includes(key) && !optional.includes(key)) fail(where, `unexpected field ${JSON.stringify(key).slice(0, 40)}`)
  for (const key of required) if (!(key in v)) fail(where, `missing ${key}`)
  return v
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(where, 'unknown value')
  return value as T
}

function bool(value: unknown, where: string): boolean {
  if (typeof value !== 'boolean') fail(where, 'not a boolean')
  return value as boolean
}

function count(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(where, 'not a whole, non-negative number')
  return value as number
}

function text(value: unknown, where: string, max = MAX_MESSAGE): string {
  if (typeof value !== 'string' || value.length > max) fail(where, 'not a short text')
  return value as string
}

function matching(value: unknown, pattern: RegExp, where: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail(where, 'malformed')
  return value as string
}

/**
 * A full ref name as `git check-ref-format` accepts it, within the characters the helper's refs use
 * (backup-ref.ts: `refs/heads/backup/<machine>/<checkout>/<yyyy-mm-dd>`): under `refs/`, no empty
 * component (so no `//` and no trailing `/`), no component starting with `.` or ending with `.lock`,
 * no `..` and no trailing `.`. The value is returned exactly as sent.
 */
function gitRef(value: unknown, where: string): string {
  const ref = matching(value, REF_CHARS, where)
  const parts = ref.split('/').slice(1)
  if (ref.includes('..') || ref.endsWith('.') || parts.some((p) => p === '' || p.startsWith('.') || p.endsWith('.lock'))) fail(where, 'not a Git ref name')
  return ref
}

function nullable<T>(value: unknown, check: (v: unknown) => T): T | null {
  return value === null ? null : check(value)
}

/** Checks timestamps against main's clock when the reply arrived. */
class Checker {
  constructor(private readonly receivedAt: number) {}

  time(value: unknown, where: string): number {
    const t = count(value, where)
    if (t > this.receivedAt + FUTURE_TOLERANCE_MS) fail(where, 'dated in the future')
    return t
  }

  path(value: unknown, where: string, allowRoot = false): string {
    if (typeof value !== 'string' || value.length > MAX_PATH || value.includes('\0')) fail(where, 'not a path')
    const p = value as string
    if (p === '' && allowRoot) return p
    if (p === '' || p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) fail(where, 'not a folder-relative path')
    return p
  }

  list<T>(value: unknown, where: string, item: (v: unknown, where: string) => T): ListView<T> {
    const v = record(value, where, ['count', 'items', 'omitted'])
    const total = count(v.count, `${where}.count`)
    const omitted = count(v.omitted, `${where}.omitted`)
    if (!Array.isArray(v.items)) fail(`${where}.items`, 'not a list')
    const raw = v.items as unknown[]
    if (raw.length > MAX_LIST_ITEMS) fail(`${where}.items`, 'longer than the helper sends')
    if (raw.length > total || omitted !== total - raw.length) fail(where, 'count, items and omitted disagree')
    return { count: total, items: raw.map((entry, i) => item(entry, `${where}.items[${i}]`)), omitted }
  }

  paths(value: unknown, where: string, allowRoot = false): ListView<string> {
    return this.list(value, where, (v, w) => this.path(v, w, allowRoot))
  }

  block(value: unknown, where: string): BackupBlockView {
    const v = record(value, where, ['reason', 'at', 'message'], ['findings', 'notScanned'])
    const out: BackupBlockView = {
      reason: oneOf(v.reason, BLOCK_REASONS, `${where}.reason`),
      at: this.time(v.at, `${where}.at`),
      message: text(v.message, `${where}.message`),
    }
    if (v.findings !== undefined) {
      out.findings = this.list(v.findings, `${where}.findings`, (f, w) => {
        const r = record(f, w, ['path', 'rule'])
        return { path: this.path(r.path, `${w}.path`), rule: text(r.rule, `${w}.rule`, 200) }
      })
    }
    if (v.notScanned !== undefined) {
      out.notScanned = this.list(v.notScanned, `${where}.notScanned`, (b, w) => {
        const r = record(b, w, ['path', 'oid', 'size', 'binary'])
        return { path: this.path(r.path, `${w}.path`), oid: matching(r.oid, OID, `${w}.oid`), size: count(r.size, `${w}.size`), binary: bool(r.binary, `${w}.binary`) }
      })
    }
    return out
  }

  cycle(value: unknown, where: string): BackupCycleView {
    const v = record(value, where, ['vault', 'reason', 'startedAt', 'finishedAt', 'outcome', 'capture', 'push', 'verify', 'block', 'error'])
    const startedAt = this.time(v.startedAt, `${where}.startedAt`)
    const finishedAt = this.time(v.finishedAt, `${where}.finishedAt`)
    if (finishedAt < startedAt) fail(where, 'finished before it started')
    const capture = nullable(v.capture, (c) => {
      const r = record(c, `${where}.capture`, ['snapshot', 'committed', 'startedAt', 'changed', 'pending', 'skipped'])
      return {
        snapshot: nullable(r.snapshot, (s) => matching(s, OID, `${where}.capture.snapshot`)),
        committed: bool(r.committed, `${where}.capture.committed`),
        startedAt: this.time(r.startedAt, `${where}.capture.startedAt`),
        changed: count(r.changed, `${where}.capture.changed`),
        pending: this.paths(r.pending, `${where}.capture.pending`),
        skipped: count(r.skipped, `${where}.capture.skipped`),
      }
    })
    const push = nullable(v.push, (p) => {
      const r = record(p, `${where}.push`, ['state'], ['reason', 'message'])
      return {
        state: oneOf(r.state, PUSH_STATES, `${where}.push.state`),
        ...(r.reason !== undefined ? { reason: oneOf(r.reason, BLOCK_REASONS, `${where}.push.reason`) } : {}),
        ...(r.message !== undefined ? { message: text(r.message, `${where}.push.message`) } : {}),
      }
    })
    const verify = nullable(v.verify, (p) => {
      const r = record(p, `${where}.verify`, ['verified'], ['state', 'snapshot', 'message'])
      const verified = bool(r.verified, `${where}.verify.verified`)
      if (verified && (r.snapshot === undefined || r.state !== undefined)) fail(`${where}.verify`, 'a verification names its snapshot and no failure state')
      if (!verified && r.state === undefined) fail(`${where}.verify`, 'a failed verification names its state')
      return {
        verified,
        ...(r.state !== undefined ? { state: oneOf(r.state, VERIFY_STATES, `${where}.verify.state`) } : {}),
        ...(r.snapshot !== undefined ? { snapshot: matching(r.snapshot, OID, `${where}.verify.snapshot`) } : {}),
        ...(r.message !== undefined ? { message: text(r.message, `${where}.verify.message`) } : {}),
      }
    })
    const outcome = oneOf(v.outcome, OUTCOMES, `${where}.outcome`)
    if (outcome === 'verified') {
      // vault-worker.ts runCycle: "verified" only when this cycle's own captured snapshot was verified.
      const proved = capture?.snapshot != null && (push?.state === 'pushed' || push?.state === 'up-to-date') && verify?.verified === true && verify.snapshot === capture.snapshot
      if (!proved) fail(where, '"verified" without verification of the captured snapshot')
    }
    return {
      vault: matching(v.vault, VAULT_ID, `${where}.vault`),
      reason: oneOf(v.reason, ['schedule', 'syncNow'] as const, `${where}.reason`),
      startedAt,
      finishedAt,
      outcome,
      capture,
      push,
      verify,
      block: nullable(v.block, (b) => this.block(b, `${where}.block`)),
      error: nullable(v.error, (e) => text(e, `${where}.error`)),
    }
  }

  engine(value: unknown, where: string): BackupEngineView {
    const v = record(value, where, ['machineId', 'checkoutId', 'protectionAgeSeconds', 'oldestUnprotectedEdit', 'lastVerifiedSnapshot', 'lastVerifiedAt', 'protectedThrough', 'latestSnapshot', 'latestRef', 'lastPushed', 'pending', 'unlistedFolders', 'unflushedEditSince', 'writing', 'lastError', 'recoveredFromDamagedRecord', 'repositoryHooksNotRun', 'enabled', 'remote', 'block'])
    const age = v.protectionAgeSeconds
    if (typeof age !== 'number' || !Number.isFinite(age) || age < 0) fail(`${where}.protectionAgeSeconds`, 'not a non-negative number')
    const time = (key: string) => nullable(v[key], (t) => this.time(t, `${where}.${key}`))
    const oid = (key: string) => nullable(v[key], (s) => matching(s, OID, `${where}.${key}`))
    return {
      machineId: matching(v.machineId, ID, `${where}.machineId`),
      checkoutId: matching(v.checkoutId, ID, `${where}.checkoutId`),
      protectionAgeSeconds: age as number,
      oldestUnprotectedEdit: time('oldestUnprotectedEdit'),
      lastVerifiedSnapshot: oid('lastVerifiedSnapshot'),
      lastVerifiedAt: time('lastVerifiedAt'),
      protectedThrough: time('protectedThrough'),
      latestSnapshot: oid('latestSnapshot'),
      latestRef: nullable(v.latestRef, (r) => gitRef(r, `${where}.latestRef`)),
      lastPushed: nullable(v.lastPushed, (p) => {
        const r = record(p, `${where}.lastPushed`, ['snapshot', 'ref', 'seq', 'coverage'])
        return {
          snapshot: matching(r.snapshot, OID, `${where}.lastPushed.snapshot`),
          ref: gitRef(r.ref, `${where}.lastPushed.ref`),
          seq: nullable(r.seq, (s) => count(s, `${where}.lastPushed.seq`)),
          coverage: nullable(r.coverage, (c) => this.time(c, `${where}.lastPushed.coverage`)),
        }
      }),
      pending: this.paths(v.pending, `${where}.pending`),
      unlistedFolders: this.paths(v.unlistedFolders, `${where}.unlistedFolders`, true),
      unflushedEditSince: time('unflushedEditSince'),
      writing: this.paths(v.writing, `${where}.writing`),
      lastError: nullable(v.lastError, (e) => {
        const r = record(e, `${where}.lastError`, ['kind', 'at', 'message'])
        return { kind: oneOf(r.kind, ERROR_KINDS, `${where}.lastError.kind`), at: this.time(r.at, `${where}.lastError.at`), message: text(r.message, `${where}.lastError.message`) }
      }),
      recoveredFromDamagedRecord: bool(v.recoveredFromDamagedRecord, `${where}.recoveredFromDamagedRecord`),
      repositoryHooksNotRun: this.list(v.repositoryHooksNotRun, `${where}.repositoryHooksNotRun`, (h, w) => text(h, w, 200)),
      enabled: bool(v.enabled, `${where}.enabled`),
      remote: nullable(v.remote, (r) => matching(r, REMOTE_NAME, `${where}.remote`)),
      block: nullable(v.block, (b) => this.block(b, `${where}.block`)),
    }
  }

  vault(value: unknown, where: string): BackupVaultView {
    const v = record(value, where, ['vault', 'summary', 'uncertainty', 'helper', 'fresh', 'engineObservedAt', 'engine', 'statusError'])
    if (!Array.isArray(v.uncertainty) || v.uncertainty.length > MAX_UNCERTAINTY) fail(`${where}.uncertainty`, 'not a short list')
    const uncertainty = (v.uncertainty as unknown[]).map((u, i) => matching(u, TOKEN, `${where}.uncertainty[${i}]`))
    // The helper always names it (vault-worker.ts summarise); a reply without it is not this helper's.
    if (v.engine !== null && !uncertainty.includes('edits-after-last-capture-unknown')) fail(`${where}.uncertainty`, 'drops edits-after-last-capture-unknown')
    if (uncertainty.length === 0) fail(`${where}.uncertainty`, 'empty')
    const h = record(v.helper, `${where}.helper`, ['state', 'cycleStartedAt', 'nextDueAt', 'lastCycle'])
    const vaultId = matching(v.vault, VAULT_ID, `${where}.vault`)
    const lastCycle = nullable(h.lastCycle, (c) => this.cycle(c, `${where}.helper.lastCycle`))
    if (lastCycle && lastCycle.vault !== vaultId) fail(`${where}.helper.lastCycle`, 'belongs to another vault')
    const engine = nullable(v.engine, (e) => this.engine(e, `${where}.engine`))
    const fresh = bool(v.fresh, `${where}.fresh`)
    const summary = oneOf(v.summary, SUMMARIES, `${where}.summary`)
    // vault-worker.ts summarise: no engine answer is "unknown"; a stale one is too.
    if ((engine === null || !fresh) && summary !== 'unknown') fail(`${where}.summary`, 'claims more than a missing or stale answer allows')
    return {
      vault: vaultId,
      summary,
      uncertainty,
      helper: {
        state: oneOf(h.state, HELPER_STATES, `${where}.helper.state`),
        cycleStartedAt: nullable(h.cycleStartedAt, (t) => this.time(t, `${where}.helper.cycleStartedAt`)),
        // The next due time is in the future by design.
        nextDueAt: nullable(h.nextDueAt, (t) => count(t, `${where}.helper.nextDueAt`)),
        lastCycle,
      },
      fresh,
      engineObservedAt: nullable(v.engineObservedAt, (t) => this.time(t, `${where}.engineObservedAt`)),
      engine,
      statusError: nullable(v.statusError, (e) => text(e, `${where}.statusError`)),
    }
  }
}

export type CheckedStatus = { helper: { protocol: number; helperVersion: string; startedAt: number; stopping: boolean }; vault: BackupVaultView }

/** The `status` result for one vault: `{ helper, vaults: [view] }`, the view for `vaultId`. */
export function checkStatusResult(result: unknown, vaultId: string, receivedAt: number): CheckedStatus {
  const c = new Checker(receivedAt)
  const v = record(result, 'status', ['helper', 'vaults'])
  // `pid` is checked but never forwarded: the renderer has no use for a process id.
  const h = record(v.helper, 'status.helper', ['protocol', 'helperVersion', 'pid', 'startedAt', 'stopping'])
  count(h.pid, 'status.helper.pid')
  // connectHelper checked the hello; a status naming another protocol contradicts it.
  if (h.protocol !== BACKUP_HELPER_PROTOCOL) fail('status.helper.protocol', 'not the protocol this bridge speaks')
  const helper = {
    protocol: BACKUP_HELPER_PROTOCOL,
    helperVersion: matching(h.helperVersion, VERSION, 'status.helper.helperVersion'),
    startedAt: c.time(h.startedAt, 'status.helper.startedAt'),
    stopping: bool(h.stopping, 'status.helper.stopping'),
  }
  if (!Array.isArray(v.vaults) || v.vaults.length !== 1) fail('status.vaults', 'not exactly the one vault asked for')
  const vault = c.vault((v.vaults as unknown[])[0], 'status.vaults[0]')
  if (vault.vault !== vaultId) fail('status.vaults[0].vault', 'not the vault asked for')
  return { helper, vault }
}

/** The `syncNow` result: one cycle report, for `vaultId`. */
export function checkCycleResult(result: unknown, vaultId: string, receivedAt: number): BackupCycleView {
  const cycle = new Checker(receivedAt).cycle(result, 'cycle')
  if (cycle.vault !== vaultId) fail('cycle.vault', 'not the vault asked for')
  return cycle
}
