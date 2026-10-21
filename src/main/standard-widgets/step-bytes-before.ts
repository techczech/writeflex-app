/**
 * Byte provenance for a recorded widget step (ticket 04c): the exact bytes a file held just before the step wrote
 * over it, captured by the writer that read them. A step's record keeps only text (workspace.ts), and text cannot show
 * the bytes it came from; a writer that rewrites only files whose bytes read back as the same text (the link writers
 * of an own-folder move, own-folder.ts) notes those bytes here, so the put-back can be compared byte for byte
 * (`leftAsBefore`, operations.ts). Main process only.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type BytesBefore = ReadonlyMap<string, Buffer>

const scope = new AsyncLocalStorage<Map<string, Buffer>>()

/** Run `call` with `into` collecting the bytes noted by the writers inside it. */
export function recordingBytesBefore<T>(into: Map<string, Buffer>, call: () => Promise<T>): Promise<T> {
  return scope.run(into, call)
}

/** The bytes `path` holds now, about to be written over by the caller. The first note for a path is kept (it is the
 *  one the step's first write over it read). Nothing is kept outside a recording step. */
export function noteBytesBefore(path: string, bytes: Uint8Array): void {
  const into = scope.getStore()
  if (into && !into.has(path)) into.set(path, Buffer.from(bytes))
}
