import { parseTable, validateObjectMarkup, type ObjectKind } from '../../../shared/object-markup'
import type { LivePreviewBlock } from './live-preview'
import { innerSource } from './object-editors/registry'

export type CodeObjectConversion = {
  kind: ObjectKind
  label: string
  replacement: string
}

const objectLabels: Record<ObjectKind, string> = {
  mermaid: 'Convert to flow diagram object',
  markmap: 'Convert to mind map object',
  table: 'Convert to table object',
  svg: 'Convert to SVG object',
}

function finalNewline(source: string): string {
  return source.endsWith('\n') ? '\n' : ''
}

function fencedInner(block: LivePreviewBlock): string {
  return innerSource(block).replace(/\n+$/, '')
}

export function objectToText(block: LivePreviewBlock): string {
  if (block.kind === 'table' || block.kind === 'image') return block.source
  return `${fencedInner(block)}${finalNewline(block.source)}`
}

export function objectToCode(block: LivePreviewBlock): string {
  if (block.kind === 'code') return block.source
  const language = block.kind === 'mermaid' || block.kind === 'markmap' || block.kind === 'svg'
    ? `${block.kind} code`
    : block.kind === 'frontmatter'
      ? 'yaml'
      : 'markdown'
  const inner = block.kind === 'table' || block.kind === 'image'
    ? block.source.replace(/\n+$/, '')
    : fencedInner(block)
  return `\`\`\`${language}\n${inner}\n\`\`\`${finalNewline(block.source)}`
}

function parsesAs(kind: ObjectKind, source: string): boolean {
  try {
    validateObjectMarkup(kind, source)
    return true
  } catch {
    return false
  }
}

function conversionKind(language: string, inner: string): ObjectKind | null {
  const tag = language.trim().toLowerCase()
  if (tag === 'mermaid' && parsesAs('mermaid', inner)) return 'mermaid'
  if (tag === 'markmap' && parsesAs('markmap', inner)) return 'markmap'
  if (tag === 'svg' && parsesAs('svg', inner)) return 'svg'
  if ((tag === 'table' || tag === 'markdown' || tag === 'md') && parseTable(inner)) return 'table'
  if (parsesAs('mermaid', inner)) return 'mermaid'
  if (parsesAs('markmap', inner)) return 'markmap'
  if (parseTable(inner)) return 'table'
  return null
}

export function codeObjectConversion(block: LivePreviewBlock): CodeObjectConversion | null {
  if (block.kind !== 'code') return null
  const inner = fencedInner(block)
  const kind = conversionKind(block.language ?? '', inner)
  if (!kind) return null
  const replacement = kind === 'table'
    ? `${inner}${finalNewline(block.source)}`
    : `\`\`\`${kind}\n${inner}\n\`\`\`${finalNewline(block.source)}`
  return { kind, label: objectLabels[kind], replacement }
}

const headingLine = /^ {0,3}(#{1,6})[ \t]+\S/
const listLine = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?\S/

function outlineShaped(lines: readonly { text: string }[]): boolean {
  return lines.some(({ text }) => headingLine.test(text) || listLine.test(text))
}

export function outlineToMindMap(doc: string, from: number, to = from): { from: number; to: number; replacement: string } | null {
  if (from < 0 || to < from || to > doc.length) return null
  const lines = doc.split('\n')
  let offset = 0
  const ranges = lines.map((text) => {
    const from = offset
    offset += text.length + 1
    return { text, from, to: from + text.length }
  })
  const lineAt = (position: number) => ranges.findIndex((line, lineIndex) => position >= line.from && (position <= line.to || (lineIndex < ranges.length - 1 && position === line.to + 1)))
  let start = lineAt(from)
  let end = lineAt(to > from ? to - 1 : to)
  if (start < 0 || end < 0) return null

  if (to > from) {
    if (!outlineShaped(ranges.slice(start, end + 1))) return null
  } else {
    const heading = headingLine.exec(ranges[start].text)
    if (heading) {
      const level = heading[1].length
      end = ranges.length - 1
      for (let cursor = start + 1; cursor < ranges.length; cursor += 1) {
        const next = headingLine.exec(ranges[cursor].text)
        if (next && next[1].length <= level) { end = cursor - 1; break }
      }
      while (end > start && ranges[end].text === '') end -= 1
    } else if (listLine.test(ranges[start].text)) {
      while (start > 0 && listLine.test(ranges[start - 1].text)) start -= 1
      while (end + 1 < ranges.length && listLine.test(ranges[end + 1].text)) end += 1
    } else return null
  }
  const source = ranges.slice(start, end + 1).map((line) => line.text).join('\n')
  return {
    from: ranges[start].from,
    to: ranges[end].to,
    replacement: `\`\`\`markmap\n${source}\n\`\`\``,
  }
}
