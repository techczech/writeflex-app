import { expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncGit, type GitOutput } from '../../src/main/git-vault-sync-git'
import { measureSyncGitRenames, probeRenameMerging, readSyncGitVersion, syncGitRenameVerdict, type ProbeGit } from '../../src/main/git-vault-sync-rename-probe'
import { stopSentence } from '../../src/shared/git-sync-view'
import { fixture, snapshot } from './git-vault-sync-fixture'

const OLD_GIT = '2.39.5 (Apple Git-154)'
const NEW_GIT = '2.54.0 (Apple Git-157)'
const cleanScanner = async (): Promise<{ findings: [] }> => ({ findings: [] })
const isolated = (folder: string) => ({ HOME: folder, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
type Behaviour = 'old' | 'honoured' | 'empty-conflict' | 'killed'

/**
 * A probe runner: the real Git runs every probe step except the merge, whose answer is chosen.
 * old       — Git 2.39.5: merge-tree without `merge.renames=false`, so any Git detects the rename as 2.39.5 does.
 * honoured  — the result an honouring Git gives: a modify/delete conflict at before.md, both blobs kept.
 * empty-conflict / killed — results that decide nothing (exit 1 with no output; a killed Git).
 */
function probeGit(folder: string, behaviour: Behaviour): ProbeGit {
  const real = syncGit(folder, isolated(folder))
  const output = (code: number, out = ''): GitOutput => ({ code, out: Buffer.from(out), rejected: false, auth: false })
  return {
    ok: real.ok,
    text: async (args, extra) => (args[0] === '--version' ? `git version ${behaviour === 'old' ? OLD_GIT : NEW_GIT}` : real.text(args, extra)),
    run: async (args, extra, input) => {
      if (!args.includes('merge-tree')) return real.run(args, extra, input)
      if (behaviour === 'old') return real.run(args.filter((arg, i) => arg !== 'merge.renames=false' && args[i + 1] !== 'merge.renames=false'), extra, input)
      if (behaviour === 'empty-conflict') return output(1)
      if (behaviour === 'killed') return output(-1)
      const [renamed, edit] = args.slice(-2)
      const original = await real.text(['rev-parse', `${renamed}:after.md`]), edited = await real.text(['rev-parse', `${edit}:before.md`])
      const tree = (await real.ok(['mktree'], undefined, Buffer.from(`100644 blob ${original}\tafter.md\n100644 blob ${edited}\tbefore.md\n`))).toString().trim()
      return output(1, `${tree}\0before.md\0\0CONFLICT (modify/delete): before.md deleted in one side and modified in the other.\0`)
    },
  }
}
async function probeIn(behaviour: Behaviour) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-probe-test-')))
  const template = join(folder, 'template'), repo = join(folder, 'repo')
  try { await mkdir(template); await mkdir(repo); return await probeRenameMerging(probeGit(repo, behaviour), template) }
  finally { await rm(folder, { recursive: true, force: true }) }
}

test('only a recognised merge result decides: 2.39.5 behaviour is unsafe, the kept conflict is safe, anything else is retried', async () => {
  expect(await probeIn('old')).toEqual({ honoured: false, version: OLD_GIT })
  expect(await probeIn('honoured')).toEqual({ honoured: true, version: NEW_GIT })
  await expect(probeIn('empty-conflict')).rejects.toThrow('no tree')
  await expect(probeIn('killed')).rejects.toThrow('no tree')
}, 30_000)

test('the verdict is keyed on the version read before every operation, and a failed measurement is not kept', async () => {
  let version = 'cache test 1', measured = 0, failing = true
  const using = {
    version: async () => version,
    measure: async () => { measured++; if (failing) throw new Error('Git did not finish in time.'); return { honoured: version.endsWith('2'), version } },
  }
  await expect(syncGitRenameVerdict(using)).rejects.toThrow('in time')
  failing = false
  expect(await syncGitRenameVerdict(using)).toEqual({ honoured: false, version: 'cache test 1' })
  expect(await syncGitRenameVerdict(using)).toEqual({ honoured: false, version: 'cache test 1' })
  expect(measured).toBe(2)
  version = 'cache test 2' // the developer tools changed while the app ran
  expect(await syncGitRenameVerdict(using)).toEqual({ honoured: true, version: 'cache test 2' })
  expect(measured).toBe(3)
})

test('a verdict measured on a different Git than the version read is never accepted or cached', async () => {
  let measured = 0, ran = NEW_GIT
  const using = {
    version: async () => `git version ${OLD_GIT}`, // the cache key: Apple's Git 2.39.5
    measure: async () => { measured++; return { honoured: ran === NEW_GIT, version: ran } }, // the tools switched mid-check
  }
  await expect(syncGitRenameVerdict(using)).rejects.toThrow('Git changed while it was checked')
  await expect(syncGitRenameVerdict(using)).rejects.toThrow('Git changed while it was checked')
  expect(measured).toBe(2) // not cached: the old Git is measured again
  ran = OLD_GIT
  expect(await syncGitRenameVerdict(using)).toEqual({ honoured: false, version: OLD_GIT })
  expect(await syncGitRenameVerdict(using)).toEqual({ honoured: false, version: OLD_GIT })
  expect(measured).toBe(3)
})

test("the production measurement ignores the user's Git configuration, templates and hooks", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-hostile-home-')))
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  try {
    const template = join(home, 'template'), marker = join(home, 'template-used')
    await mkdir(join(template, 'hooks'), { recursive: true })
    await writeFile(join(template, 'marker'), 'copied from the user template\n')
    await writeFile(join(template, 'hooks', 'post-checkout'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 })
    const config = `[init]\n\ttemplateDir = ${template}\n\tdefaultBranch = bad ref\n[core]\n\thooksPath = ${join(template, 'hooks')}\n`
    await writeFile(join(home, '.gitconfig'), config)
    await mkdir(join(home, 'git'), { recursive: true }); await writeFile(join(home, 'git', 'config'), config)
    process.env.HOME = home; process.env.XDG_CONFIG_HOME = home
    const version = await readSyncGitVersion()
    expect(version).toMatch(/^git version /)
    const verdict = await measureSyncGitRenames()
    expect(verdict.version).toBe(version.replace(/^git version\s*/, ''))
    expect(typeof verdict.honoured).toBe('boolean')
    await expect(lstat(marker)).rejects.toThrow()
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await rm(home, { recursive: true, force: true })
  }
}, 30_000)

