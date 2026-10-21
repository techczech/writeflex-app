/**
 * The exported cover reads the Folio's Details (0.26): its title, standfirst and the Date, Status and Author chips come
 * from the Index Note's header, field by field; where the Details leave a field empty, the title page's own header
 * still fills it (the decision of 2026-10-19: otherwise a Folio whose title page already says a status could never
 * show the status picked in Details). Pure: no IO.
 */
import type { HtmlDocumentCover, HtmlDocumentData, HtmlFrontmatterValue } from './markdown/html-document'

/** The Index Note's header values for the fields the cover reads; a missing or empty field is absent. */
export type CoverDetails = Partial<Record<'title' | 'standfirst' | 'date' | 'status' | 'author', string>>

/** The Details fields that are chips on a cover. */
export const COVER_CHIP_FIELDS = ['date', 'status', 'author'] as const

/**
 * The chips a cover shows, in the order the export's field selection names them: each selected field takes the
 * Details value when there is one, else the value already there (the title page's). A field no one has is not a chip.
 * A selected field that is not a Details chip field keeps the value it had.
 */
export function coverChips(
  existing: Readonly<Record<string, HtmlFrontmatterValue>>,
  details: CoverDetails | null,
  selected: readonly string[],
): Record<string, HtmlFrontmatterValue> {
  const chips: Record<string, HtmlFrontmatterValue> = {}
  const chipField = (field: string): field is typeof COVER_CHIP_FIELDS[number] => (COVER_CHIP_FIELDS as readonly string[]).includes(field)
  for (const field of selected) {
    const fromDetails = chipField(field) ? details?.[field] : undefined
    const value = fromDetails ?? existing[field]
    if (value !== undefined) chips[field] = value
  }
  // Anything else the title page's header carried stays, after the selected fields.
  for (const [field, value] of Object.entries(existing)) if (!(field in chips)) chips[field] = value
  return chips
}

/** The title page's cover with the Details laid over it; with no Details it is returned as it is. */
export function coverWithDetails(cover: HtmlDocumentCover, details: CoverDetails | null, selected: readonly string[]): HtmlDocumentCover {
  if (!details) return cover
  const base: HtmlDocumentData | undefined = cover.data
  const frontmatter = coverChips(base?.frontmatter ?? {}, details, selected)
  return {
    ...cover,
    title: details.title ?? cover.title,
    ...(details.standfirst ? { standfirst: details.standfirst } : {}),
    ...(base ? { data: { ...base, frontmatter } } : Object.keys(frontmatter).length > 0 ? { data: { frontmatter, outline: [], metadata: { title: details.title ?? cover.title, description: null, purpose: null, status: null, modified: 0, words: 0 } } } : {}),
  }
}

/** What the generated cover and masthead of a Folio with no title page show: the Details' standfirst and chips. */
export function folioHeaderDetails(details: CoverDetails | null, selected: readonly string[]): { standfirst: string | null; frontmatter: Record<string, HtmlFrontmatterValue> } | null {
  if (!details) return null
  const frontmatter = coverChips({}, details, selected)
  const standfirst = details.standfirst ?? null
  return standfirst === null && Object.keys(frontmatter).length === 0 ? null : { standfirst, frontmatter }
}
