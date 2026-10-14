/**
 * What each Piece is made of (journey A of `docs/design/2026-09-27-scraps-and-sources-on-the-board`):
 * its **Scraps** (cut fragments in `scraps/<origin>-SCRAPS.md`, CONTEXT.md) and its **Sources**
 * (reference material: the piece's frontmatter `sources:` list plus the research notes its text
 * wikilinks to). Pure: Collection folder facts in, per-piece material out. It never reads a file —
 * the Collection query hands it facts parsed from bytes it has already read.
 */

import { posix } from 'node:path'
import type { Piece } from './collection'
import { buildWikilinkCandidateIndex, resolveWikilinkTargetFromIndex, type Candidate } from './wikilinks'
import { isScrapsPath, originForScrapsPath } from './scraps'

/** Notes an agent leaves live in `agent-notes/` folders; they are not pieces. */
const AGENT_NOTES_DIR = 'agent-notes'

/** How many scraps, and how many sources, the Board card's drawer lists before "+ n more". */
export const DRAWER_ITEMS_PER_KIND = 2
/** The drawer shows a scrap by its first words: at most this many characters, cut at a word. */
const FIRST_WORDS_CHARS = 40
const RESEARCH_DIR = 'research'
const MARKDOWN_EXTENSION = /\.(?:md|markdown|mdx)$/i

/** A scrap as the drawer lists it. `text` is the full body, so a drag carries what the Scratchpad's does. */
export type DrawerScrap = { id: string; text: string; firstWords: string }
/** A source as the drawer lists it. `path` is null when a listed entry names no file in the Collection. */
export type DrawerSource = { title: string; path: string | null }
export type PieceDrawer = { scraps: DrawerScrap[]; moreScraps: number; sources: DrawerSource[]; moreSources: number }
/** `drawer` is null when the piece has neither scraps nor sources (its card shows no chip). */
export type PieceMaterial = { scrapCount: number; sourceCount: number; drawer: PieceDrawer | null }

/** One Markdown file in the Collection, as far as material is concerned. `scraps` is present only on
 *  a scraps file; `frontmatterSources` is the piece's `sources:` list verbatim. */
