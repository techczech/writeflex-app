/**
 * Regression probe for the PR 298 review (run by git-sync-quit-send.test.tsx in its own Bun process, because it mocks
 * `electron`). Real controller, real settings store, real Git and gitleaks; synthetic repositories only. Each block
 * was first a reproduction of a defect; the assertions now state the fixed behaviour.
 */
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = process.cwd()
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-pr298-probe-')))
const home = join(scratch, 'home')
process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'
await mkdir(home)
process.env.HOME = home
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, stdio: 'pipe' }).toString().trim()
const developer = join(scratch, 'Developer')
const wrapper = join(developer, 'usr', 'bin', 'git')
const realGit = join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr', 'bin', 'git')
const xcodeSelect = join(scratch, 'xcode-select')
const denyPush = join(scratch, 'deny-push')
await mkdir(join(developer, 'usr', 'bin'), { recursive: true })
await writeFile(wrapper, `#!/bin/sh\nif [ -e '${denyPush}' ]; then for arg do [ "$arg" = push ] && exit 1; done; fi\nexec '${realGit}' "$@"\n`)
await writeFile(xcodeSelect, `#!/bin/sh\necho '${developer}'\n`)
await chmod(wrapper, 0o755)
await chmod(xcodeSelect, 0o755)

const { electronMainStandIn } = await import(join(root, 'tests/helpers/electron-main-stand-in.ts'))
const handlers = new Map()
mock.module('electron', () => ({ ...electronMainStandIn, app: { getPath: () => scratch, getVersion: () => '0.0.0-test', isPackaged: false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) } }))
const { developerToolsSeams } = await import(join(root, 'src/main/developer-tools.ts'))
developerToolsSeams.command = xcodeSelect
developerToolsSeams.platform = 'darwin'
const { SettingsStore } = await import(join(root, 'src/main/settings.ts'))
const { registerWindow } = await import(join(root, 'src/main/state.ts'))
const { registerGitSync, gitSyncSaved } = await import(join(root, 'src/main/git-sync-app.ts'))
let senderId = 50

async function fixture(name: string) {
  const base = join(scratch, name), vault = join(base, 'vault'), remote = join(base, 'remote.git')
  await mkdir(base)
  git(base, 'init', '--bare', '--initial-branch=main', remote)
  git(base, 'clone', remote, vault)
  git(vault, 'config', 'user.name', 'Fixture')
  git(vault, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(vault, 'draft.md'), 'Initial synthetic draft.\n')
  git(vault, 'add', 'draft.md')
  git(vault, 'commit', '-m', 'Initial synthetic draft')
  git(vault, 'push', '-u', 'origin', 'main')
  return { base, vault, remote, settingsPath: join(base, 'settings.json'), key: 'git-sync.wait.' + createHash('sha256').update(vault).digest('hex') + '.resume' }
}

function windowAt(vault: string) {
  let closed = false
  const sender = Object.assign(new EventEmitter(), { id: ++senderId, send: (channel, input) => {
    if (channel === 'git-sync:prepare') queueMicrotask(() => handlers.get('git-sync:buffers')({ sender }, { ...input, paths: [] }))
  } })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => closed, isFocused: () => true })
  state.workspace = { root: vault, recordOwnWrite: () => {}, exclusiveAll: (work) => work() }
  return { close: () => { closed = true }, call: (action) => handlers.get('git-sync:call')({ sender }, { action }) }
}

function open(f: Awaited<ReturnType<typeof fixture>>, changed = () => {}) {
  const settings = new SettingsStore(f.settingsPath)
  // Vault sync is behind its experimental switch (Settings › Advanced), off by default.
  void settings.set('experimental.gitVaultSync', true, 'test', { log: false })
  const lifecycle = registerGitSync(settings, changed)
  return { settings, lifecycle, ...windowAt(f.vault) }
}

async function idle(app, condition) {
  for (let i = 0; i < 200; i++) {
    const view = await app.call('status')
    if (!view.busy && condition(view)) return view
    await Bun.sleep(30)
  }
  throw new Error('Sync did not settle: ' + JSON.stringify(await app.call('status')))
}

async function enable(app) {
  await app.call('open')
  await app.call('enable')
  await idle(app, view => view.result.enabled && view.result.checkedAt && !view.result.reason)
}

