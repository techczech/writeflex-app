/**
 * The vault index for a window's root (ticket 0.25-02): runs work detection (vault-works.ts) over the
 * Workspace listing, reading every file's facts through the search content cache, and keeps the result
 * per root. A snapshot of each result goes to app userData (`<cacheDir>/<hash>.json`), never into the
 * vault. A root is a vault only while it holds `.writeflex/vault.json`; for any other root the index is
 * null and nothing is read or written.
 *
 * The service is the seam the `vault:index` IPC call and the `vault:index-changed` push stand on.
 */

import { createHash } from 'node:crypto'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { MANIFEST_NAME } from '../shared/folio-constants'
import { isPathInSearchScope } from '../shared/search-scope'
import { pieceTitle } from './search-query'
import { FACTS_READ_CONCURRENCY, mapBounded } from './file-facts'
import type { VaultIndex } from '../shared/vault-index'
import { vaultStoreFor } from './vault-store'
import {
  detectVaultWorks, markdownFactsFrom,
  type MarkdownFacts, type VaultWorkSettings,
} from './vault-works'
import { buildVaultPreview } from './vault-preview'
import type { VaultPreview } from '../shared/vault-preview'
import type { MarkdownFile, Workspace } from './workspace'

/**
 * The vault's work-detection settings, read through ticket 01's store (read-only, never creates the file
 * or its folder): null when the root is not a vault, defaults for anything missing or malformed.
 */
export async function readVaultWorkSettings(root: string): Promise<VaultWorkSettings | null> {
  const vault = await vaultStoreFor(root).read()
  if (!vault) return null
  return { hidden: [...vault.settings.hidden], supportFolders: [...vault.settings.supportFolders] }
}

/** Detection passes per computation: the first, plus up to three more for files read from disk on demand. */
const MAX_DETECT_PASSES = 4

/** Where a root's index snapshot lives in app userData (one file per root, named by the root's hash). */
export function vaultSnapshotPath(cacheDir: string, root: string): string {
  return join(cacheDir, `${createHash('sha1').update(root).digest('hex')}.json`)
}

type FactsEntry = { mtimeMs: number; size: number; facts: MarkdownFacts | null }
/** A folder's Folio manifest as last read: its text, by the manifest file's mtime and size. */
type ManifestEntry = { mtimeMs: number; size: number; text: string | null }
type RootCache = {
  index: VaultIndex | null
  facts: Map<string, FactsEntry>
  manifests: Map<string, ManifestEntry>
  /** The serialised index last written to the snapshot, so an unchanged index is not rewritten. */
  snapshot?: string
}

export type VaultIndexServiceOptions = {
  /** Folder in app userData for the per-root snapshots; null keeps them in memory only. */
  cacheDir: string | null
  /** The vault settings reader (ticket 01's store at integration). */
  readSettings?: (root: string) => Promise<VaultWorkSettings | null>
}

export class VaultIndexService {
  readonly #roots = new Map<string, RootCache>()
  readonly #inflight = new Map<string, { run: Promise<VaultIndex | null>; generation: number }>()
  /** Roots whose cached index reflects the disk: set only after a computation succeeds with no
   *  invalidation since it started; cleared by `invalidate`. */
  readonly #fresh = new Set<string>()
  /** Per root, bumped by every `invalidate`: a computation is current only if it did not change meanwhile. */
  readonly #generation = new Map<string, number>()
  readonly #readSettings: (root: string) => Promise<VaultWorkSettings | null>
  /** Files read from disk outside the search cache (out-of-scope folders). For tests. */
  directReads = 0

  constructor(private readonly options: VaultIndexServiceOptions) {
    this.#readSettings = options.readSettings ?? readVaultWorkSettings
  }

