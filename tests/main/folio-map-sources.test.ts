import { expect, test } from 'bun:test'
import { canvasSourceNode,canvasAttachmentSource } from '../../src/renderer/src/folio-map-sources'
import { mapNodeViews } from '../../src/shared/folio-map'
test('a file-passage drop keeps its quote in standard text and attaches the same chosen quote explicitly',()=>{
 const source={kind:'file' as const,path:'paper/research/Study (draft).md',quote:'A chosen\n passage.'}
 const node=canvasSourceNode(source,{x:70,y:90},'chosen')
 expect(node.type).toBe('text');expect(node.text).toContain('A chosen passage.')
 const view=mapNodeViews({nodes:[node],edges:[]},[],'paper',[source.path])[0]
 expect(canvasAttachmentSource(view)).toEqual({...source,quote:'A chosen passage.'})
 expect(Object.keys(node)).toEqual(['id','x','y','width','height','type','text'])
})
test('unrelated text has no inferred source and Zotero highlights keep their parent and annotation identity',()=>{
 const node=canvasSourceNode({kind:'zotero',itemTarget:'zotero://select/library/items/ABCDEFGH',label:'Smith 2025',annotation:{target:'zotero://open-pdf/library/items/JKLMNPQR?annotation=STUVWXYZ',label:'Smith 2025 p4'}},{x:0,y:0},'z')
 const view=mapNodeViews({nodes:[node],edges:[]},[],'paper',[])[0]
 view.itemTarget='zotero://select/library/items/ABCDEFGH'
 expect(canvasAttachmentSource(view)?.kind).toBe('zotero')
 expect(canvasAttachmentSource({...view,kind:'text',raw:{...node,text:'My interpretation.'}})).toBeNull()
})
