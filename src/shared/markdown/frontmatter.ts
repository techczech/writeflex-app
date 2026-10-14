/**
 * WHERE FRONTMATTER ENDS AND THE WRITING BEGINS — asked once, answered once (finding 4).
 *
 * Frontmatter is stage-truth for the app (ADR-0019) and never leaves it, so every export and every
 * copy removes it before the parse. That makes this the most dangerous question in the export layer:
 * answer it too generously and the writer's own words are deleted from their output, silently. Which
 * is what happened — the exporters carried a shape-only regex (`---`, anything, `---`) while the
 * frontmatter organ (src/main/frontmatter.ts) knew the key shapes it can actually read, so a piece
 * that opened on a thematic break lost its first paragraph on copy and on export.
 *
 * There is now ONE definition, here in shared/ where both the main process and the renderer reach
 * it, and the organ reads its block through this module rather than through a second fence scan.
 *
 * A leading block is frontmatter when ALL of this holds:
 *   - the first line is a `---` fence (after a single UTF-8 BOM, which Windows-authored files carry
 *     and which otherwise defeats the check entirely);
 *   - a closing `---` fence follows — an opened-but-never-closed block is a thematic break;
 *   - and the block DECLARES SOMETHING: at least one `key: value` line, or nothing at all. A block
 *     of prose, of list items or of headings is a document that opens on a rule, not metadata.
 *
 * Junk lines BESIDE real keys stay inside the block: the organ keeps them under `extra._raw` rather
 * than throwing, and the export layer must agree that the whole block is metadata.
 */

/** A `---` fence line. Trailing spaces and tabs are tolerated; nothing else on the line is. */
export const FRONTMATTER_FENCE = /^---[ \t]*$/
/** A YAML `key: value` line — the shape that makes a block metadata rather than prose. */
export const FRONTMATTER_KEY_VALUE = /^([\p{L}\p{N}_-]+):[ \t]*(.*)$/u
/** A dashed block-list item under a key. */
export const FRONTMATTER_DASH_ITEM = /^[ \t]*-[ \t]*(.*)$/

/** A document's leading frontmatter block: its body lines, and where the block ends in the ORIGINAL
 *  text (past the closing fence's newline, and past any BOM), so a caller can slice the body off. */
export type FrontmatterBlock = { lines: string[]; end: number }

/** A block is metadata only if it says something in YAML — or says nothing at all. */
function declaresSomething(lines: string[]): boolean {
  return lines.every((line) => line.trim() === '') || lines.some((line) => FRONTMATTER_KEY_VALUE.test(line))
}

/** The document's leading frontmatter block, or null when it has none. */
export function frontmatterBlock(text: string): FrontmatterBlock | null {
  // A UTF-8 BOM decodes to a leading U+FEFF that would otherwise make the fence line read as "﻿---".
  // Strip a single leading one; a U+FEFF anywhere else is a legitimate character.
  const bom = text.startsWith('﻿') ? 1 : 0
  const lines: string[] = []
  let cursor = bom
  let opened = false
  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor)
    const lineEnd = newline === -1 ? text.length : newline
    const next = newline === -1 ? text.length : newline + 1
    const line = text.slice(cursor, lineEnd).replace(/\r$/, '')
    if (!opened) {
      if (!FRONTMATTER_FENCE.test(line)) return null
      opened = true
    } else if (FRONTMATTER_FENCE.test(line)) {
      return declaresSomething(lines) ? { lines, end: next } : null
    } else {
      lines.push(line)
    }
    if (newline === -1) break
    cursor = next
  }
  return null // opened a fence but never closed it → a thematic break, not frontmatter
}
