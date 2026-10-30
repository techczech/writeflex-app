import type { CanvasNode, MapNodeView } from '../../shared/folio-map'
import type { EvidenceTransfer } from '../../shared/folio-evidence-transfer'
import { normaliseQuote, parseEvidenceLink } from '../../shared/folio-evidence'
import { safeLabel, safeUrl } from './editor/citation'
export function canvasSourceNode(source: EvidenceTransfer, point: {x:number;y:number}, id: string): CanvasNode {
 const base={id,x:point.x,y:point.y,width:240,height:140}
 if(source.kind==='file')return source.quote?{...base,type:'text',text:`> ${normaliseQuote(source.quote)}\n\n[${safeLabel(source.path.split('/').at(-1)!)}](${safeUrl(source.path)})`}:{...base,type:'file',file:source.path}
 if(source.kind==='note')return {...base,type:'text',text:`[[${source.title}]]`}
 if(source.kind==='archive')return {...base,type:'link',url:source.url}
 const target=source.pending?source.itemTarget:source.annotation?.target??source.itemTarget
 return {...base,type:'text',text:`[${safeLabel(source.annotation?.label??source.label)}](${safeUrl(target)})`}
}
/** Explicit attachment derives provenance from standard Canvas fields and the card's authored text. */
export function canvasAttachmentSource(view: MapNodeView): EvidenceTransfer | null {
 if(view.kind==='research'&&view.resolvedPath)return {kind:'file',path:view.resolvedPath}
 if(view.kind==='note')return {kind:'note',title:view.title}
 if(view.kind==='link'&&view.target)return {kind:'archive',title:view.title,url:view.target}
 if(view.kind==='zotero'&&view.target)return {kind:'zotero',itemTarget:view.target,label:view.title}
 if(view.kind==='highlight'&&view.target&&view.itemTarget)return {kind:'zotero',itemTarget:view.itemTarget,label:view.title,annotation:{target:view.target,label:view.title}}
 if(view.kind==='text'&&typeof view.raw.text==='string') {
  const chosen=/^> ([^\r\n]+)\r?\n\r?\n(\[[^\r\n]+\]\([^\r\n]+\))$/.exec(view.raw.text)
  const source=chosen?parseEvidenceLink('- '+chosen[2]):null
  if(chosen&&source?.kind==='file')return {kind:'file',path:source.target,quote:chosen[1]}
 }
 return null
}
