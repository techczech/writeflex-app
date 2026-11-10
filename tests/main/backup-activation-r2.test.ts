import { shortSocketDir } from '../helpers/short-socket-dir'
// Backup activation repair r2 (review-writeflex-backup-activation-r1, R1-R5, R9, R10): what each repaired
// boundary must hold, asserted on the real enrolment, active services, supervisor, receipt adapter and, for
// the copy guard, the real Workspace exclusive create with an unsupported hard link. The helper process,
// its one-shot answers and the receipt instances are FAKES (labelled); no helper runs, no network, no
// credential.
import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { constants, copyFileSync, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActiveBackupServices, type ServicePair } from '../../src/main/backup-helper/active-services'
import { createBackupEnrolment, WRITEFLEX_SCOPE } from '../../src/main/backup-helper/enrolment'
import type { BackupReceiptService } from '../../src/main/backup-helper/receipt-service'
import type { BackupHelperService } from '../../src/main/backup-helper/service'
import { createHelperSupervisor, type SupervisorState } from '../../src/main/backup-helper/supervisor'
import type { BackupHelperTrial } from '../../src/main/backup-helper/trial-config'
import { setNonAtomicWritePolicy } from '../../src/main/save-receipt-gate'
import { atomicWriteSeams, Workspace } from '../../src/main/workspace'
import { createHelperReceiptAdapter } from '../../src/renderer/src/app/backup-helper-receipts'

