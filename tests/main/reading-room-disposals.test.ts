import {test, expect} from 'bun:test'
import {readFileSync, realpathSync} from 'node:fs'
import {dirname} from 'node:path'
import {existsSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {ReadingRoomClient} from '../../src/renderer/src/reading-room-client'
import {ReaderPort} from '../../src/shared/reading-room-channel'
import {ReaderRegistry} from '../../src/main/reading-room-policy'
import {createReaderResources} from '../../src/main/reading-room-resources'
const A=new URL('../..',import.meta.url).pathname.replace(/\/$/,'')
const Accounting=existsSync(A+'/src/renderer/src/reading-room-disposals.ts')?(await import(A+'/src/renderer/src/reading-room-disposals.ts')).ReaderDisposals:class {dispose(c:any){return c.dispose()}close(cs:any[]){return Promise.all(cs.map(c=>c?.dispose()))}}
const disposals={current:new Accounting()}
const src=(p:string)=>readFileSync(A+'/'+p,'utf8')
const run=(s:string,c:any,result:string)=>new Function(...Object.keys(c),new Bun.Transpiler({loader:'ts'}).transformSync(s)+'\nreturn '+result)(...Object.values(c))
const tick=()=>new Promise(r=>setTimeout(r,0))
function deferred(){let resolve!:()=>void;let reject!:(e:Error)=>void;const promise=new Promise<void>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
const room=src('src/renderer/src/components/ReadingRoom.tsx')
const a=room.indexOf('onLoad={() => {'),b=room.indexOf('\n              />',a)
const callback=room.slice(a+'onLoad={'.length,b).trim().slice(0,-1)
function registerLifetime(embeds:any,pending:any){
 let lifetime!:()=>Promise<void>
 const a=room.indexOf('    registerLifetime(async () => {'),b=room.indexOf('\n    return () => registerLifetime(null)',a)
 run(room.slice(a,b),{registerLifetime:(fn:any)=>{lifetime=fn},embeds,pending,disposals},'undefined')
 return ()=>lifetime()
}
async function fixture(refuseClose=false,hold?:Promise<void>){
 disposals.current=new Accounting()
 const registry=new ReaderRegistry(),owner={id:1,top:'1:1',epoch:1,origin:'file://'},lease=registry.create(owner,0)
 const listeners=new Set<Function>(),events:string[]=[],hosts:ReaderPort[]=[]
 const beforeWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),beforeLocation=Object.getOwnPropertyDescriptor(globalThis,'location')
 Object.defineProperty(globalThis,'location',{configurable:true,value:{origin:'file://'}})
 Object.defineProperty(globalThis,'window',{configurable:true,value:{addEventListener(_t:string,f:Function){listeners.add(f)},removeEventListener(_t:string,f:Function){listeners.delete(f)},writeflex:{readingRoom:{releaseReaderLease:async(id:string)=>{events.push('revoke');registry.revoke(id)}}}}})
 const live={liveness:{activeViewInitialised:true,canvas:{width:1,height:1},page:1,pageCount:1},viewState:null}
 const frame={isConnected:true,contentWindow:{postMessage(_d:any,_o:string,ports:MessagePort[]){hosts.push(new ReaderPort(ports[0],lease,'host',async type=>{if(type==='dispose'){events.push('dispose');await hold;if(refuseClose)throw Error('native close refused');return null}return structuredClone(live)}))}}}
 const client=new ReadingRoomClient(lease,()=>frame as any,()=>{events.push('unmount');frame.isConnected=false})
 for(const f of listeners)f({source:frame.contentWindow,origin:lease.origin,data:{type:'reader-ready',version:1,reader:lease.id,generation:lease.generation,nonce:lease.nonce}})
 await client.ready
 return {registry,owner,lease,frame,client,events,cleanup:async()=>{await Promise.allSettled([client.dispose()]);hosts.forEach(p=>p.close());registry.revoke(lease.id);for(const [key,d]of [['window',beforeWindow],['location',beforeLocation]]as const){if(d)Object.defineProperty(globalThis,key,d);else delete(globalThis as any)[key]}}}
}
for(const mode of ['current','unmounted','different-client','different-token'] as const)test('captured failed-load callback identity guard: '+mode,async()=>{
 const f=await fixture(),read=deferred(),mounted={current:true},pending={current:{token:7}},embeds={current:[f.client]},persistence={current:[{}]},errors:string[]=[]
 const onLoad=run('const callback='+callback,{embeds,pending,persistence,mounted,disposals,index:0,frame:{token:7},frameLoaded:()=>read.promise,onError:(e:string)=>errors.push(e),readingRoomError:(e:Error)=>e.message},'callback')
 try{
  onLoad()
  if(mode==='unmounted')mounted.current=false
  if(mode==='different-client')embeds.current[0]={replacement:true}as any
  if(mode==='different-token')pending.current={token:8}
  read.reject(Error('read refused'));await tick();await tick();await f.client.dispose()
  expect(f.frame.isConnected).toBe(false);expect(()=>f.registry.owned(f.lease.id,f.owner)).toThrow('stale')
  expect(errors).toEqual(mode==='current'?['read refused']:[])
  if(mode==='current'){expect(embeds.current[0]).toBeNull();expect(pending.current).toBeNull();expect(persistence.current[0]).toBeNull()}
  else {expect(embeds.current[0]).not.toBeNull();expect(persistence.current[0]).not.toBeNull()}
 }finally{await f.cleanup()}
},5000)

test('current failed load keeps failed-disposal client reachable for registered lifetime',async()=>{
 const f=await fixture(true),read=deferred(),mounted={current:true},pending={current:{token:7}},embeds={current:[f.client]},persistence={current:[{}]},errors:string[]=[]
 const lifetime=registerLifetime(embeds,pending)
 const onLoad=run('const callback='+callback,{embeds,pending,persistence,mounted,disposals,index:0,frame:{token:7},frameLoaded:()=>read.promise,onError:(e:string)=>errors.push(e),readingRoomError:(e:Error)=>e.message},'callback')
 try{
  onLoad();read.reject(Error('read refused'));await tick();await tick()
  await expect(f.client.dispose()).rejects.toThrow('native close refused')
  const before=f.events.slice();let lifetimeRejected=false
  try{await lifetime()}catch{lifetimeRejected=true}
  const observed={errors,clientStillRegistered:embeds.current[0]===f.client,frameConnected:f.frame.isConnected,grantLive:f.registry.owned(f.lease.id,f.owner).live,lifetimeRejected,events:before,lifetimeEvents:f.events.slice(before.length)}
  console.log(JSON.stringify({control:'failed-load-plus-real-port-dispose-refusal',observed}))
  expect(observed.clientStillRegistered).toBe(true)
  expect(lifetimeRejected).toBe(true)
  expect(errors).toContain('native close refused')
  await expect(lifetime()).rejects.toThrow('native close refused')
  expect(f.events.filter(x=>x==='dispose')).toHaveLength(1)
 }finally{await f.cleanup()}
},5000)

for(const stale of [false,true])test('registered cleanup waits for in-flight failed-load disposal, stale slot='+stale,async()=>{
 const hold=deferred(),f=await fixture(false,hold.promise),read=deferred(),mounted={current:true},pending={current:{token:7}},embeds={current:[f.client]},persistence={current:[{}]},errors:string[]=[]
 const lifetime=registerLifetime(embeds,pending)
 const onLoad=run('const callback='+callback,{embeds,pending,persistence,mounted,disposals,index:0,frame:{token:7},frameLoaded:()=>read.promise,onError:(e:string)=>errors.push(e),readingRoomError:(e:Error)=>e.message},'callback')
 try{
  onLoad();read.reject(Error('read refused'));await tick();await tick()
  expect(f.events).toEqual(['dispose']);expect(f.frame.isConnected).toBe(true)
  if(stale)embeds.current[0]=null as any
  let settled=false
  const closing=lifetime().then(()=>{settled=true})
  await tick();expect(settled).toBe(false);expect(f.registry.owned(f.lease.id,f.owner).live).toBe(true)
  hold.resolve();await closing;await tick()
  expect(f.frame.isConnected).toBe(false);expect(()=>f.registry.owned(f.lease.id,f.owner)).toThrow('stale')
  expect(f.events).toEqual(['dispose','unmount','revoke'])
 }finally{hold.resolve();await f.cleanup()}
},5000)

for(const detached of [false,true])test('refused captured teardown stays owned across a room close and a document re-request, detached='+detached,async()=>{
 const hold=deferred(),f=await fixture(true,hold.promise),read=deferred(),mounted={current:true},pending={current:{token:7}},embeds={current:[f.client]},persistence={current:[{}]},errors:string[]=[]
 const lifetime=registerLifetime(embeds,pending)
 const onLoad=run('const callback='+callback,{embeds,pending,persistence,mounted,disposals,index:0,frame:{token:7},frameLoaded:()=>read.promise,onError:(e:string)=>errors.push(e),readingRoomError:(e:Error)=>e.message},'callback')
 try{
  onLoad()
  let settled=false
  const result=lifetime().then(()=>({success:true}),error=>({success:false,error})).then(value=>{settled=true;return value})
  if(detached)embeds.current[0]=null as any
  read.reject(Error('read refused'));await tick();await tick()
  expect(settled).toBe(false);expect(f.frame.isConnected).toBe(true)
  expect(()=>f.registry.create(f.owner,0)).toThrow('not finished closing')
  hold.resolve();const closed=await result
  expect(closed.success).toBe(false);expect(errors).toContain('native close refused')
  expect(f.registry.owned(f.lease.id,f.owner).live).toBe(true)
  await expect(lifetime()).rejects.toThrow('native close refused')
  await expect(disposals.current.dispose(f.client)).rejects.toThrow('native close refused')
  expect(f.events).toEqual(['dispose'])
  let leaseRequests=0
  ;(globalThis as any).window.writeflex.readingRoom.createReaderLease=async()=>{leaseRequests++;return f.registry.create(f.owner,0)}
  const start=room.indexOf('  const beginDocument = useCallback('),end=room.indexOf('\n  useEffect(() => {',start)
  const begin=run(room.slice(start,end),{useCallback:(fn:Function)=>fn,measureSpan:()=>null,updateRoomWidth:()=>{},clampReadingRoomWidth:()=>448,setRoomView:()=>{},activeIndexRef:{current:-1},setDocument:()=>{},pending,embeds,disposals,mounted,ReadingRoomClient,frameRefs:{current:[]},setFrames:()=>{},onError:(e:string)=>errors.push(e),readingRoomError:(e:Error)=>e.message},'beginDocument')
  begin({document:{},roomWidth:448});await tick();await tick()
  expect(leaseRequests).toBe(detached?1:0)
  expect(errors.at(-1)).toContain(detached?'not finished closing':'native close refused')
  expect(f.registry.owned(f.lease.id,f.owner).live).toBe(true)
  expect(f.events).toEqual(['dispose'])
 }finally{hold.resolve();await f.cleanup()}
},5000)