export type MaterialFact = {
  path: string
  title: string
  /** The title wikilinks resolve by (a written `title:` first, then the heading), as the editor does. */
  linkTitle: string
  aliases: string[]
  frontmatterSources: string[]
  wikilinks: string[]
  scraps?: Array<{ id: string; text: string; done?: boolean }>
  /** Last-modified time (ms); dates an offcut whose id carries no cut time. */
  mtime?: number
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

/** The material facts of a Piece the Collection query already holds. */
export function materialFactOf(piece: Piece): MaterialFact {
  const extra = piece.frontmatter?.extra ?? {}
  return {
    path: piece.path,
    title: piece.metadata.title,
    linkTitle: piece.frontmatter?.title?.trim() || piece.metadata.title,
    aliases: stringList(extra.aliases ?? extra.alias),
    frontmatterSources: stringList(extra.sources),
    wikilinks: piece.derived.wikilinks,
    ...(piece.derived.scraps ? { scraps: piece.derived.scraps } : {}),
    mtime: piece.derived.mtime,
  }
}

/** A research note: a Markdown file inside a `research/` folder of the Collection (at any depth). */
export function isResearchNotePath(path: string, dir: string): boolean {
  const relative = dir === '' ? path : posix.relative(dir, path)
  return relative.split('/').slice(0, -1).includes(RESEARCH_DIR)
}

/** A scrap's first words for the drawer: whitespace collapsed, a leading Markdown marker dropped,
 *  cut at a word boundary with an ellipsis when longer than the drawer line. */
export function firstWords(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
  if (flat.length <= FIRST_WORDS_CHARS) return flat
  const cut = flat.slice(0, FIRST_WORDS_CHARS + 1)
  const boundary = cut.lastIndexOf(' ')
  return `${(boundary > 0 ? cut.slice(0, boundary) : flat.slice(0, FIRST_WORDS_CHARS)).replace(/[\s,;:.–—-]+$/, '')}…`
}

type Resolver = (from: string, target: string) => string | null

function resolverFor(dir: string, facts: MaterialFact[]): Resolver {
  const known = new Set(facts.map((fact) => fact.path))
  const candidates: Candidate[] = facts.map((fact) => ({
    path: fact.path,
    title: fact.linkTitle,
    basename: posix.basename(fact.path).replace(MARKDOWN_EXTENSION, ''),
    aliases: fact.aliases,
  }))
  const index = buildWikilinkCandidateIndex(candidates)
  const byPath = (from: string, target: string): string | null => {
    const clean = target.replace(/^\.\//, '')
    const bases = [posix.dirname(from) === '.' ? '' : posix.dirname(from), dir, '']
    for (const base of bases) {
      const joined = posix.normalize(base ? posix.join(base, clean) : clean)
      for (const candidate of MARKDOWN_EXTENSION.test(joined) ? [joined] : [`${joined}.md`, joined]) {
        if (known.has(candidate)) return candidate
      }
    }
    return null
  }
  return (from, target) => {
    const cleaned = target.split('|', 1)[0].split('#', 1)[0].trim()
    if (!cleaned) return null
    if (cleaned.includes('/') || MARKDOWN_EXTENSION.test(cleaned)) {
      const found = byPath(from, cleaned)
      if (found) return found
    }
    return resolveWikilinkTargetFromIndex(from, cleaned, index).to
  }
}

/** A `sources:` entry as the drawer names it when it is not a file in this Collection. */
function unresolvedTitle(entry: string): string {
  const inner = /^\[\[([^\]]+)\]\]$/.exec(entry)?.[1] ?? entry
  const target = inner.split('|', 1)[0].split('#', 1)[0].trim()
  return /[/\\]/.test(target) || MARKDOWN_EXTENSION.test(target) ? posix.basename(target.replace(/\\/g, '/')).replace(MARKDOWN_EXTENSION, '') : target
}

/** A `sources:` entry's target: the inside of a `[[wikilink]]`, else the entry as written. */
function entryTarget(entry: string): string {
  return /^\[\[([^\]]+)\]\]$/.exec(entry)?.[1] ?? entry
}

/** One piece's sources: its `sources:` list in order, then the research notes its text wikilinks to,
 *  each counted once (by resolved file, else by the entry's name). */
function pieceSources(dir: string, fact: MaterialFact, resolve: Resolver, titles: Map<string, string>): DrawerSource[] {
  const sources: DrawerSource[] = []
  const seen = new Set<string>()
  const add = (source: DrawerSource): void => {
    const key = source.path ?? `entry:${source.title.toLocaleLowerCase()}`
    if (source.path === fact.path || seen.has(key)) return
    seen.add(key)
    sources.push(source)
  }
  for (const entry of fact.frontmatterSources) {
    const path = resolve(fact.path, entryTarget(entry))
    add(path ? { title: titles.get(path) ?? path, path } : { title: unresolvedTitle(entry), path: null })
  }
  for (const target of fact.wikilinks) {
    const path = resolve(fact.path, target)
    if (path && isResearchNotePath(path, dir)) add({ title: titles.get(path) ?? path, path })
  }
  return sources
}

/**
 * Every Piece's material, keyed by path. Scraps belong to the piece their scraps file names as its
 * origin. Sources are the frontmatter `sources:` list in its order, then research notes the text
 * wikilinks to in text order, each counted once (by resolved file, else by the entry's name).
 */
