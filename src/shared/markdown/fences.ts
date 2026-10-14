export const MARKDOWN_FENCE_LINE = /^\s*(`{3,}|~{3,})(?:[^`]*)$/

/** Remove complete fenced regions, including their markers, while preserving outside line positions. */
export function stripFencedRegions(text: string): string {
  let fence: { marker: '`' | '~'; length: number } | null = null
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const match = MARKDOWN_FENCE_LINE.exec(line)
    if (!fence && match) {
      fence = { marker: match[1][0] as '`' | '~', length: match[1].length }
      continue
    }
    if (fence) {
      const close = new RegExp(`^\\s*${fence.marker === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
      if (close.test(line)) fence = null
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}
