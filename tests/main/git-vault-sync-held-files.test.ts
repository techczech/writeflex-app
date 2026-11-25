import { expect, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { open, readFile, rename, utimes, writeFile, lstat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fixture, largeFiles } from './git-vault-sync-fixture'
import { testWithSafeSyncGitAndGitleaks as test } from './git-sync-prerequisites'
import { gitState } from '../../src/shared/git-sync-view'

test('automatic sends omit changed large/LFS files, preserve staged bytes and survive reopening', async () => {
 const f=await fixture()
 try {
  const large=await largeFiles(f)
  await f.put(f.a,'inspection.lfs','Staged LFS version.\n'); f.git(f.a,'add','inspection.lfs')
  await f.put(f.a,'inspection.lfs','Unstaged LFS version.\n')
  const file=await open(join(f.a,'large.bin'),'r+'); try {await file.write(Buffer.from('changed'),0,7,0)} finally {await file.close()}
  const index=f.git(f.a,'ls-files','-s','--',...large.paths), remote=f.git(f.remote,'ls-tree','main','--',...large.paths)
  await f.put(f.a,'new.lfs','New LFS payload.\n')
  await large.reset(); await f.put(f.a,'draft.md','Sent prose.\n')
  const sent=await f.A.send(f.av)
  expect(sent.reason).toBeUndefined(); expect(sent.pending).toEqual([])
  expect(sent.held?.map(d=>d.path).sort()).toEqual([...large.paths,'new.lfs'].sort())
  expect(sent.state).toBe('held'); expect(gitState({result:sent} as any)).not.toBe(1)
  expect(f.git(f.remote,'show','main:draft.md')).toBe('Sent prose.')
  expect(f.git(f.remote,'ls-tree','main','--',...large.paths)).toBe(remote)
  expect(f.git(f.remote,'ls-tree','main','--','new.lfs')).toBe('')
  expect(f.git(f.a,'ls-files','-s','--',...large.paths)).toBe(index)
  expect(await readFile(join(f.a,'inspection.lfs'),'utf8')).toBe('Unstaged LFS version.\n')
  expect((await f.engineA().status(f.av)).held?.map(d=>d.path).sort()).toEqual([...large.paths,'new.lfs'].sort())
  const tip=f.git(f.a,'rev-parse','HEAD'); await f.A.send(f.av); expect(f.git(f.a,'rev-parse','HEAD')).toBe(tip)
  expect(await large.calls()).toEqual([])
 } finally {await f.close()}
},240000)

test('large deletion and rename stay held while other prose travels; equality is below the hold boundary',async()=>{
 const f=await fixture()
 try {
  const large=await largeFiles(f)
  const equal=await open(join(f.a,'boundary.bin'),'w');try{await equal.truncate(100_000_000)}finally{await equal.close()}
  const {selectSyncFiles}=await import('../../src/main/git-vault-sync-selection'),{syncGit}=await import('../../src/main/git-vault-sync-git')
  expect((await selectSyncFiles(syncGit(f.a,f.gitEnv),f.a)).large.has('boundary.bin')).toBe(false)
  // Test owns this synthetic file; move it outside the fixture repository before sending.
  await rename(join(f.a,'boundary.bin'),join(f.base,'boundary.bin'))
  await f.put(f.a,'inspection.lfs','Small LFS edit renamed without its attribute.\n')
  await rename(join(f.a,'inspection.lfs'),join(f.a,'renamed.bin'))
  // Shrinking a formerly large path does not grant authority to send it.
  await writeFile(join(f.a,'large.bin'),'smaller now')
  await f.put(f.a,'draft.md','Rename prose.\n');await large.reset()
  const result=await f.A.send(f.av)
  expect(result.reason).toBeUndefined();expect(result.held?.map(d=>d.path)).not.toContain('renamed.bin')
  expect(result.held?.map(d=>d.path)).toContain('inspection.lfs')
  expect(f.git(f.remote,'show','main:draft.md')).toBe('Rename prose.')
  expect(f.git(f.remote,'show','main:renamed.bin')).toBe('Small LFS edit renamed without its attribute.')
  expect(f.git(f.remote,'ls-tree','main','--','inspection.lfs')).not.toBe('')
  expect(await large.calls()).toEqual([])
 }finally{await f.close()}
},240000)

test('an outgoing commit touching a held file cannot leak through a prose push, including a reverted change',async()=>{
 const f=await fixture()
 try{
  await f.put(f.a,'.gitattributes','*.lfs filter=lfs -text\n');await f.put(f.a,'small.lfs','Baseline.\n');f.git(f.a,'add','.');f.git(f.a,'commit','-m','LFS baseline');f.git(f.a,'push')
  const remote=f.git(f.remote,'rev-parse','main')
  await f.put(f.a,'small.lfs','Committed held file.\n');f.git(f.a,'commit','-am','User large-file commit');f.git(f.a,'revert','--no-edit','HEAD')
  const head=f.git(f.a,'rev-parse','HEAD');await f.put(f.a,'draft.md','Cannot send yet.\n')
  const r=await f.A.send(f.av)
  expect(r.reason?.code).toBe('held-file-in-history');expect(r.reason?.document).toBe('small.lfs')
  expect(f.git(f.remote,'rev-parse','main')).toBe(remote);expect(f.git(f.a,'rev-parse','HEAD')).toBe(head)
 }finally{await f.close()}
},120000)

test('explicit checking reads stale large files once, records local equality evidence and never sends changed files',async()=>{
 const f=await fixture()
 try{
  const large=await largeFiles(f),head=f.git(f.a,'rev-parse','HEAD'),remote=f.git(f.remote,'rev-parse','main')
  for(const path of large.paths){const p=join(f.a,path),s=await lstat(p);await utimes(p,s.atime,new Date(s.mtimeMs-2000))}
  expect((await f.A.status(f.av)).held).toHaveLength(2)
  const beforeIndex=await readFile(join(f.a,'.git/index'))
  const counts=new Map<string,number>(),originalOpen=fs.open
  const observer=spyOn(fs,'open').mockImplementation((async(...args:Parameters<typeof fs.open>)=>{const path=String(args[0]);if(large.paths.some(p=>join(f.a,p)===path))counts.set(path,(counts.get(path)??0)+1);return originalOpen(...args)}) as typeof fs.open)
  let r:Awaited<ReturnType<typeof f.A.status>>
  try{r=await f.A.checkLargeFiles(f.av)}finally{observer.mockRestore()}
  expect([...counts.values()]).toEqual([1,1]);expect(await readFile(join(f.a,'.git/index'))).toEqual(beforeIndex)
  expect(r.reason).toBeUndefined();expect(r.held).toEqual([]);expect(r.largeChecks?.every(c=>c.state==='unchanged')).toBe(true)
  expect((await f.engineA().status(f.av)).held).toEqual([])
  await f.put(f.a,'inspection.lfs','Changed after checking.\n')
  const changed=await f.A.checkLargeFiles(f.av)
  expect(changed.held?.find(p=>p.path==='inspection.lfs')?.state).toBe('changed')
  const profile=join(f.base,'cli-profile'),developer=join(f.base,'cli-developer'),selector=join(f.base,'cli-xcode-select')
  await fs.mkdir(join(developer,'usr/bin'),{recursive:true});await fs.mkdir(profile)
  await fs.copyFile(join(f.base,'a-settings.json'),join(profile,'settings.json'))
  const realGit=join(execFileSync('/usr/bin/xcode-select',['-p']).toString().trim(),'usr/bin/git'),quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'"
  await fs.writeFile(join(developer,'usr/bin/git'),`#!/bin/sh\nGIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 exec ${quote(realGit)} "$@"\n`)
  await fs.writeFile(selector,`#!/bin/sh\nprintf '%s\\n' ${quote(developer)}\n`)
  await fs.chmod(join(developer,'usr/bin/git'),0o755);await fs.chmod(selector,0o755)
  const child=Bun.spawn([process.execPath,'-e',`
   const c=JSON.parse(process.env.WF_HELD_CLI_CONFIG);
   const {developerToolsSeams}=await import('./src/main/developer-tools.ts');developerToolsSeams.command=c.selector;developerToolsSeams.platform='darwin';
   const {runCli}=await import('./src/main/cli/run.ts');
   process.exit(await runCli(['--root',c.root,'--json','check-large-files'],{cwd:c.root,home:c.home,write:{appDataFolders:[c.profile]},stdout:t=>process.stdout.write(t),stderr:t=>process.stderr.write(t)}));
  `],{env:{...process.env,...f.gitEnv,WRITEFLEX_DATA_DIR:profile,WF_HELD_CLI_CONFIG:JSON.stringify({root:f.av,profile,selector,home:f.base})},stdout:'pipe',stderr:'pipe'})
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
  expect(err).toBe('');expect(code).toBe(0);expect(JSON.parse(out).result.checks).toContainEqual({path:'inspection.lfs',state:'changed'})
  expect(f.git(f.a,'rev-parse','HEAD')).toBe(head);expect(f.git(f.remote,'rev-parse','main')).toBe(remote)
  expect(await large.calls()).toEqual([])
 }finally{await f.close()}
},240000)
