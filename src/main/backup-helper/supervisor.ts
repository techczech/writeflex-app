/**
 * The backup helper as a child of this app, for as long as the app runs. Nothing here installs, registers
 * or schedules anything: no launch agent, login item or background service. The helper is the reviewed
 * command line of @app-patterns/vault-sync (`bin.js run`), started as its own process with this app's
 * binary in Node mode (ELECTRON_RUN_AS_NODE=1, as the `writeflex` command-line shim does); its engine and
 * server are never loaded into this process.
 *
 * - One child at a time. Credential-bearing children also retain ownership until `close`, so two helpers of
 *   this app never overlap; the helper's own runtime-folder and per-vault claims also refuse a second
 *   helper of any app (a refused start exits 2 and is retried with backoff).
 * - Bounded life: the command line requires a runtime bound, at most six hours (`--max-runtime-ms`). When
 *   the helper reaches it, it stops cleanly (exit 0) and is started again at once. Only that is a
 *   completed run: the helper reported `started`, then `stopping` with reason `max-runtime`, it exited 0
 *   without a signal, and at least the bound (less RUNTIME_SLACK_MS) passed since it started. Between the
 *   exit and the next `started` event nobody serves the socket: receipts and status report the helper as
 *   offline for that moment, and nothing claims protection.
 * - Failures: any other ending (a clean exit before the bound or for another reason included) is retried
 *   after 5 s, 30 s, 2 min and 5 min; after five in a row that did not reach `started` or ended within ten
 *   minutes the supervisor stops trying and reports `failed` with the helper's last message, until `start`
 *   is called again (a change of enrolment, or a restart).
 * - A child's ending is settled once (`complete`), by whichever comes first of `exit`, `close`, or an
 *   `error` from a child that never started (no pid: the spawn itself failed, and `exit` may never come).
 *   An `error` from a running child is recorded only: it does not show the process has gone, so its
 *   claims are not treated as released.
 * - Stopping signals only the child this supervisor spawned, through its own handle (never a pid looked up
 *   elsewhere, never another app's helper), once with SIGTERM; the command line then lets a running cycle
 *   finish (grace 20 s), cancels it, contains its own processes and exits. `stop()` waits for the exit up to
 *   STOP_WAIT_MS and reports `stop-overdue` if it has not come; it never sends SIGKILL to a helper that may
 *   still hold Git locks.
 * - App close: `will-quit` asks the child to stop and does not wait; the child finishes its stop on its
 *   own within its bound and exits. Backup does not continue after WriteFlex closes.
 * - The child's environment is fixed here: no PATH from a shell (the helper runs only the programs its
 *   configuration names), no GIT_* or askpass variables, no credentials.
 * Events on the child's stderr are JSON lines; only their types, times and the helper's own short messages
 * are kept (a line is at most 64 KiB; a longer one is dropped).
 */
import { HISTORY_APPROVAL_ENV } from '../../backup-helper/history-approvals'
import type { CompletionTarget } from '../../backup-helper/github-auth-receipts'
import { prepareChildCredentials, prepareConfiguredCredentials, sendChildCredentials, type ChildCredentialInput } from './github-credentials'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

export const HELPER_MAX_RUNTIME_MS = 6 * 60 * 60_000
export const HELPER_GRACE_MS = 20_000
export const HELPER_HARD_STOP_MS = 15_000
export const STOP_WAIT_MS = HELPER_GRACE_MS + HELPER_HARD_STOP_MS + 10_000
const BACKOFF_MS = [5_000, 30_000, 120_000, 300_000]
const MAX_FAILED_STARTS = 5
const HEALTHY_RUN_MS = 10 * 60_000
/** Tolerance between the helper's own runtime timer and this process's clock. */
export const RUNTIME_SLACK_MS = 60_000
const MAX_LINE = 64 * 1024

