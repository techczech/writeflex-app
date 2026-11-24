import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
/** Content, not commit ids: monotone reconciliation may create commits without making progress. */
export async function pendingFingerprint(root: string, paths: readonly string[]): Promise<string> {
 const digest=createHash('sha256')
 for(const path of [...paths].sort()) {digest.update(path);try{digest.update(await readFile(join(root,path)))}catch{digest.update('missing')} }
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
