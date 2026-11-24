/**
 * Guards ADR-0055 "normal quit gives sends a three-second total opportunity": the last save before a normal quit is
 * sent by the bounded quit attempt, or, when the attempt cannot finish in time, it is sent on the next opening of the
 * vault and the writer is told. Timing is injected, not hoped for: a Git stand-in hangs `push` while a flag file
 * exists, so the quit attempt cannot finish within its bound on any machine.
 *
 * The app layer (`registerGitSync`) runs for real in its own Bun process with `electron` mocked, as in
 * `git-sync-without-developer-tools.test.tsx`; each process is one launch of the app, sharing one settings file.
 */
import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { GitMark, GitPanel } from '../../src/renderer/src/sync/GitSync'
import { leftAtQuitSentence, type GitView } from '../../src/shared/git-sync-view'
import { testWithGitleaks } from '../helpers/built-output'

const gitEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }
const git = (cwd: string, ...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, env: gitEnv, stdio: 'pipe' }).toString().trim()
const realGit = () => join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr', 'bin', 'git')

const probe = String.raw`
  import { mock } from 'bun:test'
  import { EventEmitter } from 'node:events'
  import { createHash } from 'node:crypto'
  import { writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
  const { scratch, vault, xcodeSelect, mode, text } = JSON.parse(process.env.WF_PROBE)
  const handlers = new Map()
  mock.module('electron', () => ({ ...electronMainStandIn, app: { getPath: () => scratch, getVersion: () => '0.0.0-test', isPackaged: false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) } }))
  const tools = await import('./src/main/developer-tools.ts')
  tools.developerToolsSeams.command = xcodeSelect
  tools.developerToolsSeams.platform = 'darwin'
  const { SettingsStore } = await import('./src/main/settings.ts')
  const { registerWindow } = await import('./src/main/state.ts')
  const { registerGitSync, gitSyncSaved } = await import('./src/main/git-sync-app.ts')
  const settings = new SettingsStore(join(scratch, 'settings.json'))
  await settings.set('experimental.gitVaultSync', true, 'test', { log: false })
  const id = createHash('sha256').update(vault).digest('hex')
  // The window's renderer answers the unsaved-buffer handshake with nothing unsaved, until the window has closed.
  let closed = false
  const sender = Object.assign(new EventEmitter(), { id: 7, send: (channel, input) => {
    if (channel === 'git-sync:prepare') setTimeout(() => handlers.get('git-sync:buffers')({ sender }, { ...input, paths: [] }), 5)
  } })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => closed, isFocused: () => true })
  state.workspace = { root: vault, recordOwnWrite: () => {}, exclusiveAll: (work) => work() }
  const lifecycle = registerGitSync(settings, () => {})
  const call = (action, value) => handlers.get('git-sync:call')({ sender }, { action, value })
  const settle = async (until) => { for (let i = 0; i < 600; i++) { const v = await call('status'); if (until(v)) return v; await new Promise(r => setTimeout(r, 50)) } throw new Error('Sync did not settle: ' + JSON.stringify({ ...(await call('status')), progress: undefined })) }
  const out = {}
  const opened = await call('open')
  out.openedLeftAtQuit = opened.leftAtQuit ?? null
  // First launch: the writer turns sync on in the Sync tab.
  if (mode !== 'reopen') await call('enable')
  // The opening's own check has run (it records when it last checked) and finished.
  if (mode !== 'reopen') await settle(v => !v.busy && v.result.checkedAt !== undefined)
  if (mode === 'nested') {
    // A second window shows a Collection inside the vault; the writer saves there last, then quits.
    let nestedClosed = false
    const nestedSender = Object.assign(new EventEmitter(), { id: 9, send: (channel, input) => {
      if (channel === 'git-sync:prepare') setTimeout(() => handlers.get('git-sync:buffers')({ sender: nestedSender }, { ...input, paths: [] }), 5)
    } })
    const nested = registerWindow({ webContents: nestedSender, on: () => {}, isDestroyed: () => nestedClosed, isFocused: () => false })
    nested.workspace = { root: join(vault, 'chapter'), recordOwnWrite: () => {}, exclusiveAll: (work) => work() }
    await handlers.get('git-sync:call')({ sender: nestedSender }, { action: 'open' })
    await writeFile(join(vault, 'chapter', 'note.md'), text)
    gitSyncSaved(join(vault, 'chapter'), 'note.md')
    for (let i = 0; i < 40 && (await call('status')).editedAt === undefined; i++) await new Promise(r => setTimeout(r, 50))
    out.parentEditedAt = (await call('status')).editedAt ?? null
    closed = true; nestedClosed = true
    await lifecycle.stop()
  } else if (mode === 'quit') {
    // The writer's last save before quitting.
    await writeFile(join(vault, 'draft.md'), text)
    gitSyncSaved(vault, 'draft.md')
    await settle(v => !v.busy && v.editedAt !== undefined && v.result.pending.length === 1)
    // Quit: the window has closed, then the network stalls for longer than the quit attempt may wait.
    closed = true
    await writeFile(join(scratch, 'hang-push'), '')
    const started = performance.now()
    await lifecycle.stop()
    out.stopMs = performance.now() - started
    out.resume = settings.get('git-sync.wait.' + createHash('sha256').update(vault).digest('hex') + '.resume')
  } else {
    const sent = await settle(v => !v.busy && v.leftAtQuit === 'sent')
    out.sent = { leftAtQuit: sent.leftAtQuit, pending: sent.result.pending.length, state: sent.result.state }
    out.resume = settings.get('git-sync.wait.' + createHash('sha256').update(vault).digest('hex') + '.resume')
    await lifecycle.stop()
  }
  console.log(JSON.stringify(out))
  process.exit(0)
`