export type SupervisorState =
  | { state: 'stopped' }
  | { state: 'starting'; since: number }
  | { state: 'running'; since: number; pid: number }
  | { state: 'restarting'; at: number; lastError: string | null }
  | { state: 'failed'; lastError: string | null }
  | { state: 'stop-overdue'; pid: number }

export type HelperLaunch = {
  /** The app binary run in Node mode. */
  command: string
  /** Absolute path of the helper's `bin.js`. */
  entry: string
  /** The environment base: HOME, USER, LOGNAME, TMPDIR are copied from it; nothing else. */
  baseEnv?: NodeJS.ProcessEnv
  /** Fixed app-owned private approval path; never taken from baseEnv or vault config. */
  historyApprovalFile?: string
}

export type SpawnPort = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export type HelperSupervisor = {
  /**
   * Starts the helper for this configuration and runtime folder; resolves once it has started or failed
   * to. `admit` is asked synchronously immediately before the child is spawned, after the old helper's
   * stop: false starts nothing, records nothing to retry and resolves with the state as it is (`stopped`).
   */
  start(configFile: string, runtimeDir: string, admit?: () => boolean): Promise<SupervisorState>
  /** Stops the owned helper; resolves when it has exited or STOP_WAIT_MS passed. */
  stop(): Promise<SupervisorState>
  /** SIGTERM to the owned helper, without waiting (app quit). */
  stopNow(): void
  state(): SupervisorState
  /** One `preview`/`enable`/`disable` command as its own short process, bounded (SIGTERM at the bound). */
  runOnce(args: readonly string[], timeoutMs?: number): Promise<{ code: number | null; stdout: string; stderr: string }>
  onState(listener: (state: SupervisorState) => void): () => void
}

export type SupervisorOptions = HelperLaunch & {
  /** Auth supplies only accepted bindings in the child configuration. Called afresh for every launch. */
  credentials?: (args: readonly string[]) => ChildCredentialInput | null | Promise<ChildCredentialInput | null>
  exposure?: { reserve(input: ChildCredentialInput): CompletionTarget; persist(target: CompletionTarget): Promise<void>; validate?(input: ChildCredentialInput): Promise<boolean>; admitted(input: ChildCredentialInput): boolean; closed(target: CompletionTarget): void }
  spawn?: SpawnPort
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  maxRuntimeMs?: number
  stopWaitMs?: number
}

/** The child's whole environment. */
export function helperEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR']) {
    const value = base[key]
    if (typeof value === 'string' && value !== '' && !value.includes('\0')) env[key] = value
  }
  return env
}

const describe = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 300)

