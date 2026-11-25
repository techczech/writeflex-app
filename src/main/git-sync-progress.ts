import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { syncGit } from './git-vault-sync-git'
import { selectSyncFiles } from './git-vault-sync-selection'
import { join } from 'node:path'
/** Ordinary content progress; large candidates contribute metadata only, never their payload bytes. */
export async function pendingFingerprint(root: string, paths: readonly string[], gitEnv: Record<string, string> = {}): Promise<string> {
 const digest=createHash('sha256')
 if (!paths.length) return digest.digest('hex')
 const atVault = syncGit(root, gitEnv), prefix = await atVault.text(['rev-parse', '--show-prefix'])
 const repository = await atVault.text(['rev-parse', '--show-toplevel'])
 const selection = await selectSyncFiles(syncGit(repository, gitEnv), repository)
 for(const path of [...paths].sort()) {digest.update(path);const large=selection.large.get(prefix+path);if(large){digest.update(large.evidence);continue}try{digest.update(await readFile(join(root,path)))}catch{digest.update('missing')} }
 return digest.digest('hex')
}
export class SendProgress {
 private stalled?: string
 shouldSend(fingerprint: string, manual = false) { return manual || fingerprint !== this.stalled }
 completed(before: string, after: string, internalPending: boolean, succeeded = true, newCommit = false): boolean {
  if(succeeded && !newCommit && internalPending && before===after) { const first=this.stalled!==after;this.stalled=after;return first }
  this.stalled=undefined;return false
 }
 changed() {this.stalled=undefined}
}

/** A refusal waits for repository movement, not more full selections of unchanged ancestry. */
export const isLargeSyncRefusal=(code?:string)=>code==='held-file-in-history'||code==='large-file-changed-elsewhere'
export async function retryBlockChanged(root:string,block:import('./git-vault-sync-types').GitSyncRetryBlock,gitEnv:Record<string,string>={}):Promise<boolean> {
 const {inspectGitVault}=await import('./git-vault-discovery')
 const d=await inspectGitVault(root,{gitEnv,timeoutMs:5000})
 if(d.state!=='ready')return true
 const git=syncGit(d.root,gitEnv,5000,5000)
 const head=await git.text(['rev-parse','HEAD']),indexPath=await git.text(['rev-parse','--path-format=absolute','--git-path','index'])
 if(head!==block.head||createHash('sha256').update(await readFile(indexPath)).digest('hex')!==block.index)return true
 // Query the branch identity only: this neither fetches blobs nor walks the working folder.
 try{const remote=(await git.network(['ls-remote','--heads',d.remote,`refs/heads/${d.branch}`])).out.toString().split(/\s/)[0];return remote!==block.remote}catch{return false}
}
