import type { FolioOutlineFile } from './folio-outline'
import type { RoomMap } from './folio-map'
import type { RoomEvidence } from './folio-evidence'
/**
 * The Folio room's facts, as plain data main gathers (`folio-room:read`) and the renderer draws (ADR-0048, spec
 * docs/plans/spec-folio-room-data-model-2026-10-22.md). Pure: nothing here reads or writes a file. This first slice
 * is read only (I-4): labels and priorities are DISPLAYED from plan-line tags (D-LBL-1/2, D-PRI-1), the status of a
 * written part is its file's `status:` (D-STA-1) and an unwritten part's is always `idea` (D-STA-2).
 */

import type { PlanCardKey, PlanPartKey } from './folio-running-order'
import type { Flag, FlagKind } from './markdown/flags'
import type { NewCardFolio } from './folio-room-order'
import type { FolioBinItem } from './folio-bin'

/**
 * The tabs of the Folio workspace (ADR-0049, layout 1A), in the drawn order; ⌥1 … ⌥7 follow this order
 * (`WORKSPACE_TAB_CHORDS`). Outline is the default tab; the last one is remembered per Folio.
 */
export const ROOM_VIEWS = ['outline', 'text', 'cards', 'map', 'flags', 'evidence', 'files'] as const
export type RoomView = (typeof ROOM_VIEWS)[number]
export const ROOM_VIEW_LABELS: Record<RoomView, string> = { outline: 'Outline', text: 'Text', cards: 'Cards', map: 'Map', flags: 'Flags', evidence: 'Evidence', files: 'Files' }
/** Every tab works. */
export const ROOM_AVAILABLE_VIEWS: readonly RoomView[] = ROOM_VIEWS
/** The chord of each tab, by position: ⌥1 Outline … ⌥7 Files. The command registry holds the same table (`folio.room.<tab>`). */
export const WORKSPACE_TAB_CHORDS: Readonly<Record<RoomView, string>> = { outline: '⌥1', text: '⌥2', cards: '⌥3', map: '⌥4', flags: '⌥5', evidence: '⌥6', files: '⌥7' }

/** The fixed palette size (D-LBL-2): label colours are `--folio-label-1` … `--folio-label-8` by list position. */
export const LABEL_PALETTE_SIZE = 8

export type RoomPriority = 'high' | 'medium' | 'low'
const PRIORITIES: readonly RoomPriority[] = ['high', 'medium', 'low']

export type RoomLabel = { name: string; slug: string; /** 1-based palette slot. */ colour: number }

export type RoomPart = {
  resolution?: 'missing' | 'ambiguous'
  /** Heading facts parsed from the content already read by the room loader. */
  outline?: FolioOutlineFile
  /** The part's Plan key: its identity in every surface (interaction 3). */
  key: PlanPartKey
  /** Whole plan line used to reject edits based on an out-of-date card. */
  card: PlanCardKey
  /** Its place in the running order (0-based). */
  index: number
  title: string
  /** The plan-line gloss (D-SYN-1). */
  synopsis: string | null
  role: string
  frontMatter: boolean
  /** The plan-line tags that are neither a listed label nor a recognised priority (shown as ordinary tags). */
  tags: string[]
  label: RoomLabel | null
  priority: RoomPriority | null
  /** A written part's `status:` or "Unsorted"; an unwritten part's is always `idea`. */
  status: string
  written: boolean
  words: number
  /** Set when another running-order line carries the same title (D-PART-2): the sentence the card shows. */
  titleClash: string | null
  flags: Array<Flag & { path: string; fingerprint: string }>
}

export type RoomBinderItem = { path: string; name: string; kind: 'file' | 'scrap-file' | 'zotero'; section?: string; /** Scraps in a scraps file. */ scraps?: number }
/** `bin`: the Folio bin's files (main/folio-bin.ts), shown as the binder's Bin row; `binUnreadable` when its list could not be read. */
export type RoomBinder = { research: RoomBinderItem[]; notes: RoomBinderItem[]; ideas: RoomBinderItem[]; bin?: FolioBinItem[]; binUnreadable?: boolean }

