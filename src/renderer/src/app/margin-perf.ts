/**
 * Test-only counters for the margin's work (0.24 ticket 16). Plain numbers, bumped where the work happens, so a test
 * can say how many times a document revision cost a model build, an anchor resolution, a text read or a measuring
 * pass. Nothing reads them in the app; the window carries them as `__wfMarginPerf` for the e2e check.
 */
export type MarginPerf = {
  /** Model builds (one build gives the filtered model and the unfiltered facts together). */
  builds: number
  /** Anchor resolutions against the document text (one per change per document revision). */
  resolves: number
  /** Whole-document text reads (`doc.toString()`) made for the margin. */
  textReads: number
  /** Measuring passes over the cards and passages. */
  measures: number
}

export const marginPerf: MarginPerf = { builds: 0, resolves: 0, textReads: 0, measures: 0 }

export function resetMarginPerf(): void {
  marginPerf.builds = 0
  marginPerf.resolves = 0
  marginPerf.textReads = 0
  marginPerf.measures = 0
}