const inspection = await fixture('failed-inspection')
const first = open(inspection)
await enable(first)
await writeFile(join(inspection.vault, 'draft.md'), 'Saved on this Mac.\n')
await first.settings.set(inspection.key, true, 'Quit interrupted', { log: false })
first.close()
git(inspection.vault, 'config', 'core.sparseCheckout', 'true')
const stopped = open(inspection)
const blocked = await stopped.call('open')
assert.equal(blocked.result.reason.code, 'unsupported')
assert.equal(blocked.result.pending.length, 0)
assert.equal(blocked.leftAtQuit, 'waiting')
assert.equal(new SettingsStore(inspection.settingsPath).get(inspection.key), true)
await idle(stopped, view => view.result.reason?.code === 'unsupported')
stopped.close()
git(inspection.vault, 'config', 'core.sparseCheckout', 'false')
const reopened = open(inspection)
const startup = await reopened.call('open')
assert.equal(startup.leftAtQuit, 'sending')
// Recovery is reported only once its intent is gone from disk: the first view that says 'sent' already finds it cleared.
for (let i = 0; i < 400 && (await reopened.call('status')).leftAtQuit !== 'sent'; i++) await Bun.sleep(10)
assert.equal(new SettingsStore(inspection.settingsPath).get(inspection.key), false)
await idle(reopened, view => view.leftAtQuit === 'sent' && view.result.pending.length === 0 && !view.result.reason)
assert.equal(git(inspection.remote, 'show', 'main:draft.md'), 'Saved on this Mac.')
reopened.close()
console.log('OK: a failed inspection kept the quit marker; the next healthy opening sent the draft and told the writer.')

const arrivals = await fixture('repeated-arrivals')
const refreshed: string[][] = []
const receiver = open(arrivals, (_state, paths) => refreshed.push(paths))
await enable(receiver)
const senderVault = join(arrivals.base, 'other')
git(arrivals.base, 'clone', arrivals.remote, senderVault)
git(senderVault, 'config', 'user.name', 'Other Fixture')
git(senderVault, 'config', 'user.email', 'other@example.invalid')
for (const text of ['First remote edit.', 'Second remote edit.']) {
  await writeFile(join(senderVault, 'draft.md'), text + '\n')
  git(senderVault, 'commit', '-am', text)
  git(senderVault, 'push')
  assert.deepEqual((await receiver.call('fetch')).result.incoming, [{ path: 'draft.md', kind: 'changed' }])
}
assert.equal(await Bun.file(join(arrivals.vault, 'draft.md')).text(), 'Second remote edit.\n')
assert.deepEqual(refreshed, [['draft.md'], ['draft.md']])
assert.deepEqual((await receiver.call('fetch')).result.incoming, [{ path: 'draft.md', kind: 'changed' }])
assert.deepEqual(refreshed, [['draft.md'], ['draft.md']])
// A receive that stops before integrating (an unsupported arrangement) refreshes nothing: no earlier arrival replays.
git(arrivals.vault, 'config', 'core.sparseCheckout', 'true')
assert.equal((await receiver.call('fetch')).result.reason?.code, 'unsupported')
assert.deepEqual(refreshed, [['draft.md'], ['draft.md']])
git(arrivals.vault, 'config', 'core.sparseCheckout', 'false')
receiver.close()
console.log('OK: each receive that changed the draft refreshed its editor; empty and stopped receives refreshed nothing.')

const overlapping = await fixture('overlapping-vaults')
const chapter = join(overlapping.vault, 'part', 'chapter')
await mkdir(chapter, { recursive: true })
await writeFile(join(chapter, 'note.md'), 'Initial nested note.\n')
git(overlapping.vault, 'add', 'part/chapter/note.md')
git(overlapping.vault, 'commit', '-m', 'Initial nested note')
git(overlapping.vault, 'push')
const parent = open(overlapping)
assert.equal((await parent.call('open')).result.enabled, false)
const nested = windowAt(chapter)
await enable(nested)
await writeFile(join(chapter, 'note.md'), 'Saved in the parent window.\n')
gitSyncSaved(overlapping.vault, 'part/chapter/note.md')
await idle(nested, view => view.editedAt !== undefined)
parent.close()
nested.close()
await parent.lifecycle.stop()
assert.equal(git(overlapping.remote, 'show', 'main:part/chapter/note.md'), 'Saved in the parent window.')
assert.equal(parent.settings.get('git-sync.wait.' + createHash('sha256').update(chapter).digest('hex') + '.resume'), false)
console.log('OK: a save under an enabled nested vault made through the parent window was sent at quit.')

