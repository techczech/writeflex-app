export type WordRange = { from: number; to: number }

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
const JOINER = /['’\-]/

function isWordChar(source: string, index: number): boolean {
  return index >= 0 && index < source.length && WORD_CHAR.test(source[index])
}

// An apostrophe or hyphen belongs to the word only when letters sit on both sides ("don't", "well-known").
function isJoinerInWord(source: string, index: number): boolean {
  return index >= 0
    && index < source.length
    && JOINER.test(source[index])
    && isWordChar(source, index - 1)
    && isWordChar(source, index + 1)
}

function isInWord(source: string, index: number): boolean {
  return isWordChar(source, index) || isJoinerInWord(source, index)
}

/**
 * The word containing `offset` in the source text, or null when the offset sits on whitespace,
 * punctuation or markup. Punctuation stays outside the range ("know," marks "know").
 */
export function wordRangeAt(source: string, offset: number): WordRange | null {
  if (!Number.isFinite(offset) || offset < 0 || offset >= source.length) return null
  if (!isInWord(source, offset)) return null
  let from = offset
  while (isInWord(source, from - 1)) from--
  let to = offset + 1
  while (isInWord(source, to)) to++
  return { from, to }
}
