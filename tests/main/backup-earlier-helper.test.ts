import { expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createBackupEngine, createGitleaksScanner, urlDigest } from '@app-patterns/vault-sync'
import { ordinaryScopeTest } from '@app-patterns/vault-sync/helper/host'
import { appendHistoryApproval, HISTORY_APPROVAL_ENV } from '../../src/backup-helper/history-approvals'
import { readHistoryProjection, writeflexHistoryProjection } from '../../src/backup-helper/history-projection'
import { WRITEFLEX_HISTORY, WRITEFLEX_SCOPE } from '../../src/main/backup-helper/enrolment'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { versionTextReader } from '../../src/main/cli/history-store'
import { readVersionContent } from '../../src/main/version-content'
import { earlierFixture } from './backup-earlier-fixture'
const NODE = Bun.which('node')
if (!NODE) throw new Error('real Node on PATH required')
// PATH first; the developer-Mac locations remain the fallback, so a host without gitleaks on PATH
// fails only the tests that run it, as before.
const GIT = Bun.which('git') ?? '/Library/Developer/CommandLineTools/usr/bin/git'
const GITLEAKS = Bun.which('gitleaks') ?? '/opt/homebrew/bin/gitleaks'
test('built helper preview and ongoing engine capture require exact private authority; all 213 names restore',async()=>{
  const f=earlierFixture(),remote=join(f.base,'remote.git'),file=join(f.base,'private','earlier-locations.jsonl')
  const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',HOME:f.base,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}
  const git=(cwd:string,args:string[])=>{const r=spawnSync(GIT,args,{cwd,env});if(r.status!==0)throw new Error(r.stderr.toString());return r.stdout}
  git(f.base,['init','-q','--bare',remote]);git(f.root,['init','-q']);git(f.root,['remote','add','origin',remote])
  writeFileSync(join(f.root,'a.md'),'Synthetic current text\n')
  const config=join(f.base,'synthetic-config.json')
  writeFileSync(config,JSON.stringify({configVersion:2,machineId:'synthetic',tools:{git:GIT,gitleaks:GITLEAKS},vaults:[{id:'v',path:f.root,include:WRITEFLEX_SCOPE.include,exclude:WRITEFLEX_SCOPE.exclude,history:WRITEFLEX_HISTORY}]}))
  const preview=(approved:boolean)=>{
    const r=spawnSync(NODE,[resolve(import.meta.dir,'../../out/backup-helper/writeflex-backup-helper.js'),'preview','--config',config,'--vault','v'],{env:{...env,...(approved?{[HISTORY_APPROVAL_ENV]:file}:{})},timeout:10000,maxBuffer:4*1024*1024})
    expect(r.status).toBe(0);return JSON.parse(r.stdout.toString())
  }
  expect(preview(false).history.state).toBe('unavailable')
  // A planted vault record is not consulted.
  writeFileSync(join(f.root,'.writeflex','earlier-locations.jsonl'),'{}\n')
  expect(preview(false).history.state).toBe('unavailable')
  const c=await readHistoryProjection(f.root,p=>p.endsWith('.md'))
  if(c.state!=='unavailable'||!c.earlier)throw new Error('missing candidates')
  appendHistoryApproval(file,f.root,c.earlier,()=>true)
  expect(preview(true).history).toMatchObject({state:'complete',summary:{namedVersions:213}})
  const bridged = await new Promise<any>((resolveResult,reject) => {
    const child = spawn(NODE,[resolve(import.meta.dir,'../../out/backup-helper/writeflex-backup-helper.js'),'--github-credentials','preview','--config',config,'--vault','v'],{env:{...env,[HISTORY_APPROVAL_ENV]:file},stdio:['ignore','pipe','pipe','pipe','pipe']})
    let stdout='',stderr=''
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('synthetic bridge timed out'))},10000)
    child.stdout!.on('data',c=>stdout+=c);child.stderr!.on('data',c=>stderr+=c)
    child.on('error',e=>{clearTimeout(timer);reject(e)})
    const snapshot=Buffer.from(JSON.stringify({version:1,namespace:'writeflex.backup.github.v1',installId:'11111111-1111-4111-8111-111111111111',epoch:1,generation:1,expiresAt:Date.now()+600000,accessToken:'synthetic-placeholder',bindings:[]})),head=Buffer.alloc(4)
    head.writeUInt32BE(snapshot.length)
    const input=child.stdio[3] as import('node:stream').Writable
    input.on('error',()=>{});child.stdio[4]!.on('error',()=>{});input.end(Buffer.concat([head,snapshot]))
    child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(new Error(`bridge exit ${code}: ${stderr}`));else {try{resolveResult(JSON.parse(stdout))}catch(e){reject(e)}}})
  })
  expect(bridged.history).toMatchObject({state:'complete',summary:{namedVersions:213}})
  expect(preview(false).history.state).toBe('unavailable')
  if(!existsSync(GITLEAKS))throw new Error('real scanner required')
  const engine=createBackupEngine({machineId:'synthetic',gitPath:GIT,gitEnv:env,settleMs:5,homeDir:'/synthetic/nonexistent',mountInfo:async()=>null,remoteVisibility:async()=>'private',secretScanner:createGitleaksScanner({gitleaksPath:GITLEAKS,searchDirs:[]}),historyProjection:writeflexHistoryProjection(ordinaryScopeTest(WRITEFLEX_SCOPE),undefined,file)})
  await engine.enable(f.root,{expectedDestinationDigest:urlDigest(remote)})
  const captured=await engine.capture(f.root,WRITEFLEX_SCOPE)
  expect(captured.projected).toMatchObject({files:3})
  const copy=join(f.base,'restored');mkdirSync(copy)
  const paths=git(f.root,['ls-tree','-r','--name-only',captured.snapshot]).toString().trim().split('\n')
  for(const path of paths){mkdirSync(join(copy,path,'..'),{recursive:true});writeFileSync(join(copy,path),git(f.root,['show',`${captured.snapshot}:${path}`]))}
  const versions=new VersionStore(new Workspace(copy)),reader=versionTextReader(copy)
  expect(await versions.list()).toHaveLength(213)
  for(let i=0;i<213;i++)expect((await readVersionContent(versions,reader,{id:`v_synthetic_${i}`,path:'a.md'}))?.content).toBe('Synthetic named text\n')
  expect([readFileSync(join(f.root,'.writeflex/versions.jsonl')),readFileSync(join(f.root,'.bridle/journal.jsonl'))]).toEqual(f.before)
  // New unapproved history after enabling must hold back ongoing capture too.
  const rows=readFileSync(join(f.root,'.writeflex/versions.jsonl'),'utf8').trim().split('\n'),row=JSON.parse(rows[200]!)
  writeFileSync(join(f.root,'.writeflex/versions.jsonl'),rows.join('\n')+'\n'+JSON.stringify({...row,id:'v_unapproved'})+'\n')
  await expect(engine.capture(f.root,WRITEFLEX_SCOPE)).rejects.toThrow()
  console.log(JSON.stringify({builtHelperBefore:'unavailable',builtHelperAfter:213,capturedHistoryFiles:3,restoredVersions:213,sourceBytesUnchangedBeforeDeliberateAppend:true,unapprovedOngoingCapture:'refused'}))
},20000)
