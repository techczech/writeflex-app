import type { NewChange } from '../engine'

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character)
}

function isWordBoundary(text: string, index: number): boolean {
  return index <= 0 || index >= text.length || isWordCharacter(text[index - 1]) !== isWordCharacter(text[index])
}

function commonPrefixAtWordBoundary(oldText: string, newText: string): number {
  const limit = Math.min(oldText.length, newText.length)
  let shared = 0
  while (shared < limit && oldText[shared] === newText[shared]) shared += 1
  while (shared > 0 && (!isWordBoundary(oldText, shared) || !isWordBoundary(newText, shared))) shared -= 1
  return shared
}

function commonSuffixAtWordBoundary(oldText: string, newText: string, prefix: number): number {
  const limit = Math.min(oldText.length - prefix, newText.length - prefix)
  let shared = 0
  while (shared < limit && oldText[oldText.length - 1 - shared] === newText[newText.length - 1 - shared]) shared += 1
  while (shared > 0) {
    const oldStart = oldText.length - shared
    const newStart = newText.length - shared
    if (isWordBoundary(oldText, oldStart) && isWordBoundary(newText, newStart)) break
    shared -= 1
  }
  return shared
}

/**
 * Reduce one proposed replacement to its smallest contiguous word-granular Change.
 * Throws for moves and move ranges because minimisation does not rebase their coordinates.
 */
export function minimiseProposedReplacement(input: NewChange): NewChange | null {
  if (input.editClass === 'move' || input.moveFrom !== undefined || input.moveTo !== undefined) {
    throw new Error('Cannot minimise move changes or changes carrying move ranges.')
  }
  if (input.oldText === input.newText) return null

  const prefix = commonPrefixAtWordBoundary(input.oldText, input.newText)
  const suffix = commonSuffixAtWordBoundary(input.oldText, input.newText, prefix)
  const oldText = input.oldText.slice(prefix, input.oldText.length - suffix)
  const newText = input.newText.slice(prefix, input.newText.length - suffix)
  if (oldText === newText) return null

  const anchor = input.anchor
    ? { from: input.anchor.from + prefix, to: input.anchor.to - suffix }
    : undefined
  return { ...input, oldText, newText, ...(anchor ? { anchor } : {}) }
}
