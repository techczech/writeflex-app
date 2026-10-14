/**
 * The RTF emitter (Round B T3) — the flavour Word, Teams and Outlook actually respect.
 *
 * HTML alone is why a paste into Teams or Word arrives restyled or flattened: those applications
 * negotiate the clipboard and treat RTF as the authoritative flavour when it is offered. So a rich
 * copy offers it, rendered from the SAME document model as the HTML and plain flavours — three
 * renderings of one reading, never three parsers.
 *
 * RTF is plain text, so there is no dependency here and none is wanted. The two rules that break
 * hand-rolled writers are obeyed throughout: `\`, `{` and `}` in writer text are escaped so they can
 * never become structure, and every non-ASCII character leaves as `\uN?` (signed 16-bit code units,
 * astral characters as their surrogate pair) so Czech text and em-dashes survive.
 */
import { readDocument, type Block, type Inline, type ListLettering } from './model'
import { labelFor } from './fancy-lists'
import { isSvgFence } from '../sanitise-svg'
import type { WikilinkPolicy } from './to-html'
import { safeUrl } from './url-safety'

/**
 * A picture ready for the clipboard. RTF hosts one as `{\pict\pngblip …hex…}` — which is exactly how
 * Word, Teams and Outlook receive a pasted image — so a picture arrives as BYTES here, never as a
 * path. `pixels` is the bytes' own size (`\picw`/`\pich`); `width`/`height` are the size to DRAW it
 * at in px, which becomes `\picwgoal`/`\pichgoal` in twips. The two differ when a vector source was
 * rasterised above its nominal size, or when a wide picture was scaled into the text column.
 */
export type RtfPicture = {
  data: Uint8Array
  type: 'png' | 'jpg'
  pixels: { width: number; height: number }
  width: number
  height: number
}

/** What becomes of `![alt](src)`. `'alt'` keeps the words that describe it (a remote picture, or one
 *  whose file could not be read); the resolver form carries the bytes. */
export type RtfImagePolicy = 'alt' | { resolve: (src: string) => RtfPicture | null }

export type RtfOptions = {
  /** Default `'text'` — the disappearing-wikilink law. A resolver turns a target into an internal
   *  bookmark name (`HYPERLINK \\l`), and declining leaves the label text. */
  wikilinks?: WikilinkPolicy
  /** Default `'alt'`. Only a caller that can read a disk (the main process) can supply pictures. */
  images?: RtfImagePolicy
  /** What becomes of a ```svg fence. Default `'code'` — the shaded monospace block. The resolver
   *  form draws it, which needs a rasteriser and therefore a caller outside this module. */
  svgFences?: 'code' | { resolve: (source: string) => RtfPicture | null }
}

// Half-points: the body is 12pt, headings step down from 18pt. Kept in one place so the three
// flavours' visual hierarchies stay recognisably the same document.
const HEADING_SIZE: Record<number, number> = { 1: 36, 2: 32, 3: 28, 4: 26, 5: 24, 6: 24 }
const BODY_SIZE = 24
const INDENT = 720 // twips per list/quote level (half an inch)
const TABLE_WIDTH = 9360 // twips: 6.5in of text between one-inch margins
const TWIPS_PER_PX = 15 // 1440 twips per inch at 96 dpi

/**
 * Writer text as RTF. Structural characters are escaped; every non-ASCII character becomes a signed
 * `\uN?` escape (the `?` is the single-byte fallback promised by `\uc1` in the header).
 */
export function escapeRtf(text: string): string {
  let out = ''
  for (const character of text) {
    if (character === '\\') { out += '\\\\'; continue }
    if (character === '{') { out += '\\{'; continue }
    if (character === '}') { out += '\\}'; continue }
    if (character === '\n') { out += '\\line '; continue }
    if (character === '\t') { out += '\\tab '; continue }
    const code = character.codePointAt(0) ?? 0
    if (code < 128) { out += character; continue }
    for (let unit = 0; unit < character.length; unit += 1) {
      const value = character.charCodeAt(unit)
      out += `\\u${value > 32767 ? value - 65536 : value}?`
    }
  }
  return out
}