export function collectionMaterial(dir: string, facts: MaterialFact[]): Map<string, PieceMaterial> {
  const resolve = resolverFor(dir, facts)
  const titles = new Map(facts.map((fact) => [fact.path, fact.title]))
  const scrapsByOrigin = new Map<string, Array<{ id: string; text: string }>>()
  for (const fact of facts) {
    if (!fact.scraps?.length) continue
    const origin = originForScrapsPath(fact.path)
    scrapsByOrigin.set(origin, [...(scrapsByOrigin.get(origin) ?? []), ...fact.scraps])
  }

  const material = new Map<string, PieceMaterial>()
  for (const fact of facts) {
    const scraps = scrapsByOrigin.get(fact.path) ?? []
    const sources = pieceSources(dir, fact, resolve, titles)
    const drawer: PieceDrawer | null = scraps.length === 0 && sources.length === 0 ? null : {
      scraps: scraps.slice(0, DRAWER_ITEMS_PER_KIND).map((scrap) => ({ id: scrap.id, text: scrap.text, firstWords: firstWords(scrap.text) })),
      moreScraps: Math.max(0, scraps.length - DRAWER_ITEMS_PER_KIND),
      sources: sources.slice(0, DRAWER_ITEMS_PER_KIND),
      moreSources: Math.max(0, sources.length - DRAWER_ITEMS_PER_KIND),
    }
    material.set(fact.path, { scrapCount: scraps.length, sourceCount: sources.length, drawer })
  }
  return material
}

/**
 * An offcut as the Board's Offcuts column lists it (locked design frame 1): one Scrap in the
 * Collection, with the piece it was cut from and the day it was cut. `scrapsPath` is the scraps file
 * that holds it; `suggestedName` prefills the name field when it becomes an idea (frame 2).
 */
export type Offcut = {
  id: string
  text: string
  firstWords: string
  suggestedName: string
  done: boolean
  scrapsPath: string
  origin: string
  originTitle: string
  /** `YYYY-MM-DD`, or null when neither the id nor the file gives a date. */
  cutOn: string | null
}

/** How many words the idea name is prefilled with. */
const NAME_WORDS = 6
/** Store ids are `s_<Date.now() base36><counter><3 random>`; the time is the first 8 base-36 digits. */
const STORE_ID_TIME = /^s_([0-9a-z]{8})/
const EARLIEST_CUT = Date.UTC(2020, 0, 1)

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The day a scrap was cut. A store-made id carries its creation time; a hand-written id does not,
 * so it falls back to the scraps file's last change, and to null without either.
 */
export function scrapCutOn(id: string, fileMtime?: number, now = Date.now()): string | null {
  const stamp = STORE_ID_TIME.exec(id)?.[1]
  if (stamp) {
    const ms = Number.parseInt(stamp, 36)
    if (ms >= EARLIEST_CUT && ms <= now + 86_400_000) return isoDay(ms)
  }
  return fileMtime !== undefined && Number.isFinite(fileMtime) && fileMtime > 0 ? isoDay(fileMtime) : null
}

/** The idea name a scrap suggests: its first few words, capitalised, without trailing punctuation. */
export function ideaNameFrom(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
  const words = flat.split(' ').slice(0, NAME_WORDS).join(' ').replace(/[\s,;:.!?–—…-]+$/, '')
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : ''
}

/**
 * Every Scrap in the Collection, keyed by the scraps file that holds it, in file order. The origin's
 * title comes from its Piece; a scraps file whose origin is not in the Collection names it by file.
 */
export function collectionOffcuts(facts: MaterialFact[], now = Date.now()): Map<string, Offcut[]> {
  const titles = new Map(facts.map((fact) => [fact.path, fact.title]))
  const offcuts = new Map<string, Offcut[]>()
  for (const fact of facts) {
    if (!fact.scraps?.length) continue
    const origin = originForScrapsPath(fact.path)
    const originTitle = titles.get(origin) ?? posix.basename(origin).replace(MARKDOWN_EXTENSION, '')
    offcuts.set(fact.path, fact.scraps.map((scrap) => ({
      id: scrap.id,
      text: scrap.text,
      firstWords: firstWords(scrap.text),
      suggestedName: ideaNameFrom(scrap.text),
      done: scrap.done === true,
      scrapsPath: fact.path,
      origin,
      originTitle,
      cutOn: scrapCutOn(scrap.id, fact.mtime, now),
    })))
  }
  return offcuts
}

