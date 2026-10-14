/**
 * The workspace search query: parse it, match it against a whole piece, rank the pieces, and cut
 * the snippet a result row shows. Pure functions over strings — Workspace.search supplies the
 * listing and the cached content (search-index.ts) and assembles the result.
 *
 * Plain words match on the PIECE: a file matches when every word appears somewhere in it, in any
 * order and on any lines (decision of 2026-09-18, docs/design/2026-09-18-working-in-a-large-archive).
 * A quoted phrase must appear on one line. `-word` filters lines, `/regex/` is one pattern, `tag:x`
 * filters files by frontmatter tag, `OR` accepts any positive term.
 */

import { documentTitle } from './frontmatter'

/** The location of a hit within one line: 1-based column, char length (0 for a zero-width regex). */
export type LineHit = { column: number; length: number }

/** A piece's match: the best line (0-based `index`), its primary hit (earliest term on that line,
 *  which the editor selects), every term span on that line, and the counts ranking uses. */
export type PieceHit = {
  index: number
  hit: LineHit
  marks: LineHit[]
  /** Distinct terms on the best line. */
  distinct: number
  /** Term occurrences across the whole piece (surviving lines only). */
  hits: number
}

/**
 * A compiled query.
 *   `matchPiece` — piece semantics: every positive term somewhere in the file's lines (any term in
 *                  OR mode); a line holding a negative term does not count. Null when the file fails.
 *   `matchLine`  — same-line semantics: the whole query holds on this one line (the pre-2026-09
 *                  behaviour; a quoted phrase is always same-line).
 *   `matchName`  — ranking rule 1: the file's name or its title contains every term.
 *   `matchTags`  — the frontmatter-tag filter. `usesLines`/`usesTags` tell search which passes run;
 *   `hasTerms`   — false for a tag-driven query with no positive term (nothing to mark or rank on).
 */
export type Matcher = {
  note?: 'literal'
  usesLines: boolean
  usesTags: boolean
  hasTerms: boolean
  tagTerms: string[]
  matchTags(tags: string[]): boolean
  matchLine(line: string): LineHit | null
  matchPiece(lines: readonly string[]): PieceHit | null
  matchName(name: string, title: string): boolean
}

/** One positive or negative term: every non-overlapping span of it on a line. */
type Term = { spans(line: string, lower: string): LineHit[] }

/** Upper bound on spans collected per term per line, so a pathological regex cannot stall a search. */
const MAX_SPANS_PER_LINE = 200

function wordTerm(word: string): Term {
  const needle = word.toLowerCase()
  return {
    spans: (_line, lower) => {
      const out: LineHit[] = []
      let from = 0
      while (out.length < MAX_SPANS_PER_LINE) {
        const idx = lower.indexOf(needle, from)
        if (idx === -1) break
        out.push({ column: idx + 1, length: needle.length })
        from = idx + Math.max(1, needle.length)
      }
      return out
    },
  }
}

