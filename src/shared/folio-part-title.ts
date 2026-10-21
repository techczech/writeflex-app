/**
 * THE part-title rule for a Folio (ticket 0.23-09). A part's title is its first-level heading, the `#`
 * heading that is the first heading of the file. Every place that shows a part's title or lists a part's
 * headings asks here: the Outline's Folio part, the Plan, the Board card, the export's contents and the
 * part heading in the export. Pure (a source and a path in, facts out), so main and the renderer share it.
 *
 * Three states of a part, from its text and its frontmatter:
 * Only a heading on the body's first non-blank line counts (`atTopOfBody`, 2026-10-21): a part that opens with
 * text, a list or a picture has no title heading, whatever headings come later.
 *
 * - `own`: the first heading is `# Title`. That is the title, and it is never listed again as the part's
 *   first child. A frontmatter `title` that says something else makes `mismatch`.
 *   Also `own`: the first heading is at a lower level (`## Title`, `### Title`) and its text is the
 *   frontmatter `title` (or, with no `title`, the file-name title), letter case, footnote references and
 *   inline markers aside (`sameTitle`, `headingPlainText`; the mismatch rule compares the same way). It is
 *   the title too, at the level the writer gave it: WriteFlex proposes no change to its level (the writer's
 *   recorded choice, 2026-10-18). Decision: no new mode and no level field. Every consumer of `mode` asks
 *   "is the title in the text" (the Plan's flag, the Outline, the export's body), and for this part the
 *   answer is yes.
 * - `none`: the frontmatter says `heading: none` (a data set, a vignette, a part with only `###` headings).
 *   Its title is the frontmatter `title`, else the file name. Its text is never given a heading.
 * - `missing`: no first heading that is the title, and no `heading: none`. The title is the frontmatter `title`, else the file
 *   name; WriteFlex proposes a heading (folio-part-proposals.ts).
 *
 * Decision: a frontmatter with no `title` and a part with a `#` heading is NOT a mismatch. "Differ" needs
 * two texts, and writing a frontmatter block into every bare file would break ADR-0008 (bare files stay bare).
 */

import { parseFrontmatter } from '../main/frontmatter'
import { frontmatterBlock } from './markdown/frontmatter'
import { eolOf, layoutOf } from './markdown/frontmatter-edit'
import { parseMarkdownBlocks } from './markdown/dialect'

export type PartHeadingMode = 'own' | 'none' | 'missing'

export type PartTitle = {
  title: string
  mode: PartHeadingMode
  /** Where the title came from. */
  from: 'heading' | 'frontmatter' | 'file-name'
  /** The text of the `#` heading (mode `own`), else null. */
  headingText: string | null
  /** The frontmatter `title`, trimmed; null when absent or empty. */
  frontmatterTitle: string | null
  /** Mode `own`, a frontmatter `title` is present, and the two texts differ beyond letter case and spacing
   *  (`sameTitle`, as the export compares them): the app and the export would name the part differently.
   *  The title-conflict fixes (shared/title-conflict.ts) offer to make them one. */
  mismatch: boolean
}

