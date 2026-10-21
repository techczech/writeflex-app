/**
 * Title conflicts (title-conflict buttons, 2026-10-19). The export names a piece or a part by its frontmatter
 * `title:` first (main/export-title.ts); the app names it by its heading. When the two disagree the app and
 * the export show different titles, and a Folio part exports both. This module says when that is so and
 * makes the one-click fixes as text:
 *
 * - "Use heading as title": `title:` becomes the heading's plain text.
 * - "Use title as heading": the heading's text span becomes the title; its level, indent, closing `#`s, a
 *   trailing `{#id …}` block, footnote references and a setext underline are kept, and nothing else moves.
 *   A document with a `title:` that does not open with a heading gets `# Title` and a blank line inserted at
 *   the top of its body instead (`titleHeadingInsertable`); no other line is touched. Never for a Folio part:
 *   its heading is added by the waiting "Add the heading" change (main/folio-part-proposals.ts).
 *
 * Only a heading on the body's first non-blank line names the document (`atTopOfBody`, Dominik 2026-10-21):
 * a heading further down is never compared with the title and never rewritten from it.
 *
 * Pure (a source and a path in, text out), so main (the Plan and the Outline, written to disk) and the
 * renderer (the open document's bar, applied to the editor buffer as one transaction) make the same bytes.
 *
 * A conflict: `title:` present and non-empty, the heading that names the document exists (not `heading:
 * none`), and its plain text is not the title by `sameTitle` (letter case and spacing aside, as the export
 * compares when it leaves out a part's own heading).
 * - A Folio part: the heading is the part's own title heading by the part-title rule (`partTitle`, option C:
 *   a `#` first heading, or a lower one that already says the title). A lower first heading that is a
 *   subsection is not the part's title (the export prints the title above it), so it never conflicts.
 *   For a part this is exactly `partTitle(...).mismatch`.
 * - Any other piece: the heading at any level, ATX or setext, that opens the body (its first block, on the
 *   body's first non-blank line). A piece that opens with anything else has no naming heading.
 * A piece with no `title:` never conflicts (ADR-0008: bare stays bare).
 */

import type { SyntaxNode } from '@lezer/common'
import { parseFrontmatter } from '../main/frontmatter'
import { frontmatterBlock, FRONTMATTER_KEY_VALUE } from './markdown/frontmatter'
import { parseMarkdownBlocks } from './markdown/dialect'
import { layoutOf, withFrontmatterKey, yamlScalar } from './markdown/frontmatter-edit'
import { atTopOfBody, declaresNoHeading, headingPlainText, partTitleWithHeading, sameTitle, withTopHeading } from './folio-part-title'

export type TitleFixDirection = 'heading-to-title' | 'title-to-heading'

/** Where the naming heading's text sits: `[from, to)` of its text span on its line (marks and attributes outside it). */
type HeadingSpan = {
  kind: 'atx' | 'setext'
  /** Its plain text (`headingPlainText`). */
  text: string
  /** The span of the line(s) after the opening marks and before closing marks, without trailing blanks. */
  from: number
  to: number
}

export type TitleConflict = {
  /** The frontmatter `title`, as the frontmatter reader gives it (trimmed). */
  title: string
  /** The heading's plain text. */
  heading: string
}

export type TitleConflictOptions = { part: boolean }

export type TitleFixResult = { ok: true; next: string } | { ok: false; message: string }

const HEADING_NODE = /^(ATX|Setext)Heading([1-6])$/

function bodyStart(source: string): number {
  const block = frontmatterBlock(source)
  if (block) return block.end
  return source.startsWith('﻿') ? 1 : 0
}

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t' || char === '\r'

