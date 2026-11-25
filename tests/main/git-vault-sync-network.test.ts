// Git vault sync: Network and retries.
// Guards ADR-0055 parcel 1c and parcel 4: rejected pushes retry within a bound, unreachable remotes stop without change, network calls have their own time limit, and identical no-progress work is not retried.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { test, expect } from 'bun:test'
import { writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, tree, snapshot, text } from './git-vault-sync-fixture'
import { testWithSafeSyncGit, testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'

const timeout = 60_000

testWithSafeSyncGitAndGitleaks('a real rejected push fetches, integrates and succeeds on a bounded retry', async () => {
  const f = await fixture()
  try {
    await f.put(f.a, 'draft.md', 'A sent after the remote moves.\n'); let pushes = 0
    const engine = f.engineA({ checkpoint: async phase => { if (phase === 'before-push' && ++pushes === 1) { await f.put(f.b, 'second.md', 'B moved the remote.\n'); expect((await f.B.send(f.bv)).state).toBe('up-to-date') } } })
    expect((await engine.send(f.av)).state).toBe('up-to-date'); expect(pushes).toBe(2)
    expect(await text(f.a, 'second.md')).toBe('B moved the remote.\n'); await f.B.fetchAndIntegrate(f.bv); expect(await tree(f.a)).toEqual(await tree(f.b))
  } finally { await f.close() }
}, timeout)

test('unreachable remote returns stopped and leaves dirty writing, index and HEAD unchanged', async () => {
  const f = await fixture()
  try {
    f.git(f.a, 'remote', 'set-url', 'origin', join(f.base, 'not-a-remote.git')); await f.put(f.a, 'draft.md', 'Unsent writing stays here.\n')
    const before = await snapshot(f), result = await f.A.send(f.av)
    expect(result.state).toBe('stopped'); expect(result.reason?.code).toBe('network-unavailable'); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGit('network calls have a separately configurable longer bound and kill a timed-out upload pack', async () => {
  const f = await fixture()
  try {
    const script = join(f.base, 'slow-upload-pack.sh')
    await writeFile(script, '#!/bin/sh\nsleep 2\nexec /usr/bin/git upload-pack "$@"\n'); await chmod(script, 0o700)
    f.git(f.a, 'config', 'remote.origin.uploadpack', script)
    const started = Date.now()
    const r = await f.engineA({ gitTimeoutMs: 1000, networkTimeoutMs: 5000 }).fetchAndIntegrate(f.av)
    expect(r.reason).toBeUndefined(); expect(Date.now() - started).toBeGreaterThanOrEqual(1500)
    const before = await snapshot(f)
    const failed = await f.engineA({ gitTimeoutMs: 1000, networkTimeoutMs: 100 }).fetchAndIntegrate(f.av)
    expect(failed.reason?.code).toBe('network-unavailable'); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

test('M2 scheduler blocks identical no-progress work until new bytes arrive',async()=>{
 const f=await fixture();try{
  const {SendProgress,pendingFingerprint}=await import('../../src/main/git-sync-progress')
  await f.put(f.a,'.bridle/journal.jsonl','{"ts":1}\n')
  const paths=['.bridle/journal.jsonl'], guard=new SendProgress(), first=await pendingFingerprint(f.a,paths,f.gitEnv)
  expect(guard.shouldSend(first)).toBe(true);expect(guard.completed(first,first,true)).toBe(true)
  expect(guard.shouldSend(await pendingFingerprint(f.a,paths,f.gitEnv))).toBe(false)
  await f.put(f.a,'.bridle/journal.jsonl','{"ts":1}\n{"ts":2}\n')
  expect(guard.shouldSend(await pendingFingerprint(f.a,paths,f.gitEnv))).toBe(true)
 }finally{await f.close()}
},120000)
