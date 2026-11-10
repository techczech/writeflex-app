/**
 * The paragraphs of Markdown, with where each sits in the text. Shared by staging a co-author's revision (folio-version-stage.ts) and by
 * placing a staged suggestion when the writer accepts it (recorded-placement.ts), so both mean the same thing by "a whole paragraph".
 */

/** The paragraphs of Markdown (blocks between blank lines) with where each sits in `text`. A fenced code block is one paragraph. */
export function markdownBlocks(text: string): Array<{ from: number; to: number; text: string }> {
  const out: Array<{ from: number; to: number; text: string }> = []
  const lines = text.split('\n')
  let offset = 0
  let start = -1
  let end = 0
  let fence: string | null = null
  const close = (): void => { if (start >= 0) out.push({ from: start, to: end, text: text.slice(start, end) }); start = -1 }
  for (const line of lines) {
    const lineEnd = offset + line.length
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence !== null) {
      end = lineEnd
      if (marker && marker[1].startsWith(fence[0]) && marker[1].length >= fence.length && line.trim() === marker[1]) fence = null
    } else if (line.trim() === '') close()
    else {
      if (start < 0) start = offset
      end = lineEnd
      if (marker) fence = marker[1]
    }
    offset = lineEnd + 1
  }
  close()
  return out
}
