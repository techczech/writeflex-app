// Backup-helper bridge (_TASK-LOG/2026-10-25-vault-sync-bridge.md): off by default, a window reaches only
// its own folder's registered vault, every reply is checked, stale answers are dropped, and no answer is
// a protection claim. A fake client covers the service; a fake helper on a real Unix socket covers the
// reviewed connectHelper path. No helper process is started.
import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelperClientError, PROTOCOL_VERSION, RESERVED_RECEIPT_METHODS } from '@app-patterns/vault-sync/helper'
import { BACKUP_HELPER_CHANNELS, BACKUP_HELPER_LIMITS, BACKUP_HELPER_PROTOCOL, BACKUP_HELPER_RESERVED_RECEIPT_METHODS } from '../../src/shared/backup-helper'
import { createHelperConnection, MAX_WAITING, type ConnectPort, type HelperClientPort, type HelperResponse } from '../../src/main/backup-helper/connection'
import { registerBackupHelperIpc } from '../../src/main/backup-helper/ipc'
import { checkCycleResult, checkStatusResult, ReplyCheckError } from '../../src/main/backup-helper/reply-check'
import { createBackupHelperService } from '../../src/main/backup-helper/service'
import { BACKUP_HELPER_TRIAL_DISABLED, resolveBackupHelperTrial, type BackupHelperTrial } from '../../src/main/backup-helper/trial-config'
import { createHelperReceiptAdapter } from '../../src/renderer/src/app/backup-helper-receipts'

const NOW = 1_800_000_000_000
const SNAP = 'a'.repeat(40)
const REF = 'refs/heads/backup/mac-1/co-1/2027-01-15'

const cycle = (over: Record<string, unknown> = {}) => ({
  vault: 'vault-a', reason: 'schedule', startedAt: NOW - 5_000, finishedAt: NOW - 4_000, outcome: 'verified',
  capture: { snapshot: SNAP, committed: true, startedAt: NOW - 5_000, changed: 1, pending: { count: 0, items: [], omitted: 0 }, skipped: 0 },
  push: { state: 'pushed' }, verify: { verified: true, snapshot: SNAP }, block: null, error: null, ...over,
})
const engine = (over: Record<string, unknown> = {}) => ({
  machineId: 'mac-1', checkoutId: 'co-1', protectionAgeSeconds: 0, oldestUnprotectedEdit: null,
  lastVerifiedSnapshot: SNAP, lastVerifiedAt: NOW - 4_000, protectedThrough: NOW - 5_000, latestSnapshot: SNAP, latestRef: REF,
  lastPushed: { snapshot: SNAP, ref: REF, seq: 3, coverage: NOW - 5_000 },
  pending: { count: 0, items: [], omitted: 0 }, unlistedFolders: { count: 0, items: [], omitted: 0 }, unflushedEditSince: null,
  writing: { count: 0, items: [], omitted: 0 }, lastError: null, recoveredFromDamagedRecord: false,
  repositoryHooksNotRun: { count: 0, items: [], omitted: 0 }, enabled: true, remote: 'origin', block: null, ...over,
})
const vaultView = (over: Record<string, unknown> = {}) => ({
  vault: 'vault-a', summary: 'no-known-unprotected-edits', uncertainty: ['edits-after-last-capture-unknown'],
  helper: { state: 'idle', cycleStartedAt: null, nextDueAt: NOW + 55_000, lastCycle: cycle() },
  fresh: true, engineObservedAt: NOW - 100, engine: engine(), statusError: null, ...over,
})
const statusResult = (vault: Record<string, unknown> = vaultView()) => ({
  helper: { protocol: 1, helperVersion: '0.1.0-spike', pid: 4242, startedAt: NOW - 60_000, stopping: false }, vaults: [vault],
})

type Call = { method: string; vault: string; timeoutMs: number }
/** A fake reviewed client: answers from `reply`, records calls and closes. */
function fakeHelper(reply: (call: Call) => Promise<HelperResponse> | HelperResponse) {
  const calls: Call[] = []
  let connects = 0
  let closes = 0
  let failConnect: unknown = null
  const connect: ConnectPort = async () => {
    connects++
    if (failConnect) throw failConnect
    let closed = false
    const client: HelperClientPort = {
      helperVersion: '0.1.0-spike',
      request: async (method, params, timeoutMs) => {
        if (closed) throw new HelperClientError('closed', 'the helper closed the connection')
        const call = { method, vault: params.vault, timeoutMs }
        calls.push(call)
        return reply(call)
      },
      close: () => { if (!closed) { closed = true; closes++ } },
    }
    return client
  }
  return {
    connect, calls,
    get connects() { return connects },
    get closes() { return closes },
    failNextConnects(error: unknown) { failConnect = error },
  }
}

const ok = (result: unknown): HelperResponse => ({ id: 1, ok: true, result })

async function trialFor(vaults: Array<{ root: string; vaultId: string }>, real: Record<string, string> = {}): Promise<BackupHelperTrial> {
  return resolveBackupHelperTrial({ enabled: true, socketPath: '/private/run/wf/helper.sock', client: 'writeflex-test', vaults }, async (p) => real[p] ?? p, async () => true)
}

function setup(reply: Parameters<typeof fakeHelper>[0], roots: Record<number, string | null> = { 1: '/link/a' }) {
  const helper = fakeHelper(reply)
  let clock = NOW
  const real: Record<string, string> = { '/link/a': '/real/a', '/link/b': '/real/b', '/real/a': '/real/a', '/real/b': '/real/b' }
  const make = async () => {
    const trial = await trialFor([{ root: '/real/a', vaultId: 'vault-a' }, { root: '/real/b', vaultId: 'vault-b' }])
    return createBackupHelperService({
      trial, windowRoot: (id) => roots[id] ?? null,
      resolveReal: async (p) => { if (!(p in real)) throw new Error('ENOENT'); return real[p]! },
      connect: helper.connect, now: () => clock,
    })
  }
  return { helper, roots, real, make, advance: (ms: number) => { clock += ms } }
}

