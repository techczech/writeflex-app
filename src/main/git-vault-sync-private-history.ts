/** The tracked journal remains tracked. Only its private live view is skip-worktree locally. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import type { SyncGit } from './git-vault-sync-git'
import { friendlyComputerName } from './git-vault-sync-computer'
import { journalPublished } from './git-vault-sync-journals'
import { entries, safePath, syncGit } from './git-vault-sync-git'
import { developerToolsPresent } from './developer-tools'
import { applyFiles, image, observeFiles } from './git-vault-sync-files'
import { refuse, type GitVaultSyncOptions } from './git-vault-sync-types'
const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex')
// Stores opened by Bridle's runtime and the UI share the same appendNow seam.
const writers=new Map<string,{before:()=>Promise<void>;after:()=>Promise<void>}>()
const wrapped=new WeakSet<object>()
const oversized=new Set<string>()
async function withinCap(path:string) {const st=await lstat(path).catch(()=>null);if(st && st.size>32*1024*1024){if(!oversized.has(path)){oversized.add(path);console.warn('History safety copying paused for an oversized journal; saving continues.')}return false}return true}
/** Git vault sync's journal-append protection is on only when vault sync was switched on at launch (Settings ›
 *  Advanced): the app sets it from registerGitSync, the command line from the profile's settings. Off (the default),
 *  a history append is an ordinary local append: no Git, no safety copy, no restored journal bytes. */
let appendProtection=false
export function setSyncAppendProtection(on:boolean):void{appendProtection=on}
/** The launch-time switch as the command line reads it: the shared settings file, then the earlier one. */
export function syncSwitchedOnIn(profile:string):boolean{
 for(const [file,section] of [['settings-v2.json','settings'],['settings.json','values']] as const){
  try{const value=JSON.parse(readFileSync(join(profile,file),'utf8'))?.[section]?.['experimental.gitVaultSync'];if(typeof value==='boolean')return value}catch{/* missing or unreadable: next */}
 }
 return false
}
export function protectSnapshotAppends(store:object): void {
 if(!appendProtection||wrapped.has(store))return
 const s=store as {dir?:string;appendNow?:(...args:unknown[])=>Promise<void>}
 if(typeof s.dir!=='string'||typeof s.appendNow!=='function')return
 const append=s.appendNow,dir=s.dir
 s.appendNow=async function(...args){const permitted=await withinCap(resolve(dir,'journal.jsonl'));const guard=permitted?(writers.get(resolve(dir,'journal.jsonl'))??await standaloneGuard(dir)):undefined;await guard?.before();await append.apply(this,args);if(await withinCap(resolve(dir,'journal.jsonl')))await guard?.after()}
 wrapped.add(store)
}
async function regular(path:string):Promise<Buffer|null> {
 const st=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(!st)return null
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size>32*1024*1024)refuse('unsupported','A local history safety copy needs checking.')
 return readFile(path)
}
async function durable(path:string,bytes:Buffer) {
 await mkdir(dirname(path),{recursive:true})
 const temp=path+'.'+randomUUID()+'.tmp'
 try{const fd=await open(temp,'wx',0o600);try{await fd.writeFile(bytes);await fd.sync()}finally{await fd.close()}await rename(temp,path)}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e})}
}
export async function skipPrivateJournals(git:SyncGit,paths:Iterable<string>,env:Record<string,string>={}) {
 for(const path of paths) {
  if(!safePath(path))refuse('unsupported','A private history path is invalid.')
  // Only the disposable prepared index is edited; installation preserves sibling entries.
  await git.ok(['update-index','--skip-worktree','--',path],env)
 }
}
type Repository={root:string;gitDir:string;git:SyncGit}
// The command-line writer can run while the window process is closed. Its guard uses
// the same per-worktree app state; it neither enables sync nor contacts a remote.
async function standaloneGuard(dir:string) {
 if(!await lstat(join(dir,'journal.jsonl.sync-fork.json')).catch(()=>null))return
 // Without the Command Line Tools no Git may start; the repository is then found from the file system alone, so
 // appends made while sync is off are still recorded and reappear in the reader when sync rejoins.
 const tools=await developerToolsPresent()
 let root:string,gitDir:string
 if(tools) {
  const git=syncGit(dirname(dir)),top=await git.run(['rev-parse','--show-toplevel'])
  if(top.code!==0)return
  root=top.out.toString().trim();gitDir=await git.text(['rev-parse','--absolute-git-dir'])
 } else {
  const found=await gitLocation(dirname(dir))
  if(!found)return
  ;({root,gitDir}=found)
 }
 const path=relative(root,join(dir,'journal.jsonl'))
 if(!safePath(path))return
 const off=join(gitDir,'writeflex-live-history',hash(path)+'.off')
 if(await lstat(off).catch(()=>null)) {
  const state=await lstat(dirname(off));if(!state.isDirectory()||state.isSymbolicLink())refuse('unsupported','The local history safety folder needs checking.')
  let before:Buffer|null=null
  return {before:async()=>{before=await regular(join(dir,'journal.jsonl'))},after:async()=>{const after=await regular(join(dir,'journal.jsonl'));if(before&&after&&after.subarray(0,before.length).equals(before)){const file=off+'.appends',old=await regular(file)??Buffer.alloc(0);await durable(file,Buffer.concat([old,after.subarray(before.length)]))}}}
 }
 // Sync is on but paused: its Git-based protection resumes with the tools, as it did when Git could not run.
 if(!tools)return
 await protectLiveJournals({root,gitDir,git:syncGit(root)},[path])
 return writers.get(resolve(dir,'journal.jsonl'))
}
/** The work tree and Git folder above `start`, as `rev-parse --show-toplevel` and `--absolute-git-dir` name them, read
 *  from the file system without running Git: a `.git` folder, or a linked worktree's `gitdir:` file. */