/** A hyperlink field. `internal` writes `\\l`, the bookmark form a bundle would use. */
function hyperlink(target: string, body: string, internal: boolean): string {
  const destination = internal ? `\\\\l "${escapeRtf(target)}"` : `"${escapeRtf(target)}"`
  return `{\\field{\\*\\fldinst{HYPERLINK ${destination}}}{\\fldrslt{\\cf2\\ul ${body}}}}`
}

const HEX = '0123456789abcdef'

/** Picture bytes as the hex RTF wants, wrapped so no line grows unbounded (readers have limits, and
 *  a megabyte on one line is what breaks the ones that do). Written by hand rather than through
 *  `Buffer`, because this module is shared and must not assume Node. */
function hex(bytes: Uint8Array): string {
  const lines: string[] = []
  let line = ''
  for (const byte of bytes) {
    line += HEX[byte >> 4] + HEX[byte & 15]
    if (line.length >= 128) { lines.push(line); line = '' }
  }
  if (line) lines.push(line)
  return lines.join('\n')
}

/**
 * One picture group. `\picw`/`\pich` are the bytes' own pixels; the `goal` pair is the drawn size in
 * twips, which is what a reader honours when the two disagree. Written as a PLAIN `{\pict}` rather
 * than Word's `{\*\shppict …}` wrapper: `\*` means "skip this whole group if you do not know it",
 * so the wrapper is how a picture arrives as nothing in a reader that is not Word.
 */
function picture(part: RtfPicture): string {
  const blip = part.type === 'jpg' ? '\\jpegblip' : '\\pngblip'
  const geometry = `\\picw${part.pixels.width}\\pich${part.pixels.height}`
    + `\\picwgoal${Math.round(part.width * TWIPS_PER_PX)}\\pichgoal${Math.round(part.height * TWIPS_PER_PX)}`
  return `{\\pict${blip}${geometry}\n${hex(part.data)}}`
}

type Emitter = { wikilinks: WikilinkPolicy; images: RtfImagePolicy; svgFences: NonNullable<RtfOptions['svgFences']> }

function inlines(parts: Inline[], emitter: Emitter): string {
  return parts.map((part) => inline(part, emitter)).join('')
}

function inline(part: Inline, emitter: Emitter): string {
  switch (part.kind) {
    case 'text': return escapeRtf(part.text)
    case 'emphasis': return `{\\i ${inlines(part.children, emitter)}}`
    case 'strong': return `{\\b ${inlines(part.children, emitter)}}`
    case 'strike': return `{\\strike ${inlines(part.children, emitter)}}`
    case 'mark': return `{\\highlight4 ${inlines(part.children, emitter)}}`
    case 'code': return `{\\f1 ${escapeRtf(part.text)}}`
    case 'break': return '\\line '
    // Raw HTML is the writer's own characters here too — shown, never interpreted.
    case 'html': return escapeRtf(part.text)
    case 'link': {
      // The SAME rule the HTML flavour applies (url-safety.ts). Word follows a HYPERLINK field on a
      // click, so a destination it will not open safely must not be written into one; the label
      // stays as ordinary words, exactly as it does in HTML.
      const href = safeUrl(part.href, 'link')
      const body = inlines(part.children, emitter)
      return href === null ? body : hyperlink(href, body, false)
    }
    case 'image': {
      // A clipboard RTF CAN host a picture — `{\pict\pngblip …}` is how Word and Teams receive a
      // pasted image — so bytes travel when the caller could read them, and the words that describe
      // the picture travel when it could not (a remote address, or a file that is not there).
      if (emitter.images === 'alt') return escapeRtf(part.alt)
      const found = emitter.images.resolve(part.src)
      return found ? picture(found) : escapeRtf(part.alt)
    }
    case 'wikilink': {
      const label = escapeRtf(part.label)
      if (emitter.wikilinks === 'text') return label
      const anchor = emitter.wikilinks.resolve(part.target)
      return anchor ? hyperlink(anchor, label, true) : label
    }
    // The mark is a plain superscript number and the notes are gathered at the end of the text
    //  rather than becoming `\footnote` notes: it is what the PRD
    // asks for, it is what the HTML flavour does — the flavours must agree — and it is the only
    // form that survives a target which flattens footnote structure.
    case 'footnote': return `{\\super ${part.index}}`
  }
}

/** One paragraph: its own `\pard` reset, so nothing is inherited from what came before. */
function paragraph(body: string, controls: string): string {
  return `\\pard${controls} ${body}\\par\n`
}

