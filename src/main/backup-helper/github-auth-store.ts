/** One encrypted slot, coupled to a durable non-secret generation gate. */
import { basename, dirname } from 'node:path'
import { lstatSync } from 'node:fs'
import { SECRET_SLOTS, nodeSecretsFiles, type SecretsFiles, type SecretsStore } from '../secrets-store'
import { AUTH_NAMESPACE, UUID, exactData, syncDir } from '../../backup-helper/github-auth-receipts'
import { validateSnapshot, type AcceptedBinding } from '../../backup-helper/github-credentials'
import { createAuthGate } from './github-auth-gate'
import type { Pair } from './github-device-flow'
export type Account = Pair & { version: 1; namespace: typeof AUTH_NAMESPACE; installId: string; clientId: string; accountId: number; login: string; epoch: number; generation: number; bindings: AcceptedBinding[] }
/** Used only by this slot; other slots retain their existing persistence behaviour. */
export function githubSecretsFiles(base: SecretsFiles = nodeSecretsFiles): SecretsFiles {
  const own = (p: string) => basename(p) === SECRET_SLOTS['backup-github-auth'].file
  return {
    exists: p => base.exists(p), read: p => base.read(p),
    writeAtomic(p, bytes) { base.writeAtomic(p, bytes); if (own(p)) { syncDir(dirname(p)); if (!base.read(p).equals(bytes)) throw Error('GitHub encrypted readback failed') } },
    remove(p) { if (own(p) && base.exists(p) && lstatSync(p).isSymbolicLink()) throw Error('GitHub encrypted slot refused'); base.remove(p); if (own(p)) { syncDir(dirname(p)); if (base.exists(p)) throw Error('GitHub encrypted removal uncertain') } },
  }
}
export function createGitHubAuthStore(userData: string, secrets: SecretsStore, clientId: string | null) {
  const gate = createAuthGate(userData)
  let account: Account | null = null, held = false, blocked = false
  function parse(text: string): Account {
    if (Buffer.byteLength(text) > 256 * 1024) throw Error('GitHub account refused')
    const parsed: unknown = JSON.parse(text)
    if (JSON.stringify(parsed) !== text) throw Error('GitHub account refused')
    const x = exactData(parsed, ['version', 'namespace', 'installId', 'clientId', 'accountId', 'login', 'epoch', 'generation', 'accessToken', 'refreshToken', 'expiresAt', 'refreshExpiresAt', 'bindings'])
    if (x.version !== 1 || x.namespace !== AUTH_NAMESPACE || typeof x.installId !== 'string' || !UUID.test(x.installId) || x.clientId !== clientId || !Number.isSafeInteger(x.accountId) || (x.accountId as number) < 1 || typeof x.login !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(x.login) || typeof x.refreshToken !== 'string' || !/^[A-Za-z0-9_.-]{1,8192}$/.test(x.refreshToken) || !Number.isSafeInteger(x.refreshExpiresAt) || (x.refreshExpiresAt as number) <= 0) throw Error('GitHub account refused')
    // Schema validation also applies to expired restored records; expiry is checked at release.
    validateSnapshot({ version: 1, namespace: AUTH_NAMESPACE, installId: x.installId, epoch: x.epoch, generation: x.generation, accessToken: x.accessToken, expiresAt: x.expiresAt, bindings: x.bindings }, -Number.MAX_SAFE_INTEGER)
    return x as unknown as Account
  }
  return {
    gate,
    async load() {
      await gate.load()
      try {
        const text = secrets.read('backup-github-auth')
        account = text === null ? null : parse(text)
        const g = gate.state()
        held = gate.damaged() || !g || (account ? g.phase !== 'active' || account.installId !== g.installId || account.epoch !== g.epoch || account.generation !== g.generation : g.phase !== 'disconnected')
        blocked = gate.damaged() || !g || (account ? account.installId !== g.installId || (g.phase === 'active' && (account.epoch !== g.epoch || account.generation !== g.generation)) : !['disconnected', 'disconnecting'].includes(g.phase))
        if (held) gate.seal()
      } catch { blocked = true; held = true; gate.seal() }
    },
    account: () => account,
    blocked: () => blocked,
    held: () => held || blocked || gate.damaged() || (account !== null && !gate.admitted(account.epoch, account.generation)),
    async commit(next: Account, admit: () => boolean) {
      const g = gate.state()
      gate.seal()
      if (blocked || !g || gate.damaged() || gate.debts().length || !admit() || next.installId !== g.installId || (account && account.accountId !== next.accountId)) throw Error('GitHub auth commit held')
      try {
        const parsed = parse(JSON.stringify(next))
        if (!admit()) throw Error('GitHub auth commit retired')
        secrets.write('backup-github-auth', JSON.stringify(parsed))
        if (secrets.read('backup-github-auth') !== JSON.stringify(parsed) || !admit()) throw Error('GitHub auth commit uncertain')
        await gate.activate(next.epoch, next.generation, admit)
        if (!admit()) throw Error('GitHub auth commit retired')
        account = parsed; held = false
      } catch { held = true; gate.seal(); throw Error('GitHub auth commit uncertain') }
    },
    async invalidateCommit() {
      const g = gate.state(); if (!g || blocked) throw Error('GitHub auth held')
      await gate.phase(secrets.has('backup-github-auth') ? 'reauth-required' : 'disconnected', g.epoch + 1, g.generation)
    },
    async remove(epoch: number) {
      if (blocked || gate.debts().length || gate.damaged()) throw Error('GitHub disconnect held')
      secrets.clear('backup-github-auth')
      if (secrets.has('backup-github-auth')) throw Error('GitHub disconnect uncertain')
      await gate.phase('disconnected', epoch, gate.state()?.generation ?? 0)
      account = null; held = false
    },
    hold() { held = true; gate.seal() },
  }
}
export type GitHubAuthStore = ReturnType<typeof createGitHubAuthStore>
