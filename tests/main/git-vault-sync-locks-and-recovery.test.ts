// Git vault sync: Locks, rollback and recovery.
// Guards ADR-0055 "Ordering, collisions and live writes", parcel 1c and parcels 4 and 5: Git index locks are waited on and never stolen; a failure or a real process crash mid-round restores files, index and branch exactly, never overwriting a newer save.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { expect } from 'bun:test'
import { readFile, writeFile, readdir, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createGitVaultSync } from '../../src/main/git-vault-sync'
import { SettingsStore } from '../../src/main/settings'
import { ChangeStore } from '../../src/main/changes'
import { Workspace } from '../../src/main/workspace'
import { fixture, tree, snapshot, text, seed, running, addChange } from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'

const timeout = 60_000
const limit = 120_000

async function crashEngine(f: Awaited<ReturnType<typeof fixture>>, phase: string, code: number): Promise<number | null> {
  const source = `import { createGitVaultSync } from ${JSON.stringify(join(process.cwd(), 'src/main/git-vault-sync.ts'))};
    import { SettingsStore } from ${JSON.stringify(join(process.cwd(), 'src/main/settings.ts'))};
    const engine = createGitVaultSync({ settings: new SettingsStore(${JSON.stringify(join(f.base, 'a-settings.json'))}),
      computerName: 'Mac A', gitEnv: ${JSON.stringify(f.gitEnv)}, renameProbe: async () => ({ honoured: true, version: 'not under test' }), checkpoint: async phase => { if (phase === ${JSON.stringify(phase)}) process.exit(${code}); } });
    const result = await engine.fetchAndIntegrate(${JSON.stringify(f.av)}); if (result.reason) console.error(result.reason.code); process.exit(result.reason ? 2 : 0);`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk.toString().slice(0, 2000 - errors.length) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Crash probe timed out')) }, 30000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', exit => { clearTimeout(timer); if (exit === 1 || exit === 2) reject(new Error(`Crash probe failed before its checkpoint: ${errors}`)); else resolve(exit) })
  })
}

async function crashFetch(f: Awaited<ReturnType<typeof fixture>>, phase: string, code: number, nth = 1): Promise<number | null> {
  const source = `import { createGitVaultSync } from ${JSON.stringify(join(process.cwd(), 'src/main/git-vault-sync.ts'))};
    import { SettingsStore } from ${JSON.stringify(join(process.cwd(), 'src/main/settings.ts'))};
    let seen = 0
    const engine = createGitVaultSync({ settings: new SettingsStore(${JSON.stringify(join(f.base, 'a-settings.json'))}),
      computerName: 'Mac A', gitEnv: ${JSON.stringify(f.gitEnv)}, renameProbe: async () => ({ honoured: true, version: 'not under test' }), checkpoint: async phase => { if (phase === ${JSON.stringify(phase)} && ++seen === ${nth}) process.exit(${code}); } });
    const result = await engine.send(${JSON.stringify(f.av)}); if (result.reason) console.error(result.reason.code); process.exit(result.reason ? 2 : 0);`
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'ignore', 'pipe'] })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk.toString().slice(0, 2000 - errors.length) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('probe timed out')) }, 30000)
    child.on('close', exit => { clearTimeout(timer); if (exit === 1 || exit === 2) reject(new Error(`probe failed: ${errors}`)); else resolve(exit) })
  })
}

async function child(f:Awaited<ReturnType<typeof fixture>>,hook:string,op='send') {
 const source=`import {createGitVaultSync} from ${JSON.stringify(join(process.cwd(),'src/main/git-vault-sync.ts'))};import {SettingsStore} from ${JSON.stringify(join(process.cwd(),'src/main/settings.ts'))};let seen=0;const e=createGitVaultSync({settings:new SettingsStore(${JSON.stringify(join(f.base,'a-settings.json'))}),computerName:'Mac A',gitEnv:${JSON.stringify(f.gitEnv)},renameProbe: async () => ({ honoured: true, version: 'not under test' }),${hook}});const r=await e.${op}(${JSON.stringify(f.av)});if(r.reason)console.error(r.reason);process.exit(r.reason?2:0)`
 return new Promise<number|null>((resolve,reject)=>{const c=spawn(process.execPath,['-e',source],{stdio:['ignore','ignore','pipe']});let errors='';c.stderr.on('data',d=>errors+=d.toString().slice(0,2000));const timer=setTimeout(()=>reject(new Error('child timed out')),60000);c.on('close',code=>{clearTimeout(timer);if(code===1||code===2)reject(new Error(errors));else resolve(code)})})
}

