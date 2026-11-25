/** Small, machine-local proof shared by the app and CLI. Never an edit to Git's index. */
import { randomUUID } from 'node:crypto'
import type { BigIntStats } from 'node:fs'
import { lstat, readFile, open, rename, unlink } from 'node:fs/promises'
import { safePath, type SyncGit } from './git-vault-sync-git'
import { refuse } from './git-vault-sync-types'
export type LargeFileEvidence = { path:string; oid:string; dev:string; ino:string; size:string; mtimeNs:string; ctimeNs:string; mode:string }
const fields=['dev','ino','size','mtimeNs','ctimeNs','mode'] as const
export const evidenceFor=(path:string,oid:string,st:BigIntStats):LargeFileEvidence=>({path,oid,...Object.fromEntries(fields.map(k=>[k,String(st[k])]))} as LargeFileEvidence)
export function evidenceMatches(e:LargeFileEvidence,st:BigIntStats|null,index?:{oid:string;mode:string},head?:{oid:string;mode:string}):boolean {
 return !!(st?.isFile()&&!st.isSymbolicLink()&&index&&head&&e.oid===index.oid&&e.oid===head.oid&&index.mode===head.mode&&((st.mode&0o111n)!==0n)===(head.mode==='100755')&&fields.every(k=>String(st[k])===e[k]))
}
export async function readLargeEvidence(git:SyncGit):Promise<Map<string,LargeFileEvidence>> {
 const path=await git.text(['rev-parse','--path-format=absolute','--git-path','writeflex-large-files.json'])
 const st=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(!st)return new Map()
 if(!st.isFile()||st.isSymbolicLink()||st.size>1024*1024)refuse('unsupported','The saved large-file check is not a small regular file. Check this repository with Git.')
 try {
  const file=JSON.parse(await readFile(path,'utf8'))
  if(!file||file.version!==1||!Array.isArray(file.entries))return new Map()
  return new Map(file.entries.filter((e:any)=>e&&typeof e.path==='string'&&safePath(e.path)&&typeof e.oid==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(e.oid)&&fields.every(k=>typeof e[k]==='string'&&/^\d+$/.test(e[k]))).map((e:LargeFileEvidence)=>[e.path,e]))
 }catch(error){if(error instanceof SyntaxError)return new Map();throw error}
}
export async function writeLargeEvidence(git:SyncGit,proof:Map<string,LargeFileEvidence>):Promise<void> {
 const path=await git.text(['rev-parse','--path-format=absolute','--git-path','writeflex-large-files.json']),temp=path+'.'+randomUUID()+'.tmp'
 const st=await lstat(path).catch(e=>{if(e.code==='ENOENT')return null;throw e})
 if(st&&(!st.isFile()||st.isSymbolicLink()))refuse('unsupported','The saved large-file check is not a regular file. Check this repository with Git.')
 const data=JSON.stringify({version:1,entries:[...proof.values()].sort((a,b)=>a.path.localeCompare(b.path))})+'\n'
 if(Buffer.byteLength(data)>1024*1024)refuse('unsupported','Too many large-file checks are waiting. Check this repository with Git.')
 try {
  const fd=await open(temp,'wx',0o600)
  try{await fd.writeFile(data);await fd.sync()}finally{await fd.close()}
  await rename(temp,path)
 }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e})}
}
