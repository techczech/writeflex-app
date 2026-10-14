/**
 * ADR-0039's one block rule, as pure text geometry. It lives in shared/ so the main process (the
 * agent's plan.compare_parts) and the renderer (focus modes, read-aloud, block marks, heading spacing)
 * split a document into blocks by the SAME rule; focus-modes.ts re-exports it. No CodeMirror imports.
 */

export type ParagraphRange = { from: number; to: number }

type LineRange = { from: number; to: number }
function lineRangesOf(text: string): LineRange[] {
  const lines: LineRange[] = []
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      lines.push({ from: start, to: i })
      start = i + 1
    }
  }
  return lines
}
const isBlank = (text: string, line: LineRange): boolean => text.slice(line.from, line.to).trim() === ''

const listPrefix = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)(?:\[(?: |x|X)\][ \t]+)?/

function indentColumns(text: string): number {
  let columns = 0
  for (const character of text) {
    if (character === ' ') columns++
    else if (character === '\t') columns += 4 - (columns % 4)
    else break
  }
  return columns
}

function listContentColumn(line: string): number | null {
  const match = listPrefix.exec(line)
  return match ? indentColumns(match[0]) : null
}

function hasOwnBlockSyntax(line: string): boolean {
  const content = line.trimStart().replace(/\r$/, '')
  if (listPrefix.test(line)) return true
  if (/^#{1,6}(?:[ \t]+|$)/.test(content)) return true
  if (/^>/.test(content)) return true
  if (/^(?:`{3,}|~{3,})/.test(content)) return true
  return content.startsWith('|') || content.endsWith('|') || /^:?-+:?(?:[ \t]*\|[ \t]*:?-+:?)+$/.test(content)
}

/**
 * ADR-0039's one block rule. Every typed newline starts a block unless the following line is an
 * indented, non-structural continuation of the currently open list item. Visual soft wrapping is
 * absent from the interface, so it cannot affect the result.
 */
export function blockRangesOf(text: string): ParagraphRange[] {
  const blocks: ParagraphRange[] = []
  let current: ParagraphRange | null = null
  let openListContentColumn: number | null = null

  for (const line of lineRangesOf(text)) {
    if (isBlank(text, line)) {
      if (current) blocks.push(current)
      current = null
      openListContentColumn = null
      continue
    }

    const lineText = text.slice(line.from, line.to)
    const lineListContentColumn = listContentColumn(lineText)
    const continuesList = current !== null
      && openListContentColumn !== null
      && lineListContentColumn === null
      && !hasOwnBlockSyntax(lineText)
      && indentColumns(lineText) >= openListContentColumn

    if (continuesList && current) {
      current.to = line.to
      continue
    }

    if (current) blocks.push(current)
    current = { from: line.from, to: line.to }
    openListContentColumn = lineListContentColumn
  }

  if (current) blocks.push(current)
  return blocks
}
