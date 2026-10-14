/**
 * The Word emitter (Round B T6) — a fourth rendering of the shared document model.
 *
 * It renders the SAME `MarkdownDocument` the HTML, RTF and plain flavours render (model.ts). It does
 * not re-parse the source, because a second reading is how the flavours drift apart: everything the
 * app must never let out (frontmatter, comments) is already gone by the time a model exists, and the
 * disappearing-wikilink law has already been applied to it.
 *
 * Word is a page, not a stream, so a few things are said differently: a code block is a shaded
 * monospace paragraph rather than a `<pre>`, and footnotes are gathered into a Notes section at the
 * end rather than becoming Word's own `\footnote` apparatus — the same ruling the RTF flavour
 * follows , and the form that survives a document someone else re-styles.
 *
 * Images arrive as BYTES from the caller (main process), never read here: this module stays pure
 * apart from the `docx` library itself.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  Paragraph,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from 'docx'
import { readDocument, type Alignment, type Block, type Footnote, type Inline, type ListLettering, type MarkdownDocument } from './model'
import { labelFor, type FancyNumbering, type ListDelimiter } from './fancy-lists'
import { safeUrl } from './url-safety'
import { isSvgFence } from '../sanitise-svg'

/** A picture ready for Word: the bytes, the format tag `docx` needs, and the size to draw it at.
 *  The caller (main/export.ts) reads and measures the file; this module never touches a disk. */
export type DocxImage = { data: Uint8Array; type: 'png' | 'jpg' | 'gif' | 'bmp'; width: number; height: number }

/** What becomes of `![alt](src)`. `'omit'` keeps the alt text only; the resolver form returns the
 *  picture, or null for a file that could not be read — a null is recorded in `missingImages`, so an
 *  export completes and REPORTS rather than silently dropping (the PRD's states table). */
export type DocxImagePolicy = 'omit' | { resolve: (src: string) => DocxImage | null }

export type DocxOptions = {
  /** Default `'omit'`. */
  images?: DocxImagePolicy
  /** What becomes of a ```svg fence. Default `'code'` — the shaded monospace block. The resolver
   *  form draws it, which needs a rasteriser and therefore a caller outside this module. */
  svgFences?: 'code' | { resolve: (source: string) => DocxImage | null }
  /** Heading levels shift by this much, clamped to 1–6 — the bundle demotes each piece's headings
   *  so the section title it generates can sit above them. */
  headingOffset?: number
  /** Namespaces nothing (Word has no anchors here) but keeps footnote numbers apart when several
   *  documents are concatenated into one file: notes are numbered per piece and prefixed with it. */
  notePrefix?: string
}

/** Word paragraphs and tables, in order, plus whatever could not be drawn. */
export type DocxContent = { children: (Paragraph | Table)[]; missingImages: string[] }

const ORDERED = 'wf-ordered'

/** Word's numbering format for each lettered or roman style (fancy-lists.ts). */
const LETTERED_FORMATS: ReadonlyArray<[FancyNumbering, (typeof LevelFormat)[keyof typeof LevelFormat]]> = [
  ['lower-alpha', LevelFormat.LOWER_LETTER],
  ['upper-alpha', LevelFormat.UPPER_LETTER],
  ['lower-roman', LevelFormat.LOWER_ROMAN],
  ['upper-roman', LevelFormat.UPPER_ROMAN],
]
const DELIMITERS: readonly ListDelimiter[] = ['.', ')']

/** The numbering definition an ordered list uses: plain numbers, or its letters and delimiter. */
function numberingReference(lettering: ListLettering | undefined): string {
  return lettering ? `wf-${lettering.numbering}-${lettering.delimiter === ')' ? 'paren' : 'dot'}` : ORDERED
}
/** 12pt Georgia body, in half-points as Word counts them. */
const BODY_SIZE = 24
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const

/** Word's default bullet geometry (docx's default-bullet-numbering: 0.5in per level, 0.25in hang),
 *  which a boxed task item reuses so it lines up with the bullets around it. */
const TASK_INDENT_STEP = 720
const TASK_HANGING = 360

const CODE_SHADING = { type: ShadingType.CLEAR, color: 'auto', fill: 'F4F4F4' }
const MARK_SHADING = { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF3C4' }

type Emitter = {
  images: DocxImagePolicy
  svgFences: NonNullable<DocxOptions['svgFences']>
  headingOffset: number
  missingImages: string[]
  ordered: { instance: number }
}

type RunStyle = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean; mark?: boolean }