function blocks(list: Block[], emitter: Emitter, indent: number): string {
  return list.map((entry) => block(entry, emitter, indent)).join('')
}

/**
 * The marker is written as LITERAL text followed by a tab, against a hanging indent — the sane
 * degradation the plan asks for, and the only one that is visible everywhere. An RTF list table
 * (`\ls`/`\listtext`) would give Word a real list, but a reader that cannot resolve the table shows
 * no marker at all: `textutil` (the AppKit engine behind Mail, Notes and TextEdit) drops a legacy
 * `{\pntext …}` bullet silently. A bullet a reader can see beats a list structure it may not.
 */
function listMarker(ordered: boolean, index: number, start: number, task: 'todo' | 'done' | null, lettering?: ListLettering): string {
  const box = task === null ? '' : task === 'done' ? escapeRtf('☑ ') : escapeRtf('☐ ')
  const marker = ordered
    ? lettering ? `${labelFor(start + index, lettering.numbering)}${lettering.delimiter}` : `${start + index}.`
    : escapeRtf('•')
  return `${marker}\\tab ${box}`
}

function block(entry: Block, emitter: Emitter, indent: number): string {
  const left = indent > 0 ? `\\li${indent}` : ''
  switch (entry.kind) {
    case 'heading':
      // `\sN` is what makes this a real Heading N in Word — the navigation pane, a table of contents
      // and anyone else's restyling all read the STYLE, not the size. `\outlinelevel` says the same
      // thing to a reader that resolves outline structure without the stylesheet. The size and the
      // bold stay as direct formatting so the hierarchy still shows in a reader that has neither.
      return paragraph(
        `${inlines(entry.children, emitter)}}`,
        `${left}\\s${entry.level}\\outlinelevel${entry.level - 1}\\keepn\\sb240\\sa120{\\b\\fs${HEADING_SIZE[entry.level] ?? BODY_SIZE}`,
      )
    case 'paragraph':
      return paragraph(inlines(entry.children, emitter), `${left}\\sa180\\fs${BODY_SIZE}`)
    case 'quote':
      // An indented, grey, italic paragraph run — the quote's own look, inherited from nothing.
      return blocks(entry.children, emitter, indent + INDENT)
        .replace(/\\pard/g, '\\pard\\cf3\\i')
    case 'list':
      return entry.items.map((item, index) => {
        const [first, ...rest] = item.children
        const marker = listMarker(entry.ordered, index, entry.start, item.task, entry.lettering)
        const head = first && first.kind === 'paragraph'
          ? paragraph(`${marker}${inlines(first.children, emitter)}`, `\\fi-360\\li${indent + INDENT}\\sa60\\fs${BODY_SIZE}`)
          : paragraph(marker, `\\fi-360\\li${indent + INDENT}\\sa60\\fs${BODY_SIZE}`)
        const tail = first && first.kind === 'paragraph'
          ? blocks(rest, emitter, indent + INDENT)
          : blocks(item.children, emitter, indent + INDENT)
        return head + tail
      }).join('')
    case 'code': {
      // A ```svg fence is drawn, not printed — the same ruling the HTML flavour follows. A fence the
      // sanitiser refuses, or one the rasteriser could not draw, falls back to its source.
      if (isSvgFence(entry.language) && emitter.svgFences !== 'code') {
        const drawn = emitter.svgFences.resolve(entry.text)
        if (drawn) return paragraph(picture(drawn), `${left}\\sa180`)
      }
      return entry.text.split('\n').map((line) =>
        paragraph(`{\\f1\\fs20 ${escapeRtf(line)}}`, `\\li${indent + 360}\\sa0`)).join('')
    }
    case 'rule':
      return `\\pard${left}\\brdrb\\brdrs\\brdrw10\\brsp20 \\par\n`
    case 'html':
      return paragraph(`{\\f1\\fs20 ${escapeRtf(entry.text)}}`, `${left}\\sa180`)
    case 'widget':
      return paragraph(escapeRtf(entry.source), `${left}\\sa180`)
    case 'table':
      return table(entry, emitter)
  }
}

/**
 * A table row is written with the cells it HAS, never padded here. The reader (model.ts) has
 * already made the table rectangular wherever that is cheap; a table it left ragged is one whose
 * padding would multiply its size (one 20,000-cell row over 20,000 short rows), and padding it here
 * would bring that back. Every cell has the same width, the page divided by the widest row, so the
 * columns of a ragged table still line up. The widest row is found with a loop, not a spread, which
 * overflows the stack on a table of a few hundred thousand rows.
 */
