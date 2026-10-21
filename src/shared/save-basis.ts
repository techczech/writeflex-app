/**
 * What an editor save says about the file it replaces (spec: docs/plans/saving-over-an-outside-change/
 * spec-save-only-over-the-version-you-saw.md). Every `file:save` carries one, and main compares it with
 * the disk in the tick of the rename that commits the write: no editor buffer replaces a file's bytes
 * unless the bytes on disk then are the ones the buffer was based on, or the writer chose Keep mine
 * against exactly those bytes.
 *
 * - `disk`: the disk text the buffer was last known to match (the renderer's saved baseline, in the form
 *   main read or wrote it: its own line endings and BOM).
 * - `new`: the buffer was never on disk; the file must not exist, or be empty (zero bytes).
 * - `keep-mine`: the writer chose Keep mine against this disk text (the text the banner was raised for).
 * - `create`: the file must not exist at all; it is created exclusively and never replaces anything (a
 *   recovery copy). A name that is taken, by a file or a folder, is refused.
 *
 * Compared byte for byte (review round 1, Sol M3): a line-ending or BOM change made by another program
 * is a change, and a buffer based on the old form does not replace it. Whether the buffer is dirty is a
 * different question, asked in the editor's form (line-endings.ts). Pure: no IO.
 */

export type SaveBasis =
  | { kind: 'disk'; text: string }
  | { kind: 'new' }
  | { kind: 'keep-mine'; text: string }
  | { kind: 'create' }

/** A value that is a well-formed basis. Anything else is a caller that did not say what it saw. */
export function isSaveBasis(value: unknown): value is SaveBasis {
  if (!value || typeof value !== 'object') return false
  const basis = value as { kind?: unknown; text?: unknown }
  if (basis.kind === 'new' || basis.kind === 'create') return true
  return (basis.kind === 'disk' || basis.kind === 'keep-mine') && typeof basis.text === 'string'
}

/** May a buffer with this basis replace a file that holds `diskNow` (null: no file there)? */
export function basisAllows(basis: SaveBasis, diskNow: string | null): boolean {
  if (basis.kind === 'create') return diskNow === null
  if (basis.kind === 'new') return diskNow === null || diskNow === ''
  return diskNow !== null && diskNow === basis.text
}

/** The basis for a buffer whose saved baseline, as on disk, is `diskText` (undefined: never read from disk). */
export function basisFromBaseline(diskText: string | undefined): SaveBasis {
  return diskText === undefined ? { kind: 'new' } : { kind: 'disk', text: diskText }
}
