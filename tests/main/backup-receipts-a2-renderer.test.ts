/**
 * Editor receipts, renderer side (A2): the save identity the document owner sends with its bytes, the edit
 * report adapter (one report per debt episode, original time, main's lifetime token, bounded calls), the proof predicate over main's
 * per-document states, and the Sync adapter's nullable `backup.revision`. Fake clock and fake main; the
 * real document owner, autosave scheduler and Sync adapter.
 */
import { describe, expect, test } from 'bun:test'
import {
  BACKUP_HELPER_LIMITS,
  type BackupHelperStatusAnswer, type BackupReceiptDoc, type BackupReceiptDocInput, type BackupReceiptEditAnswer,
  type BackupReceiptEditInput, type BackupReceiptLifetimeAnswer, type BackupReceiptStatusAnswer, type BackupVaultView,
} from '../../src/shared/backup-helper'
import { textForSave } from '../../src/shared/line-endings'
import type { SaveBasis } from '../../src/shared/save-basis'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createAutosaveScheduler } from '../../src/renderer/src/app/autosave-scheduler'
import { createHelperReceiptAdapter as createAdapter, proves, RECEIPT_CALL_TIMEOUT_MS, RECEIPT_REPORT_DELAY_MS, type HelperReceiptOptions, type ReceiptApi } from '../../src/renderer/src/app/backup-helper-receipts'
import { fanOutReceipts, type SaveIdentity } from '../../src/renderer/src/app/save-receipts'
import { createHelperSyncAdapter, mapHelperStatus } from '../../src/renderer/src/sync/helper-sync-adapter'
import { presentSync, type SyncView } from '../../src/renderer/src/sync/sync-status'

const P = 'notes/a.md'
const ROOT = '/vault'
const TOKEN = 'c'.repeat(32)
/** The fake clock's wall time at elapsed 0. */
const T0 = 1_700_000_000_000
/** The adapter for the folder ROOT, as App makes it. */
const createHelperReceiptAdapter = (options: HelperReceiptOptions = {}) => createAdapter({ root: ROOT, ...options })
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

/** A manual clock: timers run only when `advance` passes them. */
function fakeClock() {
  let t = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    elapsed: () => t,
    now: () => T0 + t,
    setTimeout: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: t + ms, fn }); return id },
    clearTimeout: (h: unknown) => { timers.delete(h as number) },
    pending: () => timers.size,
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0]); t = due[1].at; due[1].fn()
        await tick()
      }
      t = end
      await tick()
    },
  }
}

/** Main as the renderer sees it: answers each call as the test says, recording them. */
function fakeMain(answer: (doc: BackupReceiptEditInput) => BackupReceiptEditAnswer | Promise<BackupReceiptEditAnswer> = () => ({ state: 'noted', owner: 'o'.repeat(32) })) {
  const reports: BackupReceiptEditInput[] = []
  const statuses: BackupReceiptDocInput[][] = []
  const lifetimes: string[] = []
  let statusAnswer: (docs: BackupReceiptDocInput[]) => BackupReceiptStatusAnswer | Promise<BackupReceiptStatusAnswer> = () => ({ state: 'disabled' })
  let lifetimeAnswer: (root: string) => BackupReceiptLifetimeAnswer | Promise<BackupReceiptLifetimeAnswer> = () => ({ state: 'bound', lifetime: TOKEN })
  const api: ReceiptApi = {
    lifetime: async (root) => { lifetimes.push(root); return lifetimeAnswer(root) },
    reportEdit: async (doc) => { reports.push({ ...doc }); return answer(doc) },
    status: async (docs, lifetime) => { expect(lifetime).toBe(TOKEN); statuses.push(docs.map((d) => ({ ...d }))); return statusAnswer(docs) },
  }
  return { api, reports, statuses, lifetimes, setStatus(fn: typeof statusAnswer) { statusAnswer = fn }, setLifetime(fn: typeof lifetimeAnswer) { lifetimeAnswer = fn } }
}

const verifiedDoc = (d: BackupReceiptDocInput, over: Partial<BackupReceiptDoc> = {}): BackupReceiptDoc => ({
  path: d.path, docEpoch: d.docEpoch, gen: d.gen, owner: 'o'.repeat(32), state: 'remote-verified', blobOid: 'b'.repeat(40),
  since: null, observedAt: 5, verifiedAt: 4, snapshot: 's'.repeat(40), ...over,
})
const reportedReceipts = (docs: BackupReceiptDocInput[], over: Partial<Extract<BackupReceiptStatusAnswer, { state: 'reported' }>> = {}, doc: Partial<BackupReceiptDoc> = {}): BackupReceiptStatusAnswer => ({
  state: 'reported', observedAt: 5, protectionClaim: false, limits: [...BACKUP_HELPER_LIMITS], lane: 'open', covered: true,
  docs: docs.map((d) => verifiedDoc(d, doc)), uncertainty: [], ...over,
})

