/**
 * List a piece's sources (scraps ticket 04): the frontmatter `sources:` list merged with the sources
 * its text cites. Two kinds of citation count:
 *
 *  - wikilinks to research notes, always (a link is certain);
 *  - author–year citations ("Hall 1976", "(Bartlett, 1932)", "Schank & Abelson (1977)"), matched to a
 *    research note ONLY when that note's frontmatter carries an author and a year. A citation more than
 *    one note fits is reported as ambiguous and counted for none. When no note carries both, only
 *    links count and the listing says author–year matching was unavailable.
 *
 * `matchAuthorYear` and `listPieceSources` are pure; `readPieceSources` reads the piece and the
 * collection and is what the verb and the palette command call.
 */

import { posix } from 'node:path'
import { collectionPieces, collectionStatus } from './collection'
import { materialFactOf, pieceSourceBreakdown, isResearchNotePath, type LinkedSource } from './piece-material'
import type { DrawerSource } from './piece-material'
import { assertRelativeWorkspacePath, type Workspace } from './workspace'
import { frontmatterBlock } from '../shared/markdown/frontmatter'
import { stripFencedRegions } from '../shared/markdown/fences'
import type { AmbiguousCitation, AuthorYearAvailability, PieceSourceListing, SourceListEntry } from '../shared/piece-sources'

/** A research note and the metadata author–year matching reads. */
export type CitationNote = { path: string; title: string; authors: string[]; year: string | null }

/** `Name`, `Name & Name`, `Name and Name`, `Name et al.`, then a year with an optional letter, bare,
 *  after a comma, or in parentheses. A surname starts a word and is at most 40 letters long, so the
 *  scan stays linear on a long run of capitals: no match starts mid-word, and none tries more than 40
 *  lengths of a name. */
const SURNAME = String.raw`(?<![\p{L}'’\-])\p{Lu}[\p{L}'’\-]{0,39}`
const CITATION = new RegExp(
  String.raw`(${SURNAME})(?:\s+(?:&|and)\s+(${SURNAME})|\s+et\s+al\.?)?(?:\s*,\s*|\s+)\(?((?:1[5-9]|20)\d{2})([a-z]?)(?![\p{L}\d])`,
  'gu',
)

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[’']/g, '').trim()
}

/** The surnames in an `author:` value: a string or a list; "Hall, Edward T.", "Edward T. Hall",
 *  "Schank & Abelson" and "A; B" are all read. */
export function surnamesOf(value: unknown): string[] {
  const parts = Array.isArray(value) ? value.map(String) : typeof value === 'string' ? [value] : []
  const names: string[] = []
  for (const part of parts) {
    for (const person of part.split(/\s*(?:;|&|\band\b)\s*/i)) {
      const cleaned = person.replace(/\bet\s+al\.?/i, '').trim()
      if (!cleaned) continue
      const surname = cleaned.includes(',') ? cleaned.split(',', 1)[0] : cleaned.split(/\s+/).at(-1)!
      const folded = fold(surname.replace(/[.]+$/, ''))
      if (folded) names.push(folded)
    }
  }
  return names
}

/** The four-digit year of a `year:` (or `published:`) value, or null. */
export function yearOf(value: unknown): string | null {
  // A YAML date (`published: 1976-01-01`) arrives as a Date at UTC midnight; local time could say 1975.
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : yearOf(String(value.getUTCFullYear()))
  return /\b(1[5-9]\d{2}|20\d{2})\b/.exec(String(value ?? ''))?.[1] ?? null
}

/** The citation facts of a research note from its frontmatter. */
export function citationNoteOf(piece: { path: string; metadata: { title: string }; frontmatter: { author?: string; extra: Record<string, unknown> } | null }): CitationNote {
  const extra = piece.frontmatter?.extra ?? {}
  return {
    path: piece.path,
    title: piece.metadata.title,
    authors: surnamesOf(piece.frontmatter?.author ?? extra.authors ?? extra.author),
    year: yearOf(extra.year ?? extra.published),
  }
}

export type AuthorYearMatches = {
  /** Matched research notes with their citation counts, in order of first citation. */
  matched: Array<{ path: string; title: string; count: number }>
  ambiguous: AmbiguousCitation[]
  availability: AuthorYearAvailability
}