function runs(parts: Inline[], style: RunStyle, emitter: Emitter): ParagraphChild[] {
  return parts.flatMap((part) => run(part, style, emitter))
}

function text(value: string, style: RunStyle): TextRun {
  return new TextRun({
    text: value,
    ...(style.bold ? { bold: true } : {}),
    ...(style.italics ? { italics: true } : {}),
    ...(style.strike ? { strike: true } : {}),
    ...(style.code ? { font: 'Consolas', size: BODY_SIZE - 2, shading: CODE_SHADING } : {}),
    ...(style.mark ? { shading: MARK_SHADING } : {}),
  })
}

function run(part: Inline, style: RunStyle, emitter: Emitter): ParagraphChild[] {
  switch (part.kind) {
    case 'text': return [text(part.text, style)]
    case 'emphasis': return runs(part.children, { ...style, italics: true }, emitter)
    case 'strong': return runs(part.children, { ...style, bold: true }, emitter)
    case 'strike': return runs(part.children, { ...style, strike: true }, emitter)
    case 'mark': return runs(part.children, { ...style, mark: true }, emitter)
    case 'code': return [text(part.text, { ...style, code: true })]
    // Raw HTML the writer typed is SHOWN as characters, never interpreted — a Word document opened
    // by someone else must not carry markup that pretends to be structure.
    case 'html': return [text(part.text, { ...style, code: true })]
    case 'break': return [new TextRun({ text: '', break: 1 })]
    // The disappearing-wikilink law: the label, as ordinary words. Word has no internal anchors in
    // a bundle either (ADR-0029), so this is the same in both scopes.
    case 'wikilink': return [text(part.label, style)]
    case 'footnote': return [new TextRun({ text: String(part.index), superScript: true })]
    case 'link': {
      const href = safeUrl(part.href, 'link')
      const body = runs(part.children, style, emitter)
      if (href === null) return body
      return [new ExternalHyperlink({ children: body, link: href })]
    }
    case 'image': return [image(part, style, emitter)]
  }
}

/** A picture, or its alt text when the file could not be drawn. Word cannot show a remote URL, so a
 *  `http(s)` source is alt text too — the resolver decides, and records what it could not take. */
function image(part: Extract<Inline, { kind: 'image' }>, style: RunStyle, emitter: Emitter): ParagraphChild {
  if (emitter.images === 'omit') return text(part.alt, style)
  const picture = emitter.images.resolve(part.src)
  if (picture === null) {
    emitter.missingImages.push(part.src)
    return text(part.alt, style)
  }
  return new ImageRun({
    type: picture.type,
    data: picture.data,
    transformation: { width: picture.width, height: picture.height },
    ...(part.alt ? { altText: { name: part.alt, description: part.alt, title: part.title ?? part.alt } } : {}),
  })
}

function paragraph(children: ParagraphChild[], options: IParagraphOptions = {}): Paragraph {
  return new Paragraph({ spacing: { after: 160 }, ...options, children })
}

/** Where a block sits: how deep it is nested, and whether it is inside a quotation (which Word says
 *  with an indent and a rule down the left edge, as the HTML flavour says it with a border). */
type Place = { depth: number; quote: boolean }

function blocks(list: Block[], emitter: Emitter, place: Place): (Paragraph | Table)[] {
  return list.flatMap((entry) => block(entry, emitter, place))
}

