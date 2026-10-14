import { MARKDOWN_FENCE_LINE } from '../../../shared/markdown/fences'

/** Options shared by every counter in this module. */
export type CountOptions = {
  /** Drop lines that read as WriteFlex `// ` comments before counting (PRD S10): the status bar
   *  (Task 12) counts prose the reader will keep, not marginal post-it notes. */
  excludeCommentLines?: boolean
}

/** The seven cycle positions the status-bar count button rotates through (PRD S13). `pages` is a
 *  one-decimal ratio; `readMinutes`/`speakMinutes` are whole minutes; the rest are exact tallies. */
export type UnitCounts = {
  words: number
  characters: number
  sentences: number
  paragraphs: number
  /** words / 250, rounded to one decimal place (a double-spaced manuscript page). */
  pages: number
  /** Minutes to read at 230 wpm, rounded up. */
  readMinutes: number
  /** Minutes to read aloud at 130 wpm, rounded up. */
  speakMinutes: number
}

/** A line that opens or closes a fenced code block: optional indent, then ``` or ~~~ (an opening
 *  fence may carry an info string, e.g. ```` ```js ````). This is a PURE text module — no CodeMirror
 *  imports (it also runs headless) — so fences are tracked by a simple line scanner, mirroring the
 *  fence-aware render decorator (editor/comments.ts) and the jumps scanner: a `//` line INSIDE a
 *  fence is real code, never a WriteFlex comment. */
/** A word: a run of letters or numbers, optionally joined by an apostrophe or hyphen (so "don't" and
 *  "hyphen-joined" each count once). Unicode-aware via \p{L}/\p{N}, so non-Latin scripts count too. */
const WORD_RE = /[\p{L}\p{N}]+(?:['’‑-][\p{L}\p{N}]+)*/gu

type SourceOptions = {
  /** Drop WriteFlex `//` comment lines (outside fences). */
  excludeCommentLines?: boolean
  /** Drop fenced code-block CONTENT as well as its markers (used for sentence splitting: sentence
   *  boundaries are counted "outside code", so a `1. 2.` in code must not read as two sentences). */
  excludeCode?: boolean
}

/**
 * The prose a reader keeps, as one string. Fence-marker lines (```/~~~ and any info string) are
 * always dropped — they are structural Markdown that contributes no prose. With `excludeCommentLines`
 * the `//` post-it lines outside fences go too; with `excludeCode` the fenced code CONTENT goes too.
 * With neither flag the original text is returned untouched, so the plain word count is unchanged.
 */
function proseSource(text: string, options: SourceOptions = {}): string {
  const { excludeCommentLines = false, excludeCode = false } = options
  if (!excludeCommentLines && !excludeCode) return text
  let inFence = false
  const kept: string[] = []
  for (const line of text.split('\n')) {
    if (MARKDOWN_FENCE_LINE.test(line)) {
      inFence = !inFence
      continue // fence markers (and the opening info string) are not prose
    }
    if (inFence) {
      if (!excludeCode) kept.push(line) // inside a fence → real code, kept unless code is excluded
      continue
    }
    if (excludeCommentLines && /^\s*\/\//.test(line)) continue // outside a fence → a WriteFlex comment
    kept.push(line)
  }
  return kept.join('\n')
}

/**
 * Count words in prose, ignoring Markdown punctuation. See {@link WORD_RE}. With `excludeCommentLines`
 * the `//` post-it lines are dropped (fence-aware: a `//` line inside a ``` fence is code, so it stays
 * counted; fence-marker lines contribute no prose and are dropped either way).
 */
export function countWords(text: string, options: CountOptions = {}): number {
  const source = proseSource(text, { excludeCommentLines: options.excludeCommentLines })
  return (source.match(WORD_RE) ?? []).length
}

/** Count sentences in ALREADY-PREPARED prose: split on `[.!?]+\s` (PRD S13). Callers strip fenced code
 *  first ("outside code"), so a period inside code never splits; a trailing full-stopped clause with no
 *  whitespace after it still counts, and a decimal (`3.14`) never splits (no whitespace follows). */
function countSentencesIn(source: string): number {
  const trimmed = source.trim()
  if (!trimmed) return 0
  return trimmed.split(/[.!?]+\s/).filter((segment) => segment.trim().length > 0).length
}

/** Count paragraphs in already-prepared prose: blank-line-separated blocks with a non-space character. */
function countParagraphsIn(source: string): number {
  return source.split(/\n\s*\n/).filter((block) => /\S/.test(block)).length
}

/**
 * Every status-bar unit (PRD S13), derived from the SAME prose the word counter keeps so the seven
 * cycle positions never disagree about what "the document" is. Formatting (thousands separators,
 * singular/plural, the "N min read" phrasing, selection scoping) is the renderer's job — this returns
 * raw numbers so it stays pure and testable headless.
 *
 * The status bar recomputes this on every editor-update tick, so the prose source is built ONCE per
 * variant, not once per unit: `prose` (words / characters / paragraphs keep fenced code) and
 * `proseNoCode` (sentence splitting drops it). The old shape re-scanned the whole document four times.
 */
export function countUnits(text: string, options: CountOptions = {}): UnitCounts {
  const { excludeCommentLines } = options
  const prose = proseSource(text, { excludeCommentLines })
  const proseNoCode = proseSource(text, { excludeCommentLines, excludeCode: true })
  const words = (prose.match(WORD_RE) ?? []).length
  return {
    words,
    characters: prose.length,
    sentences: countSentencesIn(proseNoCode),
    paragraphs: countParagraphsIn(prose),
    pages: Math.round((words / 250) * 10) / 10,
    readMinutes: Math.ceil(words / 230),
    speakMinutes: Math.ceil(words / 130),
  }
}