describe('the save carries the identity captured with its bytes', () => {
  function ownerHarness() {
    const registry = createUnsavedRegistry()
    const h = { buffer: 'A\n', disk: 'A\n' as string | null, sent: [] as Array<{ doc: string; identity: SaveIdentity | undefined }>, during: null as null | (() => void | Promise<void>), before: null as null | (() => void) }
    const owner = createDocumentOwner({
      buffer: () => h.buffer,
      notice: () => undefined,
      registry,
      write: async (_p, doc, _basis: SaveBasis, identity) => {
        h.sent.push({ doc, identity: identity ? { ...identity } : undefined })
        const during = h.during; h.during = null
        await during?.()
        h.disk = textForSave(doc, h.disk)
        return { content: h.disk, written: h.disk }
      },
      // The await between the buffer read and main's call (the e2e slow-save hold is one).
      beforeSave: async () => { const before = h.before; h.before = null; await tick(); before?.() },
      setReadOnly: () => {}, forgetBuffer: () => {}, renameBuffer: () => {}, replaceBuffer: () => {}, dirtyChanged: () => {},
      report: { slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {}, saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {} },
    })
    owner.activated(P, 'A\n', () => h.buffer)
    const type = (text: string) => { h.buffer = text; owner.edited(P, text) }
    return { h, owner, type }
  }

  test('typing while the write is on its way never relabels the bytes already sent (causal: current gen grafted)', async () => {
    const { h, owner, type } = ownerHarness()
    type('A1\n'); type('A12\n'); type('A123\n') // gen 3
    // While the gen-3 bytes are with main, the writer types twice more (gen 5).
    h.during = () => { type('A1234\n'); type('A12345\n') }
    expect(await owner.save(P)).toBe(true)
    expect(h.sent).toEqual([{ doc: 'A123\n', identity: { docEpoch: 1, gen: 3 } }])
    expect(owner.generationsOf(P)).toEqual({ gen: 5, savedGen: 3 })
    // The next save carries gen 5 with its own bytes.
    await owner.save(P)
    expect(h.sent[1]).toEqual({ doc: 'A12345\n', identity: { docEpoch: 1, gen: 5 } })
    // Typing after the read but before main is called (an await between): still the read's gen.
    type('A123456\n') // gen 6
    h.before = () => { type('A1234567\n') } // gen 7, before main sees the gen-6 bytes
    await owner.save(P)
    expect(h.sent[2]).toEqual({ doc: 'A123456\n', identity: { docEpoch: 1, gen: 6 } })
  })

  test('a record made again (dropped, then edited) starts a new epoch', async () => {
    const { h, owner, type } = ownerHarness()
    type('B\n')
    await owner.save(P)
    owner.drop(P)
    owner.activated(P, h.disk!, () => h.buffer)
    type('C\n')
    await owner.save(P)
    expect(h.sent.map((s) => s.identity)).toEqual([{ docEpoch: 1, gen: 1 }, { docEpoch: 2, gen: 1 }])
  })
})

