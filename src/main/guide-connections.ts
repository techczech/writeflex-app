/**
 * The machine-state probe behind the Guide's What it connects to rows (ADR-0043, ticket 08). It only
 * READS: whether Zotero's database is where Zotero keeps it. The model account and the voice list are
 * read in the renderer (where those sources live); each row's wording is in `src/shared/guide-connections.ts`.
 */
export type ZoteroProbeSources = {
  /** Where `zotero.sqlite` is (Zotero's own preference, or the e2e fixture). */
  databasePath: () => string
  exists: (path: string) => boolean
}

export function probeZotero(sources: ZoteroProbeSources): boolean {
  try { return sources.exists(sources.databasePath()) } catch { return false }
}

/** The two fixed places the Guide's connection actions open. The renderer names one; main holds the URL. */
export const GUIDE_LINKS = {
  'zotero-download': 'https://www.zotero.org/download/',
  'voice-settings': 'x-apple.systempreferences:com.apple.Accessibility-Settings.extension',
} as const
export type GuideLink = keyof typeof GUIDE_LINKS
export const isGuideLink = (value: unknown): value is GuideLink => typeof value === 'string' && Object.hasOwn(GUIDE_LINKS, value)