export type RoomMeta = { parts: number; unwritten: number; words: number }

export type FolioRoomModel = {
  map?: RoomMap
  enrichment?: 'pending' | 'failed'
  evidence?: RoomEvidence
  dir: string
  /** The folder's name. */
  name: string
  /** The Index Note's title (frontmatter `title`, else its first heading), else the folder's name. */
  title: string
  /** The Folio's one spelling and its window root: the key room UI state is held under (I-8). */
  stateKey: string
  indexBasis: string | null
  parts: RoomPart[]
  /** Manifest entries absent from the running order, kept visible with their reasons. */
  leftOut?: Array<{ path: string; reason: 'unreadable' | 'not-found' | 'outside-folio' | 'agent-instructions' | 'room-support' | 'not-a-part' | 'not-in-outline' }>
  /** Title-page and front-matter files that are not running-order lines (the manifest's `title_matter`): shown as front matter. */
  frontMatterFiles: Array<{ path: string; title: string; words: number }>
  binder: RoomBinder
  /** The label vocabulary as written in the Index Note, in order, with each name's colour slot. */
  labels: RoomLabel[]
  /** Two vocabulary names that read as one label (D-LBL-2): reported, never rewritten. */
  duplicateLabels: string[]
  meta: RoomMeta
  /** The Index Note has no `## Running order` list: the room says "Start a plan". */
  startAPlan: boolean
  /** The files under Not in the outline (title and path) and the Index Note (null: no file yet): New card's name check (ticket 11, review S-1, S-5). */
  newCardFolio: NewCardFolio
}

/** Room UI state: kept in app state per Folio key, never in the Folio folder (I-8, D-UI-2). */
export type RoomSurface = 'room' | 'page'
/**
 * `surface`: which of the Folio's two faces it last showed, the room or the Folio page (the outline with its edit
 * controls). A Folio opens as the room unless it was last left on its page.
 */
export type MapViewport = { x: number; y: number; zoom: number; overlay: boolean }
function mapViewport(raw: unknown): MapViewport | undefined {
 if (typeof raw !== 'object' || raw === null) return undefined
 const value = raw as MapViewport
 return [value.x,value.y,value.zoom].every(Number.isFinite) && value.zoom >= 0.25 && value.zoom <= 2 ? {x:value.x,y:value.y,zoom:value.zoom,overlay:value.overlay===true} : undefined
}
export type RoomState = { identityLinksAttempted?: true; outlineTitleWidth?: number; outlineExpanded?: string[]; /** Cards grouped in the Board's status lanes (ADR-0049: the Board's lanes are an option of Cards). */ cardsByStatus?: boolean; evidenceGaps?: boolean; mapViewport?: MapViewport; flagsFilter?: FlagKind | 'all'; view: RoomView; selected: PlanPartKey | null; surface: RoomSurface; /** Cards with the selected part's text beside them (interaction 4). */ split: boolean }
export const DEFAULT_ROOM_STATE: RoomState = { view: 'outline', selected: null, surface: 'room', split: false }