const durability = await fixture('read-only-settings')
const quitting = open(durability)
await enable(quitting)
await writeFile(join(durability.vault, 'draft.md'), 'Saved before quitting.\n')
gitSyncSaved(durability.vault, 'draft.md')
await idle(quitting, view => view.result.pending.length === 1 && !!view.editedAt)
await chmod(durability.settingsPath, 0o400)
await writeFile(denyPush, '')
quitting.close()
const started = performance.now()
await quitting.lifecycle.stop()
assert.equal(quitting.settings.get(durability.key), true)
assert.equal(new SettingsStore(durability.settingsPath).get(durability.key), null)
assert.equal(git(durability.remote, 'show', 'main:draft.md'), 'Initial synthetic draft.')
const stopMs = performance.now() - started
assert.ok(stopMs < 3500, `quit took ${Math.round(stopMs)} ms`)
// Nothing is written anywhere else: no marker file in the Git folder (or the vault) that a clone could pick up.
const gitDir = git(durability.vault, 'rev-parse', '--absolute-git-dir')
assert.ok(!(await readdir(gitDir)).some(name => name.includes('quit')), 'no quit marker in the Git folder')
assert.equal(git(durability.vault, 'status', '--porcelain', '--untracked-files=all'), 'M draft.md')
await rename(denyPush, join(scratch, 'former-deny-push'))
await chmod(durability.settingsPath, 0o600)
// The next opening has no intent to go on, but the writing is shown waiting and is sent by the ordinary path.
const after = open(durability)
const reopenedView = await after.call('open')
assert.equal(reopenedView.leftAtQuit, undefined)
const waiting = await idle(after, view => view.result.pending.length === 1 && !view.result.reason)
assert.equal(waiting.result.state, 'waiting-to-send')
await after.call('send')
await idle(after, view => view.result.pending.length === 0 && !view.result.reason)
assert.equal(git(durability.remote, 'show', 'main:draft.md'), 'Saved before quitting.')
after.close()
console.log('OK: with settings read-only the intent stayed in memory only; the next opening showed the writing waiting and sent it.')

// Sibling vaults in one repository keep their own intents: turning sync off in one never clears the other's.
const siblings = await fixture('sibling-vaults')
const vaultA = join(siblings.vault, 'a'), vaultB = join(siblings.vault, 'b')
await mkdir(vaultA); await mkdir(vaultB)
await writeFile(join(vaultA, 'note.md'), 'A first.\n'); await writeFile(join(vaultB, 'note.md'), 'B first.\n')
git(siblings.vault, 'add', '.'); git(siblings.vault, 'commit', '-m', 'Two vaults'); git(siblings.vault, 'push')
const keyOf = (vault: string) => 'git-sync.wait.' + createHash('sha256').update(vault).digest('hex') + '.resume'
const host = open(siblings); host.close()
const windowA = windowAt(vaultA), windowB = windowAt(vaultB)
await enable(windowA); await enable(windowB)
await writeFile(join(vaultA, 'note.md'), 'A saved before quitting.\n')
gitSyncSaved(vaultA, 'note.md')
await idle(windowA, view => view.result.pending.length === 1 && !!view.editedAt)
await writeFile(denyPush, '')
windowA.close(); windowB.close()
await host.lifecycle.stop()
assert.equal(new SettingsStore(siblings.settingsPath).get(keyOf(vaultA)), true)
await rename(denyPush, join(scratch, 'former-deny-push-2'))
const second = open(siblings); second.close()
const againB = windowAt(vaultB)
await againB.call('open'); await againB.call('disable')
assert.equal(new SettingsStore(siblings.settingsPath).get(keyOf(vaultA)), true)
const againA = windowAt(vaultA)
assert.equal((await againA.call('open')).leftAtQuit, 'sending')
await idle(againA, view => view.leftAtQuit === 'sent' && !view.result.reason)
assert.equal(git(siblings.remote, 'show', 'main:a/note.md'), 'A saved before quitting.')
againA.close(); againB.close()
console.log('OK: turning sync off in one vault left the sibling vault its quit intent, which the next opening sent.')

// Turning sync off retires the intent: later writing is not narrated as the last quit's.
const optOut = await fixture('opt-out')
const before = open(optOut)
await enable(before)
await before.settings.set(optOut.key, true, 'Quit interrupted', { log: false })
await before.call('disable')
assert.equal(new SettingsStore(optOut.settingsPath).get(optOut.key), false)
before.close()
console.log('OK: turning sync off cleared the quit marker.')
await rm(scratch, { recursive: true, force: true })
