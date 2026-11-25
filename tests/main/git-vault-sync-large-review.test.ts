import { expect } from 'bun:test'
import { readFile, writeFile, lstat, utimes, open } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, largeFiles } from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks as test } from './git-sync-prerequisites'
import { readLargeEvidence } from '../../src/main/git-vault-sync-large-evidence'
import { syncGit } from '../../src/main/git-vault-sync-git'

for(const operation of ['send','fetchAndIntegrate'] as const)test(`incoming LFS difference refuses ${operation} without moving HEAD, index or payload; plain Git unblocks it`,async()=>{
 const f=await fixture()
 try{
  const large=await largeFiles(f,[32,100_000_001])
  await f.put(f.b,'inspection.lfs','Other Mac payload.\n');f.git(f.b,'add','inspection.lfs');f.git(f.b,'commit','-m','Manual LFS change');f.git(f.b,'push')
  await f.put(f.a,'draft.md','Local writing still waiting.\n')
  const head=f.git(f.a,'rev-parse','HEAD'),index=await readFile(join(f.a,'.git/index')),bytes=await readFile(join(f.a,'inspection.lfs'))
  await large.reset()
  const result=await f.A[operation](f.av)
  expect(result.reason?.code).toBe('large-file-changed-elsewhere');expect(result.reason?.document).toBe('inspection.lfs')
  expect(result.reason?.message).toBe('inspection.lfs is a large file that was changed in the other copy. WriteFlex does not move large files. Update this folder with Git and Git LFS, then sync carries on by itself.')
  expect(result.pending.map(p=>p.path)).toContain('draft.md');expect(result.retryBlock?.head).toBe(head)
  expect(f.git(f.a,'rev-parse','HEAD')).toBe(head);expect(await readFile(join(f.a,'.git/index'))).toEqual(index);expect(await readFile(join(f.a,'inspection.lfs'))).toEqual(bytes)
  expect(await readFile(join(f.a,'draft.md'),'utf8')).toBe('Local writing still waiting.\n');expect(await large.calls()).toEqual([])
  f.git(f.a,'pull','--ff-only')
  // Force a racily clean cached timestamp with stock Git. Git's index writer must not
  // clean this held entry while installing only the prose change.
  const future=new Date(Date.now()+1000);await utimes(join(f.a,'inspection.lfs'),future,future);f.git(f.a,'add','inspection.lfs');await large.reset()
  expect((await f.engineA().send(f.av)).reason).toBeUndefined();expect(f.git(f.remote,'show','main:draft.md')).toBe('Local writing still waiting.')
  expect(await large.calls()).toEqual([])
 }finally{await f.close()}
},120000)

test('ordinary incoming writing is received while local LFS payload stays held',async()=>{
 const f=await fixture()
 try{
  const large=await largeFiles(f,[32,100_000_001]);await f.put(f.a,'inspection.lfs','Held here.\n')
  await f.put(f.b,'second.md','Incoming prose.\n');expect((await f.B.send(f.bv)).reason).toBeUndefined()
  await large.reset();const bytes=await readFile(join(f.a,'inspection.lfs')),result=await f.A.fetchAndIntegrate(f.av)
  expect(result.reason).toBeUndefined();expect(result.held?.map(p=>p.path)).toContain('inspection.lfs')
  expect(await readFile(join(f.a,'inspection.lfs'))).toEqual(bytes);expect(await readFile(join(f.a,'second.md'),'utf8')).toBe('Incoming prose.\n');expect(await large.calls()).toEqual([])
 }finally{await f.close()}
},120000)

test('a merge that inherits its LFS entry from a parent is not a new held-file change',async()=>{
 const f=await fixture()
 try{
  await largeFiles(f,[32,100_000_001])
  await f.put(f.a,'draft.md','Local committed prose.\n');f.git(f.a,'commit','-am','Local prose')
  await f.put(f.b,'inspection.lfs','Remote LFS committed explicitly.\n');f.git(f.b,'add','inspection.lfs');f.git(f.b,'commit','-m','Remote LFS');f.git(f.b,'push')
  f.git(f.a,'fetch','origin');f.git(f.a,'-c','user.name=WriteFlex on Mac A','-c','user.email=writeflex@localhost','merge','--no-ff','origin/main','-m','WriteFlex: inherited remote LFS')
  const result=await f.A.send(f.av)
  expect(result.reason).toBeUndefined();expect(f.git(f.remote,'show','main:draft.md')).toBe('Local committed prose.')
  const file=await open(join(f.a,'large.bin'),'r+');try{await file.write(Buffer.from('x'),0,1,0)}finally{await file.close()}
  f.git(f.a,'add','large.bin');f.git(f.a,'commit','-m','Size-only file change');f.git(f.a,'revert','--no-edit','HEAD')
  const blocked=await f.A.send(f.av)
  expect(blocked.reason?.code).toBe('held-file-in-history');expect(blocked.reason?.message).toBe('large.bin is in an unsent commit. Nothing is being sent. Send that commit with Git, then try again.')
 }finally{await f.close()}
},120000)

