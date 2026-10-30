/**
 * WriteFlex's ONE Markdown dialect (Round B, ADR-era "one dialect" rule).
 *
 * This file is the single definition of what WriteFlex's Markdown *is*: CommonMark + GFM + the
 * app's own `==mark==` and footnote syntax. The editor installs it (renderer/src/editor/setup.ts)
 * and every emitter parses with it (to-html, to-rtf, to-plain, to-markdown), so an export can never
 * drift from what the writer sees. Nothing here may be duplicated: if a construct needs to change,
 * it changes here and both sides move together.
 *
 * Pure and platform-free — no CodeMirror, no DOM, no fs — so it runs in the renderer, in the main
 * process and headless in `bun test` alike.
 */
import { GFM, parser, type BlockContext, type Line, type MarkdownConfig, type MarkdownExtension, type DelimiterType } from '@lezer/markdown'
import { Tag, tags } from '@lezer/highlight'
import type { Tree } from '@lezer/common'
import { frontmatterBlock } from './frontmatter'
import { FANCY_NUMBERINGS, continuesNumbering, fancyMarkerAt, type FancyMarker, type FancyNumbering, type ListDelimiter } from './fancy-lists'

/** Highlight tag for `==marked==` text. Defined here (not in the editor theme) because the tag is
 *  part of the dialect's node definitions; editor/theme.ts re-exports it for its style rules. */
