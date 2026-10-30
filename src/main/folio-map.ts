import { readFolioZoteroEvidence } from './folio-zotero-evidence'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { folioKey } from './folio-dir'
import type { Workspace } from './workspace'
import { DocumentChangedError, DiskChangedUnderBuffer, NameTaken } from './workspace'
import type { FolioWorkspace } from './folio-workspace'
import { readFolioPlan } from './plan'
import { folioFiles } from './folio-files'
import { collectionCandidates, resolveWikilinkTarget } from './wikilinks'
import { withoutAbsolutePaths } from '../shared/plain-error-text'
import { canonicalJsonText, topLevelValueTexts, arrayValueTexts, firstLossyCarriedKey } from './lossless-json'
import { applyMapOps, parseCanvas, mapNodeViews, mapPath, mapPatch, canvasNode, canvasEdge, type CanvasDocument, type CanvasRoot, type MapOp, type RoomMap, type MapPart } from '../shared/folio-map'
export type MapWriteResult = { ok: boolean; token: string | null; message: string; path?: string; refused?: number }
export type MapWriteOptions = { session: string; expectedOwner?: string; beforeWrite?: (path: string) => Promise<void> }
export function mapFilePath(ws: { root: string; folioDir: string }): string { return posix.join(ws.folioDir, `_${posix.basename(ws.folioDir || ws.root)}_MAP.canvas`) }
const ownerOf = (ws: Pick<FolioWorkspace, 'root' | 'folioDir'>): string => { const key = folioKey(ws.root, ws.folioDir); return key.root + '\0' + key.dir }
const tails = new Map<string, Promise<void>>(), sessions = new Set<string>(), undos = new Map<string, { owner: string; ops: MapOp[] }>()
async function serial<T>(key: string, run: () => Promise<T>): Promise<T> { const prior = tails.get(key) ?? Promise.resolve(); let release!: () => void; const next = new Promise<void>(resolve => { release = resolve }); tails.set(key,next); await prior; try { return await run() } finally { release(); if(tails.get(key)===next) tails.delete(key) } }
async function sourceNow(ws: Workspace, path: string): Promise<string | null> { try { return (await ws.readFile(path)).content } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT') return null; throw error } }
function keyOrder(text: string, parsed: Record<string, unknown>): boolean { const fields=topLevelValueTexts(text); return fields!==null && [...fields.values()].every(values=>values.length===1) && JSON.stringify([...fields.keys()])===JSON.stringify(Object.keys(parsed)) }
/** Values and key order are checked at every rewritten entity; unsupported numeric spellings refuse the write. */
export function serializeCanvas(doc: CanvasDocument, result: CanvasRoot): string {
 const output: Record<string,unknown> = {...result}
 if(doc.source!==null) {
  const source=doc.source.slice(doc.style.bom.length), fields=topLevelValueTexts(source)
  const original=JSON.parse(source) as Record<string,unknown>
  if(!Object.hasOwn(original,'edges') && !result.edges.length) delete output.edges
  if(!keyOrder(source,original) || firstLossyCarriedKey(source,doc.root,output)) throw new Error('This map carries a value or key order that cannot be preserved safely.')
  for(const kind of ['nodes','edges'] as const) {
   const raw=fields?.get(kind)?.[0]
   const entries=raw ? arrayValueTexts(raw) : []
   const before=doc.root[kind]
   for(let i=0;i<before.length;i++) {
    const text=entries[i], node=before[i], next=result[kind].find(value=>value.id===node.id)
    if(!text || !keyOrder(text,node)) throw new Error('This map carries repeated or reordered keys that cannot be preserved safely.')
    if(!next || next===node) { if(canonicalJsonText(text)!==JSON.stringify(node)) throw new Error('This map carries a number that cannot be preserved safely.') }
    else if(firstLossyCarriedKey(text,node,next)) throw new Error('This map carries a number that cannot be preserved safely.')
   }
  }
 }
 const text=JSON.stringify(output,null,' ').replace(/^ +/gm, spaces=>doc.style.indent.repeat(spaces.length)).replace(/\n/g,doc.style.eol)
 return doc.style.bom+text+(doc.style.newline?doc.style.eol:'')
}
const object=(value: unknown): value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
function plain(value: unknown, depth=0): boolean { if(depth>25)return false; if(value===null||typeof value==='string'||typeof value==='boolean')return true; if(typeof value==='number')return Number.isFinite(value); if(Array.isArray(value))return value.length<=10000&&value.every(child=>plain(child,depth+1)); return object(value)&&Object.prototype.toString.call(value)==='[object Object]'&&Object.keys(value).length<=1000&&Object.values(value).every(child=>plain(child,depth+1)) }
export function validateMapOps(value: unknown): MapOp[] {
 if(!Array.isArray(value)||value.length>500||!plain(value)||JSON.stringify(value).length>2000000) throw new Error('Invalid map edit.')
 for(const op of value) {
  if(!object(op))throw new Error('Invalid map edit.')
  const positions=['at','edgeAt'].every(key=>op[key]===undefined || (Array.isArray(op[key]) ? (op[key] as unknown[]).every(at=>Number.isSafeInteger(at)&&(at as number)>=0) : Number.isSafeInteger(op[key])&&(op[key] as number)>=0))
  const edges=(list: unknown):boolean=>Array.isArray(list)&&list.every(canvasEdge)
  const valid=op.kind==='addNode'?canvasNode(op.node)&&(op.edges===undefined||edges(op.edges)):
   op.kind==='deleteNode'?canvasNode(op.node)&&edges(op.edges):
   op.kind==='addEdge'||op.kind==='deleteEdge'?canvasEdge(op.edge):
   op.kind==='path'?edges(op.expect)&&edges(op.edges):
   op.kind==='patch'?typeof op.id==='string'&&object(op.fields)&&Object.values(op.fields).every(field=>object(field)&&['before','after'].every(key=>object(field[key])&&typeof field[key].present==='boolean'&&(!field[key].present||Object.hasOwn(field[key],'value')))):false
  if(!positions||!valid)throw new Error('Invalid map edit.')
 }
 return value as MapOp[]
}
async function partsAndFiles(ws: Workspace, dir: string): Promise<{parts:MapPart[]; files:string[]}> { const plan=await readFolioPlan(ws,dir); if(!plan) throw new Error('That folder is no longer a Folio.'); const titles=new Map<string,number>(); plan.parts.forEach(part=>{const key=part.title.normalize('NFC').toLocaleLowerCase('en-GB');titles.set(key,(titles.get(key)??0)+1)}); return {parts:plan.parts.map((part,index)=>({ index,title:part.title,key:{title:part.title,path:part.path},frontMatter:part.role==='front-matter',titleClash:(titles.get(part.title.normalize('NFC').toLocaleLowerCase('en-GB'))??0)>1?'Two parts share this title.':null })),files:[...new Set([...(await folioFiles(ws,dir)),...(await collectionCandidates(ws,'')).map(value=>value.path)])]} }
async function write(ws: FolioWorkspace, input: MapOp[], options: MapWriteOptions, restoring=false): Promise<MapWriteResult> {
 const path=mapFilePath(ws),owner=ownerOf(ws)
 try {
  if(!options.session||options.session.length>128||(options.expectedOwner!==undefined&&options.expectedOwner!==owner))throw new Error('The workspace changed. The map was not saved.')
  validateMapOps(input)
  const {parts,files}=await partsAndFiles(ws,ws.folioDir)
  let basis=await sourceNow(ws,path)
  const apply=(source:string|null) => {
   const doc=parseCanvas(source),ops:MapOp[]=[],refused:MapOp[]=[];let current=doc.root
   for(const given of input) {
    let op=given
    const views=mapNodeViews(current,parts,ws.folioDir,files)
    if(!restoring && op.kind==='patch') {
     const id=op.id, view=views.find(view=>view.raw.id===id)
     if(view?.kind==='part') {
      if(Object.keys(op.fields).some(key=>!['x','y','width','height'].includes(key))){refused.push(op);continue}
      const changes:Record<string,unknown>={}
      if(view.resolvedPath && view.raw.type==='text')Object.assign(changes,{type:'file',file:view.resolvedPath,text:undefined})
      else if(view.resolvedPath&&view.raw.type==='file'&&view.raw.file!==view.resolvedPath)changes.file=view.resolvedPath
      op={...op,fields:{...op.fields,...mapPatch(view.raw,changes).fields}}
     }
    }
    if(!restoring && op.kind==='patch') {
     const id=op.id,view=views.find(view=>view.raw.id===id)
     if(view?.raw.type==='file'&&view.resolvedPath&&view.raw.file!==view.resolvedPath)op={...op,fields:{...op.fields,...mapPatch(view.raw,{file:view.resolvedPath}).fields}}
    }
    if(!restoring && op.kind==='addNode') {
     const view=mapNodeViews({nodes:[op.node],edges:[]},parts,ws.folioDir,files)[0]
     if(view.partIndex!==null&&(parts[view.partIndex].titleClash||views.some(other=>other.partIndex===view.partIndex))){refused.push(op);continue}
     if(view.kind==='part'&&Object.keys(op.node).some(key=>!['id','type','x','y','width','height','file','text'].includes(key))){refused.push(op);continue}
    }
    const step=applyMapOps(current,[op]);current=step.root;ops.push(...step.applied);refused.push(...step.refused)
   }
   const result=applyMapOps(doc.root,ops)
   return {...result,refused:[...refused],doc,text:ops.length?serializeCanvas(doc,current):source}
  }
  let result=apply(basis)
  if(!result.applied.length) return {ok:false,token:null,message:'The map changed elsewhere, or that edit cannot be applied safely.',refused:result.refused.length}
  const session=owner+'\0'+options.session
  if(!sessions.has(session)){await options.beforeWrite?.(path);sessions.add(session);if(sessions.size>512)sessions.delete(sessions.values().next().value!)}
  for(let attempt=0;attempt<2;attempt++)try {
   await ws.saveFileOver(path,result.text!,basis===null?{kind:'create'}:{kind:'disk',text:basis})
   let token:string|null=null
   if(!restoring&&result.inverse.length){token='map:'+randomUUID();undos.set(token,{owner,ops:result.inverse});if(undos.size>100)undos.delete(undos.keys().next().value!)}
   return {ok:true,token,path,refused:result.refused.length,message:result.refused.length?`${result.refused.length} edits on the map were not kept because their values changed elsewhere.`:restoring?'Undone. Other map changes were kept.':'Saved the map.'}
  } catch(error) {
   if(!(error instanceof DocumentChangedError||error instanceof DiskChangedUnderBuffer||error instanceof NameTaken)||attempt===1)throw error
   basis=await sourceNow(ws,path);result=apply(basis)
   if(!result.applied.length)return {ok:false,token:null,message:'The map changed elsewhere. Your edits were not applied.',refused:result.refused.length}
  }
  throw new Error('The map changed again.')
 } catch(error){return {ok:false,token:null,message:withoutAbsolutePaths(error instanceof Error?error.message:String(error),ws.root)}}
}
export function writeMap(ws:FolioWorkspace,ops:MapOp[],options:MapWriteOptions):Promise<MapWriteResult>{return serial(ownerOf(ws),()=>write(ws,ops,options))}
export function undoMap(ws:FolioWorkspace,token:string,options:MapWriteOptions):Promise<MapWriteResult>{return serial(ownerOf(ws),async()=>{const entry=undos.get(token);if(!entry||entry.owner!==ownerOf(ws))return {ok:false,token:null,message:'That map edit can no longer be undone.'};const result=await write(ws,entry.ops,options,true);if(result.ok)undos.delete(token);return result})}
export async function readMap(ws:Workspace,dir:string,given?:MapPart[],knownFiles?:string[]):Promise<RoomMap>{
 const path=mapFilePath({root:ws.root,folioDir:dir})
 try {
  const source=await sourceNow(ws,path),doc=parseCanvas(source),facts=given&&knownFiles?{parts:given,files:knownFiles}:await partsAndFiles(ws,dir)
  const nodes=mapNodeViews(doc.root,facts.parts,dir,facts.files),candidates=await collectionCandidates(ws,'')
  for(const view of nodes)if(view.kind==='note') { view.resolvedPath=resolveWikilinkTarget(path,view.title,candidates).to; if(!view.resolvedPath)view.sourceState='missing note' }
  const references=nodes.filter(view=>view.kind==='zotero'||view.kind==='highlight')
  const live=await readFolioZoteroEvidence(references.map(view=>({target:view.target!,highlights:view.kind==='highlight'?[view.target!]:[]})))
  for(const view of references){const fact=live.find(fact=>fact.target===view.target);view.sourceState=fact?.state??'Zotero not available';view.itemTarget=fact?.itemTarget;if(view.kind==='highlight'){const quote=fact?.highlights.find(value=>value.target===view.target);view.quote=quote?.quote??undefined;if(!quote&&fact?.state==='ready')view.sourceState='highlight deleted in Zotero'}else view.title=fact?.title??view.title}
  return {path,state:source===null?'missing':'ready',document:doc,nodes,pathOrder:mapPath(doc.root,nodes,facts.parts)}
 }catch(error){return {path,state:'unreadable',message:withoutAbsolutePaths(error instanceof Error?error.message:String(error),ws.root),document:null,nodes:[],pathOrder:{valid:false,nodes:[],parts:[],message:'This map file cannot be read.'}}}
}
