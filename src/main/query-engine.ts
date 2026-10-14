/**
 * The one Collection Query engine (ADR-0019/0023). It parses the portable line grammar once and
 * returns projection-neutral rows consumed later by in-document Query Objects, the Rail, the Board,
 * and the Digest. It is read-only and stateless: callers always evaluate current Workspace bytes.
 */

import { posix } from 'node:path'
import { collectionPieces } from './collection'
import { BOARD_STATUS_ORDER } from '../shared/collection-status'
import type { Workspace } from './workspace'
import { collectionMaterial, collectionOffcuts, collectionSourceUse, isResearchNotePath, materialFactOf, type Offcut, type PieceDrawer, type SourceUser } from './piece-material'
import { isScrapsPath } from './scraps'

export type QueryFilterField = 'title' | 'date' | 'status' | 'description' | 'purpose' | 'related' | 'tags' | 'goal' | 'due' | 'project' | 'words'
export type QuerySortField = 'date' | 'title' | 'status' | 'description' | 'purpose' | 'goal' | 'due' | 'project' | 'words'
export type QuerySortDirection = 'asc' | 'desc'
export type Query = Partial<Record<QueryFilterField, string[]>> & {
  folder?: string
  sort?: { field: QuerySortField; direction: QuerySortDirection }
  limit?: number
}

export type QueryError = { line: number; message: string; humanReadable: string }
export type QueryParseResult = { ok: true; query: Query } | { ok: false; error: QueryError }
export type QueryRow = {
  path: string
  title: string
  status: string | null
  description: string | null
  date: string | null
  words: number
  goal?: number | null
  due?: string | null
  project?: string | null
  purpose?: string | null
  agentAuthored: boolean
  provenance: { title: 'written' | 'derived'; status: 'written' | 'derived'; date: 'written' | 'derived' }
  folderPath?: string
  /** Scraps whose origin is this piece, and its sources (frontmatter `sources:` + wikilinked research notes). */
  scrapCount: number
  sourceCount: number
  /** The piece's open and ticked boxes (the Board card's "n / m to do" chip); both 0 when it has none. */
  taskOpen: number
  taskDone: number
  /** The Board card's drawer listing; present only when either count is above zero. */
  drawer?: PieceDrawer
  /** Set on a file that is a piece's material rather than a piece: a scraps file (its scraps are the
   *  Board's Offcuts column) or a research note (a Source). The Board shows neither as a card. */
  material?: 'scraps' | 'research'
  /** On a scraps file: every scrap it holds, as the Offcuts column lists them. */
  offcuts?: Offcut[]
  /** On a research note: the pieces that use it (list it in `sources:` or wikilink to it), as the
   *  Board's Sources rail names them; empty when none does yet. */
  usedBy?: SourceUser[]
}
export type QueryResult =
  | { ok: true; source: string; query: Query; rows: QueryRow[] }
  | { ok: false; source: string; error: QueryError }
export type CollectionQueryInvalidation = { paths: string[] }

const FILTER_FIELDS = ['title', 'date', 'status', 'description', 'purpose', 'related', 'tags', 'goal', 'due', 'project', 'words'] as const satisfies readonly QueryFilterField[]
const QUERY_KEYS = [...FILTER_FIELDS, 'folder', 'sort', 'limit'] as const
const SORT_FIELDS = new Set<QuerySortField>(['date', 'title', 'status', 'description', 'purpose', 'goal', 'due', 'project', 'words'])

/** Payload for the shared Collection/Query watcher channel. Paths stay in mutation order so a future
 *  projection can refresh selectively without relying on filesystem access in the renderer. */
export function collectionQueryInvalidation(paths: string[]): CollectionQueryInvalidation {
  return { paths: [...new Set(paths)] }
}

function error(line: number, message: string, humanReadable: string): QueryParseResult {
  return { ok: false, error: { line, message, humanReadable: `Line ${line}: ${humanReadable}` } }
}

function commaValues(value: string, quoted: boolean): string[] | null {
  if (!quoted) return value.split(',').map((item) => item.trim()).filter(Boolean)
  const values: string[] = []
  let current = ''
  let inQuotes = false
  let escaped = false
  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
    } else if (character === '\\' && inQuotes) {
      escaped = true
    } else if (character === '"') {
      inQuotes = !inQuotes
    } else if (character === ',' && !inQuotes) {
      const item = current.trim()
      if (item) values.push(item)
      current = ''
    } else {
      current += character
    }
  }
  if (escaped || inQuotes) return null
  const item = current.trim()
  if (item) values.push(item)
  return values
}

