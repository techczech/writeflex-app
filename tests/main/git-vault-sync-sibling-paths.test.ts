// Git vault sync: Sibling paths.
// Guards ADR-0055 "Repository-wide incoming changes" (parcels 1, 1c, 4): a vault inside a larger repository never sends, overwrites or stages work in folders outside the vault, and stops before any repository-wide content conversion.
// Real `git`, a bare remote and two clones through the shared fixture; no Electron.
import { test, expect } from 'bun:test'
import { fixture, tree, snapshot, text } from './git-vault-sync-fixture'
import { testWithSafeSyncGit, testWithSafeSyncGitAndGitleaks } from './git-sync-prerequisites'

const timeout = 60_000

testWithSafeSyncGitAndGitleaks('subfolder send preserves staged and unstaged sibling edits; non-overlapping incoming sibling changes are applied', async () => {
  const f = await fixture(true)
  try {
    await f.put(f.a, 'sibling/notes.md', 'Staged sibling.\n'); f.git(f.a, 'add', 'sibling/notes.md')
    const staged = f.git(f.a, 'diff', '--cached', '--', 'sibling/notes.md')
    await f.put(f.a, 'sibling/notes.md', 'Unstaged sibling on top.\n'); await f.put(f.a, 'vault/draft.md', 'Vault writing.\n')
    expect((await f.A.send(f.av)).state).toBe('up-to-date')
    expect(f.git(f.a, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('vault/draft.md')
    expect(f.git(f.a, 'diff', '--cached', '--', 'sibling/notes.md')).toBe(staged)
    await f.B.fetchAndIntegrate(f.bv)
    await f.put(f.b, 'sibling/other.md', 'Remote sibling update.\n'); f.git(f.b, 'add', 'sibling/other.md'); f.git(f.b, 'commit', '-m', 'Another tool updates a sibling'); f.git(f.b, 'push')
    const result = await f.A.fetchAndIntegrate(f.av)
    expect(result.state).not.toBe('stopped'); expect(await text(f.a, 'sibling/other.md')).toBe('Remote sibling update.\n')
    expect(await text(f.a, 'sibling/notes.md')).toBe('Unstaged sibling on top.\n'); expect(f.git(f.a, 'diff', '--cached', '--', 'sibling/notes.md')).toBe(staged)
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGit('overlapping uncommitted sibling edits stop cleanly without changing the pre-attempt tree, index or HEAD', async () => {
  const f = await fixture(true)
  try {
    await f.put(f.a, 'sibling/notes.md', 'Private uncommitted sibling.\n')
    await f.put(f.b, 'sibling/notes.md', 'Remote sibling.\n'); f.git(f.b, 'add', 'sibling/notes.md'); f.git(f.b, 'commit', '-m', 'Other tool'); f.git(f.b, 'push')
    const before = await snapshot(f), result = await f.A.fetchAndIntegrate(f.av)
    expect(result.state).toBe('stopped'); expect(result.reason?.code).toBe('sibling-changes')
    expect(result.reason?.message).toBe('Another folder in this repository has changes that block the update.')
    expect(await snapshot(f)).toEqual(before)
  } finally { await f.close() }
}, timeout)

test('an existing conflict in a sibling folder stops without changing the merge already in progress', async () => {
  const f = await fixture(true)
  try {
    f.git(f.a, 'checkout', '-b', 'sibling-branch'); await f.put(f.a, 'sibling/notes.md', 'Branch version.\n'); f.git(f.a, 'add', 'sibling/notes.md'); f.git(f.a, 'commit', '-m', 'Branch change')
    f.git(f.a, 'checkout', 'main'); await f.put(f.a, 'sibling/notes.md', 'Main version.\n'); f.git(f.a, 'add', 'sibling/notes.md'); f.git(f.a, 'commit', '-m', 'Main change')
    try { f.git(f.a, 'merge', 'sibling-branch') } catch { /* real Git leaves an unresolved sibling conflict */ }
    expect(f.git(f.a, 'ls-files', '--unmerged')).not.toBe('')
    const before = await snapshot(f), mergeHead = await text(f.a, '.git/MERGE_HEAD')
    const result = await f.A.fetchAndIntegrate(f.av)
    expect(result.reason?.code).toBe('sibling-changes'); expect(await snapshot(f)).toEqual(before); expect(await text(f.a, '.git/MERGE_HEAD')).toBe(mergeHead)
  } finally { await f.close() }
}, timeout)

test('R3 send refuses an unpushed user commit touching sibling paths', async () => {
  const f = await fixture(true)
  try {
    await f.put(f.a, 'sibling/notes.md', 'Private WIP not meant to be pushed.\n'); f.git(f.a, 'commit', '-am', 'WriteFlex: message alone is not app authority'); 
    await f.put(f.a, 'vault/draft.md', 'Vault edit.\n')
    const r = await f.A.send(f.av)
    expect(r.reason?.code).toBe('outside-vault-commits')
    expect(f.git(f.remote, 'show', 'main:sibling/notes.md')).toBe('Original sibling.')
    expect(await text(f.a, 'sibling/notes.md')).toBe('Private WIP not meant to be pushed.\n')
  } finally { await f.close() }
}, timeout)

testWithSafeSyncGit('incoming filter and newline conversion attributes anywhere in the repository stop before writing raw blobs', async () => {
  for (const rule of ['text eol=crlf', 'filter=review-filter']) {
    const f = await fixture(true)
    try {
      f.git(f.a, 'config', 'filter.review-filter.smudge', 'cat')
      await f.put(f.b, '.gitattributes', `sibling/notes.md ${rule}\n`)
      await f.put(f.b, 'sibling/notes.md', 'Filtered incoming.\n')
      f.git(f.b, 'add', '.'); f.git(f.b, 'commit', '-m', 'Incoming conversion'); f.git(f.b, 'push')
      const before = await snapshot(f), r = await f.A.fetchAndIntegrate(f.av)
      expect(r.reason?.code).toBe('content-conversion'); expect(r.reason?.document).toBe('sibling/notes.md'); expect(await snapshot(f)).toEqual(before)
    } finally { await f.close() }
  }
}, timeout)

testWithSafeSyncGitAndGitleaks('S2 an ordinary pull merge introduces no new sibling work to publish',async()=>{
 const f=await fixture(true);try{
  await f.put(f.a,'vault/draft.md','A local vault.\n');await f.A.fetchAndIntegrate(f.av)
  await f.put(f.b,'sibling/notes.md','Remote sibling.\n');f.git(f.b,'commit','-am','Sibling B');f.git(f.b,'push')
  f.git(f.a,'pull','--no-rebase','--no-edit')
  const result=await f.A.send(f.av);expect(result.reason).toBeUndefined()
  expect(f.git(f.remote,'show','main:vault/draft.md')).toBe('A local vault.')
 }finally{await f.close()}
},120000)
