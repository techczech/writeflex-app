import { CliError } from './operation'

type Heading = { index: number; level: number; text: string }

function slug(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')
}

/** ATX headings outside fenced code and outside frontmatter. */
function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = []
  let fence: string | null = null
  let start = 0
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
    if (close > 0) start = close + 1
  }
  for (let i = start; i < lines.length; i++) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i])?.[1]
    if (marker) {
      if (fence === null) fence = marker[0]
      else if (marker[0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const match = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (match) out.push({ index: i, level: match[1].length, text: match[2] })
  }
  return out
}

/**
 * The section under a heading: the heading line down to (not including) the next heading of the same
 * or a higher level. Matches the heading text or its slug, ignoring case; an ambiguous name is refused
 * with the line numbers so the caller can say which one.
 */
export function readSection(content: string, name: string): { heading: string; line: number; text: string } {
  const lines = content.split('\n')
  const wanted = name.trim().replace(/^#+\s*/, '').toLowerCase()
  const headings = headingsOf(lines)
  const found = headings.filter((h) => h.text.toLowerCase() === wanted || slug(h.text) === slug(wanted))
  if (found.length === 0) {
    const available = headings.map((h) => h.text).join('; ')
    throw new CliError(`No section named "${name}".${available ? ` Sections: ${available}.` : ' The document has no headings.'}`)
  }
  if (found.length > 1) {
    throw new CliError(`"${name}" names ${found.length} sections, at lines ${found.map((h) => h.index + 1).join(', ')}.`)
  }
  const [target] = found
  const next = headings.find((h) => h.index > target.index && h.level <= target.level)
  const end = next ? next.index : lines.length
  return { heading: target.text, line: target.index + 1, text: lines.slice(target.index, end).join('\n').replace(/\n+$/, '') }
}
