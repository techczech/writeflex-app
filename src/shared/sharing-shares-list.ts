// The Shares list (sharing ticket 10; spec docs/plans/spec-writeflex-sharing-and-reader-notes-2026-10-14.md
// section 4.6; locked frame `shares-list`): the Sharing page one level up, every link made in the
// Workspace. Main (src/main/sharing-piece-ipc.ts `sharing:open-list`) decides which links are listed and
// binds exactly those to the window; this file holds the shapes it answers in and the pure model the page
// draws from: counts per link and per collection, the filters and the sort. Nothing here is a secret.
//
// Notes waiting and Handled (ticket 07): undecided and decided readers' records of each link in this
// Collection's review list, from main (`sharing:notes`). The Opened column is the service's count (service build 4).

import type { OwnAddressState } from './sharing-setup'
import type { ShareKind, ShareLinkView } from './sharing-links'

/** One link on the Shares list. */
export type ShareListEntry = {
  link: ShareLinkView
  kind: ShareKind
  /** The piece's path in this window's Workspace; a Folio: its folder ('' the Workspace itself). */
  path: string
  /** The Piece column: the piece's name, or the Folio's with " (Folio)". */
  piece: string
  /** Its file is no longer a writer's piece, or its folder no longer a Folio: Copy link and Turn off only. */
  sourceGone: boolean
  /** The file to open for its Sharing page (the piece, or a part of the Folio); null when there is none. */
  openPath: string | null
}

export type SharesListView = {
  /** Sharing is set up on this Mac. */
  ready: boolean
  /** The address new and copied links read (as on the Sharing page). */
  address: string | null
  cloudflareAddress?: string | null
  addressUntil?: number | null
  ownAddress?: OwnAddressState | null
  entries: ShareListEntry[]
}

/** The pages ask for opened counts this long after their view was last read, so a burst of changes asks once. */
export const OPENED_SETTLE_MS = 300

/** How many times each link was opened, by share id; null when the service did not say. */
export type OpenedCounts = Record<string, number | null>

/**
 * What the opened counts are asked again on (ticket 11, review 10 P3-2): the links listed, each one on or
 * off, and when its last publish finished. A publish step changes none of it (`publishing`, a problem),
 * so a burst of steps asks the service once, when the publish has gone through.
 */
export function openedKey(links: readonly Pick<ShareLinkView, 'shareId' | 'on' | 'publishedAt'>[]): string {
  return links.map((link) => `${link.shareId}:${link.on ? 1 : 0}:${link.publishedAt ?? ''}`).sort().join(',')
}

/** A path relative to the Collection that stays inside it: not absolute (`/`, `\\`, a drive), no `..` step. */
const insideCollection = (path: string): boolean => !/^([\\/]|[A-Za-z]:)/.test(path) && !path.split(/[\\/]/).includes('..')

/**
 * The Piece column's folder (ticket 11, review 10 P3-3): for each listed link whose piece shares its
 * name with another piece (or Folio) on the list, the folder it is in within the Collection ('' the
 * Collection itself), by share id. Links to one same piece are one piece; unique names get none. Only
 * a folder inside the Collection is shown: a path from a malformed record that is absolute or climbs
 * out with `..` gets none (review round 1 of ticket 11, F4).
 */
export function sameNameFolders(entries: readonly ShareListEntry[]): Record<string, string> {
  const pathsByName = new Map<string, Set<string>>()
  for (const entry of entries) {
    const name = entry.piece.toLowerCase()
    pathsByName.set(name, (pathsByName.get(name) ?? new Set()).add(`${entry.kind}:${entry.path}`))
  }
  const folders: Record<string, string> = {}
  for (const entry of entries) {
    if ((pathsByName.get(entry.piece.toLowerCase())?.size ?? 0) < 2 || !insideCollection(entry.path)) continue
    const slash = entry.path.lastIndexOf('/')
    folders[entry.link.shareId] = slash < 0 ? '' : entry.path.slice(0, slash)
  }
  return folders
}

/** A link that needs the writer: on, and its last publish did not go through or left a part out. */
export function needsAttention(entry: ShareListEntry): boolean {
  return entry.link.on && (entry.link.problem !== null || !!entry.link.lost || (entry.link.missingParts ?? 0) > 0)
}

