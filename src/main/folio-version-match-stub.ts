/**
 * The stand-in judge for "which part does this Word section look like?" (Folio versions, ticket 13).
 *
 * judgement-stub: replace with model judgement. Deciding that a renamed, split or merged heading is
 * "the same section" depends on what the section means, so it is a judgement task (skill
 * `judgement-vs-code`). Until a model or the writer supplies those judgements (`MatchOptions.judged`
 * in folio-version-match.ts), this file offers candidates from three mechanical clues and says so in
 * every result (`mechanism: 'judgement-stub'`). The clues only ever make a PROPOSAL for the writer; none
 * is ever treated as a confirmed match. They can miss a real match (a heading rewritten in other words
 * with edited text) and can point at the wrong part (two parts that share a word).
 *
 * The clues, in order of strength:
 *  1. She renamed the heading with tracked changes and the heading she started from is exactly a part's
 *     title (Word recorded the rename; nothing is inferred). Strong.
 *  2. The text she started from is exactly the part's text (after trimming and collapsing spaces), under a
 *     different heading. Strong.
 *  3. The two headings share most of their words (letters and digits, case ignored, a few very common
 *     English words skipped). Likely at three quarters or more, possible at two fifths or more.
 *
 * Pure: no file system, no model, no clock.
 */
import type { WordSection } from './word-reader'

export type ConfidenceWord = 'strong' | 'likely' | 'possible'

export type Clue = { confidence: ConfidenceWord; score: number; reason: string }

/** Exact equality after Unicode normalisation and trimming: the only comparison code is trusted to settle. */
export const headingKey = (text: string | null | undefined): string | null => {
  if (text === null || text === undefined) return null
  const key = text.normalize('NFKC').trim()
  return key === '' ? null : key
}

const SKIPPED = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was', 'were', 'do', 'does', 'did', 'we', 'how', 'what', 'who', 'which'])

const words = (text: string): Set<string> => {
  const found = new Set<string>()
  for (const word of text.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (word !== '' && !SKIPPED.has(word)) found.add(word)
  return found
}

const bodyKey = (text: string | undefined): string | null => {
  if (text === undefined) return null
  const key = text.normalize('NFKC').replace(/\s+/g, ' ').trim()
  // A very short body (or none) proves nothing: two empty bodies are equal.
  return key.length >= 40 ? key : null
}

/** The best clue that `section` is the part titled `title` whose text is `partBody`, or null. */
export function clueFor(section: WordSection, title: string, partBody: string | undefined): Clue | null {
  const titleKey = headingKey(title)
  const sectionKey = headingKey(section.heading)
  const originalKey = headingKey(section.headingOriginal)
  if (titleKey !== null && originalKey === titleKey && sectionKey !== originalKey) {
    return { confidence: 'strong', score: 3, reason: `The heading was renamed in tracked changes; the heading before the rename is “${title.trim()}”.` }
  }
  const wanted = bodyKey(partBody)
  if (wanted !== null && bodyKey(section.originalMarkdown) === wanted) {
    return { confidence: 'strong', score: 2, reason: 'The text before the tracked changes is word for word the text of this part, under a different heading.' }
  }
  if (sectionKey !== null && titleKey !== null) {
    const mine = words(sectionKey)
    const theirs = words(titleKey)
    if (mine.size > 0 && theirs.size > 0) {
      let shared = 0
      for (const word of mine) if (theirs.has(word)) shared += 1
      const overlap = shared / (mine.size + theirs.size - shared)
      if (overlap >= 0.75) return { confidence: 'likely', score: overlap, reason: `The heading shares most of its words with “${title.trim()}”.` }
      if (overlap >= 0.4) return { confidence: 'possible', score: overlap, reason: `The heading shares some words with “${title.trim()}”.` }
    }
  }
  return null
}