describe('edit reports: one per debt episode, original time, bounded', () => {
  test('a thousand keystrokes make one report after the delay, carrying the first keystroke\'s original time', async () => {
    const clock = fakeClock()
    const main = fakeMain()
    const a = createHelperReceiptAdapter({ api: main.api, clock })
    for (let gen = 1; gen <= 1000; gen++) { a.edited({ path: P, epoch: 1, gen, at: clock.now() }); if (gen % 100 === 0) await clock.advance(50) }
    // 450 ms of typing so far: nothing sent, one timer.
    expect(main.reports).toHaveLength(0)
    expect(clock.pending()).toBe(1)
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    expect(main.reports).toEqual([{ path: P, docEpoch: 1, gen: 1000, lifetime: TOKEN, at: T0 }])
    expect(main.lifetimes).toEqual([ROOT])
    // Main holds the debt now: more typing in the episode sends nothing.
    for (let gen = 1001; gen <= 1500; gen++) a.edited({ path: P, epoch: 1, gen, at: clock.now() })
    await clock.advance(10 * RECEIPT_REPORT_DELAY_MS)
    expect(main.reports).toHaveLength(1)
    expect(clock.pending()).toBe(0)
  })

  test('a flushed save ends the episode; the next edit reports again; typing during the save is reported after it', async () => {
    const clock = fakeClock()
    const main = fakeMain()
    const a = createHelperReceiptAdapter({ api: main.api, clock })
    a.edited({ path: P, epoch: 1, gen: 1, at: 0 })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    a.edited({ path: P, epoch: 1, gen: 2, at: 0 })
    a.saveCompleted({ path: P, epoch: 1, gen: 2, at: 0, outcome: 'flushed' })
    await clock.advance(5 * RECEIPT_REPORT_DELAY_MS)
    expect(main.reports.map((r) => r.gen)).toEqual([1])
    a.edited({ path: P, epoch: 1, gen: 3, at: 0 })
    a.edited({ path: P, epoch: 1, gen: 4, at: 0 })
    // gen 4 typed while the gen-3 save was with main; only gen 3 flushed.
    a.saveCompleted({ path: P, epoch: 1, gen: 3, at: 0, outcome: 'flushed' })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    expect(main.reports.map((r) => r.gen)).toEqual([1, 4])
    // A refused or unknown save ends nothing: no further report.
    a.saveCompleted({ path: P, epoch: 1, gen: 4, at: 0, outcome: 'unknown' })
    a.edited({ path: P, epoch: 1, gen: 5, at: 0 })
    await clock.advance(5 * RECEIPT_REPORT_DELAY_MS)
    expect(main.reports.map((r) => r.gen)).toEqual([1, 4])
  })

  test('the time comes from the autosave scheduler\'s oldest owed mark when it is older (never the report time)', async () => {
    const clock = fakeClock()
    const main = fakeMain()
    const scheduler = createAutosaveScheduler({ flush: async () => undefined, isSaved: () => false, clock: { now: clock.now, elapsed: clock.elapsed, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout } })
    const a = createHelperReceiptAdapter({ api: main.api, clock: { now: clock.now, elapsed: clock.elapsed, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }, owedSince: (p, e, g) => scheduler.owedSince(p, e, g) })
    const port = fanOutReceipts(() => [scheduler.receipts, a])
    port.edited({ path: P, epoch: 1, gen: 1, at: clock.now() })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    // gen 2 is typed at t=1000 while the gen-1 save runs; it flushes at t=3000.
    port.saveStarted({ path: P, epoch: 1, gen: 1, at: clock.now() })
    port.edited({ path: P, epoch: 1, gen: 2, at: clock.now() })
    await clock.advance(2_000)
    port.saveCompleted({ path: P, epoch: 1, gen: 1, at: clock.now(), outcome: 'flushed' })
    // The adapter arms the new episode at t=3000; the scheduler knows gen 2 has been owed since t=1000.
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    expect(main.reports[1]).toEqual({ path: P, docEpoch: 1, gen: 2, lifetime: TOKEN, at: T0 + 1_000 })
    // Save metadata: the captured gen and the original time of the oldest owed edit those bytes carry.
    expect(a.saveMeta(P, { docEpoch: 1, gen: 2 })).toEqual({ docEpoch: 1, gen: 2, lifetime: TOKEN, at: T0 + 1_000 })
    // Bytes of gen 1 carry none of gen 2's debt (noted, nothing of gen 1 owed): no time, main's own, never gen 2's.
    expect(a.saveMeta(P, { docEpoch: 1, gen: 1 })).toEqual({ docEpoch: 1, gen: 1, lifetime: TOKEN })
    scheduler.dispose()
  })

  test('disabled or not registered turns the adapter off: no reports, no save metadata, nothing to prove', async () => {
    for (const state of ['disabled', 'not-registered'] as const) {
      const clock = fakeClock()
      const main = fakeMain(() => ({ state }))
      const a = createHelperReceiptAdapter({ api: main.api, clock })
      a.activate()
      await tick()
      a.edited({ path: P, epoch: 1, gen: 1, at: 0 })
      expect(a.saveMeta(P, { docEpoch: 1, gen: 1 })).toEqual({ docEpoch: 1, gen: 1, lifetime: TOKEN })
      await clock.advance(RECEIPT_REPORT_DELAY_MS)
      expect(a.mode).toBe('off')
      for (let gen = 2; gen < 200; gen++) a.edited({ path: P, epoch: 1, gen, at: 0 })
      await clock.advance(10 * RECEIPT_REPORT_DELAY_MS)
      expect(main.reports).toHaveLength(1)
      expect(a.saveMeta(P, { docEpoch: 1, gen: 199 })).toBeUndefined()
      expect(a.captured()).toBeNull()
      expect(await a.status([{ path: P, docEpoch: 1, gen: 1 }])).toBeNull()
      expect(clock.pending()).toBe(0)
    }
  })

  test('no api: off from the start, so a renderer without the bridge does no receipt work at all', () => {
    const clock = fakeClock()
    const a = createHelperReceiptAdapter({ clock })
    for (let gen = 1; gen < 100; gen++) a.edited({ path: P, epoch: 1, gen, at: 0 })
    expect(a.mode).toBe('off')
    expect(clock.pending()).toBe(0)
    expect(a.saveMeta(P, { docEpoch: 1, gen: 99 })).toBeUndefined()
  })

  test('a hung report keeps its document\'s slot until main settles it: later edits coalesce, no timer, no second call', async () => {
    const clock = fakeClock()
    let release!: (a: BackupReceiptEditAnswer) => void
    const main = fakeMain(() => new Promise((r) => { release = r }))
    const a = createHelperReceiptAdapter({ api: main.api, clock })
    a.edited({ path: P, epoch: 1, gen: 1, at: T0 })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    for (let gen = 2; gen < 50; gen++) { a.edited({ path: P, epoch: 1, gen, at: clock.now() }); await clock.advance(RECEIPT_CALL_TIMEOUT_MS + 1_000) }
    expect(main.reports).toHaveLength(1)
    expect(clock.pending()).toBe(0) // no retry timer: the next edit or save carries the debt
    // The save still names the episode's original time, never a later one.
    expect(a.saveMeta(P, { docEpoch: 1, gen: 49 })?.at).toBe(T0)
    // Main stored it after all: a durable note, never a proof.
    release({ state: 'noted', owner: 'o'.repeat(32) })
    await tick()
    expect(a.mode).toBe('on')
    expect(a.captured()).toBeNull()
  })

  test('deactivated (root changed) while a report is with main: its answer changes nothing, nothing more is sent', async () => {
    const clock = fakeClock()
    let release!: (a: BackupReceiptEditAnswer) => void
    const main = fakeMain(() => new Promise((r) => { release = r }))
    const a = createHelperReceiptAdapter({ api: main.api, clock })
    a.edited({ path: P, epoch: 1, gen: 1, at: 0 })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    expect(main.reports).toHaveLength(1)
    a.deactivate()
    expect(clock.pending()).toBe(0) // the unresolved call holds a slot, not a timer
    release({ state: 'noted', owner: 'o'.repeat(32) })
    await tick()
    expect(a.mode).toBe('unknown')
    a.edited({ path: P, epoch: 1, gen: 2, at: 0 })
    a.saveCompleted({ path: P, epoch: 1, gen: 2, at: 0, outcome: 'flushed' })
    a.edited({ path: P, epoch: 1, gen: 3, at: 0 })
    await clock.advance(20 * RECEIPT_REPORT_DELAY_MS)
    expect(main.reports).toHaveLength(1)
    expect(a.saveMeta(P, { docEpoch: 1, gen: 3 })).toBeUndefined()
    expect(await a.status([{ path: P, docEpoch: 1, gen: 3 }])).toBeNull()
  })

  test('a new owner from main (the folder bound again) is told of every open debt again', async () => {
    const clock = fakeClock()
    let owner = 'a'.repeat(32)
    const main = fakeMain(() => ({ state: 'noted', owner }))
    const a = createHelperReceiptAdapter({ api: main.api, clock })
    a.edited({ path: 'notes/x.md', epoch: 1, gen: 1, at: 0 })
    a.edited({ path: 'notes/y.md', epoch: 2, gen: 1, at: 0 })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    expect(main.reports).toHaveLength(2)
    owner = 'b'.repeat(32)
    a.edited({ path: 'notes/z.md', epoch: 3, gen: 1, at: 0 })
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    await clock.advance(RECEIPT_REPORT_DELAY_MS)
    expect(main.reports.map((r) => r.path)).toEqual(['notes/x.md', 'notes/y.md', 'notes/z.md', 'notes/x.md', 'notes/y.md'])
  })
})