async function gitLocation(start:string):Promise<{root:string;gitDir:string}|null> {
 let folder=await realpath(start).catch(()=>null)
 while(folder) {
  const marker=join(folder,'.git'),st=await lstat(marker).catch(()=>null)
  if(st?.isDirectory()){const gitDir=await realpath(marker).catch(()=>null);return gitDir?{root:folder,gitDir}:null}
  if(st?.isFile()) {
   const named=/^gitdir: (.+?)\s*$/.exec(await readFile(marker,'utf8').catch(()=>''))
   const gitDir=named?await realpath(resolve(folder,named[1]!)).catch(()=>null):null
   return gitDir&&(await lstat(gitDir)).isDirectory()?{root:folder,gitDir}:null
  }
  if(st)return null
  const parent=dirname(folder);folder=parent===folder?null:parent
 }
 return null
}
/** Before trusting live history, recover our last known private view; never discard found bytes. */
export async function protectLiveJournals(c:Repository,paths:Iterable<string>,options:Pick<GitVaultSyncOptions,'ownWrite'|'withFileLock'|'computerName'>={}) {
 const uncertain:string[]=[];const ownName=options.computerName??friendlyComputerName()
 for(const path of paths) {
  if(!safePath(path))refuse('unsupported','A private history path is invalid.')
  const stateDir=join(c.gitDir,'writeflex-live-history')
  await mkdir(stateDir,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error})
  const state=await lstat(stateDir)
  if(!state.isDirectory()||state.isSymbolicLink())refuse('unsupported','The local history safety folder needs checking.')
  const absolute=join(c.root,path),backup=join(stateDir,hash(path)+'.jsonl')
  await observeFiles(c.root,[path],new Map())
  const off=backup.replace(/\.jsonl$/,'.off'),appends=await regular(off+'.appends')
  let saved=await regular(backup);const current=await image(absolute)
  const tracked=await c.git.run(['show',`HEAD:${path}`])
  if(!saved && current) {
   const tree=await entries(c.git,'HEAD')
   const marker=tree.get(path+'.sync-fork.json'),manifest=marker?JSON.parse((await c.git.ok(['cat-file','blob',marker.oid])).toString()):null
   if(manifest && hash(current.bytes)!==manifest.canonicalHash && await journalPublished(c.git,tree,path,current.bytes)) {
    const revisions=(await c.git.text(['log','--format=%H','-n','40','HEAD'])).split('\n')
    for(const rev of revisions){
     const who=(await c.git.text(['show','-s','--format=%cn%x00%ce%x00%(trailers:key=WriteFlex-Computer,valueonly)',rev])).split('\0')
     if(who[0]!==`WriteFlex on ${ownName}`||who[1]!=='writeflex@localhost'||who[2]?.trim()!==ownName)continue
     const old=await c.git.run(['show',`${rev}:${path}`]);if(old.code!==0||!await journalPublished(c.git,tree,path,old.out))continue
     const parents=(await c.git.text(['rev-list','--parents','-n','1',rev])).split(' ').slice(1)
     let introduced=parents.length>0
     for(const parent of parents){const prior=await c.git.run(['show',`${parent}:${path}`]);if(prior.code===0&&prior.out.equals(old.out))introduced=false}
     if(introduced){saved=current.bytes.subarray(0,old.out.length).equals(old.out)?current.bytes:old.out;await durable(backup,saved);break}
    }
    if(!saved)uncertain.push(path)
   }
  }
  if(saved&&appends?.length){const known=new Set(saved.toString().split('\n'));const added=appends.toString().split('\n').filter(line=>line&&!known.has(line)&&!!known.add(line));if(added.length){saved=Buffer.concat([saved,saved.at(-1)===10?Buffer.alloc(0):Buffer.from('\n'),Buffer.from(added.join('\n')+'\n')]);await durable(backup,saved)}}
  const replacedByGit=current && tracked.code===0 && current.bytes.equals(tracked.out)
  if(saved && (!current || !current.bytes.equals(saved) && (replacedByGit || !current.bytes.subarray(0,saved.length).equals(saved)))) {
   const plan:import('./git-vault-sync-files').FileChange[]=[]
   if(current && !await journalPublished(c.git,await entries(c.git,'HEAD'),path,current.bytes)) {
    const from=await sourceComputer(c,path,current.bytes)
    await archiveSource(c,path,current.bytes,from,plan)
   }
   plan.push({path,before:current,after:{bytes:saved,mode:current?.mode??0o644}})
   await applyFiles(c.root,plan,undefined,'',undefined,options.ownWrite,options.withFileLock)
  } else if(current&&!uncertain.includes(path)) await durable(backup,current.bytes)
  await unlink(off).catch(e=>{if(e.code!=='ENOENT')throw e});await unlink(off+'.appends').catch(e=>{if(e.code!=='ENOENT')throw e})
  // Every in-app append is backed up before its promise resolves, including Bridle runtime appends.
  writers.set(absolute,{before:async()=>{await protectLiveJournals(c,[path],options)},after:async()=>{const live=await regular(absolute);if(live)await durable(backup,live)}})
 }
 return uncertain
}

