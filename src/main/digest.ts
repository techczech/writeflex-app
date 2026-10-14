import { basename, isAbsolute, posix, relative, sep } from 'node:path'
import type { ContextItem } from '@bridle/core'
import { collectionPieces } from './collection'
import type { Workspace } from './workspace'
import { buildWikilinkCandidateIndex, resolveWikilinkTargetFromIndex, type Candidate } from './wikilinks'
export { digestDisplayGist } from '../shared/digest-display'
import { digestDisplayGist } from '../shared/digest-display'

export type DigestLinks = { inbound: number; outbound: number; degree: number }
export type DigestPiece = {
  path: string
  title: string
  status: string | null
  gist: string
  words: number
  links: DigestLinks
  agentAuthored: boolean
  folderPath?: string
}
export type CollectionDigest = {
  collection: string
  summary: { pieces: number; statuses: Record<string, number> }
  pieces: DigestPiece[]
  readThisTurn: string[]
}

function aliases(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean)
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

/** Compute ambient Collection knowledge from the existing Piece population. No model or harness enters this path. */
export async function computeCollectionDigest(
  ws: Workspace,
  dir: string,
  readThisTurn: string[] = [],
): Promise<CollectionDigest> {
  const pieces = await collectionPieces(ws, dir)
  const candidates: Candidate[] = pieces.map((piece) => ({
    path: piece.path,
    title: piece.metadata.title,
    basename: posix.basename(piece.path).replace(/\.(?:md|markdown|mdx)$/i, ''),
    aliases: aliases(piece.frontmatter?.extra.aliases ?? piece.frontmatter?.extra.alias),
  }))
  const inbound = new Map(pieces.map((piece) => [piece.path, 0]))
  const outbound = new Map(pieces.map((piece) => [piece.path, 0]))
  const candidateIndex = buildWikilinkCandidateIndex(candidates)
  for (const piece of pieces) {
    for (const target of piece.derived.wikilinks) {
      const resolved = resolveWikilinkTargetFromIndex(piece.path, target, candidateIndex).to
      if (!resolved) continue
      outbound.set(piece.path, (outbound.get(piece.path) ?? 0) + 1)
      inbound.set(resolved, (inbound.get(resolved) ?? 0) + 1)
    }
  }

  const rows = pieces.map((piece): DigestPiece => {
    const agentAuthored = piece.path.split('/').includes('agent-notes')
    const incoming = inbound.get(piece.path) ?? 0
    const outgoing = outbound.get(piece.path) ?? 0
    return {
      path: piece.path,
      title: piece.metadata.title,
      status: agentAuthored ? null : piece.metadata.status,
      gist: piece.derived.gist,
      words: piece.derived.words,
      links: { inbound: incoming, outbound: outgoing, degree: incoming + outgoing },
      agentAuthored,
      ...(piece.folderPath ? { folderPath: piece.folderPath } : {}),
    }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const statuses: Record<string, number> = {}
  for (const piece of rows) if (piece.status) statuses[piece.status] = (statuses[piece.status] ?? 0) + 1
  return {
    collection: dir === '' ? basename(ws.root) : posix.basename(dir),
    summary: { pieces: rows.length, statuses },
    pieces: rows,
    readThisTurn: [...new Set(readThisTurn)].filter((path) => rows.some((piece) => piece.path === path)),
  }
}

function statusSummary(digest: CollectionDigest): string {
  const counts = Object.entries(digest.summary.statuses)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
  return `${digest.collection} — ${digest.summary.pieces} ${digest.summary.pieces === 1 ? 'piece' : 'pieces'}${counts.length ? ` · ${counts.join(' · ')}` : ''}`
}

export function digestSummaryLine(digest: CollectionDigest): string {
  return statusSummary(digest)
}

function boundedSection(lines: string[], budget: number, label: string, singular: string): string {
  if (lines.length === 0) return `${label}\n- none`
  const chosen: string[] = []
  for (const line of lines) {
    const omitted = lines.length - chosen.length - 1
    const marker = `… and ${Math.max(0, omitted)} more ${singular}${omitted === 1 ? '' : 's'}${singular === 'Piece' ? ' omitted to keep the Digest bounded.' : ''}`
    if ([label, ...chosen, line, marker].join('\n').length > budget) break
    chosen.push(line)
  }
  const omitted = lines.length - chosen.length
  const marker = `… and ${omitted} more ${singular}${omitted === 1 ? '' : 's'}${singular === 'Piece' ? ' omitted to keep the Digest bounded.' : ''}`
  return [label, ...chosen, ...(omitted > 0 ? [marker] : [])].join('\n')
}

/** Roughly 2,000 tokens at four characters per token. Truncation is explicit, never silent. */
export function formatDigestContext(digest: CollectionDigest, maxChars = 8_000): string {
  const head = `DIGEST (code-computed ambient Collection knowledge)\n${statusSummary(digest)}`
  const reads = digest.readThisTurn.map((path) => `- ${path}`)
  const lines = digest.pieces.map((piece) => {
    const status = piece.status ?? 'agent note'
    const provenance = piece.agentAuthored ? ' · agent-authored' : ''
    return `- ${piece.path} | ${piece.title} | ${status} | ${piece.words} words | links ${piece.links.inbound} in/${piece.links.outbound} out | ${digestDisplayGist(piece.gist) || 'no gist'}${provenance}`
  })
  const separators = 4
  const available = Math.max(0, maxChars - head.length - separators)
  const readBudget = Math.floor(available * 0.25)
  const pieceBudget = available - readBudget
  const pieces = boundedSection(lines, pieceBudget, 'PIECES', 'Piece')
  const read = boundedSection(reads, readBudget, 'READ LAST TURN (full file reads by tools)', 'read')
  const output = `${head}\n\n${pieces}\n\n${read}`
  return output.length <= maxChars ? output : output.slice(0, Math.max(0, maxChars - 1)) + '…'
}

export function digestContextItem(digest: CollectionDigest): ContextItem {
  return { kind: 'text', label: 'Active Collection Digest', content: formatDigestContext(digest), transcript: 'hidden' }
}

export function cachedDigestContextItem(cache: CollectionDigestCache, ws: Workspace, dir: string, revision: number, readThisTurn: string[] = []): ContextItem {
  const digest = cache.take(ws, dir, revision, readThisTurn)
  if (!digest) throw new Error(`The ${dir || 'Workspace'} Digest cache entry is unavailable.`)
  return digestContextItem(digest)
}

/** Convert Bridle receipt paths to honest, unique Workspace-relative file reads. */
export function digestReadPaths(root: string, filesRead: readonly string[]): string[] {
  const out: string[] = []
  for (const path of filesRead) {
    const rel = isAbsolute(path) ? relative(root, path) : path
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue
    const normalised = rel.split(sep).join('/')
    if (!out.includes(normalised)) out.push(normalised)
  }
  return out
}

/** Expand real Workspace-relative write paths into every Collection scope they invalidate. */
export function collectionDirsForPaths(paths: readonly string[]): string[] {
  const dirs = new Set<string>([''])
  for (const path of paths) {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean)
    for (let index = 1; index <= parts.length; index += 1) dirs.add(parts.slice(0, index).join('/'))
  }
  return [...dirs]
}

/** Track invalidation revisions for Collection scopes reached by real Workspace paths. */
export class CollectionDigestRevisions {
  private readonly values = new Map<string, number>()

  private key(root: string, dir: string): string {
    return `${root}\0${dir}`
  }

  get(root: string, dir: string): number {
    return this.values.get(this.key(root, dir)) ?? 0
  }

  bump(root: string, paths: readonly string[]): void {
    for (const dir of collectionDirsForPaths(paths)) {
      const key = this.key(root, dir)
      this.values.set(key, (this.values.get(key) ?? 0) + 1)
    }
  }
}

type DigestBuilder = (ws: Workspace, dir: string) => Promise<CollectionDigest>
type CacheEntry = {
  promise: Promise<CollectionDigest>
  resolved?: CollectionDigest
  primed: boolean
  lastUsed: number
}

export class CollectionDigestCache {
  private readonly values = new Map<string, CacheEntry>()
  private clock = 0
  constructor(private readonly build: DigestBuilder = computeCollectionDigest, private readonly maxEntries = 4) {}

  private key(ws: Workspace, dir: string, revision: number): string {
    return `${ws.root}\0${dir}\0${revision}`
  }

  private collectionPrefix(ws: Workspace, dir: string): string {
    return `${ws.root}\0${dir}\0`
  }

  private touch(entry: CacheEntry): void {
    entry.lastUsed = ++this.clock
  }

  private evict(protectedKey?: string): void {
    while (this.values.size > this.maxEntries) {
      const candidate = [...this.values.entries()]
        .filter(([key]) => key !== protectedKey)
        .sort((left, right) => Number(left[1].primed) - Number(right[1].primed) || left[1].lastUsed - right[1].lastUsed)[0]
      if (!candidate) return
      this.values.delete(candidate[0])
    }
  }

  private entry(ws: Workspace, dir: string, revision: number): CacheEntry {
    const key = this.key(ws, dir, revision)
    const existing = this.values.get(key)
    if (existing) {
      this.touch(existing)
      return existing
    }
    const prefix = this.collectionPrefix(ws, dir)
    for (const [cachedKey, cached] of this.values) {
      if (cachedKey.startsWith(prefix) && !cached.primed) this.values.delete(cachedKey)
    }
    const entry: CacheEntry = {
      promise: Promise.resolve(null as unknown as CollectionDigest),
      primed: false,
      lastUsed: ++this.clock,
    }
    entry.promise = this.build(ws, dir).then((digest) => {
      entry.resolved = digest
      return digest
    }).catch((error) => {
      this.values.delete(key)
      throw error
    })
    this.values.set(key, entry)
    this.evict(key)
    return entry
  }

  async get(ws: Workspace, dir: string, revision: number, readThisTurn: string[] = []): Promise<CollectionDigest> {
    const digest = await this.entry(ws, dir, revision).promise
    return { ...digest, readThisTurn: [...readThisTurn] }
  }

  async prime(ws: Workspace, dir: string, revision: number): Promise<void> {
    const entry = this.entry(ws, dir, revision)
    entry.primed = true
    await entry.promise
  }

  take(ws: Workspace, dir: string, revision: number, readThisTurn: string[] = []): CollectionDigest | null {
    const entry = this.values.get(this.key(ws, dir, revision))
    if (!entry?.resolved) return null
    this.touch(entry)
    return { ...entry.resolved, readThisTurn: [...readThisTurn] }
  }

  takePrimed(ws: Workspace, dir: string, readThisTurn: string[] = []): CollectionDigest | null {
    const prefix = this.collectionPrefix(ws, dir)
    const candidate = [...this.values.entries()]
      .filter(([key, entry]) => key.startsWith(prefix) && entry.primed && entry.resolved)
      .sort((left, right) => right[1].lastUsed - left[1].lastUsed)[0]
    if (!candidate?.[1].resolved) return null
    candidate[1].primed = false
    this.touch(candidate[1])
    const digest = { ...candidate[1].resolved, readThisTurn: [...readThisTurn] }
    this.evict()
    return digest
  }

  /** Test seam: a turn consumes its primed marker before any later prompt work can throw or abort. */
  pinnedCountForTests(): number { return [...this.values.values()].filter((entry) => entry.primed).length }
}
