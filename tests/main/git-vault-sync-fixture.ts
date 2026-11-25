import { expect } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, realpath, open, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { SnapshotStore } from '@bridle/core'
import { ChangeStore } from '../../src/main/changes'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
// This import fails first until the main-process module exists; no Electron or installed app is involved.
const { createGitVaultSync } = await import('../../src/main/git-vault-sync')
const { SettingsStore } = await import('../../src/main/settings')
type Options = Parameters<typeof createGitVaultSync>[0]
/** The Git rename check is not what these tests are about: their engines report a Git that merges without rename
 *  detection, so they test their own behaviour on any Git (the Mac Studio's 2.39.5 included). Pass `renameProbe` to
 *  override; `git-vault-sync-rename-probe.test.ts` tests the real check. */
export const mergesWithoutRenames = async () => ({ honoured: true, version: 'not under test' })

export async function fixture(subfolder = false, enabled = true) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'writeflex-two-macs-')))
  const remote = join(base, 'remote.git'), a = join(base, 'mac-a'), b = join(base, 'mac-b')
  const gitEnv = { HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), ...gitEnv, GIT_TERMINAL_PROMPT: '0' }
  const git = (root: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trimEnd()
  const put = async (root: string, path: string, text: string) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
  git(base, 'init', '--bare', '--initial-branch=main', remote); git(base, 'clone', remote, a)
  git(a, 'config', 'user.name', 'Mac A'); git(a, 'config', 'user.email', 'a@example.invalid')
  const prefix = subfolder ? 'vault/' : ''
  await put(a, prefix + 'draft.md', 'The initial draft.\n'); await put(a, prefix + 'second.md', 'The second document.\n')
  await put(a, '.gitignore', 'ignored.md\n')
  if (subfolder) { await put(a, 'sibling/notes.md', 'Original sibling.\n'); await put(a, 'sibling/other.md', 'Other sibling.\n') }
  git(a, 'add', '.'); git(a, 'commit', '-m', 'Initial documents'); git(a, 'push', '-u', 'origin', 'main')
  git(base, 'clone', remote, b); git(b, 'config', 'user.name', 'Mac B'); git(b, 'config', 'user.email', 'b@example.invalid')
  const settingsA = new SettingsStore(join(base, 'a-settings.json')), settingsB = new SettingsStore(join(base, 'b-settings.json'))
  const engineA = (extra: Partial<Options> = {}) => createGitVaultSync({ settings: settingsA, computerName: 'Mac A', gitEnv, renameProbe: mergesWithoutRenames, ...extra })
  const engineB = (extra: Partial<Options> = {}) => createGitVaultSync({ settings: settingsB, computerName: 'Mac B', gitEnv, renameProbe: mergesWithoutRenames, ...extra })
  const av = subfolder ? join(a, 'vault') : a, bv = subfolder ? join(b, 'vault') : b
  const A = engineA(), B = engineB()
  if (enabled) { await A.setEnabled(av, true); await B.setEnabled(bv, true) }
  return { base, remote, a, b, av, bv, prefix, git, put, A, B, engineA, engineB, settingsA, settingsB, gitEnv, close: () => rm(base, { recursive: true, force: true }) }
}
export async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(folder: string, prefix = ''): Promise<void> {
    for (const name of (await readdir(folder)).sort()) {
      if (name === '.git') continue
      const path = join(folder, name), rel = prefix + name, st = await lstat(path)
      if (st.isDirectory()) { out[rel + '/'] = 'directory'; await walk(path, rel + '/') }
      else out[rel] = `${st.mode & 0o777}:${(await readFile(path)).toString('base64')}`
    }
  }
  await walk(root); return out
}
export async function snapshot(f: Awaited<ReturnType<typeof fixture>>, root = f.a) {
  return { tree: await tree(root), index: (await readFile(join(root, '.git/index'))).toString('base64'), head: f.git(root, 'rev-parse', 'HEAD') }
}
export async function text(root: string, path: string) { return readFile(join(root, path), 'utf8') }


