/** Real controller/engine/settings, fixture repositories, recording Git and settings, injected clock/tick. */
import { mock, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronMainStandIn } from '../helpers/electron-main-stand-in'

const handlers = new Map<string, (...args: any[]) => any>()
mock.module('electron', () => ({ ...electronMainStandIn, app: { getPath: () => scratch, getVersion: () => '0.0.0-test', isPackaged: false }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } }))
const engineModule = await import('../../src/main/git-vault-sync')
const realCreate = engineModule.createGitVaultSync
let statusPasses = 0
const active = new Set<Promise<unknown>>()
mock.module('../../src/main/git-vault-sync', () => ({ ...engineModule, createGitVaultSync: (...args: Parameters<typeof realCreate>) => {
  const engine = realCreate(...args)
  return { ...engine, status: (...input: Parameters<typeof engine.status>) => {
    statusPasses++
    const task = engine.status(...input)
    active.add(task)
    void task.finally(() => active.delete(task))
    return task
  } }
} }))
const { fixture } = await import('./git-vault-sync-fixture')
const f = await fixture()
const scratch = f.base
const originalNow = Date.now
const originalInterval = globalThis.setInterval
const originalClearInterval = globalThis.clearInterval
const realWrite = fs.writeFileSync
let now = 1_800_000_000_000, tick: (() => void) | undefined
Date.now = () => now
// Only the controller's interval is injected; Git's bounded subprocess timers remain real.
globalThis.setInterval = ((fn: () => void) => { tick = fn; return { unref() {} } }) as typeof setInterval
globalThis.clearInterval = (() => { tick = undefined }) as typeof clearInterval
const key = 'git-sync.wait.' + createHash('sha256').update(f.av).digest('hex') + '.pendingSince'
let settingsWrites = 0, pendingWrites = 0, pendingRequests = 0, previousPending: unknown = f.settingsA.get(key)
const writes = spyOn(fs, 'writeFileSync').mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
  const data = typeof args[1] === 'string' ? args[1] : ''
  if (data.startsWith('{')) {
    try {
      const values = JSON.parse(data).values
      if (values) {
        settingsWrites++
        if (values[key] !== previousPending) { pendingWrites++; previousPending = values[key] }
      }
    } catch { /* not settings JSON */ }
  }
  return realWrite(...args)
}) as typeof fs.writeFileSync)
const log = join(scratch, 'git-processes.txt')
const developer = join(scratch, 'Developer'), wrapper = join(developer, 'usr/bin/git'), select = join(scratch, 'xcode-select')
const realGit = join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr/bin/git')
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
let lifecycle: { start(): void; stop(): Promise<void> } | undefined
try {
  await mkdir(join(developer, 'usr/bin'), { recursive: true })
  await writeFile(wrapper, `#!/bin/sh\nprintf 'git\\n' >> ${quote(log)}\nGIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 exec ${quote(realGit)} "$@"\n`)
  await writeFile(select, `#!/bin/sh\nprintf '%s\\n' ${quote(developer)}\n`)
  await chmod(wrapper, 0o755); await chmod(select, 0o755)
  const { developerToolsSeams, recheckDeveloperTools } = await import('../../src/main/developer-tools')
  developerToolsSeams.command = select; developerToolsSeams.platform = 'darwin'
  // The fixture already asked for Git. Forget that cached executable so the controller uses the recorder.
  await recheckDeveloperTools()
  process.env.HOME = scratch; process.env.GIT_CONFIG_GLOBAL = '/dev/null'; process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_TERMINAL_PROMPT = '0'
  const { SettingsStore } = await import('../../src/main/settings')
  const { registerWindow } = await import('../../src/main/state')
  const { registerGitSync, gitSyncSaved } = await import('../../src/main/git-sync-app')
  const { gitState } = await import('../../src/shared/git-sync-view')
  const sender = Object.assign(new EventEmitter(), { id: 710, send: (channel: string, input: any) => {
    if (channel === 'git-sync:prepare') queueMicrotask(() => handlers.get('git-sync:buffers')!({ sender }, { ...input, paths: [] }))
  } })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false, isFocused: () => false } as any)
  state.workspace = { root: f.av, recordOwnWrite: () => {}, exclusiveAll: (work: () => unknown) => work() } as any
  const start = async (settings: InstanceType<typeof SettingsStore>) => {
    const set = settings.set.bind(settings), durable = settings.setDurable.bind(settings)
    settings.set = async (...args) => { if (args[0] === key) pendingRequests++; return set(...args) }
    settings.setDurable = async (...args) => { if (args[0] === key) pendingRequests++; return durable(...args) }
    lifecycle = registerGitSync(settings, () => {}); lifecycle.start()
    return handlers.get('git-sync:call')!({ sender }, { action: 'status' })
  }
  const call = (action = 'status') => handlers.get('git-sync:call')!({ sender }, { action })
  const settle = async (until = (_v: any) => true) => {
    for (let i = 0; i < 1000; i++) {
      const view = await call()
      if (!view.busy && active.size === 0 && until(view)) return view
      await Bun.sleep(10)
    }
    throw new Error('Controller did not settle')
  }
  await f.settingsA.set('experimental.gitVaultSync', true, 'test', { log: false })
  await start(f.settingsA)
  // Opening's independent ignore audit is not work caused by the measured saves.
  await settle(v => v.ignored !== undefined)
  const initialHead = f.git(f.remote, 'rev-parse', 'HEAD')
  statusPasses = 0; settingsWrites = 0; pendingWrites = 0; pendingRequests = 0
  await writeFile(log, '')
  const expected: string[] = []
  let immediateState: number | undefined, durableWhenHookReturned = false
  const save = async (i: number) => {
    expected.push(`Edit ${i}`)
    await f.put(f.a, 'draft.md', expected.join('\n') + '\n')
    gitSyncSaved(f.av, 'draft.md')
    if (i === 1) durableWhenHookReturned = JSON.parse(fs.readFileSync(join(scratch, 'a-settings.json'), 'utf8')).values[key] === now
    // No elapsed fake time: this includes the first-save bookkeeping, but no delayed status.
    const view = await settle(v => v.editedAt === now)
    immediateState ??= gitState(view)
  }
  if (process.argv[2] === 'burst') {
    for (let i = 1; i <= 20; i++) { now += 500; await save(i); tick!(); await settle() }
    now += 5000; tick!(); await settle()
    const counts = { gitProcesses: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).length, statusPasses, settingsWrites, pendingWrites, pendingRequests }
    now += 175_000 - 1000; tick!(); await settle()
    const beforeDeadline = f.git(f.remote, 'rev-parse', 'HEAD')
    now += 1000; tick!(); await settle(v => v.result.lastSentAt !== undefined)
    console.log(JSON.stringify({ ...counts, gitProcessesThroughSend: (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).length, settingsWritesThroughSend: settingsWrites, initialHead, beforeDeadline, immediateState, remoteText: f.git(f.remote, 'show', 'HEAD:draft.md') + '\n', expectedText: expected.join('\n') + '\n', pendingAfterSend: f.settingsA.get(key) }))
  } else {
    now += 500; await save(1)
    // Discard this controller without stop(): stop is a clean quit and would send, not crash.
    const settings = new SettingsStore(join(scratch, 'a-settings.json'))
    const durableBeforeStatus = durableWhenHookReturned && settings.get(key) === now && statusPasses === 0
    const reopened = await start(settings)
    // A real reopening fetches, then sends at the unchanged quiet deadline.
    await call('open'); await settle(v => v.ignored !== undefined)
    now += 180_000; tick!(); await settle(v => v.result.lastSentAt !== undefined)
    console.log(JSON.stringify({ durableBeforeStatus, reopenedState: gitState(reopened), remoteText: f.git(f.remote, 'show', 'HEAD:draft.md') + '\n', expectedText: expected.join('\n') + '\n' }))
  }
} finally {
  globalThis.clearInterval = originalClearInterval; globalThis.setInterval = originalInterval; Date.now = originalNow
  writes.mockRestore()
  await f.close()
}