/** Parse the exact W1a Query source grammar. Blank lines are ignored; every non-blank line is one
 *  unique `key: value` pair. Invalid source fails closed with a line-addressed human diagnosis. */
export function parseQuery(source: string): QueryParseResult {
  const query: Query = {}
  const seen = new Set<string>()
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    const line = lines[index].trim()
    if (line === '') continue
    const colon = line.indexOf(':')
    if (colon <= 0) return error(lineNumber, 'Expected "key: value".', 'write this as a query field followed by a colon and value.')
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (!(QUERY_KEYS as readonly string[]).includes(key)) {
      return error(lineNumber, `Unknown query key "${key}".`, `“${key}” is not a query field. Use a Piece field, folder, sort, or limit.`)
    }
    if (seen.has(key)) return error(lineNumber, `Duplicate query key "${key}".`, `“${key}” already appears above. Combine its values on one line.`)
    if (value === '') return error(lineNumber, `Query key "${key}" needs a value.`, `add a value after “${key}:”.`)
    seen.add(key)

    if ((FILTER_FIELDS as readonly string[]).includes(key)) {
      const values = commaValues(value, true)
      if (values === null) return error(lineNumber, `Invalid quoted value for "${key}".`, 'close every double quote and escape quotes inside a value with a backslash.')
      if (values.length === 0) return error(lineNumber, `Query key "${key}" needs at least one value.`, `add one or more comma-separated values after “${key}:”.`)
      query[key as QueryFilterField] = values
      continue
    }
    if (key === 'folder') {
      const folder = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
      if (posix.isAbsolute(folder) || folder.split('/').some((part) => part === '..' || part === '')) {
        return error(lineNumber, 'Folder must be a relative Collection path.', 'use a folder inside this Collection, without empty or “..” segments.')
      }
      query.folder = folder
      continue
    }
    if (key === 'sort') {
      const [field, direction, ...rest] = value.toLowerCase().split(/\s+/)
      if (rest.length || !SORT_FIELDS.has(field as QuerySortField) || (direction !== 'asc' && direction !== 'desc')) {
        return error(lineNumber, `Invalid sort "${value}".`, 'use a sortable Piece field followed by asc or desc.')
      }
      query.sort = { field: field as QuerySortField, direction }
      continue
    }
    if (!/^\d+$/.test(value)) return error(lineNumber, `Invalid limit "${value}".`, 'use a whole number, for example “limit: 20”.')
    query.limit = Number(value)
  }
  return { ok: true, query }
}

function lowerSet(values: string[] | undefined): Set<string> | null {
  return values ? new Set(values.map((value) => value.toLocaleLowerCase())) : null
}

function comparePresent<T>(a: T | null, b: T | null, compare: (left: T, right: T) => number): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return compare(a, b)
}

