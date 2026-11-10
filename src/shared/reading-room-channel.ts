import { readerByteLength } from './reading-room-bytes'
import { readerPayload, readerSnapshot } from './reading-room-schema'
import type { ReaderAnnotation, ReaderHostChord, ReaderLiveness, ReaderSelectionAnnotation, ReaderToolInput, NavigationTarget } from '@readflex/reader-embed'

export type ReaderLease = { id: string; origin: string; url: string; nonce: string; generation: number; slot: 0 | 1 }
export type ReaderSelectionSnapshot = {
  annotation: ReaderSelectionAnnotation | null; text: string; pageLabel: string | null; pageIndex: number | null; pageLink: string
}
export type ReaderDocumentMetadata = { attachmentKey: string; authorYear: string; itemKey: string; libraryId: number; shortTitle: string }
export type ReaderCommands = {
  open: { bytes: Uint8Array; kind: 'pdf' | 'snapshot'; annotations: ReaderAnnotation[]; viewState: Record<string, unknown> | null; document: ReaderDocumentMetadata; citationBaseLink: string; side: 'left' | 'right' }
  navigate: NavigationTarget
  position: Record<string, unknown>
  tool: ReaderToolInput
  upsert: ReaderAnnotation[]
  live: null
  side: 'left' | 'right'
  dispose: null
}
export type ReaderEvents = {
  'annotation-created': ReaderAnnotation; 'annotation-updated': ReaderAnnotation; 'annotation-deleted': ReaderAnnotation
  'host-chord': ReaderHostChord; 'mark-mode-cancelled': null; 'view-state-changed': Record<string, unknown>
  selection: ReaderSelectionSnapshot | null; error: string
}
export type ReaderSnapshot = { liveness: ReaderLiveness; viewState: Record<string, unknown> | null }
const COMMANDS = ['open', 'navigate', 'position', 'tool', 'upsert', 'live', 'side', 'dispose'] as const
const EVENTS = ['annotation-created', 'annotation-updated', 'annotation-deleted', 'host-chord', 'mark-mode-cancelled', 'view-state-changed', 'selection', 'error'] as const
const MAX_JSON = 24 * 1024 * 1024

/** Inspect descriptors before values. The port accepts structured data only, never accessors,
 * prototypes, cyclic graphs, DOM objects, functions or an unbounded image/annotation graph. */
export function boundedReaderDTO(value: unknown, allowBytes = false): boolean {
  let budget = MAX_JSON
  const seen = new Set<object>()
  function walk(v: unknown, depth: number): boolean {
    if (depth > 24 || (budget -= 8) < 0) return false
    if (v === null || typeof v === 'boolean') return true
    if (typeof v === 'number') return Number.isFinite(v)
    if (typeof v === 'string') return (budget -= v.length * 2) >= 0
    if (allowBytes && readerByteLength(v) !== null) return true
    if (typeof v !== 'object' || !v || seen.has(v)) return false
    const proto = Object.getPrototypeOf(v)
    if (Array.isArray(v) ? proto !== Array.prototype : (proto !== Object.prototype && proto !== null)) return false
    seen.add(v)
    const descriptors = Object.getOwnPropertyDescriptors(v)
    if (Reflect.ownKeys(descriptors).length > 10000 || Object.getOwnPropertySymbols(v).length) return false
    if (Array.isArray(v) && (v.length > 10000 || Object.keys(descriptors).length !== v.length + 1 || Object.keys(descriptors).some(k => k !== 'length' && (!/^(0|[1-9][0-9]*)$/.test(k) || Number(k) >= v.length)))) return false
    for (const [key, d] of Object.entries(descriptors)) {
      if (key === 'length' && Array.isArray(v)) continue
      if (key === '__proto__' || key === 'constructor' || key === 'prototype' || !('value' in d) || !d.enumerable || (budget -= key.length * 2) < 0 || !walk(d.value, depth + 1)) return false
    }
    seen.delete(v)
    return true
  }
  try { return walk(value, 0) } catch { return false }
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
export function validReaderPayload(type: string, value: unknown): boolean {
  return boundedReaderDTO(value, type === 'open') && readerPayload(type, value)
}
export function validReaderReply(type: string, value: unknown): boolean {
  return boundedReaderDTO(value) && (COMMANDS.includes(type as keyof ReaderCommands) && type !== 'dispose' ? readerSnapshot(value) : value === null)
}
export const READER_OPERATION_MS = 20000
export async function withinReaderBound<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The reader did not acknowledge its operation.')), READER_OPERATION_MS) })]) }
  finally { if (timer) clearTimeout(timer) }
}

