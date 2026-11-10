import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { BackupHelperStatusAnswer, BackupVaultView, BackupHelperSyncAnswer } from '../../src/shared/backup-helper'
import { BACKUP_HELPER_LIMITS } from '../../src/shared/backup-helper'
import { createHelperSyncAdapter } from '../../src/renderer/src/sync/helper-sync-adapter'
import { presentSync, SyncSession, type SyncInput, type SyncView } from '../../src/renderer/src/sync/sync-status'
const now = Date.now() - 1000
const view: SyncView = { vaultId: '/vault', epoch: 1, revision: 3 }
function vault(): BackupVaultView {
  return { vault: 'opaque-vault', summary: 'no-known-unprotected-edits', uncertainty: ['edits-after-last-capture-unknown'], fresh: true, engineObservedAt: now,
    helper: { state: 'idle', cycleStartedAt: null, nextDueAt: null, lastCycle: null }, statusError: null,
    engine: { machineId: 'm', checkoutId: 'c', protectionAgeSeconds: 0, oldestUnprotectedEdit: null, lastVerifiedSnapshot: 'snapshot-original', lastVerifiedAt: now - 5000, protectedThrough: now - 6000,
      latestSnapshot: 'latest', latestRef: 'refs/heads/backup/test', lastPushed: null, pending: { count: 3, items: ['draft.md'], omitted: 2 },
      unlistedFolders: { count: 2, items: ['notes'], omitted: 1 }, writing: { count: 0, items: [], omitted: 0 }, repositoryHooksNotRun: { count: 1, items: ['hook'], omitted: 0 },
      unflushedEditSince: null, lastError: null, recoveredFromDamagedRecord: false, enabled: true, remote: 'remote', block: null } }
}
function reported(v = vault()): BackupHelperStatusAnswer {
  return { state: 'reported', observedAt: now + 500, protectionClaim: false, limits: [...BACKUP_HELPER_LIMITS], helper: { protocol: 1, helperVersion: 'test', startedAt: now - 10000, stopping: false }, vault: v }
}
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const tick = () => new Promise(r => setTimeout(r, 0))
// The adapter falls back to `window` for its lifecycle events; under bun there is none unless another test file
// left one on globalThis. This file's precondition is no `window`, whichever file ran first; restored after.
const hadWindow = 'window' in globalThis
const previousWindow = (globalThis as { window?: unknown }).window
beforeAll(() => { delete (globalThis as { window?: unknown }).window })
afterAll(() => { if (hadWindow) (globalThis as { window?: unknown }).window = previousWindow })


const verifiedCycle = (): BackupHelperSyncAnswer => ({ state: 'cycle', observedAt: now, protectionClaim: false, limits: [...BACKUP_HELPER_LIMITS],
  cycle: { vault: 'opaque-vault', reason: 'syncNow', startedAt: now - 1000, finishedAt: now, outcome: 'verified', capture: null, push: null, verify: { verified: true }, block: null, error: null } })