testWithSafeSyncGitAndGitleaks('index.lock is waited on, never deleted; release allows send and timeout leaves it intact', async () => {
  const f = await fixture()
  try {
    const lock = join(f.a, '.git/index.lock'); await writeFile(lock, 'Owned by the test, not WriteFlex.'); await f.put(f.a, 'draft.md', 'A waiting draft.\n')
    let now = 0, sleeps = 0
    const engine = f.engineA({ lockWaitMs: 100, lockPollMs: 10, now: () => now, sleep: async ms => {
      expect(await readFile(lock, 'utf8')).toBe('Owned by the test, not WriteFlex.'); now += ms; sleeps++
      if (sleeps === 2) await rm(lock)
    } })
    expect((await engine.send(f.av)).state).toBe('up-to-date'); expect(sleeps).toBe(2)
    await writeFile(lock, 'Still owned by the test.'); const before = await snapshot(f)
    const result = await f.engineA({ lockWaitMs: 20, lockPollMs: 10, now: () => now, sleep: async ms => { now += ms } }).send(f.av)
    expect(result.reason?.code).toBe('index-busy'); expect(await readFile(lock, 'utf8')).toBe('Still owned by the test.'); expect(await snapshot(f)).toEqual(before)
    await rm(lock)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('failure after a merge starts applying restores files, directories, the index and HEAD exactly', async () => {
  const f = await fixture(true)
  try {
    await f.put(f.a, 'vault/draft.md', 'Local version.\n'); await f.put(f.b, 'vault/draft.md', 'Remote version.\n'); await f.put(f.b, 'vault/new-folder/new.md', 'New remote file.\n'); await f.B.send(f.bv)
    const before = await snapshot(f); let failed = false, writes = 0
    const result = await f.engineA({ checkpoint: async phase => { if (phase === 'after-write' && ++writes === 2) { failed = true; throw new Error('Synthetic mid-merge fault') } } }).fetchAndIntegrate(f.av)
    expect(failed).toBe(true); expect(writes).toBe(2); expect(result.state).toBe('stopped'); expect(await snapshot(f)).toEqual(before)
    expect(f.git(f.a, 'ls-files', '--unmerged')).toBe(''); expect((await f.A.status(f.av)).pairs).toEqual([])
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a post-push local merge failure restores the local tree, reports the actual send, and retains the pair through recovery', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'A keeps this version.\n'); await f.put(f.b, 'draft.md', 'B keeps this version.\n'); await f.B.send(f.bv)
    const before = await snapshot(f)
    const result = await f.engineA({ checkpoint: async phase => { if (phase === 'after-write') throw new Error('Synthetic post-push filesystem fault') } }).send(f.av)
    expect(result.state).toBe('stopped'); expect(result.lastSentAt).toBeDefined(); expect(result.pairs).toHaveLength(1); expect(await snapshot(f)).toEqual(before)
    const recovered = await f.A.fetchAndIntegrate(f.av)
    expect(recovered.state).toBe('needs-you')
    expect(await text(f.a, recovered.pairs[0].local)).toBe('A keeps this version.\n')
    expect(await text(f.a, recovered.pairs[0].other)).toBe('B keeps this version.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('R5 rollback leaves both newer saves and reports the preserved document', async () => {
  const f = await fixture()
  try {
    await f.put(f.b, 'draft.md', 'B draft.\n'); await f.put(f.b, 'second.md', 'B second.\n'); await f.B.send(f.bv)
    let n = 0
    const A2 = f.engineA({ checkpoint: async (phase) => { if (phase === 'after-write' && n++ === 0) {
      const first = (await text(f.a, 'draft.md')) === 'B draft.\n' ? 'draft.md' : 'second.md'
      const other = first === 'draft.md' ? 'second.md' : 'draft.md'

      await f.put(f.a, first, 'USER TYPED AFTER RELOAD.\n')
      await f.put(f.a, other, 'User also saved the other.\n')
    } } })
    const r = await A2.fetchAndIntegrate(f.av)
    // Parcel 4 retries a detected late save once as keep-both in this same operation.
    expect(r.state).toBe('needs-you'); expect(r.reason).toBeUndefined()
    expect(new Set(r.pairs.map(p=>p.local))).toEqual(new Set(['draft.md','second.md']))
    expect(r.warnings.some(w => w.code === 'local-write-preserved' && ['draft.md', 'second.md'].includes(w.path))).toBe(true)
    expect(new Set([await text(f.a, 'draft.md'), await text(f.a, 'second.md')])).toEqual(new Set(['USER TYPED AFTER RELOAD.\n', 'User also saved the other.\n']))
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('network preparation holds no real index lock, and an ordinary vault-only user commit is sent', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'Own vault-only commit.\n'); f.git(f.a, 'commit', '-am', 'WriteFlex: spoofed message')
    let checked = false
    const r = await f.engineA({ checkpoint: async phase => { if (phase === 'before-push') {
      checked = true; expect(await lstat(join(f.a, '.git/index.lock')).then(() => true, () => false)).toBe(false)
    } } }).send(f.av)
    expect(checked).toBe(true); expect(r.reason).toBeUndefined()
    await f.B.fetchAndIntegrate(f.bv); expect(await text(f.b, 'draft.md')).toBe('Own vault-only commit.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('index is installed before the branch; a real process crash between them is repaired on reopening', async () => {
  const f = await fixture()
  try {
    const oldHead = f.git(f.a, 'rev-parse', 'HEAD')
    await f.put(f.b, 'draft.md', 'New after crash.\n'); expect((await f.B.send(f.bv)).reason).toBeUndefined()
    expect(await crashEngine(f, 'after-index-install', 86)).toBe(86)
    expect(f.git(f.a, 'rev-parse', 'HEAD')).toBe(oldHead)
    expect(f.git(f.a, 'show', ':draft.md')).toBe('New after crash.')
    const r = await f.A.fetchAndIntegrate(f.av)
    expect(r.reason).toBeUndefined(); expect(f.git(f.a, 'rev-parse', 'HEAD')).toBe(f.git(f.remote, 'rev-parse', 'main'))
    expect(f.git(f.a, 'diff', '--cached', '--name-only')).toBe(''); expect(await text(f.a, 'draft.md')).toBe('New after crash.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a dead WriteFlex lock owner is reclaimed after a real process crash; unknown locks remain foreign', async () => {
  const f = await fixture()
  try {
    await f.put(f.b, 'draft.md', 'Incoming before lock crash.\n'); expect((await f.B.send(f.bv)).reason).toBeUndefined()
    expect(await crashEngine(f, 'after-write', 87)).toBe(87)
    expect(await lstat(join(f.a, '.git/index.lock')).then(() => true, () => false)).toBe(true)
    const r = await f.engineA({ lockWaitMs: 100 }).fetchAndIntegrate(f.av)
    expect(r.reason).toBeUndefined(); expect(await text(f.a, 'draft.md')).toBe('Incoming before lock crash.\n')
    expect(await lstat(join(f.a, '.git/index.lock')).then(() => true, () => false)).toBe(false)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a caught failure after index installation compensates the index, files and branch', async () => {
  const f = await fixture()
  try {
    await f.put(f.b, 'draft.md', 'Incoming before install fault.\n'); await f.B.send(f.bv)
    const before = await snapshot(f); let installed = false
    const result = await f.engineA({ checkpoint: async phase => { if (phase === 'after-index-install') { installed = true; throw new Error('Synthetic install failure') } } }).fetchAndIntegrate(f.av)
    expect(installed).toBe(true); expect(result.state).toBe('stopped'); expect(await snapshot(f)).toEqual(before)
    expect((await f.A.fetchAndIntegrate(f.av)).reason).toBeUndefined()
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('one installation never reclaims another installation’s orphaned Git index lock', async () => {
  const f = await fixture()
  try {
    await f.put(f.b, 'draft.md', 'Incoming before ownership test.\n'); expect((await f.B.send(f.bv)).reason).toBeUndefined()
    expect(await crashEngine(f, 'after-write', 87)).toBe(87)
    const foreign = f.engineB({ lockWaitMs: 100 })
    await foreign.setEnabled(f.av, true)
    expect(await lstat(join(f.a, '.git/index.lock')).then(() => true, () => false)).toBe(true)
    const before = await snapshot(f), stopped = await foreign.fetchAndIntegrate(f.av)
    expect(stopped.reason?.code).toBe('index-busy'); expect(await snapshot(f)).toEqual(before)
    expect((await f.A.fetchAndIntegrate(f.av)).reason).toBeUndefined()
    expect(await text(f.a, 'draft.md')).toBe('Incoming before ownership test.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('rollback never overwrites an app append made after the engine applied a ledger', async () => {
  const f = await fixture()
  try {
    await seed(f)
    await addChange(new ChangeStore(new Workspace(f.a)), 'A before application')
    await addChange(new ChangeStore(new Workspace(f.b)), 'B incoming'); running(await f.B.send(f.bv))
    const before = await snapshot(f); let appended = false
    const result = await f.engineA({ checkpoint: async phase => {
      if (phase === 'after-write' && !appended) {
        appended = true
        await addChange(new ChangeStore(new Workspace(f.a)), 'A append during application')
        throw new Error('Synthetic failure after a newer app append')
      }
    } }).fetchAndIntegrate(f.av)
    expect(appended).toBe(true); expect(result.state).toBe('stopped')
    const after = await snapshot(f); expect(after.index).toBe(before.index); expect(after.head).toBe(before.head)
    expect(new Set((await new ChangeStore(new Workspace(f.a)).list()).map(c => c.summary))).toEqual(new Set(['Common change', 'A before application', 'B incoming', 'A append during application']))
    running(await f.A.send(f.av)); running(await f.B.fetchAndIntegrate(f.bv))
    expect(await tree(f.a)).toEqual(await tree(f.b))
  } finally { await f.close() }
}, limit)

testWithSafeSyncGitAndGitleaks('S4 a process exit between apply writes recovers target bytes as sync-owned',async()=>{
 const f=await fixture();try{
  await f.put(f.b,'draft.md','B draft.\n');await f.put(f.b,'second.md','B second.\n');await f.B.send(f.bv)
  await f.put(f.a,'draft.md','A local.\n');await f.put(f.a,'third.md','A third.\n')
  expect(await crashFetch(f,'after-write',91,1)).toBe(91)
  await f.B.fetchAndIntegrate(f.bv);await f.put(f.b,'second.md','B second newer.\n');await f.B.send(f.bv)
  const result=await f.engineA({lockWaitMs:200}).send(f.av)
  expect(result.reason).toBeUndefined();expect(result.pairs.some(p=>p.local==='second.md')).toBe(false)
  expect(await text(f.a,'second.md')).toBe('B second newer.\n');expect(await text(f.a,'draft.md')).toBe('A local.\n')
 }finally{await f.close()}
},180000)

testWithSafeSyncGitAndGitleaks('S4a a save after interruption keeps the incoming version as a real pair on both Macs',async()=>{
 const f=await fixture();try{
  await f.put(f.b,'draft.md','B draft.\n');await f.put(f.b,'second.md','B second incoming.\n');await f.B.send(f.bv);await f.put(f.a,'third.md','A third.\n')
  expect(await child(f,`checkpoint:async p=>{if(p==='after-write'&&++seen===1)process.exit(91)}`)).toBe(91)
  await f.put(f.a,'second.md','A newest saved after restart.\n')
  const r=await f.A.send(f.av);expect(r.reason).toBeUndefined();const pair=r.pairs.find(p=>p.local==='second.md');expect(pair).toBeDefined()
  expect(await text(f.a,'second.md')).toBe('A newest saved after restart.\n');expect(await text(f.a,pair!.other)).toBe('B second incoming.\n');expect(pair!.from).toBe('Mac B')
  expect((await f.B.fetchAndIntegrate(f.bv)).reason).toBeUndefined();expect(await text(f.b,pair!.other)).toBe('B second incoming.\n');expect(await text(f.b,'second.md')).toBe('A newest saved after restart.\n')
 }finally{await f.close()}
},180000)

testWithSafeSyncGitAndGitleaks('S4b two interruptions remove only UUID sync temporaries on restart',async()=>{
 const f=await fixture();try{
  await f.put(f.b,'draft.md','B draft.\n');await f.put(f.b,'second.md','B second.\n');await f.put(f.b,'zfour.md','B four.\n');await f.B.send(f.bv);await f.put(f.a,'third.md','A third.\n')
  expect(await child(f,`checkpoint:async p=>{if(p==='after-write'&&++seen===1)process.exit(91)}`)).toBe(91)
  expect(await child(f,`ownWrite:()=>{if(++seen===2)process.exit(92)}`,'status')).toBe(92)
  expect((await readdir(f.a)).some(n=>/^\.writeflex-sync-[a-f0-9-]{36}\.tmp$/.test(n))).toBe(true)
  await f.put(f.a,'.writeflex-sync-not-owned.tmp','Do not delete this.\n')
  const r=await f.A.send(f.av);expect(r.reason).toBeUndefined();expect(r.pairs).toHaveLength(0)
  expect((await readdir(f.a)).some(n=>/^\.writeflex-sync-[a-f0-9-]{36}\.tmp$/.test(n))).toBe(false);expect(await text(f.a,'.writeflex-sync-not-owned.tmp')).toBe('Do not delete this.\n')
 }finally{await f.close()}
},180000)
