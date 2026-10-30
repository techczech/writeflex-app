import { findFlags, type FlagKind } from './flags'
import { parseMarkdown } from './dialect'
import { frontmatterBlock } from './frontmatter'

/** Build a single replacement only when the parser finds one new flag over exactly the chosen words. */
export function flagSelectionEdit(source: string, from: number, to: number, kind: FlagKind): { from: number; to: number; insert: string } {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > source.length || from >= to) throw new Error('Select the words to flag first.')
  const selected = source.slice(from, to)
  from += selected.length - selected.trimStart().length
  to -= selected.length - selected.trimEnd().length
  if (from >= to) throw new Error('Select the words to flag first.')
  const words = source.slice(from, to)
  if (words.includes('==')) throw new Error('The selection already contains highlight marks.')
  if (from < (frontmatterBlock(source)?.end ?? 0)) throw new Error('Flags cannot be put in metadata.')
  let refusal: string | null = null
  let blocks = 0
  parseMarkdown(source).iterate({ enter(node) {
    if (node.to <= from || node.from >= to) return false
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'CodeText'].includes(node.name)) refusal = 'Flags cannot be put in code.'
    if (node.name === 'Table') refusal = 'Flags cannot be put in a table cell yet.'
    if (node.name === 'Highlight') refusal = 'The selection overlaps an existing highlight or flag.'
    if (['Paragraph', 'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6', 'SetextHeading1', 'SetextHeading2'].includes(node.name)) blocks += 1
  } })
  if (refusal) throw new Error(refusal)
  if (blocks !== 1 || /\r?\n[ \t]*\r?\n/.test(words)) throw new Error('Choose words inside one paragraph or heading.')
  const insert = `==${words}==<!--flag:${kind}-->`
  const next = source.slice(0, from) + insert + source.slice(to)
  const before = findFlags(source), after = findFlags(next)
  if (after.length !== before.length + 1 || !after.some(flag => flag.from === from && flag.words === words && flag.kind === kind)) throw new Error('Those words cannot be flagged in this Markdown context.')
  return { from, to, insert }
}
