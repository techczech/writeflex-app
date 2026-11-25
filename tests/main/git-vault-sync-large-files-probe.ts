/** Child-process observation: Node read counters plus an OS deny-read boundary on every Git child.
 * A deliberately reading Git control must fail. Successful automatic work then proves zero Git-side
 * worktree payload reads, rather than inferring it from Git command names or a warm stat cache.
 */
import { expect, mock, spyOn, setSystemTime } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as syncFs from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { electronMainStandIn } from '../helpers/electron-main-stand-in'
const handlers = new Map<string, (...args: any[]) => any>()
let scratch = ''
mock.module('electron', () => ({ ...electronMainStandIn, app: { getPath: () => scratch, getVersion: () => 'test', isPackaged: false }, ipcMain: { handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn) } }))
const { fixture, largeFiles } = await import('./git-vault-sync-fixture')
const { pendingFingerprint } = await import('../../src/main/git-sync-progress')
const mode = process.argv[2]
const f = await fixture()
scratch = f.base
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval, originalNow = Date.now
const originalEnv = Object.fromEntries(['HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].map(k => [k, process.env[k]]))
const observers: Array<{ mockRestore(): void }> = []
try {
  const large = await largeFiles(f), payloads = [f.a, f.b].flatMap(root => large.paths.map(p => join(root, p)))
  if (mode === 'held' || mode === 'held-controller') {
    await f.put(f.a,'inspection.lfs','Staged changed LFS.\n');f.git(f.a,'add','inspection.lfs');await f.put(f.a,'inspection.lfs','Unstaged changed LFS.\n')
    const fd=await fs.open(join(f.a,'large.bin'),'r+');try{await fd.write(Buffer.from('edit'),0,4,0)}finally{await fd.close()}
    await large.reset()
  }
  if (mode === 'stale') { const st = await fs.lstat(payloads[0]); await fs.utimes(payloads[0], st.atime, new Date(st.mtimeMs - 2000)) }
  const before = await Promise.all(payloads.map(p => fs.lstat(p, { bigint: true })))
  const objects = [f.a, f.b].map(root => f.git(root, 'ls-files', '-s', '--', ...large.paths))
  const realGit = join(execFileSync('/usr/bin/xcode-select', ['-p']).toString().trim(), 'usr/bin/git')
  const profile = join(f.base, 'no-payload-reads.sb'), metadataProfile = join(f.base, 'metadata-only.sb')
  const largeOid = f.git(f.a, 'rev-parse', 'HEAD:large.bin')
  const blobs = [f.a, f.b].map(root => join(root, '.git/objects', largeOid.slice(0, 2), largeOid.slice(2)))
  // Keep the big ordinary blob loose, so the OS can deny its body to merge/pack/diff commands
  // without denying unrelated commit and tree objects. Only Git's size-only batch query gets access.
  for (const blob of blobs) expect((await fs.lstat(blob)).isFile()).toBe(true)
  const deny = (paths: string[]) => `(version 1) (allow default) (deny file-read-data ${paths.map(p => `(literal ${JSON.stringify(p)})`).join(' ')})`
  await fs.writeFile(profile, deny([...payloads, ...blobs]))
  await fs.writeFile(metadataProfile, deny(payloads))
  // This invokes Git's own worktree content hashing, not a Node-only imitation.
  const control = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, realGit, '-C', f.a, 'hash-object', large.paths[0]], { encoding: 'utf8' })
  const controlDenied = control.status !== 0 && /[Pp]ermission denied|[Oo]peration not permitted/.test(control.stderr)
  expect(controlDenied).toBe(true)
  const unpackControl = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, realGit, '-C', f.a, 'cat-file', 'blob', largeOid], { encoding: 'utf8' })
  expect(unpackControl.status).not.toBe(0)
  const developer = join(f.base, 'Developer'), wrapper = join(developer, 'usr/bin/git'), select = join(f.base, 'xcode-select')
  await fs.mkdir(join(developer, 'usr/bin'), { recursive: true })
  const q = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(wrapper, `#!/bin/sh\nprofile=${q(profile)}\nfor arg do\n  if [ "$arg" = '--batch-check=%(objectname) %(objecttype) %(objectsize)' ]; then profile=${q(metadataProfile)}; fi\ndone\nGIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 exec /usr/bin/sandbox-exec -f "$profile" ${q(realGit)} "$@"\n`)
  await fs.writeFile(select, `#!/bin/sh\nprintf '%s\\n' ${q(developer)}\n`)
  await fs.chmod(wrapper, 0o755); await fs.chmod(select, 0o755)
  const { developerToolsSeams, recheckDeveloperTools } = await import('../../src/main/developer-tools')
  developerToolsSeams.command = select; developerToolsSeams.platform = 'darwin'; await recheckDeveloperTools()
  Object.assign(process.env, f.gitEnv, { GIT_TERMINAL_PROMPT: '0' })
  let nodePayloadReads = 0
  const read = fs.readFile
  observers.push(spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
    if (payloads.includes(String(args[0]))) nodePayloadReads++
    return read(...args)
  }) as typeof fs.readFile))
  const open = fs.open, syncRead = syncFs.readFileSync
  observers.push(spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
    if (payloads.includes(String(args[0]))) nodePayloadReads++
    return open(...args)
  }) as typeof fs.open))
  observers.push(spyOn(syncFs, 'readFileSync').mockImplementation(((...args: Parameters<typeof syncFs.readFileSync>) => {
    if (payloads.includes(String(args[0]))) nodePayloadReads++
    return syncRead(...args)
  }) as typeof syncFs.readFileSync))
  const readingControl = await fs.open(payloads[0], 'r'); await readingControl.close()
  expect(nodePayloadReads).toBe(1); nodePayloadReads = 0
  const healthy = (r: Awaited<ReturnType<typeof f.A.status>>) => { expect(r.reason).toBeUndefined(); expect(r.pairs).toEqual([]) }
  if (mode === 'stale') {
    // First a real cached stat mismatch, then an index reconstructed without any stat evidence.
    expect((await f.A.status(f.av)).held?.length).toBeGreaterThan(0)
    if(mode!=='held'&&mode!=='held-controller')f.git(f.a, 'read-tree', 'HEAD')
    for (const operation of [() => f.A.status(f.av), () => f.A.fetchAndIntegrate(f.av), () => f.A.send(f.av)]) {
      const r = await operation(); expect(r.state).toBe('held'); expect(r.reason).toBeUndefined()
      expect(r.held?.some(d => large.paths.includes(d.path))).toBe(true)
    }
    await pendingFingerprint(f.av, large.paths, f.gitEnv)
    expect((await f.engineA().status(f.av)).held?.length).toBeGreaterThan(0)
  } else if (mode === 'invalidation') {
    // Same bytes and size, different inode: neither timestamps nor an old selection may conceal it.
    await fs.rename(join(f.a, large.paths[0]), join(f.a, 'saved-payload'))
    await fs.copyFile(join(f.a, 'saved-payload'), join(f.a, large.paths[0]))
    let r = await f.engineA().status(f.av)
    expect(r.held?.length).toBeGreaterThan(0)
    await f.put(f.a, '.gitattributes', '*.bin filter=lfs -text\n')
    r = await f.engineA().status(f.av); expect(r.held?.length).toBeGreaterThan(0)
    const { selectSyncFiles } = await import('../../src/main/git-vault-sync-selection')
    const { syncGit } = await import('../../src/main/git-vault-sync-git')
    const select = () => selectSyncFiles(syncGit(f.a, f.gitEnv), f.a)
    expect((await select()).large.get('large.bin')?.state).toBe('needs-checking')
    const previous = (await select()).large.get('inspection.lfs')!.evidence
    f.git(f.a, 'update-index', '--cacheinfo', '100644', f.git(f.a, 'rev-parse', 'HEAD:draft.md'), 'inspection.lfs')
    expect((await select()).large.get('inspection.lfs')!.evidence).not.toBe(previous)
    await fs.rename(join(f.a, 'large.bin'), join(f.a, 'moved.bin'))
    expect((await select()).large.get('moved.bin')?.state).toBe('needs-checking')
    f.git(f.a, 'branch', 'another-branch'); f.git(f.a, 'symbolic-ref', 'HEAD', 'refs/heads/another-branch')
    expect((await f.A.status(f.av)).reason?.code).toBe('repository-changed')
  } else if (mode === 'controller' || mode === 'held-controller') {
    let tick: (() => void) | undefined
    const clock = { now: 1_800_000_000_000 }
    // Also advance Date.now references captured by main-process modules before this branch.
    setSystemTime(clock.now)
    globalThis.setInterval = ((fn: () => void) => { tick = fn; return { unref() {} } }) as typeof setInterval
    globalThis.clearInterval = (() => {}) as typeof clearInterval
    const { registerWindow } = await import('../../src/main/state')
    const { registerGitSync, gitSyncSaved } = await import('../../src/main/git-sync-app')
    const sender = Object.assign(new EventEmitter(), { id: 713, send(channel: string, input: any) { if (channel === 'git-sync:prepare') queueMicrotask(() => handlers.get('git-sync:buffers')!({ sender }, { ...input, paths: [] })) } })
    const state = registerWindow({ webContents: sender, on() {}, isDestroyed: () => false, isFocused: () => true } as any)
    state.workspace = { root: f.av, recordOwnWrite() {}, exclusiveAll: (work: () => unknown) => work() } as any
    await f.settingsA.set('experimental.gitVaultSync', true, 'test', { log: false })
    const lifecycle = registerGitSync(f.settingsA, () => {}); lifecycle.start()
    const call = (action = 'status') => handlers.get('git-sync:call')!({ sender }, { action })
    let lastView: any
    const settle = async (until = (_r: any) => true) => {
      for (let i = 0; i < 2000; i++) { const view = lastView = await call(); if (!view.busy && until(view)) { healthy(view.result); return view }; await Bun.sleep(10) }
      throw new Error('Controller did not settle: ' + JSON.stringify({clockNow:clock.now,dateNow:Date.now(),tickName:tick?.name,busy:lastView.busy,ignored:lastView.ignored,result:lastView.result,editedAt:lastView.editedAt,discovery:lastView.discovery}))
    }
    await call('open'); await settle(v => v.ignored !== undefined)
    clock.now += 600_001; setSystemTime(clock.now); expect(Date.now()).toBe(clock.now); tick!(); await settle()
    await f.put(f.a, 'draft.md', 'Timed ordinary writing.\n'); gitSyncSaved(f.av, 'draft.md')
    await settle(v => v.editedAt === clock.now); clock.now += 180_001; setSystemTime(clock.now); expect(Date.now()).toBe(clock.now); tick!(); await settle(v => v.result.lastSentAt !== undefined)
    expect(f.git(f.remote, 'show', 'main:draft.md')).toBe('Timed ordinary writing.')
    if(mode==='held-controller') {
      const tip=f.git(f.remote,'rev-parse','main');for(let i=0;i<4;i++){clock.now+=180001;setSystemTime(clock.now);tick!();await settle()}expect(f.git(f.remote,'rev-parse','main')).toBe(tip)
      await f.put(f.a,'draft.md','Quit prose with held files.\n');gitSyncSaved(f.av,'draft.md');await settle(v=>v.editedAt===clock.now)
    }
    await lifecycle.stop()
    if(mode==='held-controller'){
      expect(f.git(f.remote,'show','main:draft.md')).toBe('Quit prose with held files.')
      // Simulate a durable failed-quit intent, then a new controller on the next opening.
      const {createHash}=await import('node:crypto'),id=createHash('sha256').update(f.av).digest('hex')
      // stop() is bounded: this same-process stand-in must let the previous process's final
      // receipt finish before it creates a new process's intent. Real reopening cannot share callbacks.
      await f.A.status(f.av)
      for(let i=0;i<1000&&f.settingsA.get('git-sync.wait.'+id+'.resume')!==false;i++)await Bun.sleep(10)
      expect(f.settingsA.get('git-sync.wait.'+id+'.resume')).toBe(false)
      await f.put(f.a,'draft.md','Resumed prose with held files.\n')
      await f.settingsA.setDurable('git-sync.wait.'+id+'.resume',true,'fixture quit intent')
      const reopened=registerGitSync(f.settingsA,()=>{});reopened.start();await call('open')
      const resumed=await settle(v=>v.leftAtQuit==='sent')
      expect(resumed.result.held?.map((d:any)=>d.path).sort()).toEqual([...large.paths].sort())
      expect(f.git(f.remote,'show','main:draft.md')).toBe('Resumed prose with held files.')
      await reopened.stop()
    }
    if(mode!=='held'&&mode!=='held-controller')f.git(f.a, 'read-tree', 'HEAD')
    expect((await call('fetch')).result.held?.length).toBeGreaterThan(0)
  } else {
    for (let i = 0; i < 3; i++) healthy(await f.A.status(f.av))
    await f.put(f.b, 'second.md', 'Incoming ordinary writing.\n'); healthy(await f.B.send(f.bv))
    healthy(await f.A.fetchAndIntegrate(f.av)); expect(await fs.readFile(join(f.a, 'second.md'), 'utf8')).toBe('Incoming ordinary writing.\n')
    await f.put(f.a, 'draft.md', 'Outgoing ordinary writing.\n'); healthy(await f.A.send(f.av))
    if(mode==='held'){const r=await f.engineA().status(f.av);expect(r.held?.map(d=>d.path).sort()).toEqual([...large.paths].sort());expect(r.pending).toEqual([])}
    healthy(await f.B.fetchAndIntegrate(f.bv)); expect(await fs.readFile(join(f.b, 'draft.md'), 'utf8')).toBe('Outgoing ordinary writing.\n')
    if(mode!=='held'&&mode!=='held-controller')f.git(f.a, 'read-tree', 'HEAD')
    expect((await f.A.status(f.av)).held?.length).toBeGreaterThan(0)
  }
  if (mode !== 'invalidation') {
    const after = await Promise.all(payloads.map(p => fs.lstat(p, { bigint: true })))
    for (let i = 0; i < before.length; i++) for (const k of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'atimeNs'] as const) expect(after[i][k]).toBe(before[i][k])
    expect([f.a, f.b].map(root => f.git(root, 'ls-files', '-s', '--', ...large.paths))).toEqual(objects)
  }
  const filterCalls = await large.calls()
  console.log(JSON.stringify({ mode, controlDenied, nodePayloadReads, filterCalls, gitPayloadReads: 0, proof: 'OS denies worktree payload reads and non-metadata access to the large Git blob; actual LFS transfer adapter records invocations', sizes: large.sizes }))
  expect(nodePayloadReads).toBe(0); expect(filterCalls).toEqual([])
} finally {
  setSystemTime()
  for (const observer of observers) observer.mockRestore(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; Date.now = originalNow
  for (const [k, v] of Object.entries(originalEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v
  await f.close()
}