/** The heading, ATX or setext, that is the body's first block on its first non-blank line, by the app's own Markdown dialect. */
function topPieceHeading(source: string): HeadingSpan | null {
  const offset = bodyStart(source)
  const body = source.slice(offset)
  const tree = parseMarkdownBlocks(body)
  // Only the first block: a heading after a paragraph, a list or anything else does not name the piece.
  const node: SyntaxNode | null = tree.topNode.firstChild
  if (node) {
    const kind = HEADING_NODE.exec(node.name)
    if (!kind || !atTopOfBody(source, node.from + offset)) return null
    const marks: SyntaxNode[] = []
    for (let child = node.firstChild; child; child = child.nextSibling) if (child.name === 'HeaderMark') marks.push(child)
    let from: number
    let to: number
    if (kind[1] === 'ATX') {
      from = marks[0] ? marks[0].to : node.from
      to = marks.length > 1 ? marks[marks.length - 1].from : node.to
    } else {
      from = node.from
      to = marks.length > 0 ? marks[marks.length - 1].from : node.to
    }
    while (from < to && (body[from] === ' ' || body[from] === '\t')) from += 1
    while (to > from && (isBlank(body[to - 1]) || body[to - 1] === '\n')) to -= 1
    const raw = body.slice(from, to)
    const text = headingPlainText(raw.replace(/\r?\n/g, ' '))
    // An empty heading (`# **`) names nothing: the app falls back to the file name.
    if (!text) return null
    return { kind: kind[1] === 'ATX' ? 'atx' : 'setext', text, from: from + offset, to: to + offset }
  }
  return null
}

/** The part's own title heading (`partTitle`, option C), when it is in the text. */
function partHeading(source: string, path: string): HeadingSpan | null {
  const { named, heading } = partTitleWithHeading(source, path)
  if (named.mode !== 'own' || !heading) return null
  const line = source.slice(heading.lineStart, heading.lineEnd)
  const hashes = heading.hashes - heading.lineStart
  let from = hashes
  while (line[from] === '#') from += 1
  while (from < line.length && (line[from] === ' ' || line[from] === '\t')) from += 1
  let to = line.length
  while (to > from && isBlank(line[to - 1])) to -= 1
  // A closing run of `#`s after a blank is a mark, not text.
  let hashStart = to
  while (hashStart > from && line[hashStart - 1] === '#') hashStart -= 1
  if (hashStart < to && hashStart > from && isBlank(line[hashStart - 1])) {
    to = hashStart
    while (to > from && isBlank(line[to - 1])) to -= 1
  } else if (hashStart === from) {
    to = from
  }
  return { kind: 'atx', text: heading.text, from: heading.lineStart + from, to: heading.lineStart + to }
}

function namingHeading(source: string, path: string, options: TitleConflictOptions): HeadingSpan | null {
  if (declaresNoHeading(source)) return null
  return options.part ? partHeading(source, path) : topPieceHeading(source)
}

function frontmatterTitle(source: string): string | null {
  return parseFrontmatter(source)?.title?.trim() || null
}

/** The conflict between the document's `title:` and its naming heading, or null when there is none. */
export function titleConflict(source: string, path: string, options: TitleConflictOptions): TitleConflict | null {
  const title = frontmatterTitle(source)
  // Cheap first: most documents have no `title:` and are never parsed.
  if (title === null) return null
  const heading = namingHeading(source, path, options)
  if (!heading) return null
  // The title read as a heading's text is, so markers on both sides compare alike (`T[^1]`).
  if (sameTitle(headingPlainText(title), heading.text)) return null
  return { title, heading: heading.text }
}

/** A conflict's identity: two looks at the same disagreement give the same key. */
export const titleConflictKey = (conflict: TitleConflict): string => `${conflict.title}\u0000${conflict.heading}`

/*
 * The scans below are hand-written and linear in the text's length, as headingPlainText's are
 * (shared/folio-part-title.ts): a heading or a title of any length is read in one pass, never retried from
 * every start (a regex such as `/\[\^[^\]\s]+\]/g` or `/[ \t]+#+[ \t]*$/` is quadratic on runs of `[^` or blanks).
 */

const isBlankChar = (char: string | undefined): boolean => char === ' ' || char === '\t'
const isWhite = (char: string): boolean => /\s/.test(char)

/** `[^label]` footnote references in `text`, in order (`/\[\^[^\]\s]+\]/g`). */
function footnoteReferences(text: string): string[] {
  const found: string[] = []
  let at = text.indexOf('[^')
  while (at !== -1) {
    let stop = at + 2
    while (stop < text.length && text[stop] !== ']' && !isWhite(text[stop])) stop += 1
    if (text[stop] === ']' && stop > at + 2) {
      found.push(text.slice(at, stop + 1))
      at = text.indexOf('[^', stop + 1)
    } else {
      // Every `[^` between `at` and `stop` stops at the same character and fails the same way.
      at = text.indexOf('[^', Math.max(stop, at + 1))
    }
  }
  return found
}