  /** The cached index for the Workspace's root when it is fresh; otherwise the answer of the computation
   *  in flight (or a new one), never a stale or half-computed index. */
  async get(ws: Workspace): Promise<VaultIndex | null> {
    const cached = this.#roots.get(ws.root)
    if (cached && this.#fresh.has(ws.root)) return cached.index
    return this.recompute(ws)
  }

  /** Whether a root has been asked for (the push only follows roots a renderer is showing). */
  known(root: string): boolean {
    return this.#roots.has(root)
  }

  /** Mark a root stale after a change; the named paths' facts are dropped so they are read again. */
  invalidate(root: string, paths: Iterable<string> = []): void {
    this.#fresh.delete(root)
    this.#generation.set(root, (this.#generation.get(root) ?? 0) + 1)
    const cache = this.#roots.get(root)
    if (!cache) return
    for (const path of paths) {
      cache.facts.delete(path)
      // A named manifest is read again even when a rewrite kept its mtime and size.
      if (path === MANIFEST_NAME || path.endsWith(`/${MANIFEST_NAME}`)) cache.manifests.delete(path === MANIFEST_NAME ? '' : path.slice(0, -MANIFEST_NAME.length - 1))
    }
  }


  /**
   * Run detection now and cache the result. Concurrent calls join the computation in flight when no
   * invalidation came since it started; after one, they wait for it to settle and start a new pass, so a
   * change made mid-computation is never answered with the older result.
   */
  recompute(ws: Workspace): Promise<VaultIndex | null> {
    const root = ws.root
    const generation = this.#generation.get(root) ?? 0
    const running = this.#inflight.get(root)
    if (running) {
      if (running.generation === generation) return running.run
      return running.run.then(() => undefined, () => undefined).then(() => this.recompute(ws))
    }
    const run = this.#compute(ws, generation).finally(() => {
      if (this.#inflight.get(root)?.run === run) this.#inflight.delete(root)
    })
    this.#inflight.set(root, { run, generation })
    return run
  }

