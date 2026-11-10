import { installSnapshotStaticTheme } from './reader-snapshot-static-theme'
import { ReaderHostLifetime } from './reader-host-lifetime'
import { copyReaderViewState, copyReaderOutput, type ReaderDataRealm } from '../../shared/reading-room-schema'
import { ReaderEmbed, type ReaderHostWindow, type ReaderAnnotation } from '@readflex/reader-embed'
import { ReaderPort, boundedReaderDTO, type ReaderCommands, type ReaderEvents, type ReaderLease, type ReaderSnapshot } from '../../shared/reading-room-channel'
import { readerTransferCallback } from './reader-transfer'
import theme from './reader-theme.css?inline'

type NativeViewer = Window & { PDFViewerApplication: { open(args: Record<string, unknown>): Promise<unknown>; close(): Promise<void> } }
type HostWindow = Window & ReaderHostWindow & { _reader?: { _primaryView?: { _iframeWindow?: NativeViewer }; _secondaryView?: { _iframeWindow?: NativeViewer } } }
const config: { lease: ReaderLease; parentOrigin: string } = JSON.parse(decodeURIComponent(location.hash.slice(1)))
if (!boundedReaderDTO(config) || config.lease.origin !== location.origin || config.lease.url !== `${location.origin}/reader-host.html`
  || !/^[a-f0-9]{48}$/.test(config.lease.nonce) || config.lease.id !== location.hostname) throw new Error('Reader bootstrap configuration refused.')
let channel: ReaderPort | null = null, embed: ReaderEmbed | null = null, frame: HTMLIFrameElement | null = null
const lifetime = new ReaderHostLifetime()
let disposed = false, opened = false
const saves = new Set<Promise<unknown>>()
const adapters = new WeakSet<object>()
const nativeOpens: Array<{ dataBytes: number; useWorkerFetch: true; useWasm: true; wasmUrl: string }> = []
// Bounded diagnostics are memory-only and contain no document bytes, password or private path.
Object.defineProperty(window, '__writeflexReader', { value: Object.freeze({ nativeOpens }) })
function readerRealms(): ReaderDataRealm[] {
  const win = frame?.contentWindow as HostWindow | null
  return [win, win?._reader?._primaryView?._iframeWindow, win?._reader?._secondaryView?._iframeWindow]
    .filter(Boolean).map(realm => ({ object: (realm as Window & typeof globalThis).Object.prototype,
      array: (realm as Window & typeof globalThis).Array.prototype }))
}
function notify<K extends keyof ReaderEvents>(type: K, payload: ReaderEvents[K]): Promise<unknown> {
  if (!channel || disposed) return Promise.reject(new Error('Reader host is closed.'))
  const operation = channel.request(type, copyReaderOutput(type, payload, readerRealms()))
  if (type.startsWith('annotation-') || type === 'view-state-changed') { saves.add(operation); void operation.finally(() => saves.delete(operation)).catch(() => {}) }
  return operation
}
function snapshot(): ReaderSnapshot {
  if (!embed || disposed) throw new Error('The reader is not live.')
  return copyReaderOutput('snapshot', { liveness: embed.getLiveness(), viewState: embed.saveViewState() }, readerRealms()) as ReaderSnapshot
}
function installOpenAdapter(event: Event): void {
  const viewer = (event as CustomEvent<{ source: NativeViewer }>).detail?.source
  const application = viewer?.PDFViewerApplication
  if (!application || adapters.has(application)) return
  adapters.add(application)
  const original = application.open
  application.open = function (args) {
    if (this !== application || !args.data || args.url || disposed) throw new Error('Only approved reader bytes may be opened.')
    const base = `${location.origin}/reader/pdf/web/`
    const options = { ...args, useWorkerFetch: true, useWasm: true, cMapPacked: true,
      cMapUrl: `${base}cmaps/`, standardFontDataUrl: `${base}standard_fonts/`, iccUrl: `${base}iccs/`, wasmUrl: `${base}wasm/`,
      enableScripting: false, enableXfa: false, isEvalSupported: false }
    nativeOpens.push({ dataBytes: (args.data as Uint8Array).byteLength, useWorkerFetch: true, useWasm: true, wasmUrl: options.wasmUrl })
    if (nativeOpens.length > 8) nativeOpens.shift()
    // isEvalSupported is retained explicitly; this pinned PDF.js no longer consumes that option.
    // CSP without unsafe-eval and the unchanged decoder/evaluator sources form the execution boundary.
    return original.call(application, options)
  }
}
function closeReader(): Promise<void> {
  return lifetime.dispose(() => {
    disposed = true
    embed?.detachKeyboardDelivery()
  }, async () => {
    await Promise.all([...saves])
    const win = frame?.contentWindow as HostWindow | null
    win?.removeEventListener('webviewerloaded', installOpenAdapter)
    const applications = new Set([win?._reader?._primaryView?._iframeWindow?.PDFViewerApplication,
      win?._reader?._secondaryView?._iframeWindow?.PDFViewerApplication].filter(Boolean))
    // PDFViewerApplication.close awaits pdfLoadingTask.destroy and its actual worker transport.
    await Promise.all([...applications].map(application => application!.close()))
    frame?.remove(); frame = null; embed = null
  })
}

