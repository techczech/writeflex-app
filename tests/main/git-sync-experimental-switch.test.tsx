/**
 * Git vault sync is behind an off-by-default experimental switch (Settings › Advanced, 24 Nov 2026): it is not yet
 * proven between two Macs. With the switch off, opening a vault, every Sync tab action, a save, the once-a-second tick,
 * Settings' per-vault switch and quit send and fetch nothing, and the Sync tab offers no turn-on; a vault whose own
 * sync was on is shown as held. Turning the switch on lets the same vault send. The probe runs the real app layer in
 * its own Bun process with `electron` mocked and every child process recorded, as in git-sync-without-developer-tools.
 */
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitPanel } from '../../src/renderer/src/sync/GitSync'
import type { GitView } from '../../src/shared/git-sync-view'
import { EXPERIMENTAL_GIT_SYNC_OFF } from '../../src/shared/git-sync-settings'
import { testWithGitleaks } from '../helpers/built-output'

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString().trim()
const developerFolder = () => execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim()

const probe = String.raw`
  import { mock } from 'bun:test'
  import * as original from 'node:child_process'
  const real = { ...original }
  import { EventEmitter } from 'node:events'
  import { createHash } from 'node:crypto'
  import { writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
  const { scratch, vault, xcodeSelect } = JSON.parse(process.env.WF_PROBE)
  const started = [], marks = {}
  const spy = (name) => (...args) => { started.push([String(args[0]), ...(Array.isArray(args[1]) ? args[1].map(String) : [])]); return real[name](...args) }
  const child = { ...real, spawn: spy('spawn'), spawnSync: spy('spawnSync'), execFile: spy('execFile'), execFileSync: spy('execFileSync'), exec: spy('exec'), execSync: spy('execSync') }
  mock.module('node:child_process', () => ({ ...child, default: child }))
  mock.module('child_process', () => ({ ...child, default: child }))
  const handlers = new Map()
  mock.module('electron', () => ({ ...electronMainStandIn, app: { getPath: () => scratch, getVersion: () => '0.0.0-test', isPackaged: false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) } }))
  const tools = await import('./src/main/developer-tools.ts')
  tools.developerToolsSeams.command = xcodeSelect
  tools.developerToolsSeams.platform = 'darwin'
  const { SettingsStore } = await import('./src/main/settings.ts')
  const { registerWindow } = await import('./src/main/state.ts')
  const { registerGitSync, gitSyncSaved, changeGitSyncPreference } = await import('./src/main/git-sync-app.ts')
  const settings = new SettingsStore(join(scratch, 'settings.json'))
  const id = createHash('sha256').update(vault).digest('hex')
  // This vault's own sync was turned on in an earlier build; the experimental switch is left at its default (off).
  await settings.set('git-vault-sync.enabled.' + id, true, 'test')
  await settings.updateSyncVault(id, { path: vault, enabled: true })
  const sender = Object.assign(new EventEmitter(), { id: 51, send: (channel, input) => {
    if (channel === 'git-sync:prepare') setTimeout(() => handlers.get('git-sync:buffers')({ sender }, { ...input, paths: [] }), 5)
  } })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false, isFocused: () => true })
  state.workspace = { root: vault, recordOwnWrite: () => {}, exclusiveAll: (work) => work() }
  const lifecycle = registerGitSync(settings, () => {})
  lifecycle.start()
  const call = (action, value) => handlers.get('git-sync:call')({ sender }, { action, value })
  const summary = (v) => ({ enabled: v.result.enabled, experimentalOff: v.experimentalOff === true, marker: v.syncMarker === true })
  const out = { started, marks, views: {} }
  out.views.open = summary(await call('open'))
  for (const action of ['enable', 'fetch', 'send', 'wait', 'e2e-idle']) out.views[action] = summary(await call(action, action === 'wait' ? 1 : undefined))
  gitSyncSaved(vault, 'draft.md')
  try { await changeGitSyncPreference(id, { enabled: true }); out.turnOn = 'accepted' } catch (error) { out.turnOn = error.message }
  await new Promise((resolve) => setTimeout(resolve, 1300))
  await lifecycle.stop()
  marks.switchOn = started.length
  // Next launch with the switch on: the app registers again and sync runs as before.
  await settings.set('experimental.gitVaultSync', true, 'test')
  registerGitSync(settings, () => {})
  // Switched on, the writer turns the vault on through the app (which records its repository), then sends.
  out.enabledAfterSwitch = (await call('enable')).result.enabled
  for (let i = 0; i < 200; i++) { const v = await call('status'); if (!v.busy) break; await new Promise(r => setTimeout(r, 50)) }
  const sent = await call('send')
  out.views.on = summary(sent)
  out.sent = { reason: sent.result.reason ?? null, pending: sent.result.pending, state: sent.result.state, enabled: sent.result.enabled, discovery: sent.discovery.state }
  for (let i = 0; i < 200; i++) { const v = await call('status'); if (!v.busy && !v.result.pending.length) break; await new Promise(r => setTimeout(r, 50)) }
  console.log(JSON.stringify(out))
  process.exit(0)
`

