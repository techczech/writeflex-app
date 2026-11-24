/**
 * On a Mac without Apple's Command Line Tools `/usr/bin/git` is a stub that opens the system install dialog however it
 * is run. WriteFlex never runs that stub: it runs the concrete Git inside the active developer folder, checked on disk
 * before every launch. Without the tools, the app's whole Git sync journey (open the vault at launch, the Sync tab's
 * checks, every button, saves, the once-a-second tick, Settings and quit) starts no Git process, and the Sync tab says
 * why. Each case runs in its own Bun process because the probe mocks `electron` and `node:child_process` for it.
 */
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitPanel } from '../../src/renderer/src/sync/GitSync'
import type { GitView } from '../../src/shared/git-sync-view'
import { gitRefusal } from '../../src/backup-helper/git-refusal'

const MESSAGE = "Git sync needs Apple's Command Line Tools, which are not installed on this Mac."
const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString().trim()
/** This machine's real Git, inside its active developer folder (the test machines have the tools). */
const realGit = () => join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr', 'bin', 'git')

const probe = String.raw`
  import { mock } from 'bun:test'
  import * as original from 'node:child_process'
  // A copy: the mock below updates the module namespace in place, and the spy must reach the real functions.
  const real = { ...original }
  import { EventEmitter } from 'node:events'
  import { createHash } from 'node:crypto'
  import { renameSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
  const { scratch, vault, xcodeSelect, flag, wrapper, mode } = JSON.parse(process.env.WF_PROBE)
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
  const { registerGitSync, gitSyncSaved, changeGitSyncPreference, recheckGitTools } = await import('./src/main/git-sync-app.ts')
  const { humanAuthorForWorkspace } = await import('./src/main/versions.ts')
  const settings = new SettingsStore(join(scratch, 'settings.json'))
  await settings.set('experimental.gitVaultSync', true, 'test', { log: false })
  const id = createHash('sha256').update(vault).digest('hex')
  // Sync was on for this vault before (another session, or tools since removed): it must still not run.
  await settings.set('git-vault-sync.enabled.' + id, mode !== 'vanish', 'test')
  await settings.updateSyncVault(id, { path: vault, enabled: mode !== 'vanish' })
  const sender = Object.assign(new EventEmitter(), { id: 41, send: () => {} })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false, isFocused: () => true })
  state.workspace = { root: vault, recordOwnWrite: () => {}, exclusiveAll: (work) => work() }
  const lifecycle = registerGitSync(settings, () => {})
  lifecycle.start()
  const call = (action, value) => handlers.get('git-sync:call')({ sender }, { action, value })
  const summary = (v) => ({ discovery: v.discovery.state, gitFolder: v.gitFolder, enabled: v.result.enabled, paused: v.paused === true })
  const views = {}, out = { started, marks, views }
  views.open = summary(await call('open'))
  if (mode === 'missing') {
    views.status = summary(await call('status'))
    for (const action of ['enable', 'fetch', 'send', 'wait']) views[action] = summary(await call(action, action === 'wait' ? 10 : undefined))
    gitSyncSaved(vault, 'draft.md')
    try { await changeGitSyncPreference(id, { enabled: true }); out.turnOn = 'accepted' } catch (error) { out.turnOn = error.message }
    out.author = await humanAuthorForWorkspace(vault)
    await new Promise((resolve) => setTimeout(resolve, 1300))
    views.checkStillMissing = summary(await call('check-tools'))
    // Settings: the off switch withdraws permission now; the history release waits for Git.
    await changeGitSyncPreference(id, { enabled: false })
    views.afterOff = summary(await call('status'))
    out.enabledAfterOff = settings.get('git-vault-sync.enabled.' + id)
    out.pendingAfterOff = settings.get('git-vault-sync.release-pending.' + id)
    await lifecycle.stop()
    marks.toolsBack = started.length
    // The tools are installed; Settings' Check again refreshes the open vault and finishes the off switch.
    writeFileSync(flag, 'on')
    out.recheck = await recheckGitTools()
    views.afterRecheck = summary(await call('status'))
    out.pendingAfterRecheck = settings.get('git-vault-sync.release-pending.' + id)
  } else if (mode === 'present') {
    views.status = summary(await call('status'))
    out.author = await humanAuthorForWorkspace(vault)
    await lifecycle.stop()
  } else {
    out.authorBefore = await humanAuthorForWorkspace(vault)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // The selected developer folder loses its Git while the app runs: the earlier answer must not be trusted.
    renameSync(wrapper, wrapper + '.gone')
    marks.vanished = started.length
    out.author = await humanAuthorForWorkspace(vault)
    views.after = summary(await call('status'))
    views.enable = summary(await call('enable'))
    await lifecycle.stop()
  }
  console.log(JSON.stringify(out))
  process.exit(0)
`