// CommonMark: an ATX heading may be indented up to three spaces. The text runs to the end of the line and
// its trailing spaces are cut by `trimBlanksEnd`: a lazy `(.+?)[ \t]*$` retries the tail at every
// character and is quadratic on a long run of spaces.
const HEADING_LINE = /^( {0,3})(#{1,6})[ \t]+(.+)$/
// A fence opens with three or more of one character (a backtick fence's info string has no backtick) and
// closes only on the same character, at least as many, with nothing after but spaces.
const FENCE_OPEN = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/
const ORDER_PREFIX = /^\d+(?:[-_. ]+|$)/
// The start of a Pandoc attribute block's inside: `#id`, `.class`, `:` or `key=`. Anchored, so linear.
const ATTRIBUTE_START = /^[ \t]*(?:[#.:]|[\w-]+=)/

const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t'

/** `text` without trailing spaces and tabs (only those: `trimEnd` would also cut other white space). */
function trimBlanksEnd(text: string, end = text.length): string {
  while (end > 0 && isBlank(text[end - 1])) end -= 1
  return text.slice(0, end)
}

/*
 * The marker passes below are hand-written scans, each linear in the text's length, so a heading or a
 * frontmatter title of any length is read whole and nothing is cut (decision 2026-10-18: a cap cut the
 * returned title, which is the export's section heading). Each scan gives the result the commented regex
 * gives; the regexes themselves retry from every start and are quadratic on runs of `[`, `<!--`, spaces.
 */

/** `/[ \t]+#+[ \t]*$/` removed: a closing run of `#`s with a space before it. */
function dropClosingHashes(text: string): string {
  const end = trimBlanksEnd(text).length
  let hashes = end
  while (hashes > 0 && text[hashes - 1] === '#') hashes -= 1
  if (hashes === end || !isBlank(text[hashes - 1])) return text
  return trimBlanksEnd(text, hashes)
}

/** `/<!--[\s\S]*?-->/g` removed. */
function dropComments(text: string): string {
  let out = ''
  let from = 0
  for (;;) {
    const open = text.indexOf('<!--', from)
    if (open === -1) break
    const close = text.indexOf('-->', open + 4)
    // No close after this open: none after any later open either.
    if (close === -1) break
    out += text.slice(from, open)
    from = close + 3
  }
  return out + text.slice(from)
}

/** `/\[\^[^\]\s]+\]/g` removed: a footnote reference. */
function dropFootnoteReferences(text: string): string {
  let out = ''
  let from = 0
  let at = text.indexOf('[^')
  while (at !== -1) {
    let stop = at + 2
    while (stop < text.length && text[stop] !== ']' && !/\s/.test(text[stop])) stop += 1
    if (text[stop] === ']' && stop > at + 2) {
      out += text.slice(from, at)
      from = stop + 1
      at = text.indexOf('[^', from)
    } else {
      // Every `[^` between `at` and `stop` stops at the same character and fails the same way.
      at = text.indexOf('[^', Math.max(stop, at + 1))
    }
  }
  return out + text.slice(from)
}

/**
 * Every `[inside]` followed by `after` (a scan that returns the index past the match, or -1) replaced by
 * its inside: `/\[([^\]]*)\]AFTER/g` with `$1`. `prefix` is `[` or `[[`. All starts before the first `]`
 * share that `]`, so a failed start skips to it.
 */
function replaceBracketed(text: string, prefix: string, inside: (body: string) => string, after: (closeEnd: number) => number | null): string {
  let out = ''
  let from = 0
  let at = text.indexOf(prefix)
  while (at !== -1) {
    const close = text.indexOf(']', at + prefix.length)
    if (close === -1) break
    const end = after(close + 1)
    if (end === null) break
    if (end >= 0) {
      out += text.slice(from, at) + inside(text.slice(at + prefix.length, close))
      from = end
      at = text.indexOf(prefix, from)
    } else at = text.indexOf(prefix, close + 1)
  }
  return out + text.slice(from)
}

/** `/\[([^\]]*)\]\{[^{}]*\}/g` with `$1`: a bracketed span's brackets and attributes. */
function dropSpanAttributes(text: string): string {
  return replaceBracketed(text, '[', (body) => body, (at) => {
    if (text[at] !== '{') return -1
    let stop = at + 1
    while (stop < text.length && text[stop] !== '{' && text[stop] !== '}') stop += 1
    return text[stop] === '}' ? stop + 1 : -1
  })
}

/** `/[ \t]*\{[ \t]*(?:[#.:]|[\w-]+=)[^{}]*\}[ \t]*$/` removed: an attribute block at the end of the line. */
function dropTrailingAttributes(text: string): string {
  const end = trimBlanksEnd(text).length
  if (text[end - 1] !== '}') return text
  const open = text.lastIndexOf('{', end - 2)
  if (open === -1) return text
  const body = text.slice(open + 1, end - 1)
  if (body.includes('}') || !ATTRIBUTE_START.test(body)) return text
  return trimBlanksEnd(text, open)
}

/**
 * Whether the raw heading text, before any marker is stripped, ends in closing `#`s, then blanks, then a
 * trailing attribute block (`Old ## {#id}`). Linear: one trailing-attribute cut and one backwards hash scan.
 */
function endsInHashesBeforeAttributes(raw: string): boolean {
  const before = dropTrailingAttributes(raw)
  if (before === raw || !isBlank(raw[before.length])) return false
  return dropClosingHashes(before) !== before
}

/** `/\[\[([^\]|]*\|)?([^\]]*)\]\]/g` with `$2`: a wikilink's brackets and target. */
function dropWikilinks(text: string): string {
  return replaceBracketed(text, '[[', (body) => {
    const bar = body.indexOf('|')
    return bar === -1 ? body : body.slice(bar + 1)
  }, (at) => (text[at] === ']' ? at + 1 : -1))
}

/** `/\[([^\]]*)\]\([^)]*\)/g` with `$1`: a link's brackets and target. */
function dropLinkTargets(text: string): string {
  return replaceBracketed(text, '[', (body) => body, (at) => {
    if (text[at] !== '(') return -1
    const close = text.indexOf(')', at + 1)
    // No `)` after this one: no later link closes either.
    return close === -1 ? null : close + 1
  })
}

/**
 * A heading line's visible text: markdown emphasis, code ticks and wikilink brackets removed, trailing `#`s
 * dropped, and the inline markers that print no words of the title dropped too: footnote references
 * (`[^1]`), HTML tags and comments (their inner text stays; `<br>` is a space), a Pandoc attribute block at
 * the end of the line (`{.class}`, `{#id}`, `{key=value}`; mid-text braces stay) and closing `#`s before it, and a bracketed span's
 * brackets (`[text]{.mark}` is `text`). Only for comparing and naming: the heading's own bytes are never
 * rewritten from it. Also applied to a frontmatter `title`, so both sides of a comparison read alike.
 * Linear in the text's length, and the whole text is read: nothing is cut.
 */
export function headingPlainText(raw: string): string {
  const hashesBeforeAttributes = endsInHashesBeforeAttributes(raw)
  let text = dropClosingHashes(raw)
  text = dropComments(text)
  // Linear as regexes: `<br` and `<x` each scan only to the next `<` or `>`.
  text = text.replace(/<br[ \t]*\/?>/gi, ' ').replace(/<\/?[A-Za-z][^<>]*>/g, '')
  text = dropFootnoteReferences(text)
  text = dropSpanAttributes(text)
  const beforeAttributes = text
  text = dropTrailingAttributes(text)
  // `# Title ## {#id}`: closing `#`s before an attribute block are marks too (Pandoc reads "Title"). Only
  // when the raw text has them right before the block: `# Old ##[^1]` and `# Old ##[^1] {#id}` keep their
  // literal `##` ("Old ##"), as the document parser reads them; stripping the footnote must not expose them.
  if (hashesBeforeAttributes && text !== beforeAttributes) text = dropClosingHashes(text)
  text = dropWikilinks(text)
  text = dropLinkTargets(text)
  return text
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Where the writing starts (past a BOM and a frontmatter block). */
function bodyStart(source: string): number {
  const block = frontmatterBlock(source)
  if (block) return block.end
  return source.startsWith('﻿') ? 1 : 0
}

/** `hashes`: where the heading's `#`s start (past an indent of up to three spaces). */
export type BodyHeading = { level: number; text: string; lineStart: number; lineEnd: number; hashes: number }

/**
 * Every ATX heading line of the body (past frontmatter, outside code fences), in order: its level, its plain
 * text (possibly empty, as in `# **`), where its line starts, and where it ends (before the `\n`; a CRLF's
 * `\r` is inside). Setext headings are not ATX headings and are not here. An unclosed fence runs to the end.
 */
export function* bodyHeadingLines(source: string): Generator<BodyHeading> {
  let offset = bodyStart(source)
  let fence: string | null = null
  while (offset <= source.length) {
    const newline = source.indexOf('\n', offset)
    const end = newline === -1 ? source.length : newline
    const line = source.slice(offset, end).replace(/\r$/, '')
    if (fence !== null) {
      const close = FENCE_CLOSE.exec(line)
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null
    } else {
      const open = FENCE_OPEN.exec(line)
      if (open) fence = open[1]
      else {
        const match = HEADING_LINE.exec(line)
        if (match) yield { level: match[2].length, text: headingPlainText(trimBlanksEnd(match[3])), lineStart: offset, lineEnd: end, hashes: offset + match[1].length }
      }
    }
    if (newline === -1) break
    offset = newline + 1
  }
}

/** The first ATX heading of the body (past frontmatter, outside code fences): its level, text, and where its line starts and ends. */
export function firstBodyHeading(source: string): BodyHeading | null {
  // An empty heading (`# **`) names nothing; it does not count as a heading.
  for (const heading of bodyHeadingLines(source)) if (heading.text) return heading
  return null
}

/** Where the body's text starts: the start of its first non-blank line (past frontmatter and blank lines), else the end. */
export function bodyTextStart(source: string): number {
  let at = bodyStart(source)
  while (at < source.length) {
    const newline = source.indexOf('\n', at)
    const end = newline === -1 ? source.length : newline
    if (source.slice(at, end).trim() !== '') return at
    if (newline === -1) break
    at = newline + 1
  }
  return source.length
}

/**
 * THE top-of-body rule (Dominik, 2026-10-21: "the title=heading should only work for when the heading is the
 * first line in the doc"): whether offset `at` lies on the body's first non-blank line. Only a heading there
 * can name the document or the part, be compared with its `title:`, or be rewritten from it. A heading
 * further down is never the title, however it is written.
 */
export function atTopOfBody(source: string, at: number): boolean {
  const start = bodyTextStart(source)
  if (at < start) return false
  const newline = source.indexOf('\n', start)
  return at <= (newline === -1 ? source.length : newline)
}

/** The body's first ATX heading when it is on the body's first non-blank line (`atTopOfBody`), else null. */
export function topBodyHeading(source: string): BodyHeading | null {
  const heading = firstBodyHeading(source)
  return heading && atTopOfBody(source, heading.lineStart) ? heading : null
}

/** Whether the body's first block, on its first non-blank line, is a setext heading (`Title` over `===` or `---`).
 *  The part-title rule reads ATX headings only, so such a part has no title heading; nothing is inserted above it. */
export function opensWithSetextHeading(source: string): boolean {
  const offset = bodyStart(source)
  const first = parseMarkdownBlocks(source.slice(offset)).topNode.firstChild
  return first !== null && /^SetextHeading[12]$/.test(first.name) && atTopOfBody(source, first.from + offset)
}

/**
 * The text with `# Title` inserted at the top of the writing: past the frontmatter and any blank lines, with a
 * blank line after it (and one before it when the frontmatter runs straight into the text). Nothing else changes.
 * Null (nothing to insert) when the title is not one line, when the body opens with a setext heading, or when
 * the inserted line would not read back as the top heading saying the title: a title such as "T\n\n```" from
 * an escaped frontmatter string can never add a fence or any other block. Every caller gets this check.
 */
export function withTopHeading(source: string, title: string): string | null {
  if (title.trim() === '' || /[\r\n\u2028\u2029]/.test(title)) return null
  if (opensWithSetextHeading(source)) return null
  const eol = eolOf(source)
  const layout = layoutOf(source)
  let at = layout ? layout.end : source.startsWith('\uFEFF') ? 1 : 0
  for (;;) {
    const newline = source.indexOf('\n', at)
    const end = newline === -1 ? source.length : newline
    if (source.slice(at, end).trim() !== '' || newline === -1) break
    at = newline + 1
  }
  const prefix = source.slice(0, at)
  const rest = source.slice(at)
  const lead = prefix !== '' && !/(?:^|\r?\n)[ \t]*\r?\n$/.test(prefix) && layout ? eol : ''
  const heading = `${lead}# ${title}${rest.trim() === '' ? eol : eol + eol}`
  const next = `${prefix}${heading}${rest}`
  // Read back: the new line is the body's top heading, at level 1, saying the title; the text after it is as before.
  const top = topBodyHeading(next)
  if (!top || top.level !== 1 || top.lineStart !== at + lead.length || !sameTitle(top.text, headingPlainText(title))) return null
  if (next.slice(at + heading.length) !== rest) return null
  return next
}

/**
 * The title written twice: the next heading after the first has the same text, at the first one's level or
 * deeper (`# T` then `# T` or `## T`; `## T` then `## T`). That second heading, else null. Read by the
 * export only (`withoutOwnHeading`); WriteFlex proposes no removal of it.
 */
export function repeatedTitleHeading(source: string): BodyHeading | null {
  let first: BodyHeading | null = null
  for (const heading of bodyHeadingLines(source)) {
    if (!heading.text) continue
    if (!first) {
      first = heading
      continue
    }
    // Only blank lines between: a heading below opening text is the writer's, never a repeat of the title.
    const between = source.slice(first.lineEnd, heading.lineStart)
    return between.trim() === '' && heading.level >= first.level && sameTitle(heading.text, first.text) ? heading : null
  }
  return null
}

/** Words of a name: separators to spaces, sentence case. A word written in capitals (an acronym) is kept. */
function sentenceCase(words: string): string {
  const parts = words.split(' ').filter(Boolean)
  const cased = parts.map((word, index) => {
    const acronym = word.length > 1 && word === word.toLocaleUpperCase() && /\p{L}/u.test(word)
    const lower = acronym ? word : word.toLocaleLowerCase()
    return index === 0 ? lower.charAt(0).toLocaleUpperCase() + lower.slice(1) : lower
  })
  return cased.join(' ')
}

/**
 * A title from a file name: extension and leading order numbers removed, separators to spaces, sentence
 * case. `03-what-would-it-cost.md` gives "What would it cost". A name that is only a number keeps it.
 */
export function titleFromFileName(path: string): string {
  const name = (path.split('/').pop() ?? path).replace(/\.(?:md|markdown|mdx)$/i, '')
  const stripped = name.replace(ORDER_PREFIX, '')
  const base = stripped.trim() === '' ? name : stripped
  return sentenceCase(base.replace(/[-_.]+/g, ' ').replace(/\s+/g, ' ').trim()) || name
}

/** Whether the frontmatter says `heading: none` (any letter case, quotes allowed). */
export function declaresNoHeading(source: string): boolean {
  return saysNoHeading(parseFrontmatter(source))
}

/** `declaresNoHeading` over frontmatter already parsed. */
function saysNoHeading(frontmatter: ReturnType<typeof parseFrontmatter>): boolean {
  const value = frontmatter?.extra.heading
  return typeof value === 'string' && value.trim().toLocaleLowerCase() === 'none'
}

const spaced = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The same text, exactly, spacing aside: the frontmatter-mismatch rule. */
export const sameText = (a: string, b: string): boolean => spaced(a) === spaced(b)

/**
 * The same title, spacing and letter case aside (locale-aware; accents count): whether a heading is the
 * part's title, a heading repeats it, or an old proposal adds it. `Kapitola 4` is `KAPITOLA 4`, not `Kapitolá 4`.
 */
export const sameTitle = (a: string, b: string): boolean => spaced(a).localeCompare(spaced(b), undefined, { sensitivity: 'accent' }) === 0

/** `partTitle`, with the heading it found to be the title (mode `own`), else null. */
export function partTitleWithHeading(source: string, path: string): { named: PartTitle; heading: BodyHeading | null } {
  const frontmatter = parseFrontmatter(source)
  const frontmatterTitle = frontmatter?.title?.trim() || null
  // The frontmatter title read as a heading's text is, so markers on both sides compare alike (`T[^1]`).
  const plainTitle = frontmatterTitle === null ? null : headingPlainText(frontmatterTitle)
  const none = saysNoHeading(frontmatter)
  // Only a heading on the body's first line can be the title (`topBodyHeading`).
  const heading = none ? null : topBodyHeading(source)
  // A lower-level first heading is the title when it says what the title says.
  if (heading && (heading.level === 1 || sameTitle(heading.text, plainTitle ?? titleFromFileName(path)))) {
    const named: PartTitle = {
      title: heading.text,
      mode: 'own',
      from: 'heading',
      headingText: heading.text,
      frontmatterTitle,
      mismatch: plainTitle !== null && !sameTitle(plainTitle, heading.text),
    }
    return { named, heading }
  }
  const named: PartTitle = {
    title: frontmatterTitle ?? titleFromFileName(path),
    mode: none ? 'none' : 'missing',
    from: frontmatterTitle !== null ? 'frontmatter' : 'file-name',
    headingText: null,
    frontmatterTitle,
    mismatch: false,
  }
  return { named, heading: null }
}

/**
 * Whether the part's first body heading is the part's own title under the current rule (option C): a `#`
 * first heading, or a lower first heading whose text is the title by `sameTitle`. Never with `heading: none`.
 * Backed by `partTitle`, so the rule lives in one place.
 */
export function firstHeadingIsPartTitle(source: string, path: string): boolean {
  return partTitle(source, path).mode === 'own'
}

/** The one answer to "what is this part called, and does it have its own heading". */
export function partTitle(source: string, path: string): PartTitle {
  return partTitleWithHeading(source, path).named
}

/**
 * The headings a part's rows list under it: one title per part. A part with its own `#` heading does not
 * list that heading again (it is the part's name). Then any leading headings whose text equals the part's
 * `title` (`headingPlainText`, then `sameTitle`: letter case aside, as the export's `repeatedTitleHeading`
 * reads it) are dropped too, whatever their level, so `# T` then `## t` shows neither and `## T` alone under
 * a frontmatter title T shows nothing. A leading heading with different text is still listed, and only a
 * leading run is ever dropped. Mode `none` lists every heading: its title is not in the text.
 */
export function partChildHeadings<T extends { level: number; text?: string }>(headings: readonly T[], mode: PartHeadingMode, title?: string): T[] {
  // `none`: the title is not in the text, so no heading is the title and every heading is listed.
  if (mode === 'none') return headings.slice()
  let skip = mode === 'own' && headings.length > 0 && headings[0].level === 1 ? 1 : 0
  // Only a part whose title heading is at the top drops a leading run that repeats the title. In `missing` the
  // title is not in the text, and any heading saying it sits below opening text: it is the writer's, so it is listed.
  if (title !== undefined && mode === 'own') {
    const wanted = headingPlainText(title)
    while (wanted && skip < headings.length && typeof headings[skip].text === 'string' && sameTitle(headingPlainText(headings[skip].text as string), wanted)) skip += 1
  }
  return headings.slice(skip)
}

/** Where a heading line's removal ends: past its newline and one blank line after it. */
export function headingRemovalEnd(source: string, heading: Pick<BodyHeading, 'lineEnd'>): number {
  let end = heading.lineEnd < source.length ? heading.lineEnd + 1 : source.length
  // One blank line after the heading goes with it.
  const next = source.indexOf('\n', end)
  const following = source.slice(end, next === -1 ? source.length : next)
  if (end < source.length && following.trim() === '') end = next === -1 ? source.length : next + 1
  return end
}

/**
 * The part's text without its own title heading line (and the blank line after it), for an export that
 * prints the part's title once as the section heading. The title heading is the `#` heading, or a lower
 * first heading that is the title (`partTitle`; `path` gives the file-name title). A title written
 * twice (`# T` then `# T` or `## T`; `## T` then `## T`) loses both. Other texts are returned unchanged.
 */
export function withoutOwnHeading(source: string, path: string): string {
  const { heading } = partTitleWithHeading(source, path)
  if (!heading) return source
  const repeated = repeatedTitleHeading(source)
  const rest = repeated ? source.slice(0, repeated.lineStart) + source.slice(headingRemovalEnd(source, repeated)) : source
  return rest.slice(0, heading.lineStart) + rest.slice(headingRemovalEnd(rest, heading))
}
