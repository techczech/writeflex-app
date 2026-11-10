/**
 * The Word reader's public shapes (Folio versions, ticket 12). The reader takes the BYTES of a
 * `.docx` and returns either a reading or a plain refusal; it never touches a disk or a network and
 * never executes anything in the file.
 */

/** Bumped when the reader's output for the same bytes could change. Recorded with an incoming
 *  revision (ADR-0052 `incoming.converter`) so an old import stays explainable. */
export const WORD_READER_VERSION = 1

/** One tracked change as Word recorded it. `scope: 'paragraph-mark'` is the paragraph break itself
 *  being added or removed (a whole paragraph arriving or leaving) and `scope: 'row'` a table row
 *  being added or removed; `text` is empty for both. */
export type WordChange = {
  /** Order in the document, from 0. Stable for the same bytes (Word's own `w:id` is not used: files in
   *  the wild repeat it). */
  index: number
  kind: 'insertion' | 'deletion'
  /** Word's move-from / move-to, read as a deletion / insertion with this flag set. */
  moved: boolean
  scope: 'text' | 'paragraph-mark' | 'row'
  /** The reviewer's name as written in the file ("Unknown author" when it names nobody). */
  author: string
  /** The date as written, when it is an ISO date-time. */
  date?: string
  text: string
  /** The section this change sits in (index into `sections`), or -1 for the part before the first section. */
  sectionIndex: number
}

/** A stretch of a paragraph: untouched, inserted by a reviewer, or deleted by one. */
export type WordSegment = {
  type: 'same' | 'inserted' | 'deleted'
  /** Plain text, no Markdown. */
  text: string
  author?: string
  date?: string
}

export type WordParagraph = {
  type: 'paragraph'
  /** Heading level 1–9 when the paragraph is a heading below the section level, else absent. */
  headingLevel?: number
  list?: { ordered: boolean; level: number }
  /** The paragraph as the file leaves it (every change accepted), as Markdown. */
  revised: string
  /** The paragraph as it was before the reviewer (every change rejected), as Markdown. */
  original: string
  segments: WordSegment[]
  changes: WordChange[]
}

/** A table as a grid of cell text. Merged cells keep their text in the first cell and leave the
 *  covered cells empty so the grid stays rectangular. Nothing from a table is ever applied to a file. */
export type WordTable = {
  type: 'table'
  rows: string[][]
  /** The grid before the reviewer's changes; equal to `rows` when nobody changed the table. */
  originalRows: string[][]
  changes: WordChange[]
}

/** A picture, chart or drawing. Only a note comes back: its bytes are never read. */
export type WordFigure = { type: 'figure'; note: 'figure here'; description?: string }

export type WordBlock = WordParagraph | WordTable | WordFigure

export type WordSection = {
  /** The heading text as the file leaves it; null for a section made without a heading. */
  heading: string | null
  /** The heading text before the reviewer's changes (differs from `heading` when she renamed it). */
  headingOriginal: string | null
  /** The heading level (1–9) that opened the section; null when there was no heading style. */
  level: number | null
  blocks: WordBlock[]
  /** The section body as Markdown, every change accepted. The heading line is not included. */
  markdown: string
  /** The section body as Markdown, every change rejected. */
  originalMarkdown: string
  changes: WordChange[]
}

export type WordReading = {
  ok: true
  converterVersion: number
  sections: WordSection[]
  /** What stands before the first section (a title, an abstract, a heading above the section level). */
  preamble: WordBlock[]
  /** The heading level the file is cut at: the shallowest level that opens at least two sections, or
   *  the shallowest level present when none does. Null when there is no heading style at all. */
  sectionLevel: number | null
  /** True when no paragraph uses a heading style. `sections` then holds one section per top-level block. */
  noHeadingStyles: boolean
  /** Every tracked change in document order, including those in the preamble and in tables. */
  changes: WordChange[]
  /** Distinct reviewer names in order of first appearance. */
  reviewers: string[]
  tableCount: number
  figureCount: number
  /** Things the reader does not carry over, as plain sentences (comments, footnotes, formatting changes). */
  limitations: string[]
}

/** Why a file was not read. The message is a plain sentence for the writer; it never repeats text
 *  taken from the file. */
export type WordRefusalCode =
  | 'not-a-word-file'
  | 'old-word-format'
  | 'macro-enabled'
  | 'password-protected'
  | 'too-large'
  | 'too-many-parts'
  | 'zip-bomb'
  | 'unsafe-part-name'
  | 'xml-not-allowed'
  | 'output-too-large'
  | 'damaged'

export type WordRefusal = { ok: false; code: WordRefusalCode; message: string }

export type WordReadResult = WordReading | WordRefusal

/** The limits a file must stay within. Overridable only so tests need not build giant files. */
export type WordReaderLimits = {
  /** The whole file, in bytes. */
  maxFileBytes: number
  /** Parts in the zip. */
  maxEntries: number
  /** Any one part once unpacked. Only the XML parts the reader needs are ever unpacked. */
  maxPartBytes: number
  /** All the parts the reader unpacks, added together. */
  maxReadBytes: number
  /** The declared unpacked size of every part added together, read or not. */
  maxDeclaredTotalBytes: number
  /** Declared unpacked size over packed size, for a part over 1 MiB unpacked. */
  maxRatio: number
  /** Elements in one XML part. */
  maxXmlNodes: number
  /** Nesting depth in one XML part. */
  maxXmlDepth: number
  /** Tracked changes in the document. */
  maxChanges: number
  /** Columns in one table row, after merged cells are counted. Word itself stops at 63. */
  maxTableColumns: number
  /** Cells in all tables together, after padding to a rectangle. */
  maxTableCells: number
  /** Characters of Markdown the reader may build, both views added together, counted before each piece is joined on. */
  maxOutputChars: number
}

export const DEFAULT_WORD_READER_LIMITS: WordReaderLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxEntries: 2000,
  maxPartBytes: 32 * 1024 * 1024,
  maxReadBytes: 64 * 1024 * 1024,
  maxDeclaredTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 200,
  maxXmlNodes: 1_000_000,
  maxXmlDepth: 200,
  maxChanges: 200_000,
  maxTableColumns: 256,
  maxTableCells: 1_000_000,
  maxOutputChars: 16 * 1024 * 1024
}