type Probe = { started: string[][]; marks: Record<string, number>; views: Record<string, { enabled: boolean; experimentalOff: boolean; marker: boolean }>; turnOn: string }

// Sending (the switched-on half) runs the secret check, so the journey needs gitleaks, like the other sync journeys.
testWithGitleaks('switched off at launch: nothing sends or fetches and the vault shows its marker; on at the next launch it sends', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-sync-switch-')))
  try {
    const vault = join(scratch, 'vault'), remote = join(scratch, 'remote.git'), xcodeSelect = join(scratch, 'xcode-select')
    git(scratch, 'init', '--bare', '--initial-branch=main', remote)
    git(scratch, 'clone', remote, vault)
    git(vault, 'config', 'user.name', 'Test Mac'); git(vault, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(vault, 'draft.md'), '# Draft\n'); git(vault, 'add', '.'); git(vault, 'commit', '-m', 'Initial'); git(vault, 'push', '-u', 'origin', 'main')
    await writeFile(join(vault, 'draft.md'), '# Draft\n\nUnsent writing.\n')
    await writeFile(xcodeSelect, `#!/bin/sh\n[ "$1" = "-p" ] || exit 0\necho "${developerFolder()}"\n`, { mode: 0o755 })
    const child = Bun.spawn([process.execPath, '-e', probe], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
      env: { ...gitEnv, HOME: join(scratch, 'home'), TMPDIR: scratch, WF_PROBE: JSON.stringify({ scratch, vault, xcodeSelect }) },
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`Probe failed (${code}): ${err}`)
    const r = JSON.parse(out.trim().split('\n').pop()!) as Probe
    const moves = (c: string[]) => /(^|\/)git$/.test(c[0]!) && c.some(a => ['push', 'fetch', 'commit', 'merge', 'pull', 'rebase', 'reset', 'checkout', 'stash'].includes(a))
    expect(r.started.slice(0, r.marks.switchOn).filter(moves)).toEqual([])
    for (const name of ['open', 'enable', 'fetch', 'send', 'wait', 'e2e-idle']) expect(r.views[name]).toEqual({ enabled: false, experimentalOff: true, marker: true })
    expect(r.turnOn).toBe(EXPERIMENTAL_GIT_SYNC_OFF)
    // Switched on at the next launch, the same vault sends.
    expect(r.views.on.experimentalOff).toBe(false)
    expect((r as any).sent.reason).toBeNull()
    expect(r.started.slice(r.marks.switchOn).some(c => c.includes('push'))).toBe(true)
    expect(git(remote, 'show', 'main:draft.md')).toBe('# Draft\n\nUnsent writing.')
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 90000)

test('switched off: the Sync tab shows the remote copy and what a save means, a marker line when sync was used, and no turn-on', () => {
  const base = { root: '/v', gitFolder: true, busy: false, wait: 3, discovery: { state: 'ready', host: 'github.com', repository: 'a/b', branch: 'main' },
    result: { enabled: false, state: 'idle', pending: [], internalPending: [], incoming: [], pairs: [], warnings: [] } } as unknown as GitView
  const controller = (view: GitView) => ({ view, call: async () => {} })
  const off = renderToStaticMarkup(<GitPanel controller={controller({ ...base, experimentalOff: true })} open={() => {}} />)
  // Issue 257's Remote copy status shows in every build; nothing offers to turn sync on.
  expect(off).toContain('aria-label="Remote copy"')
  expect(off).toContain('WriteFlex saves your writing on this Mac only and sends nothing anywhere.')
  expect(off).not.toContain('Turn on sync for this vault')
  expect(off).not.toContain('switched off (experimental)')
  const marked = renderToStaticMarkup(<GitPanel controller={controller({ ...base, experimentalOff: true, syncMarker: true })} open={() => {}} />)
  expect(marked).toContain('Vault sync with Git is switched off (experimental).')
  expect(marked).not.toContain('<button')
  // Switched on at launch: the existing offer.
  expect(renderToStaticMarkup(<GitPanel controller={controller(base)} open={() => {}} />)).toContain('Turn on sync for this vault')
})
