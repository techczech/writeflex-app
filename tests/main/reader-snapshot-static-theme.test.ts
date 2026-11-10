import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { ReaderEmbed, type ReaderHostWindow } from '@readflex/reader-embed'

const adapterPath = new URL('../../src/renderer/src/reader-snapshot-static-theme.ts', import.meta.url)
// Before the repair, exercise the unchanged createReader path as the controlled red.
const install = existsSync(adapterPath) ? (await import(adapterPath.href)).installSnapshotStaticTheme : (_win: unknown) => {}
const source = readFileSync(new URL('../../node_modules/@readflex/reader-embed/vendor/reader/reader.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('reader.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function method(className: string, name: string) {
 let found = ''
 function walk(node: ts.Node) {
  if (ts.isClassDeclaration(node) && node.name?.text === className) {
   const member = node.members.find(m => ts.isMethodDeclaration(m) && m.name.getText(ast) === name)
   if (member) found = member.getText(ast)
  }
  ts.forEachChild(node, walk)
 }
 walk(ast); if (!found) throw Error('Pinned vendor method missing: ' + className + '.' + name)
 return found
}
// Execute the pinned vendor bodies, with a finite DOM surface and throwing CSP sentinel.
const initialize = method('DOMView', '_initialize')
const baseTheme = method('DOMView', '_updateColorScheme')
const snapshotTheme = method('snapshot_view_SnapshotView', '_updateColorScheme')
const snapshotLoaded = method('snapshot_view_SnapshotView', '_handleIFrameLoaded')
let darkreaderSource: string | undefined
function findDarkReader(node: ts.Node): void {
 if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'darkreader' && node.initializer) {
  let value: ts.Expression = node.initializer
  while (ts.isParenthesizedExpression(value)) value = value.expression
  if (ts.isStringLiteral(value)) darkreaderSource = value.text
 }
 ts.forEachChild(node, findDarkReader)
}
findDarkReader(ast)
if (!darkreaderSource) throw Error('Pinned Dark Reader source constant missing')
function fixture() {
 const events: string[] = [], handlers = new Map<string, () => void>(); let evalCalls = 0
 function element() { const classes = new Set<string>(), properties = new Map<string, string>(); return {dataset:{} as any, style:{setProperty:(k:string,v:string)=>properties.set(k,v)},properties,classList:{toggle(k:string,v:boolean){v?classes.add(k):classes.delete(k)},remove(k:string){classes.delete(k)},add(k:string){classes.add(k)},contains:(k:string)=>classes.has(k)}} }
 const documentElement=element(),body=element(),annotationRoot=element()
 const doc={documentElement,body,styleSheets:[],addEventListener(){}}
 const iframeWindow={document:doc,eval(){evalCalls++;throw new EvalError('CSP unsafe-eval refused')},addEventListener(){},removeEventListener(){}}
 const context=vm.createContext({events,handlers,doc,iframeWindow,annotationRoot,element,darkreader:darkreaderSource,window:{dev:false},isSafari:false,URL,
  utilities_getCurrentColorScheme:(v:string)=>v,getModeBasedOnColors:(bg:string)=>bg==='#ffffff'?'light':'dark'})
 const Snapshot=vm.runInContext(`class DOMView {
 constructor(options) { this._options=options;this._colorScheme='light';this._annotationRenderRootEl=annotationRoot;
 this._lightTheme={id:'light',background:'#ffffff',foreground:'#121212'};this._darkTheme={id:'dark',background:'#121212',foreground:'#ffffff'};
 this._fixtureLoadReady=new Promise(resolve=>this._fixtureResolveLoadReady=resolve);
 this._iframe={srcdoc:'',classList:element().classList,contentWindow:iframeWindow,contentDocument:doc,addEventListener:(type,fn)=>{handlers.set(type,fn);if(type==='load')this._fixtureResolveLoadReady()}};
 this.initializedPromise=this._initialize(); }
 async _getSrcDoc(){return '<p>Snapshot</p>'}
 _handleVisibilityChange(){}
 _getSnapshotLocation(){return null}
 _handleIFrameLoaded(){events.push('first-theme:'+this._isDynamicThemeSupported);this._updateColorScheme()}
 ${initialize}
 ${baseTheme}
}
class snapshot_view_SnapshotView extends DOMView {
 _isDynamicThemeSupported=true;
 async _getSrcDoc(){return super._getSrcDoc()}
 ${snapshotLoaded}
 ${snapshotTheme}
}
snapshot_view_SnapshotView`,context)
 class Reader {
  _type='snapshot';_primaryView:any;_secondaryView:any;_lastView:any;_state:any={};callbacks:any;annotations:any[]=[]
  constructor(options:any){this.callbacks=options;this._primaryView=this._createView(true);this._lastView=this._primaryView}
  _createView(_primary:boolean){return new Snapshot({data:{buf:new Uint8Array([1])}})}
  navigate(value:any){this.callbacks.onChangeViewState(value,true)}
  setAnnotations(value:any[]){this.annotations=value}
 }
 const win:any={addEventListener(){},removeEventListener(){},createReader(options:any){win._reader=new Reader(options);return win._reader}}
 async function load(view:any){await view._fixtureLoadReady;expect(view._iframe.srcdoc).toBe('<p>Snapshot</p>');handlers.get('load')!();await view.initializedPromise}
 return {win,load,events,doc,Snapshot,evalCalls:()=>evalCalls}
}
test('controlled original vendor theme attempts evaluation under the CSP sentinel',async()=>{
 const f=fixture(),r=f.win.createReader({});await expect(f.load(r._primaryView)).rejects.toThrow('CSP unsafe-eval refused');expect(f.evalCalls()).toBe(1)
})
test('static mode precedes first vendor theme update and normal light/dark/readability changes use zero eval',async()=>{
 const f=fixture();install(f.win);const r=f.win.createReader({type:'snapshot'}),v=r._primaryView
 expect(v._isDynamicThemeSupported).toBe(false);expect(v._iframe.srcdoc).toBe('')
 await f.load(v);expect(f.events).toEqual(['first-theme:false']);expect(f.evalCalls()).toBe(0)
 expect(f.doc.body.classList.contains('force-static-theme')).toBe(false)
 v._colorScheme='dark';v._updateColorScheme();expect(f.doc.body.classList.contains('force-static-theme')).toBe(true)
 expect(f.doc.documentElement.properties.get('--background-color')).toBe('#121212')
 v._colorScheme='light';v._lightTheme={id:'sepia',background:'#f4ecd8',foreground:'#333333'};v._updateColorScheme()
 expect(f.doc.body.classList.contains('force-static-theme')).toBe(true);expect(f.doc.documentElement.properties.get('--background-color')).toBe('#f4ecd8')
 v._lightTheme={id:'light',background:'#ffffff',foreground:'#121212'};v._updateColorScheme();expect(f.doc.body.classList.contains('force-static-theme')).toBe(false);expect(f.evalCalls()).toBe(0)
 const second=r._createView(false);expect(second._isDynamicThemeSupported).toBe(false);await f.load(second);expect(f.evalCalls()).toBe(0)
 expect(Object.hasOwn(f.Snapshot.prototype,'_isDynamicThemeSupported')).toBe(false)
})
test('snapshot annotations, selection, restored state and keyboard delivery still use the public embed',async()=>{
 const f=fixture();install(f.win);const events:any[]=[]
 const embed=new ReaderEmbed({readFile:async()=>new Uint8Array([1])});embed.attachWindow(f.win as ReaderHostWindow)
 const state={scale:1,scrollYPercent:0,appearance:{lineHeight:1,wordSpacing:0,letterSpacing:0,pageWidth:0,useOriginalFont:true}}
 embed.restoreViewState(state)
 const opening=embed.openDocument({path:'synthetic',kind:'snapshot',annotations:[]});await Promise.resolve();await f.load(f.win._reader._primaryView);await opening
 expect(f.win._reader.callbacks.primaryViewState).toEqual(state)
 embed.on('annotation-created',v=>{events.push(v)})
 const mark={id:'MARK0001',type:'highlight',text:'Snapshot',position:{type:'FragmentSelector',conformsTo:'https://www.w3.org/TR/annotation-model/',value:'body > p'},sortIndex:'0',tags:[]}
 await new Promise<void>(resolve=>f.win._reader.callbacks.onSaveAnnotations([mark],resolve))
 expect(events[0].text).toBe('Snapshot');expect(embed.annotationForKey('MARK0001')?.text).toBe('Snapshot')
 f.win._reader._state.primaryViewSelectionPopup={annotation:mark};expect(f.win._reader._state.primaryViewSelectionPopup.annotation).toBe(mark);expect(events[0].position).toBe(JSON.stringify(mark.position))
 await embed.navigateToViewState(state);expect(embed.saveViewState()).toEqual(state);expect(embed.getLiveness().activeViewInitialised).toBe(true)
 embed.detachKeyboardDelivery();expect(f.evalCalls()).toBe(0)
})
test('PDF creation is passed through without touching its view or options',()=>{
 const options={type:'pdf'},view=Object.freeze({pdf:true}),reader=Object.freeze({_primaryView:view});let received:any
 const win:any={createReader(input:any){received=input;return reader}};const original=win.createReader;install(win)
 expect(win.createReader(options)).toBe(reader);expect(received).toBe(options);expect(view).toEqual({pdf:true});expect(original).not.toBe(win.createReader)
})
for(const defect of ['class','flag','loaded','reader','factory'] as const)test('unsupported snapshot '+defect+' fails closed',()=>{
 const f=fixture(),original=f.win.createReader
 f.win.createReader=function(options:any){const r=original(options),v=r._primaryView
 if(defect==='class')Object.setPrototypeOf(v,{constructor:{name:'Other'}})
 if(defect==='flag')delete v._isDynamicThemeSupported
 if(defect==='loaded')v._iframeWindow={}
 if(defect==='reader')r._type='pdf'
 if(defect==='factory')r._createView=null
 return r}
 install(f.win);expect(()=>f.win.createReader({type:'snapshot'})).toThrow('Snapshot static theme adapter refused')
})
