import { test, expect } from 'bun:test'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createReaderResources } from '../../src/main/reading-room-resources'
const A=resolve(import.meta.dir,'../..'),hash=(s:Uint8Array|string)=>createHash('sha256').update(s).digest('hex')
const vite=await import('vite')
const wait=async(check:()=>boolean,bound=5000)=>{const start=performance.now();while(!check()&&performance.now()-start<bound)await new Promise(r=>setTimeout(r,10));return check()}
test('normal main dev watcher rebuilds a host dependency into a fresh immutable served map and retains ordinary main/editor/preload wiring',async()=>{
 const root=mkdtempSync('/private/tmp/'),identity=statSync(root),project=root+'/p',events:any[]=[],errors:any[]=[]
 let watcher:any,closed=false
 try{
  mkdirSync(project);cpSync(A+'/src',project+'/src',{recursive:true});mkdirSync(project+'/node_modules')
  for(const name of readdirSync(A+'/node_modules'))if(!['.vite','.vite-temp','.cache'].includes(name))symlinkSync(A+'/node_modules/'+name,project+'/node_modules/'+name)
  writeFileSync(project+'/package.json','{"type":"module"}')
  const selector=project+'/src/main/reading-room-host-directory.ts'
  if(!existsSync(selector))writeFileSync(selector,"import {dirname,join} from 'node:path';export function readerHostDirectory(entryFile:string):string{return join(dirname(entryFile),'..','renderer')}")
  writeFileSync(project+'/src/main/watch-entry.ts',"export {readerHostDirectory} from './reading-room-host-directory';export const ordinaryMain='before'")
  const pluginFile=A+'/scripts/reader-host-development.ts'
  let plugin:any
  if(existsSync(pluginFile))plugin=(await import(pluginFile)).readerHostDevelopment(project)
  else{
   // Execute the exact old preparer with only its trusted project root replaced by this owned copy.
   const text=readFileSync(A+'/scripts/prepare-reader-host.ts','utf8'),start=text.indexOf('export async function prepareReaderHost'),end=text.indexOf('\nif (import.meta.main)')
   const fn=new Function('project','resolve','realpathSync','dirname','build','createReaderResources',new Bun.Transpiler({loader:'ts'}).transformSync(text.slice(start,end).replace('export async','async'))+';return prepareReaderHost')(project,resolve,realpathSync,dirname,vite.build,createReaderResources)
   await fn(project+'/out/renderer')
  }
  const installed=readFileSync(A+'/node_modules/electron-vite/dist/chunks/lib-7y7CgM8M.js','utf8')
  const start=installed.indexOf('            const closeBundle = () => {'),end=installed.indexOf('            config = mergeConfig',start)
  expect(start).toBeGreaterThan(0)
  const closeBundle=new Function('resolve','watchHook','let firstBundle=true;'+installed.slice(start,end)+'return closeBundle')(()=>{},()=>{})
  watcher=await vite.build({configFile:false,root:project,logLevel:'warn',plugins:plugin?[plugin,{name:'vite:electron-watcher',closeBundle}]:[],build:{outDir:project+'/out/main',emptyOutDir:false,watch:{},lib:{entry:project+'/src/main/watch-entry.ts',formats:['es'],fileName:()=> 'watch-entry.mjs'},rollupOptions:{external:['node:path']}}})
  watcher.on('event',(e:any)=>{if(e.code==='END')events.push(e);if(e.code==='ERROR')errors.push(e.error)})
  expect(await wait(()=>events.length>=1)).toBe(true);expect(errors).toEqual([])
  const getDirectory=async(n:number)=>(await import(project+'/out/main/watch-entry.mjs?round='+n)).readerHostDirectory(project+'/out/main/watch-entry.mjs')
  const firstDirectory=await getDirectory(0),vendor=dirname(dirname(realpathSync(A+'/node_modules/@readflex/reader-embed/vendor/reader/reader.html')))
  const before=createReaderResources(vendor,firstDirectory),bundleKey=[...before.assets.keys()].find(k=>k.startsWith('assets/')&&k.endsWith('.js'))!,beforeBytes=before.read(bundleKey)
  const dependency=project+'/src/shared/reading-room-schema.ts',original=readFileSync(dependency,'utf8')
  // Alter a real retained runtime diagnostic in the synthetic dependency, preserving production sources.
  expect(original).toContain('prototype')
  
  // This literal is present in the schema's actual error path and survives normal minification.
  const marker='Reader view state prototype refused.'
  expect(original).toContain(marker)
  writeFileSync(dependency,original.replaceAll(marker,'Reader view state refreshed prototype refused.'))
  const refreshed=await wait(()=>events.length>=2)
  console.log(JSON.stringify({oldSource:!plugin,firstDirectory,hostDependencyEditObserved:refreshed,events:events.length,errors:errors.map(String),oldServedHash:hash(beforeBytes)}))
  expect(refreshed).toBe(true);expect(errors).toEqual([])
  const nextDirectory=await getDirectory(1),after=createReaderResources(vendor,nextDirectory)
  expect(nextDirectory).not.toBe(firstDirectory);expect(after.mapHash).not.toBe(before.mapHash)
  expect(before.read(bundleKey)).toEqual(beforeBytes)
  const served=[...after.assets.keys()].filter(k=>k.startsWith('assets/')&&k.endsWith('.js')).map(k=>after.read(k).toString()).join('\n')
  expect(served).toContain('Reader view state refreshed prototype refused.');expect(served).not.toContain(marker)
  expect([...after.assets.keys()].filter(k=>k.startsWith('reader/')||k.startsWith('lib/'))).toHaveLength(244)
  expect(after.assets.has('index.html')).toBe(false);expect(()=>after.read('index.html')).toThrow()
  for(const [key,item]of after.assets)expect(hash(after.read(key))).toBe(item.sha256)
  const main=project+'/src/main/watch-entry.ts';writeFileSync(main,readFileSync(main,'utf8').replace("ordinaryMain='before'","ordinaryMain='after'"))
  expect(await wait(()=>events.length>=3)).toBe(true)
  expect((await import(project+'/out/main/watch-entry.mjs?round=2')).ordinaryMain).toBe('after')
  const config=readFileSync(A+'/electron.vite.config.ts','utf8')
  const entryConfig=process.env.WRITEFLEX_REPAIR_EVIDENCE?readFileSync(process.env.WRITEFLEX_REPAIR_EVIDENCE+'/source-entry/electron.vite.config.ts','utf8'):config
  // Everything after preload remains byte-for-byte identical: its watcher, editor React/HMR and inputs.
  expect(config.slice(config.indexOf('  preload:')).replace(/\}\)\)?\s*$/,'}')).toBe(entryConfig.slice(entryConfig.indexOf('  preload:')).replace(/\}\)\)?\s*$/,'}'))
  expect(JSON.parse(readFileSync(A+'/package.json','utf8')).scripts.dev).toBe('electron-vite dev')
  console.log(JSON.stringify({firstDirectory,nextDirectory,mapBefore:before.mapHash,mapAfter:after.mapHash,events:events.length,currentServedHash:hash(served),native:false,oldMapStable:true,ordinaryMainRefreshed:true,preloadEditorPreserved:true}))
 }finally{
  if(watcher){await watcher.close();closed=true}
  const evidence=process.env.WRITEFLEX_REPAIR_EVIDENCE
  if(evidence){
   const archive=evidence+'/archive-reader-watch-'+(existsSync(A+'/scripts/reader-host-development.ts')?'green':'red')+'.tar'
   const check=spawnSync('python3',['-c',"import tarfile,pathlib,sys\nr=pathlib.Path(sys.argv[1]);n=0\nwith tarfile.open(sys.argv[2],'x',dereference=False) as t:t.add(r,arcname='fixture')\nwith tarfile.open(sys.argv[2]) as t:\n for m in t.getmembers():\n  if m.isfile():\n   assert t.extractfile(m).read()==(r/pathlib.Path(*pathlib.PurePosixPath(m.name).parts[1:])).read_bytes();n+=1\nprint(n)",root,archive],{encoding:'utf8'})
   writeFileSync(archive+'.readback.json',JSON.stringify({exit:check.status,files:check.stdout,error:check.stderr,watcherClosed:closed,root,archiveSha256:hash(readFileSync(archive))}),{flag:'wx'})
   if(check.status!==0)throw Error('Independent watch fixture archive readback failed; retaining '+root)
  }
  if(watcher&&!closed)throw Error('Owned watcher did not close; retaining '+root)
  const current=statSync(root);if(current.ino!==identity.ino||current.dev!==identity.dev)throw Error('Owned watch root changed')
  rmSync(root,{recursive:true})
 }
},20000)