/** Off rejoins Git's normal live file, retaining exact private history as recovery evidence. */
export async function releaseLiveJournals(c:Repository,paths:string[],options:Pick<GitVaultSyncOptions,'ownWrite'|'withFileLock'|'computerName'>) {
 for(const path of paths) {
  await protectLiveJournals(c,[path],options)
  const current=await image(join(c.root,path)),tracked=await c.git.ok(['show',`HEAD:${path}`])
  const plan:import('./git-vault-sync-files').FileChange[]=[]
  if(current&&!current.bytes.equals(tracked)&&!await journalPublished(c.git,await entries(c.git,'HEAD'),path,current.bytes))await archiveSource(c,path,current.bytes,options.computerName??friendlyComputerName(),plan)
  if(current&&!current.bytes.equals(tracked))plan.push({path,before:current,after:{bytes:tracked,mode:current.mode}})
  const applied=await applyFiles(c.root,plan,undefined,'',undefined,options.ownWrite,options.withFileLock)
  try{await c.git.ok(['update-index','--no-skip-worktree','--',path])}catch(e){await applied.rollback();throw e}
  writers.delete(join(c.root,path))
  await durable(join(c.gitDir,'writeflex-live-history',hash(path)+'.off'),Buffer.from('off'))
 }
}

async function sourceComputer(c:Repository,path:string,bytes:Buffer):Promise<string> {
 const revisions=(await c.git.text(['log','--format=%H','-n','40','HEAD','--',path])).split('\n').filter(Boolean)
 for(const rev of revisions){
  const blob=await c.git.run(['show',`${rev}:${path}`]);if(blob.code!==0||!blob.out.equals(bytes))continue
  const parents=(await c.git.text(['rev-list','--parents','-n','1',rev])).split(' ').slice(1)
  let introduced=true
  for(const parent of parents){const prior=await c.git.run(['show',`${parent}:${path}`]);if(prior.code===0&&prior.out.equals(bytes))introduced=false}
  if(!introduced)continue
  const parts=(await c.git.text(['show','-s','--format=%cn%x00%ce%x00%(trailers:key=WriteFlex-Computer,valueonly)',rev])).split('\0')
  const name=parts[2]?.trim()
  return name&&parts[1]==='writeflex@localhost'&&parts[0]===`WriteFlex on ${name}`?name:'another computer'
 }
 return 'another computer'
}
async function archiveSource(c:Repository,path:string,bytes:Buffer,from:string,plan:import('./git-vault-sync-files').FileChange[]) {
 const dates=bytes.toString().split('\n').flatMap(row=>{try{const ts=JSON.parse(row).ts;return typeof ts==='number'&&Number.isFinite(ts)&&Math.abs(ts)<=8640000000000000?[new Date(ts).toISOString().slice(0,10)]:[]}catch{return []}}).sort()
 const range=dates.length?dates[0]===dates.at(-1)?dates[0]:`${dates[0]}–${dates.at(-1)}`:'an undated period'
 const meta=Buffer.from(JSON.stringify({version:1,from,range,prefixHash:hash(''),prefixBytes:0,sourceHash:hash(bytes)})+'\n')
 let stem=path.slice(0,-6)+'.from-'+hash(meta),n=1
 for(;;){const data=await image(join(c.root,stem+'.jsonl')),m=await image(join(c.root,stem+'.json'));if((!data||data.bytes.equals(bytes))&&(!m||m.bytes.equals(meta))){if(!data)plan.push({path:stem+'.jsonl',before:null,after:{bytes,mode:0o644}});if(!m)plan.push({path:stem+'.json',before:null,after:{bytes:meta,mode:0o644}});return}stem=path.slice(0,-6)+'.from-'+hash(meta)+'-'+(++n)}
}
