// Git vault sync: Secrets and scanning.
// Guards ADR-0055 "Consequences and verification" and parcel 1c: every outgoing byte, including history and packed recovery tails, is scanned; a finding or a missing scanner stops sending without changing the index, while receiving still brings in other work.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { test, expect } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, tree, snapshot, text, seed, hash } from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'

const timeout = 60_000
const limit = 120_000

testWithSafeSyncGitAndGitleaks('a planted synthetic secret blocks a commit, names its document and preserves the exact original index', async () => {
  const f = await fixture(true)
  try {
    await f.put(f.a, 'sibling/notes.md', 'Keep this staged.\n'); f.git(f.a, 'add', 'sibling/notes.md')
    const fake = 'ghp_' + randomBytes(18).toString('hex')
    await f.put(f.av, 'secret.md', `Synthetic fixture only: ${fake}\n`)
    const before = await snapshot(f), result = await f.A.send(f.av)
    expect(result.state).toBe('stopped'); expect(result.reason?.code).toBe('secret-found'); expect(result.reason?.document).toBe('secret.md')
    expect(JSON.stringify(result)).not.toContain(fake); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

test('missing scanner fails closed and restores the index', async () => {
  const f = await fixture()
  try {
    const { createGitleaksScanner } = await import('@app-patterns/vault-sync')
    await f.put(f.a, 'draft.md', 'A safe draft.\n'); const before = await snapshot(f)
    const result = await f.engineA({ scanner: createGitleaksScanner({ gitleaksPath: join(f.base, 'missing-scanner'), searchDirs: [] }) }).send(f.av)
    expect(result.reason?.code).toBe('scanner-unavailable'); expect(result.reason?.document).toBe('draft.md'); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a secret in an intermediate outgoing commit from another tool is not pushed even if the final tree removed it', async () => {
  const f = await fixture()
  try {
    const fake = 'ghp_' + randomBytes(18).toString('hex')
    await f.put(f.a, 'temporary.md', `Synthetic fixture: ${fake}\n`); f.git(f.a, 'add', 'temporary.md'); f.git(f.a, 'commit', '-m', 'Another tool adds a synthetic secret')
    await rm(join(f.a, 'temporary.md')); f.git(f.a, 'add', '-u'); f.git(f.a, 'commit', '-m', 'Another tool removes it')
    const before = await snapshot(f), remoteBefore = f.git(f.base, '--git-dir', f.remote, 'rev-parse', 'main')
    const result = await f.A.send(f.av)
    expect(result.reason?.code).toBe('secret-found'); expect(result.reason?.document).toBe('temporary.md'); expect(await snapshot(f)).toEqual(before)
    expect(f.git(f.base, '--git-dir', f.remote, 'rev-parse', 'main')).toBe(remoteBefore)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('R7 a secret already on the remote does not block receiving a clean local change', async () => {
  const f = await fixture()
  try {
    const fake = 'ghp_' + randomBytes(18).toString('hex')
    await f.put(f.b, 'other.md', `Pushed by plain git: ${fake}\n`); f.git(f.b, 'add', '-A'); f.git(f.b, 'commit', '-m', 'x'); f.git(f.b, 'push')
    await f.put(f.a, 'draft.md', 'Local edit.\n')
    const r = await f.A.fetchAndIntegrate(f.av)
    expect(r.reason).toBeUndefined(); expect(await text(f.a, 'other.md')).toContain(fake); expect(await text(f.a, 'draft.md')).toBe('Local edit.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('receiving still brings in other documents when a dirty local secret cannot be committed', async () => {
  const f = await fixture()
  try {
    const fake = 'ghp_' + randomBytes(18).toString('hex')
    await f.put(f.a, 'draft.md', `Local only ${fake}\n`)
    await f.put(f.b, 'second.md', 'Incoming while local is flagged.\n'); await f.B.send(f.bv)
    const r = await f.A.fetchAndIntegrate(f.av)
    expect(await text(f.a, 'second.md')).toBe('Incoming while local is flagged.\n')
    expect(await text(f.a, 'draft.md')).toContain(fake)
    expect(f.git(f.a, 'show', 'HEAD:draft.md')).toBe('The initial draft.')
    expect(r.reason?.code).toBe('secret-found'); expect(r.reason?.document).toBe('draft.md')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('flagged dirty document receives an incoming version beside it without committing local bytes', async () => {
  const f = await fixture()
  try {
    const fake = 'ghp_' + randomBytes(18).toString('hex'), local = `Flagged local ${fake}\n`
    await f.put(f.a, 'draft.md', local)
    await f.put(f.b, 'draft.md', 'Incoming version during flag.\n'); await f.B.send(f.bv)
    const r = await f.A.fetchAndIntegrate(f.av)
    expect(r.reason?.code).toBe('secret-found'); expect(r.pairs).toHaveLength(1)
    expect(await text(f.a, 'draft.md')).toBe(local)
    expect(await text(f.a, r.pairs[0].other)).toBe('Incoming version during flag.\n')
    expect(f.git(f.a, 'show', 'HEAD:draft.md')).toBe('Incoming version during flag.')
    expect(f.git(f.remote, 'show', 'main:draft.md')).not.toContain(fake)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a secret already committed in divergent local history stops receiving rather than rewriting user history or making an unscanned merge', async () => {
  const f = await fixture()
  try {
    const fake = 'ghp_' + randomBytes(18).toString('hex')
    await f.put(f.a, 'draft.md', `Committed local-only secret ${fake}\n`); f.git(f.a, 'commit', '-am', 'User local history')
    await f.put(f.b, 'second.md', 'Divergent incoming.\n'); await f.B.send(f.bv)
    const before = await snapshot(f), r = await f.A.fetchAndIntegrate(f.av)
    expect(r.reason?.code).toBe('secret-found'); expect(r.reason?.document).toBe('draft.md'); expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('receiving around a flagged draft also preserves a different caller-unsaved document', async () => {
  const f = await fixture()
  try {
    const fake = 'ghp_' + randomBytes(18).toString('hex')
    await f.put(f.a, 'draft.md', `Flagged dirty ${fake}\n`)
    await f.put(f.b, 'second.md', 'Incoming into an unsaved editor.\n'); expect((await f.B.send(f.bv)).reason).toBeUndefined()
    const r = await f.A.fetchAndIntegrate(f.av, { unsavedPaths: ['second.md'] })
    expect(await text(f.a, 'second.md')).toBe('The second document.\n')
    expect(r.reason?.code).toBe('secret-found'); expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0].local).toBe('second.md'); expect(await text(f.a, r.pairs[0].other)).toBe('Incoming into an unsaved editor.\n')
    expect(await text(f.a, 'draft.md')).toContain(fake)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGitAndGitleaks('a synthetic secret in a raw snapshot object blocks sending and leaves the index and tree unchanged', async () => {
  const f = await fixture()
  try {
    await seed(f)
    const fake = 'ghp_' + randomBytes(18).toString('hex'), bytes = `Snapshot contains a synthetic token ${fake}\n`, path = `.bridle/objects/${hash(bytes)}`
    await f.put(f.a, path, bytes); const before = await snapshot(f), result = await f.A.send(f.av)
    expect(result.reason?.code).toBe('secret-found'); expect(result.reason?.document).toBe(path); expect(await snapshot(f)).toEqual(before); expect(JSON.stringify(result)).not.toContain(fake)
  } finally { await f.close() }
}, limit)

test('S7 packed recovery bytes still fail closed under the secret scan',async()=>{
 const f=await fixture();try{
  const {snapshot}=await import('./git-vault-sync-fixture')
  const fake='synthetic-secret-for-pack-test',path='.bridle/journal.from-'+'a'.repeat(64)+'.jsonl'
  await f.put(f.a,'.bridle/journal.jsonl.sync-pack.json',JSON.stringify({version:1,files:[{path,data:Buffer.from(JSON.stringify({note:fake})+'\n').toString('base64')}]}))
  const before=await snapshot(f)
  const result=await f.engineA({scanner:async blobs=>({findings:blobs.filter(b=>b.bytes.includes(fake)).map(b=>({path:b.path,rule:'test',line:1}))})}).send(f.av)
  expect(result.reason?.code).toBe('secret-found');expect(await snapshot(f)).toEqual(before)
 }finally{await f.close()}
},120000)
