import { parseFrontmatter } from '../main/frontmatter'

/**
 * A Folio's (or one document's) HTML contents depth, kept in its own frontmatter as `toc_depth`
 * (an integer 1-6; 6 lists every level). The Folio's lives in its Index Note. Absent, or anything
 * that is not 1-6, reads as no setting: the export's default applies. Pure: no IO.
 */
export const TOC_DEPTH_KEY = 'toc_depth'

export const isTocDepthValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6

/** The `toc_depth` a file's text declares, or null. */
export function tocDepthOf(text: string): number | null {
  const raw = parseFrontmatter(text)?.extra[TOC_DEPTH_KEY]
  return typeof raw === 'string' && /^[1-6]$/.test(raw.trim()) ? Number(raw.trim()) : null
}
