/**
 * Needs-work flags (Folio room spec § 6, D-FLAG-1/2): `==words==<!--flag:<kind>-->`.
 *
 * A flag is a `Highlight` node whose NEXT SIBLING is an inline `Comment` naming one of the four kinds,
 * found by walking the dialect's own parse tree, so code, frontmatter and anything the parser does not
 * read as a highlight is never a flag. Read tolerantly (spaces around `flag` / the colon / the kind,
 * kind case-insensitive); written canonically by the flag command (a later ticket).
 *
 * Pure and platform-free: the Flags list, the editor decorations, the export strip, word counts and
 * outline text all call these three functions and nothing else.
 */
import { frontmatterBlock } from './frontmatter'
import { parseMarkdown } from './dialect'

export type FlagKind = 'needs-citation' | 'rewrite' | 'check-fact' | 'expand'

export const FLAG_KINDS: readonly FlagKind[] = ['needs-citation', 'rewrite', 'check-fact', 'expand']

export type Flag = {
  kind: FlagKind
  /** The whole flag: `==words==<!--flag:kind-->`. */
  from: number
  to: number
  /** The words between the `==` marks. */
  wordsFrom: number
  wordsTo: number
  words: string
  /** Index of the top-level block (paragraph, heading, list, table …) holding the flag, from 0. */
  paragraph: number
  /** The flag sits in a table cell (hand-written; the editor shows it as text). */
  inTable: boolean
  /** Up to {@link CONTEXT} characters of source either side, white space made one space. */
  contextBefore: string
  contextAfter: string
}

const CONTEXT = 60
const FLAG_COMMENT = /^<!--\s*flag\s*:\s*([A-Za-z-]+?)\s*-->$/i

function kindOf(comment: string): FlagKind | null {
  const kind = FLAG_COMMENT.exec(comment)?.[1].toLowerCase()
  return kind !== undefined && (FLAG_KINDS as readonly string[]).includes(kind) ? (kind as FlagKind) : null
}

const squash = (text: string): string => text.replace(/\s+/g, ' ')

/** Every flag in `source`, in document order. Reads only; the source is never changed. */
export function findFlags(source: string): Flag[] {
  // Cheap exit: a flag needs a comment opener, and most files have none.
  if (!source.includes('<!--')) return []
  const bodyStart = frontmatterBlock(source)?.end ?? 0
  const flags: Flag[] = []
  let block = -1
  parseMarkdown(source).iterate({
    enter(node) {
      if (node.node.parent?.name === 'Document') block += 1
      if (node.name !== 'Highlight' || node.from < bodyStart) return undefined
      const next = node.node.nextSibling
      if (!next || next.name !== 'Comment' || next.from !== node.to) return undefined
      const kind = kindOf(source.slice(next.from, next.to))
      if (!kind) return undefined
      const wordsFrom = node.from + 2
      const wordsTo = node.to - 2
      let inTable = false
      for (let up = node.node.parent; up; up = up.parent) {
        if (up.name === 'TableCell') { inTable = true; break }
      }
      flags.push({
        kind,
        from: node.from,
        to: next.to,
        wordsFrom,
        wordsTo,
        words: source.slice(wordsFrom, wordsTo),
        paragraph: Math.max(0, block),
        inTable,
        contextBefore: squash(source.slice(Math.max(bodyStart, node.from - CONTEXT), node.from)),
        contextAfter: squash(source.slice(next.to, next.to + CONTEXT)),
      })
      return undefined // a flag may hold another (handwritten); its inner flags are found too
    },
  })
  return flags
}

/** Is this HTML comment text a flag tag (`<!--flag:rewrite-->`, read tolerantly)? The export model asks
 *  this of the Comment that follows a `Highlight`: a flagged highlight is emitted as plain words. */
export function isFlagComment(comment: string): boolean {
  return kindOf(comment) !== null
}

/** `source` with each flag's two `==` marks and its comment cut out by source offset, nested flags too.
 *  The words are not touched or escaped: this is for DISPLAY text (word counts, outline labels, the
 *  Markdown flavour of export). Emitters that parse (HTML, Word, plain, RTF, sharing) do not use it;
 *  they treat a flag at the tree level (model.ts), so the words can never re-parse as new syntax. */
export function stripFlags(source: string): string {
  const flags = findFlags(source)
  if (flags.length === 0) return source
  const cuts: Array<[number, number]> = []
  for (const flag of flags) {
    cuts.push([flag.from, flag.wordsFrom], [flag.wordsTo, flag.to])
  }
  cuts.sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [from, to] of cuts) {
    if (from < at) continue // cannot happen (cuts never overlap); never move backwards regardless
    out += source.slice(at, from)
    at = to
  }
  return out + source.slice(at)
}

/** `source` with each flag COMMENT (only the comment, not the `==`) overwritten by NUL characters, one for
 *  each character except line breaks, which stay: every line and column of the source is unchanged
 *  (search reports positions in the file) while the tag text cannot be matched. */
export function blankFlagTags(source: string): string {
  const flags = findFlags(source)
  if (flags.length === 0) return source
  const ranges = flags.map((flag) => [flag.wordsTo + 2, flag.to] as const).sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [from, to] of ranges) {
    if (from < at) continue
    out += source.slice(at, from) + source.slice(from, to).replace(/[^\n]/g, '\u0000')
    at = to
  }
  return out + source.slice(at)
}

/** Remove the NULs {@link blankFlagTags} left from `text`. Each mark (1-based `column`, `length`) moves
 *  to its place in the shortened text and shrinks by the NULs it spanned. */
export function dropBlankedTags<M extends { column: number; length: number }>(text: string, marks: readonly M[] = []): { text: string; marks: M[] } {
  if (!text.includes('\u0000')) return { text, marks: marks.map((m) => ({ ...m })) }
  const upTo: number[] = [0] // upTo[i]: NULs among the first i characters
  for (let i = 0; i < text.length; i += 1) upTo.push(upTo[i] + (text[i] === '\u0000' ? 1 : 0))
  const at = (index: number): number => upTo[Math.max(0, Math.min(index, text.length))]
  const moved = marks.map((m) => {
    const start = m.column - 1
    const end = start + m.length
    return { ...m, column: m.column - at(start), length: Math.max(0, m.length - (at(end) - at(start))) }
  })
  return { text: text.replace(/\u0000/g, ''), marks: moved }
}

/** {@link stripFlags} for one line of display text (a heading): same rule, no document around it. */
export function stripFlagsInLine(text: string): string {
  return text.includes('<!--') ? stripFlags(text) : text
}
