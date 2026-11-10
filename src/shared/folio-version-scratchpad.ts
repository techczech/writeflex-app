/**
 * Sending text from a saved Folio version to the floating Scratchpad (ADR-0052 § Sending text to the Scratchpad; Folio versions
 * ticket 10). Pure types and the words the window, the command line and the agent say. Main does the sending
 * (`main/folio-version-scratchpad.ts`): the window names a version, a part and a range of paragraph NUMBERS, never text.
 */
import type { ScratchItem } from './scratchpad-items'

/** `version` is the saved text of the version itself (`sent` is the same text, named for the version that was sent); `theirs` is her converted section of an incoming revision. */
export type VersionTextSide = 'version' | 'sent' | 'theirs'
export const VERSION_TEXT_SIDES: readonly VersionTextSide[] = ['version', 'sent', 'theirs']

export type VersionSendInput = {
  /** The Folio's folder. */
  dir: string
  /** The Folio version's id (`fv_…`). */
  id: string
  /** The part as the version recorded it (its path), or its title when that names exactly one part. For `theirs`: her section heading. */
  path: string
  side: VersionTextSide
  /** Paragraph numbers, 1-based, inclusive. */
  from: number
  to: number
}

export type VersionSendReply =
  | { ok: true; item: ScratchItem; part: string; versionName: string; from: number; to: number; words: number }
  | { ok: false; error: string }

/** The status line after a send (the locked mockup's words: "Sent 2 paragraphs to the Scratchpad. The version is unchanged."). */
export function versionSentText(from: number, to: number): string {
  const count = to - from + 1
  return `Sent ${count === 1 ? '1 paragraph' : `${count} paragraphs`} to the Scratchpad. The Folio and the version are unchanged.`
}

export const VERSION_SEND_UNDONE = 'Removed the new copy from the Scratchpad. The Folio and the version are unchanged.'

/** The sentence for a send the window could not even ask for. */
export const VERSION_SEND_UNAVAILABLE = 'The Scratchpad could not be reached, so nothing was sent.'

export const VERSION_CUT_REASON = 'This is a saved version, so it cannot be cut. Send a copy instead.'