describe('proof: only every captured document remote-verified at its gen', () => {
  const want: BackupReceiptDocInput[] = [{ path: P, docEpoch: 1, gen: 4 }, { path: 'notes/b.md', docEpoch: 2, gen: 1 }]
  test('positive control', () => { expect(proves(want, reportedReceipts(want))).toBe(true) })
  const cases: Array<[string, BackupReceiptStatusAnswer | null]> = [
    ['no answer', null],
    ['disabled', { state: 'disabled' }],
    ['stale owner', { state: 'stale', reason: 'owner-replaced' }],
    ['covered false', reportedReceipts(want, { covered: false, uncertainty: ['vault debt or active writes'] })],
    ['lane offline', reportedReceipts(want, { lane: 'offline' })],
    ['a row omitted (truncated)', { ...reportedReceipts(want), docs: [verifiedDoc(want[0]!)] } as BackupReceiptStatusAnswer],
    ['another gen (older verified, newer typing)', { ...reportedReceipts(want), docs: [verifiedDoc({ ...want[0]!, gen: 3 }), verifiedDoc(want[1]!)] } as BackupReceiptStatusAnswer],
    ['another epoch with equal numbers', { ...reportedReceipts(want), docs: [verifiedDoc({ ...want[0]!, docEpoch: 9 }), verifiedDoc(want[1]!)] } as BackupReceiptStatusAnswer],
    ['captured, not verified', reportedReceipts(want, {}, { state: 'captured' })],
    ['registered only (successful save + ack)', reportedReceipts(want, {}, { state: 'receipt-registered', verifiedAt: null, snapshot: null })],
    ['saved, not registered', reportedReceipts(want, {}, { state: 'saved-not-registered', verifiedAt: null, snapshot: null })],
    ['verified without snapshot', reportedReceipts(want, {}, { snapshot: null })],
  ]
  for (const [name, answer] of cases) test(`refused: ${name}`, () => { expect(proves(want, answer)).toBe(false) })
  test('refused: nothing captured', () => { expect(proves([], reportedReceipts([]))).toBe(false) })
})