type Probe = {
  started: string[][]; marks: Record<string, number>; views: Record<string, { discovery: string; gitFolder: boolean; enabled: boolean; paused: boolean }>
  turnOn?: string; author: { name: string }; authorBefore?: { name: string }; enabledAfterOff?: unknown; pendingAfterOff?: unknown; recheck?: boolean; pendingAfterRecheck?: unknown
}

async function journey(mode: 'missing' | 'present' | 'vanish') {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-no-clt-')))
  try {
    const vault = join(scratch, 'vault'), remote = join(scratch, 'remote.git'), developer = join(scratch, 'Developer')
    git(scratch, 'init', '--bare', '--initial-branch=main', remote)
    git(scratch, 'clone', remote, vault)
    git(vault, 'config', 'user.name', 'Test Mac'); git(vault, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(vault, 'draft.md'), '# Draft\n'); git(vault, 'add', '.'); git(vault, 'commit', '-m', 'Initial'); git(vault, 'push', '-u', 'origin', 'main')
    await writeFile(join(vault, 'draft.md'), '# Draft\n\nUnsent writing.\n')
    // A stand-in developer folder whose Git hands over to this machine's real one, and a stand-in xcode-select that
    // names it only while the flag file exists (otherwise Apple's "no developer directory" failure).
    const wrapper = join(developer, 'usr', 'bin', 'git'), flag = join(scratch, 'tools-installed'), xcodeSelect = join(scratch, 'xcode-select')
    await mkdir(join(developer, 'usr', 'bin'), { recursive: true })
    await writeFile(wrapper, `#!/bin/sh\nexec "${realGit()}" "$@"\n`); await chmod(wrapper, 0o755)
    if (mode !== 'missing') await writeFile(flag, 'on')
    await writeFile(xcodeSelect, `#!/bin/sh\n[ "$1" = "-p" ] || exit 0\n[ -e "${flag}" ] && { echo "${developer}"; exit 0; }\necho "xcode-select: error: unable to get active developer directory" >&2\nexit 2\n`)
    await chmod(xcodeSelect, 0o755)
    const child = Bun.spawn([process.execPath, '-e', probe], {
      cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
      env: { ...gitEnv, HOME: join(scratch, 'home'), TMPDIR: scratch, WF_PROBE: JSON.stringify({ scratch, vault, xcodeSelect, flag, wrapper, mode }) },
    })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`Probe failed (${code}): ${err}`)
    return { ...(JSON.parse(out.trim().split('\n').pop()!) as Probe), xcodeSelect, wrapper }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

const runsGit = (command: string[]) => /(^|\/)git$/.test(command[0]!) || /(^|\/)xcrun$/.test(command[0]!)
const stub = (command: string[]) => command[0]!.startsWith('/usr/bin/')

test('without the Command Line Tools: launch, Sync tab, every action, save, tick, Settings and quit start no Git process', async () => {
  const r = await journey('missing')
  const outage = r.started.slice(0, r.marks.toolsBack)
  expect(outage.filter(runsGit)).toEqual([])
  expect(outage.filter(c => c[0] === r.xcodeSelect && c[1] === '--install')).toEqual([])
  expect(outage.filter(c => c[0] === r.xcodeSelect).length).toBeGreaterThanOrEqual(1)
  for (const name of ['open', 'status', 'enable', 'fetch', 'send', 'wait', 'checkStillMissing']) expect(r.views[name]).toEqual({ discovery: 'tools-missing', gitFolder: true, enabled: false, paused: true })
  expect(r.turnOn).toBe(MESSAGE)
  expect(r.author.name).not.toBe('Test Mac')
  // Settings' off switch works during the outage; the Git-dependent history release waits.
  expect(r.views.afterOff!.paused).toBe(false)
  expect(r.enabledAfterOff).toBe(false)
  expect(r.pendingAfterOff).toBe(true)
  // Check again in Settings refreshes the open vault: it is found ready, and turning off is finished with Git.
  expect(r.recheck).toBe(true)
  expect(r.views.afterRecheck).toMatchObject({ discovery: 'ready', enabled: false, paused: false })
  expect(r.pendingAfterRecheck).toBe(false)
  expect(r.started.some(c => c[0] === r.wrapper)).toBe(true)
  expect(r.started.filter(stub)).toEqual([])
}, 90000)

test('with the Command Line Tools: the same journey runs the concrete Git, never the /usr/bin stub', async () => {
  const r = await journey('present')
  expect(r.started.some(c => c[0] === r.wrapper)).toBe(true)
  expect(r.started.filter(stub)).toEqual([])
  expect(r.views.open!.discovery).toBe('ready')
  expect(r.views.open!.gitFolder).toBe(true)
  expect(r.author.name).toBe('Test Mac')
}, 90000)

test('tools removed while the app runs: the earlier answer is not trusted and no Git starts', async () => {
  const r = await journey('vanish')
  expect(r.authorBefore!.name).toBe('Test Mac')
  expect(r.started.slice(r.marks.vanished).filter(runsGit)).toEqual([])
  expect(r.started.filter(stub)).toEqual([])
  expect(r.author.name).not.toBe('Test Mac')
  expect(r.views.after).toMatchObject({ discovery: 'tools-missing', enabled: false })
  expect(r.views.enable).toMatchObject({ discovery: 'tools-missing', enabled: false })
}, 90000)

test('Backup never runs Apple\'s stub, also through a link, and never Git looked up on PATH', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-backup-stub-')))
  try {
    const link = join(scratch, 'git'), config = (tools?: object) => { const file = join(scratch, `config-${Math.random()}.json`); return writeFile(file, JSON.stringify({ configVersion: tools ? 2 : 1, ...(tools ? { tools } : {}) })).then(() => file) }
    await symlink('/usr/bin/git', link)
    expect(gitRefusal(['run', '--config', await config({ git: link, gitleaks: '/opt/homebrew/bin/gitleaks' })])).toContain('stub')
    expect(gitRefusal(['preview', `--config=${await config({ git: '/usr/bin/git', gitleaks: 'x' })}`, '--vault', 'v'])).toContain('stub')
    expect(gitRefusal(['run', '--config', await config()])).toContain('names its Git program')
    expect(gitRefusal(['run', '--config', await config({ git: realGit(), gitleaks: 'x' })])).toBeNull()
    expect(gitRefusal(['status', '--runtime-dir', scratch])).toBeNull()
  } finally { await rm(scratch, { recursive: true, force: true }) }
})

test('the Sync tab says what is missing, offers the installer and Check again, and can turn a paused vault off', () => {
  const calls: string[] = []
  const view: GitView = {
    root: '/vault', gitFolder: true, busy: false, wait: 3, paused: true,
    discovery: { state: 'tools-missing', reason: MESSAGE },
    result: { state: 'off', enabled: false, computerName: '', pending: [], incoming: [], pairs: [], warnings: [], internalPending: [] },
  }
  const html = renderToStaticMarkup(<GitPanel controller={{ view, call: async (action) => { calls.push(action) } }} open={() => {}} />)
  expect(html).toContain(MESSAGE.replace("'", '&#x27;'))
  expect(html).toContain('Install Command Line Tools')
  expect(html).toContain('Check again')
  expect(html).toContain('Turn sync off')
  expect(html).not.toContain('Turn on sync for this vault')
})
