/** Explicit-only, one-pass verification. It writes app evidence, never Git's index or payloads. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { entries, nul, type SyncGit } from './git-vault-sync-git'
import { evidenceFor, evidenceMatches, readLargeEvidence, writeLargeEvidence, type LargeFileEvidence } from './git-vault-sync-large-evidence'
import { refuse, type GitSyncLargeCheck } from './git-vault-sync-types'
import type { SyncSelection } from './git-vault-sync-selection'
type Context = { root:string; prefix:string; index:string; git:SyncGit }
export async function checkLargeFileContents(c:Context,selection:SyncSelection):Promise<GitSyncLargeCheck[]> {
 const original=await readFile(c.index),head=await c.git.text(['rev-parse','HEAD']),tree=await entries(c.git,head)
 const algorithm=await c.git.text(['rev-parse','--show-object-format']),indexEntries=new Map<string,{oid:string;mode:string}>()
 for(const line of nul(await c.git.ok(['ls-files','--stage','-z']))){const m=/^(\d+) ([a-f0-9]+) 0\t([\s\S]+)$/.exec(line);if(m)indexEntries.set(m[3],{mode:m[1],oid:m[2]})}
 const checks:GitSyncLargeCheck[]=[],verified=new Map<string,LargeFileEvidence>()
 for(const candidate of selection.candidates.filter(p=>p.path.startsWith(c.prefix))) {
  const name=candidate.path,entry=tree.get(name),st=await lstat(join(c.root,name),{bigint:true}).catch(e=>{if(e.code==='ENOENT')return null;throw e})
  if(!entry||!st?.isFile()||st.isSymbolicLink()){checks.push({path:name.slice(c.prefix.length),state:'needs-checking'});continue}
  const blobHash=createHash(algorithm).update(`blob ${st.size}\0`),payloadHash=createHash('sha256')
  let pointer:{oid:string;size:bigint}|undefined
  if(candidate.cause==='lfs'&&Number(await c.git.text(['cat-file','-s',entry.oid]))<=1024){
   const m=/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/.exec((await c.git.ok(['cat-file','blob',entry.oid])).toString())
   if(m)pointer={oid:m[1],size:BigInt(m[2])}
  }
  const file=await open(join(c.root,name),constants.O_RDONLY|constants.O_NOFOLLOW)
  let unchanged=false
  try {
   const opened=await file.stat({bigint:true})
   if(opened.ino!==st.ino||opened.dev!==st.dev)refuse('local-changes','The file changed during the large-file check.',name.slice(c.prefix.length))
   const buffer=Buffer.alloc(1024*1024)
   for(;;){const {bytesRead}=await file.read(buffer);if(!bytesRead)break;const bytes=buffer.subarray(0,bytesRead);blobHash.update(bytes);payloadHash.update(bytes)}
   const after=await file.stat({bigint:true}),proof=evidenceFor(name,entry.oid,st)
   const sameFile=evidenceMatches(proof,after,{...entry},entry)
   // A pointer-only checkout and a hydrated payload are both valid unchanged LFS views.
   unchanged=sameFile&&(blobHash.digest('hex')===entry.oid||!!(pointer&&pointer.size===st.size&&payloadHash.digest('hex')===pointer.oid))
   if(unchanged&&evidenceMatches(proof,st,indexEntries.get(name),entry))verified.set(name,proof)
  }finally{await file.close()}
  checks.push({path:name.slice(c.prefix.length),state:verified.has(name)?'unchanged':unchanged?'needs-checking':'changed'})
 }
 if(await c.git.text(['rev-parse','HEAD'])!==head||!(await readFile(c.index)).equals(original))refuse('repository-changed','Git changed during the large-file check. Nothing was sent.')
 for(const [path,proof] of verified){const st=await lstat(join(c.root,path),{bigint:true});if(!evidenceMatches(proof,st,indexEntries.get(path),tree.get(path)))refuse('local-changes','The file changed during the large-file check.',path.slice(c.prefix.length))}
 const evidence=await readLargeEvidence(c.git)
 for(const p of selection.candidates.filter(p=>p.path.startsWith(c.prefix)))evidence.delete(p.path)
 for(const [path,proof] of verified)evidence.set(path,proof)
 await writeLargeEvidence(c.git,evidence)
 return checks
}
export async function checkLargeFilesAt(vault:string) {
 const {inspectGitVault}=await import('./git-vault-discovery'),{syncGit}=await import('./git-vault-sync-git'),{selectSyncFiles}=await import('./git-vault-sync-selection')
 const found=await inspectGitVault(vault)
 if(found.state!=='ready')refuse('repository-state',found.reason)
 const git=syncGit(found.root),c={...found,git,index:await git.text(['rev-parse','--path-format=absolute','--git-path','index'])}
 return checkLargeFileContents(c,await selectSyncFiles(git,c.root))
}