export const highlightMarkTag = Tag.define()
/** Highlight tag for `[^ref]` and `^[inline]` footnotes; re-exported by editor/theme.ts. */
export const footnoteTag = Tag.define()

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' }
// The inline-punctuation class GFM's Strikethrough uses for its delimiter flanking rules; reused so
// `==mark==` opens/closes on exactly the same word-boundary logic as `~~strike~~`.
const INLINE_PUNCTUATION = /[!-/:-@[-`{-~¡-¿‐-‧]/

/**
 * `==highlight==` marks, modelled on GFM Strikethrough's `~~` delimiter (identical open/close
 * flanking rules). `===` and up are left to setext headings / horizontal rules — a third `=`
 * declines the delimiter. The marked text carries {@link highlightMarkTag}; the `==` markers recede
 * as processingInstruction (editor/theme.ts).
 */
export const Highlight: MarkdownConfig = {
  defineNodes: [
    { name: 'Highlight', style: { 'Highlight/...': highlightMarkTag } },
    { name: 'HighlightMark', style: tags.processingInstruction },
  ],
  parseInline: [
    {
      name: 'Highlight',
      after: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1
        const before = cx.slice(pos - 1, pos)
        const after = cx.slice(pos + 2, pos + 3)
        const sBefore = /\s|^$/.test(before)
        const sAfter = /\s|^$/.test(after)
        const pBefore = INLINE_PUNCTUATION.test(before)
        const pAfter = INLINE_PUNCTUATION.test(after)
        return cx.addDelimiter(
          HighlightDelim,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        )
      },
    },
  ],
}

/**
 * Footnote syntax (PRD S10). `[^id]` references and `^[…]` inline footnotes both carry
 * {@link footnoteTag}. The reference parser runs before `Link` so `[^1]` is claimed as a footnote
 * rather than opening a link; the inline parser matches balanced brackets after `^[`.
 *
 * Note what is deliberately absent: there is no BLOCK parser for `[^1]: definition` lines — a
 * definition parses as an ordinary paragraph whose first inline node is a FootnoteReference, which
 * is what the editor wants. The emitters lift definitions out of the source themselves.
 */
export const Footnotes: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: footnoteTag },
    { name: 'FootnoteInline', style: footnoteTag },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1
        let end = pos + 2
        while (end < cx.end) {
          const c = cx.char(end)
          if (c === 93 /* ] */) break
          if (c === 32 || c === 9 || c === 10 || c === 91) return -1 // labels take no ws or nested [
          end++
        }
        if (end >= cx.end || cx.char(end) !== 93 || end === pos + 2) return -1 // need a non-empty label + ]
        return cx.addElement(cx.elt('FootnoteReference', pos, end + 1))
      },
    },
    {
      name: 'FootnoteInline',
      parse(cx, next, pos) {
        if (next !== 94 /* ^ */ || cx.char(pos + 1) !== 91 /* [ */) return -1
        let depth = 1
        let end = pos + 2
        while (end < cx.end && depth > 0) {
          const c = cx.char(end)
          if (c === 91 /* [ */) depth++
          else if (c === 93 /* ] */) {
            depth--
            if (depth === 0) break
          }
          end++
        }
        if (depth !== 0) return -1
        return cx.addElement(cx.elt('FootnoteInline', pos, end + 1))
      },
    },
  ],
}

// ---- Lettered and roman lists -------------------------------------------------------------------
// Pandoc's fancy_lists: `a.`, `A.`, `i.`, `I.` (or with `)`) open an ordered list. The numbering and
// marker rules live in fancy-lists.ts (the editor and the exporters read them too); this is only the
// parser half. A `FancyList` holds ordinary `ListItem`s and `ListMark`s, so muted marker ink, GFM task
// items and every "is this a real list marker" question work unchanged.

/**
 * A FancyList block's `value` carries its numbering and delimiter, so the continuation check needs
 * no second parse: numbering index × 128 + the delimiter's character code.
 */
function encodeList(numbering: FancyNumbering, delimiter: ListDelimiter): number {
  return FANCY_NUMBERINGS.indexOf(numbering) * 128 + delimiter.charCodeAt(0)
}

function decodeList(value: number): { numbering: FancyNumbering; delimiter: ListDelimiter } {
  return { numbering: FANCY_NUMBERINGS[Math.floor(value / 128)] ?? 'lower-alpha', delimiter: value % 128 === 41 ? ')' : '.' }
}

/** The first label of a fancy list opens it (`i` is roman); every later one only has to FIT it. */
function markerContinues(marker: FancyMarker, value: number): boolean {
  const list = decodeList(value)
  return marker.delimiter === list.delimiter && continuesNumbering(marker.label, list.numbering)
}

/**
 * `@lezer/markdown` keeps two facts a composite block's continuation needs off its public surface:
 * the open block stack and which of its entries is being checked. The built-in list continuation
 * (`skipForList`) reads exactly these, and this mirrors it; if a release ever moves them, the
 * fallback below keeps lists working without the indented-child rule, and the dialect tests fail.
 */
type ParserInternals = { stack?: Array<{ value: number }> }
type LineInternals = { depth?: number }

function continuesFancyList(cx: BlockContext, line: Line, value: number): boolean {
  if (line.pos === line.text.length) return true
  const stack = (cx as unknown as ParserInternals).stack
  const depth = (line as unknown as LineInternals).depth
  if (stack && depth !== undefined && depth < stack.length - 1 && line.indent >= stack[depth + 1].value + line.baseIndent) return true
  if (line.indent >= line.baseIndent + 4) return false
  const marker = fancyMarkerAt(line.text, line.pos)
  return marker !== null && markerContinues(marker, value)
}

/** Where the item's text starts — CommonMark's rule, as `@lezer/markdown`'s own list uses it. */
function listContentColumn(line: Line, pos: number): number {
  const indentAfter = line.countIndent(pos, line.pos, line.indent)
  const skipped = line.skipSpace(pos)
  const indented = line.countIndent(skipped, pos, indentAfter)
  return indented >= indentAfter + 5 || skipped === line.text.length ? indentAfter + 1 : indented
}

function inFancyList(cx: BlockContext): boolean {
  for (let depth = cx.depth - 1; depth >= 0; depth -= 1) if (cx.parentType(depth).name === 'FancyList') return true
  return false
}

const OPENING_LABELS = new Set(['a', 'A', 'i', 'I'])

/** Lettered and roman lists as a block extension (see fancy-lists.ts for the rules it follows). */
export const FancyLists: MarkdownConfig = {
  defineNodes: [{ name: 'FancyList', block: true, composite: continuesFancyList }],
  parseBlock: [{
    name: 'FancyList',
    after: 'OrderedList',
    parse(cx, line) {
      if (line.indent >= line.baseIndent + 4) return false
      const marker = fancyMarkerAt(line.text, line.pos)
      if (!marker) return false
      // Inside an open FancyList the continuation check has already matched this marker to the list.
      if (cx.parentType().name !== 'FancyList') {
        if (!marker.numbering) return false
        cx.startComposite('FancyList', line.basePos, encodeList(marker.numbering, marker.delimiter))
      }
      const content = listContentColumn(line, line.pos + marker.length)
      cx.startComposite('ListItem', line.basePos, content - line.baseIndent)
      cx.addElement(cx.elt('ListMark', cx.lineStart + line.pos, cx.lineStart + line.pos + marker.length))
      line.moveBaseColumn(content)
      return null
    },
    endLeaf(cx, line) {
      const marker = fancyMarkerAt(line.text, line.pos)
      if (!marker) return false
      if (inFancyList(cx)) return true
      const hasText = line.skipSpace(line.pos + marker.length) < line.text.length
      return hasText && marker.numbering !== null && OPENING_LABELS.has(marker.label)
    },
  }],
}

/**
 * A `-` or `--` line under a paragraph is not a setext underline here. CommonMark makes it one, which
 * turned the paragraph above into a heading the moment a writer typed the `-` that starts a list
 * (and left it one until the space and text arrived). `---` and longer, and every `=` underline,
 * still underline a heading, so existing documents read as before. The same parser serves the editor,
 * the outline and every export, so all of them agree.
 *
 * Mechanism: a leaf parser ahead of the stock setext one that hides the line from it (`line.next` is
 * the character the stock check looks at) and consumes nothing, so the line stays paragraph text.
 * The stock parser itself stays installed because the thematic-break rule asks whether it is.
 */
export const ShortDashIsText: MarkdownConfig = {
  parseBlock: [{
    name: 'ShortDashIsText',
    before: 'SetextHeading',
    leaf() {
      return {
        nextLine(cx: BlockContext, line: Line): boolean {
          if (line.next !== 45 /* - */ || line.indent >= line.baseIndent + 4) return false
          let pos = line.pos + 1
          while (pos < line.text.length && line.text.charCodeAt(pos) === 45) pos += 1
          if (pos - line.pos >= 3) return false
          while (pos < line.text.length && (line.text.charCodeAt(pos) === 32 || line.text.charCodeAt(pos) === 9)) pos += 1
          if (pos !== line.text.length) return false
          line.next = 0
          return false
        },
        finish: () => false,
      }
    },
  }],
}

/** The dialect as `@lezer/markdown` extensions, in the editor's installation order. Both the editor
 *  (`markdown({ extensions: markdownDialect() })`) and {@link parseMarkdown} use exactly this list.
 *  FancyLists adds Pandoc-style lettered and roman lists: `a.`, `A.`, `i.`, `I.`. */
export function markdownDialect(): MarkdownExtension[] {
  return [GFM, Highlight, Footnotes, FancyLists, ShortDashIsText]
}

const dialectParser = parser.configure(markdownDialect())

/** Parse Markdown into a Lezer tree with WriteFlex's dialect — the exporters' entry point. */
export function parseMarkdown(text: string): Tree {
  return dialectParser.parse(text)
}

/** Every inline parser the dialect installs; without them only its block parsers are left. */
const INLINE_PARSERS = [
  'Escape', 'Entity', 'InlineCode', 'HTMLTag', 'Emphasis', 'Highlight', 'Strikethrough', 'HardBreak',
  'FootnoteReference', 'Link', 'Image', 'Autolink', 'FootnoteInline', 'LinkEnd',
]

/** The dialect's block layer: the same block parsers in the same order, no inline parsing. Inline
 *  parsing never changes block structure in `@lezer/markdown` (a table row is split on its pipes,
 *  not on inline nodes), so the blocks are exactly {@link parseMarkdown}'s, at a fraction of the
 *  cost. Configured in a second step because one `configure` applies `remove` before it adds the
 *  extensions' own inline parsers. */
const blockParser = dialectParser.configure({ remove: INLINE_PARSERS })

/** Parse Markdown into its BLOCKS only — headings, paragraphs, lists, code, tables — with no inline
 *  nodes inside them. For questions about where blocks are, asked of many files at once
 *  (listing-title.ts). */
export function parseMarkdownBlocks(text: string): Tree {
  return blockParser.parse(text)
}

// ---- What is content, and what is not ---------------------------------------------------------
// Frontmatter is stage-truth for the app (ADR-0019) and comments are the annotation tier (ADR-0021).
// Neither is part of the work, so neither ever leaves it: every emitter cleans the source with
// {@link exportSource} BEFORE parsing, so no emitter can forget, and no emitter is left stripping
// after the fact (by then a comment has already been folded into whatever it sat inside).

/**
 * WHERE THE SOURCE IS QUOTED CODE — asked of the dialect's own parser, once.
 *
 * The cleaners below run BEFORE the parse, which is exactly why they must not re-guess what code is.
 * A line scanner did, twice, and each time it deleted a writer's text: it toggled on any ``` or `~~~`
 * line without matching the closing delimiter to the opening one (so a `~~~` inside a ``` block ended
 * it, and the code after it was scrubbed as prose), and it knew nothing of INDENTED code blocks (so
 * `    // real code` in an example vanished). There is no second opinion about code available here:
 * the parser is configured with this very dialect, and it also finds code inside a list item or a
 * block quote, which no line scanner ever did.
 *
 * A cleaner needs this extra parse only when it finds a candidate to remove; its ranges are
 * shared by all candidates in that call.
 */
type Range = { from: number; to: number }

function codeBlockRanges(text: string): Range[] {
  const ranges: Range[] = []
  const cursor = parseMarkdown(text).cursor()
  do {
    if (cursor.name === 'FencedCode' || cursor.name === 'CodeBlock') ranges.push({ from: cursor.from, to: cursor.to })
  } while (cursor.next())
  return ranges
}

/** True when the character at `at` sits in quoted code. Callers judge a LINE by its first non-blank
 *  character, because an indented block's node begins past the indent that makes it code. */
function insideCode(ranges: Range[], at: number): boolean {
  return ranges.some((range) => at >= range.from && at < range.to)
}

/** The offset of a line's first non-blank character. */
function firstInk(line: string, lineStart: number): number {
  return lineStart + (line.length - line.trimStart().length)
}

/**
 * A UTF-8 byte-order mark decodes to a leading U+FEFF, and it then defeats EVERY "first line"
 * question the export layer asks. `﻿# Heading` is not a heading to the parser, it is a paragraph
 * beginning with an invisible character; `﻿[^1]: note` is not a definition; and the mark itself
 * travels into the paste. The frontmatter reader learned to tolerate its own leading BOM (finding 4,
 * frontmatter.ts) — but only a file WITH frontmatter had it removed, because it fell off with the
 * block. It is dropped once here instead, for every document.
 *
 * Only a LEADING mark: a U+FEFF anywhere else is a character the writer typed, and it stays.
 */
export function withoutByteOrderMark(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text
}

/** Drop a leading YAML frontmatter block. Returns the text unchanged when the file is bare.
 *
 *  What counts as frontmatter is NOT decided here — it is decided once, in
 *  {@link frontmatterBlock}, and the frontmatter organ (src/main/frontmatter.ts) asks the same
 *  question of the same code. A shape-only regex used to live here, and it deleted the first
 *  paragraph of any piece that opened on a thematic break. */
export function stripFrontmatter(text: string): string {
  const block = frontmatterBlock(text)
  return block === null ? text : text.slice(block.end)
}

/** A line that reads as a WriteFlex `//` post-it comment (editor/comments.ts paints exactly these). */
const COMMENT_LINE = /^\s*\/\//

/** Drop WriteFlex `//` post-it comment lines (ADR-0021). Code-aware: a `//` line inside a fenced OR
 *  an indented code block is the writer's code and stays, wherever that block sits. */
export function stripComments(text: string): string {
  let code: Range[] | undefined
  const kept: string[] = []
  let start = 0
  for (const line of text.split('\n')) {
    if (COMMENT_LINE.test(line) && !insideCode(code ??= codeBlockRanges(text), firstInk(line, start))) { start += line.length + 1; continue }
    kept.push(line)
    start += line.length + 1
  }
  return kept.join('\n')
}

/** The bytes of a document that may leave the app: byte-order mark, frontmatter and comments
 *  removed, everything else byte-faithful. Every emitter starts here. */
export function exportSource(text: string): string {
  return stripComments(stripFrontmatter(withoutByteOrderMark(text))).replace(/^\n+/, '')
}

// ---- Wikilinks --------------------------------------------------------------------------------
// The disappearing-wikilink law: `[[target]]` and `[[target|label]]` leave the app as their label
// TEXT, in every copy and every single-document export. The one exception is the Collection bundle,
// where a target inside the bundle becomes a working internal anchor — and that is expressed as a
// resolver handed to the emitter, never as a second code path.

/** A wikilink found in the source. `target` is the piece it points at (without any `#heading` or
 *  `|label` tail); `label` is the text a reader sees when the link disappears. */
export type Wikilink = { from: number; to: number; target: string; label: string }

/** How deep a label may nest before the sweep simply takes the brackets off instead of reading a
 *  link out of them. Real writing does not nest at all; the cap is what keeps a pathological
 *  document (`[[` twenty thousand times) bounded rather than recursing until the stack goes. */
const MAX_WIKILINK_NESTING = 8

/**
 * Every TOP-LEVEL `[[…]]` in `text`, in document order, found in a single left-to-right pass with a
 * stack of open brackets. Nesting is counted, so `[[a|[[b]]]]` is ONE link whose raw body is
 * `a|[[b]]` — a regex that stops at the first `]]` truncates there and leaks the inner brackets into
 * every flavour. Openers with nothing to close them are simply abandoned (the sweep takes them), and
 * a newline abandons whatever is open, because a wikilink is a single-line construct exactly as it
 * is in the editor's own classifier (editor/wikilinks.ts).
 */
function scanWikilinks(text: string, depth: number): Wikilink[] {
  const links: Wikilink[] = []
  const open: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\n') { open.length = 0; continue }
    if (character !== '[' && character !== ']') continue
    if (text[index + 1] !== character) continue
    if (character === '[') { open.push(index); index += 1; continue }
    const start = open.pop()
    index += 1
    // Only the OUTERMOST pair is a link; an inner one is part of its label and is read there.
    if (start !== undefined && open.length === 0) links.push(readWikilink(text, start, index + 1, depth))
  }
  return links
}

/** One link's target and label. Mirrors the editor's classifier: a `#fragment` is dropped from the
 *  target, a `|label` tail wins as the display text, and an empty link reads as the app's
 *  "Untitled idea" placeholder. A label that is itself a wikilink is flattened in its turn. */
function readWikilink(text: string, from: number, to: number, depth: number): Wikilink {
  const raw = text.slice(from + 2, to - 2)
  const separator = raw.indexOf('|')
  const target = sealWikilinkBrackets((separator < 0 ? raw : raw.slice(0, separator)).split('#', 1)[0].trim())
  const label = target === ''
    ? 'Untitled idea'
    : flattenAt((separator < 0 ? target : raw.slice(separator + 1).trim()) || target, depth + 1)
  return { from, to, target, label }
}

/** Parse every `[[…]]` in `text`. */
export function wikilinkRanges(text: string): Wikilink[] {
  return scanWikilinks(text, 0)
}

/**
 * Belt and braces for the disappearing-wikilink law: delete any `[[`/`]]` the scanner declined to
 * claim as a link — an opener with no closer, a closer with no opener, a link broken across lines,
 * a ragged run of three. The text between them is the writer's words and survives; only the
 * brackets go. Every emitter passes its prose through this, so no input can leak a bracket.
 */
export function sealWikilinkBrackets(text: string): string {
  return text.replace(/\[\[+|\]\]+/g, '')
}

function flattenAt(text: string, depth: number): string {
  if (depth > MAX_WIKILINK_NESTING) return sealWikilinkBrackets(text)
  let out = ''
  let pos = 0
  for (const link of scanWikilinks(text, depth)) {
    out += text.slice(pos, link.from) + link.label
    pos = link.to
  }
  return sealWikilinkBrackets(out + text.slice(pos))
}

/** Replace every `[[…]]` with its plain label text — the law applied to a source string. */
export function flattenWikilinks(text: string): string {
  return flattenAt(text, 0)
}

// ---- Footnotes --------------------------------------------------------------------------------

/** A `[^label]: text` definition lifted out of the source, with its continuation lines folded in. */
export type FootnoteDefinition = { label: string; text: string }

/** A definition opener: `[^label]:` at the start of a line — the shape editor/insert-objects.ts
 *  renumbers. Its block runs on through every following non-blank line that neither opens another
 *  definition nor belongs to a code block. */
const FOOTNOTE_OPENER = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/

/** Lift every footnote definition out of `text`, returning the body without them and the
 *  definitions in source order. Emitters render the definitions at the end of the output, which is
 *  where a pasted footnote belongs .
 *
 *  CODE IS QUOTED: a `[^1]: …` line inside a fenced or indented block is a Markdown EXAMPLE, not a
 *  definition. Lifting it destroyed the example twice over — the body lost the line, and the
 *  continuation ran on into the closing fence and folded it into the note. */
export function footnoteDefinitions(text: string): { body: string; definitions: FootnoteDefinition[] } {
  let code: Range[] | undefined
  const lines = text.split('\n')
  const starts: number[] = []
  for (let at = 0, index = 0; index < lines.length; index += 1) { starts.push(at); at += lines[index].length + 1 }
  const definitions: FootnoteDefinition[] = []
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const opener = FOOTNOTE_OPENER.exec(lines[index])
    if (!opener) { kept.push(lines[index]); continue }
    code ??= codeBlockRanges(text)
    if (insideCode(code, firstInk(lines[index], starts[index]))) { kept.push(lines[index]); continue }
    const parts = [opener[2].trim()]
    while (index + 1 < lines.length) {
      const next = lines[index + 1]
      if (next.trim() === '' || FOOTNOTE_OPENER.test(next)) break
      if (insideCode(code, firstInk(next, starts[index + 1]))) break
      parts.push(next.trim())
      index += 1
    }
    definitions.push({ label: opener[1], text: parts.filter(Boolean).join(' ') })
  }
  return { body: kept.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd(), definitions }
}
