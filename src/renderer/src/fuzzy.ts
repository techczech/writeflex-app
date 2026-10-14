const SEGMENT_BOUNDARIES = new Set(['/', '-', '_', '.', ' '])
const COMBINING_MARK = /^\p{M}$/u

/**
 * Fold one UTF-16 code unit without changing its position in the source string. Precomposed letters
 * become the lower-case base of their NFD decomposition only when every remaining code point is a
 * combining mark. Isolated combining marks and surrogate halves stay in place.
 */
function foldCharacter(character: string): string {
  const decomposition = Array.from(character.normalize('NFD'))
  const base = decomposition[0] ?? character
  const canDropRemainder = decomposition.slice(1).every((part) => COMBINING_MARK.test(part))
  const folded = (canDropRemainder ? base : character).toLowerCase()
  return folded.length === character.length ? folded : character
}

function foldForFuzzyMatch(value: string): string {
  let folded = ''
  for (let index = 0; index < value.length; index += 1) folded += foldCharacter(value[index])
  return folded
}

function isSegmentStart(candidate: string, pos: number): boolean {
  return pos === 0 || SEGMENT_BOUNDARIES.has(candidate[pos - 1])
}

/**
 * Case-insensitive subsequence score: null when `query` isn't a subsequence of `candidate`.
 * Each matched character earns +3 when it immediately follows the previous match (a run), else +2
 * when it starts a segment (after /,-,_,.,space, or the string start), else +1. Ties in the caller
 * (fuzzyFilter) go to the shorter candidate.
 *
 * Scored via DP over (query index, candidate position) rather than a leftmost greedy match, so a
 * cheap early match can't block a later, higher-scoring alignment (e.g. a segment-start run).
 */
function subsequenceScore(query: string, candidate: string): number | null {
  if (query.length === 0) return 0
  const q = foldForFuzzyMatch(query)
  const c = foldForFuzzyMatch(candidate)
  const m = q.length
  const n = c.length
  if (m > n) return null

  const NONE = Number.NEGATIVE_INFINITY
  // row[j] = best score matching q[0..i] with q[i] matched at candidate position j.
  let row = new Array<number>(n).fill(NONE)
  for (let j = 0; j < n; j += 1) {
    if (c[j] === q[0]) row[j] = isSegmentStart(candidate, j) ? 2 : 1
  }

  for (let i = 1; i < m; i += 1) {
    const next = new Array<number>(n).fill(NONE)
    let bestNonAdjacent = NONE // max(row[k]) for k <= j - 2
    for (let j = 0; j < n; j += 1) {
      if (j >= 2 && row[j - 2] > bestNonAdjacent) bestNonAdjacent = row[j - 2]
      if (c[j] !== q[i]) continue
      let best = NONE
      if (j >= 1 && row[j - 1] !== NONE) best = row[j - 1] + 3 // consecutive run
      if (bestNonAdjacent !== NONE) {
        const alt = bestNonAdjacent + (isSegmentStart(candidate, j) ? 2 : 1)
        if (alt > best) best = alt
      }
      next[j] = best
    }
    row = next
  }

  const result = Math.max(...row)
  return result === NONE ? null : result
}

/** The query's tokens: split on whitespace, with `-` and `_` read as spaces so `prop-schem` works. */
export function fuzzyTokens(query: string): string[] {
  return query.split(/[\s\-_]+/).filter((token) => token.length > 0)
}

/** +2 when a whole token sits as one run starting at a segment boundary of the candidate. */
const WORD_BOUNDARY_BONUS = 2

function startsSegmentRun(token: string, candidate: string): boolean {
  const folded = foldForFuzzyMatch(candidate)
  let at = folded.indexOf(token)
  while (at !== -1) {
    if (isSegmentStart(candidate, at)) return true
    at = folded.indexOf(token, at + 1)
  }
  return false
}

/**
 * Multi-word, order-free name matching (Requirement: `prop schem` must find
 * `schemas-and-propositions`). The query splits into tokens on whitespace, `-` and `_`; the
 * candidate matches only when EVERY token is a folded subsequence of it, anywhere and in any
 * order. Score = sum of token scores, plus a bonus per token that sits whole at a word boundary.
 * A single-token query scores exactly as the plain subsequence scorer did.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const tokens = fuzzyTokens(query)
  if (tokens.length === 0) return 0
  if (tokens.length === 1) return subsequenceScore(tokens[0], candidate)
  let total = 0
  for (const token of tokens) {
    const score = subsequenceScore(token, candidate)
    if (score === null) return null
    total += score + (startsSegmentRun(foldForFuzzyMatch(token), candidate) ? WORD_BOUNDARY_BONUS : 0)
  }
  return total
}

/**
 * Filters and ranks `paths` against `query`, highest score first, ties broken by the shorter
 * candidate. An empty (or whitespace-only) query short-circuits to input order (the "recent
 * files" list), still capped at `limit`.
 */
export function fuzzyFilter(query: string, paths: string[], limit = 50): string[] {
  if (fuzzyTokens(query).length === 0) return paths.slice(0, limit)

  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const score = fuzzyScore(query, path)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.path.length - b.path.length))
  return scored.slice(0, limit).map((entry) => entry.path)
}
