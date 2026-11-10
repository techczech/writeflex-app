import { readerAnnotationTransport } from './reading-room-annotation-transport'
import type { ReaderAnnotation, ReaderEmbedEventMap, ReaderLiveness, ReaderToolInput, NavigationTarget } from '@readflex/reader-embed'
import { boundedReaderDTO, ReaderPort, type ReaderCommands, type ReaderEvents, type ReaderLease, type ReaderSnapshot, withinReaderBound } from '../../shared/reading-room-channel'

type Events = ReaderEmbedEventMap & Pick<ReaderEvents, 'selection' | 'error'>
export class ReadingRoomClient {
  readonly ready: Promise<void>
  readonly src: string
  #channel: ReaderPort | null = null
  #listeners = new Map<string, Set<(value: any) => void | Promise<void>>>()
  #closed = false
  #closing: Promise<void> | null = null
  #frame: HTMLIFrameElement | null = null
  #beforeRelease: () => Promise<void> = async () => {}
  #unlisten: () => void = () => {}
  #rejectReady: (error: Error) => void = () => {}
  #timer: ReturnType<typeof setTimeout>
  constructor(readonly lease: ReaderLease, readonly frame: () => HTMLIFrameElement | null, readonly unmountFrame: () => void) {
    this.src = `${lease.url}#${encodeURIComponent(JSON.stringify({ lease, parentOrigin: location.origin }))}`
    this.ready = new Promise((resolve, reject) => {
      this.#rejectReady = reject
      const receive = (event: MessageEvent): void => {
        const m = event.data
        if (this.#closed || this.#closing || this.#channel || event.source !== frame()?.contentWindow || event.origin !== lease.origin
          || !boundedReaderDTO(m) || !m || Object.keys(m).sort().join(',') !== 'generation,nonce,reader,type,version'
          || m.type !== 'reader-ready' || m.version !== 1 || m.reader !== lease.id || m.generation !== lease.generation || m.nonce !== lease.nonce) return
        this.#unlisten(); clearTimeout(this.#timer)
        this.#frame = frame()
        const ports = new MessageChannel()
        this.#channel = new ReaderPort(ports.port1, lease, 'parent', async (type, payload) => {
          if (this.#closed) throw new Error('This reader has closed.')
          for (const listener of this.#listeners.get(type) ?? []) await listener(payload === null && type === 'mark-mode-cancelled' ? undefined : payload)
          return null
        })
        frame()!.contentWindow!.postMessage({ type: 'bind', version: 1, reader: lease.id, generation: lease.generation, nonce: lease.nonce }, lease.origin, [ports.port2])
        resolve()
      }
      window.addEventListener('message', receive)
      this.#unlisten = () => window.removeEventListener('message', receive)
    })
    this.#timer = setTimeout(() => { this.#unlisten(); this.#rejectReady(new Error('The reader did not complete its bootstrap.')) }, 12000)
    // The slot may be abandoned before the component awaits ready.
    void this.ready.catch(() => {})
  }
  on<K extends keyof Events>(type: K, listener: (value: Events[K]) => void | Promise<void>): () => void {
    let listeners = this.#listeners.get(type)
    if (!listeners) { listeners = new Set(); this.#listeners.set(type, listeners) }
    listeners.add(listener)
    return () => { listeners!.delete(listener) }
  }
  async request<K extends keyof ReaderCommands>(type: K, payload: ReaderCommands[K]): Promise<unknown> {
    if (this.#closing || this.#closed) throw new Error('The reader is closed.')
    await this.ready
    if (this.#closing || this.#closed || !this.#channel) throw new Error('The reader is closed.')
    return this.#channel.request(type, readerAnnotationTransport(type, payload))
  }
  openDocument(payload: ReaderCommands['open']): Promise<unknown> { return this.request('open', payload) }
  navigateTo(target: NavigationTarget): Promise<unknown> { return this.request('navigate', target) }
  async navigateToViewState(state: Record<string, unknown>): Promise<void> { await this.request('position', state) }
  async upsertAnnotations(annotations: ReaderAnnotation[]): Promise<void> { await this.request('upsert', annotations) }
  async setTool(tool: ReaderToolInput): Promise<void> { await this.request('tool', tool) }
  async snapshot(): Promise<ReaderSnapshot> {
    const value = await this.request('live', null)
    if (!boundedReaderDTO(value) || !value || typeof value !== 'object' || !('liveness' in value) || !('viewState' in value)) throw new Error('The reader returned an invalid snapshot.')
    return value as ReaderSnapshot
  }
  async getLiveness(): Promise<ReaderLiveness> { return (await this.snapshot()).liveness }
  async saveViewState(): Promise<Record<string, unknown> | null> { return (await this.snapshot()).viewState }
  beforeRelease(operation: () => Promise<void>): void { this.#beforeRelease = operation }
  dispose(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#unlisten(); clearTimeout(this.#timer)
    this.#channel?.beginDisposal()
    this.#rejectReady(new Error('The reader was closed.'))
    this.#closing = this.#dispose()
    return this.#closing
  }
  async #dispose(): Promise<void> {
    if (this.#channel) {
      // The host stops new work, drains its authorised saves, and awaits actual native teardown.
      // Incoming save events remain accepted until that handshake completes.
      await this.#channel.request('dispose', null)
      await this.#channel.drain()
    }
    await withinReaderBound(this.#beforeRelease())
    const frame = this.#frame ?? this.frame()
    // React owns the outer frame. Its owner must commit the unmount before port/lease release.
    this.unmountFrame()
    if (frame?.isConnected) throw new Error('The reader frame has not finished unmounting.')
    this.#closed = true
    this.#channel?.close(); this.#listeners.clear()
    await window.writeflex.readingRoom.releaseReaderLease(this.lease.id)
  }
}
