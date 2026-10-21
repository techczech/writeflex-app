/**
 * The text under "Make this folder a Folio?": a short plain list of the pieces, never the raw
 * manifest. The piece list is bounded (at most 10 lines of at most 60 characters), so the native
 * dialog always fits on screen and its buttons stay reachable. Pure, so main and the tests share it.
 */

const MAX_LISTED = 8
const MAX_LINE = 60
export const FOLIO_CONFIRM_FALLBACK = 'A manifest will be written so this folder compiles in order.'

function pieceName(path: string): string {
  const base = path.split('/').pop() ?? path
  return base.replace(/\.md$/i, '')
}

function clip(line: string): string {
  const chars = Array.from(line)
  return chars.length <= MAX_LINE ? line : `${chars.slice(0, MAX_LINE - 1).join('')}…`
}

/** Detail text for the confirmation, from the manifest's file paths in running order. */
export function folioConfirmSummary(paths: string[]): string {
  const n = paths.length
  if (n === 0) return 'This folder has no pieces yet. The Folio starts empty.'
  const lines = [n === 1 ? '1 piece will go into the Folio:' : `${n} pieces will go into the Folio, in this order:`]
  paths.slice(0, MAX_LISTED).forEach((p, i) => lines.push(clip(`${i + 1}. ${pieceName(p)}`)))
  if (n > MAX_LISTED) lines.push(`and ${n - MAX_LISTED} more.`)
  return lines.join('\n')
}

/** Same, from the drafted manifest text. Anything that is not a manifest with a files list gets the
 *  fixed fallback sentence (no list), not the zero-piece wording. */
export function folioConfirmSummaryFromDraft(draft: string, warning?: string): string {
  if (warning) return `${warning}\n\n${folioConfirmSummaryFromDraft(draft)}`
  try {
    const files = (JSON.parse(draft) as { files?: unknown })?.files
    if (!Array.isArray(files)) return FOLIO_CONFIRM_FALLBACK
    const paths = files.map((f) => (f && typeof (f as { path?: unknown }).path === 'string' ? (f as { path: string }).path : null))
    if (paths.some((p) => p === null)) return FOLIO_CONFIRM_FALLBACK
    return folioConfirmSummary(paths as string[])
  } catch {
    return FOLIO_CONFIRM_FALLBACK
  }
}
