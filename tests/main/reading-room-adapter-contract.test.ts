import { expect, test } from 'bun:test'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { ReaderEmbed, type ReaderHostWindow } from '@readflex/reader-embed'
import { readerTransferCallback } from '../../src/renderer/src/reader-transfer'
import * as schema from '../../src/shared/reading-room-schema'
import { validReaderPayload } from '../../src/shared/reading-room-channel'

const source = readFileSync(new URL('../../src/renderer/src/reader-host.ts', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('function notify<'), source.indexOf('\nfunction snapshot('))
const notifyCode = new Bun.Transpiler({ loader: 'ts' }).transformSync(body)
const nested = vm.createContext({})
const realm = vm.runInContext('({object:Object.prototype,array:Array.prototype})', nested)
const raw = (patch = '') => vm.runInContext(`(()=>{const a={id:'MARK0001',type:'highlight',text:'Synthetic quote',sortIndex:'00000|000001|00001',position:{pageIndex:0,rects:[[1,2,8,4]]},tags:[{name:'tag'},'second']};${patch};return a})()`, nested)
function notifyBoundary(sent: unknown[]) {
 const channel = { request(type: string, value: unknown) {
  if (!validReaderPayload(type, value)) return Promise.reject(Error('Reader request refused.'))
  sent.push({type,value});return Promise.resolve(null)
 } }
 return new Function('channel','disposed','saves','copyReaderOutput','readerRealms',notifyCode+';return notify')(channel,false,new Set(),(schema as any).copyReaderOutput,()=>[realm])
}
async function adapter() {
 let options: any
 const errors: Error[] = [],sent: any[] = []
 const view = { initializedPromise: Promise.resolve(), _iframeWindow: { addEventListener() {}, removeEventListener() {} } }
 const reader: any = { _lastView:view, _primaryView:view, _lastViewPrimary:true, _state:{primaryViewSelectionPopup:null}, setAnnotations() {}, navigate() {} }
 const embed = new ReaderEmbed({readFile:async()=>new Uint8Array([1]),hostCallbacks:{onError:e=>errors.push(e)}})
 embed.attachWindow({addEventListener(){},removeEventListener(){},createReader(input: unknown){options=input;return reader}} as unknown as ReaderHostWindow)
 await embed.openDocument({path:'synthetic',kind:'pdf'})
 const notify = notifyBoundary(sent)
 for(const name of ['annotation-created','annotation-updated','annotation-deleted'] as const) embed.on(name,v=>notify(name,v))
 return {embed,options,reader,errors,sent}
}
test('actual public adapter create/update/delete crosses the production host boundary with known nested tags realm', async()=>{
 const {embed,options,errors,sent}=await adapter()
 const a=raw()
 await new Promise<void>(resolve=>options.onSaveAnnotations([a],resolve))
 expect(errors.map(e=>e.message)).toEqual([])
 expect(sent.map(x=>x.type)).toEqual(['annotation-created'])
 expect(Object.getPrototypeOf(sent[0].value.tags)).toBe(Array.prototype)
 expect(sent[0].value.tags).toEqual(['tag','second'])
 a.comment='Updated'
 await new Promise<void>(resolve=>options.onSaveAnnotations([a],resolve))
 options.onDeleteAnnotations(['MARK0001'])
 // Join the adapter's actual event queue without adding a timing wait.
 await new Promise<void>(resolve=>options.onSaveAnnotations([],resolve))
 expect(errors).toEqual([])
 expect(sent.map(x=>x.type)).toEqual(['annotation-created','annotation-updated','annotation-deleted'])
 expect(embed.annotationForKey('MARK0001')).toBe(null)
 embed.detachKeyboardDelivery()
})

test('exact adapter refusal is nested tags Array.prototype, independently of the proposed copier', async()=>{
 const {embed,options}=await adapter();let output:any
 embed.on('annotation-created',v=>{output=v})
 await new Promise<void>(resolve=>options.onSaveAnnotations([raw()],resolve))
 expect(Object.getPrototypeOf(output)).toBe(Object.prototype)
 expect(Object.getPrototypeOf(output.tags)).toBe(realm.array)
 expect(Reflect.ownKeys(output).sort()).toEqual(['color','comment','isExternal','key','pageLabel','position','sortIndex','tags','text','type'])
 expect(Reflect.ownKeys(Object.getOwnPropertyDescriptors(output)).every(k=>'value' in Object.getOwnPropertyDescriptor(output,k)!)).toBe(true)
 expect(validReaderPayload('annotation-created',output)).toBe(false)
 const sameFieldsLocalTags={...output,tags:Array.from(output.tags)}
 expect(validReaderPayload('annotation-created',sameFieldsLocalTags)).toBe(true)
 embed.detachKeyboardDelivery()
})

const copy=(type:string,value:unknown,realms=[realm])=>(schema as any).copyReaderOutput(type,value,realms)
const annotation={key:'MARK0001',type:'highlight',text:'Quote',comment:null,color:null,pageLabel:null,position:'{"pageIndex":0,"rects":[[1,2,8,4]]}',sortIndex:'0',tags:[],isExternal:false}
for(const type of ['highlight','note','image','ink','underline','text']) for(const tags of ['absent','strings','objects']) test(`pinned adapter ${type}, ${tags} tags and optional PNG output`,async()=>{
 const {embed,options,errors,sent}=await adapter()
 const a=raw(`a.type=${JSON.stringify(type)};${tags==='absent'?'delete a.tags':tags==='strings'?"a.tags=['tag']":"a.tags=[{name:'tag'}]"};${type==='image'?"a.image='data:image/png;base64,AA=='":''}`)
 await new Promise<void>(resolve=>options.onSaveAnnotations([a],resolve))
 expect(errors).toEqual([]);expect(sent).toHaveLength(1)
 expect(validReaderPayload('annotation-created',sent[0].value)).toBe(true)
 expect(Object.hasOwn(sent[0].value,'image')).toBe(type==='image')
 embed.detachKeyboardDelivery()
})

test('actual public adapter selection, annotation clone and liveness shapes',async()=>{
 const {embed,options,reader,errors}=await adapter()
 const a=raw();reader._state.primaryViewSelectionPopup={annotation:a}
 const selection=embed.getSelectionAnnotation()
 expect(selection?.type).toBe('highlight')
 expect(Object.getPrototypeOf(selection)).toBe(Object.prototype)
 expect(validReaderPayload('selection',copy('selection',{annotation:selection,text:'Synthetic quote',pageLabel:null,pageIndex:0,pageLink:'zotero://open-pdf/library/items/ATTACH01?page=1'}))).toBe(true)
 await new Promise<void>(resolve=>options.onSaveAnnotations([a],resolve))
 const clone=embed.annotationForKey(a.id)
 expect(validReaderPayload('annotation-created',clone)).toBe(true)
 expect(Object.getPrototypeOf(clone?.tags)).toBe(Array.prototype)
 const snapshot={liveness:embed.getLiveness(),viewState:embed.saveViewState()}
 expect(schema.readerSnapshot(copy('snapshot',snapshot))).toBe(true)
 expect(errors).toEqual([])
 embed.detachKeyboardDelivery()
})
const states=[{pageIndex:0,scale:'page-width',top:0,left:0,scrollMode:0,spreadMode:0,lastReadAloudPosition:null},
 {scale:1,scrollYPercent:0,appearance:{lineHeight:1,wordSpacing:0,letterSpacing:0,pageWidth:0,useOriginalFont:true},lastReadAloudPosition:null}]
for(const [i,state] of states.entries()) test(`actual adapter state ${i} event and saved snapshot realms`,async()=>{
 const {embed,options}=await adapter();let received:any
 embed.on('view-state-changed',v=>{received=v})
 const foreign=vm.runInContext('('+JSON.stringify(state)+')',nested)
 options.onChangeViewState(foreign,true)
 await new Promise<void>(resolve=>options.onSaveAnnotations([],resolve))
 expect(received).toBe(foreign)
 expect(validReaderPayload('view-state-changed',copy('view-state-changed',received))).toBe(true)
 expect(schema.readerSnapshot(copy('snapshot',{liveness:embed.getLiveness(),viewState:embed.saveViewState()}))).toBe(true)
 embed.detachKeyboardDelivery()
})

test('all remaining output variants retain their closed port schemas',()=>{
 const values:any={selection:null,error:'Synthetic error','mark-mode-cancelled':null,'host-chord':{altKey:true,code:'KeyF',ctrlKey:false,key:'f',metaKey:true,shiftKey:false}}
 for(const [type,value] of Object.entries(values))expect(validReaderPayload(type,copy(type,value))).toBe(true)
 expect(()=>copy('open',{})).toThrow('type refused')
 expect(()=>copy('annotation-created',{...annotation,imaginaryOptional:null})).toThrow('schema refused')
 expect(()=>copy('selection',{annotation:null,text:'Quote',pageLabel:null,pageIndex:0,pageLink:'x',extra:null})).toThrow('schema refused')
})
for(const [name,change] of [
 ['wrong object realm',(a:any)=>Object.setPrototypeOf(a,vm.runInNewContext('Object.prototype'))],
 ['wrong array realm',(a:any)=>{a.tags=vm.runInNewContext('[]')}],
 ['arbitrary object prototype',(a:any)=>Object.setPrototypeOf(a,{})],
 ['arbitrary array prototype',(a:any)=>Object.setPrototypeOf(a.tags,{})],
 ['symbol',(a:any)=>{a[Symbol('x')]=1}],
 ['nonenumerable',(a:any)=>Object.defineProperty(a,'text',{value:'x',enumerable:false})],
 ['cycle',(a:any)=>{a.tags.push(a)}],
 ['sparse array',(a:any)=>{a.tags.length=1}],
 ['array extras',(a:any)=>{a.tags.extra=1}],
 ['oversized array',(a:any)=>{a.tags=Array(10001).fill('x')}],
 ['tag schema budget',(a:any)=>{a.tags=Array(1001).fill('x')}],
 ['tag text budget',(a:any)=>{a.tags=['x'.repeat(4097)]}],
 ['image budget',(a:any)=>{a.image='x'.repeat(8*1024*1024+1)}],
 ['aggregate byte budget',(a:any)=>{a.text='x'.repeat(13*1024*1024)}],
 ['nonfinite',(a:any)=>{a.text=NaN}],
] as const) test('trusted output copier refuses '+name,()=>{
 const a={...annotation,tags:[]};change(a);expect(()=>copy('annotation-created',a)).toThrow()
})
test('no getter, toJSON, coercion or array element accessor runs at output boundary',()=>{
 let calls=0
 for(const key of ['text','tags','toJSON']){
  const a={...annotation};Object.defineProperty(a,key,{enumerable:true,get(){calls++;return 'x'}})
  expect(()=>copy('annotation-created',a)).toThrow('descriptor refused')
 }
 const a={...annotation,tags:[] as any[]};Object.defineProperty(a.tags,'0',{enumerable:true,get(){calls++;return 'x'}})
 expect(()=>copy('annotation-created',a)).toThrow('descriptor refused')
 const b={...annotation,toJSON(){calls++;return {}},[Symbol.toPrimitive](){calls++;return 'x'}}
 expect(()=>copy('annotation-created',b)).toThrow()
 expect(calls).toBe(0)
})

for (const [name, rawType, text] of [['copy quote','highlight','Synthetic quote'],['ordinary text drag','highlight','Synthetic quote'],['empty selection','highlight','']] as const) test('actual synchronous transfer callback: '+name,async()=>{
 const {embed,options,reader}=await adapter()
 const a=raw();a.type=rawType;a.text=text
 reader._state.primaryViewSelectionPopup={annotation:a}
 const data=new Map([['text/plain','Vendor ordinary text']]),selections:any[]=[],errors:string[]=[]
 // Actual public callback passthrough, with its real nested-realm items and synchronous transfer.
 const transferEmbed=new ReaderEmbed({readFile:async()=>new Uint8Array([1]),hostCallbacks:{onSetDataTransferAnnotations:(dataTransfer,items)=>readerTransferCallback({embed,dataTransfer,items,document:{attachmentKey:'ATTACH01',itemKey:'PARENT01',libraryId:1,authorYear:'Synthetic 2026',shortTitle:'Synthetic'},citationBaseLink:'zotero://open-pdf/library/items/ATTACH01',selection:v=>selections.push(copy('selection',v)),error:e=>errors.push(e)})}})
 let callbacks:any
 transferEmbed.attachWindow({addEventListener(){},removeEventListener(){},createReader(v:unknown){callbacks=v;return reader}} as unknown as ReaderHostWindow)
 await transferEmbed.openDocument({path:'synthetic',kind:'pdf'})
 callbacks.onSetDataTransferAnnotations({setData:(k:string,v:string)=>data.set(k,v)},vm.runInContext('[]',nested).concat([a]),name==='copy quote')
 expect(errors).toEqual([])
 expect(data.get('text/plain')).toBe('Vendor ordinary text')
 expect(data.has('application/x-writeflex-evidence')).toBe(true)
 expect(selections).toHaveLength(1)
 expect(validReaderPayload('selection',selections[0])).toBe(true)
 expect(selections[0]===null).toBe(!text)
 if(text){expect(selections[0].annotation.text).toBe(text);expect(selections[0].pageLink).toEndWith('?page=1')}
 embed.detachKeyboardDelivery();transferEmbed.detachKeyboardDelivery()
})
