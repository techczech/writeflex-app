/**
 * The content cache behind Workspace.search.
 *
 * Every query used to read every in-scope file from disk, sequentially, so a workspace of a few
 * hundred pieces made each keystroke a full re-read ("the speed is bad"). The index keeps each
 * file's text and frontmatter tags in memory keyed by path, and on a query re-reads ONLY the files
 * whose listing entry (mtime or size) no longer matches the cached one, or that are new. Files that
 * have left the listing leave the cache. Matching then runs from memory.
 *
 * The listing already carries `modifiedAt` and `size` from the walk's own `stat`, so freshness costs
 * no second stat pass. Reads run with bounded concurrency. In the desktop app the content cache
 * is also snapshotted under userData, per root. Across launches a saved entry is used only for a
 * file in the current listing with the same mtime and size. A rewrite while the app is closed
 * that preserves both is indistinguishable by this stamp and can reuse the earlier text until
 * the next detectable change or watcher invalidation.
 *
 * Each entry's title (what the piece is called — search ranks a file whose title holds every term
 * first) is derived lazily on first ask and kept with the entry, so a refresh re-derives it only for
 * the files it re-read.
 *
 * Each entry's task summary (its boxes and whether it is a checklist note — the Files tree's and
 * Quick Open's progress chip, shared/markdown/task-lines.ts) is derived the same lazy way.
 *
 * `invalidate(paths)` is the watcher's door: an external change or unlink drops the entry so the
 * next query re-reads it even when a same-size rewrite lands inside the same mtime tick.
 * It also revokes reads already queued or underway for that path.
 *
 * THE PER-FILE FACTS CACHE (0.24.1). The same entries serve every listing that derives facts from a
 * file — Collection pieces, the agent's Digest, wikilink candidates, the vault index — so a file is
 * read once and its facts derived once per (path, mtime, size), whoever asks first:
 *   - `ensure(files, listed)` brings just the named files up to date WITHOUT forgetting the rest
 *     (a Collection of one folder must not empty the cache search relies on). Files it brought in
 *     are retained across a search `refresh` whose scope leaves them out (search skips top-level
 *     `cache/` and `indexes/`, a Collection does not), until a later `ensure` sees they have left
 *     the whole listing.
 *   - `derive(path, slot, fn)` memoises anything computed from an entry's content on the entry
 *     itself, so a re-read (new mtime or size), an own write or a watcher change — which all replace
 *     or drop the entry — take every derived fact with it. There is no second invalidation path to
 *     forget.
 */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isPathInSearchScope } from '../shared/search-scope'
import { summariseTasks, type TaskSummary } from '../shared/markdown/task-lines'

export type SearchIndexEntry = {
  mtimeMs: number
  size: number
  content: string
  tags: string[]
  title?: string
  tasks?: TaskSummary
  /** Facts derived from `content` by `derive`, by slot name; they live and die with the entry. */
  derived?: Map<string, unknown>
}
/** The listing shape the index needs to decide freshness — a subset of Workspace's MarkdownFile. */
export type IndexableFile = { path: string; modifiedAt: number; size: number }

export const SEARCH_INDEX_READ_CONCURRENCY = 16

const CACHE_VERSION = 1
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const CACHE_QUIET_MS = 750
const pendingCaches = new Set<SearchIndex>()
const oversizedCaches = new Set<string>()
const checksum = (path: string, payload: string): string =>
  createHash('sha256').update(basename(path)).update('\0').update(payload).digest('hex')

type CacheLocation = { root: string; dir: string }

/** Rejected snapshots are equivalent to a cache miss. Only the app's own regular files are read. */
async function loadSnapshot(path: string): Promise<Map<string, SearchIndexEntry>> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    let text: string
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_CACHE_BYTES) return new Map()
      const bytes = Buffer.allocUnsafe(stat.size)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead !== bytes.length) return new Map()
      text = bytes.toString('utf8')
    } finally {
      await handle.close()
    }

    const envelope = JSON.parse(text) as { version?: unknown; digest?: unknown; payload?: unknown } | null
    if (envelope?.version !== CACHE_VERSION || typeof envelope.payload !== 'string'
      || envelope.digest !== checksum(path, envelope.payload)) return new Map()
    const encoded: unknown = JSON.parse(envelope.payload)
    if (!Array.isArray(encoded)) return new Map()
    const entries = new Map<string, SearchIndexEntry>()
    for (const row of encoded) {
      if (!Array.isArray(row) || row.length !== 5) return new Map()
      const [file, mtimeMs, size, content, tags] = row
      if (typeof file !== 'string' || !file || entries.has(file)
        || !Number.isFinite(mtimeMs) || !Number.isSafeInteger(size) || size < 0
        || typeof content !== 'string' || !Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) return new Map()
      entries.set(file, { mtimeMs, size, content, tags })
    }
    return entries
  } catch {
    return new Map()
  }
}