/** A stored state read back: anything malformed falls to the default for that field. Only available views are kept. */
export function readRoomState(raw: unknown): RoomState {
  const fallback: RoomState = { ...DEFAULT_ROOM_STATE }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fallback
  const value = raw as { identityLinksAttempted?: unknown; outlineTitleWidth?: unknown; outlineExpanded?: unknown; cardsByStatus?: unknown; evidenceGaps?: unknown; mapViewport?: unknown; flagsFilter?: unknown; view?: unknown; selected?: unknown; surface?: unknown; split?: unknown }
  const view = ROOM_AVAILABLE_VIEWS.find((candidate) => candidate === value.view) ?? DEFAULT_ROOM_STATE.view
  const sel = value.selected as { title?: unknown; path?: unknown } | null | undefined
  const selected = sel && typeof sel === 'object' && typeof sel.title === 'string' && (sel.path === null || typeof sel.path === 'string')
    ? { title: sel.title, path: sel.path as string | null }
    : null
  const surface: RoomSurface = value.surface === 'room' || value.surface === 'page' ? value.surface : DEFAULT_ROOM_STATE.surface
  return { ...(value.identityLinksAttempted === true ? { identityLinksAttempted: true as const } : {}), ...(validTitleWidth(value.outlineTitleWidth) ? { outlineTitleWidth: value.outlineTitleWidth } : {}), ...(expandedPaths(value.outlineExpanded) ? { outlineExpanded: expandedPaths(value.outlineExpanded) } : {}), ...(value.cardsByStatus === true ? { cardsByStatus: true } : {}), ...(typeof value.evidenceGaps==='boolean'?{evidenceGaps:value.evidenceGaps}:{}), ...(mapViewport(value.mapViewport) ? {mapViewport:mapViewport(value.mapViewport)} : {}), view, selected, surface, split: value.split === true, ...(['all', 'needs-citation', 'rewrite', 'check-fact', 'expand'].includes(String(value.flagsFilter)) ? { flagsFilter: value.flagsFilter as FlagKind | 'all' } : {}) }
}

/** A patch of room state (`{ view }`, `{ selected }`, `{ surface }` or `{ split }`) laid over the stored state; a field that is absent or malformed keeps its stored value. */
export function mergeRoomState(current: RoomState, patch: unknown): RoomState {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return current
  const given = patch as Record<string, unknown>
  const next: RoomState = { ...current }
  if (given.identityLinksAttempted === true) next.identityLinksAttempted = true
  if (given.outlineTitleWidth === null) delete next.outlineTitleWidth
  else if (validTitleWidth(given.outlineTitleWidth)) next.outlineTitleWidth = given.outlineTitleWidth
  if (typeof given.cardsByStatus === 'boolean') { if (given.cardsByStatus) next.cardsByStatus = true; else delete next.cardsByStatus }
  if(typeof given.evidenceGaps==='boolean')next.evidenceGaps=given.evidenceGaps
  const viewport = mapViewport(given.mapViewport); if (viewport) next.mapViewport = viewport
  const expanded = expandedPaths(given.outlineExpanded); if (expanded) next.outlineExpanded = expanded
  // Each field is checked on its own, so a malformed one keeps its stored value instead of falling to the default.
  if (ROOM_AVAILABLE_VIEWS.some((candidate) => candidate === given.view)) next.view = given.view as RoomView
  if (given.surface === 'room' || given.surface === 'page') next.surface = given.surface
  if (['all', 'needs-citation', 'rewrite', 'check-fact', 'expand'].includes(String(given.flagsFilter))) next.flagsFilter = given.flagsFilter as FlagKind | 'all'
  if (typeof given.split === 'boolean') next.split = given.split
  if ('selected' in given) {
    if (given.selected === null) next.selected = null
    else {
      const read = readRoomState({ selected: given.selected }).selected
      if (read !== null) next.selected = read
    }
  }
  return next
}

// ---- Labels and priority (display only) ------------------------------------------------------

/** D-LBL-1's canonical slug: NFC, lower-case, runs of anything but letters and digits become `-`, trimmed. Null when empty. */
export function labelSlug(name: string): string | null {
  const slug = name.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? null : slug
}

/**
 * The label vocabulary (D-LBL-2): the Index Note frontmatter's `labels:` list, in order, as a block list (one `- name`
 * per line) or an inline `[a, b]` list. Two names with one slug: the first stays, the later ones are reported in
 * `duplicates` and ignored. A missing key, a scalar or a missing frontmatter reads as no labels. Never rewrites.
 */