describe('off by default', () => {
  test('the default service answers disabled and touches nothing', async () => {
    let looked = 0
    const service = createBackupHelperService({ windowRoot: () => { looked++; return '/real/a' } })
    expect(await service.status(1)).toEqual({ state: 'disabled' })
    expect(await service.syncNow(1)).toEqual({ state: 'disabled' })
    expect(looked).toBe(0)
    expect(BACKUP_HELPER_TRIAL_DISABLED.enabled).toBe(false)
  })

  test('the IPC channels take no arguments; any argument is refused before the service', async () => {
    const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>()
    const seen: number[] = []
    registerBackupHelperIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
      status: async (id) => { seen.push(id); return { state: 'disabled' } },
      syncNow: async (id) => { seen.push(id); return { state: 'disabled' } },
      disposeWindow: () => undefined, dispose: () => undefined,
    })
    expect([...handlers.keys()].sort()).toEqual([BACKUP_HELPER_CHANNELS.status, BACKUP_HELPER_CHANNELS.syncNow].sort())
    const event = { sender: { id: 7 } }
    for (const channel of handlers.keys()) {
      expect(await handlers.get(channel)!(event, { vault: 'vault-b' })).toEqual({ state: 'refused', reason: 'unexpected-arguments' })
      expect(await handlers.get(channel)!(event, '/real/b')).toEqual({ state: 'refused', reason: 'unexpected-arguments' })
    }
    expect(seen).toEqual([])
    expect(await handlers.get(BACKUP_HELPER_CHANNELS.status)!(event)).toEqual({ state: 'disabled' })
    expect(seen).toEqual([7])
  })

  test('an enabled configuration is checked and resolved by main', async () => {
    await expect(resolveBackupHelperTrial({ enabled: true, socketPath: 'relative.sock', client: 'x', vaults: [{ root: '/a', vaultId: 'v' }] })).rejects.toThrow()
    await expect(resolveBackupHelperTrial({ enabled: true, socketPath: '/r/../h.sock', client: 'x', vaults: [{ root: '/a', vaultId: 'v' }] })).rejects.toThrow()
    await expect(trialFor([{ root: '/a', vaultId: '../v' }])).rejects.toThrow()
    await expect(trialFor([{ root: '/a', vaultId: 'v' }, { root: '/b', vaultId: 'v' }])).rejects.toThrow()
    await expect(trialFor([{ root: '/l', vaultId: 'v' }, { root: '/a', vaultId: 'w' }], { '/l': '/a' })).rejects.toThrow()
    const trial = await trialFor([{ root: '/link/a', vaultId: 'vault-a' }], { '/link/a': '/real/a' })
    expect(trial.enabled && [...trial.vaults]).toEqual([['/real/a', 'vault-a']])
  })
})

describe('a window reaches only its own vault', () => {
  test('the window folder is resolved to its real path and mapped to its registered id', async () => {
    const s = setup(() => ok(statusResult()), { 1: '/link/a', 2: '/elsewhere', 3: null })
    const service = await s.make()
    const answer = await service.status(1)
    expect(answer.state).toBe('reported')
    expect(s.helper.calls).toEqual([{ method: 'status', vault: 'vault-a', timeoutMs: 5_000 }])
    expect(await service.status(2)).toEqual({ state: 'not-registered' })
    expect(await service.syncNow(3)).toEqual({ state: 'not-registered' })
    expect(s.helper.calls.map((c) => c.vault)).toEqual(['vault-a'])
  })

  test('a reply for another vault than the one asked is a bad reply', async () => {
    const s = setup(() => ok(statusResult(vaultView({ vault: 'vault-b', helper: { state: 'idle', cycleStartedAt: null, nextDueAt: null, lastCycle: null } }))))
    const service = await s.make()
    const answer = await service.status(1)
    expect(answer.state === 'unavailable' && answer.reason).toBe('bad-reply')
  })

  test('an answer for a window that moved to another folder or closed is dropped', async () => {
    let release: (() => void) | null = null
    const s = setup(() => new Promise((resolve) => { release = () => resolve(ok(statusResult())) }))
    const service = await s.make()
    const moved = service.status(1)
    await Bun.sleep(1)
    s.roots[1] = '/link/b'
    release!()
    expect(await moved).toEqual({ state: 'stale', reason: 'window-root-changed' })

    s.roots[1] = '/link/a'
    const closed = service.status(1)
    await Bun.sleep(1)
    service.disposeWindow(1)
    release!()
    expect(await closed).toEqual({ state: 'stale', reason: 'window-closed' })
  })
})