function availabilityOf(notes: CitationNote[]): AuthorYearAvailability {
  const usable = notes.filter((note) => note.authors.length > 0 && note.year !== null).length
  let message: string | null = null
  if (notes.length > 0 && usable === 0) {
    message = 'Author–year matching was unavailable: no research note has an author and a year in its frontmatter, so only links to research notes were counted.'
  } else if (usable < notes.length) {
    message = `Author–year matching used ${usable} of ${notes.length} research notes; the others have no author or no year in their frontmatter.`
  }
  return { notesWithMetadata: usable, notesTotal: notes.length, available: usable > 0, message }
}

/** Prose to scan: wikilinks blanked (so "[[Hall 1976 notes]]" is not also a citation), fenced code dropped. */
function scanText(text: string): string {
  return stripFencedRegions(text).replace(/\[\[[^\]\n]*\]\]/g, (link) => ' '.repeat(link.length))
}

/**
 * Match the author–year citations in `text` to research notes by their frontmatter. A citation fits a
 * note when its first surname is one of the note's authors and its year is the note's year; when
 * several notes fit and the citation names a second author, the notes that list that author win. Still
 * more than one: ambiguous, shown and not counted. A note by the same author with no year could be the
 * one cited, so it joins the candidates of a citation that fits a dated note, which then is ambiguous.
 */
