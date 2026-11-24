/**
 * Child of git-sync-off-probe.ts (forked scenario): a fresh process with vault sync switched off makes one history save
 * through the app's path (registerGitSync, then a gated restore point) or the command line's (save-version, after the
 * command line has read the launch switch). The save is an ordinary local append: the live journal keeps its bytes and
 * only grows, and the Git-side safety copy is byte-identical. Adapted from the review of PR 319.
 * Usage: bun tests/main/git-sync-off-history-child.ts <app|cli> <vault> <profile>
 */
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mock } from 'bun:test'
import * as original from 'node:child_process'

const real = { ...original }
const gitCommands: string[] = []
const intercepted = (name: keyof typeof real) => (...args: any[]) => {
  if (/(^|\/)git$/.test(String(args[0]))) gitCommands.push(String(args[1]?.at(-1)))
  return (real[name] as any)(...args)
}
const child = { ...real, spawn: intercepted('spawn'), execFile: intercepted('execFile'), spawnSync: intercepted('spawnSync'), execFileSync: intercepted('execFileSync') }
mock.module('node:child_process', () => ({ ...child, default: child }))
const [mode, vault, profile] = process.argv.slice(2) as [string, string, string]
const root = process.cwd()
const { electronMainStandIn } = await import(join(root, 'tests/helpers/electron-main-stand-in.ts'))
mock.module(Bun.resolveSync('electron', root), () => ({
  ...electronMainStandIn,
  app: { getPath: () => profile, getVersion: () => '0.0.0-test', isPackaged: false },
  ipcMain: { handle: () => {} },
}))
const { SettingsStore } = await import(join(root, 'src/main/settings.ts'))
const settings = new SettingsStore(join(profile, 'a-settings.json'))
assert.notEqual(settings.get('experimental.gitVaultSync'), true)
const name = '.bridle/journal.jsonl'
const journal = join(vault, name)
const backup = join(vault, '.git/writeflex-live-history', createHash('sha256').update(name).digest('hex') + '.jsonl')
const priorJournal = await readFile(journal)
const priorBackup = await readFile(backup)
assert(!priorJournal.equals(priorBackup), 'fixture starts with the canonical journal live and a distinct private copy')
if (mode === 'app') {
  const { registerGitSync } = await import(join(root, 'src/main/git-sync-app.ts'))
  registerGitSync(settings, () => {}).start()
  const { gatedSnapshots } = await import(join(root, 'src/main/gated-snapshots.ts'))
  const { SnapshotStore } = await import(Bun.resolveSync('@bridle/core', root))
  const store = await SnapshotStore.open({ dir: join(vault, '.bridle'), root: vault })
  await gatedSnapshots(vault, store).beginRestorePoint('Local save with sync off', 'off')
} else {
  // As writeflex-cli.ts does before any command: the launch switch from the profile (off here).
  const { setSyncAppendProtection, syncSwitchedOnIn } = await import(join(root, 'src/main/git-vault-sync-private-history.ts'))
  setSyncAppendProtection(syncSwitchedOnIn(profile))
  const { saveVersionFromCommandLine } = await import(join(root, 'src/main/cli/history-store.ts'))
  const { Workspace } = await import(join(root, 'src/main/workspace.ts'))
  await saveVersionFromCommandLine(new Workspace(vault), async () => {}, { path: 'draft.md', name: 'Command-line save with sync off', author: { name: 'Synthetic writer' } })
}
const nextJournal = await readFile(journal)
const nextBackup = await readFile(backup)
assert(nextJournal.length > priorJournal.length, 'the save appended to the journal')
assert(nextJournal.subarray(0, priorJournal.length).equals(priorJournal), 'the live journal kept its bytes: nothing was restored over it')
assert(nextBackup.equals(priorBackup), 'the Git-side safety copy is byte-identical')
console.log(JSON.stringify({ mode, appendedOnly: true, safetyCopyUnchanged: true, gitCommands }))
process.exit()
