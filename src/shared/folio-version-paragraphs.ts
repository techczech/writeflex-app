/**
 * The numbered paragraphs of a saved part (ADR-0052 § Sending text to the Scratchpad; Folio versions ticket 10). A "paragraph" here is a
 * top-level block of the app's one Markdown dialect: a heading, a paragraph, a list, a quote, a fenced block, a table. The numbering
 * is a pure function of the saved text, so the read-only view, Compare, the command line and the agent's verb all count the same way,
 * and main re-counts the saved text itself before it sends anything: the window names a range of numbers, never text.
 *
 * Numbers are 1-based. `from` and `to` are offsets into the text as given (UTF-16 code units, like `String.slice`), so the Markdown of a
 * run of paragraphs is exactly `text.slice(first.from, last.to)`: the blank lines between them travel with it, byte for byte. Front
 * matter is not a paragraph (the reader does not show it either).
 */
import { parseMarkdownBlocks } from './markdown/dialect'
import { bodyForReading } from './folio-versions-view'

export type VersionParagraph = { n: number; from: number; to: number }

export function versionParagraphs(text: string): VersionParagraph[] {
  const offset = text.length - bodyForReading(text).length
  const out: VersionParagraph[] = []
  for (let node = parseMarkdownBlocks(text.slice(offset)).topNode.firstChild; node; node = node.nextSibling) {
    // A block ends at its last character, never after the line break that ends it (a CRLF text keeps its own breaks between paragraphs only).
    let to = offset + node.to
    while (to > offset + node.from && (text[to - 1] === '\n' || text[to - 1] === '\r')) to -= 1
    if (to > offset + node.from) out.push({ n: out.length + 1, from: offset + node.from, to })
  }
  return out
}

/** The exact Markdown of paragraphs `first` to `last` (1-based, inclusive); null when the range is not inside the part. */
export function sliceParagraphs(text: string, first: number, last: number): string | null {
  const paragraphs = versionParagraphs(text)
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last > paragraphs.length) return null
  return text.slice(paragraphs[first - 1]!.from, paragraphs[last - 1]!.to)
}

/** "Paragraph 3" / "Paragraphs 3 to 5". */
export function paragraphRangeText(first: number, last: number): string {
  return first === last ? `Paragraph ${first}` : `Paragraphs ${first} to ${last}`
}
