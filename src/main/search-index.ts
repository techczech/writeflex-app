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
 * no second stat pass. Reads run with bounded concurrency so a cold first query on a large folder
 * does not open hundreds of files at once.
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
 */

import { summariseTasks, type TaskSummary } from '../shared/markdown/task-lines'

export type SearchIndexEntry = { mtimeMs: number; size: number; content: string; tags: string[]; title?: string; tasks?: TaskSummary }
/** The listing shape the index needs to decide freshness — a subset of Workspace's MarkdownFile. */
export type IndexableFile = { path: string; modifiedAt: number; size: number }

export const SEARCH_INDEX_READ_CONCURRENCY = 16

const fileStem = (path: string): string => (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')

export class SearchIndex {
  readonly #entries = new Map<string, SearchIndexEntry>()
  /** Files read from disk since construction — the counter tests assert on. */
  reads = 0

  constructor(
    private readonly read: (path: string) => Promise<string>,
    private readonly tagsOf: (content: string) => string[],
    private readonly concurrency = SEARCH_INDEX_READ_CONCURRENCY,
    private readonly titleOf: (content: string, path: string) => string = (_content, path) => fileStem(path),
  ) {}

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

  /** Drop entries so the next refresh re-reads them (watcher change/unlink, own writes). */
  invalidate(paths: Iterable<string>): void {
    for (const path of paths) this.#entries.delete(path)
  }

  clear(): void {
    this.#entries.clear()
  }

  /**
   * Bring the cache in line with a listing: re-read stale or missing files, forget files that have
   * gone. After this resolves, `get(path)` answers for every listed path that could be read.
   */
  async refresh(files: readonly IndexableFile[]): Promise<void> {
    const listed = new Set<string>()
    const stale: IndexableFile[] = []
    for (const file of files) {
      listed.add(file.path)
      const cached = this.#entries.get(file.path)
      if (!cached || cached.mtimeMs !== file.modifiedAt || cached.size !== file.size) stale.push(file)
    }
    for (const path of this.#entries.keys()) if (!listed.has(path)) this.#entries.delete(path)
    if (stale.length === 0) return

    let next = 0
    const worker = async (): Promise<void> => {
      while (next < stale.length) {
        const file = stale[next++]
        let content: string
        try {
          this.reads += 1
          content = await this.read(file.path)
        } catch {
          // Vanished between the listing and the read: nothing to index this round.
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
    await Promise.all(Array.from({ length: Math.min(this.concurrency, stale.length) }, worker))
  }
}