type Envelope = { version: 1; reader: string; generation: number; id: number; type: string; payload: unknown }
export class ReaderPort {
  #next = 0
  #last = 0
  #closed = false
  #disposing = false
  #receivingClosed = false
  #pending = new Map<number, { type: string; done: Promise<unknown>; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  #incoming = new Set<Promise<unknown>>()
  constructor(readonly port: MessagePort, readonly lease: ReaderLease, readonly role: 'parent' | 'host', readonly receive: (type: string, payload: unknown) => unknown | Promise<unknown>) {
    port.onmessage = event => { void this.#message(event.data) }
    port.onmessageerror = () => this.close(new Error('Reader message could not be decoded.'))
    port.start()
  }
  async #message(raw: unknown): Promise<void> {
    if (this.#closed || !boundedReaderDTO(raw, true) || !record(raw) || !exact(raw, ['version','reader','generation','id','type','payload'])) return
    const m = raw as Envelope
    if (m.version !== 1 || m.reader !== this.lease.id || m.generation !== this.lease.generation || !Number.isSafeInteger(m.id) || m.id < 1) return
    if (m.type === 'ok' || m.type === 'error-reply') {
      const p = this.#pending.get(m.id)
      if (!p) return
      this.#pending.delete(m.id); clearTimeout(p.timer)
      if (m.type === 'ok' && validReaderReply(p.type, m.payload)) p.resolve(m.payload)
      else if (m.type === 'error-reply' && typeof m.payload === 'string' && m.payload.length <= 4096) p.reject(new Error(m.payload))
      else p.reject(new Error('The reader returned an invalid reply.'))
      return
    }
    const allowed: readonly string[] = this.role === 'host' ? COMMANDS : EVENTS
    if (!allowed.includes(m.type) || !validReaderPayload(m.type, m.payload) || m.id <= this.#last || this.#incoming.size >= 32) return
    this.#last = m.id
    if (this.#receivingClosed) { this.#send(m.id, 'error-reply', 'The reader is closed.'); return }
    if (m.type === 'dispose') { this.#disposing = true; this.#receivingClosed = true }
    const operation = Promise.resolve().then(() => this.receive(m.type, m.payload))
    this.#incoming.add(operation)
    try {
      const result = (await operation) ?? null
      if (!validReaderReply(m.type, result)) throw new Error('The reader returned an invalid reply.')
      this.#send(m.id, 'ok', result)
    }
    catch (error) { this.#send(m.id, 'error-reply', String(error instanceof Error ? error.message : error).slice(0, 4096)) }
    finally { this.#incoming.delete(operation) }
  }
  #send(id: number, type: string, payload: unknown): void {
    if (!this.#closed) this.port.postMessage({ version: 1, reader: this.lease.id, generation: this.lease.generation, id, type, payload })
  }
  request(type: string, payload: unknown): Promise<unknown> {
    const allowed: readonly string[] = this.role === 'parent' ? COMMANDS : EVENTS
    if (this.#closed || (this.#disposing && type !== 'dispose') || this.#pending.size >= 32 || !allowed.includes(type) || !validReaderPayload(type, payload)) return Promise.reject(new Error('Reader request refused.'))
    const id = ++this.#next
    let settle!: () => void
    const done = new Promise<void>(resolve => { settle = resolve })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); settle(); reject(new Error('The reader did not acknowledge its operation.')) }, READER_OPERATION_MS)
      this.#pending.set(id, { type, done, resolve: value => { settle(); resolve(value) }, reject: error => { settle(); reject(error) }, timer })
      try { this.#send(id, type, payload) } catch (error) { clearTimeout(timer); this.#pending.delete(id); settle(); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }
  beginDisposal(): void { this.#disposing = true }
  async drain(): Promise<void> { await withinReaderBound(Promise.allSettled([...this.#incoming, ...[...this.#pending.values()].map(p => p.done)]).then(() => {})) }
  close(error = new Error('The reader was closed.')): void {
    this.#closed = true
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.#pending.clear(); this.port.onmessage = null; this.port.onmessageerror = null; this.port.close()
  }
}
