import { shortSocketDir } from '../helpers/short-socket-dir'
// Shared fixture of the backup activation tests (r3, r4): real enrolment, real registration/configuration
// files and the real durable writer; the supervisor, the helper's one-shot answers and the service pairs
// are FAKES (labelled). No helper runs, no network, no credential.
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActiveBackupServices, type ServicePair } from '../../src/main/backup-helper/active-services'
import { createBackupEnrolment } from '../../src/main/backup-helper/enrolment'
import type { BackupReceiptService } from '../../src/main/backup-helper/receipt-service'
import type { BackupHelperService } from '../../src/main/backup-helper/service'
import type { SupervisorState } from '../../src/main/backup-helper/supervisor'
import type { BackupHelperTrial } from '../../src/main/backup-helper/trial-config'

export const tick = () => new Promise((r) => setTimeout(r, 2))

/** FAKE service pair: an enabled instance refuses the copy route for its folders. */
export function fakePair(trial: BackupHelperTrial): ServicePair {
  const roots = trial.enabled ? new Set(trial.vaults.keys()) : new Set<string>()
  const receipts = {
    lifetime: async () => ({ state: trial.enabled ? 'not-registered' : 'disabled' }), reportEdit: async () => ({ state: 'disabled' }), status: async () => ({ state: 'disabled' }),
    beginSave: async () => null, nonAtomicPolicy: (root: string) => (roots.has(root) ? 'refuse' : 'copy'), retireSender: () => undefined, dispose: () => undefined,
    ready: Promise.resolve(), streamFor: async () => null,
  } as unknown as BackupReceiptService
  const helper = { status: async () => ({ state: 'disabled' }), syncNow: async () => ({ state: 'disabled' }), disposeWindow: () => undefined, dispose: () => undefined } as unknown as BackupHelperService
  return { helper, receipts }
}

export async function fixture(cleanups: Array<() => Promise<void> | void>) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'wfr3-')))
  const socketBase = shortSocketDir()
  cleanups.push(() => rm(base, { recursive: true, force: true }))
  cleanups.push(() => rm(socketBase, { recursive: true, force: true }))
  const mk = async (name: string) => { const v = join(base, name); await mkdir(join(v, '.git'), { recursive: true }); await writeFile(join(v, '.git', 'HEAD'), 'ref: refs/heads/main\n'); return v }
  const a = await mk('a'); const b = await mk('b'); const c = await mk('c')
  const git = join(base, 'git'); const gitleaks = join(base, 'gitleaks'); const entry = join(base, 'helper.js')
  for (const f of [git, gitleaks, entry]) await writeFile(f, '')
  let window = a
  const dir = join(base, 'userData', 'backup-helper')
  /** FAKE supervisor: records stops, the configurations started and the one-shot commands; hooks run at chosen points. */
  const log: string[] = []
  const hooks: { atStop?: () => void | Promise<void>; atSpawnAdmission?: () => void; afterSpawn?: () => void | Promise<void>; history?: unknown } = {}
  let state: SupervisorState = { state: 'stopped' }
  const started: string[][] = []
  const supervisor = {
    state: () => state,
    stop: async () => { log.push('stop'); await hooks.atStop?.(); state = { state: 'stopped' }; return state },
    start: async (configFile: string, _run: string, admit?: () => boolean) => {
      hooks.atSpawnAdmission?.()
      if (admit && !admit()) { log.push('start-refused'); return state }
      const config = JSON.parse(await readFile(configFile, 'utf8'))
      started.push(config.vaults.map((v: { path: string }) => v.path))
      log.push(`spawn:${config.vaults.map((v: { path: string }) => v.path.slice(base.length)).join(',')}`)
      state = { state: 'running', since: 1, pid: 7 }
      await hooks.afterSpawn?.()
      return state
    },
    stopNow: () => undefined,
    onState: () => () => undefined,
    runOnce: async (args: readonly string[]) => {
      const cfg = JSON.parse(await readFile(args[args.indexOf('--config') + 1]!, 'utf8'))
      const v = cfg.vaults[0]
      log.push(`${args[0]}:${v.path.slice(base.length)}`)
      const answer = args[0] === 'preview'
        ? { root: v.path, refused: null, tools: { git: { path: git, version: '2.50.1' }, gitleaks: { path: gitleaks, version: '8.30.1' } }, remote: { kind: 'local', path: '/remote.git' }, visibility: 'private', visibilityReason: null, scope: { include: v.include, exclude: v.exclude }, files: { count: 1, items: ['a.md'], omitted: 0 }, skipped: [], unreadable: [], enabled: false, publication: { branchPrefix: 'backup/m/', userCommitsSent: false, block: null }, destinationDigest: 'ab'.repeat(32), history: hooks.history ?? { name: 'writeflex-named-versions', state: 'complete', files: 0, bytes: 0, items: [], omitted: 0, summary: { namedVersions: 0 } } }
        : args[0] === 'enable' ? { enabled: true, root: v.path, visibility: 'private' } : { disabled: true }
      return { code: 0, stdout: JSON.stringify(answer), stderr: '' }
    },
  }
  const services = createActiveBackupServices({ make: (t) => fakePair(t), sleep: () => tick() })
  cleanups.push(() => services.dispose())
  const make = () => createBackupEnrolment({ dir, windowRoot: () => window, helperEntry: () => entry, gitCandidates: [git], gitleaksCandidates: [gitleaks], supervisor: supervisor as never, services, shortRuntimeBase: join(socketBase, 's') })
  const e = make()
  const registered = async (): Promise<string[] | null> => existsSync(join(dir, 'registrations.json')) ? JSON.parse(await readFile(join(dir, 'registrations.json'), 'utf8')).vaults.map((v: { root: string }) => v.root) : null
  const turnOn = async (folder: string) => {
    window = folder
    const p = await e.preview(1)
    if (p.state !== 'ready') throw new Error('not ready')
    return e.enable(1, { previewId: p.previewId, confirmPublic: false })
  }
  /** r5: a new app process over the same userData (the old instance is simply no longer used). */
  const restart = () => make()
  return { socketBase, base, a, b, c, e, dir, log, hooks, started, services, registered, turnOn, restart, setWindow: (r: string) => { window = r } }
}
