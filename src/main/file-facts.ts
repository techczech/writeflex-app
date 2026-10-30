/**
 * THE PER-FILE FACTS SEAM (0.24.1): what listings read from a file — its text, and whatever they
 * derive from it — asked in one place, so a folder of thousands of files is read and parsed once
 * per (path, mtime, size) instead of once per listing per change.
 *
 * For the app's own Workspace the facts live on the search content cache (search-index.ts): the
 * entry is re-read when the listing's mtime or size moves, and dropped by every own write
 * (`recordOwnWrite`), agent write, rename, delete and watcher change, taking every derived fact with
 * it. Any other Workspace — a subclass or wrapper with its own `readFile` (planned overlays, the
 * guarded command-line and document-only views, test doubles) — reads through its own `readFile`
 * every time, exactly as before, because its text need not be what is on disk.
 *
 * A file the cache could not read (it vanished after the listing) is read through `readFile`, so a
 * caller sees the same error it always did.
 */

import { Workspace, type MarkdownFile } from './workspace'

/** The listing fields freshness is judged by. */
export type FactsFile = Pick<MarkdownFile, 'path' | 'modifiedAt' | 'size'>

/** One file's text, and a memo for facts derived from exactly that text. */
export type FileFacts = {
  content: string
  /** `compute(content)`, memoised for this text under `slot`; one slot is always one function. */
  derive<T>(slot: string, compute: (content: string) => T): T
}

export type FactsReader = { read(file: FactsFile): Promise<FileFacts> }

/** How many files a listing reads at once when it cannot use the cache (the search index's bound). */
export const FACTS_READ_CONCURRENCY = 16

type ReadableWorkspace = Pick<Workspace, 'readFile'>

/**
 * Views of the app's own Workspace that read exactly as it does (folio-workspace.ts `FolioWorkspace`: every reading
 * member is the Workspace's own, bound to it). A bound method is a new function, so the identity check below cannot
 * see that it reads as the Workspace; the view says so here instead, once, when it is made (spec folio-workspace § 5).
 */
const readsAsWorkspace = new WeakSet<object>()

/** Say that `view` reads the disk exactly as the Workspace it wraps, whose `readFile` is the class's own. */
export function markReadsAsWorkspace(view: object): void {
  readsAsWorkspace.add(view)
}

/** Whether the Workspace reads the disk as the search cache does (no overriding `readFile`). */
function usesCache(ws: ReadableWorkspace): ws is Workspace {
  return ws instanceof Workspace && (ws.readFile === Workspace.prototype.readFile || readsAsWorkspace.has(ws))
}

/** A read-only snapshot keeps the underlying workspace's cache policy, including overlay refusal. */
export function inheritWorkspaceFacts(view: object, workspace: ReadableWorkspace): void {
  if (usesCache(workspace)) markReadsAsWorkspace(view)
}

function uncached(content: string): FileFacts {
  const memo = new Map<string, unknown>()
  return {
    content,
    derive<T>(slot: string, compute: (text: string) => T): T {
      if (!memo.has(slot)) memo.set(slot, compute(content))
      return memo.get(slot) as T
    },
  }
}

/**
 * A reader over `files`. For the app's Workspace this first brings the cache up to date for those
 * files (reading only the stale or new ones, 16 at a time); `listing` is the whole current listing,
 * so files that have left it are forgotten.
 */
export async function factsReader(
  ws: ReadableWorkspace,
  files: readonly FactsFile[],
  listing?: readonly FactsFile[],
): Promise<FactsReader> {
  const readThrough = async (path: string): Promise<FileFacts> => uncached((await ws.readFile(path)).content)
  if (!usesCache(ws)) return { read: (file) => readThrough(file.path) }
  const index = ws.searchIndex
  await index.ensure(files, listing ? new Set(listing.map((file) => file.path)) : undefined)
  return {
    async read(file) {
      const entry = index.current(file)
      if (!entry) return readThrough(file.path)
      const local = uncached(entry.content)
      return {
        content: entry.content,
        // Memoise on the entry only while it is still the cached one; a newer read has its own facts.
        derive: (slot, compute) => (index.get(file.path) === entry ? index.derive(file.path, slot, compute)! : local.derive(slot, compute)),
      }
    },
  }
}

/** `items` mapped through `run` with at most `limit` in flight, results in input order. */
export async function mapBounded<T, R>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

