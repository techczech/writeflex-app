import { canvasSourceNode, canvasAttachmentSource } from '../folio-map-sources'
import { FLAG_KINDS } from '../../../shared/markdown/flags'
import { FLAG_LABELS } from '../editor/flag-actions'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Network, Layers, ArrowRight, StickyNote, Type, Undo2, PanelRight, ZoomIn, ZoomOut } from 'lucide-react'
import type { FolioRoomModel, RoomPart, RoomState } from '../../../shared/folio-room'
import { parseCanvas, applyMapOps, mapPatch, mapNodeViews, mapPath, mapOrderPreview, type CanvasDocument, type CanvasNode, type MapOp } from '../../../shared/folio-map'
import type { FolioRunningOrder } from '../app/folio-running-order'
import { registerRoomPending } from '../folio-room-pending'
import { evidenceFromDrag, isEvidenceDrag } from '../folio-evidence-transfer'
import type { EvidenceTransfer } from '../../../shared/folio-evidence-transfer'
import type { ShownFlag } from './FolioRoomFlags'
import { noEvidence } from './FolioRoomEvidence'
import type { RoomAuthor } from './FolioRoomInspector'
import { safeLabel, safeUrl } from '../editor/citation'
type Draft = { base: CanvasDocument; ops: MapOp[]; tokens: string[]; writing: Promise<boolean> | null; message: string }
const drafts = new Map<string, Draft>()
const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0,16)
const geometry = { x: 40, y: 40, width: 240, height: 140 }
const types = (target: EventTarget | null): boolean => target instanceof HTMLElement && Boolean(target.closest('input,textarea,select,[contenteditable=true]'))
export function FolioRoomMap({ model, state, update, flags, author, onOpen, onSelect, runningOrder }: {
 model:FolioRoomModel;state:RoomState;update:(patch:Partial<RoomState>)=>void;flags:Map<number,ShownFlag[]>;author:RoomAuthor;onOpen:(path:string)=>void;onSelect:(part:RoomPart)=>void;runningOrder?:Pick<FolioRunningOrder,'write'|'reorderInRoom'|'undo'|'canUndo'>
}):JSX.Element {
 const [tick,setTick]=useState(0), [selected,setSelected]=useState<string|null>(null), [inspector,setInspector]=useState(false), [blank,setBlank]=useState(false)
 const [placing,setPlacing]=useState<'part'|'source'|'note'|null>(null), [pathDraft,setPathDraft]=useState<string[]|null>(null), [arrow,setArrow]=useState(false), [arrowFrom,setArrowFrom]=useState<string|null>(null), [arrowLabel,setArrowLabel]=useState('supports')
 const [preview,setPreview]=useState<{parts:RoomPart[];order:number[];moved:number[]}|null>(null),[orderMessage,setOrderMessage]=useState('')
 const [dragged,setDragged]=useState<{id:string;x:number;y:number;width:number;height:number}|null>(null)
 const session=useMemo(()=>newId(),[model.stateKey])
 const draft=useMemo(()=>{let value=drafts.get(model.stateKey);if(!value){value={base:model.map?.document??parseCanvas(null),ops:[],tokens:[],writing:null,message:''};drafts.set(model.stateKey,value)}return value},[model.stateKey])
 const alive=useRef(true),surface=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>>()
 const flushRef=useRef<()=>Promise<boolean>>(()=>Promise.resolve(true))
 const bump=():void=>{if(alive.current)setTick(value=>value+1)}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(()=>{if(model.map?.document&&!draft.writing){draft.base=model.map.document;bump()}},[model.map?.document,draft])
 flushRef.current=()=>{
  clearTimeout(timer.current)
  if(draft.writing)return draft.writing.then(ok=>!ok?false:draft.ops.length?flushRef.current():true)
  if(!draft.ops.length)return Promise.resolve(true)
  const sent=[...draft.ops]
  const promise=window.writeflex.folioRoom.map(model.dir,{session,stateKey:model.stateKey,ops:sent}).then(async answer=>{
   draft.message=answer.message
   if(!answer.ok){bump();return false}
   draft.ops.splice(0,sent.length)
   if(answer.token)draft.tokens.push(answer.token)
   const fresh=await window.writeflex.folioRoom.read(model.dir)
   if(fresh?.stateKey===model.stateKey&&fresh.map?.document)draft.base=fresh.map.document
   bump();return true
  }).catch(error=>{draft.message=error instanceof Error?error.message:'The map could not be saved.';bump();return false}).finally(()=>{draft.writing=null;if(draft.ops.length) bump()})
  draft.writing=promise;bump();return promise
 }
 useEffect(()=>registerRoomPending({path:model.map?.path??`${model.dir}/map.canvas`,dirty:()=>Boolean(draft.ops.length),flush:()=>flushRef.current()}),[draft,model.stateKey])
 const enqueue=(ops:MapOp[]):void=>{draft.ops.push(...ops);draft.message='';setBlank(true);bump();clearTimeout(timer.current);timer.current=setTimeout(()=>void flushRef.current(),400)}
 const result=applyMapOps(draft.base.root,draft.ops),root=result.root
 const files=[...new Set([...model.parts.flatMap(part=>part.key.path?[part.key.path]:[]),...(model.evidence?.candidates.map(value=>value.path)??[]),...model.binder.research.map(value=>value.path)])]
 const views=mapNodeViews(root,model.parts,model.dir,files).map(view=>{const live=model.map?.nodes.find(value=>value.raw.id===view.raw.id&&value.raw.text===view.raw.text&&value.raw.file===view.raw.file);return live?{...view,quote:live.quote,sourceState:live.sourceState,itemTarget:live.itemTarget,resolvedPath:live.resolvedPath,title:view.kind==='zotero'?live.title:view.title}:view}),path=mapPath(root,views,model.parts),chosen=views.find(view=>view.raw.id===selected)
 const viewport=state.mapViewport??{x:0,y:0,zoom:1,overlay:false}
 const changedViewport=(patch:Partial<typeof viewport>):void=>update({mapViewport:{...viewport,...patch}})
 const point=()=>({x:Math.round((-viewport.x+80)/viewport.zoom/10)*10,y:Math.round((-viewport.y+80)/viewport.zoom/10)*10})
 const addPart=(part:RoomPart):void=>{
  const old=views.find(view=>view.partIndex===part.index)
  if(old){setSelected(old.raw.id);changedViewport({x:40-old.raw.x*viewport.zoom,y:40-old.raw.y*viewport.zoom});setPlacing(null);return}
  if(part.titleClash){draft.message=part.titleClash;bump();return}
  const node={id:newId(),...geometry,...point(),...(part.key.path?{type:'file',file:part.key.path}:{type:'text',text:`[[${part.title}]]`})}
  enqueue([{kind:'addNode',node}]);setSelected(node.id);setPlacing(null)
 }
 const putAll=():void=>{
  const parts=model.parts.filter(part=>!part.frontMatter),nodes=parts.map((part,at)=>({id:newId(),...geometry,x:40+(at%3)*300,y:40+Math.floor(at/3)*200,...(part.key.path?{type:'file',file:part.key.path}:{type:'text',text:`[[${part.title}]]`})}))
  enqueue([...nodes.map(node=>({kind:'addNode' as const,node})),{kind:'path',expect:root.edges.filter(edge=>edge.label==='path'),edges:nodes.slice(1).map((node,at)=>({id:newId(),fromNode:nodes[at].id,toNode:node.id,toEnd:'arrow',label:'path'}))}]);changedViewport({x:0,y:0,zoom:Math.max(.25,Math.min(1,((surface.current?.clientWidth??1000)-40)/Math.max(1,...nodes.map(node=>node.x+node.width+40))))})
 }
 const remove=(node:CanvasNode):void=>{enqueue([{kind:'deleteNode',node,edges:root.edges.filter(edge=>edge.fromNode===node.id||edge.toNode===node.id)}]);setSelected(null)}
 const choose=(id:string):void=>{
  if(pathDraft){const view=views.find(view=>view.raw.id===id);if(view&&view.partIndex!==null&&!view.duplicate&&!model.parts[view!.partIndex!]?.frontMatter){setPathDraft(list=>list?.includes(id)?list:list?[...list,id]:null)}else{draft.message='Choose a running-order part for the path.';bump()}return}
  if(arrow){if(!arrowFrom){setArrowFrom(id);return}if(arrowFrom!==id){enqueue([{kind:'addEdge',edge:{id:newId(),fromNode:arrowFrom,toNode:id,toEnd:'arrow',label:arrowLabel}}]);setArrow(false);setArrowFrom(null)}return}
  setSelected(id)
  const part=views.find(view=>view.raw.id===id)?.partIndex
  if(part!==null&&part!==undefined)onSelect(model.parts[part])
 }
 const undo=async():Promise<void>=>{if(!await flushRef.current())return;const token=draft.tokens.at(-1);if(!token)return;const answer=await window.writeflex.folioRoom.map(model.dir,{session,stateKey:model.stateKey,token});draft.message=answer.message;if(answer.ok){draft.tokens.pop();const fresh=await window.writeflex.folioRoom.read(model.dir);if(fresh?.map?.document)draft.base=fresh.map.document}bump()}
 const drawPath=():void=>{if(pathDraft){if(pathDraft.length>1)enqueue([{kind:'path',expect:root.edges.filter(edge=>edge.label==='path'),edges:pathDraft.slice(1).map((id,at)=>({id:newId(),fromNode:pathDraft[at],toNode:id,label:'path',toEnd:'arrow'}))}]);setPathDraft(null)}else{setPathDraft([]);setArrow(false)}}
 const makePreview=async():Promise<void>=>{if(!await flushRef.current())return;const fresh=await window.writeflex.folioRoom.read(model.dir);if(!fresh?.map?.pathOrder.valid){draft.message=fresh?.map?.pathOrder.message??'The Folio changed.';bump();return}setPreview({parts:fresh.parts,...mapOrderPreview(fresh.parts,fresh.map.pathOrder.parts)})}
 const writeOrder=async():Promise<void>=>{if(!preview||!runningOrder)return;const ok=await runningOrder.reorderInRoom(model.dir,preview.parts.map(part=>part.key),preview.order);if(ok){setPreview(null);setOrderMessage('Wrote the map path to the Folio running order.')}else{setOrderMessage('The running order changed. Review the refreshed preview.');await makePreview()}}
 const placeSource=(source:EvidenceTransfer,at=point()):void=>{const node=canvasSourceNode(source,at,newId());enqueue([{kind:'addNode',node}]);setSelected(node.id);setPlacing(null)}
 const onNodeKey=(event:React.KeyboardEvent,node:CanvasNode):void=>{
  if(event.defaultPrevented||types(event.target)||(event.target!==event.currentTarget&&event.target instanceof HTMLElement&&event.target.closest('button,a')))return
  if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();choose(node.id);return}
  if(event.key==='Delete'||event.key==='Backspace'){event.preventDefault();event.stopPropagation();remove(node);return}
  const move:Record<string,[number,number]>={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}
  if(move[event.key]&&!event.metaKey&&!event.ctrlKey&&!event.altKey){event.preventDefault();event.stopPropagation();const [x,y]=move[event.key],step=event.shiftKey?50:10;enqueue([mapPatch(node,{x:node.x+x*step,y:node.y+y*step})])}
 }
 const startDrag=(event:React.PointerEvent,node:CanvasNode,resize=false):void=>{
  if(event.button!==0||types(event.target)||pathDraft||arrow)return
  event.stopPropagation();event.preventDefault();setSelected(node.id)
  const element=event.currentTarget as HTMLElement,from={x:event.clientX,y:event.clientY};element.setPointerCapture(event.pointerId)
  let moved={id:node.id,x:node.x,y:node.y,width:node.width,height:node.height}
  const move=(ev:PointerEvent):void=>{const dx=Math.round((ev.clientX-from.x)/viewport.zoom/10)*10,dy=Math.round((ev.clientY-from.y)/viewport.zoom/10)*10;moved=resize?{...moved,width:Math.max(160,node.width+dx),height:Math.max(90,node.height+dy)}:{...moved,x:node.x+dx,y:node.y+dy};setDragged(moved)}
  const end=():void=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',end);element.removeEventListener('pointercancel',end);setDragged(null);if(resize?(moved.width!==node.width||moved.height!==node.height):(moved.x!==node.x||moved.y!==node.y))enqueue([mapPatch(node,resize?{width:moved.width,height:moved.height}:{x:moved.x,y:moved.y})])}
  element.addEventListener('pointermove',move);element.addEventListener('pointerup',end);element.addEventListener('pointercancel',end)
 }
 void tick
 if(model.map?.state==='unreadable')return <div className="fr-empty"><b>This map file cannot be read.</b><p>{model.map.message}</p><button className="fr-btn" onClick={()=>void window.writeflex.showItem(model.map!.path)}>Show in Finder</button></div>
 return <div className="fr-map" data-testid="room-map" onKeyDown={event=>{if(event.key==='Escape'&&!types(event.target)){event.preventDefault();setPathDraft(null);setArrow(false);setPlacing(null);setPreview(null)}}}>
  <div className="fr-map-tools">
   <button className="fr-btn" onClick={()=>setPlacing(placing==='part'?null:'part')}><Plus size={14}/>Part</button>
   <button className="fr-btn" onClick={()=>setPlacing(placing==='source'?null:'source')}><Layers size={14}/>Source</button>
   <button className="fr-btn" onClick={()=>setPlacing(placing==='note'?null:'note')}><StickyNote size={14}/>Note</button>
   <button className="fr-btn" onClick={()=>{const node={id:newId(),...geometry,...point(),type:'text',text:'New thought'};enqueue([{kind:'addNode',node}]);setSelected(node.id);setInspector(true)}}><Type size={14}/>Text</button>
   <button className="fr-btn" onClick={()=>{const node={id:newId(),...geometry,...point(),width:580,height:360,type:'group',label:'New cluster'};enqueue([{kind:'addNode',node}]);setSelected(node.id);setInspector(true)}}>Cluster</button>
   <button className="fr-btn" aria-pressed={arrow} onClick={()=>{setArrow(!arrow);setArrowFrom(null);setPathDraft(null)}}><ArrowRight size={14}/>Arrow</button>
   <button className="fr-btn" aria-pressed={pathDraft!==null} onClick={drawPath}><Network size={14}/>{pathDraft?'Finish path':'Path'}</button>
   <span className="g"/><button className="fr-btn" disabled={!path.valid} onClick={()=>void makePreview()}>Use this order</button>
   <button className="fr-btn" aria-label="Undo map edit" disabled={!draft.tokens.length&&!draft.ops.length} onClick={()=>void undo()}><Undo2 size={14}/></button>
   <button className="fr-btn" aria-label="Toggle map overlay" aria-pressed={viewport.overlay} onClick={()=>changedViewport({overlay:!viewport.overlay})}><Layers size={14}/></button>
   <button className="fr-btn" aria-label="Toggle map inspector" aria-pressed={inspector} onClick={()=>setInspector(!inspector)}><PanelRight size={14}/></button>
  </div>
  <div className="fr-map-status" role="status">{draft.message||orderMessage||(pathDraft?`Choose parts in path order (${pathDraft.length}). Finish path to save.`:arrow?arrowFrom?'Choose the arrow’s destination.':'Choose the arrow’s starting card.':path.message)}{draft.message&&draft.ops.length>0&&!draft.writing&&<button className="fr-linkbtn" onClick={async()=>{const fresh=await window.writeflex.folioRoom.read(model.dir);if(fresh?.map?.document){draft.base=fresh.map.document;draft.ops=[];draft.message='Kept the map from disk.';bump()}}}>Keep disk version</button>}{orderMessage&&runningOrder?.canUndo&&<button className="fr-linkbtn" onClick={()=>void runningOrder.undo()}>Undo running order</button>}</div>
  {arrow&&<div className="fr-map-pop"><label>Arrow label <input aria-label="Arrow label" list="fr-arrow-labels" value={arrowLabel} onChange={event=>setArrowLabel(event.target.value)}/></label><datalist id="fr-arrow-labels"><option value="supports"/><option value="contrasts"/><option value="leads to"/></datalist></div>}
  {placing&&<div className="fr-map-pop" role="group" aria-label={`Add ${placing} to map`}>{placing==='part'?model.parts.filter(part=>!part.frontMatter).map(part=><button className="fr-btn" key={part.index} disabled={Boolean(part.titleClash)} onClick={()=>addPart(part)}>{part.title}{views.some(view=>view.partIndex===part.index)?' · already on map':''}</button>):<><select aria-label="Source to place" defaultValue="" onChange={event=>{const candidate=model.evidence?.candidates.find(value=>value.path===event.target.value);if(candidate)placeSource(candidate.kind==='note'?{kind:'note',title:candidate.title}:{kind:'file',path:candidate.path})}}><option value="">Choose a {placing}…</option>{model.evidence?.candidates.filter(value=>placing==='note'?value.kind==='note':value.kind==='file').map(value=><option key={value.path} value={value.path}>{value.title}</option>)}</select>{placing==='source'&&model.binder.research.filter(value=>value.kind==='zotero').map(value=><button className="fr-btn" key={value.path} onClick={()=>placeSource({kind:'zotero',itemTarget:value.path,label:value.name})}>{value.name}</button>)}<span>Or drag a source or highlight here.</span></>}</div>}
  {preview&&<div className="fr-map-preview" role="dialog" aria-label="Use the map path as running order"><h2>Use this order</h2><p>{preview.moved.length?`${preview.moved.length} parts move. Parts off the path keep their places.`:'The path matches the running order.'}</p><ol>{preview.order.map((index,at)=><li key={index} className={preview.moved.includes(at)?'moved':''}>{preview.parts[index].title}{preview.moved.includes(at)&&<small> moved from {index+1}</small>}</li>)}</ol><button className="fr-btn primary" disabled={!preview.moved.length||!runningOrder} onClick={()=>void writeOrder()}>Write this order</button><button className="fr-btn" onClick={()=>setPreview(null)}>Keep map only</button></div>}
  <div className="fr-map-space" ref={surface} tabIndex={0} aria-label="Map canvas" onKeyDown={event=>{if(event.target!==event.currentTarget)return;const move:Record<string,[number,number]>={ArrowLeft:[60,0],ArrowRight:[-60,0],ArrowUp:[0,60],ArrowDown:[0,-60]};if(move[event.key]){event.preventDefault();event.stopPropagation();changedViewport({x:viewport.x+move[event.key][0],y:viewport.y+move[event.key][1]})}}} onDragOver={event=>{if(isEvidenceDrag(event.dataTransfer)){event.preventDefault();event.dataTransfer.dropEffect='copy'}}} onDrop={event=>{const source=evidenceFromDrag(event.dataTransfer,model);if(source){event.preventDefault();event.stopPropagation();const box=event.currentTarget.getBoundingClientRect();placeSource(source,{x:Math.round((event.clientX-box.left-viewport.x)/viewport.zoom/10)*10,y:Math.round((event.clientY-box.top-viewport.y)/viewport.zoom/10)*10})}}}
   onWheel={event=>{if(event.ctrlKey||event.metaKey)changedViewport({zoom:Math.max(.25,Math.min(2,viewport.zoom*(event.deltaY>0?.9:1.1)))});else changedViewport({x:viewport.x-event.deltaX,y:viewport.y-event.deltaY})}}>
   {!root.nodes.length&&!blank?<div className="fr-map-empty"><Network/><h2>See how the parts connect.</h2><p>Place the parts, gather sources into clusters, and try a different path through the argument.</p><button className="fr-btn primary" disabled={model.parts.some(part=>part.titleClash)} onClick={putAll}>Put all {model.parts.filter(part=>!part.frontMatter).length} parts on the map</button><button className="fr-btn" onClick={()=>setBlank(true)}>Start blank</button></div>:<div className="fr-map-plane" style={{transform:`translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`}}>
    <svg className="fr-map-edges" width="10000" height="10000" style={{left:-5000,top:-5000}}><defs><marker id="fr-map-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor"/></marker></defs><g transform="translate(5000,5000)">{root.edges.map(edge=>{const a=root.nodes.find(node=>node.id===edge.fromNode),b=root.nodes.find(node=>node.id===edge.toNode);if(!a||!b)return null;const x=a.x+a.width,y=a.y+a.height/2,x2=b.x,y2=b.y+b.height/2;return <g key={edge.id} className={edge.label==='path'?'path':'relation'}><path d={`M${x} ${y} C${x+80} ${y},${x2-80} ${y2},${x2} ${y2}`} markerEnd="url(#fr-map-arrow)"/><text x={(x+x2)/2} y={(y+y2)/2-8}>{edge.label==='path'?'':edge.label}</text></g>})}</g></svg>
    {views.map(view=>{const node=view.raw,position=dragged?.id===node.id?dragged:node,part=view.partIndex!==null?model.parts[view.partIndex]:null,step=path.valid?path.nodes.indexOf(node.id):-1;return <div key={node.id} role="button" tabIndex={0} aria-label={`Map ${view.kind}: ${view.title}`} aria-pressed={selected===node.id} data-node-id={node.id} className={`fr-map-node ${view.kind}${selected===node.id?' selected':''}${part?.label?` fr-lbl-${part.label.colour}`:''}${pathDraft?.includes(node.id)?' on-path':''}${viewport.overlay&&part&&!part.frontMatter&&noEvidence(model,part)?' evidence-gap':''}${viewport.overlay&&part&&!part.written?' unwritten':''}`} style={{left:position.x,top:position.y,width:position.width,height:position.height}} onClick={()=>choose(node.id)} onDoubleClick={()=>{if(part)onSelect(part);if(view.resolvedPath)onOpen(view.resolvedPath);else setInspector(true)}} onKeyDown={event=>onNodeKey(event,node)} onPointerDown={event=>startDrag(event,node)}>
     {step>=0&&<span className="fr-map-step">{step+1}</span>}{view.kind==='group'?<b>{view.title}</b>:part?<><strong><small>{part.index+1}</small> {part.title}</strong>{part.synopsis&&<p>{part.synopsis}</p>}<span className={`fr-stage ${part.written?'editing':'idea'}`}>{part.written?part.status:'not written yet'}</span>{view.duplicate&&<small>Also on the map</small>}{viewport.overlay&&<div className="fr-map-overlay">{FLAG_KINDS.map(kind=>{const count=flags.get(part.index)?.filter(flag=>flag.kind===kind).length??0;return count?<span key={kind} title={FLAG_LABELS[kind]}>{FLAG_LABELS[kind]} {count} </span>:null})}{noEvidence(model,part)?'no evidence':'evidence attached'}</div>}</>:<><strong>{view.quote?`“${view.quote}”`:view.title}</strong>{view.sourceState&&<small>{view.sourceState}</small>}</>}
     <button className="fr-map-resize" aria-label={`Resize ${view.title}`} onPointerDown={event=>startDrag(event,node,true)} onKeyDown={event=>{event.stopPropagation();const delta=event.key==='ArrowLeft'?{width:Math.max(160,node.width-20)}:event.key==='ArrowRight'?{width:node.width+20}:event.key==='ArrowUp'?{height:Math.max(90,node.height-20)}:event.key==='ArrowDown'?{height:node.height+20}:null;if(delta){event.preventDefault();enqueue([mapPatch(node,delta)])}}} onClick={event=>{event.stopPropagation();if(event.detail===0)enqueue([mapPatch(node,{width:node.width+20,height:node.height+20})])}}>↘</button>
    </div>})}
   </div>}
   {viewport.overlay&&<div className="fr-map-legend" aria-label="Map overlay legend">{FLAG_KINDS.map(kind=><button className="fr-linkbtn" key={kind} onClick={()=>update({view:'flags',flagsFilter:kind})}>{FLAG_LABELS[kind]} ({[...flags.values()].flat().filter(flag=>flag.kind===kind).length})</button>)}<button className="fr-linkbtn" onClick={()=>update({view:'evidence',evidenceGaps:true})}>Parts without evidence ({model.parts.filter(part=>!part.frontMatter&&noEvidence(model,part)).length})</button><span>Dashed cards: not written yet</span></div>}
   <div className="fr-map-zoom"><button className="fr-btn" aria-label="Zoom out" onClick={()=>changedViewport({zoom:Math.max(.25,viewport.zoom-.1)})}><ZoomOut size={14}/></button><span>{Math.round(viewport.zoom*100)}%</span><button className="fr-btn" aria-label="Zoom in" onClick={()=>changedViewport({zoom:Math.min(2,viewport.zoom+.1)})}><ZoomIn size={14}/></button><button className="fr-btn" onClick={()=>changedViewport({x:0,y:0,zoom:1})}>Reset view</button></div>
  </div>
  {inspector&&<aside className="fr-map-inspector" aria-label="Map inspector">{chosen?<><h3>{chosen.kind==='group'?'Cluster':chosen.title}</h3>{chosen.partIndex===null&&chosen.raw.type==='text'&&<label>Card text<textarea key={chosen.raw.id} aria-label="Card text" defaultValue={String(chosen.raw.text)} onChange={event=>{if(event.target.value!==chosen.raw.text)enqueue([mapPatch(chosen.raw,{text:event.target.value})])}}/></label>}{chosen.raw.type==='group'&&<label>Cluster label<input aria-label="Cluster label" key={chosen.raw.id} defaultValue={String(chosen.raw.label??'')} onChange={event=>{if(event.target.value!==chosen.raw.label)enqueue([mapPatch(chosen.raw,{label:event.target.value})])}}/></label>}{chosen.partIndex===null&&canvasAttachmentSource(chosen)!==null&&<label>Attach to part<select aria-label="Attach map card to part" defaultValue="" onChange={event=>{const part=model.parts[Number(event.target.value)];if(!part)return;const source=canvasAttachmentSource(chosen);if(source)void author({op:'attachEvidence',part:part.title,source,session,stateKey:model.stateKey})}}><option value="">Choose part…</option>{model.parts.map(part=><option key={part.index} value={part.index} disabled={Boolean(part.titleClash)}>{part.title}</option>)}</select></label>}<button className="fr-btn" onClick={()=>remove(chosen.raw)}>Remove from map</button><h4>Arrows</h4>{root.edges.filter(edge=>edge.fromNode===chosen.raw.id||edge.toNode===chosen.raw.id).map(edge=><p key={edge.id}>{edge.label||'Arrow'} <button className="fr-linkbtn" aria-label={`Delete arrow ${edge.label??''}`} onClick={()=>enqueue([{kind:'deleteEdge',edge}])}>Delete</button></p>)}</>:<p>Select a card to see its properties.</p>}</aside>}
 </div>
}
