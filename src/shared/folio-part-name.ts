/**
 * THE name rule for which files of a Folio may be parts, shared by main (folio.ts, plan.ts, the Outline's
 * order facts) and the renderer's Outline grouping (folio-outline.ts), so the Plan and the sidebar list the
 * same files under "Not in the outline". Pure and Node-free. Names are compared case-insensitively.
 */

import { isAgentInstructionsName } from './folio-agent-files'

/** The cover names a folder may carry besides its `_`-prefixed Index Note and `_<folder>.md`, lower-cased. */
export const FOLIO_COVER_NAMES: readonly string[] = ['readme.md', 'index.md']

/** A folder's cover by name (README.md, index.md, in any letter case). The `_`-prefixed covers fall to the `_` rule. */
export function isFolioCoverName(name: string): boolean {
  return FOLIO_COVER_NAMES.includes(name.toLocaleLowerCase())
}

/**
 * The name rule every Folio part list applies: a file whose name starts with `_` (Index Notes, the
 * manifest's siblings), a `.writeflex-backup`, and agent instructions (AGENTS.md, CLAUDE.md and their
 * conflict copies) are never parts. Covers are excluded separately (`isNotInOutlineName`).
 */
export function isFolioPartCandidateName(name: string): boolean {
  return !name.startsWith('_') && !name.endsWith('.writeflex-backup') && !isAgentInstructionsName(name)
}

/** A file "Not in the outline" may list, by name: a part candidate that is not a cover (ADR-0046). */
export function isNotInOutlineName(name: string): boolean {
  return isFolioPartCandidateName(name) && !isFolioCoverName(name)
}