test('old hold causes disappear when the path or its own cause is gone, including after reopening',async()=>{
 const f=await fixture()
 try{
  await largeFiles(f,[32,100_000_001]);await f.put(f.a,'inspection.lfs','Changed.\n');expect((await f.A.status(f.av)).held?.map(p=>p.path)).toContain('inspection.lfs')
  f.git(f.a,'rm','-f','inspection.lfs');f.git(f.a,'commit','-m','Remove held file with Git');f.git(f.a,'push');f.git(f.b,'pull','--ff-only')
  expect((await f.engineA().status(f.av)).held?.map(p=>p.path)).not.toContain('inspection.lfs')
  await f.put(f.a,'small.lfs','Now ordinary.\n');expect((await f.A.status(f.av)).held?.map(p=>p.path)).toContain('small.lfs')
  await f.put(f.a,'.gitattributes','');f.git(f.a,'add','.gitattributes');f.git(f.a,'commit','-m','Remove LFS rule with Git');f.git(f.a,'push')
  expect((await f.engineA().status(f.av)).held?.map(p=>p.path)).not.toContain('small.lfs')
  expect((await f.A.send(f.av)).reason).toBeUndefined();expect(f.git(f.remote,'show','main:small.lfs')).toBe('Now ordinary.')
 }finally{await f.close()}
},120000)

test('pointer-only LFS checks write local evidence without touching the index; stale file or object identities discard it',async()=>{
 const f=await fixture()
 try{
  await largeFiles(f,[32,100_000_001])
  const pointer=f.git(f.a,'show','HEAD:inspection.lfs')+'\n',path=join(f.a,'inspection.lfs'),git=syncGit(f.a,f.gitEnv)
  await writeFile(path,pointer);const original=await readFile(join(f.a,'.git/index'))
  expect((await f.A.status(f.av)).held?.map(p=>p.path)).toContain('inspection.lfs')
  const result=await f.A.checkLargeFiles(f.av)
  expect(result.largeChecks).toContainEqual({path:'inspection.lfs',state:'unchanged'});expect(await readFile(join(f.a,'.git/index'))).toEqual(original)
  expect((await f.engineA().status(f.av)).held?.map(p=>p.path)).not.toContain('inspection.lfs');expect((await readLargeEvidence(git)).has('inspection.lfs')).toBe(true)
  const st=await lstat(path);await utimes(path,st.atime,new Date(st.mtimeMs-2000))
  expect((await f.engineA().status(f.av)).held?.map(p=>p.path)).toContain('inspection.lfs');expect((await readLargeEvidence(git)).has('inspection.lfs')).toBe(false)
  await f.A.checkLargeFiles(f.av);const fd=await open(path,'a');try{await fd.write(' ')}finally{await fd.close()}
  expect((await f.engineA().status(f.av)).held?.map(p=>p.path)).toContain('inspection.lfs');expect((await readLargeEvidence(git)).has('inspection.lfs')).toBe(false)
  await writeFile(path,pointer);await f.A.checkLargeFiles(f.av)
  await f.put(f.b,'inspection.lfs','A different committed object.\n');f.git(f.b,'add','inspection.lfs');f.git(f.b,'commit','-m','New LFS object')
  const oid=f.git(f.b,'rev-parse','HEAD:inspection.lfs');f.git(f.a,'fetch',f.b,'main');f.git(f.a,'update-index','--cacheinfo','100644',oid,'inspection.lfs');f.git(f.a,'commit','-m','Use a different committed LFS object')
  expect((await f.engineA().status(f.av)).held?.map(p=>p.path)).toContain('inspection.lfs');expect((await readLargeEvidence(git)).has('inspection.lfs')).toBe(false)
 }finally{await f.close()}
},120000)