// Shared app history for the internal-folder, private-history, secret and rollback cases.
export const hash = (s: string) => createHash('sha256').update(s).digest('hex')
export function running(r: import('../../src/main/git-vault-sync-types').GitVaultSyncResult) {
  expect(r.reason).toBeUndefined(); expect(r.pairs).toEqual([])
}
export const addChange = (store: ChangeStore, summary: string) => store.add({ path: 'draft.md', provenance: 'agent', editClass: 'content', summary, oldText: 'Before', newText: 'After', isCorrection: false })
export async function seed(f: Awaited<ReturnType<typeof fixture>>) {
  const ws = new Workspace(f.a), changes = new ChangeStore(ws)
  const first = await addChange(changes, 'Common change')
  const snapshots = await SnapshotStore.open({ dir: join(f.a, '.bridle'), root: f.a })
  const point = await snapshots.beginRestorePoint('Common point', 'common-session')
  const shot = await snapshots.snapshotFile(join(f.a, 'draft.md'), { sessionId: 'common-session' })
  await new VersionStore(ws).append({ id: 'v_common', path: 'draft.md', name: 'Common version', author: { name: 'Common' }, ts: 100, snapshotId: shot.id, versionId: point })
  await f.put(f.a, '.writeflex/vault.json', JSON.stringify({ version: 1, name: 'Shared writing vault', pins: [] }) + '\n')
  f.git(f.a, 'add', '.writeflex', '.bridle'); f.git(f.a, 'commit', '-m', 'Existing intentionally tracked app history'); f.git(f.a, 'push')
  running(await f.B.fetchAndIntegrate(f.bv))
  return first
}

/** Real LFS/local transport and a sparse ordinary blob; all baseline work precedes observation. */
export async function largeFiles(f: Awaited<ReturnType<typeof fixture>>, sizes = [151_000_000, 100_000_001]) {
  const paths = ['inspection.lfs', 'large.bin']
  const log = join(f.base, 'lfs-calls.txt'), filter = join(f.base, 'lfs-filter')
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  await writeFile(filter, `#!/bin/sh\nprintf '%s\\n' "$1" >> ${quote(log)}\nexec /opt/homebrew/bin/git-lfs "$@" 2>> ${quote(log)}\n`)
  await chmod(filter, 0o755)
  await writeFile(log, '')
  for (const root of [f.a, f.b]) {
    f.git(root, 'lfs', 'install', '--local')
    f.git(root, 'config', '--unset', 'filter.lfs.process')
    f.git(root, 'config', 'filter.lfs.clean', quote(filter) + ' clean -- %f')
    f.git(root, 'config', 'filter.lfs.smudge', quote(filter) + ' smudge -- %f')
    f.git(root, 'config', 'fetch.unpackLimit', '10000')
    f.git(root, 'config', 'lfs.standalonetransferagent', 'recording')
    f.git(root, 'config', 'lfs.customtransfer.recording.path', filter)
    f.git(root, 'config', 'lfs.customtransfer.recording.args', 'standalone-file')
    f.git(root, 'config', 'lfs.customtransfer.recording.concurrent', 'false')
  }
  await f.put(f.a, '.gitattributes', '*.lfs filter=lfs diff=lfs merge=lfs -text\n')
  for (let i = 0; i < paths.length; i++) {
    const file = await open(join(f.a, paths[i]), 'w')
    try { await file.truncate(sizes[i]) } finally { await file.close() }
  }
  try { f.git(f.a, 'add', '.gitattributes', ...paths) } catch (error) { throw new Error('LFS fixture setup: ' + await readFile(log, 'utf8'), { cause: error }) }
  f.git(f.a, 'commit', '-m', 'Synthetic large baselines')
  f.git(f.a, 'push'); f.git(f.b, 'pull', '--ff-only')
  const setupCalls = (await readFile(log, 'utf8')).trim().split('\n')
  expect(setupCalls).toContain('standalone-file'); expect(setupCalls).toContain('smudge')
  for (const root of [f.a, f.b]) expect((await lstat(join(root, paths[0]))).size).toBe(sizes[0])
  await writeFile(log, '')
  return { paths, sizes, log, filter, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean), reset: () => writeFile(log, '') }
}