test('on a Git that detects renames anyway, every operation stops with the version named and merges nothing', async () => {
  const f = await fixture()
  const oldGit = async () => ({ honoured: false, version: OLD_GIT })
  const A = f.engineA({ scanner: cleanScanner, renameProbe: oldGit })
  try {
    await writeFile(join(f.bv, 'second.md'), 'Mac B edited the second document.\n')
    expect((await f.engineB({ scanner: cleanScanner }).send(f.bv)).state).toBe('up-to-date')
    await writeFile(join(f.av, 'draft.md'), 'Mac A edited the draft.\n')
    const remoteBefore = f.git(f.remote, 'rev-parse', 'main'), before = await snapshot(f)
    for (const result of [await A.send(f.av), await A.fetchAndIntegrate(f.av), await A.status(f.av)]) {
      expect(result.state).toBe('stopped')
      expect(result.reason?.code).toBe('git-renames')
      expect(result.reason?.message).toContain(`version ${OLD_GIT}`)
      expect(stopSentence(result.reason!)).toBe(result.reason!.message)
    }
    expect(await snapshot(f)).toEqual(before)
    expect(f.git(f.remote, 'rev-parse', 'main')).toBe(remoteBefore)
    // Updated developer tools: the next operation checks again and the stop clears.
    expect((await f.engineA({ scanner: cleanScanner }).status(f.av)).reason).toBeUndefined()
  } finally { await f.close() }
}, 60_000)

/** Mac A's receive exits the process after its first apply write: an interrupted transaction is left on disk. */
async function interruptedReceive(f: Awaited<ReturnType<typeof fixture>>): Promise<number | null> {
  const source = `import { createGitVaultSync } from ${JSON.stringify(join(process.cwd(), 'src/main/git-vault-sync.ts'))};
    import { SettingsStore } from ${JSON.stringify(join(process.cwd(), 'src/main/settings.ts'))};
    const engine = createGitVaultSync({ settings: new SettingsStore(${JSON.stringify(join(f.base, 'a-settings.json'))}), computerName: 'Mac A',
      gitEnv: ${JSON.stringify(f.gitEnv)}, scanner: async () => ({ findings: [] }), renameProbe: async () => ({ honoured: true, version: 'not under test' }),
      checkpoint: async phase => { if (phase === 'after-write') process.exit(91) } });
    const result = await engine.fetchAndIntegrate(${JSON.stringify(f.av)}); process.exit(result.reason ? 2 : 0);`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('interrupted receive timed out')) }, 30_000)
    child.on('close', (exit) => { clearTimeout(timer); resolve(exit) })
  })
}

test('with an interrupted transaction on disk, a Git that detects renames recovers, cleans and merges nothing', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.bv, 'draft.md'), 'Mac B changed the draft.\n'); await writeFile(join(f.bv, 'second.md'), 'Mac B changed the second.\n')
    expect((await f.engineB({ scanner: cleanScanner }).send(f.bv)).state).toBe('up-to-date')
    expect(await interruptedReceive(f)).toBe(91)
    const gitDir = join(f.a, '.git')
    const transaction = (await readdir(gitDir)).filter((name) => name.includes('writeflex-transaction'))
    expect(transaction.length).toBeGreaterThan(0)
    const before = await snapshot(f)
    const A = f.engineA({ scanner: cleanScanner, renameProbe: async () => ({ honoured: false, version: OLD_GIT }) })
    for (const result of [await A.status(f.av), await A.fetchAndIntegrate(f.av), await A.send(f.av)]) expect(result.reason?.code).toBe('git-renames')
    expect(await snapshot(f)).toEqual(before)
    expect((await readdir(gitDir)).filter((name) => name.includes('writeflex-transaction'))).toEqual(transaction)
    // With a Git that merges safely, the next operation finishes the interrupted receive as before.
    expect((await f.engineA({ scanner: cleanScanner }).fetchAndIntegrate(f.av)).reason).toBeUndefined()
    expect((await readdir(gitDir)).filter((name) => name.includes('writeflex-transaction'))).toEqual([])
  } finally { await f.close() }
}, 120_000)