async function open(payload: ReaderCommands['open']): Promise<ReaderSnapshot> {
  if (opened || disposed) throw new Error('The reader document is already bound.')
  opened = true
  frame = document.createElement('iframe')
  frame.title = 'Document reader'; frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0'
  const loaded = new Promise<void>((resolve, reject) => {
    frame!.onload = () => resolve()
    frame!.onerror = () => reject(new Error('The reader document did not load.'))
  })
  frame.src = `${location.origin}/reader/reader.html`
  document.body.append(frame)
  await loaded
  if (disposed) throw new Error('The reader was closed while loading.')
  const win = frame.contentWindow as HostWindow
  const style = win.document.createElement('style'); style.textContent = theme; win.document.head.append(style)
  win.document.documentElement.dataset.roomSide = payload.side
  win.addEventListener('webviewerloaded', installOpenAdapter)
  if (payload.kind === 'snapshot') installSnapshotStaticTheme(win)
  const bytes = payload.bytes
  embed = new ReaderEmbed({ readFile: async key => {
    if (key !== 'approved-document' || disposed) throw new Error('Reader document authority refused.')
    return bytes
  }, hostCallbacks: {
    onError: error => { void notify('error', error.message).catch(() => {}) },
    onSetDataTransferAnnotations: (dataTransfer, items) => readerTransferCallback({ embed: embed!, dataTransfer, items,
      document: payload.document, citationBaseLink: payload.citationBaseLink,
      selection: selection => { void notify('selection', selection).catch(() => {}) },
      error: error => { void notify('error', error).catch(() => {}) } }),
  } })
  embed.attachWindow(win)
  embed.restoreViewState(payload.viewState)
  for (const name of ['annotation-created','annotation-updated','annotation-deleted'] as const) embed.on(name, value => notify(name, value).then(() => {}))
  embed.on('host-chord', value => { void notify('host-chord', value).catch(() => {}) })
  embed.on('mark-mode-cancelled', () => { void notify('mark-mode-cancelled', null).catch(() => {}) })
  embed.on('view-state-changed', value => {
    const realms = [win, win._reader?._primaryView?._iframeWindow, win._reader?._secondaryView?._iframeWindow]
    const state = copyReaderViewState(value, realms.filter(Boolean).map(realm => (realm as Window & typeof globalThis).Object.prototype))
    return notify('view-state-changed', state).then(() => {})
  })
  await embed.openDocument({ path: 'approved-document', kind: payload.kind, annotations: payload.annotations })
  if (disposed) throw new Error('The reader was closed while opening.')
  return snapshot()
}
async function receive(type: string, value: unknown): Promise<unknown> {
  if (type === 'dispose') { await closeReader(); return null }
  if (disposed) throw new Error('Reader is closed.')
  if (type === 'open') return lifetime.run(() => open(value as ReaderCommands['open']))
  return lifetime.run(async () => {
    if (!embed) throw new Error('Reader is not ready.')
    if (type === 'navigate') await embed.navigateTo(value as ReaderCommands['navigate'])
    else if (type === 'position') await embed.navigateToViewState(value as ReaderCommands['position'])
    else if (type === 'tool') embed.setTool(value as ReaderCommands['tool'])
    else if (type === 'upsert') embed.upsertAnnotations(value as ReaderAnnotation[])
    else if (type === 'side' && frame?.contentDocument) frame.contentDocument.documentElement.dataset.roomSide = value as string
    return snapshot()
  })
}
// The approved file-backed editor serialises its window-message origin as null.
// Its location/protocol origin and the successful ready target remain file://.
function expectedParentMessageOrigin(parentOrigin: string): string {
  return parentOrigin === 'file://' ? 'null' : parentOrigin
}
function bind(event: MessageEvent): void {
  const m = event.data
  if (channel || event.source !== parent || event.origin !== expectedParentMessageOrigin(config.parentOrigin) || event.ports.length !== 1 || !boundedReaderDTO(m)
    || !m || Object.keys(m).sort().join(',') !== 'generation,nonce,reader,type,version' || m.type !== 'bind' || m.version !== 1
    || m.reader !== config.lease.id || m.generation !== config.lease.generation || m.nonce !== config.lease.nonce) return
  removeEventListener('message', bind)
  channel = new ReaderPort(event.ports[0], config.lease, 'host', receive)
}
addEventListener('message', bind)
parent.postMessage({ type: 'reader-ready', version: 1, reader: config.lease.id, generation: config.lease.generation, nonce: config.lease.nonce }, config.parentOrigin === 'null' ? '*' : config.parentOrigin)