const tick = () => new Promise((r) => setTimeout(r, 5))
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function vaultFixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wfr2-')))
  const socketBase = shortSocketDir()
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  cleanups.push(() => rm(socketBase, { recursive: true, force: true }))
  const mk = async (name: string) => {
    const vault = join(base, name)
    await mkdir(join(vault, '.git'), { recursive: true })
    await writeFile(join(vault, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    return vault
  }
  const a = await mk('a'); const b = await mk('b')
  const git = join(base, 'git'); const gitleaks = join(base, 'gitleaks'); const entry = join(base, 'bin.js')
  for (const f of [git, gitleaks, entry]) await writeFile(f, '')
  return { socketBase, base, a, b, git, gitleaks, entry }
}

/** FAKE receipt/control pair: an enabled instance refuses the copy route for its folders. */
function fakePair(trial: BackupHelperTrial, opts: { stream?: () => { settled(): Promise<void> } | null } = {}): ServicePair {
  const roots = trial.enabled ? new Set(trial.vaults.keys()) : new Set<string>()
  const receipts: BackupReceiptService = {
    lifetime: async () => ({ state: trial.enabled ? 'not-registered' : 'disabled' }) as never,
    reportEdit: async () => ({ state: 'disabled' }) as never,
    status: async () => ({ state: 'disabled' }) as never,
    beginSave: async () => null,
    nonAtomicPolicy: (root) => (roots.has(root) ? 'refuse' : 'copy'),
    retireSender: () => undefined,
    dispose: () => undefined,
    ready: Promise.resolve(),
    streamFor: async () => (trial.enabled && opts.stream ? opts.stream() as never : null),
  }
  const helper: BackupHelperService = { status: async () => ({ state: 'disabled' }) as never, syncNow: async () => ({ state: 'disabled' }) as never, disposeWindow: () => undefined, dispose: () => undefined }
  return { helper, receipts }
}

type Answer = Record<string, unknown>
/** FAKE supervisor: one-shot answers from `answer`; stop/start can be held by the test. */
function fakeSupervisor(answer: (command: string, config: any) => Answer) {
  const commands: Array<{ command: string; config: any; args: readonly string[] }> = []
  let state: SupervisorState = { state: 'stopped' }
  let stopGate: Promise<void> | null = null
  let startGate: Promise<void> | null = null
  let stopResult: SupervisorState | null = null
  const entered = { stop: 0, start: 0 }
  const supervisor = {
    start: async () => { entered.start += 1; if (startGate) await startGate; state = { state: 'running', since: 1, pid: 1 }; return state },
    stop: async () => { entered.stop += 1; if (stopGate) await stopGate; state = stopResult ?? { state: 'stopped' }; return state },
    stopNow: () => undefined,
    state: () => state,
    runOnce: async (args: readonly string[]) => {
      const config = JSON.parse(await readFile(args[args.indexOf('--config') + 1]!, 'utf8'))
      commands.push({ command: args[0]!, config, args })
      return { code: 0, stdout: JSON.stringify(answer(args[0]!, config)), stderr: '' }
    },
    onState: () => () => undefined,
  }
  return {
    supervisor, commands, entered,
    holdStop: () => { const d = deferred(); stopGate = d.promise; return () => { stopGate = null; d.resolve() } },
    holdStart: () => { const d = deferred(); startGate = d.promise; return () => { startGate = null; d.resolve() } },
    overdueStops: () => { stopResult = { state: 'stop-overdue', pid: 9 } },
  }
}

const previewOf = (config: any, over: Answer = {}): Answer => ({
  root: config.vaults[0].path, refused: null, tools: { git: { path: '/git', version: '2.50.1' }, gitleaks: { path: '/gitleaks', version: '8.30.1' } },
  remote: { kind: 'github', repository: 'owner/first' }, visibility: 'public', visibilityReason: null,
  scope: { include: config.vaults[0].include, exclude: config.vaults[0].exclude }, files: { count: 1, items: ['a.md'], omitted: 0 }, skipped: [], unreadable: [], enabled: false,
  publication: { branchPrefix: 'backup/m/', userCommitsSent: false, block: null }, destinationDigest: 'd0'.repeat(32), history: { name: 'writeflex-named-versions', state: 'complete', files: 0, bytes: 0, items: [], omitted: 0, summary: { namedVersions: 0 } }, ...over,
})

function enrolment(f: Awaited<ReturnType<typeof vaultFixture>>, sup: ReturnType<typeof fakeSupervisor>, opts: { window?: () => string | null; services?: ReturnType<typeof createActiveBackupServices> } = {}) {
  const services = opts.services ?? createActiveBackupServices({ make: (t) => fakePair(t), sleep: () => tick() })
  const e = createBackupEnrolment({
    dir: join(f.base, 'userData', 'backup-helper'), windowRoot: opts.window ?? (() => f.a), helperEntry: () => f.entry,
    gitCandidates: [f.git], gitleaksCandidates: [f.gitleaks], supervisor: sup.supervisor as never, services, shortRuntimeBase: join(f.socketBase, 'short'),
  })
  cleanups.push(() => services.dispose())
  return { e, services }
}
const ready = (p: any): { previewId: string } => { if (p.state !== 'ready') throw new Error(`preview not ready: ${JSON.stringify(p)}`); return p }

describe('R1 activation is bound to the shown preview and the window binding', () => {
  test('a repository change after the preview voids it: no enable runs and nothing is registered, until a fresh preview is shown', async () => {
    const f = await vaultFixture()
    let repository = 'owner/first'
    const sup = fakeSupervisor((c, cfg) => (c === 'preview' ? previewOf(cfg, { remote: { kind: 'github', repository } }) : { enabled: true }))
    const { e } = enrolment(f, sup)
    const shown = ready(await e.preview(1))
    repository = 'owner/second'
    const r = await e.enable(1, { previewId: shown.previewId, confirmPublic: true })
    expect(r.ok).toBe(false)
    expect(sup.commands.filter((c) => c.command === 'enable')).toHaveLength(0)
    expect(existsSync(join(f.base, 'userData', 'backup-helper', 'registrations.json'))).toBe(false)
    // Single use: the same id cannot be tried again, even now the repository is back.
    repository = 'owner/first'
    expect((await e.enable(1, { previewId: shown.previewId, confirmPublic: true })).ok).toBe(false)
    expect(sup.commands.filter((c) => c.command === 'enable')).toHaveLength(0)
    // A fresh preview showing the new repository can be used, and enable is run with exactly that repository.
    repository = 'owner/second'
    const again = ready(await e.preview(1))
    expect((again as any).remote).toEqual({ kind: 'github', repository: 'owner/second' })
    expect((await e.enable(1, { previewId: again.previewId, confirmPublic: true })).ok).toBe(true)
    const enabled = sup.commands.find((c) => c.command === 'enable')!
    expect(enabled.config.vaults[0].github).toEqual({ repository: 'owner/second' })
    expect(enabled.args).toContain('--confirm-public')
  })

  test('private turning public after the preview voids it (the shown answer did not ask for confirmation)', async () => {
    const f = await vaultFixture()
    let visibility = 'private'
    const sup = fakeSupervisor((c, cfg) => (c === 'preview' ? previewOf(cfg, { visibility }) : { enabled: true }))
    const { e } = enrolment(f, sup)
    const shown = ready(await e.preview(1))
    expect((shown as any).needsPublicConfirmation).toBe(false)
    visibility = 'public'
    expect((await e.enable(1, { previewId: shown.previewId, confirmPublic: true })).ok).toBe(false)
    expect(sup.commands.filter((c) => c.command === 'enable')).toHaveLength(0)
  })

  test('a root change while the enable re-check is awaited refuses before any enable, registration or apply', async () => {
    const f = await vaultFixture()
    let window = f.a
    let previews = 0
    const sup = fakeSupervisor((c, cfg) => {
      if (c === 'preview' && ++previews === 2) window = f.b // during enable's own helper re-check
      return c === 'preview' ? previewOf(cfg) : { enabled: true }
    })
    const { e, services } = enrolment(f, sup, { window: () => window })
    const shown = ready(await e.preview(1))
    const r = await e.enable(1, { previewId: shown.previewId, confirmPublic: true })
    expect(r.ok).toBe(false)
    expect(r.status).toEqual({ state: 'off', folder: f.b })
    expect(sup.commands.filter((c) => c.command === 'enable')).toHaveLength(0)
    expect(sup.entered.start).toBe(0)
    expect(services.trial.enabled).toBe(false)
  })

  test('a root change during the helper enable undoes the engine switch it made and registers nothing', async () => {
    const f = await vaultFixture()
    let window = f.a
    const sup = fakeSupervisor((c, cfg) => {
      if (c === 'enable') window = f.b
      return c === 'preview' ? previewOf(cfg) : c === 'enable' ? { enabled: true } : { disabled: true }
    })
    const { e } = enrolment(f, sup, { window: () => window })
    const shown = ready(await e.preview(1))
    expect((await e.enable(1, { previewId: shown.previewId, confirmPublic: true })).ok).toBe(false)
    expect(sup.commands.map((c) => c.command)).toEqual(['preview', 'preview', 'enable', 'disable'])
    expect(sup.commands[3]!.config.vaults[0].path).toBe(f.a)
    expect(existsSync(join(f.base, 'userData', 'backup-helper', 'registrations.json'))).toBe(false)
    expect(sup.entered.start).toBe(0)
  })

  test('a root change while the preview itself is awaited gives no usable preview', async () => {
    const f = await vaultFixture()
    let window = f.a
    const sup = fakeSupervisor((c, cfg) => { window = f.b; return previewOf(cfg) })
    const { e } = enrolment(f, sup, { window: () => window })
    expect(await e.preview(1)).toMatchObject({ state: 'refused' })
  })

  test('the same folder bound again (or the page replaced) voids the preview; another window cannot use it', async () => {
    const f = await vaultFixture()
    const sup = fakeSupervisor((c, cfg) => (c === 'preview' ? previewOf(cfg) : { enabled: true }))
    const { e } = enrolment(f, sup)
    const shown = ready(await e.preview(1))
    expect((await e.enable(2, { previewId: shown.previewId, confirmPublic: true })).ok).toBe(false)
    const again = ready(await e.preview(1))
    e.retireSender(1)
    expect((await e.enable(1, { previewId: again.previewId, confirmPublic: true })).ok).toBe(false)
    expect(sup.commands.filter((c) => c.command === 'enable')).toHaveLength(0)
  })

  test('an expired preview is refused', async () => {
    const f = await vaultFixture()
    let clock = 1_800_000_000_000
    const sup = fakeSupervisor((c, cfg) => (c === 'preview' ? previewOf(cfg) : { enabled: true }))
    const services = createActiveBackupServices({ make: (t) => fakePair(t), sleep: () => tick() })
    cleanups.push(() => services.dispose())
    const e = createBackupEnrolment({ dir: join(f.base, 'u'), windowRoot: () => f.a, helperEntry: () => f.entry, gitCandidates: [f.git], gitleaksCandidates: [f.gitleaks], supervisor: sup.supervisor as never, services, shortRuntimeBase: join(f.socketBase, 's'), now: () => clock })
    const shown = ready(await e.preview(1))
    clock += 10 * 60_000 + 1
    expect((await e.enable(1, { previewId: shown.previewId, confirmPublic: true })).ok).toBe(false)
  })
})

describe('R2 the copy guard holds through helper release, replacement start and service installation (REAL Workspace)', () => {
  test('unsupported hard link: no copy while the old stop is unresolved, while the new helper starts, after an overdue stop, or while receipts are paused', async () => {
    const f = await vaultFixture()
    const sup = fakeSupervisor((c, cfg) => (c === 'preview' ? previewOf(cfg, { visibility: 'private', remote: { kind: 'local', path: '/backup.git' } }) : c === 'enable' ? { enabled: true } : { disabled: true }))
    const { e, services } = enrolment(f, sup)
    setNonAtomicWritePolicy((root) => services.receipts.nonAtomicPolicy(root))
    let copies = 0
    atomicWriteSeams.link = () => { throw Object.assign(new Error('FAKE: this disk has no hard links'), { code: 'ENOTSUP' }) }
    atomicWriteSeams.copy = (from, to) => { copies++; copyFileSync(from, to, constants.COPYFILE_EXCL) }
    cleanups.push(() => { setNonAtomicWritePolicy(null); delete atomicWriteSeams.link; delete atomicWriteSeams.copy })
    const ws = new Workspace(f.a)
    const create = async (name: string): Promise<string> => { try { await ws.createFile(name, 'x\n'); return 'created' } catch (error) { return (error as Error).name } }

    // Off: the copy route is the ordinary one.
    expect(await create('off.md')).toBe('created')
    expect(copies).toBe(1)

    // Turning on with the new helper's start held: the folder is guarded before its helper starts.
    const releaseStart = sup.holdStart()
    const shown = ready(await e.preview(1))
    const enabling = e.enable(1, { previewId: shown.previewId, confirmPublic: false })
    for (let i = 0; i < 200 && sup.entered.start === 0; i++) await tick()
    expect(sup.entered.start).toBe(1)
    expect(await create('starting.md')).toBe('NonAtomicWriteRefused')
    releaseStart()
    expect((await enabling).ok).toBe(true)
    expect(await create('on.md')).toBe('NonAtomicWriteRefused')

    // Turning off with the old helper's stop held: receipts are already retired, the guard is not.
    const releaseStop = sup.holdStop()
    const disabling = e.disable(1)
    for (let i = 0; i < 200 && sup.entered.stop < 2; i++) await tick()
    expect(sup.entered.stop).toBe(2)
    expect(await create('stopping.md')).toBe('NonAtomicWriteRefused')
    releaseStop()
    expect((await disabling).ok).toBe(true)
    // The old helper has exited and nothing serves the folder: copies are allowed again.
    expect(await create('after.md')).toBe('created')
    expect(copies).toBe(2)

    // An overdue stop keeps the guard after the change has returned.
    const again = ready(await e.preview(1))
    expect((await e.enable(1, { previewId: again.previewId, confirmPublic: false })).ok).toBe(true)
    sup.overdueStops()
    await e.disable(1)
    expect(await create('overdue.md')).toBe('NonAtomicWriteRefused')
    expect(copies).toBe(2)
  })

  test('paused receipts keep the guard: a lane that is not running is not proof that no helper captures', async () => {
    const f = await vaultFixture()
    const sup = fakeSupervisor((c, cfg) => (c === 'preview' ? previewOf(cfg, { visibility: 'private', remote: { kind: 'local', path: '/backup.git' } }) : c === 'enable' ? { enabled: true } : { disabled: true }))
    const hanging = deferred()
    const services = createActiveBackupServices({ make: (t) => fakePair(t, { stream: () => ({ settled: () => hanging.promise }) }), settleLimitMs: 30, sleep: () => tick() })
    const { e } = enrolment(f, sup, { services })
    const shown = ready(await e.preview(1))
    expect((await e.enable(1, { previewId: shown.previewId, confirmPublic: false })).ok).toBe(true)
    await e.disable(1)
    expect(services.receipts.nonAtomicPolicy(f.a)).toBe('refuse')
    hanging.resolve()
  })
})

describe('R3 only actual settlement counts', () => {
  const trial = (root: string): BackupHelperTrial => ({ enabled: true, socketPath: '/tmp/x.sock', client: 'fixture', vaults: new Map([[root, 'v']]), connectTimeoutMs: 100, statusTimeoutMs: 100, syncTimeoutMs: 100 })
  const multi = (): BackupHelperTrial => ({ enabled: true, socketPath: '/tmp/x.sock', client: 'fixture', vaults: new Map([['/a', 'v1'], ['/b', 'v2']]), connectTimeoutMs: 100, statusTimeoutMs: 100, syncTimeoutMs: 100 })

  test('a timeout landing exactly on the deadline is not settlement', async () => {
    let now = 1000
    const original = Date.now
    Date.now = () => now
    try {
      let made = 0
      const hanging = deferred()
      const services = createActiveBackupServices({ make: (t) => { if (t.enabled) made++; return fakePair(t, { stream: () => ({ settled: () => hanging.promise }) }) }, settleLimitMs: 10, sleep: async (ms) => { now += ms } })
      await services.configure(trial('/a'))
      expect(await services.configure(trial('/b'))).toBe('receipts-paused')
      expect(made).toBe(1)
      hanging.resolve()
    } finally { Date.now = original }
  })

  test('every stream must settle: one settled and one not is paused; all settled (or ended with an error) is configured', async () => {
    let made = 0
    const hang = deferred()
    const paused = createActiveBackupServices({ make: (t) => { if (t.enabled) made++; let n = 0; return fakePair(t, { stream: () => ({ settled: () => (n++ === 0 ? Promise.resolve() : hang.promise) }) }) }, settleLimitMs: 30, sleep: () => tick() })
    await paused.configure(multi())
    expect(await paused.configure(trial('/c'))).toBe('receipts-paused')
    expect(made).toBe(1)
    hang.resolve()
    const ok = createActiveBackupServices({ make: (t) => fakePair(t, { stream: () => ({ settled: () => Promise.reject(new Error('pump ended')) }) }), settleLimitMs: 30, sleep: () => tick() })
    await ok.configure(multi())
    expect(await ok.configure(trial('/c'))).toBe('configured')
  })

  test('opening a stream is bounded too: a hung streamFor is paused, never waited for forever', async () => {
    const never = new Promise<never>(() => undefined)
    const services = createActiveBackupServices({ make: (t) => { const p = fakePair(t); if (t.enabled) p.receipts.streamFor = () => never; return p }, settleLimitMs: 30, sleep: () => tick() })
    await services.configure(trial('/a'))
    expect(await services.configure(trial('/b'))).toBe('receipts-paused')
  })

  test('while reconfiguring, windows are refused as reconfiguring (not disabled), so adapters keep their debt', async () => {
    const hang = deferred()
    const services = createActiveBackupServices({ make: (t) => fakePair(t, { stream: () => ({ settled: () => hang.promise }) }), settleLimitMs: 30, sleep: () => tick() })
    await services.configure(trial('/a'))
    expect(await services.configure(trial('/b'))).toBe('receipts-paused')
    expect(await services.receipts.lifetime({ id: 1, mainFrame: true }, ['/a'])).toEqual({ state: 'refused', reason: 'reconfiguring' })
    expect(await services.receipts.reportEdit({ id: 1, mainFrame: true }, [{}])).toEqual({ state: 'refused', reason: 'reconfiguring' })
    hang.resolve()
  })
})

describe('R4 same-root enrolment change keeps unsent edit debt (rebind, not a new adapter)', () => {
  const AT = 1_793_149_999_000
  function harness() {
    const pending = new Map<number, () => void>()
    let id = 0
    const reports: Array<{ path: string; gen: number; at?: number; lifetime: string }> = []
    let lifetimeAnswer: any = { state: 'bound', lifetime: 'token-1' }
    let editAnswer: (n: number) => any = () => ({ state: 'noted', owner: 'a'.repeat(32) })
    const api = {
      lifetime: async () => lifetimeAnswer,
      reportEdit: async (doc: any) => { reports.push(doc); return editAnswer(reports.length) },
      status: async () => ({ state: 'disabled' }),
    } as any
    const clock = { now: () => AT + 1000, elapsed: () => 1000, setTimeout: (fn: () => void) => { pending.set(++id, fn); return id }, clearTimeout: (n: unknown) => { pending.delete(n as number) } }
    const fire = async () => { for (const [n, fn] of [...pending]) { pending.delete(n); fn() } await tick() }
    const adapter = createHelperReceiptAdapter({ root: '/same-root', api, clock, owedSince: () => ({ at: AT, ageMs: 1000 }) })
    return { adapter, reports, pending, fire, setLifetime: (a: any) => { lifetimeAnswer = a }, setEdit: (fn: (n: number) => any) => { editAnswer = fn } }
  }

  test('an edit armed but not yet reported is reported once after the rebind, with its original time', async () => {
    const h = harness()
    h.adapter.activate(); await tick()
    h.adapter.edited({ path: 'draft.md', epoch: 1, gen: 1, at: AT })
    expect(h.pending.size).toBe(1)
    h.adapter.rebind(); await tick()
    await h.fire()
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toMatchObject({ path: 'draft.md', gen: 1, at: AT })
  })

  test('a held (conflict-refused) save with no more typing: the debt main had noted is reported again to the new owner', async () => {
    const h = harness()
    h.adapter.activate(); await tick()
    h.adapter.edited({ path: 'draft.md', epoch: 1, gen: 3, at: AT })
    await h.fire()
    expect(h.reports).toHaveLength(1)
    h.adapter.saveCompleted({ path: 'draft.md', epoch: 1, gen: 3, outcome: 'refused' } as never)
    h.adapter.rebind(); await tick()
    await h.fire()
    expect(h.reports).toHaveLength(2)
    expect(h.reports[1]).toMatchObject({ path: 'draft.md', gen: 3, at: AT })
    // A flushed document owes nothing and is not reported again.
    h.adapter.saveCompleted({ path: 'draft.md', epoch: 1, gen: 3, outcome: 'flushed' } as never)
    h.adapter.rebind(); await tick()
    await h.fire()
    expect(h.reports).toHaveLength(2)
  })

  test('refused as reconfiguring while main changes the enrolment: nothing is lost; the rebind after it reports', async () => {
    const h = harness()
    h.setLifetime({ state: 'refused', reason: 'reconfiguring' })
    h.adapter.activate(); await tick()
    h.adapter.edited({ path: 'draft.md', epoch: 1, gen: 1, at: AT })
    await h.fire()
    expect(h.reports).toHaveLength(0)
    expect(h.adapter.mode).not.toBe('off')
    h.setLifetime({ state: 'bound', lifetime: 'token-2' })
    h.adapter.rebind(); await tick()
    await h.fire()
    expect(h.reports).toHaveLength(1)
    expect(h.reports[0]).toMatchObject({ path: 'draft.md', at: AT, lifetime: 'token-2' })
  })

  test('a report unresolved across the rebind is reported again once it settles; the old answer is ignored', async () => {
    const h = harness()
    const gate = deferred<any>()
    h.setEdit((n) => (n === 1 ? gate.promise : { state: 'noted', owner: 'b'.repeat(32) }))
    h.adapter.activate(); await tick()
    h.adapter.edited({ path: 'draft.md', epoch: 1, gen: 1, at: AT })
    await h.fire()
    expect(h.reports).toHaveLength(1)
    h.adapter.rebind(); await tick()
    gate.resolve({ state: 'noted', owner: 'a'.repeat(32) })
    await tick()
    await h.fire()
    expect(h.reports).toHaveLength(2)
    expect(h.reports[1]).toMatchObject({ path: 'draft.md', at: AT })
  })

  test('the new instance saying not-registered turns the adapter off as before', async () => {
    const h = harness()
    h.adapter.activate(); await tick()
    h.adapter.edited({ path: 'draft.md', epoch: 1, gen: 1, at: AT })
    h.setLifetime({ state: 'not-registered' })
    h.adapter.rebind(); await tick()
    expect(h.adapter.mode).toBe('off')
  })
})

describe('R5 history files are never ordinary files; only the required projection sends them', () => {
  test('the ordinary scope names documents and the vault settings file only; the history journals and .bridle are excluded from it', () => {
    expect(WRITEFLEX_SCOPE.include).toEqual(['**/*.md', '**/*.markdown', '.writeflex/vault.json'])
    for (const never of ['.writeflex/versions.jsonl', '.writeflex/changes.jsonl', '.bridle']) expect(WRITEFLEX_SCOPE.exclude).toContain(never)
  })

  test('(r3) every helper configuration requires the named-version projection; Turn on is blocked unless the helper read it completely', async () => {
    const f = await vaultFixture()
    let history: unknown = { name: 'writeflex-named-versions', state: 'complete', files: 3, bytes: 120, items: [], omitted: 0, summary: { namedVersions: 2 } }
    const sup = fakeSupervisor((c, cfg) => previewOf(cfg, { visibility: 'private', history }))
    const services = createActiveBackupServices({ make: (t) => fakePair(t), sleep: () => tick() })
    cleanups.push(() => services.dispose())
    const e = createBackupEnrolment({ dir: join(f.base, 'u'), windowRoot: () => f.a, helperEntry: () => f.entry, gitCandidates: [f.git], gitleaksCandidates: [f.gitleaks], supervisor: sup.supervisor as never, services, shortRuntimeBase: join(f.socketBase, 's') })
    expect(await e.preview(1)).toMatchObject({ state: 'ready', blocker: null, history: { included: true, namedVersions: 2, files: 3, bytes: 120 } })
    expect(sup.commands[0]!.config.vaults[0]).toMatchObject({ include: WRITEFLEX_SCOPE.include, history: 'writeflex-named-versions' })
    history = { name: 'writeflex-named-versions', state: 'unavailable', reason: 'a named version\'s object is missing' }
    const unavailable = await e.preview(1)
    expect(unavailable).toMatchObject({ state: 'ready', history: { included: false, reason: "a named version's object is missing" } })
    expect((unavailable as { blocker: string }).blocker).toContain('Named versions cannot be backed up')
    // A helper that reports no projection (an older or generic helper) is never taken as documents-only.
    history = undefined
    expect(await e.preview(1)).toMatchObject({ history: { included: false }, blocker: expect.stringContaining('Named versions') })
    // A projection of another name is not this one.
    history = { name: 'other', state: 'complete', files: 0, bytes: 0, items: [], omitted: 0, summary: {} }
    expect(await e.preview(1)).toMatchObject({ history: { included: false } })
    // No enable ran for any of them.
    expect(sup.commands.filter((c) => c.command === 'enable')).toEqual([])
  })
})

/** FAKE helper child for the supervisor. */
class FakeChild extends EventEmitter {
  stderr = new PassThrough(); stdout = new PassThrough(); pid: number | undefined; signals: string[] = []
  constructor(pid: number | undefined) { super(); this.pid = pid }
  kill(signal: string) { this.signals.push(signal); return true }
  say(event: Record<string, unknown>) { this.stderr.write(`${JSON.stringify(event)}\n`) }
}

describe('R9 one idempotent completion of a child', () => {
  function sup(pid: number | undefined) {
    const children: FakeChild[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const s = createHelperSupervisor({ command: '/fixture/app', entry: '/fixture/bin.js', spawn: (() => { const c = new FakeChild(pid); children.push(c); return c }) as never, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => undefined })
    return { s, children, timers }
  }

  test('a spawn that never started (error, no pid, no exit) settles start and backs off, once', async () => {
    const f = sup(undefined)
    let settled: SupervisorState | null = null
    void f.s.start('/cfg', '/run').then((x) => { settled = x })
    f.children[0]!.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    f.children[0]!.emit('close', -2, null)
    await tick()
    expect(settled).toMatchObject({ state: 'restarting', lastError: 'spawn ENOENT' })
    expect(f.timers).toHaveLength(1)
  })

  test('error then close (the reviewer\'s sequence) settles start too', async () => {
    const f = sup(123)
    let settled = false
    void f.s.start('/cfg', '/run').then(() => { settled = true })
    f.children[0]!.emit('error', new Error('spawn EACCES'))
    f.children[0]!.emit('close', -13, null)
    await tick()
    expect(settled).toBe(true)
    expect(f.timers).toHaveLength(1)
  })

  test('an error from a running child is not taken as its exit; exit then close restarts once', async () => {
    const f = sup(321)
    const answer = f.s.start('/cfg', '/run')
    f.children[0]!.say({ type: 'started' })
    expect((await answer).state).toBe('running')
    f.children[0]!.emit('error', new Error('kill EPERM'))
    await tick()
    expect(f.s.state().state).toBe('running')
    expect(f.timers).toHaveLength(0)
    f.children[0]!.emit('exit', 1, null)
    f.children[0]!.emit('close', 1, null)
    await tick()
    expect(f.timers).toHaveLength(1)
    expect(f.children).toHaveLength(1)
  })

  test('runOnce settles when a spawn never started', async () => {
    const f = sup(undefined)
    const run = f.s.runOnce(['preview'])
    f.children[0]!.emit('error', new Error('spawn ENOENT'))
    expect(await run).toMatchObject({ code: null, stderr: 'spawn ENOENT' })
  })
})

describe('R10 only a proven runtime-bound completion restarts at once', () => {
  function sup(clock: { now: number }) {
    const children: FakeChild[] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const s = createHelperSupervisor({ command: '/fixture/app', entry: '/fixture/bin.js', now: () => clock.now, spawn: (() => { const c = new FakeChild(500 + children.length); children.push(c); return c }) as never, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearTimer: () => undefined })
    return { s, children, timers }
  }

  test('twenty short clean exits launch no more than the bounded retries, each after a backoff timer', async () => {
    const clock = { now: 1000 }
    const f = sup(clock)
    const first = f.s.start('/cfg', '/run')
    for (let i = 0; i < 20; i++) {
      const c = f.children.at(-1)!
      c.say({ type: 'started' }); await tick()
      c.emit('exit', 0, null); c.emit('close', 0, null)
      const t = f.timers.shift()
      if (t) t.fn()
    }
    await first
    expect(f.children.length).toBeLessThanOrEqual(5)
    expect(f.s.state().state).toBe('failed')
  })

  test('max-runtime reported but far too early, or a clean exit after a signal, counts as a failure', async () => {
    const clock = { now: 1000 }
    const f = sup(clock)
    const first = f.s.start('/cfg', '/run')
    f.children[0]!.say({ type: 'started' }); await first
    clock.now += 60_000
    f.children[0]!.say({ type: 'stopping', reason: 'max-runtime' }); await tick()
    f.children[0]!.emit('exit', 0, null)
    expect(f.children).toHaveLength(1)
    expect(f.timers).toHaveLength(1)
    f.timers.shift()!.fn()
    f.children[1]!.say({ type: 'started' }); await tick()
    clock.now += 6 * 3600_000
    f.children[1]!.say({ type: 'stopping', reason: 'signal' }); await tick()
    f.children[1]!.emit('exit', 0, null)
    expect(f.children).toHaveLength(2)
    expect(f.timers).toHaveLength(1)
  })

  test('started, max-runtime at the bound and exit 0: the next helper starts at once, after the exit', async () => {
    const clock = { now: 1000 }
    const f = sup(clock)
    const first = f.s.start('/cfg', '/run')
    f.children[0]!.say({ type: 'started' }); await first
    clock.now += 6 * 3600_000 - 1000
    f.children[0]!.say({ type: 'stopping', reason: 'max-runtime' }); await tick()
    expect(f.children).toHaveLength(1)
    f.children[0]!.emit('exit', 0, null)
    expect(f.children).toHaveLength(2)
    expect(f.timers).toHaveLength(0)
  })
})
