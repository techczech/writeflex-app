/**
 * What a citation looks like once it is in the draft (ReadFlex ADR-0003).
 *
 * Plain Markdown, always: a visible chip `⟨Lea and Street 1998, p. 157⟩` written as an ordinary link
 * whose target is a `zotero://` URL. Other editors and agents read WriteFlex documents, so a link that
 * only WriteFlex understands is a link that rots. The target is the item or the annotation — never a hash
 * of the quoted words — so editing the wording never breaks it.
 */

export type CitationSource = {
  /** `Lea and Street 1998`, already formatted by the Shelf. */
  authorYear: string
  /** Zotero's display page label, when the citation points at a place rather than a whole work. */
  pageLabel?: string | null
  /** The `zotero://` target. */
  link: string
}

/** The chip's visible text: `⟨Lea and Street 1998, p. 157⟩`, or without the page when there is none. */
export function chipLabel(source: CitationSource): string {
  const page = source.pageLabel?.trim()
  const who = source.authorYear.trim() || 'Reference'
  return `⟨${page ? `${who}, p. ${page}` : who}⟩`
}

/** A link label cannot contain a bare `]`; a URL cannot contain a bare `)`. Both are escaped. */
export function safeLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]')
}

export function safeUrl(url: string): string {
  return /[()\s]/.test(url) ? `<${url}>` : url
}

/** The chip alone — "insert reference", and the paragraph↔reading-position association. */
export function citationChip(source: CitationSource): string {
  return `[${safeLabel(chipLabel(source))}](${safeUrl(source.link)})`
}

/**
 * Strip the typographic quotes the reader wraps a dragged passage in.
 *
 * `reader.js`'s `_handleSetDataTransferAnnotations` writes `'“' + text + '”'` unless its `fromText`
 * argument is true, and the PDF view's drag handler does not pass it — so the same passage arrives bare
 * on ⌘C and quoted on a drag. The flag cannot be used to tell the two apart, because it means "do not
 * add quotes" rather than "this came from a selection": the EPUB view passes `true` for a
 * selection drag and the PDF view passes nothing for the identical gesture. So the matcher unwraps
 * instead, which also keeps the vendored bundle untouched (ReadFlex ADR-0013).
 *
 * Only a matched outer pair is removed, and only when something is left inside it.
 */
export function unwrapReaderQuotes(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 3 || !trimmed.startsWith('“') || !trimmed.endsWith('”')) return trimmed
  return trimmed.slice(1, -1).trim()
}

/** The comparison shared by the transfer seam and the paste/drop matcher. */
export function normaliseReaderText(text: string): string {
  return unwrapReaderQuotes(text).replace(/\s+/g, ' ').trim()
}

/** How a pulled quote sits in the draft. Block is the default; inline suits a sentence mid-paragraph. */
export type QuoteStyle = 'block' | 'inline'

/**
 * A quote and its chip. The quoted words are ordinary Markdown you can edit freely — the chip after them
 * carries the link, so rewording, trimming or translating the quote never orphans the citation.
 */
export function quotedCitation(
  quote: string,
  source: CitationSource,
  style: QuoteStyle = 'block',
): string {
  const text = quote.replace(/\s+/g, ' ').trim()
  const chip = citationChip(source)
  if (!text) return chip
  if (style === 'inline') return `“${text}” ${chip}`
  // A blockquote must carry `> ` on every line, including the blank ones a multi-paragraph quote has.
  const quoted = `“${text}”`.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')
  return `${quoted}\n>\n> ${chip}`
}

/** As much of what the reader handed over as a citation needs. */
export type ReaderQuote = {
  text: string
  authorYear: string
  pageLabel?: string | null
}

/**
 * The citation for words that have just arrived in the draft, or null when they did not come out of the
 * reader.
 *
 * Matched on the words themselves rather than on a clipboard flavour, so one mechanism serves ⌘C→⌘V and
 * a drag, and ordinary pasted prose is never mistaken for a citation. The reader's own quote wrapping is
 * removed before the comparison and before the quote is rebuilt, so a drag matches its selection and the
 * words are not quoted twice.
 */
export function citationForReaderText(
  pasted: string,
  quote: ReaderQuote | null,
  link: string,
): string | null {
  if (!quote || !link) return null
  const incoming = normaliseReaderText(pasted)
  if (!incoming || normaliseReaderText(quote.text) !== incoming) return null
  return quotedCitation(incoming, {
    authorYear: quote.authorYear,
    link,
    pageLabel: quote.pageLabel,
  })
}
