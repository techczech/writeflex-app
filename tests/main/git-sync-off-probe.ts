/**
 * Probe for git-sync-off.test.ts: one scenario per process (it mocks `electron`, `node:child_process` and the engine
 * factory). Vault sync with Git switched off at launch, on a synthetic vault left with an interrupted receive or a
 * forked journal: startup, a save, the periodic check and quit start no Git process, build no engine and change no
 * byte (files, index, HEAD, history flags); the Sync tab's reads change nothing either.
 * Usage: bun tests/main/git-sync-off-probe.ts <interrupted|forked>
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'bun:test'
import * as childProcess from 'node:child_process'

const real = { ...childProcess }
const started: string[][] = []
const spy = (name: keyof typeof real) => (...args: any[]) => { started.push([String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])]); return (real[name] as any)(...args) }
const child = { ...real, spawn: spy('spawn'), spawnSync: spy('spawnSync'), execFile: spy('execFile'), execFileSync: spy('execFileSync'), exec: spy('exec'), execSync: spy('execSync') }
mock.module('node:child_process', () => ({ ...child, default: child }))
mock.module('child_process', () => ({ ...child, default: child }))

const load = (file: string) => import(join(process.cwd(), file))
const { electronMainStandIn } = await load('tests/helpers/electron-main-stand-in.ts')
const handlers = new Map()
let profile = ''
mock.module(Bun.resolveSync('electron', process.cwd()), () => ({
  ...electronMainStandIn,
  app: { getPath: () => profile, getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: (name: string, fn: unknown) => handlers.set(name, fn), removeHandler: (name: string) => handlers.delete(name) },
}))
const engineFile = join(process.cwd(), 'src/main/git-vault-sync.ts')
const realEngine = { ...(await import(engineFile)) }
let built = 0
mock.module(engineFile, () => ({ ...realEngine, createGitVaultSync: (options: object) => { built++; return realEngine.createGitVaultSync({ ...options, scanner: async () => ({ findings: [] }) }) } }))
const { fixture, snapshot } = await load('tests/main/git-vault-sync-fixture.ts')
const { registerWindow } = await load('src/main/state.ts')
const { registerGitSync, gitSyncSaved, changeGitSyncPreference } = await load('src/main/git-sync-app.ts')
const { SnapshotStore } = await import(Bun.resolveSync('@bridle/core', process.cwd()))
const { createHash } = await import('node:crypto')
const clean = async () => ({ findings: [] })
const JOURNAL = '.bridle/journal.jsonl'
const gitRun = (c: string[]) => /(^|\/)(git|xcrun)$/.test(c[0]!)
const MUTATING = ['commit', 'commit-tree', 'update-ref', 'update-index', 'read-tree', 'checkout', 'reset', 'merge', 'pull', 'push', 'fetch', 'stash', 'apply', 'rm', 'mv', 'add', 'write-tree', 'hash-object']

async function interrupted(f: any) {
  await f.put(f.b, 'draft.md', 'Incoming draft from B.\n')
  await f.put(f.b, 'second.md', 'Incoming second from B.\n')
  assert.equal((await f.engineB({ scanner: clean }).send(f.bv)).reason, undefined)
  const exit = Bun.spawnSync([process.execPath, '-e', [
    'import { createGitVaultSync } from "./src/main/git-vault-sync.ts"',
    'import { SettingsStore } from "./src/main/settings.ts"',
    'const engine = createGitVaultSync({ settings: new SettingsStore(' + JSON.stringify(join(f.base, 'a-settings.json')) + '), gitEnv: ' + JSON.stringify(f.gitEnv) +
      ', checkpoint: async phase => { if (phase === "after-write") process.exit(91) } })',
    'await engine.fetchAndIntegrate(' + JSON.stringify(f.av) + ')',
  ].join('\n')])
  assert.equal(exit.exitCode, 91, exit.stderr.toString())
  assert(existsSync(join(f.a, '.git/index.writeflex-transaction.json')))
}

async function forked(f: any) {
  const sa = await SnapshotStore.open({ dir: join(f.a, '.bridle'), root: f.a })
  await sa.beginRestorePoint('Shared', 'shared')
  f.git(f.a, 'add', '-A'); f.git(f.a, 'commit', '-m', 'Seed journal'); f.git(f.a, 'push')
  f.git(f.b, 'pull', '--ff-only')
  const sb = await SnapshotStore.open({ dir: join(f.b, '.bridle'), root: f.b })
  await sb.snapshotFile(join(f.b, 'second.md'), { sessionId: 'shared' })
  await sb.beginRestorePoint('B fork', 'b')
  await sb.snapshotFile(join(f.b, 'second.md'), { sessionId: 'b' })
  f.git(f.b, 'add', '-A'); f.git(f.b, 'commit', '-m', 'Advance B journal'); f.git(f.b, 'push')
  await sa.snapshotFile(join(f.a, 'draft.md'), { sessionId: 'shared' })
  await sa.beginRestorePoint('A fork', 'a')
  await sa.snapshotFile(join(f.a, 'draft.md'), { sessionId: 'a' })
  await f.put(f.a, 'draft.md', 'A written before the switch existed.\n')
  assert.equal((await f.engineA({ scanner: clean }).send(f.av)).reason, undefined)
  assert.match(f.git(f.a, 'ls-files', '-v', '--', JOURNAL), /^S /)
}

const name = process.argv[2]!
const f = await fixture()
try {
  await ({ interrupted, forked } as Record<string, (f: any) => Promise<void>>)[name]!(f)
  profile = f.base
  // A later edit on this Mac, saved while vault sync is switched off.
  await f.put(f.a, 'draft.md', 'Written with vault sync switched off.\n')
  const before = { ...(await snapshot(f)), flags: f.git(f.a, 'ls-files', '-v'), remote: f.git(f.remote, 'rev-parse', 'refs/heads/main'), transaction: existsSync(join(f.a, '.git/index.writeflex-transaction.json')) }
  assert.notEqual(f.settingsA.get('experimental.gitVaultSync'), true)
  const mark = started.length, engines = built
  // Startup, the periodic check, a save, a refused turn-on in Settings, and quit.
  const sender = Object.assign(new EventEmitter(), { id: 77, send: () => {} })
  const state = registerWindow({ webContents: sender, on() {}, isDestroyed: () => false, isFocused: () => true })
  state.workspace = { root: f.av, recordOwnWrite() {}, exclusiveAll: (work: () => unknown) => work() }
  const lifecycle = registerGitSync(f.settingsA, () => {})
  lifecycle.start()
  gitSyncSaved(f.av, 'draft.md')
  await Bun.sleep(1300)
  let refused = ''
  try { await changeGitSyncPreference(createHash('sha256').update(f.av).digest('hex'), { enabled: true }) } catch (error) { refused = (error as Error).message }
  await lifecycle.stop()
  const lifecycleGit = started.slice(mark).filter(gitRun)
  // The Sync tab: open, status and every action the panel or a command could send.
  const views = [] as any[]
  for (const action of ['open', 'status', 'enable', 'send', 'fetch', 'disable', 'wait', 'done', 'e2e-idle']) views.push(await handlers.get('git-sync:call')({ sender }, { action, value: action === 'wait' ? 1 : undefined }))
  await Bun.sleep(500)
  const tabMutating = started.slice(mark).filter(gitRun).filter(c => c.some(a => MUTATING.includes(a)))
  const after = { ...(await snapshot(f)), flags: f.git(f.a, 'ls-files', '-v'), remote: f.git(f.remote, 'rev-parse', 'refs/heads/main'), transaction: existsSync(join(f.a, '.git/index.writeflex-transaction.json')) }
  assert.deepEqual(lifecycleGit, [], 'startup, save, check and quit start no Git process')
  assert.deepEqual(tabMutating, [], 'the Sync tab runs no Git command that writes')
  assert.equal(built, engines, 'no sync engine is built')
  assert.deepEqual(after, before, 'files, index, HEAD, history flags, remote and transaction unchanged')
  assert(views.every(v => v.experimentalOff === true && v.result.enabled === false && v.syncMarker === true))
  assert.match(refused, /switched off \(experimental\)/)
  // A forked vault: a history save in a fresh app process and in a fresh command line, both with sync switched off,
  // starting from the canonical journal live and a distinct private safety copy.
  const history: string[] = []
  if (name === 'forked') {
    const { readFile, writeFile } = await import('node:fs/promises')
    const journal = join(f.a, JOURNAL)
    const safety = join(f.a, '.git/writeflex-live-history', createHash('sha256').update(JOURNAL).digest('hex') + '.jsonl')
    const safetyBytes = await readFile(safety)
    const canonical = real.execFileSync('/usr/bin/git', ['show', 'HEAD:' + JOURNAL], { cwd: f.a })
    assert(!canonical.equals(safetyBytes))
    for (const mode of ['app', 'cli']) {
      await writeFile(safety, safetyBytes)
      await writeFile(journal, canonical)
      const run = Bun.spawnSync([process.execPath, 'tests/main/git-sync-off-history-child.ts', mode, f.a, f.base], { env: { ...process.env, ...f.gitEnv } })
      assert.equal(run.exitCode, 0, mode + ': ' + run.stderr.toString() + run.stdout.toString())
      assert.equal(f.git(f.remote, 'rev-parse', 'refs/heads/main'), before.remote)
      assert.equal(f.git(f.a, 'ls-files', '-v'), before.flags)
      history.push(mode)
    }
  }
  console.log(JSON.stringify({ scenario: name, result: { gitProcesses: lifecycleGit.length, writes: tabMutating.length, engines: built - engines, unchanged: true, marker: true, ...(history.length ? { history } : {}) } }))
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await f.close() }
process.exit()
