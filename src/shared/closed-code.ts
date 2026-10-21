/**
 * Why a Change was closed without being applied, as a code from a closed list. Defined ONCE, here:
 * the main process sets it wherever it closes a Change (`closedCode`, beside `closedReason`), and the
 * review dock chooses its own sentence from it. `closedReason` stays, in words, for an agent reading
 * the ledger and for records made before the code existed. No Node or Electron import: the renderer
 * can read it.
 */
export const CLOSED_CODES = [
  /** The text the Change replaces, moves or is placed after is no longer in the document. */
  'target-gone',
  /** That text now occurs more than once, so the Change has no one place. */
  'target-repeated',
  /** The document is not there (renamed, moved or put in the Trash). */
  'file-missing',
  /** The path is not a document of this Collection: a folder, a link, a hidden folder, or outside it. */
  'not-a-document',
  /** A Change over the whole document, and the document no longer reads as it did when the Change was proposed. */
  'document-changed',
  /** Another Change to the same document was accepted first, and this one can no longer be placed; or
   *  WriteFlex closed an add-a-heading proposal of its own because the Folio part already has that heading
   *  (main/folio-part-proposals.ts). */
  'superseded',
  /** The document is there and could not be read. */
  'unreadable',
  /** Anything else, and every record closed before the code existed. */
  'other',
] as const
export type ClosedCode = (typeof CLOSED_CODES)[number]

/** The code on a closed record; `other` when it carries none or one this build does not know. Tolerates any record. */
export function closedCodeOf(record: unknown): ClosedCode {
  const code = typeof record === 'object' && record !== null ? (record as { closedCode?: unknown }).closedCode : undefined
  return typeof code === 'string' && (CLOSED_CODES as readonly string[]).includes(code) ? (code as ClosedCode) : 'other'
}
