import { expect, mock, setSystemTime } from 'bun:test'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { electronMainStandIn } from '../helpers/electron-main-stand-in'
const handlers=new Map<string, (...args:any[])=>any>();let scratch=''
mock.module('electron',()=>({...electronMainStandIn,app:{getPath:()=>scratch,getVersion:()=> 'test',isPackaged:false},ipcMain:{handle:(name:string,fn:(...args:any[])=>any)=>handlers.set(name,fn)}}))
const module=await import('../../src/main/git-vault-sync'),create=module.createGitVaultSync
let sends=0,fetches=0,checks=0,hold=false,entered:()=>void=()=>{},release:()=>void=()=>{},gate:Promise<void>=Promise.resolve()
mock.module('../../src/main/git-vault-sync',()=>({...module,createGitVaultSync:(...args:Parameters<typeof create>)=>{
 const engine=create(...args)
 return {...engine,send:async(...input:Parameters<typeof engine.send>)=>{sends++;if(hold){hold=false;entered();await gate}return engine.send(...input)},fetchAndIntegrate:async(...input:Parameters<typeof engine.fetchAndIntegrate>)=>{fetches++;return engine.fetchAndIntegrate(...input)},checkLargeFiles:async(...input:Parameters<typeof engine.checkLargeFiles>)=>{checks++;return engine.checkLargeFiles(...input)}}
}}))
const {fixture}=await import('./git-vault-sync-fixture'),f=await fixture();scratch=f.base
const mode=process.argv[2],oldInterval=globalThis.setInterval,oldClear=globalThis.clearInterval
const priorEnv=Object.fromEntries(['HOME','GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_TERMINAL_PROMPT'].map(k=>[k,process.env[k]]))
let tick:()=>void=()=>{},now=1_800_000_000_000,lifecycle:{start():void;stop():Promise<void>}|undefined
try{
 await f.put(f.a,'.gitattributes','*.lfs filter=lfs -text\n');await f.put(f.a,'small.lfs','Baseline payload.\n');f.git(f.a,'add','.');f.git(f.a,'commit','-m','Fixture LFS baseline');f.git(f.a,'push');f.git(f.b,'pull','--ff-only')
 if(mode==='history'){await f.put(f.a,'small.lfs','Committed held edit.\n');f.git(f.a,'commit','-am','Unsent LFS');f.git(f.a,'revert','--no-edit','HEAD')}
 else {await f.put(f.b,'small.lfs','Remote held edit.\n');f.git(f.b,'commit','-am','Remote LFS');f.git(f.b,'push')}
 await f.put(f.a,'draft.md','Waiting prose.\n')
 const developer=join(f.base,'Developer'),selector=join(f.base,'xcode-select'),realGit=join(execFileSync('/usr/bin/xcode-select',['-p']).toString().trim(),'usr/bin/git'),q=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'"
 await mkdir(join(developer,'usr/bin'),{recursive:true});await writeFile(join(developer,'usr/bin/git'),`#!/bin/sh\nGIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 exec ${q(realGit)} "$@"\n`);await chmod(join(developer,'usr/bin/git'),0o755)
 await writeFile(selector,`#!/bin/sh\nprintf '%s\\n' ${q(developer)}\n`);await chmod(selector,0o755)
 const {developerToolsSeams,recheckDeveloperTools}=await import('../../src/main/developer-tools');developerToolsSeams.command=selector;developerToolsSeams.platform='darwin';await recheckDeveloperTools();Object.assign(process.env,f.gitEnv,{GIT_TERMINAL_PROMPT:'0'})
 setSystemTime(now);globalThis.setInterval=((fn:()=>void)=>{tick=fn;return{unref(){}}}) as typeof setInterval;globalThis.clearInterval=(()=>{}) as typeof clearInterval
 const {registerWindow}=await import('../../src/main/state'),{registerGitSync}=await import('../../src/main/git-sync-app')
 const sender=Object.assign(new EventEmitter(),{id:919,send(channel:string,input:any){if(channel==='git-sync:prepare')queueMicrotask(()=>handlers.get('git-sync:buffers')!({sender},{...input,paths:[]}))}})
 const state=registerWindow({webContents:sender,on(){},isDestroyed:()=>false,isFocused:()=>true} as any);state.workspace={root:f.av,recordOwnWrite(){},exclusiveAll:(work:()=>unknown)=>work()} as any
 await f.settingsA.set('experimental.gitVaultSync',true,'fixture',{log:false})
 const call=(action='status')=>handlers.get('git-sync:call')!({sender},{action})
 const settle=async(until=(v:any)=>true)=>{let last:any;for(let i=0;i<2000;i++){last=await call();if(!last.busy&&until(last))return last;await Bun.sleep(10)}throw new Error('Controller did not settle: '+JSON.stringify(last))}
 lifecycle=registerGitSync(f.settingsA,()=>{});lifecycle.start();await call('open');await settle()
 await call('send');let view=await settle();expect(view.result.reason?.code).toBe(mode==='history'?'held-file-in-history':'large-file-changed-elsewhere')
 const before=sends+fetches
 for(let i=0;i<3;i++){now+=600_001;setSystemTime(now);tick();await settle()}
 const unchangedRetries=sends+fetches-before;expect(unchangedRetries).toBe(0)
 // A manual Send now bypasses the guard. Check large files now is requested during that send.
 f.git(f.a,'read-tree','HEAD');let enteredResolve!:()=>void;const waiting=new Promise<void>(r=>enteredResolve=r);entered=enteredResolve;gate=new Promise<void>(r=>release=r);hold=true
 const sending=call('send');await waiting;await call('check-large-files');expect(checks).toBe(0);release();await sending;view=await settle(()=>checks===1)
 expect(view.result.largeChecks).toContainEqual({path:'small.lfs',state:'unchanged'})
 const queuedChecks=checks
 let count=sends+fetches;await f.put(f.b,'second.md','Remote branch moved.\n');f.git(f.b,'commit','-am','Move remote');f.git(f.b,'push');now+=600_001;setSystemTime(now);tick();await settle();const remoteMoveRetries=sends+fetches-count
 count=sends+fetches;f.git(f.a,'add','draft.md');now+=600_001;setSystemTime(now);tick();await settle();const indexMoveRetries=sends+fetches-count
 count=sends+fetches;f.git(f.a,'commit','--allow-empty','-m','Move local HEAD');now+=600_001;setSystemTime(now);tick();await settle();const headMoveRetries=sends+fetches-count
 await lifecycle.stop();count=sends+fetches;lifecycle=registerGitSync(f.settingsA,()=>{});lifecycle.start();await call('open');await settle();const resumedRetries=sends+fetches-count
 console.log(JSON.stringify({mode,unchangedRetries,queuedChecks,remoteMoveRetries,indexMoveRetries,headMoveRetries,resumedRetries}))
}finally{
 release();await lifecycle?.stop();setSystemTime();globalThis.setInterval=oldInterval;globalThis.clearInterval=oldClear
 for(const[k,v]of Object.entries(priorEnv))if(v===undefined)delete process.env[k];else process.env[k]=v
 await f.close()
}