function block(entry: Block, emitter: Emitter, place: Place): (Paragraph | Table)[] {
  const { depth } = place
  const indent = {
    ...(depth ? { indent: { left: 360 * depth } } : {}),
    ...(place.quote
      ? { border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'CCCCCC', space: 10 } } }
      : {}),
  }
  switch (entry.kind) {
    case 'heading': {
      const level = Math.min(6, Math.max(1, entry.level + emitter.headingOffset))
      return [paragraph(runs(entry.children, {}, emitter), { heading: HEADING_LEVELS[level - 1], spacing: { before: 240, after: 120 }, ...indent })]
    }
    case 'paragraph': {
      const children = runs(entry.children, {}, emitter)
      return children.length ? [paragraph(children, indent)] : []
    }
    // A quotation is indented with a rule down its left edge — Word's own way of saying the same
    // thing the HTML flavour says with a border.
    case 'quote':
      return blocks(entry.children, emitter, { depth: depth + 1, quote: true })
    case 'list': {
      const instance = entry.ordered ? (emitter.ordered.instance += 1) : 0
      return entry.items.flatMap((item, index) => {
        const box = item.task === null ? '' : item.task === 'done' ? '☑' : '☐'
        const [first, ...rest] = item.children
        // A box stands in for the bullet (the locked export frame, docs/design/2026-09-27-checkbox-
        // lists): an unordered task item is the bullet's own indent with the box where the dot was
        // and a tab to the text, so a wrapped line hangs under the words. A numbered one keeps its
        // number and puts the box before the words.
        const boxedBullet = box !== '' && !entry.ordered
        const lead = first && first.kind === 'paragraph'
          ? [paragraph(
              boxedBullet
                ? [text(box, {}), new TextRun({ children: [new Tab()] }), ...runs(first.children, {}, emitter)]
                : [...(box ? [text(`${box} `, {})] : []), ...runs(first.children, {}, emitter)],
              entry.ordered
                ? { numbering: { reference: numberingReference(entry.lettering), level: Math.min(2, depth), instance }, spacing: { after: 80 } }
                : boxedBullet
                  ? { indent: { left: TASK_INDENT_STEP * (Math.min(4, depth) + 1), hanging: TASK_HANGING }, spacing: { after: 80 } }
                  : { bullet: { level: Math.min(4, depth) }, spacing: { after: 80 } },
            )]
          : []
        const tail = first && first.kind === 'paragraph' ? rest : item.children
        // An ordered list that starts at 7 says so in its first item, because Word's numbering
        // restarts at 1 per instance and a silently renumbered list is a changed document.
        const opener = entry.ordered && index === 0 && entry.start !== 1
          ? [paragraph([text(`(continuing from ${entry.lettering ? labelFor(entry.start, entry.lettering.numbering) : entry.start})`, { italics: true })], { spacing: { after: 40 }, ...indent })]
          : []
        return [...opener, ...lead, ...blocks(tail, emitter, { depth: depth + 1, quote: place.quote })]
      })
    }
    case 'code': {
      // A ```svg fence is DRAWN — the editor draws it, so the Word document does too. A fence the
      // sanitiser refuses, or one the rasteriser could not draw, falls back to its source.
      if (isSvgFence(entry.language) && emitter.svgFences !== 'code') {
        const drawn = emitter.svgFences.resolve(entry.text)
        if (drawn) {
          return [paragraph(
            [new ImageRun({ type: drawn.type, data: drawn.data, transformation: { width: drawn.width, height: drawn.height } })],
            indent,
          )]
        }
      }
      return entry.text.replace(/\n$/, '').split('\n').map((line) => paragraph(
        [new TextRun({ text: line, font: 'Consolas', size: BODY_SIZE - 4 })],
        { shading: CODE_SHADING, spacing: { after: 0 }, indent: { left: 360 * (depth + 1) } },
      ))
    }
    case 'rule':
      return [new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 1 } }, spacing: { before: 200, after: 200 }, children: [] })]
    case 'html':
      return [paragraph([text(entry.text, { code: true })], indent)]
    case 'widget':
      return [paragraph([text(entry.source, {})], indent)]
    case 'table': {
      const cell = (content: Inline[], header: boolean, index: number): TableCell => new TableCell({
        children: [paragraph(runs(content, header ? { bold: true } : {}, emitter), { spacing: { after: 0 }, alignment: alignment(entry.alignments[index]) })],
        ...(header ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F0F0F0' } } : {}),
      })
      const rows = [
        ...(entry.header.length ? [new TableRow({ tableHeader: true, children: entry.header.map((content, index) => cell(content, true, index)) })] : []),
        // A row Word can open has at least one cell: a row read with none (`|` alone, in a table the
        // reader left ragged) gets one empty cell.
        ...entry.rows.map((row) => new TableRow({ children: (row.length ? row : [[]]).map((content, index) => cell(content, false, index)) })),
      ]
      if (!rows.length) return []
      // A table must be followed by a paragraph or Word glues the next block to it.
      return [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }), paragraph([], { spacing: { after: 120 } })]
    }
  }
}

function alignment(align: Alignment | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  return align === 'centre' ? AlignmentType.CENTER : align === 'right' ? AlignmentType.RIGHT : undefined
}

function notes(footnotes: Footnote[], emitter: Emitter, prefix: string): (Paragraph | Table)[] {
  if (!footnotes.length) return []
  return [
    new Paragraph({
      border: { top: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 6 } },
      spacing: { before: 320, after: 120 },
      children: [new TextRun({ text: 'Notes', bold: true, size: BODY_SIZE - 2 })],
    }),
    ...footnotes.flatMap((note) => {
      const [first, ...rest] = note.children
      const lead = first && first.kind === 'paragraph' ? runs(first.children, {}, emitter) : []
      return [
        paragraph([new TextRun({ text: `${prefix}${note.index}. `, bold: true, size: BODY_SIZE - 2 }), ...lead], { spacing: { after: 60 } }),
        ...blocks(first && first.kind === 'paragraph' ? rest : note.children, emitter, { depth: 1, quote: false }),
      ]
    }),
  ]
}