export type ListTotals = {
  links: number
  on: number
  off: number
  attention: number
  /** Opened, all links together; null while no count is known. */
  opened: number | null
  /** Some links' counts are not known: the total is "at least". */
  openedPartial: boolean
}

/** The collection's counts (frame `shares-list`, the filter buttons and "This collection"). */
export function listTotals(entries: readonly ShareListEntry[], opened: OpenedCounts): ListTotals {
  const known = entries.map((entry) => opened[entry.link.shareId]).filter((count): count is number => typeof count === 'number')
  const on = entries.filter((entry) => entry.link.on).length
  return {
    links: entries.length,
    on,
    off: entries.length - on,
    attention: entries.filter(needsAttention).length,
    opened: known.length > 0 ? known.reduce((sum, count) => sum + count, 0) : null,
    openedPartial: known.length > 0 && known.length < entries.length,
  }
}

/** The Opened cell: the count, or a dash when the service did not say (offline, an older service). */
export function openedLabel(count: number | null | undefined): string {
  return typeof count === 'number' ? String(count) : '–'
}

/** The link detail's Opened fact (frame `shared-several`: "3 times"); "Not known" when the service did not say. */
export function openedTimes(count: number | null | undefined): string {
  if (typeof count !== 'number') return 'Not known'
  return count === 1 ? '1 time' : `${count} times`
}

export type ListFilter = 'all' | 'on' | 'off' | 'attention'

/** The links a filter and a search ("Search by piece or link name") leave. */
export function filterEntries(entries: readonly ShareListEntry[], filter: ListFilter, search: string, label: (entry: ShareListEntry) => string): ShareListEntry[] {
  const words = search.trim().toLowerCase()
  return entries.filter((entry) => {
    if (filter === 'on' && !entry.link.on) return false
    if (filter === 'off' && entry.link.on) return false
    if (filter === 'attention' && !needsAttention(entry)) return false
    return !words || entry.piece.toLowerCase().includes(words) || label(entry).toLowerCase().includes(words)
  })
}

export type ListColumn = 'piece' | 'name' | 'settings' | 'made' | 'opened' | 'waiting' | 'handled' | 'on'

/** Notes waiting and handled per link (ticket 07; null: not known). */
export type NotesWaitingHandled = Record<string, { waiting: number | null; handled: number | null }>

/** The collection's Notes waiting and Notes handled (frame `shares-list`, "This collection"); null while none is known. */
export function notesTotals(entries: readonly ShareListEntry[], notes: NotesWaitingHandled): { waiting: number | null; handled: number | null } {
  const sum = (pick: 'waiting' | 'handled'): number | null => {
    const known = entries.map((entry) => notes[entry.link.shareId]?.[pick]).filter((count): count is number => typeof count === 'number')
    return known.length > 0 ? known.reduce((total, count) => total + count, 0) : null
  }
  return { waiting: sum('waiting'), handled: sum('handled') }
}
export type ListSort = { column: ListColumn; descending: boolean }

/** The list sorted by a column; ties keep the order they were made in (newest first). */
export function sortEntries(entries: readonly ShareListEntry[], sort: ListSort, opened: OpenedCounts, label: (entry: ShareListEntry) => string, notes: NotesWaitingHandled = {}): ShareListEntry[] {
  const key = (entry: ShareListEntry): string | number => {
    switch (sort.column) {
      case 'piece': return entry.piece.toLowerCase()
      case 'name': return label(entry).toLowerCase()
      case 'settings': return entry.link.comments ? 1 : 0
      case 'made': return entry.link.madeAt
      case 'opened': return opened[entry.link.shareId] ?? -1
      case 'waiting': return notes[entry.link.shareId]?.waiting ?? -1
      case 'handled': return notes[entry.link.shareId]?.handled ?? -1
      case 'on': return entry.link.on ? 1 : 0
    }
  }
  const newestFirst = [...entries].sort((a, b) => b.link.madeAt - a.link.madeAt)
  return newestFirst
    .map((entry, index) => ({ entry, index, key: key(entry) }))
    .sort((a, b) => {
      const order = typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key).localeCompare(String(b.key))
      return (sort.descending ? -order : order) || a.index - b.index
    })
    .map((item) => item.entry)
}
