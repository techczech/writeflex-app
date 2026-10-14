/**
 * Prose-aware sentence segmentation (Round A, Task 1) — the pure, dependency-free module the focus
 * modes decorate from (Highlight sentence, Segment focus, Sentence breakup) and read-aloud will
 * reuse later. Nothing here touches a document: text in, absolute offsets out.
 */

/** One sentence's absolute character range: `from` inclusive, `to` exclusive. */
export type SentenceRange = { from: number; to: number }

/** Sentence terminators. A run of them (e.g. `?!`, `...`) counts as one potential boundary. */
const TERMINATORS = new Set(['.', '!', '?', '…'])

/** Closing quotes/brackets that stay WITH the sentence when they follow its terminator. */
const CLOSERS = new Set(['”', '’', '"', "'", ')', ']'])

/**
 * Tokens whose trailing full stop is an abbreviation dot, not a sentence end. Compared lowercase,
 * with any INNER dots kept ("e.g", "i.e") — the token is what sits immediately before the
 * terminator run. Single capital initials ("J." in "J. Smith") are handled separately.
 */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'cf', 'vs', 'viz', 'ca', 'al', 'et al',
  'dr', 'prof', 'mr', 'mrs', 'ms', 'st', 'rev', 'jr', 'sr',
  'fig', 'no', 'vol', 'ch', 'p', 'pp', 'ed', 'eds',
])

/** True for any whitespace character (space, tab, newline …). */
const isSpace = (ch: string): boolean => /\s/.test(ch)

/** What may open the NEXT sentence after the gap: a capital, a digit, or an opening quote/bracket. */
const isSentenceOpener = (ch: string): boolean => /[\p{Lu}\p{N}“‘"'(\[]/u.test(ch)

/** The word token immediately before position `pos` (letters and inner dots), or ''. */
function tokenBefore(text: string, pos: number): string {
  let start = pos
  while (start > 0 && /[\p{L}.]/u.test(text[start - 1])) start--
  return text.slice(start, pos).replace(/^\.+/, '')
}

/**
 * Split `text` into sentences, returning absolute offsets (shifted by `from`, default 0). A
 * terminator run ends a sentence only when what follows reads as a new sentence (whitespace then a
 * capital/digit/opening quote, or the end of the text) AND what precedes is not an abbreviation, a
 * single capital initial, or a decimal number. Closing quotes/brackets after the terminator stay
 * inside the sentence. A terminator-less tail still counts as a sentence.
 */
export function segmentSentences(text: string, from = 0): SentenceRange[] {
  const sentences: SentenceRange[] = []
  const len = text.length
  let start = 0
  // Skip leading whitespace to the first sentence's real start.
  while (start < len && isSpace(text[start])) start++

  let i = start
  while (i < len) {
    if (!TERMINATORS.has(text[i])) {
      i++
      continue
    }
    // The full terminator run (handles "..." and "?!").
    let runEnd = i + 1
    while (runEnd < len && TERMINATORS.has(text[runEnd])) runEnd++
    // Closing quotes/brackets belong to this sentence.
    let end = runEnd
    while (end < len && CLOSERS.has(text[end])) end++

    const atEOL = end >= len
    // A boundary needs a gap and a sentence-opening character after it (or the end of the text).
    let next = end
    while (next < len && isSpace(text[next])) next++
    const gapped = next > end
    const opensNext = next < len && isSentenceOpener(text[next])

    const token = tokenBefore(text, i)
    const isAbbreviation = ABBREVIATIONS.has(token.toLowerCase())
    const isInitial = token.length === 1 && /\p{Lu}/u.test(token)
    // "3.5": the dot is flanked by digits with no gap — the gap requirement already rejects it, but
    // keep the check explicit for runs like "3.5." where only the FIRST dot is decimal.
    const isDecimal = i > 0 && /\d/.test(text[i - 1]) && runEnd < len && /\d/.test(text[runEnd])

    if ((atEOL || (gapped && opensNext)) && !isAbbreviation && !isInitial && !isDecimal) {
      if (end > start) sentences.push({ from: start + from, to: end + from })
      start = next
      i = next
    } else {
      i = end > i ? end : i + 1
    }
  }

  // A trailing fragment with no terminator is still a sentence (trimmed of trailing whitespace).
  if (start < len) {
    let tail = len
    while (tail > start && isSpace(text[tail - 1])) tail--
    if (tail > start) sentences.push({ from: start + from, to: tail + from })
  }
  return sentences
}

/**
 * The Anchored Reading lead-in ramp (bionic): how many characters of `word` carry the emphasis.
 * Measured on the word's LETTERS only (punctuation stripped); short words anchor on one character,
 * long words on ~35% of their length. Always at least 1 so every token has a handhold.
 */
export function leadLength(word: string): number {
  const letters = word.replace(/[^\p{L}]/gu, '').length
  if (letters <= 3) return 1
  if (letters <= 6) return 2
  if (letters <= 9) return 3
  return Math.ceil(letters * 0.35)
}