export function readLabelVocabulary(indexSource: string | null): { labels: RoomLabel[]; duplicates: string[] } {
  if (indexSource === null) return { labels: [], duplicates: [] }
  const text = indexSource.replace(/^﻿/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { labels: [], duplicates: [] }
  const end = lines.findIndex((line, at) => at > 0 && /^(---|\.\.\.)\s*$/.test(line))
  if (end < 0) return { labels: [], duplicates: [] }
  const front = lines.slice(1, end)
  const at = front.findIndex((line) => /^labels\s*:/.test(line))
  if (at < 0) return { labels: [], duplicates: [] }
  const rest = withoutYamlComment(front[at].replace(/^labels\s*:\s*/, '')).trim()
  const names: string[] = []
  if (rest.startsWith('[') && rest.endsWith(']')) {
    names.push(...(inlineLabelNames(rest) ?? []))
  } else if (rest === '') {
    for (const line of front.slice(at + 1)) {
      const item = /^\s*-\s+(.*)$/.exec(line)
      if (item) { const name = unquote(withoutYamlComment(item[1])); if (name !== '') names.push(name); continue }
      if (line.trim() === '' || /^\s*#/.test(line)) continue
      break
    }
  }
  const labels: RoomLabel[] = []
  const duplicates: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const slug = labelSlug(name)
    if (slug === null) continue
    if (seen.has(slug)) { duplicates.push(name); continue }
    seen.add(slug)
    labels.push({ name, slug, colour: ((labels.length) % LABEL_PALETTE_SIZE) + 1 })
  }
  return { labels, duplicates }
}

/** A YAML scalar line without its trailing comment: a `#` that starts the text or follows a space, outside quotes (D-LBL-1/2: the name is the scalar, not the comment). */
export function withoutYamlComment(value: string): string {
  let quote: string | null = null
  const inline = value.trimStart().startsWith('[')
  let scalarStart = true
  let listStart = inline
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at]
    if (quote !== null) {
      // YAML quoting: "..." escapes with a backslash; '...' escapes a quote by doubling it.
      if (quote === '"' && char === '\\') at += 1
      else if (quote === "'" && char === "'" && value[at + 1] === "'") at += 1
      else if (char === quote) quote = null
      continue
    }
    if (/\s/.test(char)) continue
    if (char === '#' && (at === 0 || /\s/.test(value[at - 1]))) return value.slice(0, at)
    if (listStart && char === '[') { listStart = false; continue }
    if (inline && char === ',') { scalarStart = true; continue }
    if ((char === '"' || char === "'") && scalarStart) quote = char
    scalarStart = false
  }
  return value
}