describe('actions during coalesced view delivery', () => {
  for (const name of ['check', 'syncNow'] as const) {
    test(`${name} accepts the hook's newer revision without waiting for updateView`, async () => {
      const adapter = createHelperSyncAdapter({ status: async () => reported(), syncNow: async () => verifiedCycle() })
      const sub = adapter.subscribe(view, () => {}); await tick()
      const next = { ...view, revision: view.revision + 1 }
      try {
        const result = await adapter.actions[name]!(next)
        expect(result.view).toEqual(next)
        expect(result.backup?.revision).toBeNull()
        expect(presentSync(result, Date.now()).tone).not.toBe('green')
      } finally { sub.unsubscribe() }
    })

    test(`${name} adopts a newer same-scope view before updateView and preserves ordering`, async () => {
      const old = deferred<BackupHelperStatusAnswer>(); const fresh = deferred<BackupHelperStatusAnswer>()
      let statusCalls = 0; let syncCalls = 0
      const adapter = createHelperSyncAdapter({ status: () => ++statusCalls === 1 ? old.promise : statusCalls === 2 ? fresh.promise : Promise.resolve(reported()),
        syncNow: async () => { syncCalls++; return verifiedCycle() } })
      const session = new SyncSession(view); const published: SyncInput[] = []
      const sub = adapter.subscribe(view, value => { published.push(value as SyncInput); session.publish(value) })
      const next = { ...view, revision: view.revision + 1 }
      session.reset(next)
      const operation = session.begin()
      const action = adapter.actions[name]!(next)
      // Attach immediately so a pre-fix rejection is recorded by the assertion below.
      const outcome = action.then(input => ({ input, error: null }), error => ({ input: null, error }))
      try {
        await tick()
        // The delayed hook update must be idempotent; an older delivery must not roll back.
        sub.updateView({ ...next }); sub.updateView(view)
        await expect(adapter.actions.check!(next)).rejects.toThrow('already')
        await expect(adapter.actions.syncNow!({ ...next, revision: next.revision + 1 })).rejects.toThrow('already')
        const oldVault = vault(); oldVault.engine!.lastVerifiedSnapshot = 'old-held-snapshot'
        old.resolve(reported(oldVault)); await tick(); await tick()
        expect(published).toHaveLength(0)
        expect(statusCalls).toBe(2)
        fresh.resolve(reported())
        const result = await outcome
        expect(result.error).toBeNull()
        const input = result.input!
        expect(input.view).toEqual(next)
        expect(input.observation).toBe(name === 'check' ? 1 : 2)
        expect(session.complete(operation, input)).toBe(true)
        expect(input.backup?.remoteRevision).toBe('snapshot-original')
        expect(input.backup?.revision).toBeNull()
        expect(input.check).toBeNull()
        expect(presentSync(input, Date.now()).tone).not.toBe('green')
        expect(syncCalls).toBe(name === 'syncNow' ? 1 : 0)
        sub.updateView({ ...next }); await tick()
        expect(statusCalls).toBe(2)
        const later = await adapter.actions.check!(next)
        expect(later.observation).toBe(input.observation + 1)
        expect(session.publish(input)).toBe(false)
        expect(session.publish(later)).toBe(true)
      } finally { old.resolve(reported()); fresh.resolve(reported()); sub.unsubscribe(); await outcome }
    })

    test(`${name} rejects older, foreign, replaced and disposed scopes without IPC`, async () => {
      let statusCalls = 0; let syncCalls = 0
      const adapter = createHelperSyncAdapter({ status: async () => { statusCalls++; return reported() }, syncNow: async () => { syncCalls++; return verifiedCycle() } })
      const sub = adapter.subscribe(view, () => {}); await tick()
      try {
        const invalid = [{ ...view, revision: view.revision - 1 }, { ...view, epoch: view.epoch + 1 }, { ...view, vaultId: '/other' },
          ...[NaN, Infinity, -1, 3.5, Number.MAX_SAFE_INTEGER + 1, '4', null, undefined].map(revision => ({ ...view, revision }) as SyncView)]
        for (const next of invalid) await expect(adapter.actions[name]!(next)).rejects.toThrow('view')
        expect(statusCalls).toBe(1); expect(syncCalls).toBe(0)
        sub.unsubscribe()
        await expect(adapter.actions[name]!({ ...view, revision: 4 })).rejects.toThrow('view')
        const replacement = adapter.subscribe({ ...view, epoch: view.epoch + 1 }, () => {})
        await tick()
        await expect(adapter.actions[name]!({ ...view, revision: 4 })).rejects.toThrow('view')
        replacement.unsubscribe()
        expect(statusCalls).toBe(2); expect(syncCalls).toBe(0)
      } finally { sub.unsubscribe() }
    })

    test(`${name} detaches its new action view before asynchronous IPC`, async () => {
      const held = deferred<BackupHelperStatusAnswer>(); const cycle = deferred<BackupHelperSyncAnswer>()
      let calls = 0
      const adapter = createHelperSyncAdapter({ status: () => ++calls === 1 ? Promise.resolve(reported()) : held.promise, syncNow: () => cycle.promise })
      const sub = adapter.subscribe(view, () => {}); await tick()
      const next = { ...view, revision: 4 }; const expected = { ...next }
      const result = adapter.actions[name]!(next).then(input => ({ input, error: null }), error => ({ input: null, error }))
      next.revision = 99; next.epoch = 99; next.vaultId = '/mutated'
      cycle.resolve(verifiedCycle()); held.resolve(reported())
      try {
        const outcome = await result
        expect(outcome.error).toBeNull(); expect(outcome.input?.view).toEqual(expected)
        sub.updateView(expected)
        const later = await adapter.actions.check!(expected)
        expect(later.observation).toBe(outcome.input!.observation + 1)
      } finally { sub.unsubscribe() }
    })
  }

  test('held old subscription answer cannot publish or replace facts after a newer non-cycle action', async () => {
    const held = deferred<BackupHelperStatusAnswer>(); let calls = 0
    const published: SyncInput[] = []
    const adapter = createHelperSyncAdapter({ status: () => ++calls === 1 ? held.promise : Promise.resolve({ state: 'stale', reason: 'window-root-changed' }),
      syncNow: async () => ({ state: 'disabled' }) })
    const sub = adapter.subscribe(view, value => published.push(value as SyncInput))
    const next = { ...view, revision: 4 }
    try {
      const result = await adapter.actions.syncNow!(next)
      expect(result.view).toEqual(next); expect(result.observation).toBe(1)
      expect(result.backup).toBeNull()
      held.resolve(reported()); await tick(); await tick()
      expect(published).toHaveLength(0)
      expect(adapter.coverageExplanation!()).not.toContain('Engine observation:')
      sub.updateView(next); sub.updateView(view)
      const checked = await adapter.actions.check!(next)
      expect(checked.observation).toBe(2); expect(checked.backup).toBeNull()
    } finally { held.resolve(reported()); sub.unsubscribe() }
  })
})