function emitterFor(options: DocxOptions): Emitter {
  return {
    images: options.images ?? 'omit',
    svgFences: options.svgFences ?? 'code',
    headingOffset: options.headingOffset ?? 0,
    missingImages: [],
    ordered: { instance: 0 },
  }
}

/**
 * One document's Word content, for a caller that is assembling several of them into one file (the
 * Collection bundle). `docxFile` wraps content in the document shell.
 */
export function docxContent(document: MarkdownDocument, options: DocxOptions = {}): DocxContent {
  const emitter = emitterFor(options)
  const children = [
    ...blocks(document.blocks, emitter, { depth: 0, quote: false }),
    ...notes(document.footnotes, emitter, options.notePrefix ?? ''),
  ]
  return { children, missingImages: emitter.missingImages }
}

/** One piece of a Collection bundle: the title the section carries, and its already-read model. */
export type DocxPiece = { title: string; document: MarkdownDocument }

/**
 * A whole Collection as ONE Word document: every piece a section, in the Collection's order, each
 * under its own Heading 1 with the piece's own headings demoted beneath it, and a page break
 * between them. There is no contents list and there are no internal links — Word gets its
 * navigation from the heading styles themselves (ADR-0029: the bundle in Word is the same ordering,
 * minus the anchors).
 */
export function docxBundleContent(pieces: DocxPiece[], options: DocxOptions = {}): DocxContent {
  const missingImages: string[] = []
  const children: (Paragraph | Table)[] = []
  pieces.forEach((piece, index) => {
    if (index > 0) children.push(new Paragraph({ children: [new PageBreak()] }))
    children.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 0, after: 200 },
      children: [new TextRun({ text: piece.title })],
    }))
    // Notes are numbered per piece, so `2.1` reads as the first note of the second piece rather
    // than colliding with the first piece's `1`.
    const content = docxContent(piece.document, { ...options, headingOffset: (options.headingOffset ?? 0) + 1, notePrefix: `${index + 1}.` })
    // one at a time: a spread in call position passes one argument per block and overflows the stack
    for (const child of content.children) children.push(child)
    for (const missing of content.missingImages) missingImages.push(missing)
  })
  return { children, missingImages }
}

function numberingConfig(reference: string, format: (typeof LevelFormat)[keyof typeof LevelFormat], delimiter: ListDelimiter) {
  return {
    reference,
    levels: [0, 1, 2].map((level) => ({
      level,
      format,
      text: `%${level + 1}${delimiter}`,
      alignment: AlignmentType.START,
      style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 260 } } },
    })),
  }
}

/** Wrap Word content in a document: the body typeface, the ordered-list numbering, the title. */
export async function docxFile(children: (Paragraph | Table)[], title: string): Promise<Buffer> {
  const document = new Document({
    title,
    creator: 'WriteFlex',
    styles: {
      default: {
        document: { run: { font: 'Georgia', size: BODY_SIZE, color: '26262A' }, paragraph: { spacing: { line: 300 } } },
      },
    },
    numbering: {
      config: [
        numberingConfig(ORDERED, LevelFormat.DECIMAL, '.'),
        // Lettered and roman lists keep their letters (the locked export frame): one definition per
        // style and delimiter, so `a)` prints as a) and `iv.` as iv. in Word's own numbering.
        ...LETTERED_FORMATS.flatMap(([numbering, format]) => DELIMITERS.map((delimiter) =>
          numberingConfig(numberingReference({ numbering, delimiter }), format, delimiter))),
      ],
    },
    sections: [{ properties: {}, children: children.length ? children : [new Paragraph({ children: [] })] }],
  })
  return Packer.toBuffer(document)
}

/**
 * Render Markdown as a complete Word document. Frontmatter and comments are gone before the parse
 * (model.ts), so they cannot reach the file by any path.
 */
export async function toDocx(markdown: string, options: DocxOptions & { title?: string } = {}): Promise<{ buffer: Buffer; missingImages: string[] }> {
  const document = readDocument(markdown)
  const { children, missingImages } = docxContent(document, options)
  return { buffer: await docxFile(children, options.title ?? 'Document'), missingImages }
}
