import { shownHeadings, type FolioOutlineFile, type FolioOutlineHeading } from './folio-outline'

export type OutlineHeadingRow = FolioOutlineHeading & { depth: number }

/** A heading to jump to: its file, the line it had when the room loaded, and its level and text so the jump can re-find it. */
export type FolioHeadingTarget = { path: string; line: number; level: number; text: string }

/** The Filter box text as matched: trimmed, NFC-normalised, lower-cased. Empty means no filter. */
export function filterQuery(filter: string): string {
  return filter.trim().normalize('NFC').toLocaleLowerCase()
}

function matchesQuery(text: string, query: string): boolean {
  return text.normalize('NFC').toLocaleLowerCase().includes(query)
}

/** Preorder rows retain their ancestry while filtering; no file reads or Plan loads. */
export function outlineHeadingRows(file: FolioOutlineFile, filter = ''): OutlineHeadingRow[] {
  const rows: Array<OutlineHeadingRow & { parent: number | null }> = []
  const stack: number[] = []
  for (const heading of shownHeadings(file.headings, file.heading, file.title)) {
    while (stack.length && rows[stack[stack.length - 1]].level >= heading.level) stack.pop()
    rows.push({ ...heading, depth: stack.length, parent: stack.at(-1) ?? null })
    stack.push(rows.length - 1)
  }
  const query = filterQuery(filter)
  const kept = new Set<number>()
  rows.forEach((row, index) => {
    if (!query || matchesQuery(row.text, query)) {
      let at: number | null = index
      while (at !== null && !kept.has(at)) { kept.add(at); at = rows[at].parent }
    }
  })
  return rows.filter((_, index) => kept.has(index)).map(({ parent: _parent, ...row }) => row)
}

/**
 * One part under the Outline Filter box. A part stays when its title matches (or when it has no outline, i.e. it is
 * unwritten), and when any of its headings matches. Its headings are the matching ones only; a part whose title matches
 * but no heading does stays visible with its headings collapsed (`headings` is empty).
 */
export function filterOutlinePart(title: string, outline: FolioOutlineFile | undefined, filter: string): { keep: boolean; headings: OutlineHeadingRow[] } {
  const headings = outline ? outlineHeadingRows(outline, filter) : []
  const query = filterQuery(filter)
  if (!query) return { keep: true, headings }
  return { keep: headings.length > 0 || matchesQuery(title, query), headings }
}

export function headingRoute(file: Pick<FolioOutlineFile, 'path'>, heading: FolioOutlineHeading): FolioHeadingTarget {
  return { path: file.path, line: heading.line, level: heading.level, text: heading.text }
}

/** The heading level and text of one document line, or null when the line is not an ATX heading. */
export function atxHeadingOf(lineText: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.*)$/.exec(lineText)
  return match ? { level: match[1].length, text: match[2].trim() } : null
}

/**
 * The line to place the cursor on for a heading jump. The recorded line is used when the document line there is still
 * that heading (same level and text after trimming). Otherwise the first line that is that heading is used, and if the
 * heading is gone, the recorded line clamped to the document. `lineText(n)` reads one-based line n.
 */
export function resolveHeadingLine(lineCount: number, lineText: (n: number) => string, target: Pick<FolioHeadingTarget, 'line' | 'level' | 'text'>): number {
  const clamped = Math.max(1, Math.min(target.line, lineCount))
  const isTarget = (n: number): boolean => {
    const heading = atxHeadingOf(lineText(n))
    return heading !== null && heading.level === target.level && heading.text === target.text.trim()
  }
  if (isTarget(clamped)) return clamped
  for (let n = 1; n <= lineCount; n++) if (isTarget(n)) return n
  return clamped
}