function regexTerm(re: RegExp): Term {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  return {
    spans: (line) => {
      const out: LineHit[] = []
      global.lastIndex = 0
      while (out.length < MAX_SPANS_PER_LINE) {
        const m = global.exec(line)
        if (!m) break
        out.push({ column: m.index + 1, length: m[0].length })
        if (m[0].length === 0) global.lastIndex += 1 // zero-width: step on or loop forever
      }
      return out
    },
  }
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A quoted phrase: its words in order, any run of whitespace between them, on one line. */
function phraseTerm(phrase: string): Term {
  const words = phrase.trim().split(/\s+/)
  return regexTerm(new RegExp(words.map(escapeRegex).join('\\s+'), 'i'))
}

/** Split a query into tokens, keeping `"a quoted phrase"` (and `-"…"`) as one token. An unclosed
 *  quote runs to the end of the query. */
function tokenize(q: string): string[] {
  return q.match(/-?"[^"]*"?|\S+/g) ?? []
}

function isPhrase(token: string): boolean {
  return token.startsWith('"') || token.startsWith('-"')
}

function unquote(token: string): string {
  return token.replace(/^-?"/, '').replace(/"$/, '')
}

/** Earliest span across terms, first term winning a tie (the pre-2026-09 andHit/orHit rule). */
function earliest(firsts: Array<LineHit | undefined>): LineHit | null {
  let best: LineHit | null = null
  for (const hit of firsts) if (hit && (best === null || hit.column < best.column)) best = hit
  return best
}

/** Sort spans and merge any that overlap, so a snippet never nests `<mark>`s. */
function mergeSpans(spans: LineHit[]): LineHit[] {
  const sorted = [...spans].sort((a, b) => a.column - b.column || b.length - a.length)
  const out: LineHit[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    if (last && span.column <= last.column + last.length) {
      const end = Math.max(last.column + last.length, span.column + span.length)
      last.length = end - last.column
    } else {
      out.push({ ...span })
    }
  }
  return out
}

/** Normalise a file name for rule 1: drop the extension, read `-`, `_` and `.` as spaces. */
function nameText(name: string): string {
  return name.replace(/\.(md|markdown|mdx)$/i, '').replace(/[-_.]+/g, ' ')
}

type Compiled = {
  note?: 'literal'
  positives: Term[]
  negatives: Term[]
  tags: string[]
  orMode: boolean
  /** A /regex/ query ignores -words, as it always has: the whole query is the pattern. */
  regex: boolean
}

function compile(q: string): Compiled {
  const rx = /^\/(.+)\/$/.exec(q)
  if (rx) {
    const pattern = rx[1]
    try {
      return { positives: [regexTerm(new RegExp(pattern, 'i'))], negatives: [], tags: [], orMode: false, regex: true }
    } catch {
      // Invalid regex: search for the inner text literally so the query still does something useful.
      return { note: 'literal', positives: [wordTerm(pattern)], negatives: [], tags: [], orMode: false, regex: true }
    }
  }

  const tokens = tokenize(q)
  const positives: Term[] = []
  const negatives: Term[] = []
  const tags: string[] = []
  for (const tok of tokens) {
    if (tok === 'AND' || tok === 'OR') continue
    if (isPhrase(tok)) {
      const phrase = unquote(tok)
      if (!phrase.trim()) continue
      ;(tok.startsWith('-') ? negatives : positives).push(phraseTerm(phrase))
    } else if (tok.toLowerCase().startsWith('tag:')) {
      const value = tok.slice(4)
      if (value) tags.push(value)
    } else if (tok.startsWith('-') && tok.length > 1) {
      negatives.push(wordTerm(tok.slice(1)))
    } else {
      positives.push(wordTerm(tok))
    }
  }
  return { positives, negatives, tags, orMode: tokens.includes('OR'), regex: false }
}

/**
 * Compile a search query into a Matcher (PRD S20). Forms:
 *   `a b` / `a AND b` → every term somewhere in the piece (default AND); `a OR b` → any term.
 *   `"a b"`      → the phrase, on one line (whitespace between the words may vary).
 *   `/pattern/`  → case-insensitive RegExp (invalid → literal fallback of the inner text, note:'literal').
 *   `tag:x`      → frontmatter-tags filter (see extractFrontmatterTags; combines with line terms).
 *   `-a` / `-"a b"` → NOT: a line FILTER in every mode — a line containing it neither matches nor
 *                  counts toward the piece. Bare `-a` alone is a no-op; with a `tag:` it lists the
 *                  tagged files that keep at least one line without it.
 */
export function parseQuery(raw: string): Matcher {
  const q = raw.trim()
  const inert: Matcher = {
    usesLines: false, usesTags: false, hasTerms: false, tagTerms: [],
    matchTags: () => true, matchLine: () => null, matchPiece: () => null, matchName: () => false,
  }
  if (!q) return inert

  const { note, positives, negatives, tags, orMode, regex } = compile(q)
  const usesTags = tags.length > 0
  // Run the line pass when there are positive terms, OR when negatives are gated by a tag: the tag:
  // bounds the file set, so reading its lines minus the negative ones is safe. A BARE all-negative
  // query (`-foo` with no positives and no tag:) runs NEITHER pass — it would otherwise match every
  // file that lacks `foo` across the whole workspace, a useless dump — so it is a documented no-op.
  const usesLines = positives.length > 0 || (negatives.length > 0 && usesTags)
  const hasTerms = positives.length > 0

  /** Per-term spans on a line, or null when a negative term excludes the line. */
  const scan = (line: string): LineHit[][] | null => {
    const lower = line.toLowerCase()
    if (!regex) for (const n of negatives) if (n.spans(line, lower).length > 0) return null
    return positives.map((term) => term.spans(line, lower))
  }
  const satisfied = (present: number): boolean => (orMode ? present > 0 : present === positives.length)

  return {
    ...(note ? { note } : {}),
    usesLines,
    usesTags,
    hasTerms,
    tagTerms: tags,
    matchTags: (fileTags) => {
      if (!usesTags) return true
      const lower = fileTags.map((t) => t.toLowerCase())
      return tags.every((t) => lower.includes(t.toLowerCase()))
    },
    matchLine: (line) => {
      if (!usesLines) return null
      const perTerm = scan(line)
      if (!perTerm) return null
      // A tag-gated negative filter (e.g. `tag:draft -river`): every surviving line is a hit with
      // nothing to mark (column 1, length 0). Only reachable when usesTags (per usesLines above).
      if (!hasTerms) return { column: 1, length: 0 }
      const present = perTerm.filter((spans) => spans.length > 0).length
      if (!satisfied(present)) return null
      return earliest(perTerm.map((spans) => spans[0]))
    },
    matchPiece: (lines) => {
      if (!usesLines) return null
      const seen = new Set<number>()
      let hits = 0
      let best: PieceHit | null = null
      let bestOnLine = 0
      for (let i = 0; i < lines.length; i += 1) {
        const perTerm = scan(lines[i])
        if (!perTerm) continue
        if (!hasTerms) {
          hits += 1
          best ??= { index: i, hit: { column: 1, length: 0 }, marks: [], distinct: 0, hits: 0 }
          continue
        }
        let distinct = 0
        let onLine = 0
        perTerm.forEach((spans, t) => {
          if (spans.length === 0) return
          distinct += 1
          onLine += spans.length
          seen.add(t)
        })
        if (distinct === 0) continue
        hits += onLine
        // Best line: most distinct terms, then most hits on it, then the earliest.
        if (!best || distinct > best.distinct || (distinct === best.distinct && onLine > bestOnLine)) {
          const hit = earliest(perTerm.map((spans) => spans[0]))
          if (!hit) continue
          best = { index: i, hit, marks: mergeSpans(perTerm.flat()), distinct, hits: 0 }
          bestOnLine = onLine
        }
      }
      if (!best) return null
      if (hasTerms && !satisfied(seen.size)) return null
      return { ...best, hits }
    },
    matchName: (name, title) => {
      if (!hasTerms) return false
      const holdsEvery = (text: string): boolean => {
        if (!text) return false
        const lower = text.toLowerCase()
        return positives.every((term) => term.spans(text, lower).length > 0)
      }
      return holdsEvery(nameText(name)) || holdsEvery(title)
    },
  }
}

/** How many heading-shaped lines pieceTitle tries before parsing the whole document. */
const TITLE_PREFIX_TRIES = 8

/**
 * What the piece is called, for ranking rule 1 — the same answer as documentTitle (its first
 * heading, else the file name), without parsing the whole document. documentTitle parses every block,
 * which cost ~0.7 ms per piece: 1.7 s the first time a common word matched 2,500 pieces. A heading
 * can only end on a heading-shaped line (`# …`, or a setext `===`/`---` underline), so this parses
 * the prefix that ends at each such line in turn and stops at the first that yields a heading. A
 * piece with no heading-shaped line has no heading, so it costs no parse at all.
 */
export function pieceTitle(content: string, path: string): string {
  const stem = (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')
  const candidate = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|=+[ \t]*$|-+[ \t]*$)/gm
  for (let tries = 0; tries < TITLE_PREFIX_TRIES; tries += 1) {
    const m = candidate.exec(content)
    if (!m) return stem
    const end = content.indexOf('\n', m.index)
    const title = documentTitle(end === -1 ? content : content.slice(0, end), path)
    if (title !== stem) return title
  }
  return documentTitle(content, path)
}

/** What ranking reads from each matched piece. */
export type RankKey = { nameMatch: boolean; distinct: number; hits: number; modifiedAt: number }

/**
 * Ranking, in order: (1) the name or title contains every term; (2) more distinct terms on one
 * line, then more total hits; (3) the most recently modified. Returns 0 on a full tie, so a stable
 * sort keeps the listing order.
 */
export function comparePieces(a: RankKey, b: RankKey): number {
  if (a.nameMatch !== b.nameMatch) return a.nameMatch ? -1 : 1
  if (a.distinct !== b.distinct) return b.distinct - a.distinct
  if (a.hits !== b.hits) return b.hits - a.hits
  return b.modifiedAt - a.modifiedAt
}

/** The text a result row shows for its best line, with every term span marked (1-based columns
 *  into `text`). A long line is cut to a window around the marks, with `…` where it was cut. */
export type Snippet = { text: string; marks: LineHit[] }

export const SNIPPET_WIDTH = 140
const SNIPPET_LEAD = 36

export function snippetOf(line: string, marks: readonly LineHit[], width = SNIPPET_WIDTH): Snippet {
  if (line.length <= width) return { text: line, marks: marks.map((m) => ({ ...m })) }
  const first = marks.length > 0 ? marks[0].column - 1 : 0
  let start = Math.max(0, Math.min(first - SNIPPET_LEAD, line.length - width))
  // Start on a word: step past the partial word the window cut into, never past the first mark.
  if (start > 0) {
    const space = line.slice(start, first).search(/\s/)
    if (space !== -1) start += space + 1
  }
  let end = Math.min(line.length, start + width)
  if (end < line.length) {
    const space = line.slice(start, end).search(/\s\S*$/)
    const lastMarkEnd = marks.reduce((acc, m) => Math.max(acc, m.column - 1 + m.length), 0)
    if (space > 0 && start + space >= Math.min(lastMarkEnd, end)) end = start + space
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < line.length ? '…' : ''
  const shift = prefix.length - start
  const inWindow = marks
    .filter((m) => m.column - 1 >= start && m.column - 1 < end)
    .map((m) => ({ column: m.column + shift, length: Math.min(m.length, end - (m.column - 1)) }))
  return { text: `${prefix}${line.slice(start, end)}${suffix}`, marks: inWindow }
}