describe('replies are checked before they leave main', () => {
  const bad: Array<[string, unknown]> = [
    ['unknown top-level field', { ...statusResult(), extra: 1 }],
    ['unknown vault field', statusResult({ ...vaultView(), path: '/real/a' })],
    ['list longer than its count', statusResult(vaultView({ engine: engine({ pending: { count: 1, items: ['a.md', 'b.md'], omitted: 0 } }) }))],
    ['omitted disagrees', statusResult(vaultView({ engine: engine({ pending: { count: 5, items: ['a.md'], omitted: 3 } }) }))],
    ['absolute path', statusResult(vaultView({ engine: engine({ pending: { count: 1, items: ['/etc/passwd'], omitted: 0 } }) }))],
    ['traversal path', statusResult(vaultView({ engine: engine({ writing: { count: 1, items: ['a/../b.md'], omitted: 0 } }) }))],
    ['future timestamp', statusResult(vaultView({ engine: engine({ lastVerifiedAt: NOW + 3_600_000 }) }))],
    ['fractional count', statusResult(vaultView({ engine: engine({ pending: { count: 0.5, items: [], omitted: 0.5 } }) }))],
    ['verified without proof', statusResult(vaultView({ helper: { state: 'idle', cycleStartedAt: null, nextDueAt: null, lastCycle: cycle({ verify: { verified: true, snapshot: 'b'.repeat(40) } }) } }))],
    ['verified without push', statusResult(vaultView({ helper: { state: 'idle', cycleStartedAt: null, nextDueAt: null, lastCycle: cycle({ push: { state: 'rejected' } }) } }))],
    ['drops edits-after-last-capture-unknown', statusResult(vaultView({ uncertainty: ['pending-files'] }))],
    ['stale answer claiming a summary', statusResult(vaultView({ fresh: false }))],
    ['missing engine claiming a summary', statusResult(vaultView({ engine: null, uncertainty: ['status-unavailable'] }))],
    ['bad snapshot id', statusResult(vaultView({ engine: engine({ latestSnapshot: 'HEAD' }) }))],
    ['two vaults for one', { ...statusResult(), vaults: [vaultView(), vaultView()] }],
    ['not an object', [1, 2]],
  ]
  for (const [name, result] of bad) {
    test(`refused: ${name}`, () => {
      expect(() => checkStatusResult(result, 'vault-a', NOW)).toThrow(ReplyCheckError)
    })
  }

  test('a well-formed reply is copied field by field, without the process id', () => {
    const checked = checkStatusResult(statusResult(), 'vault-a', NOW)
    expect(checked.helper).toEqual({ protocol: 1, helperVersion: '0.1.0-spike', startedAt: NOW - 60_000, stopping: false })
    expect(JSON.stringify(checked)).not.toContain('4242')
    // Exact snapshot and ref values are kept as the helper sent them.
    expect(checked.vault.engine?.lastPushed).toEqual({ snapshot: SNAP, ref: REF, seq: 3, coverage: NOW - 5_000 })
    expect(checked.vault.helper.lastCycle?.verify).toEqual({ verified: true, snapshot: SNAP })
    // A cancelled cycle may carry partial state and is not refused.
    expect(checkCycleResult(cycle({ outcome: 'cancelled', verify: null, push: null }), 'vault-a', NOW).outcome).toBe('cancelled')
    expect(() => checkCycleResult(cycle(), 'vault-b', NOW)).toThrow(ReplyCheckError)
  })

  test('a malformed reply ends the connection without crashing, and the next request reconnects', async () => {
    let n = 0
    const s = setup(() => ok(n++ === 0 ? { garbage: true } : statusResult()))
    const service = await s.make()
    const first = await service.status(1)
    expect(first.state === 'unavailable' && first.reason).toBe('bad-reply')
    expect(s.helper.closes).toBe(1)
    expect((await service.status(1)).state).toBe('reported')
    expect(s.helper.connects).toBe(2)
  })
})

describe('no green from the helper', () => {
  test('every answer with helper state carries all limits and no protection claim', async () => {
    const s = setup(() => ok(statusResult()))
    const service = await s.make()
    const answer = await service.status(1)
    if (answer.state !== 'reported') throw new Error(answer.state)
    expect(answer.vault.summary).toBe('no-known-unprotected-edits')
    expect(answer.vault.helper.lastCycle?.outcome).toBe('verified')
    expect(answer.protectionClaim).toBe(false)
    expect(answer.limits).toEqual([...BACKUP_HELPER_LIMITS])
    expect(answer.limits).toContain('editor-edits-not-reported')
    expect(answer.limits).toContain('no-branch-comparison')
    expect(answer.vault.uncertainty).toContain('edits-after-last-capture-unknown')
  })

  test('the reserved receipt methods and protocol match the reviewed helper', () => {
    expect([...BACKUP_HELPER_RESERVED_RECEIPT_METHODS]).toEqual([...RESERVED_RECEIPT_METHODS])
    expect(BACKUP_HELPER_PROTOCOL).toBe(PROTOCOL_VERSION)
  })

  test('the renderer receipt adapter never treats a flushed save as coverage', () => {
    // Without main's receipt bridge the adapter is off: it reports nothing, sends no save metadata and
    // has no documents to prove, whatever the owner's receipts say.
    const adapter = createHelperReceiptAdapter()
    adapter.edited({ path: 'a.md', epoch: 1, gen: 1, at: NOW - 10_000 })
    adapter.saveStarted({ path: 'a.md', epoch: 1, gen: 1, at: NOW - 9_000 })
    adapter.saveCompleted({ path: 'a.md', epoch: 1, gen: 1, startedAt: NOW - 9_000, at: NOW - 8_000, outcome: 'flushed' })
    expect(adapter.mode).toBe('off')
    expect(adapter.captured()).toBeNull()
    expect(adapter.saveMeta('a.md', { docEpoch: 1, gen: 1 })).toBeUndefined()
  })
})