export function matchAuthorYear(text: string, notes: CitationNote[]): AuthorYearMatches {
  const availability = availabilityOf(notes)
  const usable = notes.filter((note) => note.authors.length > 0 && note.year !== null)
  const undated = notes.filter((note) => note.authors.length > 0 && note.year === null)
  const matched = new Map<string, { path: string; title: string; count: number }>()
  const ambiguous = new Map<string, AmbiguousCitation>()
  if (usable.length === 0) return { matched: [], ambiguous: [], availability }
  for (const match of scanText(text).matchAll(CITATION)) {
    const [whole, first, second, year, suffix] = match
    const dated = usable.filter((note) => note.year === year && note.authors.includes(fold(first)))
    if (dated.length === 0) continue
    let fits = [...dated, ...undated.filter((note) => note.authors.includes(fold(first)))]
    if (fits.length > 1 && second) {
      const both = fits.filter((note) => note.authors.includes(fold(second)))
      if (both.length > 0) fits = both
    }
    if (fits.length === 1) {
      const note = fits[0]
      const known = matched.get(note.path)
      if (known) known.count += 1
      else matched.set(note.path, { path: note.path, title: note.title, count: 1 })
    } else if (fits.length > 1) {
      const label = whole.replace(/\s+/g, ' ').replace(/\s*\($/, '').replace(/[,\s]+$/, '').trim()
      const key = `${fold(first)}|${second ? fold(second) : ''}|${year}${suffix}`
      const known = ambiguous.get(key)
      if (known) known.count += 1
      else ambiguous.set(key, { text: label, count: 1, candidates: fits.map((note) => ({ path: note.path, title: note.title })) })
    }
  }
  return { matched: [...matched.values()], ambiguous: [...ambiguous.values()], availability }
}

/** The pure merge: the `sources:` list, the research notes the text links to, and the author–year matches. */
export function listPieceSources(input: {
  piece: string
  pieceTitle: string
  dir: string
  text: string
  listed: DrawerSource[]
  linked: LinkedSource[]
  notes: CitationNote[]
}): PieceSourceListing {
  const authorYear = matchAuthorYear(input.text, input.notes)
  const links = new Map(input.linked.map((link) => [link.path, link.count]))
  const years = new Map(authorYear.matched.map((hit) => [hit.path, hit.count]))
  const entries: SourceListEntry[] = []
  const placed = new Set<string>()
  for (const source of input.listed) {
    const linkCount = source.path ? links.get(source.path) ?? 0 : 0
    const yearCount = source.path ? years.get(source.path) ?? 0 : 0
    if (source.path) placed.add(source.path)
    entries.push({
      title: source.title, path: source.path, links: linkCount, authorYear: yearCount,
      cited: linkCount + yearCount, status: linkCount + yearCount > 0 ? 'both' : 'listed',
    })
  }
  const titles = new Map(input.notes.map((note) => [note.path, note.title]))
  const citedOnly = [
    ...input.linked.map((link) => ({ path: link.path, title: link.title })),
    ...authorYear.matched.map((hit) => ({ path: hit.path, title: hit.title })),
  ]
  for (const hit of citedOnly) {
    if (placed.has(hit.path)) continue
    placed.add(hit.path)
    const linkCount = links.get(hit.path) ?? 0
    const yearCount = years.get(hit.path) ?? 0
    entries.push({
      title: titles.get(hit.path) ?? hit.title, path: hit.path, links: linkCount, authorYear: yearCount,
      cited: linkCount + yearCount, status: 'cited',
    })
  }
  return {
    piece: input.piece, pieceTitle: input.pieceTitle, dir: input.dir, entries,
    ambiguous: authorYear.ambiguous, authorYearMatching: authorYear.availability,
  }
}

/** The Collection a piece belongs to: the nearest ancestor folder that is one, else its own folder. */
export async function pieceCollectionDir(ws: Workspace, piecePath: string): Promise<string> {
  const start = posix.dirname(piecePath) === '.' ? '' : posix.dirname(piecePath)
  let cursor = start
  for (;;) {
    if ((await collectionStatus(ws, cursor)).collection) return cursor
    if (cursor === '') return start
    const parent = posix.dirname(cursor)
    if (parent === cursor) return start // `/`: an absolute path has no workspace parent left to try
    cursor = parent === '.' ? '' : parent
  }
}

/** Why a listing was refused; the text is shown as it stands. */
export class PieceSourcesRefusal extends Error {}

/** A single room read shares collection projections and citation metadata across all parts. */
export function pieceSourcesContext(ws: Workspace, dir: string) {
  let pending: Promise<Awaited<ReturnType<typeof collectionPieces>>> | undefined
  return { pieces: () => pending ??= collectionPieces(ws, dir) }
}
export type PieceSourcesContext = ReturnType<typeof pieceSourcesContext>

/** Metadata dates cannot be citations; explicit sources still require reconstruction. */
export function needsPieceSources(content: string): boolean {
  const block = frontmatterBlock(content)
  const body = stripFencedRegions(block ? content.slice(block.end) : content)
  return Boolean(block && /^sources\s*:/m.test(content.slice(0, block.end)))
    || /\[\[/.test(body) || [...scanText(body).matchAll(CITATION)].length > 0
}

/** Read the piece and its collection and list its sources. `dir` is the collection when the caller knows it. */
export async function readPieceSources(ws: Workspace, input: { path: string; dir?: string }, context?: PieceSourcesContext): Promise<PieceSourceListing> {
  try {
    assertRelativeWorkspacePath(input.path)
    if (input.dir) assertRelativeWorkspacePath(input.dir)
  } catch {
    throw new PieceSourcesRefusal('A piece\'s path must be workspace-relative.')
  }
  if (!/\.(?:md|markdown|mdx)$/i.test(input.path)) throw new PieceSourcesRefusal('Only a Markdown piece has sources to list.')
  const dir = (input.dir ?? await pieceCollectionDir(ws, input.path)).replace(/^\/+|\/+$/g, '')
  const content = (await ws.readFile(input.path)).content
  const pieces = await (context?.pieces() ?? collectionPieces(ws, dir))
  const facts = pieces.map(materialFactOf)
  const breakdown = pieceSourceBreakdown(dir, facts, input.path)
  if (!breakdown) throw new PieceSourcesRefusal(`${input.path} is not a piece of this collection.`)
  const fact = facts.find((candidate) => candidate.path === input.path)!
  const notes = pieces.filter((piece) => isResearchNotePath(piece.path, dir)).map(citationNoteOf)
  const block = frontmatterBlock(content)
  return listPieceSources({
    piece: input.path, pieceTitle: fact.title, dir,
    text: block ? content.slice(block.end) : content.replace(/^﻿/, ''),
    listed: breakdown.listed, linked: breakdown.linked, notes,
  })
}

/** The listing as text, for the agent's read verb. */
export function describeListing(listing: PieceSourceListing): string {
  const lines = [`Sources of ${listing.pieceTitle} (${listing.piece}) · ${listing.entries.length}`]
  for (const entry of listing.entries) {
    const how = entry.status === 'listed' ? 'listed' : entry.status === 'both' ? `listed, cited ${entry.cited}×` : `cited ${entry.cited}×, not listed`
    lines.push(`- ${entry.title}${entry.path ? ` (${entry.path})` : ' (no file in the collection)'} — ${how}`)
  }
  for (const item of listing.ambiguous) {
    lines.push(`- Ambiguous citation "${item.text}" (${item.count}×) fits ${item.candidates.map((c) => c.path).join(', ')}; not counted.`)
  }
  if (listing.authorYearMatching.message) lines.push(listing.authorYearMatching.message)
  return lines.join('\n')
}