function rowComparator(sort: NonNullable<Query['sort']>): (a: QueryRow, b: QueryRow) => number {
  const statusRank = new Map<string, number>(BOARD_STATUS_ORDER.map((status, index) => [status.toLowerCase(), index]))
  return (a, b) => {
    let compared = 0
    if (sort.field === 'words' || sort.field === 'goal') {
      const left = sort.field === 'words' ? a.words : a.goal ?? null
      const right = sort.field === 'words' ? b.words : b.goal ?? null
      compared = comparePresent(left, right, (one, two) => one - two)
    }
    else if (sort.field === 'status') {
      compared = comparePresent(a.status, b.status, (left, right) => {
        const leftRank = statusRank.get(left.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
        const rightRank = statusRank.get(right.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
        return leftRank - rightRank || left.localeCompare(right, undefined, { sensitivity: 'base' })
      })
    } else {
      compared = comparePresent(a[sort.field] ?? null, b[sort.field] ?? null, (left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    }
    // Missing values stay last in either direction; reverse only comparisons where both values exist.
    const leftMissing = sort.field !== 'words' && (a[sort.field] ?? null) === null
    const rightMissing = sort.field !== 'words' && (b[sort.field] ?? null) === null
    if (!leftMissing && !rightMissing && sort.direction === 'desc') compared *= -1
    return compared || a.path.localeCompare(b.path)
  }
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function filterValues(piece: Awaited<ReturnType<typeof collectionPieces>>[number], field: QueryFilterField): string[] {
  if (field === 'title') return [piece.metadata.title]
  if (field === 'date') return piece.metadata.date ? [piece.metadata.date] : []
  if (field === 'status') return piece.path.split('/').includes('agent-notes') ? [] : [piece.metadata.status]
  if (field === 'description') return piece.frontmatter?.description ? [piece.frontmatter.description] : []
  if (field === 'purpose') return piece.metadata.purpose ? [piece.metadata.purpose] : []
  if (field === 'related') return piece.metadata.related
  if (field === 'tags') return piece.frontmatter?.tags ?? []
  if (field === 'words') return [String(piece.derived.words)]
  const value = scalar(piece.frontmatter?.extra[field])
  return value === null ? [] : [value]
}

/** Evaluate a Query over the Collection's recursive Piece population. */
export async function evaluateCollectionQuery(ws: Workspace, dir: string, source: string): Promise<QueryResult> {
  const parsed = parseQuery(source)
  if (!parsed.ok) return { ok: false, source, error: parsed.error }
  const scopeDir = parsed.query.folder ? posix.join(dir, parsed.query.folder) : dir
  const pieces = await collectionPieces(ws, scopeDir)
  // Material is derived from the same Piece reads (scraps files and research notes are Pieces too),
  // over the whole scope before filtering, so a filtered row still counts material it does not match.
  const facts = pieces.map(materialFactOf)
  const material = collectionMaterial(scopeDir, facts)
  const offcuts = collectionOffcuts(facts)
  const sourceUse = collectionSourceUse(scopeDir, facts)
  const rows: QueryRow[] = []

  for (const piece of pieces) {
    let matches = true
    for (const field of FILTER_FIELDS) {
      const wanted = lowerSet(parsed.query[field])
      if (wanted && !filterValues(piece, field).some((value) => wanted.has(value.toLocaleLowerCase()))) {
        matches = false
        break
      }
    }
    if (!matches) continue
    const rawGoal = scalar(piece.frontmatter?.extra.goal)
    const agentAuthored = piece.path.split('/').includes('agent-notes')
    rows.push({
      path: piece.path,
      title: piece.metadata.title,
      status: agentAuthored ? null : piece.metadata.status,
      description: piece.frontmatter?.description ?? null,
      date: piece.metadata.date,
      words: piece.derived.words,
      ...(rawGoal !== null && /^\d+$/.test(rawGoal) ? { goal: Number(rawGoal) } : {}),
      ...(scalar(piece.frontmatter?.extra.due) !== null ? { due: scalar(piece.frontmatter?.extra.due) } : {}),
      ...(scalar(piece.frontmatter?.extra.project) !== null ? { project: scalar(piece.frontmatter?.extra.project) } : {}),
      ...(piece.metadata.purpose !== null ? { purpose: piece.metadata.purpose } : {}),
      agentAuthored,
      provenance: {
        title: piece.provenance.title,
        status: piece.provenance.status,
        date: piece.provenance.date,
      },
      ...(piece.folderPath ? { folderPath: piece.folderPath } : {}),
      scrapCount: material.get(piece.path)?.scrapCount ?? 0,
      sourceCount: material.get(piece.path)?.sourceCount ?? 0,
      taskOpen: piece.derived.tasks?.open ?? 0,
      taskDone: piece.derived.tasks?.done ?? 0,
      ...(material.get(piece.path)?.drawer ? { drawer: material.get(piece.path)!.drawer! } : {}),
      ...(isScrapsPath(piece.path) ? { material: 'scraps' as const, offcuts: offcuts.get(piece.path) ?? [] }
        : isResearchNotePath(piece.path, scopeDir) ? { material: 'research' as const, usedBy: sourceUse.get(piece.path) ?? [] } : {}),
    })
  }

  if (parsed.query.sort) rows.sort(rowComparator(parsed.query.sort))
  else rows.sort((a, b) => a.path.localeCompare(b.path))
  return { ok: true, source, query: parsed.query, rows: parsed.query.limit === undefined ? rows : rows.slice(0, parsed.query.limit) }
}