async function launch(scratch: string, vault: string, xcodeSelect: string, mode: 'quit' | 'reopen' | 'nested', text = '') {
  const child = Bun.spawn([process.execPath, '-e', probe], {
    cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
    env: { ...gitEnv, HOME: join(scratch, 'home'), TMPDIR: scratch, WF_PROBE: JSON.stringify({ scratch, vault, xcodeSelect, mode, text }) },
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Probe ${mode} failed (${code}): ${err}`)
  return JSON.parse(out.trim().split('\n').pop()!) as { openedLeftAtQuit: string | null; stopMs?: number; resume: unknown; sent?: { leftAtQuit: string; pending: number; state: string } }
}

testWithGitleaks('a quit that cannot send in time leaves the last save to the next opening, which sends it and tells the writer', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-quit-send-')))
  try {
    const vault = join(scratch, 'vault'), remote = join(scratch, 'remote.git'), developer = join(scratch, 'Developer')
    await mkdir(join(scratch, 'home'))
    git(scratch, 'init', '--bare', '--initial-branch=main', remote)
    git(scratch, 'clone', remote, vault)
    git(vault, 'config', 'user.name', 'Test Mac'); git(vault, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(vault, 'draft.md'), '# Draft\n\nEarlier writing.\n'); git(vault, 'add', '.'); git(vault, 'commit', '-m', 'Initial'); git(vault, 'push', '-u', 'origin', 'main')
    // The Git stand-in: `push` never finishes while the flag file exists (the quit's network stall).
    const wrapper = join(developer, 'usr', 'bin', 'git'), xcodeSelect = join(scratch, 'xcode-select'), flag = join(scratch, 'hang-push')
    await mkdir(join(developer, 'usr', 'bin'), { recursive: true })
    await writeFile(wrapper, `#!/bin/sh\nif [ -e "${flag}" ]; then for a in "$@"; do [ "$a" = push ] && exec /bin/sleep 30; done; fi\nexec "${realGit()}" "$@"\n`); await chmod(wrapper, 0o755)
    await writeFile(xcodeSelect, `#!/bin/sh\n[ "$1" = "-p" ] || exit 0\necho "${developer}"\n`); await chmod(xcodeSelect, 0o755)

    const last = '# Draft\n\nSaved just before quitting.\n'
    const quit = await launch(scratch, vault, xcodeSelect, 'quit', last)
    // The quit stayed within its bound, did not send, and left its next-open mark.
    expect(quit.stopMs!).toBeLessThan(3500)
    expect(git(remote, 'show', 'main:draft.md')).toBe('# Draft\n\nEarlier writing.')
    expect(quit.resume).toBe(true)

    await unlink(flag)
    const reopened = await launch(scratch, vault, xcodeSelect, 'reopen')
    // Opening the vault again tells the writer at once, sends the save, then says it was sent.
    expect(reopened.openedLeftAtQuit).toBe('sending')
    expect(reopened.sent).toEqual({ leftAtQuit: 'sent', pending: 0, state: 'up-to-date' })
    expect(git(remote, 'show', 'main:draft.md')).toBe(last.trimEnd())
    expect(reopened.resume).toBe(false)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 120000)

testWithGitleaks('a quit mark whose writing did reach the other copy is cleared without a notice', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-quit-sent-')))
  try {
    const vault = join(scratch, 'vault'), remote = join(scratch, 'remote.git'), developer = join(scratch, 'Developer')
    await mkdir(join(scratch, 'home'))
    git(scratch, 'init', '--bare', '--initial-branch=main', remote)
    git(scratch, 'clone', remote, vault)
    git(vault, 'config', 'user.name', 'Test Mac'); git(vault, 'config', 'user.email', 'test@example.invalid')
    await writeFile(join(vault, 'draft.md'), '# Draft\n'); git(vault, 'add', '.'); git(vault, 'commit', '-m', 'Initial'); git(vault, 'push', '-u', 'origin', 'main')
    const wrapper = join(developer, 'usr', 'bin', 'git'), xcodeSelect = join(scratch, 'xcode-select')
    await mkdir(join(developer, 'usr', 'bin'), { recursive: true })
    await writeFile(wrapper, `#!/bin/sh\nexec "${realGit()}" "$@"\n`); await chmod(wrapper, 0o755)
    await writeFile(xcodeSelect, `#!/bin/sh\n[ "$1" = "-p" ] || exit 0\necho "${developer}"\n`); await chmod(xcodeSelect, 0o755)
    // The quit's send outlived the quit and finished: its mark remains, but nothing is waiting.
    const quit = await launch(scratch, vault, xcodeSelect, 'quit', '# Draft\n\nSent at quit.\n')
    expect(quit.resume).toBe(false)
    expect(git(remote, 'show', 'main:draft.md')).toBe('# Draft\n\nSent at quit.')
    const { SettingsStore } = await import('../../src/main/settings')
    const { createHash } = await import('node:crypto')
    const settings = new SettingsStore(join(scratch, 'settings.json'))
    await settings.set('git-sync.wait.' + createHash('sha256').update(vault).digest('hex') + '.resume', true, 'test', { log: false })
    const child = Bun.spawn([process.execPath, '-e', `
      import { mock } from 'bun:test'
      import { EventEmitter } from 'node:events'
      import { join } from 'node:path'
      import { electronMainStandIn } from './tests/helpers/electron-main-stand-in.ts'
      const { scratch, vault, xcodeSelect } = JSON.parse(process.env.WF_PROBE)
      const handlers = new Map()
      mock.module('electron', () => ({ ...electronMainStandIn, app: { getPath: () => scratch, getVersion: () => '0.0.0-test', isPackaged: false }, ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: () => {} } }))
      const tools = await import('./src/main/developer-tools.ts'); tools.developerToolsSeams.command = xcodeSelect; tools.developerToolsSeams.platform = 'darwin'
      const { SettingsStore } = await import('./src/main/settings.ts'); const { registerWindow } = await import('./src/main/state.ts'); const { registerGitSync } = await import('./src/main/git-sync-app.ts')
      const settings = new SettingsStore(join(scratch, 'settings.json'))
      const sender = Object.assign(new EventEmitter(), { id: 8, send: (channel, input) => { if (channel === 'git-sync:prepare') setTimeout(() => handlers.get('git-sync:buffers')({ sender }, { ...input, paths: [] }), 5) } })
      const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false, isFocused: () => true })
      state.workspace = { root: vault, recordOwnWrite: () => {}, exclusiveAll: (work) => work() }
      registerGitSync(settings, () => {})
      const view = await handlers.get('git-sync:call')({ sender }, { action: 'open' })
      // The intent is cleared once the opening's own send has confirmed nothing is left; the writer is told nothing.
      let later = view
      for (let i = 0; i < 200 && (later.busy || settings.get(process.env.WF_KEY) !== false); i++) { await new Promise(r => setTimeout(r, 50)); later = await handlers.get('git-sync:call')({ sender }, { action: 'status' }) }
      console.log(JSON.stringify({ leftAtQuit: view.leftAtQuit ?? later.leftAtQuit ?? null, resume: settings.get(process.env.WF_KEY) }))
      process.exit(0)
    `], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
      env: { ...gitEnv, HOME: join(scratch, 'home'), TMPDIR: scratch, WF_KEY: 'git-sync.wait.' + createHash('sha256').update(vault).digest('hex') + '.resume', WF_PROBE: JSON.stringify({ scratch, vault, xcodeSelect }) } })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(err)
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual({ leftAtQuit: null, resume: false })
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 120000)

test('the Sync tab and its mark say when writing from the last quit is being sent, and when it has been', () => {
  const view = (leftAtQuit: 'sending' | 'waiting' | 'sent', pending: number): GitView => ({
    root: '/vault', gitFolder: true, busy: false, wait: 3, leftAtQuit,
    discovery: { state: 'ready', host: 'local', repository: 'remote', branch: 'main', localPath: '/remote.git' } as GitView['discovery'],
    result: { state: pending ? 'waiting-to-send' : 'up-to-date', enabled: true, computerName: 'Test Mac', pending: pending ? [{ path: 'draft.md', kind: 'changed' }] : [], incoming: [], pairs: [], warnings: [], internalPending: [] },
  })
  const controller = (v: GitView) => ({ view: v, call: async () => {} })
  expect(renderToStaticMarkup(<GitPanel controller={controller(view('sending', 1))} open={() => {}} />)).toContain(leftAtQuitSentence.sending)
  expect(renderToStaticMarkup(<GitMark controller={controller(view('sending', 1))} onOpen={() => {}} />)).toContain(leftAtQuitSentence.sending)
  expect(renderToStaticMarkup(<GitPanel controller={controller(view('sent', 0))} open={() => {}} />)).toContain(leftAtQuitSentence.sent)
  expect(renderToStaticMarkup(<GitMark controller={controller(view('sent', 0))} onOpen={() => {}} />)).toContain(leftAtQuitSentence.sent)
  expect(renderToStaticMarkup(<GitPanel controller={controller(view('waiting', 1))} open={() => {}} />)).toContain(leftAtQuitSentence.waiting)
})

testWithGitleaks('the last save in a nested Collection window before quitting is sent by the vault that contains it', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'wf-quit-nested-')))
  try {
    const vault = join(scratch, 'vault'), remote = join(scratch, 'remote.git'), developer = join(scratch, 'Developer')
    await mkdir(join(scratch, 'home'))
    git(scratch, 'init', '--bare', '--initial-branch=main', remote)
    git(scratch, 'clone', remote, vault)
    git(vault, 'config', 'user.name', 'Test Mac'); git(vault, 'config', 'user.email', 'test@example.invalid')
    await mkdir(join(vault, 'chapter')); await writeFile(join(vault, 'chapter', 'note.md'), 'Earlier note.\n')
    git(vault, 'add', '.'); git(vault, 'commit', '-m', 'Initial'); git(vault, 'push', '-u', 'origin', 'main')
    const wrapper = join(developer, 'usr', 'bin', 'git'), xcodeSelect = join(scratch, 'xcode-select')
    await mkdir(join(developer, 'usr', 'bin'), { recursive: true })
    await writeFile(wrapper, `#!/bin/sh\nexec "${realGit()}" "$@"\n`); await chmod(wrapper, 0o755)
    await writeFile(xcodeSelect, `#!/bin/sh\n[ "$1" = "-p" ] || exit 0\necho "${developer}"\n`); await chmod(xcodeSelect, 0o755)
    await launch(scratch, vault, xcodeSelect, 'nested', 'Note saved in the Collection window just before quitting.\n')
    expect(git(remote, 'show', 'main:chapter/note.md')).toBe('Note saved in the Collection window just before quitting.')
  } finally { await rm(scratch, { recursive: true, force: true }) }
}, 120000)

// PR 298 review: a failed inspection keeps the quit marker; an intent settings cannot store stays in memory only (no
// second storage place); a save reaches an enabled vault nested inside the saving window; each receive refreshes only
// its own arrivals; opt-out retires only its own vault's intent; recovery is reported after its cleanup. The probe asserts each and prints one OK line per case.
testWithGitleaks('quit recovery survives failed inspection and unwritable settings; saves reach nested vaults; every arrival refreshes', async () => {
  const child = Bun.spawn([process.execPath, 'tests/main/git-sync-quit-recovery-probe.ts'], {
    cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', env: { ...gitEnv },
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Recovery probe failed (${code}): ${err}\n${out}`)
  expect(out.split('\n').filter(line => line.startsWith('OK: '))).toHaveLength(6)
}, 180000)