  async #compute(ws: Workspace, generation: number): Promise<VaultIndex | null> {
    const root = ws.root
    const cache = this.#roots.get(root) ?? { index: null, facts: new Map<string, FactsEntry>(), manifests: new Map<string, ManifestEntry>() }
    this.#roots.set(root, cache)
    const settings = await this.#readSettings(root)
    let index: VaultIndex | null = null
    if (!settings) { cache.facts.clear(); cache.manifests.clear() }
    else index = (await this.#detect(ws, settings, cache)).index
    cache.index = index
    // Fresh only after success, and only if nothing was invalidated while this pass ran.
    if ((this.#generation.get(root) ?? 0) === generation) this.#fresh.add(root)
    if (index) await this.#snapshot(root, index, cache)
    return index
  }

  /**
   * What the Make-vault sheet shows for a root that is not a vault yet: detection with the draft's
   * settings plus the found counts. Runs on a throwaway facts cache and writes nothing: not into the
   * folder, not into the userData snapshots, and the root does not become `known` to the push.
   */
  async preview(ws: Workspace, settings: VaultWorkSettings): Promise<VaultPreview> {
    const cache: RootCache = { index: null, facts: new Map<string, FactsEntry>(), manifests: new Map<string, ManifestEntry>() }
    const { index, listed, folders } = await this.#detect(ws, settings, cache)
    return buildVaultPreview({ rootName: basename(ws.root), index, files: listed.map((file) => file.path), folders, supportFolders: settings.supportFolders })
  }

  async #detect(ws: Workspace, settings: VaultWorkSettings, cache: RootCache): Promise<{ index: VaultIndex; listed: MarkdownFile[]; folders: string[] }> {
    const root = ws.root
    const [listed, folders] = await Promise.all([ws.listFiles(), ws.listFolders()])
    // One shared read of each file with search: refresh over the same in-scope listing search uses.
    await ws.searchIndex.refresh(listed.filter((file) => isPathInSearchScope(file.path)))
    const byPath = new Map(listed.map((file) => [file.path, file]))
    for (const path of cache.facts.keys()) if (!byPath.has(path)) cache.facts.delete(path)

    const { manifests, manifestTexts } = await this.#manifests(ws, folders, cache)

    // Facts come from this root's facts cache (by mtime and size), else the search cache. A file search
    // leaves out (top-level `cache/`, `indexes/`) is read from disk only when detection asks for it: each
    // pass records those asks, they are read once, and passes repeat until one asks for nothing new (a main
    // document found only after an index note was read), at most MAX_DETECT_PASSES.
    const direct = new Map<string, string | null>()
    const asked = new Set<string>()
    const factsOf = (path: string): MarkdownFacts | null => {
      const file = byPath.get(path)
      if (!file) return null
      const known = cache.facts.get(path)
      if (known && known.mtimeMs === file.modifiedAt && known.size === file.size) return known.facts
      // Only an entry that matches the listing: the cache also retains files a Collection read.
      const entry = ws.searchIndex.current(file)
      let facts: MarkdownFacts | null
      if (entry) facts = markdownFactsFrom(entry.content, path, ws.searchIndex.title(path) ?? pieceTitle(entry.content, path))
      else if (direct.has(path)) {
        const content = direct.get(path)
        facts = content == null ? null : markdownFactsFrom(content, path, pieceTitle(content, path))
      } else {
        asked.add(path)
        return null
      }
      cache.facts.set(path, { mtimeMs: file.modifiedAt, size: file.size, facts })
      return facts
    }
    const tree = { rootName: basename(root), files: listed.map((file) => file.path), folders, manifests }
    const reader = { markdown: factsOf, manifest: (folder: string) => manifestTexts.get(folder) ?? null }
    const warn = (message: string): void => console.warn(`${message} (${root})`)
    let index = detectVaultWorks(tree, settings, reader, warn)
    for (let pass = 1; asked.size > 0 && pass < MAX_DETECT_PASSES; pass += 1) {
      const toRead = [...asked]
      asked.clear()
      await mapBounded(toRead, FACTS_READ_CONCURRENCY, async (path) => {
        this.directReads += 1
        try { direct.set(path, (await ws.readFile(path)).content) } catch { direct.set(path, null) }
      })
      index = detectVaultWorks(tree, settings, reader, () => {})
    }
    return { index, listed, folders }
  }

  /**
   * The folders holding a Folio manifest, and each manifest's text. One `stat` per folder answers
   * both whether the manifest is there and whether it changed (the Markdown listing does not carry
   * `.json` files); the text is re-read only when its mtime or size moved, 16 folders at a time.
   */
  async #manifests(ws: Workspace, folders: readonly string[], cache: RootCache): Promise<{ manifests: string[]; manifestTexts: Map<string, string | null> }> {
    const listed = new Set(folders)
    for (const folder of cache.manifests.keys()) if (!listed.has(folder)) cache.manifests.delete(folder)
    const found = await mapBounded(folders, FACTS_READ_CONCURRENCY, async (folder) => {
      let info: { mtimeMs: number; size: number }
      try { info = await stat(join(ws.root, folder, MANIFEST_NAME)) } catch { cache.manifests.delete(folder); return null }
      const known = cache.manifests.get(folder)
      if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) return { folder, text: known.text }
      let text: string | null
      try { text = (await ws.readFile(`${folder}/${MANIFEST_NAME}`)).content } catch { text = null }
      cache.manifests.set(folder, { mtimeMs: info.mtimeMs, size: info.size, text })
      return { folder, text }
    })
    const manifests: string[] = []
    const manifestTexts = new Map<string, string | null>()
    for (const entry of found) {
      if (!entry) continue
      manifests.push(entry.folder)
      manifestTexts.set(entry.folder, entry.text)
    }
    return { manifests, manifestTexts }
  }

  async #snapshot(root: string, index: VaultIndex, cache: RootCache): Promise<void> {
    const dir = this.options.cacheDir
    if (!dir) return
    const serialised = JSON.stringify(index)
    // An unchanged index is already on disk: a save that moves no work rewrites nothing.
    if (cache.snapshot === serialised) return
    try {
      await mkdir(dir, { recursive: true })
      const target = vaultSnapshotPath(dir, root)
      const temp = `${target}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify({ root, computedAt: new Date().toISOString(), index }))
      await rename(temp, target)
      cache.snapshot = serialised
    } catch { /* the snapshot is a convenience; the in-memory index stands */ }
  }
}