/** A piece as the Sources rail names it under a source that uses it. */
export type SourceUser = { path: string; title: string }

/** Whether a file is a piece rather than a piece's material or an agent's note: only pieces "use" a source. */
function isPieceFact(dir: string, path: string): boolean {
  return !isScrapsPath(path) && !isResearchNotePath(path, dir) && !path.split('/').includes(AGENT_NOTES_DIR)
}

/**
 * Which pieces use each research note (the Sources rail, locked design frame 1), keyed by the note's
 * path: every research note in the Collection is a key, and an unused one maps to an empty list. A
 * piece uses a note when its `sources:` list names it or its text wikilinks to it — the same sources
 * its card counts. Users are in path order.
 */
export function collectionSourceUse(dir: string, facts: MaterialFact[]): Map<string, SourceUser[]> {
  const resolve = resolverFor(dir, facts)
  const titles = new Map(facts.map((fact) => [fact.path, fact.title]))
  const use = new Map<string, SourceUser[]>()
  for (const fact of facts) if (isResearchNotePath(fact.path, dir)) use.set(fact.path, [])
  for (const fact of [...facts].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isPieceFact(dir, fact.path)) continue
    for (const source of pieceSources(dir, fact, resolve, titles)) {
      if (source.path) use.get(source.path)?.push({ path: fact.path, title: fact.title })
    }
  }
  return use
}

/**
 * The `sources:` entry of a piece that already names `sourcePath`, or null when none does. Entries
 * resolve as the card's count resolves them (a path, a `[[wikilink]]`, a title), so a source listed in
 * any of those forms counts as listed. Only the list counts: a note the text merely links to is not.
 */
export function listedSourceEntry(dir: string, facts: MaterialFact[], piecePath: string, entries: string[], sourcePath: string): string | null {
  const resolve = resolverFor(dir, facts)
  return entries.find((entry) => resolve(piecePath, entryTarget(entry)) === sourcePath) ?? null
}

/** A research note the piece's text wikilinks to, with how many links point at it. */
export type LinkedSource = { title: string; path: string; count: number }

/**
 * One piece's sources split by how the piece names them (ticket 04, "List this piece's sources"):
 * `listed` is its `sources:` list in order (the same entries its card counts); `linked` is each research
 * note its text wikilinks to, in order of first link, with the number of links. Null when the piece is
 * not among the facts. A note can be in both.
 */
export function pieceSourceBreakdown(dir: string, facts: MaterialFact[], piecePath: string): { listed: DrawerSource[]; linked: LinkedSource[] } | null {
  const fact = facts.find((candidate) => candidate.path === piecePath)
  if (!fact) return null
  const resolve = resolverFor(dir, facts)
  const titles = new Map(facts.map((candidate) => [candidate.path, candidate.title]))
  const listed: DrawerSource[] = []
  const seen = new Set<string>()
  for (const entry of fact.frontmatterSources) {
    const path = resolve(fact.path, entryTarget(entry))
    const source: DrawerSource = path ? { title: titles.get(path) ?? path, path } : { title: unresolvedTitle(entry), path: null }
    const key = source.path ?? `entry:${source.title.toLocaleLowerCase()}`
    if (source.path === fact.path || seen.has(key)) continue
    seen.add(key)
    listed.push(source)
  }
  const counts = new Map<string, LinkedSource>()
  for (const target of fact.wikilinks) {
    const path = resolve(fact.path, target)
    if (!path || path === fact.path || !isResearchNotePath(path, dir)) continue
    const known = counts.get(path)
    if (known) known.count += 1
    else counts.set(path, { title: titles.get(path) ?? path, path, count: 1 })
  }
  return { listed, linked: [...counts.values()] }
}