function serialiseSnapshot(path: string, entries: Iterable<[string, SearchIndexEntry]>): string | undefined {
  const rows: string[] = []
  let bytes = 2 // brackets
  for (const [file, entry] of entries) {
    if (entry.content.length > MAX_CACHE_BYTES) return undefined
    const row = JSON.stringify([file, entry.mtimeMs, entry.size, entry.content, entry.tags])
    // The payload is itself a JSON string in the envelope. Count its escaped bytes.
    bytes += Buffer.byteLength(JSON.stringify(row)) - 1 // outer quotes out, comma in
    if (bytes > MAX_CACHE_BYTES) return undefined
    rows.push(row)
  }
  const payload = '[' + rows.join(',') + ']'
  const snapshot = JSON.stringify({ version: CACHE_VERSION, digest: checksum(path, payload), payload })
  return Buffer.byteLength(snapshot) <= MAX_CACHE_BYTES ? snapshot : undefined
}

const fileStem = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')

export class SearchIndex {
  readonly #entries = new Map<string, SearchIndexEntry>()
  /** Only the latest scheduled read for a path may update its entry. */
  readonly #pendingReads = new Map<string, IndexableFile>()
  /** Paths `ensure` brought in: a scoped `refresh` that does not list them leaves them alone. */
  readonly #retained = new Set<string>()
  readonly #cacheFile?: string
  // Saved entries stay here until a listing has verified their stamp. They are invisible to get/title/derive.
  #unchecked?: Map<string, SearchIndexEntry>
  #loading?: Promise<void>
  readonly #invalidatedBeforeLoad = new Set<string>()
  #timer?: ReturnType<typeof setTimeout>
  #writing?: Promise<void>
  #dirty = false
  /** Files read from disk since construction — the counter tests assert on. */
  reads = 0

  constructor(
    private readonly read: (path: string) => Promise<string>,
    private readonly tagsOf: (content: string) => string[],
    private readonly concurrency = SEARCH_INDEX_READ_CONCURRENCY,
    private readonly titleOf: (content: string, path: string) => string = (_content, path) => fileStem(path),
    cache?: CacheLocation,
  ) {
    if (cache) this.#cacheFile = join(cache.dir, createHash('sha1').update(cache.root).digest('hex') + '.json')
  }

  /** Flush snapshots still queued when the app is quitting, including closed windows' caches. */
  static async flushPending(): Promise<void> {
    await Promise.all([...pendingCaches].map((index) => index.flush()))
  }