export type OwnedHelperChild = { pid: number | null; kind: 'run' | 'once'; generation: number | null; status: 'live' | 'exit-unconfirmed' }
export type ManagedHelperSupervisor = HelperSupervisor & {
  /** Live children remain accounted until close; an overdue child prevents a confirmed drain. */
  ownedChildren(): readonly OwnedHelperChild[]
  resumeAdmission(): boolean
  acknowledgeExposure(exposure: string): boolean
  drain(): Promise<{ confirmed: boolean; remaining: readonly OwnedHelperChild[] }>
}
export function createHelperSupervisor(options: SupervisorOptions): ManagedHelperSupervisor {
  const spawn = options.spawn ?? (nodeSpawn as SpawnPort)
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const maxRuntimeMs = options.maxRuntimeMs ?? HELPER_MAX_RUNTIME_MS
  const stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS
  const env = helperEnv(options.baseEnv)
  if (options.historyApprovalFile) env[HISTORY_APPROVAL_ENV] = options.historyApprovalFile
  const owned = new Map<ChildProcess, { kind: 'run' | 'once'; generation: number | null; done: Promise<void>; closeStreams: () => void }>()
  let draining = 0
  let admission = true
  let admissionEpoch = 0
  const uncertain: OwnedHelperChild[] = []
  const exposures = new WeakMap<ChildProcess, CompletionTarget>()
  const closedExposures = new Map<string, OwnedHelperChild>()
  const ownedChildren = (): OwnedHelperChild[] => [...[...owned].map(([p, v]) => ({ pid: p.pid ?? null, kind: v.kind, generation: v.generation, status: 'live' as const })), ...uncertain]
  const recordedExit = new WeakSet<ChildProcess>()
  const awaitingForegroundClose = () => [...owned.values()].some(v => v.kind === 'run' && v.generation !== null)
  const recordExit = (proc: ChildProcess, record: { kind: 'run' | 'once'; generation: number | null }, code: number | null, signal?: string | null) => {
    if (!recordedExit.has(proc) && proc.pid !== undefined && record.generation !== null && (code !== 0 || signal != null)) {
      recordedExit.add(proc)
      const uncertainty: OwnedHelperChild = { pid: proc.pid, kind: record.kind, generation: record.generation, status: 'exit-unconfirmed' }
      uncertain.push(uncertainty)
      const exposure = exposures.get(proc)
      if (exposure) closedExposures.set(exposure.identity.exposure, uncertainty)
      admission = false; admissionEpoch++; wanted = null
    }
  }
  const signalled = new WeakSet<ChildProcess>()
  const cancelChild = (p: ChildProcess) => {
    const record = owned.get(p)
    if (!record || signalled.has(p)) return
    record.closeStreams()
    signalled.add(p)
    try { p.kill('SIGTERM') } catch { /* handle may have ended */ }
  }
  const cancelOwned = () => { for (const p of owned.keys()) cancelChild(p) }
  const listeners = new Set<(s: SupervisorState) => void>()
  let state: SupervisorState = { state: 'stopped' }
  let child: ChildProcess | null = null
  let exited: Promise<void> = Promise.resolve()
  let wanted: { configFile: string; runtimeDir: string; admit?: () => boolean } | null = null
  let failedStarts = 0
  let retryTimer: unknown = null
  let lastError: string | null = null
  let startWaiters: Array<(s: SupervisorState) => void> = []

  const set = (next: SupervisorState): void => {
    state = next
    for (const l of listeners) { try { l(next) } catch { /* a listener cannot affect the helper */ } }
    if (next.state !== 'starting') {
      const waiters = startWaiters
      startWaiters = []
      for (const w of waiters) w(next)
    }
  }

  async function launch(): Promise<void> {
    if (!wanted || child || !admission || awaitingForegroundClose()) return
    const intent = wanted
    const { configFile, runtimeDir } = intent
    const args = [options.entry, 'run', '--config', configFile, '--runtime-dir', runtimeDir, '--max-runtime-ms', String(maxRuntimeMs), '--shutdown-grace-ms', String(HELPER_GRACE_MS), '--hard-stop-ms', String(HELPER_HARD_STOP_MS)]
    const startedAt = now()
    let runningSince: number | null = null
    let stoppingReason: string | null = null
    let proc: ChildProcess
    let credentials: ReturnType<typeof prepareChildCredentials>
    let input: ChildCredentialInput | null | undefined
    let exposure: CompletionTarget | undefined
    try {
      input = options.credentials ? await options.credentials(args.slice(1)) : null
      credentials = input ? await prepareConfiguredCredentials(input, args.slice(1), now()) : null
      if (wanted !== intent || !admission || child || awaitingForegroundClose()) return
      if (credentials && intent.admit && !intent.admit()) { wanted = null; set({ state: 'stopped' }); return }
      if (credentials) {
        args[args.indexOf('--max-runtime-ms') + 1] = String(Math.min(maxRuntimeMs, credentials.runtimeMs))
        args.splice(1, 0, '--github-credentials')
      }
      if (credentials && input && options.exposure) { exposure = options.exposure.reserve(input); args.splice(1, 0, '--github-exposure', Buffer.from(JSON.stringify(exposure)).toString('base64url')) }
      proc = spawn(options.command, args, { env, stdio: credentials ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'], detached: false })
    } catch (error) {
      if (wanted !== intent || !admission) return
      lastError = options.credentials ? 'GitHub credential bridge refused' : describe(error instanceof Error ? error.message : String(error))
      afterExit(false, startedAt)
      return
    }
    child = proc
    set({ state: 'starting', since: startedAt })
    let resolveExit!: () => void
    exited = new Promise<void>((r) => { resolveExit = r })
    let closeSettled!: () => void
    const record = { kind: 'run' as const, generation: credentials?.generation ?? null, done: new Promise<void>(r => { closeSettled = r }), closeStreams: () => {} }
    let completed = false
    let renewOnClose = false
    let released = false
    const release = (code: number | null = null, signal?: string | null) => {
      if (released) return
      released = true
      recordExit(proc, record, code, signal); record.closeStreams(); owned.delete(proc); closeSettled()
      if (exposure) options.exposure?.closed(exposure)
      // A retry/runtime renewal may have reached admission while this child still owned its streams.
      if (record.generation !== null && completed && wanted === intent && admission && retryTimer === null && (renewOnClose || state.state === 'restarting')) void launch()
    }
    proc.once('close', release)
    owned.set(proc, record)
    if (exposure) exposures.set(proc, exposure)
    record.closeStreams = () => { (proc.stdio?.[3] as import('node:stream').Writable | null)?.destroy(); (proc.stdio?.[4] as import('node:stream').Writable | null)?.destroy() }
    /** The one ending of this child, whichever event shows it first. */
    const complete = (code: number | null, signal: NodeJS.Signals | string | null): void => {
      if (completed) return
      completed = true
      recordExit(proc, record, code, signal)
      record.closeStreams()
      if (proc.pid === undefined) release()
      if (code !== 0 && !lastError) lastError = `the helper ended (${signal ?? `exit ${code}`})`
      if (child === proc) child = null
      resolveExit()
      const bound = runningSince !== null && code === 0 && signal === null && stoppingReason === 'max-runtime' && now() - runningSince >= maxRuntimeMs - RUNTIME_SLACK_MS
      if (code === 0 && !bound && !lastError) lastError = 'the helper stopped before its runtime bound'
      renewOnClose = bound
      if (wanted === intent || !wanted) afterExit(bound, startedAt)
    }
    let buffer = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (line.length > MAX_LINE) continue
        let event: { type?: unknown; message?: unknown; error?: unknown; reason?: unknown } | null = null
        try { event = JSON.parse(line) } catch { if (line.trim()) lastError = describe(line) }
        if (!event || typeof event.type !== 'string') continue
        if (event.type === 'started' && child === proc && !completed) {
          runningSince = now()
          set({ state: 'running', since: runningSince, pid: proc.pid ?? -1 })
        } else if (event.type === 'stopping') {
          stoppingReason = typeof event.reason === 'string' ? event.reason : null
        } else if (event.type === 'start-failed' || event.type === 'stop-failed') {
          lastError = describe(String(event.message ?? event.error ?? event.type))
        }
      }
      if (buffer.length > MAX_LINE) buffer = ''
    })
    proc.on('error', (error) => {
      lastError = describe(error.message)
      // No pid: the process was never created, and no `exit` need follow.
      if (proc.pid === undefined) complete(null, null)
    })
    proc.on('exit', (code, signal) => complete(code, signal))
    proc.on('close', (code, signal) => complete(code, signal))
    try {
      if (credentials) {
        if (exposure) await options.exposure!.persist(exposure)
        if (!owned.has(proc) || completed || !admission || wanted !== intent || (intent.admit && !intent.admit()) || (input && options.exposure && !options.exposure.admitted(input))) { cancelChild(proc); return }
        const fresh = input ? await prepareConfiguredCredentials(input, args.slice(args.indexOf('--github-credentials') + 1), now()) : null
        if (input && options.exposure?.validate && !await options.exposure.validate(input)) { cancelChild(proc); return }
        if (!fresh || !fresh.configurationCurrent() || !fresh.bytes.equals(credentials.bytes) || !owned.has(proc) || completed || !admission || wanted !== intent || (intent.admit && !intent.admit()) || (input && options.exposure && !options.exposure.admitted(input))) { cancelChild(proc); return }
        record.closeStreams = sendChildCredentials(proc, credentials.bytes)
      }
    } catch { cancelChild(proc) }
  }

  function afterExit(cleanBound: boolean, startedAt: number): void {
    if (!wanted) { set({ state: 'stopped' }); return }
    if (cleanBound) {
      // Reached its runtime bound: start the next one now.
      failedStarts = 0
      lastError = null
      launch()
      return
    }
    if (now() - startedAt >= HEALTHY_RUN_MS) failedStarts = 0
    failedStarts += 1
    if (failedStarts >= MAX_FAILED_STARTS) { set({ state: 'failed', lastError }); return }
    const delay = BACKOFF_MS[Math.min(failedStarts - 1, BACKOFF_MS.length - 1)]!
    set({ state: 'restarting', at: now() + delay, lastError })
    retryTimer = setTimer(() => { retryTimer = null; launch() }, delay)
  }

  async function stop(): Promise<SupervisorState> {
    wanted = null
    cancelOwned()
    if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null }
    const proc = child
    if (!proc) { set({ state: 'stopped' }); return state }
    let timer: unknown = null
    const overdue = new Promise<'overdue'>((r) => { timer = setTimer(() => r('overdue'), stopWaitMs) })
    const outcome = await Promise.race([exited.then(() => 'exited' as const), overdue])
    if (timer !== null) clearTimer(timer)
    if (outcome === 'overdue') set({ state: 'stop-overdue', pid: proc.pid ?? -1 })
    return state
  }

  return {
    async start(configFile, runtimeDir, admit) {
      if (draining || uncertain.length) { set({ state: 'failed', lastError: 'GitHub helper containment is unconfirmed' }); return state }
      if (child || awaitingForegroundClose() || state.state === 'stop-overdue') await stop()
      if (state.state === 'stop-overdue') return state
      const pending = [...owned].filter(([, v]) => v.kind === 'run' && v.generation !== null)
      if (pending.length) {
        let timer: unknown
        await Promise.race([Promise.all(pending.map(([, v]) => v.done)), new Promise<void>(r => { timer = setTimer(r, stopWaitMs) })])
        if (timer !== undefined) clearTimer(timer)
        if (awaitingForegroundClose()) { set({ state: 'stop-overdue', pid: pending[0]![0].pid ?? -1 }); return state }
      }
      if (uncertain.length) { set({ state: 'failed', lastError: 'GitHub helper containment is unconfirmed' }); return state }
      // Last check before the spawn below; nothing between them waits.
      if (admit && !admit()) return state
      admission = true
      wanted = { configFile, runtimeDir, admit }
      failedStarts = 0
      lastError = null
      const answer = new Promise<SupervisorState>((r) => startWaiters.push(r))
      launch()
      return answer
    },
    stop,
    ownedChildren,
    resumeAdmission() {
      if (draining || uncertain.length || [...owned.values()].some(v => v.generation !== null)) return false
      if (!admission) { admissionEpoch++; admission = true }; return true
    },
    acknowledgeExposure(exposure) {
      if ([...owned.keys()].some(p => exposures.get(p)?.identity.exposure === exposure)) return false
      const entry = closedExposures.get(exposure)
      if (!entry) return false
      const i = uncertain.indexOf(entry); if (i < 0) return false
      uncertain.splice(i, 1); closedExposures.delete(exposure)
      return true
    },
    async drain() {
      draining++
      try {
      admission = false
      admissionEpoch++
      const stopping = stop()
      cancelOwned()
      let timer: unknown
      await Promise.race([Promise.all([...owned.values()].map(v => v.done)), new Promise<void>(r => { timer = setTimer(r, stopWaitMs) })])
      if (timer !== undefined) clearTimer(timer)
      await stopping
      const remaining = ownedChildren()
      return { confirmed: remaining.length === 0, remaining }
      } finally { draining-- }
    },
    stopNow() {
      admissionEpoch++
      admission = false
      cancelOwned()
      wanted = null
      if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null }

    },
    state: () => state,
    async runOnce(args, timeoutMs = 90_000) {
      const epoch = admissionEpoch
      let credentials: ReturnType<typeof prepareChildCredentials>
      let input: ChildCredentialInput | null | undefined
      let exposure: CompletionTarget | undefined
      try {
        input = options.credentials ? await options.credentials(args) : null
        credentials = input ? await prepareConfiguredCredentials(input, args, now()) : null
      } catch { return { code: null, stdout: '', stderr: 'GitHub credential bridge refused' } }
      return new Promise((resolve) => {
        if (!admission || epoch !== admissionEpoch) { resolve({ code: null, stdout: '', stderr: 'helper admission closed' }); return }
        let proc: ChildProcess
        try {
          if (credentials && input && options.exposure) exposure = options.exposure.reserve(input)
          proc = spawn(options.command, [options.entry, ...(exposure ? ['--github-exposure', Buffer.from(JSON.stringify(exposure)).toString('base64url')] : []), ...(credentials ? ['--github-credentials'] : []), ...args], { env, stdio: credentials ? ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'], detached: false })
        } catch (error) {
          resolve({ code: null, stdout: '', stderr: describe(error instanceof Error ? error.message : String(error)) })
          return
        }
        let settled!: () => void
        const record = { kind: 'once' as const, generation: credentials?.generation ?? null, done: new Promise<void>(r => { settled = r }), closeStreams: () => {} }
        owned.set(proc, record)
        if (exposure) exposures.set(proc, exposure)
        record.closeStreams = () => { (proc.stdio?.[3] as import('node:stream').Writable | null)?.destroy(); (proc.stdio?.[4] as import('node:stream').Writable | null)?.destroy() }
        let stdout = ''
        let stderr = ''
        proc.stdout?.setEncoding('utf8')
        proc.stderr?.setEncoding('utf8')
        proc.stdout?.on('data', (c: string) => { if (stdout.length < 8 * 1024 * 1024) stdout += c })
        proc.stderr?.on('data', (c: string) => { if (stderr.length < 64 * 1024) stderr += c })
        const timer = setTimer(() => cancelChild(proc), Math.min(timeoutMs, credentials?.runtimeMs ?? timeoutMs))
        let done = false
        const finish = (code: number | null, signal?: string | null): void => {
          if (done) return
          done = true
          recordExit(proc, record, code, signal)
          record.closeStreams(); owned.delete(proc); settled()
          if (exposure) options.exposure?.closed(exposure)
          clearTimer(timer)
          resolve({ code, stdout, stderr: describe(stderr) })
        }
        proc.on('error', (error) => {
          stderr += describe(error.message)
          // Never started: no `close` need follow.
          if (proc.pid === undefined) finish(null)
        })
        proc.on('close', (code, signal) => finish(code, signal))
        void (async () => {
          if (!credentials) return
          if (exposure) await options.exposure!.persist(exposure)
          if (done || !owned.has(proc) || !admission || epoch !== admissionEpoch || (input && options.exposure && !options.exposure.admitted(input))) { cancelChild(proc); return }
          const fresh = input ? await prepareConfiguredCredentials(input, args, now()) : null
          if (input && options.exposure?.validate && !await options.exposure.validate(input)) { cancelChild(proc); return }
        if (!fresh || !fresh.configurationCurrent() || !fresh.bytes.equals(credentials.bytes) || done || !owned.has(proc) || !admission || epoch !== admissionEpoch || (input && options.exposure && !options.exposure.admitted(input))) { cancelChild(proc); return }
          record.closeStreams = sendChildCredentials(proc, credentials.bytes)
        })().catch(() => cancelChild(proc))
      })
    },
    onState(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
