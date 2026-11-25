import { expect } from 'bun:test'
import { testWithSafeSyncGitAndGitleaks as test } from './git-sync-prerequisites'
for(const mode of ['history','incoming'] as const)test(`large-file refusal controller: ${mode} waits for Git movement and queues explicit checking`,async()=>{
 const child=Bun.spawn([process.execPath,'tests/main/git-sync-large-review-probe.ts',mode],{stdout:'pipe',stderr:'pipe'})
 const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited])
 console.info(out.trim());if(err)console.error(err.trim());expect(code).toBe(0)
 const proof=JSON.parse(out.trim().split('\n').at(-1)!)
 expect(proof.unchangedRetries).toBe(0);expect(proof.queuedChecks).toBe(1);expect(proof.resumedRetries).toBe(0);expect(proof.remoteMoveRetries).toBe(1);expect(proof.indexMoveRetries).toBe(1);expect(proof.headMoveRetries).toBe(1)
},180000)