function table(entry: Extract<Block, { kind: 'table' }>, emitter: Emitter): string {
  let columns = Math.max(entry.header.length, 1)
  for (const cells of entry.rows) if (cells.length > columns) columns = cells.length
  const width = Math.floor(TABLE_WIDTH / columns)
  const borders = '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10'
  // One definition per row LENGTH, built once: a rectangular table has one, as before.
  const definitions = new Map<number, string>()
  const definition = (count: number): string => {
    let found = definitions.get(count)
    if (found === undefined) {
      found = `\\trowd\\trgaph108\\trleft0${Array.from({ length: count }, (_unused, index) => `${borders}\\cellx${width * (index + 1)}`).join('')}`
      definitions.set(count, found)
    }
    return found
  }
  const row = (cells: Inline[][], header: boolean): string => {
    const count = Math.max(cells.length, 1) // a row needs a cell: `|` alone is one empty cell
    const body = Array.from({ length: count }, (_unused, index) => {
      const content = cells[index] ? inlines(cells[index], emitter) : ''
      return `\\pard\\intbl\\fs${BODY_SIZE} ${header ? `{\\b ${content}}` : content}\\cell`
    }).join('')
    return `${definition(count)}\n${body}\\row\n`
  }
  const head = entry.header.length ? row(entry.header, true) : ''
  return `${head}${entry.rows.map((cells) => row(cells, false)).join('')}\\pard\\sa180\\fs${BODY_SIZE}\n`
}

/**
 * The style table. Word maps a paragraph style to its OWN built-in Heading 1–6 by the style's NAME
 * (`heading 1`… lower-case, exactly), which is what a pasted document needs for the navigation pane
 * and a table of contents to work in it. `\sbasedon0\snext0` says the styles descend from Normal
 * and that the paragraph after a heading is ordinary prose — without `\snext0` a writer pressing
 * Return at the end of a heading gets another heading.
 */
function stylesheet(): string {
  const entries = [`{\\s0\\ql\\f0\\fs${BODY_SIZE}\\snext0 Normal;}`]
  for (let level = 1; level <= 6; level += 1) {
    entries.push(
      `{\\s${level}\\ql\\keepn\\sb240\\sa120\\outlinelevel${level - 1}`
      + `\\b\\f0\\fs${HEADING_SIZE[level] ?? BODY_SIZE}\\sbasedon0\\snext0 heading ${level};}`,
    )
  }
  return `{\\stylesheet${entries.join('')}}`
}

/**
 * Render Markdown as a complete RTF document. Frontmatter and comments are gone before the parse
 * (model.ts), so they cannot reach the output by any path.
 */
export function toRtf(markdown: string, options: RtfOptions = {}): string {
  const emitter: Emitter = {
    wikilinks: options.wikilinks ?? 'text',
    images: options.images ?? 'alt',
    svgFences: options.svgFences ?? 'code',
  }
  const document = readDocument(markdown)
  const body = blocks(document.blocks, emitter, 0)
  const notes = document.footnotes.length
    ? `\\pard\\sa60\\brdrt\\brdrs\\brdrw10\\brsp20\\fs20 \\par\n` + document.footnotes.map((note) => {
      const content = note.children
        .map((child) => (child.kind === 'paragraph' ? inlines(child.children, emitter) : blocks([child], emitter, 0)))
        .join(' ')
      return paragraph(`{\\super ${note.index}} ${content}`, `\\sa60\\fs20`)
    }).join('')
    : ''
  return [
    '{\\rtf1\\ansi\\ansicpg1252\\uc1\\deff0',
    '{\\fonttbl{\\f0\\froman\\fcharset0 Georgia;}{\\f1\\fmodern\\fcharset0 Courier New;}{\\f2\\fswiss\\fcharset0 Helvetica;}}',
    '{\\colortbl;\\red38\\green38\\blue42;\\red46\\green107\\blue230;\\red102\\green102\\blue102;\\red255\\green243\\blue196;}',
    stylesheet(),
    `\\f0\\fs${BODY_SIZE}\\cf1`,
    body + notes,
    '}',
  ].join('\n')
}
