/** Section pages are ordinary Folio parts, marked only by their own `folio: section` frontmatter.
 * Every later contents part belongs to that section until the next section page, regardless of headings.
 * Front matter never belongs. Before the first section page, parts belong to none. No manifest role is used.
 */
import { parseFrontmatter } from '../main/frontmatter'

export function declaresSectionPage(source: string): boolean {
  const value = Object.entries(parseFrontmatter(source)?.extra ?? {}).find(([key]) => key.toLocaleLowerCase() === 'folio')?.[1]
  return typeof value === 'string' && value.trim().toLocaleLowerCase() === 'section'
}

/** Input indexes of the owning section; section pages themselves have no owner. */
export function sectionMembership(parts: readonly { frontMatter?: boolean; sectionPage?: boolean }[]): Array<number | null> {
  let section: number | null = null
  return parts.map((part, index) => {
    if (part.frontMatter) return null
    if (part.sectionPage) { section = index; return null }
    return section
  })
}

/** Visible room rows retain running-order indexes, even when their section is collapsed. Counts exclude its opening. */
export function sectionOutlineRows(parts: readonly { index: number; words: number; frontMatter?: boolean; outline?: { sectionPage?: boolean } }[], collapsed: ReadonlySet<number>) {
  const inputs = parts.map(part => ({ frontMatter: part.frontMatter, sectionPage: part.outline?.sectionPage }))
  const owners = sectionMembership(inputs)
  return parts.flatMap((part, at) => {
    const owner = owners[at]
    if (owner !== null && collapsed.has(parts[owner].index)) return []
    const sectionPage = !part.frontMatter && part.outline?.sectionPage === true
    const members = sectionPage ? parts.filter((_, i) => owners[i] === at) : []
    return [{ index: part.index, sectionIndex: owner === null ? null : parts[owner].index, sectionPage, parts: members.length, words: sectionPage ? members.reduce((sum, member) => sum + member.words, 0) : part.words }]
  })
}

export const FOLIO_SECTION_EXPORT_FIELDS = ['section-title-pages', 'section-contents'] as const
export type FolioSectionExportField = typeof FOLIO_SECTION_EXPORT_FIELDS[number]
export const isSectionExportField = (field: unknown): field is FolioSectionExportField => (FOLIO_SECTION_EXPORT_FIELDS as readonly unknown[]).includes(field)
/** Opt-in only; absent, false and unrecognised values all mean off. */
export function sectionExportOptions(source: string): { titlePages: boolean; contents: boolean } {
  const extra = parseFrontmatter(source)?.extra
  return { titlePages: extra?.['section-title-pages'] === 'true', contents: extra?.['section-contents'] === 'true' }
}

/** Keyboard movement is over drawn rows; a collapse never changes their running-order indexes. */
export function sectionKeyTarget(visible: readonly number[], shown: number | null, key: string): number | null {
  if (!visible.length) return null
  const at = Math.max(0, visible.indexOf(shown ?? -1))
  const next = key === 'Home' ? 0 : key === 'End' ? visible.length - 1 : key === 'ArrowUp' ? Math.max(0, at - 1) : key === 'ArrowDown' ? Math.min(visible.length - 1, at + 1) : -1
  return next < 0 ? null : visible[next]
}
/** Shift selection includes only drawn rows, so removal never silently includes a collapsed member. */
export function visibleSectionRange(visible: readonly number[], anchor: number, target: number): number[] {
  return visible.filter(index => index >= Math.min(anchor, target) && index <= Math.max(anchor, target))
}