describe('Sync mapping: nullable backup.revision, never a fabricated check', () => {
  const now = Date.now() - 1000
  const view: SyncView = { vaultId: '/vault', epoch: 1, revision: 7 }
  function vault(over: Partial<BackupVaultView['engine'] & object> = {}): BackupVaultView {
    return { vault: 'v', summary: 'no-known-unprotected-edits', uncertainty: [], fresh: true, engineObservedAt: now,
      helper: { state: 'idle', cycleStartedAt: null, nextDueAt: null, lastCycle: null }, statusError: null,
      engine: { machineId: 'm', checkoutId: 'c', protectionAgeSeconds: 0, oldestUnprotectedEdit: null, lastVerifiedSnapshot: 'snap', lastVerifiedAt: now - 5000, protectedThrough: now - 6000,
        latestSnapshot: 'snap', latestRef: 'refs/heads/backup/x', lastPushed: null, pending: { count: 0, items: [], omitted: 0 }, unlistedFolders: { count: 0, items: [], omitted: 0 },
        writing: { count: 0, items: [], omitted: 0 }, repositoryHooksNotRun: { count: 0, items: [], omitted: 0 }, unflushedEditSince: null, lastError: null,
        recoveredFromDamagedRecord: false, enabled: true, remote: 'r', block: null, ...over } }
  }
  const control = (v = vault()): BackupHelperStatusAnswer => ({ state: 'reported', observedAt: now, protectionClaim: false, limits: [...BACKUP_HELPER_LIMITS], helper: { protocol: 1, helperVersion: 't', startedAt: now - 1e4, stopping: false }, vault: v })

  test('proven: the revision names the view; the label is at most "Backed up · check needed"', () => {
    const input = mapHelperStatus(control(), view, 1, undefined, true)
    expect(input.backup?.revision).toBe(7)
    expect(input.check).toBeNull()
    const label = presentSync({ ...input, local: { dirtyPaths: [], complete: true } }, Date.now()).label
    expect(label).toBe('Backed up · check needed')
    expect(label).not.toContain('Up to date')
  })
  test('not proven, or the engine not ready (stale, blocked, failed), the revision stays null', () => {
    expect(mapHelperStatus(control(), view, 1).backup?.revision).toBeNull()
    expect(mapHelperStatus(control(vault({ lastError: 'push failed' } as never)), view, 1, undefined, true).backup?.revision).toBeNull()
    expect(mapHelperStatus(control({ ...vault(), fresh: false }), view, 1, undefined, true).backup?.revision).toBeNull()
    const unavailable: BackupHelperStatusAnswer = { state: 'unavailable', reason: 'disconnected', message: 'x', observedAt: now, protectionClaim: false, limits: [...BACKUP_HELPER_LIMITS], lastKnown: { observedAt: now - 10, vault: vault() } }
    expect(mapHelperStatus(unavailable, view, 1, undefined, true).backup?.revision).toBeNull()
  })

  test('the adapter asks main for exactly the documents of the captured view; newer typing is not proven by an older answer', async () => {
    const main = fakeMain()
    const receipts = createHelperReceiptAdapter({ api: main.api, reportDelayMs: 1_000_000 })
    receipts.edited({ path: P, epoch: 1, gen: 4, at: 0 })
    receipts.saveCompleted({ path: P, epoch: 1, gen: 4, at: 0, outcome: 'flushed' })
    main.setStatus((docs) => reportedReceipts(docs))
    const published: Array<number | null | undefined> = []
    const adapter = createHelperSyncAdapter({ status: async () => control(), syncNow: async () => ({ state: 'disabled' }) }, receipts)
    const sub = adapter.subscribe(view, (input) => published.push((input as { backup: { revision: number | null } | null }).backup?.revision))
    await tick(5)
    expect(main.statuses).toEqual([[{ path: P, docEpoch: 1, gen: 4 }]])
    expect(published).toEqual([7])
    // Typing after the capture (gen 5, not saved): nothing can be proven, so main is not even asked.
    receipts.edited({ path: P, epoch: 1, gen: 5, at: 0 })
    sub.updateView({ ...view, revision: 8 })
    await tick(5)
    expect(main.statuses).toHaveLength(1)
    expect(published).toEqual([7, null])
    // Gen 5 saved, but main still answers for gen 4 only (an older observation): not proven.
    receipts.saveCompleted({ path: P, epoch: 1, gen: 5, at: 0, outcome: 'flushed' })
    main.setStatus((docs) => ({ ...reportedReceipts(docs), docs: docs.map((d) => verifiedDoc({ ...d, gen: 4 })) }))
    sub.updateView({ ...view, revision: 9 })
    await tick(5)
    expect(main.statuses[1]).toEqual([{ path: P, docEpoch: 1, gen: 5 }])
    expect(published).toEqual([7, null, null])
    // The coverage text names main's states and keeps the other limits.
    const text = adapter.coverageExplanation!()
    expect(text).toContain('Editor receipts for 1 edited document: 1 remote-verified')
    expect(text).toContain('shared branches are not compared'); expect(text).toContain('No protection claim')
    sub.unsubscribe()
  })

  test('a receipt status that never answers settles as not proven and never fails the Sync read', async () => {
    const main = fakeMain()
    const receipts = createHelperReceiptAdapter({ api: main.api, reportDelayMs: 1_000_000, callTimeoutMs: 30 })
    receipts.edited({ path: P, epoch: 1, gen: 1, at: 0 })
    receipts.saveCompleted({ path: P, epoch: 1, gen: 1, at: 0, outcome: 'flushed' })
    main.setStatus(() => new Promise(() => {}))
    const published: unknown[] = []
    const adapter = createHelperSyncAdapter({ status: async () => control(), syncNow: async () => ({ state: 'disabled' }) }, receipts, { statusTimeoutMs: 500 })
    const sub = adapter.subscribe(view, (input) => published.push(input))
    await tick(80)
    expect(published).toHaveLength(1)
    expect((published[0] as { backup: { revision: number | null } }).backup.revision).toBeNull()
    expect((published[0] as { availability: string }).availability).toBe('ready')
    sub.unsubscribe()
  })

  test('the disabled trial: no receipt status call, explanation unchanged ("editor edits are not reported")', async () => {
    const main = fakeMain(() => ({ state: 'disabled' }))
    const receipts = createHelperReceiptAdapter({ api: main.api, reportDelayMs: 1 })
    receipts.edited({ path: P, epoch: 1, gen: 1, at: 0 })
    await tick(10)
    const adapter = createHelperSyncAdapter({ status: async () => ({ state: 'disabled' }), syncNow: async () => ({ state: 'disabled' }) }, receipts)
    const sub = adapter.subscribe(view, () => {})
    await tick(5)
    expect(main.statuses).toHaveLength(0)
    expect(adapter.coverageExplanation!()).toContain('editor edits are not reported to the helper')
    sub.unsubscribe()
  })
})
