/** The declaration rule shared by Plan parsing and folder recognition. */
export function codeLines(lines: ReadonlyArray<{ text: string }>): boolean[] {
  const skipped = Array.from({ length: lines.length }, () => false)
  let fence: { marker: '`' | '~'; length: number } | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index].text
    if (fence) {
      skipped[index] = true
      const closing = new RegExp(`^ {0,3}${fence.marker === '`' ? '`' : '~'}{${fence.length},}\\s*$`)
      if (closing.test(text)) fence = null
      continue
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(text)
    if (opening) {
      const run = opening[1]
      fence = { marker: run[0] as '`' | '~', length: run.length }
      skipped[index] = true
      continue
    }
    if (/^(?: {4}|\t)/.test(text)) skipped[index] = true
  }
  return skipped
}

export function runningOrderHeadingLines(source: string): number[] {
  const lines = source.split(/\r\n|\r|\n/).map(text => ({ text }))
  const skipped = codeLines(lines)
  return lines.flatMap((line, index) => !skipped[index] && /^##(?!#)\s+Running order(?:\s.*)?$/i.test(line.text) ? [index] : [])
}
export function declaresRunningOrder(source: string): boolean {
  return runningOrderHeadingLines(source).length > 0
}
/** Park each Running order section, retaining every byte outside it. Section boundaries match the Plan parser. */
export function parkRunningOrder(source: string): string {
  const headings = new Set(runningOrderHeadingLines(source))
  const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []
  const plain = lines.map(text => ({ text: text.replace(/(?:\r\n|\r|\n)$/, '') }))
  const skipped = codeLines(plain)
  let removing = false
  return lines.filter((_line, index) => {
    if (headings.has(index)) { removing = true; return false }
    if (removing && !skipped[index] && /^ {0,3}#{1,6}(?:\s|$)/.test(plain[index].text)) removing = false
    return !removing
  }).join('')
}
