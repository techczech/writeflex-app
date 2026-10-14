/**
 * A file's text as the editor holds it, and back (bug 01, 2026-09-27; ADR-0039: the file is never
 * rewritten). CodeMirror splits lines on `\r\n`, `\r` and `\n` and joins them with `\n`, so a CRLF,
 * lone-CR or mixed-ending file lives in the editor as LF text. Two rules follow:
 *
 * - **Is this a change?** Compare in the editor's form. A buffer that differs from its file only in
 *   line-ending style or a leading BOM is the same document; treating it as different is what made
 *   opening a CRLF file schedule an autosave that rewrote it with LF.
 * - **What bytes to write?** When nothing changed, the file's own bytes, so the caller writes nothing.
 *   When the writer did edit, the file keeps its dominant line-ending style and its BOM.
 */

const BOM = '﻿'

export type LineEnding = '\r\n' | '\n' | '\r'

/** The text the editor holds for these bytes: every `\r\n` and lone `\r` read as `\n`. */
export function editorTextOf(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

function comparable(text: string): string {
  const lf = editorTextOf(text)
  return lf.startsWith(BOM) ? lf.slice(1) : lf
}

/** True when `buffer` is a different document from `baseline`. Line-ending style and a leading BOM are
 *  not differences. An unknown baseline (never read) counts as a change. */
export function isTextChange(baseline: string | undefined, buffer: string): boolean {
  if (baseline === undefined) return true
  if (baseline === buffer) return false
  return comparable(baseline) !== comparable(buffer)
}

/** The file's most frequent line ending; a tie goes to the ending that appears first. A file with no
 *  line ending at all counts as `\n`. */
export function dominantLineEnding(text: string): LineEnding {
  const counts: Record<LineEnding, number> = { '\r\n': 0, '\n': 0, '\r': 0 }
  let first: LineEnding | null = null
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as LineEnding
    counts[ending] += 1
    first ??= ending
  }
  if (first === null) return '\n'
  let best: LineEnding = first
  for (const ending of ['\r\n', '\n', '\r'] as const) {
    if (counts[ending] > counts[best]) best = ending
  }
  return best
}

/**
 * The bytes to write when the editor saves `buffer` over a file that currently holds `disk` (null when
 * the file does not exist). Returns `disk` itself when the buffer is the same document, so the caller can
 * skip the write. Editor text (no `\r`) takes the file's dominant line ending and keeps its BOM; text that
 * already carries `\r` was written with explicit endings by its caller and is kept as given.
 */
export function textForSave(buffer: string, disk: string | null): string {
  if (disk === null) return buffer
  if (!isTextChange(disk, buffer)) return disk
  if (buffer.includes('\r')) return buffer
  const eol = dominantLineEnding(disk)
  const restored = eol === '\n' ? buffer : buffer.replace(/\n/g, eol)
  return disk.startsWith(BOM) && !restored.startsWith(BOM) ? `${BOM}${restored}` : restored
}

/** Saved-content baselines held in the editor's form, so every buffer-versus-baseline comparison is
 *  honest for CRLF, lone-CR and mixed-ending files. Setting a raw disk read stores its editor text. */
export class EditorBaselines extends Map<string, string> {
  override set(path: string, text: string): this {
    return super.set(path, editorTextOf(text))
  }
}
