/**
 * WHAT A PIECE IS CALLED, CHEAPLY — for listings (collection rows, wikilink candidates, the folder
 * digest), where thousands of files are named at once.
 *
 * The answer is `documentTitle`'s (src/main/frontmatter.ts), exactly: the first TOP-LEVEL heading of
 * any level (ATX or setext; a heading inside a list or a block quote does not count), its text with
 * markup taken off, else the file's own name. Legacy `title:` frontmatter keys are never the title
 * (ADR-0034). `documentTitle` gets there by building the whole document model: the dialect parser
 * runs three times over the whole file (comment strip, footnote lift, the model itself), inlines and
 * all — about 3 ms a file, 12 s over a 3,934-file folder.
 *
 * This asks the same questions more cheaply, without a second opinion about Markdown:
 *   - WHERE the first heading is, is a BLOCK question. It is asked of the dialect's own block
 *     layer (`parseMarkdownBlocks`, dialect.ts): the same block parsers with every inline parser
 *     removed, so the blocks are the editor's and the exporters' blocks.
 *   - WHAT the heading says is an inline question about that heading alone, so the model is built
 *     for the heading's own source, plus the document's link-reference and footnote definitions
 *     when the heading could point at them (both are document-wide in the model).
 *   - The comment strip and footnote lift that run before every parse are skipped when the file
 *     has no line they could touch (the common case); when it does, the same functions run.
 *
 * Pure: no DOM, no fs. Equivalence with `documentTitle` is proven by tests/main/listing-title.test.ts
 * (fixtures) and, over a real folder, by the same file with WRITEFLEX_TITLE_CORPUS set.
 */
import type { SyntaxNode } from '@lezer/common'
import { footnoteDefinitions, parseMarkdownBlocks, stripComments, stripFrontmatter } from './dialect'
import { eachInline, readDocument, type Block } from './model'

const HEADING_NODES = new Set([
  'ATXHeading1', 'ATXHeading2', 'ATXHeading3', 'ATXHeading4', 'ATXHeading5', 'ATXHeading6',
  'SetextHeading1', 'SetextHeading2',
])

/** A line `stripComments` would consider (it then keeps the ones inside code). */
const COMMENT_LINE = /^\s*\/\//m
/** A line `footnoteDefinitions` would consider (it then keeps the ones inside code). */
const FOOTNOTE_OPENER = /^\[\^([^\]\s]+)\]:/m

/** The file name without its Markdown extension — the title of a piece with no heading. */
export function fileStem(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')
}

/** The text before the footnote lift: one line ending, no BOM, no frontmatter, no comment lines,
 *  no leading blank lines — `readDocument`'s first steps. The code-aware comment strip runs only
 *  when a line could be touched by it. */
function cleanedSource(original: string): string {
  let text = original.replace(/\r\n?/g, '\n')
  if (text.startsWith('\uFEFF')) text = text.slice(1)
  text = stripFrontmatter(text)
  if (COMMENT_LINE.test(text)) text = stripComments(text)
  return text.replace(/^\n+/, '')
}

/** The body `readDocument` parses, and the labels of the footnote definitions lifted out of it. */
function liftedBody(text: string): { body: string; footnoteLabels: string[] } {
  if (!FOOTNOTE_OPENER.test(text)) return { body: text.replace(/\n{3,}/g, '\n\n').trimEnd(), footnoteLabels: [] }
  const { body, definitions } = footnoteDefinitions(text)
  return { body, footnoteLabels: definitions.map((definition) => definition.label) }
}

/** The first top-level heading node of a parsed body, if any. */
function firstHeading(root: SyntaxNode): SyntaxNode | null {
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (HEADING_NODES.has(child.name)) return child
  }
  return null
}

/** The heading's text, read exactly as `documentTitle` reads it from the model. */
function headingText(source: string): string {
  const heading = readDocument(source).blocks.find(
    (block): block is Extract<Block, { kind: 'heading' }> => block.kind === 'heading',
  )
  if (!heading) return ''
  let text = ''
  eachInline([heading], (part) => {
    if (part.kind === 'text' || part.kind === 'code') text += part.text
    if (part.kind === 'wikilink') text += part.label
  })
  return text.trim()
}

/**
 * A line that could be a TOP-LEVEL heading: an ATX line, or a setext underline (`=` or `-` runs; the
 * dialect hides `-` and `--`, and a longer run is still a candidate). A top-level heading has no
 * container prefix and fewer than four columns of indent, so every one sits on such a line; most
 * candidates in a folder are the heading itself, and a file with none has no heading at all.
 */
const HEADING_CANDIDATE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|=+[ \t]*$|-+[ \t]*$)/m

/** Every definition a heading's `[label]` or `[^label]` could resolve against, as source text. */
function definitionsAppendix(root: SyntaxNode, body: string, footnoteLabels: string[]): string {
  const appendix: string[] = []
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.name === 'LinkReference') appendix.push(body.slice(child.from, child.to))
  }
  for (const label of footnoteLabels) appendix.push(`[^${label}]: x`)
  return appendix.length ? `\n\n${appendix.join('\n\n')}` : ''
}

/** The whole-document reading: lift footnotes, parse every block, resolve against every definition. */
function wholeDocumentTitle(text: string, path: string): string {
  const { body, footnoteLabels } = liftedBody(text)
  const root = parseMarkdownBlocks(body).topNode
  const heading = firstHeading(root)
  if (!heading) return fileStem(path)
  let source = body.slice(heading.from, heading.to)
  // A `[label]` or `[^label]` resolves against definitions anywhere in the document; carry them
  // after the heading so the model resolves it exactly as it would in place.
  if (source.includes('[')) source += definitionsAppendix(root, body, footnoteLabels)
  return headingText(source) || fileStem(path)
}

/**
 * The listing title of a piece: the same string `documentTitle(content, path)` returns.
 *
 * Most pieces open on their heading, so only the text up to the FIRST candidate line is parsed:
 * block parsing only ever moves forward, so the blocks of that prefix are the document's blocks up
 * to that line, and if the line is a top-level heading it is the first one. Anything less simple —
 * the candidate sits in code or a list, a footnote definition comes before it, or its text has a
 * bracket that may resolve against a definition further down — reads the whole document instead.
 */
export function listingTitle(content: string, path: string): string {
  const text = cleanedSource(content)
  const candidate = HEADING_CANDIDATE.exec(text)
  if (!candidate) return fileStem(path) // lifting footnotes only removes lines: still no candidate
  const lineEnd = text.indexOf('\n', candidate.index)
  const end = lineEnd === -1 ? text.length : lineEnd
  const opener = FOOTNOTE_OPENER.exec(text)
  if (opener && opener.index < end) return wholeDocumentTitle(text, path)
  const prefix = text.slice(0, end).replace(/\n{3,}/g, '\n\n')
  const heading = firstHeading(parseMarkdownBlocks(prefix).topNode)
  if (!heading) return wholeDocumentTitle(text, path)
  const source = prefix.slice(heading.from, heading.to)
  if (source.includes('[')) return wholeDocumentTitle(text, path)
  return headingText(source) || fileStem(path)
}