describe('connection: one at a time, bounded, reconnecting', () => {
  test('a timeout or close is unavailable, keeps the dated last answer as last known, and reconnects', async () => {
    let mode: 'ok' | 'timeout' = 'ok'
    const s = setup(() => {
      if (mode === 'timeout') throw new HelperClientError('timeout', 'the helper did not answer in time')
      return ok(statusResult())
    })
    const service = await s.make()
    const first = await service.status(1)
    if (first.state !== 'reported') throw new Error(first.state)
    s.advance(30_000)
    mode = 'timeout'
    const second = await service.status(1)
    if (second.state !== 'unavailable') throw new Error(second.state)
    expect(second.reason).toBe('disconnected')
    expect(second.observedAt).toBe(NOW + 30_000)
    // The old answer keeps its own time: it is not relabelled as current.
    expect(second.lastKnown?.observedAt).toBe(NOW)
    expect(second.lastKnown?.vault.engineObservedAt).toBe(NOW - 100)
    mode = 'ok'
    expect((await service.status(1)).state).toBe('reported')
    expect(s.helper.connects).toBe(2)
  })

  test('a failed connect backs off without touching the socket, then tries again', async () => {
    const s = setup(() => ok(statusResult()))
    const service = await s.make()
    s.helper.failNextConnects(Object.assign(new Error('no socket'), { code: 'ENOENT' }))
    const a = await service.status(1)
    expect(a.state === 'unavailable' && a.reason).toBe('not-running')
    const b = await service.status(1)
    expect(b.state === 'unavailable' && b.reason).toBe('backing-off')
    expect(s.helper.connects).toBe(1)
    s.helper.failNextConnects(new HelperClientError('protocol-mismatch', 'this helper speaks protocol 2'))
    s.advance(2_000)
    const c = await service.status(1)
    expect(c.state === 'unavailable' && c.reason).toBe('protocol-mismatch')
    s.helper.failNextConnects(null)
    s.advance(4_000)
    expect((await service.status(1)).state).toBe('reported')
    expect(s.helper.connects).toBe(3)
  })

  test('helper error answers keep the connection; unknown vault is named', async () => {
    const s = setup(() => ({ id: 1, ok: false, error: { code: 'unknown-vault', message: 'no registered vault has this id' } }))
    const service = await s.make()
    const a = await service.status(1)
    expect(a.state === 'unavailable' && a.reason).toBe('unknown-vault')
    expect(s.helper.closes).toBe(0)
  })

  test('more than MAX_WAITING requests are refused as busy without being sent', async () => {
    const releases: Array<() => void> = []
    const s = setup(() => new Promise((resolve) => { releases.push(() => resolve(ok(statusResult()))) }))
    const service = await s.make()
    const pending = Array.from({ length: MAX_WAITING + 2 }, () => service.status(1))
    await Bun.sleep(5)
    const answers: unknown[] = []
    for (let i = 0; i < MAX_WAITING + 2; i++) { releases.shift()?.(); await Bun.sleep(1) }
    for (const p of pending) answers.push(await p)
    const busy = answers.filter((a) => (a as { reason?: string }).reason === 'busy')
    expect(busy.length).toBe(2)
    expect(s.helper.calls.length).toBe(MAX_WAITING)
  })

  test('status during a Sync now answers sync-running; Sync now requests share one helper request', async () => {
    let releaseSync: (() => void) | null = null
    const s = setup((call) => {
      if (call.method === 'syncNow') return new Promise((resolve) => { releaseSync = () => resolve(ok(cycle({ reason: 'syncNow' }))) })
      return ok(statusResult())
    }, { 1: '/link/a', 2: '/real/a' })
    const service = await s.make()
    await service.status(1)
    const one = service.syncNow(1)
    const two = service.syncNow(2)
    await Bun.sleep(1)
    const during = await service.status(1)
    if (during.state !== 'sync-running') throw new Error(during.state)
    expect(during.lastKnown?.observedAt).toBe(NOW)
    expect(during.protectionClaim).toBe(false)
    releaseSync!()
    const [a, b] = await Promise.all([one, two])
    expect(a.state).toBe('cycle')
    expect(b.state).toBe('cycle')
    expect(s.helper.calls.filter((c) => c.method === 'syncNow')).toEqual([{ method: 'syncNow', vault: 'vault-a', timeoutMs: 360_000 }])
  })

  test('closing the last window closes the connection; a connect finishing after that is closed at once', async () => {
    let releaseConnect: (() => void) | null = null
    let closedLate = 0
    const connect: ConnectPort = () => new Promise((resolve) => {
      releaseConnect = () => resolve({ helperVersion: 'x', request: async () => ok(statusResult()), close: () => { closedLate++ } })
    })
    const trial = await trialFor([{ root: '/real/a', vaultId: 'vault-a' }])
    const service = createBackupHelperService({ trial, windowRoot: () => '/real/a', resolveReal: async (p) => p, connect, now: () => NOW })
    const answer = service.status(1)
    await Bun.sleep(1)
    service.disposeWindow(1)
    releaseConnect!()
    expect(await answer).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(closedLate).toBe(1)
    service.dispose()
    expect(await service.status(1)).toEqual({ state: 'stale', reason: 'window-closed' })
  })
})