/** Read a flat inline label list, respecting quoted commas; null means unsafe or malformed syntax. */
export function inlineLabelNames(value: string): string[] | null {
  if (!value.startsWith('[') || !value.endsWith(']')) return null
  const inner = value.slice(1, -1)
  if (!inner.trim()) return []
  const names: string[] = []
  let at = 0
  while (at < inner.length) {
    while (/\s/.test(inner[at] ?? '') && at < inner.length) at += 1
    if (at === inner.length) break // YAML permits a trailing comma.
    const start = at
    const quote = inner[at] === '"' || inner[at] === "'" ? inner[at++] : null
    let name: string
    if (quote) {
      let closed = false
      let body = ''
      while (at < inner.length) {
        const char = inner[at++]
        if (quote === '"' && char === '\\') { if (at === inner.length) return null; at += 1 }
        else if (char === quote) {
          if (quote === "'" && inner[at] === "'") { body += "'"; at += 1; continue }
          closed = true
          break
        } else body += char
      }
      if (!closed) return null
      if (quote === '"') {
        try { name = JSON.parse(inner.slice(start, at)); if (typeof name !== 'string') return null } catch { return null }
      } else name = body
      while (at < inner.length && /\s/.test(inner[at])) at += 1
      if (at < inner.length && inner[at] !== ',') return null
    } else {
      while (at < inner.length && inner[at] !== ',') at += 1
      name = inner.slice(start, at).trim()
      // Flat names only. Quotes inside a plain scalar are literal (Writer's voice).
      // Mapping entries, collections, tags, aliases and anchors are not label names.
      if (/^[!&*?%@`#|>]|^[-:]([\s]|$)|[\[\]{}]|:([\s]|$)/.test(name)) return null
    }
    name = name.trim()
    if (!name || /[\r\n]/.test(name)) return null
    names.push(name)
    if (at < inner.length) at += 1 // The separator, verified above for quoted names.
  }
  return names
}

function unquote(value: string): string {
  const trimmed = value.trim()
  const quoted = /^(["'])(.*)\1$/.exec(trimmed)
  if (!quoted) return trimmed
  if (quoted[1] === '"') { try { return String(JSON.parse(trimmed)).trim() } catch { /* retain unsupported YAML escapes literally */ } }
  const body = quoted[1] === '"' ? quoted[2].replace(/\\(.)/g, '$1') : quoted[2].replace(/''/g, "'")
  return body.trim()
}

/** The label of a plan line: the first `#label-<slug>` tag whose slug is listed; other `#label-…` tags stay ordinary (D-LBL-1). */
export function labelOfTags(tags: readonly string[], vocabulary: readonly RoomLabel[]): RoomLabel | null {
  for (const tag of tags) {
    if (!tag.startsWith('label-')) continue
    const found = vocabulary.find((label) => label.slug === tag.slice('label-'.length))
    if (found) return found
  }
  return null
}

/** The priority of a plan line: the first recognised `#priority-high|medium|low`; any other `#priority-…` is an ordinary tag (D-PRI-1). */
export function priorityOfTags(tags: readonly string[]): RoomPriority | null {
  for (const tag of tags) {
    const level = PRIORITIES.find((candidate) => tag === `priority-${candidate}`)
    if (level) return level
  }
  return null
}

/** The tags the card shows as ordinary tags: everything except the listed label tags and the recognised priority tags. */
export function ordinaryTags(tags: readonly string[], vocabulary: readonly RoomLabel[]): string[] {
  return tags.filter((tag) => (
    !(tag.startsWith('label-') && vocabulary.some((label) => label.slug === tag.slice('label-'.length)))
    && !PRIORITIES.some((level) => tag === `priority-${level}`)
  ))
}

// ---- Title clashes, counts, selection ---------------------------------------------------------

/** The Plan's title key (case and Unicode form folded, `linkKey` in plan.ts) for comparing two titles. */
export const titleKey = (title: string): string => title.normalize('NFC').toLocaleLowerCase()

/** D-PART-2: the sentence each part of a clash carries, by index. Parts with a unique title are absent. */
export function titleClashes(titles: readonly string[]): Map<number, string> {
  const groups = new Map<string, number[]>()
  titles.forEach((title, at) => groups.set(titleKey(title), [...(groups.get(titleKey(title)) ?? []), at]))
  const out = new Map<number, string>()
  for (const indices of groups.values()) {
    if (indices.length < 2) continue
    const sentence = `Two parts are called ‘${titles[indices[0]]}’. Rename one to use the room's evidence, map and ordering for them.`
    for (const at of indices) out.set(at, sentence)
  }
  return out
}

/** The meta line's counts under the title (spec § 7; evidence and flag counts join in later tickets). */
export function roomMeta(parts: readonly Pick<RoomPart, 'written' | 'words'>[]): RoomMeta {
  return { parts: parts.length, unwritten: parts.filter((part) => !part.written).length, words: parts.reduce((sum, part) => sum + part.words, 0) }
}

/** The meta line as drawn: "10 parts · 1 unwritten · 2,116 words" (the unwritten count is left out at zero). */
export function metaLine(meta: RoomMeta): string {
  const pieces = [`${meta.parts} ${meta.parts === 1 ? 'part' : 'parts'}`]
  if (meta.unwritten > 0) pieces.push(`${meta.unwritten} unwritten`)
  pieces.push(`${meta.words.toLocaleString('en-GB')} ${meta.words === 1 ? 'word' : 'words'}`)
  return pieces.join(' · ')
}

/**
 * Selection identity (interaction 3): the part with the selected Plan key, re-resolved after every Plan change. Two
 * parts of a title clash share a key, so the first one stands (a clash is marked, never silently resolved).
 * Null when the key names no part any more.
 */
export function resolveSelection(parts: readonly Pick<RoomPart, 'key'>[], selected: PlanPartKey | null): number | null {
  if (selected === null) return null
  // A selection with no title names a part by its file (a part opened from the Files sidebar, search or a link: only its path is known there).
  const at = parts.findIndex((part) => (selected.title === '' ? selected.path !== null && part.key.path === selected.path : part.key.title === selected.title && part.key.path === selected.path))
  return at < 0 ? null : at
}

/** The part the room shows selected: the stored selection when it still resolves, else the first part, else none. */
export function shownSelection(parts: readonly Pick<RoomPart, 'key'>[], selected: PlanPartKey | null): number | null {
  return resolveSelection(parts, selected) ?? (parts.length > 0 ? 0 : null)
}

// ---- Drawing helpers --------------------------------------------------------------------------

const STAGE_CLASSES: Record<string, string> = { idea: 'idea', 'note gathering': 'note', 'in progress': 'prog', editing: 'edit', ready: 'ready', published: 'pub', unsorted: 'unsorted' }
/** The colour class of a status chip: the app's Collection statuses and colours (D-STA-1); any other status draws neutral. */
export function stageClass(status: string): string {
  return STAGE_CLASSES[status.trim().toLowerCase()] ?? 'pub'
}

/** The priority as the inspector words it. */
export const PRIORITY_LABELS: Record<RoomPriority, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/** What a card says where its words would be. */
export const wordsText = (part: Pick<RoomPart, 'written' | 'words'>): string => (part.written ? `${part.words.toLocaleString('en-GB')} ${part.words === 1 ? 'word' : 'words'}` : 'not written yet')

// ---- Text beside the cards, Text view, previous and next (interactions 4 and 5) -----------------

/** Split only means something in Cards: Outline is a table and Text is already the text alone. */
export const splitApplies = (view: RoomView): boolean => view === 'cards'

/** Whether the text sits beside the cards: the stored toggle, but only while the Cards view is on. */
export const textBeside = (view: RoomView, split: boolean): boolean => split && splitApplies(view)

/** What the text pane holds for a part: nothing (no part), "not written yet" with no editor (an unwritten part), or the app's editor on its file. */
export function textPaneKind(part: Pick<RoomPart, 'written' | 'key'> | null): 'none' | 'not-written' | 'editor' {
  if (part === null) return 'none'
  return part.written && part.key.path !== null ? 'editor' : 'not-written'
}

/**
 * The part before (-1) or after (+1) the shown one in the running order, over the parts the room draws as cards.
 * Skips nothing: an unwritten part is a stop like any other. Null at either end, or when the shown part is not among them.
 */
export function neighbourPart<T extends Pick<RoomPart, 'index'>>(cards: readonly T[], shown: number | null, step: 1 | -1): T | null {
  if (shown === null) return null
  const at = cards.findIndex((part) => part.index === shown)
  if (at < 0) return null
  return cards[at + step] ?? null
}

/** The Outline's last row: "10 parts · 1 unwritten" and the words total, over the parts it lists. */
export function outlineTotals(parts: readonly Pick<RoomPart, 'written' | 'words'>[]): { line: string; words: number } {
  const meta = roomMeta(parts)
  const pieces = [`${meta.parts} ${meta.parts === 1 ? 'part' : 'parts'}`]
  if (meta.unwritten > 0) pieces.push(`${meta.unwritten} unwritten`)
  return { line: pieces.join(' · '), words: meta.words }
}

/** Only complete, well-formed expansion lists replace stored state. */
function expandedPaths(raw: unknown): string[] | undefined {
  return Array.isArray(raw) && raw.every(path => typeof path === 'string') ? [...new Set(raw)] : undefined
}

function validTitleWidth(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 140 && value <= 1800 }

/** Stable row identity; indistinguishable unwritten titles alone need a positional fallback. */
export function roomPartRenderKey(part: RoomPart, parts: readonly RoomPart[]): string {
  const duplicate = part.key.path === null && parts.some(other => other !== part && other.key.path === null && other.key.title === part.key.title)
  return JSON.stringify([part.key.title, part.key.path, duplicate ? part.index : null])
}
