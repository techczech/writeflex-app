/** Narrow main→owner read request. No eval, writes, flush, or document replacement. */
import { randomUUID } from 'node:crypto'
import { configureScratchLiveReader, type OwnedScratchBuffer } from './scratchpad-inventory'
import { validRemovedSpans } from '../shared/scratchpad-inventory'
import type { ScratchRemovedSpan } from '../shared/scratchpad-items'
import type { ScratchpadIpcRegistrar } from './scratchpad-ipc'

type Binding = { sender: number; root: string; send: (request: { id: string; root: string; paths: string[] }) => void }
export function registerScratchLiveReads(ipc: ScratchpadIpcRegistrar, bindings: () => Binding[]): void {
  const pending = new Map<string, { binding: Binding; paths: readonly string[]; finish: (buffers: OwnedScratchBuffer[] | null) => void }>()
  configureScratchLiveReader(async (root, paths) => {
    const readers = bindings().filter(binding => binding.root === root)
    return (await Promise.all(readers.map(binding => new Promise<OwnedScratchBuffer[]>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => finish(null), 5000)
      const finish = (buffers: OwnedScratchBuffer[] | null): void => {
        clearTimeout(timer); pending.delete(id)
        if (buffers === null) reject(new Error('An open window could not supply its live document inventory. Try again; disk was not substituted.'))
        else resolve(buffers)
      }
      pending.set(id, { binding, paths, finish })
      binding.send({ id, root, paths: [...paths] })
    })))).flat()
  })
  ipc.handle('scratchpad:answer-buffers', (event, raw) => {
    const input = raw as { id?: unknown; root?: unknown; buffers?: unknown }
    if (!input || typeof input.id !== 'string') return
    const request = pending.get(input.id)
    if (!request || request.binding.sender !== event.sender.id) return
    if (input.root !== request.binding.root || !bindings().some(binding => binding.sender === event.sender.id && binding.root === input.root)) { request.finish(null); return }
    if (!Array.isArray(input.buffers) || input.buffers.length > request.paths.length) { request.finish(null); return }
    const seen = new Set<string>()
    const buffers: OwnedScratchBuffer[] = []
    for (const value of input.buffers) {
      if (!value || typeof value.path !== 'string' || !request.paths.includes(value.path) || seen.has(value.path) || (value.content !== null && (typeof value.content !== 'string' || value.content.length > 16 * 1024 * 1024))) { request.finish(null); return }
      let removedSpans: ScratchRemovedSpan[] | undefined
      if (value.removedSpans !== undefined) {
        if (!Array.isArray(value.removedSpans) || value.removedSpans.length > 100_000 || typeof value.content !== 'string'
          || value.removedSpans.some((span: unknown) => !span || typeof span !== 'object' || typeof (span as ScratchRemovedSpan).from !== 'number' || typeof (span as ScratchRemovedSpan).to !== 'number')) { request.finish(null); return }
        removedSpans = value.removedSpans.map((span: ScratchRemovedSpan) => ({ from: span.from, to: span.to }))
        if (!validRemovedSpans(removedSpans, value.content.length)) { request.finish(null); return }
      }
      seen.add(value.path); buffers.push({ path: value.path, content: value.content, ...(removedSpans ? { removedSpans } : {}) })
    }
    request.finish(buffers)
  })
}