/** A fake helper speaking protocol 1 on a real Unix socket in a private folder. Not the helper. */
async function fakeSocketHelper(answer: (request: Record<string, unknown>) => unknown, options: { protocol?: number } = {}) {
  const dir = await mkdtemp('/tmp/wfbh-')
  const socketPath = join(dir, 'helper.sock')
  // The fixture folder doubles as a synthetic Git worktree root for the trial's vault.
  await mkdir(join(dir, '.git'))
  await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  const sockets = new Set<Socket>()
  let closedSockets = 0
  const server: Server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => { sockets.delete(socket); closedSockets++ })
    let greeted = false
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        const message = JSON.parse(line) as Record<string, unknown>
        if (!greeted) {
          greeted = true
          const protocol = options.protocol ?? 1
          socket.write(`${JSON.stringify(protocol === message.protocol
            ? { type: 'hello', ok: true, protocol, helperVersion: '0.1.0-spike' }
            : { type: 'hello', ok: false, protocol, error: { code: 'protocol-mismatch', message: `this helper speaks protocol ${protocol}` } })}\n`)
          if (protocol !== message.protocol) socket.end()
          continue
        }
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result: answer(message) })}\n`)
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return {
    socketPath,
    root: dir,
    get openSockets() { return sockets.size },
    get closedSockets() { return closedSockets },
    async stop() {
      for (const s of sockets) s.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    },
  }
}

describe('reviewed client over a fake socket helper', () => {
  const realNow = () => Date.now()
  const liveStatus = () => {
    const t = Date.now()
    return {
      helper: { protocol: 1, helperVersion: '0.1.0-spike', pid: 1, startedAt: t - 1_000, stopping: false },
      vaults: [vaultView({ engineObservedAt: t, engine: engine({ lastVerifiedAt: t - 1_000, protectedThrough: t - 2_000, lastPushed: { snapshot: SNAP, ref: REF, seq: 1, coverage: t - 2_000 } }),
        helper: { state: 'idle', cycleStartedAt: null, nextDueAt: t + 60_000, lastCycle: cycle({ startedAt: t - 3_000, finishedAt: t - 1_000, capture: { snapshot: SNAP, committed: true, startedAt: t - 3_000, changed: 0, pending: { count: 0, items: [], omitted: 0 }, skipped: 0 } }) } })],
    }
  }

  test('hello, status and a single connection, closed when the window goes', async () => {
    const seen: Array<Record<string, unknown>> = []
    const fixture = await fakeSocketHelper((request) => { seen.push(request); return liveStatus() })
    try {
      const trial = await resolveBackupHelperTrial({ enabled: true, socketPath: fixture.socketPath, client: 'writeflex-test', vaults: [{ root: fixture.root, vaultId: 'vault-a' }] })
      const service = createBackupHelperService({ trial, windowRoot: () => fixture.root, now: realNow })
      const a = await service.status(1)
      const b = await service.status(1)
      expect(a.state).toBe('reported')
      expect(b.state).toBe('reported')
      expect(seen.map((r) => [r.method, r.vault])).toEqual([['status', 'vault-a'], ['status', 'vault-a']])
      expect(fixture.openSockets).toBe(1)
      service.disposeWindow(1)
      for (let i = 0; i < 50 && fixture.openSockets > 0; i++) await Bun.sleep(10)
      expect(fixture.openSockets).toBe(0)
      service.dispose()
    } finally {
      await fixture.stop()
    }
  })

  test('a malformed result over the socket is a bad reply and that socket is closed', async () => {
    const fixture = await fakeSocketHelper(() => ({ helper: {}, vaults: [] }))
    try {
      const trial = await resolveBackupHelperTrial({ enabled: true, socketPath: fixture.socketPath, client: 'writeflex-test', vaults: [{ root: fixture.root, vaultId: 'vault-a' }] })
      const service = createBackupHelperService({ trial, windowRoot: () => fixture.root, now: realNow })
      const a = await service.status(1)
      expect(a.state === 'unavailable' && a.reason).toBe('bad-reply')
      for (let i = 0; i < 50 && fixture.openSockets > 0; i++) await Bun.sleep(10)
      expect(fixture.openSockets).toBe(0)
      service.dispose()
    } finally {
      await fixture.stop()
    }
  })

  test('a helper of another protocol is refused', async () => {
    const fixture = await fakeSocketHelper(() => null, { protocol: 2 })
    try {
      const trial = await resolveBackupHelperTrial({ enabled: true, socketPath: fixture.socketPath, client: 'writeflex-test', vaults: [{ root: fixture.root, vaultId: 'vault-a' }] })
      const service = createBackupHelperService({ trial, windowRoot: () => fixture.root, now: realNow })
      const a = await service.status(1)
      expect(a.state === 'unavailable' && a.reason).toBe('protocol-mismatch')
      service.dispose()
    } finally {
      await fixture.stop()
    }
  })

  test('no socket at the configured place is not-running', async () => {
    const dir = await mkdtemp('/tmp/wfbh-')
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const fixture = { root: dir }
    try {
      const trial = await resolveBackupHelperTrial({ enabled: true, socketPath: join(dir, 'helper.sock'), client: 'writeflex-test', vaults: [{ root: fixture.root, vaultId: 'vault-a' }] })
      const service = createBackupHelperService({ trial, windowRoot: () => fixture.root, now: realNow })
      const a = await service.status(1)
      expect(a.state === 'unavailable' && a.reason).toBe('not-running')
      service.dispose()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the app embeds only the reviewed client', () => {
  // A1 (editor receipts): main also uses the reviewed receipts client (connectReceipts) beside the protocol-1
  // client. Values come only from the helper entry and only these names; everything else is `import type`.
  const ALLOWED_VALUES = new Set(['connectHelper', 'HelperClientError', 'connectReceipts', 'ReceiptsClientError'])
  // r3: the separate WriteFlex helper entry (src/backup-helper/, its own bundle and process; never imported by
  // main, preload or a renderer) uses only the package's host seam, and only these names.
  const HELPER_ENTRY = new Set(['src/backup-helper/projections.ts', 'src/backup-helper/writeflex-helper.ts'])
  const HOST_VALUES = new Set(['main', 'runCli', 'ordinaryScopeTest'])
  // Main's earlier-location confirmation reuses the helper's read-only scope test so it judges the same files the helper captures.
  // It may take that one pure function from the host seam and nothing else; it starts no helper.
  // The inserted-file scope test (ADR-0052 amendment, 3 Nov 2026) is a pure function both the helper and main call; it too takes
  // only ordinaryScopeTest from the host seam and starts nothing.
  const MAIN_HOST_USERS = new Map([
    ['src/main/backup-helper/earlier-locations.ts', new Set(['ordinaryScopeTest'])],
    ['src/backup-helper/inserted-scope.ts', new Set(['ordinaryScopeTest'])],
  ])
  test('only main backup-helper modules import the helper package, and only its clients', async () => {
    const { Glob } = await import('bun')
    const importers: string[] = []
    for await (const file of new Glob('src/**/*.{ts,tsx}').scan('.')) {
      const source = await Bun.file(file).text()
      const imports = [...source.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+['"](@app-patterns\/vault-sync[^'"]*)['"]/g)]
      expect(imports.length).toBe([...source.matchAll(/from\s+['"]@app-patterns\/vault-sync/g)].length)
      if (!imports.length) continue
      importers.push(file)
      if (file === 'src/backup-helper/github-credentials.ts') expect(imports.every(([, typeOnly]) => Boolean(typeOnly))).toBe(true)
      for (const [, typeOnly, names, from] of imports) {
        const values = names!.split(',').map((n) => n.trim()).filter((n) => n && !n.startsWith('type '))
        if (typeOnly) continue
        if (HELPER_ENTRY.has(file)) {
          expect(from).toBe('@app-patterns/vault-sync/helper/host')
          for (const name of values) expect(HOST_VALUES.has(name)).toBe(true)
          continue
        }
        const hostOnly = MAIN_HOST_USERS.get(file)
        if (hostOnly) {
          expect(from).toBe('@app-patterns/vault-sync/helper/host')
          for (const name of values) expect(hostOnly.has(name)).toBe(true)
          continue
        }
        expect(from).toBe('@app-patterns/vault-sync/helper')
        for (const name of values) expect(ALLOWED_VALUES.has(name)).toBe(true)
      }
      expect(source).not.toMatch(/startHelper|loadHelperConfig|createProcessRegistry|createBackupEngine|createGitleaksScanner/)
      // Nothing outside the helper entry imports the helper entry's modules.
      // The read-only history validator is the one helper-side module main may reuse (earlier-location confirmation); the entry modules stay out.
      if (!HELPER_ENTRY.has(file)) expect(source).not.toMatch(MAIN_HOST_USERS.has(file) ? /backup-helper\/(projections|writeflex-helper)['"]/ : /backup-helper\/(projections|writeflex-helper|history-projection)['"]/)
    }
    expect(importers.sort()).toEqual([
      'src/backup-helper/github-credentials.ts', 'src/backup-helper/inserted-scope.ts', 'src/backup-helper/projections.ts', 'src/backup-helper/writeflex-helper.ts',
      'src/main/backup-helper/connection.ts', 'src/main/backup-helper/earlier-locations.ts', 'src/main/backup-helper/outbox-store.ts', 'src/main/backup-helper/receipt-coverage.ts',
      'src/main/backup-helper/receipt-identity.ts', 'src/main/backup-helper/receipt-service.ts', 'src/main/backup-helper/receipt-stream.ts',
    ])
  })
})

// Repair r1 (review-writeflex-helper-bridge.md S1–S3 and the worktree-root gate): each test failed on the
// reviewed bytes and passes on the repair.
describe('repair r1: no work outlives the windows that asked for it', () => {
  /** An answer, or 'still waiting' if it has not come within a short while (a sent request held by the fake). */
  const within = <T,>(p: Promise<T>) => Promise.race([p, Bun.sleep(200).then(() => 'still waiting' as const)])
  /** Every helper call waits until the test releases it; closing a client ends its waiting calls, as the reviewed client does. */
  function holding() {
    const held: Array<{ call: Call; release: () => void }> = []
    const s = setup(() => ok(null), { 1: '/link/a', 2: '/link/b', 3: '/real/a', 4: '/real/b' })
    const calls: Call[] = []
    let connects = 0
    let closes = 0
    const connect: ConnectPort = async () => {
      connects++
      let closed = false
      const ending = new Set<(error: Error) => void>()
      return {
        helperVersion: '0.1.0-spike',
        request: (method, params, timeoutMs) => new Promise((resolve, reject) => {
          if (closed) return reject(new HelperClientError('closed', 'the helper closed the connection'))
          const call = { method, vault: params.vault, timeoutMs }
          calls.push(call)
          ending.add(reject)
          const result = method === 'syncNow' ? cycle({ vault: params.vault, reason: 'syncNow' })
            : statusResult(params.vault === 'vault-a' ? vaultView() : vaultView({ vault: params.vault, helper: { state: 'idle', cycleStartedAt: null, nextDueAt: null, lastCycle: null } }))
          held.push({ call, release: () => { ending.delete(reject); resolve(ok(result)) } })
        }),
        close: () => {
          if (closed) return
          closed = true
          closes++
          for (const end of ending) end(new HelperClientError('closed', 'the helper closed the connection'))
          ending.clear()
        },
      }
    }
    const make = async () => createBackupHelperService({
      trial: await trialFor([{ root: '/real/a', vaultId: 'vault-a' }, { root: '/real/b', vaultId: 'vault-b' }]),
      windowRoot: (id) => s.roots[id] ?? null, resolveReal: async (p) => { if (!(p in s.real)) throw new Error('ENOENT'); return s.real[p]! }, connect, now: () => NOW,
    })
    return { held, make, helper: { get connects() { return connects }, get closes() { return closes }, connect }, sent: () => calls.map((c) => `${c.method}:${c.vault}`) }
  }

  test('S1: a Sync now queued for vault B is not sent once every window has closed', async () => {
    const h = holding()
    const service = await h.make()
    const a = service.syncNow(1)
    const b = service.syncNow(2)
    await Bun.sleep(2)
    expect(h.sent()).toEqual(['syncNow:vault-a'])
    service.disposeWindow(1)
    service.disposeWindow(2)
    expect(await within(a)).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(await within(b)).toEqual({ state: 'stale', reason: 'window-closed' })
    await Bun.sleep(5)
    expect(h.sent()).toEqual(['syncNow:vault-a'])
    expect(h.helper.connects).toBe(1)
    expect(h.helper.closes).toBe(1)
    service.dispose()
  })

  test('S1: a coalesced Sync now keeps going for the surviving window of the same vault', async () => {
    const h = holding()
    const service = await h.make()
    const busy = service.status(2)
    await Bun.sleep(2)
    const one = service.syncNow(1)
    const three = service.syncNow(3)
    await Bun.sleep(2)
    service.disposeWindow(1)
    h.held.shift()!.release()
    expect(await within(busy)).toMatchObject({ state: 'reported' })
    for (let i = 0; i < 20 && h.held.length === 0; i++) await Bun.sleep(1)
    expect(h.sent()).toEqual(['status:vault-b', 'syncNow:vault-a'])
    h.held.shift()!.release()
    expect(await within(one)).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(await within(three)).toMatchObject({ state: 'cycle' })
    service.dispose()
  })

  test('S1: a shared Sync now whose requesters all closed is withdrawn while other windows stay open', async () => {
    const h = holding()
    const service = await h.make()
    const busy = service.status(2)
    await Bun.sleep(2)
    const one = service.syncNow(1)
    const three = service.syncNow(3)
    await Bun.sleep(2)
    service.disposeWindow(1)
    service.disposeWindow(3)
    expect(await within(one)).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(await within(three)).toEqual({ state: 'stale', reason: 'window-closed' })
    // Window 2 is still open, so the connection stays; the withdrawn Sync now is never sent and no
    // longer makes status answer sync-running.
    h.held.shift()!.release()
    expect(await within(busy)).toMatchObject({ state: 'reported' })
    const after = service.status(4)
    for (let i = 0; i < 20 && h.held.length === 0; i++) await Bun.sleep(1)
    h.held.shift()?.release()
    expect(await within(after)).toMatchObject({ state: 'reported' })
    expect(h.sent()).toEqual(['status:vault-b', 'status:vault-b'])
    expect(h.helper.connects).toBe(1)
    service.dispose()
  })

  test('S1: a status queued for a closed window is not sent; a new window reconnects after all closed', async () => {
    const h = holding()
    const service = await h.make()
    const first = service.status(1)
    const second = service.status(2)
    await Bun.sleep(2)
    service.disposeWindow(1)
    service.disposeWindow(2)
    expect(await within(first)).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(await within(second)).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(h.sent()).toEqual(['status:vault-a'])
    const fresh = service.status(3)
    for (let i = 0; i < 20 && h.held.length < 2; i++) await Bun.sleep(1)
    h.held[1]!.release()
    expect(await within(fresh)).toMatchObject({ state: 'reported' })
    expect(h.helper.connects).toBe(2)
    expect(h.sent()).toEqual(['status:vault-a', 'status:vault-a'])
    service.dispose()
  })

  test('S1: close() withdraws unsent requests of that connection; a later request opens a new one', async () => {
    const h = holding()
    const connection = createHelperConnection({ socketPath: '/private/run/wf/helper.sock', client: 'x', connectTimeoutMs: 1_000, connect: h.helper.connect, now: () => NOW })
    const check = (r: unknown) => r
    const inFlight = connection.request('syncNow', 'vault-a', 1_000, check)
    const queued = connection.request('syncNow', 'vault-b', 1_000, check)
    await Bun.sleep(2)
    connection.close()
    expect(await within(inFlight)).toMatchObject({ ok: false })
    expect(await within(queued)).toEqual({ ok: false, reason: 'cancelled', message: 'The request was withdrawn.' })
    expect(connection.connected).toBe(false)
    expect(h.sent()).toEqual(['syncNow:vault-a'])
    const later = connection.request('status', 'vault-a', 1_000, check)
    for (let i = 0; i < 20 && h.held.length < 2; i++) await Bun.sleep(1)
    h.held[1]!.release()
    expect(await within(later)).toMatchObject({ ok: true })
    expect(h.helper.connects).toBe(2)
    connection.dispose()
  })
})

describe('repair r1: facts are released only for the same canonical folder', () => {
  test('S2: a root whose spelling is unchanged but now resolves elsewhere is refused', async () => {
    let release: (() => void) | null = null
    const s = setup(() => new Promise((resolve) => { release = () => resolve(ok(statusResult())) }))
    const service = await s.make()
    const pending = service.status(1)
    await Bun.sleep(2)
    s.real['/link/a'] = '/real/b'
    release!()
    expect(await pending).toEqual({ state: 'stale', reason: 'window-root-changed' })
  })

  test('S2: an unverifiable root after the answer is refused, and so is a Sync now cycle', async () => {
    let release: (() => void) | null = null
    const s = setup((call) => new Promise((resolve) => { release = () => resolve(ok(call.method === 'syncNow' ? cycle({ reason: 'syncNow' }) : statusResult())) }))
    const service = await s.make()
    const pending = service.status(1)
    await Bun.sleep(2)
    delete s.real['/link/a']
    release!()
    expect(await pending).toEqual({ state: 'stale', reason: 'window-root-changed' })
    s.real['/link/a'] = '/real/a'
    const sync = service.syncNow(1)
    await Bun.sleep(2)
    s.real['/link/a'] = '/real/b'
    release!()
    expect(await sync).toEqual({ state: 'stale', reason: 'window-root-changed' })
  })

  test('S2: a window closing during the re-check gets nothing', async () => {
    let release: (() => void) | null = null
    const helper = fakeHelper(() => new Promise((resolve) => { release = () => resolve(ok(statusResult())) }))
    const trial = await trialFor([{ root: '/real/a', vaultId: 'vault-a' }])
    let calls = 0
    let service: ReturnType<typeof createBackupHelperService> | null = null
    service = createBackupHelperService({
      trial, windowRoot: () => '/real/a', connect: helper.connect, now: () => NOW,
      resolveReal: async (p) => { if (++calls === 2) service!.disposeWindow(1); return p },
    })
    const pending = service.status(1)
    await Bun.sleep(2)
    release!()
    expect(await pending).toEqual({ state: 'stale', reason: 'window-closed' })
    expect(calls).toBe(2)
  })
})

describe('repair r1: refs and protocol are checked strictly', () => {
  const withRef = (ref: string) => statusResult(vaultView({ engine: engine({ latestRef: ref, lastPushed: { snapshot: SNAP, ref, seq: 3, coverage: NOW - 5_000 } }) }))
  const withLatest = (ref: string) => statusResult(vaultView({ engine: engine({ latestRef: ref }) }))
  const withPushed = (ref: string) => statusResult(vaultView({ engine: engine({ lastPushed: { snapshot: SNAP, ref, seq: 3, coverage: NOW - 5_000 } }) }))
  const badRefs = ['refs/heads/backup/../other', 'refs//heads/a', 'refs/heads/a.lock', 'refs/heads/a.', 'refs/heads/a/', 'refs/heads/.hidden', 'refs/heads/a..b',
    'refs/heads/a.lock/b', 'refs/', 'refs/heads/a/./b', 'refs/heads/a/.', 'heads/main', 'refs/heads/a b', 'refs/heads/a~1', 'refs/heads/a@{1}', 'refs/heads/' + 'x'.repeat(260)]
  for (const ref of badRefs) {
    test(`S3 refused ref: ${ref.slice(0, 40)}`, () => {
      expect(() => checkStatusResult(withLatest(ref), 'vault-a', NOW)).toThrow(ReplyCheckError)
      expect(() => checkStatusResult(withPushed(ref), 'vault-a', NOW)).toThrow(ReplyCheckError)
    })
  }

  test('S3: legal refs are kept exactly', () => {
    for (const ref of [REF, 'refs/heads/backup/mac.1/co_1/2027-01-15', 'refs/heads/backup/A-1/b.2/2026-12-31', 'refs/heads/main', 'refs/heads/feature.x/y-z']) {
      const checked = checkStatusResult(withRef(ref), 'vault-a', NOW)
      expect(checked.vault.engine?.latestRef).toBe(ref)
      expect(checked.vault.engine?.lastPushed?.ref).toBe(ref)
    }
  })

  test('S3: a status naming another protocol than 1 is refused', () => {
    for (const protocol of [0, 2, 1.5, -1]) {
      const result = statusResult()
      expect(() => checkStatusResult({ ...result, helper: { ...result.helper, protocol } }, 'vault-a', NOW)).toThrow(ReplyCheckError)
    }
    expect(checkStatusResult(statusResult(), 'vault-a', NOW).helper.protocol).toBe(1)
  })
})

describe('repair r1: only a Git worktree root can be registered', () => {
  async function scratch() {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'wfbh-root-')))
    return { base, done: () => rm(base, { recursive: true, force: true }) }
  }
  const config = (root: string) => ({ enabled: true as const, socketPath: '/private/run/wf/helper.sock', client: 'writeflex-test', vaults: [{ root, vaultId: 'vault-a' }] })

  test('a folder holding its own .git directory is accepted', async () => {
    const { base, done } = await scratch()
    try {
      await mkdir(join(base, 'repo', '.git'), { recursive: true })
      await writeFile(join(base, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
      const trial = await resolveBackupHelperTrial(config(join(base, 'repo')))
      expect(trial.enabled && [...trial.vaults]).toEqual([[join(base, 'repo'), 'vault-a']])
    } finally { await done() }
  })

  test('a linked worktree (.git file naming its git folder) is accepted', async () => {
    const { base, done } = await scratch()
    try {
      const gitdir = join(base, 'main', '.git', 'worktrees', 'wt')
      await mkdir(gitdir, { recursive: true })
      await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/wt\n')
      await mkdir(join(base, 'wt'))
      await writeFile(join(base, 'wt', '.git'), `gitdir: ${gitdir}\n`)
      expect((await resolveBackupHelperTrial(config(join(base, 'wt')))).enabled).toBe(true)
      // A relative gitdir is read relative to the worktree, as Git does.
      await mkdir(join(base, 'rel'))
      await writeFile(join(base, 'rel', '.git'), 'gitdir: ../main/.git/worktrees/wt\n')
      expect((await resolveBackupHelperTrial(config(join(base, 'rel')))).enabled).toBe(true)
    } finally { await done() }
  })

  test('a subfolder of a worktree, a plain folder and malformed markers are refused', async () => {
    const { base, done } = await scratch()
    try {
      await mkdir(join(base, 'repo', '.git'), { recursive: true })
      await writeFile(join(base, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
      await mkdir(join(base, 'repo', 'writing'))
      await expect(resolveBackupHelperTrial(config(join(base, 'repo', 'writing')))).rejects.toThrow(/Git worktree root/)
      await mkdir(join(base, 'plain'))
      await expect(resolveBackupHelperTrial(config(join(base, 'plain')))).rejects.toThrow(/Git worktree root/)
      await mkdir(join(base, 'nohead', '.git'), { recursive: true })
      await expect(resolveBackupHelperTrial(config(join(base, 'nohead')))).rejects.toThrow(/Git worktree root/)
      await mkdir(join(base, 'garbage'))
      await writeFile(join(base, 'garbage', '.git'), 'not a gitdir line\n')
      await expect(resolveBackupHelperTrial(config(join(base, 'garbage')))).rejects.toThrow(/Git worktree root/)
      await mkdir(join(base, 'dangling'))
      await writeFile(join(base, 'dangling', '.git'), `gitdir: ${join(base, 'missing')}\n`)
      await expect(resolveBackupHelperTrial(config(join(base, 'dangling')))).rejects.toThrow(/Git worktree root/)
      await mkdir(join(base, 'linked'))
      await symlink(join(base, 'repo', '.git'), join(base, 'linked', '.git'))
      await expect(resolveBackupHelperTrial(config(join(base, 'linked')))).rejects.toThrow(/Git worktree root/)
    } finally { await done() }
  })
})
