import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { metadataRows } from '../shared/document-metadata'
import { METADATA_REGISTRY, type MetadataValues } from '../shared/metadata-registry'

export const METADATA_SCAN_LIMITS = { files: 1000, fileBytes: 256 * 1024, totalBytes: 16 * 1024 * 1024, values: 60 } as const
type File = { path: string; size: number; modifiedAt: number }
type Source = { listFiles(): Promise<File[]>; readFile(path: string): Promise<{ content: string }> }
type Cached = { stamp: string; rows: ReturnType<typeof metadataRows> }
const caches = new WeakMap<Source, Map<string, Cached>>()

/** Opaque values never become suggestions, but ordinary multiline prose and flat nested maps
 * need not hide a document's unrelated author/tags. Other unsupported shapes fail closed. */
function readableOrOpaque(row: ReturnType<typeof metadataRows>[number], inner: string): boolean {
  if (row.editable) return true
  // A file with an entry the key reader cannot name is skipped, whatever its value looks like.
  if (row.opaque) return false
  const lines = inner.slice(row.from, row.to).trimEnd().split(/\r?\n/)
  const first = lines.shift() ?? ''
  const tail = first.slice(first.indexOf(':') + 1).trim().replace(/\s+#.*$/, '')
  const indented = (line: string) => /^ *(?:#.*)?$/.test(line) || /^ +\S/.test(line)
  if (/^[|>](?:[+-][1-9]?|[1-9][+-]?)?$/.test(tail)) return lines.every(indented)
  if (tail !== '' || !lines.every(indented)) return false
  return lines.every(line => {
    if (/^ *(?:#.*)?$/.test(line)) return true
    const nested = metadataRows(line.trimStart())
    return nested.length === 1 && nested[0].editable
  })
}

/** Main-only, bounded asynchronous IO. Per-workspace file facts are invalidated by mtime/size on every request. */
export async function workspaceMetadataValues(workspace: Source, exclude?: string): Promise<MetadataValues> {
  let cache = caches.get(workspace)
  if (!cache) { cache = new Map(); caches.set(workspace, cache) }
  const listed = await workspace.listFiles()
  const present = new Set(listed.map(f => f.path))
  for (const path of cache.keys()) if (!present.has(path)) cache.delete(path)
  let bytes = 0, files = 0
  const counts = new Map(METADATA_REGISTRY.filter(e => !e.system && !e.options).map(e => [e.key, new Map<string, number>()]))
  for (const file of listed) {
    if (file.path === exclude || !/\.(md|markdown|mdx)$/i.test(file.path) || file.size > METADATA_SCAN_LIMITS.fileBytes) continue
    if (files >= METADATA_SCAN_LIMITS.files || bytes + file.size > METADATA_SCAN_LIMITS.totalBytes) break
    files++; bytes += file.size
    const stamp = `${file.modifiedAt}:${file.size}`
    let cached = cache.get(file.path)
    if (!cached || cached.stamp !== stamp) {
      try {
        const { content } = await workspace.readFile(file.path)
        const block = Buffer.byteLength(content) <= METADATA_SCAN_LIMITS.fileBytes ? frontmatterBlock(content) : null
        const inner = block ? content.slice(content.indexOf('\n') + 1, block.end).replace(/\r?\n---[^\n]*(?:\n)?$/, '') : ''
        const rows = metadataRows(inner)
        // Unsupported/malformed headers cannot seed misleading autocomplete values.
        const prefix = inner.slice(0, rows[0]?.from ?? inner.length)
        const cleanPrefix = prefix.split(/\r?\n/).every(line => /^\s*(?:#.*)?$/.test(line))
        cached = { stamp, rows: cleanPrefix && rows.every(row => readableOrOpaque(row, inner)) && new Set(rows.map(r => r.key)).size === rows.length ? rows : [] }
        cache.set(file.path, cached)
      } catch { continue }
    }
    for (const row of cached.rows) {
      const values = counts.get(row.key)
      if (!values) continue
      for (const value of new Set(Array.isArray(row.value) ? row.value : [row.value])) {
        if (value && value.length <= 2000 && !value.includes('\n')) values.set(value, (values.get(value) ?? 0) + 1)
      }
    }
  }
  return Object.fromEntries([...counts].map(([key, values]) => [key, [...values].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, METADATA_SCAN_LIMITS.values)]))
}