  /** Finish the outstanding write and any newer changes it did not include. */
  async flush(): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    while (this.#dirty || this.#writing) {
      if (!this.#writing) {
        this.#dirty = false
        this.#writing = this.#saveSnapshot().finally(() => {
          this.#writing = undefined
          if (!this.#dirty) pendingCaches.delete(this)
        })
      }
      await this.#writing
    }
  }

  #scheduleSnapshot(): void {
    if (!this.#cacheFile) return
    this.#dirty = true
    pendingCaches.add(this)
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => { void this.flush() }, CACHE_QUIET_MS)
    this.#timer.unref()
  }

  async #saveSnapshot(): Promise<void> {
    const path = this.#cacheFile
    if (!path) return
    let temporary: string | undefined
    try {
      const snapshot = serialiseSnapshot(path, new Map([
        ...(this.#unchecked ?? []),
        ...this.#entries,
      ]))
      if (snapshot === undefined) {
        if (!oversizedCaches.has(path)) {
          oversizedCaches.add(path)
          console.warn('[WriteFlex] Search cache exceeds its 32 MiB disk limit. Keeping the updated cache in memory.')
        }
        return
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const next = path + '.' + randomUUID() + '.tmp'
      const handle = await open(next, 'wx', 0o600)
      temporary = next
      try { await handle.writeFile(snapshot) }
      finally { await handle.close() }
      await rename(temporary, path)
      temporary = undefined
    } catch {
      // A convenience cache must never interrupt a search or quit.
    } finally {
      if (temporary) await unlink(temporary).catch(() => {})
    }
  }

  async #load(): Promise<void> {
    if (!this.#cacheFile || this.#unchecked) return
    this.#loading ??= loadSnapshot(this.#cacheFile).then((entries) => {
      if (this.#unchecked) return // clear() ran during the load
      let removed = false
      for (const path of this.#invalidatedBeforeLoad) removed = entries.delete(path) || removed
      this.#invalidatedBeforeLoad.clear()
      this.#unchecked = entries
      if (removed) this.#scheduleSnapshot()
    })
    await this.#loading
  }

  #needsRead(file: IndexableFile): boolean {
    if (this.current(file)) return false
    const saved = this.#unchecked?.get(file.path)
    if (!saved) return true
    this.#unchecked?.delete(file.path)
    if (saved.mtimeMs !== file.modifiedAt || saved.size !== file.size) return true
    this.#entries.set(file.path, saved)
    return false
  }

  get size(): number {
    return this.#entries.size
  }

  get(path: string): SearchIndexEntry | undefined {
    return this.#entries.get(path)
  }

  /** The cached piece's title, derived from its cached content on first ask; undefined when the
   *  path is not in the cache. Never reads the disk. */
  title(path: string): string | undefined {
    const entry = this.#entries.get(path)
    if (!entry) return undefined
    entry.title ??= this.titleOf(entry.content, path)
    return entry.title
  }

  /** The cached piece's task summary, derived from its cached content on first ask; undefined when
   *  the path is not in the cache. Never reads the disk. */
  tasks(path: string): TaskSummary | undefined {
    const entry = this.#entries.get(path)
    if (!entry) return undefined
    entry.tasks ??= summariseTasks(entry.content)
    return entry.tasks
  }

  /** A fact derived from the cached entry's content, computed on first ask and kept on the entry
   *  until it is re-read or dropped; undefined when the path is not cached. Never reads the disk.
   *  `slot` names the fact; one slot must always be derived by the same function. */
  derive<T>(path: string, slot: string, compute: (content: string) => T): T | undefined {
    const entry = this.#entries.get(path)
    if (!entry) return undefined
    entry.derived ??= new Map()
    if (entry.derived.has(slot)) return entry.derived.get(slot) as T
    const value = compute(entry.content)
    entry.derived.set(slot, value)
    return value
  }

  /** The entry for `file` only when it matches the listing's mtime and size. */
  current(file: IndexableFile): SearchIndexEntry | undefined {
    const entry = this.#entries.get(file.path)
    return entry && entry.mtimeMs === file.modifiedAt && entry.size === file.size ? entry : undefined
  }

  /** Drop entries so the next refresh re-reads them (watcher change/unlink, own writes). */
  invalidate(paths: Iterable<string>): void {
    let removed = false
    for (const path of paths) {
      this.#pendingReads.delete(path)
      if (this.#cacheFile && !this.#unchecked) this.#invalidatedBeforeLoad.add(path)
      removed = this.#unchecked?.delete(path) || removed
      removed = this.#entries.delete(path) || removed
    }
    if (removed) this.#scheduleSnapshot()
  }

  clear(): void {
    const removed = this.#entries.size > 0 || !this.#unchecked || this.#unchecked.size > 0
    this.#entries.clear()
    this.#pendingReads.clear()
    this.#retained.clear()
    this.#invalidatedBeforeLoad.clear()
    this.#unchecked = new Map()
    if (removed) this.#scheduleSnapshot()
  }

  /**
   * Bring the named files up to date (re-read the stale or missing) without forgetting any other
   * entry. `listed` is every path of the whole current listing: a retained entry no longer in it is
   * forgotten here. After this resolves, `current(file)` answers for every named file that could
   * be read.
   */
  async ensure(files: readonly IndexableFile[], listed?: ReadonlySet<string>): Promise<void> {
    await this.#load()
    let removed = false
    if (listed) {
      if (this.#unchecked) for (const path of this.#unchecked.keys()) {
        if (!listed.has(path)) removed = this.#unchecked.delete(path) || removed
      }
      for (const path of this.#retained) {
        if (listed.has(path)) continue
        this.#retained.delete(path)
        removed = this.#entries.delete(path) || removed
      }
    }
    const stale = files.filter((file) => this.#needsRead(file))
    for (const file of files) this.#retained.add(file.path)
    await this.#read(stale)
    if (removed || stale.length) this.#scheduleSnapshot()
  }

  /**
   * Bring the cache in line with a listing: re-read stale or missing files, forget files that have
   * gone. After this resolves, `get(path)` answers for every listed path that could be read.
   */
  async refresh(files: readonly IndexableFile[]): Promise<void> {
    await this.#load()
    const listed = new Set<string>()
    const stale: IndexableFile[] = []
    for (const file of files) {
      listed.add(file.path)
      if (this.#needsRead(file)) stale.push(file)
    }
    let removed = false
    for (const path of this.#entries.keys()) {
      if (!listed.has(path) && !this.#retained.has(path)) removed = this.#entries.delete(path) || removed
    }
    // Scope-excluded files may still be asked for by a Collection facts listing.
    if (this.#unchecked) for (const path of this.#unchecked.keys()) {
      if (!listed.has(path) && isPathInSearchScope(path)) removed = this.#unchecked.delete(path) || removed
    }
    await this.#read(stale)
    if (removed || stale.length) this.#scheduleSnapshot()
  }

  /** Read files into the cache with bounded concurrency; a file that cannot be read is dropped. */
  async #read(stale: readonly IndexableFile[]): Promise<void> {
    if (stale.length === 0) return
    // Give every file a distinct read identity before any worker starts, including
    // files that will wait for a slot and later reads with the same listing stamp.
    const queued = stale.map(({ path, modifiedAt, size }) => {
      const request = { path, modifiedAt, size }
      this.#pendingReads.set(path, request)
      return request
    })
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < queued.length) {
        const file = queued[next++]
        if (this.#pendingReads.get(file.path) !== file) continue
        let content: string | undefined
        try {
          this.reads += 1
          content = await this.read(file.path)
        } catch {
          // The file may have vanished between listing and reading.
        }
        if (this.#pendingReads.get(file.path) !== file) continue
        this.#pendingReads.delete(file.path)
        if (content === undefined) {
          this.#entries.delete(file.path)
          continue
        }
        this.#entries.set(file.path, {
          mtimeMs: file.modifiedAt,
          size: file.size,
          content,
          tags: this.tagsOf(content),
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queued.length) }, worker))
  }
}