// The start of a Pandoc attribute block's inside: `#id`, `.class`, `:` or `key=`. Anchored, so linear.
const ATTRIBUTE_START = /^[ \t]*(?:[#.:]|[\w-]+=)/

/** A trailing Pandoc attribute block (`{#id .class key=value}`) with the blanks before it, else ''
 *  (`/[ \t]*\{[ \t]*(?:[#.:]|[\w-]+=)[^{}]*\}$/`). */
function trailingAttributes(text: string): string {
  if (text[text.length - 1] !== '}') return ''
  const open = text.lastIndexOf('{', text.length - 2)
  if (open === -1) return ''
  const body = text.slice(open + 1, text.length - 1)
  if (body.includes('}') || !ATTRIBUTE_START.test(body)) return ''
  let start = open
  while (start > 0 && isBlankChar(text[start - 1])) start -= 1
  return text.slice(start)
}

/** Closing `#`s at the end of `text` with the blanks around them, else '' (`/[ \t]+#+[ \t]*$/`). */
function closingHashes(text: string): string {
  let end = text.length
  while (end > 0 && isBlankChar(text[end - 1])) end -= 1
  let hashes = end
  while (hashes > 0 && text[hashes - 1] === '#') hashes -= 1
  if (hashes === end || !isBlankChar(text[hashes - 1])) return ''
  let start = hashes
  while (start > 0 && isBlankChar(text[start - 1])) start -= 1
  return text.slice(start)
}

/** Whether `text` ends in a run of `#`s at its start or after a blank (`/(?:^|[ \t])#+$/`). */
function endsInHashMark(text: string): boolean {
  let hashes = text.length
  while (hashes > 0 && text[hashes - 1] === '#') hashes -= 1
  return hashes < text.length && (hashes === 0 || isBlankChar(text[hashes - 1]))
}

/** Whether `text` holds what may start an HTML tag or comment (`/<\/?[A-Za-z!]/`). */
function hasHtml(text: string): boolean {
  for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', at + 1)) {
    const next = text[at + 1] === '/' ? text[at + 2] : text[at + 1]
    if (next !== undefined && (next === '!' || (next >= 'A' && next <= 'Z') || (next >= 'a' && next <= 'z'))) return true
  }
  return false
}

const REFUSE_HTML = 'This heading has HTML in it, so WriteFlex will not rewrite it. Change the heading in the text.'
const REFUSE_MULTILINE = 'This heading runs over more than one line, so WriteFlex will not rewrite it. Change the heading in the text.'
const REFUSE_UNSAFE_TITLE = 'The title would not read the same as a heading, so WriteFlex did not write it. Change the heading in the text.'
const REFUSE_NOT_A_HEADING = 'With this title the heading would no longer read as the same heading, so WriteFlex did not write it. Change the heading in the text.'
const REFUSE_LIST_TITLE = 'The title is written as a list or a block, so WriteFlex will not change it. Change it in the file.'
const NOTHING_TO_FIX = 'The title and the heading already match.'
const NO_TOP_HEADING = 'This document does not start with a heading, so there is no heading to use as its title.'
const NO_TITLE = 'This document has no title to use as its heading.'
export const PART_HEADING_IS_A_CHANGE = 'This part does not start with a heading. The change that adds its title as the heading is waiting in the Changes.'

/** The body's top-level Markdown blocks, by the app's own dialect: their node names and where they sit in `source`. */
type Block = { name: string; from: number; to: number }
function topBlocks(source: string): Block[] {
  const offset = bodyStart(source)
  const blocks: Block[] = []
  for (let node = parseMarkdownBlocks(source.slice(offset)).topNode.firstChild; node; node = node.nextSibling) {
    blocks.push({ name: node.name, from: node.from + offset, to: node.to + offset })
  }
  return blocks
}

/**
 * Whether `next` (the heading's text span `[span.from, span.to)` of `source` replaced, `delta` longer) still
 * reads, block for block, as `source` does: every block before the heading the same, the heading the same
 * kind and level at the same place, and every block after it the same and only moved by `delta`. A title
 * that would turn the heading into a fence, an HTML block, a list or a paragraph, or would pull the body
 * into it, fails here.
 */
function sameBlocks(source: string, next: string, span: HeadingSpan, delta: number): boolean {
  const before = topBlocks(source)
  const after = topBlocks(next)
  if (before.length !== after.length) return false
  const index = before.findIndex((block) => block.from <= span.from && span.from < block.to)
  if (index === -1 || !HEADING_NODE.test(before[index].name)) return false
  return before.every((block, at) => {
    const other = after[at]
    if (other.name !== block.name) return false
    if (at < index) return other.from === block.from && other.to === block.to
    if (at === index) return other.from === block.from && other.to === block.to + delta
    return other.from === block.from + delta && other.to === block.to + delta
  })
}

/** The source with the naming heading's text replaced by `title`, keeping every mark around it. */
function withHeadingText(source: string, path: string, span: HeadingSpan, title: string, options: TitleConflictOptions): TitleFixResult {
  const old = source.slice(span.from, span.to)
  if (old.includes('\n') || old.includes('\r')) return { ok: false, message: REFUSE_MULTILINE }
  if (hasHtml(old)) return { ok: false, message: REFUSE_HTML }
  const attributes = trailingAttributes(old)
  let words = old.slice(0, old.length - attributes.length)
  // `# T # {#id}`: closing `#`s before an attribute block are marks too.
  const closing = attributes ? closingHashes(words) : ''
  words = words.slice(0, words.length - closing.length)
  const notes = footnoteReferences(words).filter((note) => !title.includes(note))
  // A title ending in what a heading reads as a mark would not survive as text.
  if (title.includes('\n') || title.includes('\r') || endsInHashMark(title) || trailingAttributes(title) !== '') return { ok: false, message: REFUSE_UNSAFE_TITLE }
  const text = title + notes.join('') + closing + attributes
  const next = source.slice(0, span.from) + text + source.slice(span.to)
  // Read back: the same heading (kind, level, place) holds the title, and the body after it reads as before.
  const again = namingHeading(next, path, options)
  if (!again || again.kind !== span.kind || again.from !== span.from || !sameBlocks(source, next, span, text.length - old.length)) {
    return { ok: false, message: REFUSE_NOT_A_HEADING }
  }
  if (!sameTitle(headingPlainText(title), again.text)) return { ok: false, message: REFUSE_UNSAFE_TITLE }
  return { ok: true, next }
}

/**
 * Whether the frontmatter `title` is written as one plain or quoted scalar on its own line, the only form
 * "Use heading as title" replaces. Refused: a list or a map (`[`, `{`, or a block below the key), a block
 * scalar (`|`, `>`), an anchor (`&t`), a tag (`!x`), an alias (`*a`), YAML's reserved `@` and backtick, a
 * `%` directive, a `?`/`:`/`-` indicator, an empty or comment-only value (`title: # c`), and any value
 * that goes on below the key: every line after it, up to the next top-level key or the end of the block,
 * is looked at (blank lines and top-level comments skipped), and an indented one or a `- ` item refuses.
 */
function titleIsOneLineScalar(source: string): boolean {
  const layout = layoutOf(source)
  if (!layout) return false
  const index = layout.lines.findIndex((item) => FRONTMATTER_KEY_VALUE.exec(item.text)?.[1] === 'title')
  if (index === -1) return false
  const raw = (FRONTMATTER_KEY_VALUE.exec(layout.lines[index].text)?.[2] ?? '').trim()
  if (raw === '' || raw[0] === '#') return false
  if ('[]{}|>&!*@`%'.includes(raw[0])) return false
  if ((raw[0] === '-' || raw[0] === '?' || raw[0] === ':') && (raw.length === 1 || isBlankChar(raw[1]))) return false
  // A value that continues: any line before the next top-level key (or the block's end) that is indented or
  // a sequence item, past blank lines and top-level comments.
  for (let at = index + 1; at < layout.lines.length; at += 1) {
    const line = layout.lines[at].text
    if (line.trim() === '') continue
    if (isBlankChar(line[0]) || line.startsWith('- ') || line === '-') return false
    if (line[0] === '#') continue
    break
  }
  // A quoted value closes on its own line.
  if (raw[0] === '"' || raw[0] === "'") {
    // A trailing comment after the closing quote is allowed; the quoted part must close.
    const quote = raw[0]
    let at = 1
    for (; at < raw.length; at += 1) {
      if (quote === '"' && raw[at] === '\\') { at += 1; continue }
      if (raw[at] === quote) {
        if (quote === "'" && raw[at + 1] === "'") { at += 1; continue }
        break
      }
    }
    if (at >= raw.length) return false
  }
  return true
}

/**
 * The text with the conflict fixed in `direction`, or why it was not: no conflict, a heading that cannot be
 * rewritten safely, a `title:` that is not a one-line scalar. Each result is checked by reading it back: a
 * fix that would not end the conflict is refused, never written.
 */
export function withTitleFixed(source: string, path: string, direction: TitleFixDirection, options: TitleConflictOptions): TitleFixResult {
  const conflict = titleConflict(source, path, options)
  if (!conflict) {
    if (frontmatterTitle(source) === null || declaresNoHeading(source)) return { ok: false, message: NOTHING_TO_FIX }
    if (namingHeading(source, path, options)) return { ok: false, message: NOTHING_TO_FIX }
    // A title and no heading at the top: only "Use title as heading" applies, and it inserts.
    return direction === 'title-to-heading' ? withTitleHeadingInserted(source, path, options) : { ok: false, message: NO_TOP_HEADING }
  }
  const span = namingHeading(source, path, options)!
  let result: TitleFixResult
  if (direction === 'heading-to-title') {
    if (!titleIsOneLineScalar(source)) return { ok: false, message: REFUSE_LIST_TITLE }
    const next = withFrontmatterKey(source, 'title', yamlScalar(span.text))
    if (next === null) return { ok: false, message: REFUSE_LIST_TITLE }
    if (frontmatterTitle(next) !== span.text) return { ok: false, message: REFUSE_UNSAFE_TITLE }
    result = { ok: true, next }
  } else {
    result = withHeadingText(source, path, span, conflict.title, options)
  }
  if (result.ok && titleConflict(result.next, path, options) !== null) return { ok: false, message: REFUSE_UNSAFE_TITLE }
  return result
}

/** Whether the body opens with a heading of any kind (an empty `# **` too): then nothing is inserted above it for a piece. */
function opensWithHeading(source: string): boolean {
  const offset = bodyStart(source)
  const first = parseMarkdownBlocks(source.slice(offset)).topNode.firstChild
  return first !== null && HEADING_NODE.test(first.name) && atTopOfBody(source, first.from + offset)
}

/**
 * `# Title` and a blank line inserted at the top of the body, for a document with a `title:` that does not
 * open with its naming heading. Refused when the title would not read back as that heading, or (a piece) the
 * body already opens with a heading. Only bytes are inserted: the text before and after the insertion is kept.
 */
function withTitleHeadingInserted(source: string, path: string, options: TitleConflictOptions): TitleFixResult {
  const title = frontmatterTitle(source)
  if (title === null) return { ok: false, message: NO_TITLE }
  // A Folio part is never given its heading here, by any caller (the Plan, the Outline, the bridge's fixPart):
  // its "Add the heading" change in the Changes does that, and a second way would leave that change behind to
  // add the heading twice.
  if (options.part) return { ok: false, message: PART_HEADING_IS_A_CHANGE }
  if (opensWithHeading(source)) return { ok: false, message: NOTHING_TO_FIX }
  if (title.includes('\n') || title.includes('\r') || endsInHashMark(title) || trailingAttributes(title) !== '') return { ok: false, message: REFUSE_UNSAFE_TITLE }
  const next = withTopHeading(source, title)
  if (next === null) return { ok: false, message: REFUSE_UNSAFE_TITLE }
  const again = namingHeading(next, path, options)
  if (!again || again.kind !== 'atx' || !sameTitle(headingPlainText(title), again.text) || titleConflict(next, path, options) !== null) {
    return { ok: false, message: REFUSE_UNSAFE_TITLE }
  }
  return { ok: true, next }
}

/** Whether "Use title as heading" would insert `# Title` at the top: a `title:`, no `heading: none`, and no
 *  heading that names the document at the top of its body. A quiet offer: there is no conflict to warn about. */
export function titleHeadingInsertable(source: string, path: string, options: TitleConflictOptions): boolean {
  if (frontmatterTitle(source) === null || declaresNoHeading(source)) return false
  if (titleConflict(source, path, options) !== null || namingHeading(source, path, options)) return false
  return withTitleHeadingInserted(source, path, options).ok
}

/** The one-line labels the buttons and commands use. */
export const TITLE_FIX_LABEL: Record<TitleFixDirection, string> = {
  'heading-to-title': 'Use heading as title',
  'title-to-heading': 'Use title as heading',
}

/** The warning's sentence. */
export const titleConflictSentence = (conflict: Pick<TitleConflict, 'title' | 'heading'>): string =>
  `The title says “${conflict.title}” and the heading says “${conflict.heading}”.`
