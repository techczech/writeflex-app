/** Main-owned account, attempt, candidate and rotation lifecycle. No renderer credentials or URLs. */
import { randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { BackupGitHubConfig } from '../backup-github-config'
import type { GitHubView, GitHubRepositoryView } from '../../shared/backup-github'
import type { GitHubAuthStore, Account } from './github-auth-store'
import { createDeviceFlow, createGitHubRequest, tokenPair, verifiedUser, GitHubRequestError, type GitHubRequest } from './github-device-flow'
import { inspectOrigin, type OriginIdentity } from './github-origin'
import { parseGitHubOrigin, inspectGitHubAccess } from './github-repositories'
import type { ChildCredentialInput, ChildVaultBinding } from './github-credentials'
import type { ManagedHelperSupervisor } from './supervisor'
import { AUTH_NAMESPACE, readCompletion, type CompletionTarget } from '../../backup-helper/github-auth-receipts'
export type GitHubAuthOptions = {
  config: BackupGitHubConfig | null; store: GitHubAuthStore
  binding(sender: number): string | null; root(sender: number): string | null
  supervisor(): ManagedHelperSupervisor
  open(url: string): Promise<void>; copy(code: string): void; changed(): void
  holdBackups?: () => void
  request?: GitHubRequest; origin?: (root: string) => Promise<OriginIdentity>; now?: () => number
}
type Attempt = { id: string; sender: number; binding: string; epoch: number; flow: ReturnType<typeof createDeviceFlow>; waiting?: GitHubView['waiting']; reason?: GitHubView['reason'] }
type Candidate = { id: string; sender: number; binding: string; epoch: number; issued: number; origin: OriginIdentity; repository: string; repositoryId: number; installationId: number }
export function createGitHubAuth(o: GitHubAuthOptions) {
  const request = o.request ?? createGitHubRequest(), origin = o.origin ?? inspectOrigin, now = o.now ?? Date.now
  let runtimeEpoch = 0, retired = false, attempt: Attempt | null = null, reason: GitHubView['reason'], loaded = false
  const candidates = new Map<number, Candidate>(), repositories = new Map<number, GitHubRepositoryView>()
  const checks = new Map<number, object>()
  let lane: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>) => { const p = lane.then(fn); lane = p.catch(() => undefined); return p }
  const changed = () => { try { o.changed() } catch { /* observer */ } }
  const current = (sender: number, binding: string, epoch: number) => !retired && runtimeEpoch === epoch && o.binding(sender) === binding
  const bound = (sender: number) => { const b = o.binding(sender); if (!b || retired) throw Error('GitHub sender refused'); return b }
  const hold = (refreshCheck?: object) => {
    o.holdBackups?.(); o.store.hold(); candidates.clear(); repositories.clear()
    // Only the Check requesting this rotation survives it; all other holds revoke operations.
    for (const [sender, check] of checks) if (check !== refreshCheck) checks.delete(sender)
  }
  const phase = () => o.store.gate.state()?.phase
  const status = (sender: number): GitHubView => {
    if (!o.binding(sender) || retired) return { state: 'error', reason: 'refused', repository: { state: 'unknown' } }
    const repo = repositories.get(sender) ?? { state: o.root(sender) ? 'unchecked' as const : 'no-folder' as const }
    const account = o.store.account()
    if (!loaded) return { state: 'error', reason: 'storage', repository: repo }
    if (o.store.gate.debts().length && o.store.held()) return { state: 'reauth-required', reason: 'shutdown-unconfirmed', ...(account ? { login: account.login } : {}), repository: repo }
    if (phase() === 'disconnecting') return { state: 'disconnecting', reason, ...(account ? { login: account.login } : {}), repository: repo }
    if (o.store.blocked()) return { state: 'reauth-required', reason: 'storage', repository: repo }
    if (!o.config) return { state: 'unconfigured', repository: repo }
    if (attempt) return attempt.sender === sender && o.binding(sender) === attempt.binding
      ? { state: attempt.waiting ? 'waiting' : 'starting', ...(attempt.waiting ? { waiting: attempt.waiting } : {}), reason: attempt.reason, attemptId: attempt.id, repository: repo }
      : { state: account ? 'connected' : 'error', ...(account ? { login: account.login } : {}), reason: 'other-window', repository: repo }
    if (o.store.held() || (account && account.expiresAt <= now())) return { state: 'reauth-required', reason: reason ?? 'expired', ...(account ? { login: account.login } : {}), repository: repo }
    return { state: account ? 'connected' : reason && reason !== 'disconnected' ? 'error' : 'disconnected', ...(account ? { login: account.login } : {}), reason, repository: repo }
  }
  function cancelAttempt() { if (attempt) { attempt.flow.cancel(); attempt = null }; candidates.clear() }
  async function reconcileClosed() {
    // A proof may clear only its own closed child's conservative in-memory uncertainty.
    for (const debt of o.store.gate.debts()) {
      const target = targets.get(debt.exposure)
      if (target && readCompletion(target)) o.supervisor().acknowledgeExposure(debt.exposure)
    }
    await o.store.gate.reconcile()
    const a = o.store.account()
    if (a && !o.store.held() && o.store.gate.debts().length === 0 && o.store.gate.admitted(a.epoch, a.generation)) o.supervisor().resumeAdmission()
  }
  const targets = new Map<string, CompletionTarget>()
  const preparedRoots = new WeakMap<ChildCredentialInput, Map<string, string>>()
  async function access(a: Account, repository: string, owner = () => true, inLane = false) {
    const epoch = runtimeEpoch
    // Capture the request's account and gate identity, not a later account with the same ID.
    const admitted = () => {
      const g = o.store.gate.state()
      return !retired && runtimeEpoch === epoch && owner() && o.store.account() === a &&
        g?.phase === 'active' && g.installId === a.installId && g.epoch === a.epoch && g.generation === a.generation
    }
    try { return await inspectGitHubAccess(o.config!, request, a.accessToken, repository) }
    catch (e) {
      if (e instanceof GitHubRequestError && e.code === 'unauthorised') {
        const invalidate = async () => {
          if (!admitted()) return
          hold()
          await o.store.gate.phase('reauth-required', a.epoch + 1, a.generation, admitted)
          await contained(); reason = 'expired'; changed()
        }
        // Repository Use already owns this lane. Re-enqueuing here would wait on itself.
        if (inLane) await invalidate(); else await serial(invalidate)
      }
      throw e
    }
  }
  async function contained() {
    await reconcileClosed()
    const drained = await o.supervisor().drain()
    await reconcileClosed()
    // If an acknowledgement arrived while drain was waiting, ask the original supervisor again.
    const confirmed = drained.confirmed || (await o.supervisor().drain()).confirmed
    return await o.store.gate.originalDrain(confirmed)
  }
  async function fresh(sender?: number, binding?: string, refreshCheck?: object): Promise<Account> {
    if (!loaded || !o.config || retired || o.store.held()) throw Error('GitHub auth held')
    let a = o.store.account()
    if (!a) throw Error('GitHub auth unavailable')
    if (a.expiresAt > now() + 120_000 + 90_000) return a
    const epoch = runtimeEpoch
    return serial(async () => {
      a = o.store.account()
      if (!a || o.store.held() || retired || runtimeEpoch !== epoch) throw Error('GitHub auth held')
      if (a.expiresAt > now() + 210_000) return a
      hold(refreshCheck)
      await o.store.gate.phase('refresh-pending', a.epoch, a.generation)
      if (!await contained() || runtimeEpoch !== epoch || retired || (sender !== undefined && o.binding(sender) !== binding)) throw Error('GitHub shutdown unconfirmed')
      try {
        if (a.refreshExpiresAt <= now()) throw Error('GitHub refresh expired')
        // Exactly one request. Pending survives every ambiguous response or persistence failure.
        const pair = tokenPair(await request('/login/oauth/access_token', { client_id: o.config!.clientId, grant_type: 'refresh_token', refresh_token: a.refreshToken }), now())
        const user = verifiedUser(await request('/user', undefined, pair.accessToken))
        if (user.accountId !== a.accountId || runtimeEpoch !== epoch || retired) throw Error('GitHub account changed')
        await o.store.commit({ ...a, ...pair, login: user.login, epoch: a.epoch + 1, generation: a.generation + 1 }, () => !retired && runtimeEpoch === epoch && (sender === undefined || o.binding(sender) === binding))
        o.supervisor().resumeAdmission(); reason = undefined; changed(); return o.store.account()!
      } catch { hold(); reason = 'expired'; changed(); throw Error('GitHub reauthorisation required') }
    })
  }
  const api = {
    async startup() { try { await o.store.load() } catch { hold() }; loaded = true; changed() },
    status,
    async connect(sender: number) {
      const binding = bound(sender)
      if (!loaded || !o.config || attempt || phase() === 'disconnecting' || o.store.gate.damaged() || o.store.blocked()) return status(sender)
      const admissionEpoch = runtimeEpoch
      await o.store.gate.reconcile()
      if (o.store.gate.debts().length || phase() === 'disconnecting' || !current(sender, binding, admissionEpoch)) return status(sender)
      const existing = o.store.account()
      if (existing && !o.store.held() && existing.expiresAt > now()) return status(sender)
      const epoch = ++runtimeEpoch, flow = createDeviceFlow({ clientId: o.config.clientId, request, now })
      const mine: Attempt = { id: randomBytes(16).toString('hex'), sender, binding, epoch, flow }
      attempt = mine; reason = undefined; changed()
      void flow.run((userCode, expiresAt) => {
        if (attempt !== mine || !current(sender, binding, epoch)) return
        mine.waiting = { attemptId: mine.id, userCode, expiresAt, canCancel: true, canOpen: true }; changed(); void api.openBrowser(sender, mine.id)
      }, (pair, user) => serial(async () => {
        if (attempt !== mine || !current(sender, binding, epoch)) throw Error('retired')
        if (existing && existing.accountId !== user.accountId) throw Error('disconnect required')
        hold()
        const g = o.store.gate.state()
        if (!g || !await contained() || attempt !== mine || !current(sender, binding, epoch)) throw Error('GitHub auth held')
        await o.store.commit({ version: 1, namespace: AUTH_NAMESPACE, installId: g.installId, clientId: o.config!.clientId, ...user, ...pair, epoch: g.epoch + 1, generation: Math.max(g.generation, existing?.generation ?? 0) + 1, bindings: [] }, () => attempt === mine && current(sender, binding, epoch))
        if (current(sender, binding, epoch)) o.supervisor().resumeAdmission()
      })).then(result => {
        if (attempt !== mine || !current(sender, binding, epoch)) return
        attempt = null; reason = result === 'connected' ? undefined : result; changed()
      })
      return status(sender)
    },
    async cancel(sender: number, id: string) {
      if (attempt?.sender === sender && attempt.id === id && current(sender, attempt.binding, attempt.epoch)) {
        runtimeEpoch++; cancelAttempt(); o.store.gate.seal(); reason = 'cancelled'
        await serial(async () => { try { await o.store.invalidateCommit(); await o.store.load() } catch { hold(); reason = 'storage' } })
        changed()
      }
      return status(sender)
    },
    async openBrowser(sender: number, id: string) {
      const mine = attempt
      if (!mine?.waiting || mine.id !== id || mine.sender !== sender || !current(sender, mine.binding, mine.epoch) || now() >= mine.waiting.expiresAt) return status(sender)
      try { await o.open('https://github.com/login/device') } catch { if (attempt === mine && current(sender, mine.binding, mine.epoch)) { mine.reason = 'browser-failed'; changed() } }
      return status(sender)
    },
    async repository(sender: number) {
      const binding = bound(sender), epoch = runtimeEpoch, root = o.root(sender)
      candidates.delete(sender)
      const checking: GitHubRepositoryView = { state: 'checking' }
      checks.set(sender, checking)
      repositories.set(sender, checking); changed()
      if (!root) { repositories.set(sender, { state: 'no-folder' }); return status(sender) }
      let displayRepository: string | undefined
      try {
        const a = await fresh(sender, binding, checking), first = await origin(root), parsed = parseGitHubOrigin(first.exactRemote)
        if (!current(sender, binding, epoch) || checks.get(sender) !== checking) return status(sender)
        if (!parsed) { repositories.set(sender, { state: 'unsupported' }); return status(sender) }
        displayRepository = parsed.repository
        const ids = await access(a, parsed.repository, () => current(sender, binding, epoch))
        const second = await origin(root)
        if (!current(sender, binding, epoch) || checks.get(sender) !== checking || JSON.stringify(first) !== JSON.stringify(second) || o.store.account() !== a) throw Error('GitHub origin changed')
        const c: Candidate = { id: randomBytes(16).toString('hex'), sender, binding, epoch, issued: now(), origin: first, repository: parsed.repository, ...ids }
        candidates.set(sender, c); repositories.set(sender, { state: 'candidate', repository: c.repository, candidateId: c.id })
      } catch (e) {
        if (e instanceof GitHubRequestError && e.code === 'offline') reason = 'offline'
        if (current(sender, binding, epoch) && checks.get(sender) === checking) repositories.set(sender, { state: e instanceof GitHubRequestError && e.code === 'not-authorised' ? 'not-authorised' : 'unknown', ...(displayRepository ? { repository: displayRepository } : {}) })
      }
      changed(); return status(sender)
    },
    async useRepository(sender: number, id: string) {
      const c = candidates.get(sender)
      if (!c || c.id !== id) return status(sender)
      candidates.delete(sender)
      if (!current(sender, c.binding, c.epoch)) return status(sender)
      if (now() < c.issued || now() - c.issued > 300_000) {
        repositories.set(sender, { state: 'expired', repository: c.repository }); changed(); return status(sender)
      }
      const selecting: GitHubRepositoryView = { state: 'selecting', repository: c.repository }
      repositories.set(sender, selecting); changed()
      await serial(async () => {
        const a = o.store.account()
        if (!a || o.store.held() || !current(sender, c.binding, c.epoch)) return
        const first = await origin(o.root(sender) ?? '')
        if (JSON.stringify(first) !== JSON.stringify(c.origin)) return
        const ids = await access(a, c.repository, () => current(sender, c.binding, c.epoch), true)
        const second = await origin(o.root(sender) ?? '')
        if (ids.repositoryId !== c.repositoryId || ids.installationId !== c.installationId || JSON.stringify(first) !== JSON.stringify(second) || !current(sender, c.binding, c.epoch)) return
        hold(); await o.store.gate.phase('refresh-pending', a.epoch, a.generation)
        if (!await contained() || !current(sender, c.binding, c.epoch)) return
        const finalOrigin = await origin(o.root(sender) ?? '')
        if (JSON.stringify(first) !== JSON.stringify(finalOrigin) || !current(sender, c.binding, c.epoch)) return
        const parsed = parseGitHubOrigin(first.exactRemote)!
        const next = { ...a, epoch: a.epoch + 1, bindings: [...a.bindings.filter(b => b.realRoot !== first.realRoot), { vaultId: `auth-${randomBytes(8).toString('hex')}`, realRoot: first.realRoot, exactRemote: first.exactRemote, credentialPath: parsed.credentialPath, ...ids }] }
        await o.store.commit(next, () => current(sender, c.binding, c.epoch))
        if (current(sender, c.binding, c.epoch)) o.supervisor().resumeAdmission()
        repositories.set(sender, { state: 'ready', repository: c.repository })
      }).catch(() => { reason = 'storage' })
      if (repositories.get(sender) === selecting) repositories.set(sender, { state: 'unknown', repository: c.repository })
      changed(); return status(sender)
    },
    async openRepositoryAccess(sender: number) { bound(sender); if (o.config && loaded && !retired) await o.open(`https://github.com/apps/${o.config.appSlug}/installations/new`).catch(() => undefined); return status(sender) },
    async openAuthorisations(sender: number) { bound(sender); await o.open('https://github.com/settings/apps/authorizations').catch(() => undefined); return status(sender) },
    copyCode(sender: number, id: string) { const a = attempt; if (a?.waiting && a.id === id && a.sender === sender && current(sender, a.binding, a.epoch) && now() < a.waiting.expiresAt) o.copy(a.waiting.userCode); return status(sender) },
    disconnect(sender: number) {
      bound(sender); runtimeEpoch++; cancelAttempt(); hold(); changed()
      return serial(async () => {
        const g = o.store.gate.state()
        if (!g || !loaded || retired || o.store.gate.damaged() || o.store.blocked()) return status(sender)
        try {
          await o.store.gate.phase('disconnecting', g.epoch + 1, g.generation)
          if (!await contained()) { reason = 'shutdown-unconfirmed'; changed(); return status(sender) }
          await o.store.remove(g.epoch + 1); if (!retired) o.supervisor().resumeAdmission(); reason = 'disconnected'
        } catch { reason = 'storage' }
        changed(); return status(sender)
      })
    },
    async recover(sender: number) { bound(sender); await reconcileClosed().catch(() => undefined); if (!o.store.gate.debts().length) await o.store.load(); changed(); return status(sender) },
    retireSender(sender: number) { if (attempt?.sender === sender) { runtimeEpoch++; cancelAttempt(); o.store.gate.seal(); void serial(async () => { try { await o.store.invalidateCommit(); await o.store.load() } catch { hold() } }) }; checks.delete(sender); candidates.delete(sender); repositories.delete(sender); changed() },
    quit() { retired = true; runtimeEpoch++; cancelAttempt(); o.store.gate.seal(); o.supervisor().stopNow() },
    githubBinding(v: { id: string; root: string; repository: string | null }) {
      const a = o.store.account(), b = a?.bindings.find(b => b.realRoot === v.root && (!v.repository || b.credentialPath.replace(/\.git$/, '').toLowerCase() === v.repository.toLowerCase()))
      // Config remains host-mode while held; this is identity only, never permission to release.
      return b ? { repository: b.credentialPath.replace(/\.git$/, ''), repositoryId: b.repositoryId } : null
    },
    async credentials(args: readonly string[]): Promise<ChildCredentialInput | null> {
      const epoch = runtimeEpoch
      const index = args.indexOf('--config')
      if (index < 0 || !args[index + 1]) return null
      const text = await readFile(args[index + 1]!, 'utf8')
      if (Buffer.byteLength(text) > 256 * 1024) throw Error('GitHub config refused')
      const v = JSON.parse(text), selected = args.indexOf('--vault')
      if (!Array.isArray(v.vaults)) throw Error('GitHub config refused')
      const vaults: ChildVaultBinding[] = v.vaults.filter((v: ChildVaultBinding) => selected < 0 || v.id === args[selected + 1])
      if (!vaults.some(v => v.github?.credentialMode === 'host')) return null
      const a = await fresh()
      const bindings = []
      const roots = new Map<string, string>()
      for (const v of vaults) {
        if (v.github?.credentialMode !== 'host') continue
        const b = a.bindings.find(b => b.realRoot === v.path && b.repositoryId === v.github?.repositoryId && b.credentialPath.replace(/\.git$/, '').toLowerCase() === v.github.repository.toLowerCase())
        if (!b) throw Error('GitHub accepted binding unavailable')
        const before = await origin(v.path)
        if (before.realRoot !== b.realRoot || before.exactRemote !== b.exactRemote) throw Error('GitHub origin changed')
        const ids = await access(a, b.credentialPath.replace(/\.git$/, ''), () => !retired && runtimeEpoch === epoch)
        const after = await origin(v.path)
        if (ids.repositoryId !== b.repositoryId || ids.installationId !== b.installationId || JSON.stringify(before) !== JSON.stringify(after) || o.store.account() !== a || !o.store.gate.admitted(a.epoch, a.generation)) throw Error('GitHub identity changed')
        roots.set(b.realRoot, before.marker)
        bindings.push({ ...b, vaultId: v.id })
      }
      const input: ChildCredentialInput = { snapshot: { version: 1, namespace: AUTH_NAMESPACE, installId: a.installId, epoch: a.epoch, generation: a.generation, expiresAt: a.expiresAt, accessToken: a.accessToken, bindings }, vaults }
      preparedRoots.set(input, roots)
      return input
    },
    exposure: {
      reserve(input: ChildCredentialInput) { const s = input.snapshot; const t = o.store.gate.reserve(s.epoch, s.generation); targets.set(t.identity.exposure, t); return t },
      persist: (t: CompletionTarget) => o.store.gate.expose(t),
      async validate(input: ChildCredentialInput): Promise<boolean> {
        for (const b of input.snapshot.bindings) {
          const found = await origin(b.realRoot)
          if (found.realRoot !== b.realRoot || found.exactRemote !== b.exactRemote || found.marker !== preparedRoots.get(input)?.get(b.realRoot)) return false
        }
        return api.exposure.admitted(input)
      },
      admitted(input: ChildCredentialInput) {
        try {
          for (const b of input.snapshot.bindings) {
            const st = lstatSync(join(b.realRoot, '.git'))
            if (realpathSync(b.realRoot) !== b.realRoot || `${st.dev}:${st.ino}:${st.isDirectory() ? 'directory' : 'file'}` !== preparedRoots.get(input)?.get(b.realRoot)) return false
          }
        } catch { return false }
        const a = o.store.account(), s = input.snapshot; return !retired && !!a && a.expiresAt > now() + 210_000 && a.expiresAt === s.expiresAt && a.epoch === s.epoch && a.generation === s.generation && o.store.gate.admitted(s.epoch, s.generation) },
      closed(_t: CompletionTarget) { void reconcileClosed().catch(() => undefined) },
    },
  }
  return api
}
export type GitHubAuth = ReturnType<typeof createGitHubAuth>
