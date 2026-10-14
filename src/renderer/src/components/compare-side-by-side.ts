import type { AttributedChange, VersionCompareResult } from '../../../preload'

export type CompareSidePart = {
  kind: 'equal' | 'added' | 'removed'
  text: string
  formatting?: boolean
  style?: 'strong' | 'emphasis' | 'code' | 'link'
}

export type CompareMarkdownSpan = CompareSidePart

export type CompareMarkdownBlock = {
  kind: 'paragraph' | 'heading' | 'blockquote' | 'list-item' | 'blank'
  level?: number
  ordered?: boolean
  children: CompareMarkdownSpan[]
}

export type CompareChangeKind = 'added' | 'removed'

export type CompareSideBySideRow = {
  id: string
  kind: 'equal' | 'added' | 'removed' | 'changed'
  category: string
  provenance: AttributedChange['provenance'] | null
  author: AttributedChange['author'] | null
  sourceVersionName: string | null
  changeKinds: CompareChangeKind[]
  dimmed: boolean
  left: CompareSidePart[]
  right: CompareSidePart[]
}

export type CompareSideBySideFilters = {
  hiddenAuthors?: Set<string>
  hiddenProvenance?: Set<string>
  hiddenChangeKinds?: Set<CompareChangeKind>
}

export type ScrollSyncState = { locked: boolean }
export type ScrollPane = { scrollTop: number }

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function authorFilterKeys(author: AttributedChange['author']): string[] {
  return author.email ? [author.name, `${author.name}<${author.email}>`] : [author.name]
}

function part(kind: CompareSidePart['kind'], text: string, formatting = false): CompareSidePart[] {
  return text ? [{ kind, text, ...(formatting ? { formatting: true } : {}) }] : []
}

function markdownVisibleText(text: string): string {
  return text
    .replace(/^([ \t]{0,3})#{1,6}[ \t]+/gm, '$1')
    .replace(/^([ \t]*)>[ \t]?/gm, '$1')
    .replace(/^([ \t]*)(?:[-*+]|\d+\.)[ \t]+/gm, '$1')
    .replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
}

function isFormattingOnlyChange(oldText: string, newText: string): boolean {
  return oldText !== newText && markdownVisibleText(oldText) === markdownVisibleText(newText)
}

function touchesMarkdownFormatting(text: string): boolean {
  return (
    /(\*\*|__|\*|_|`)/.test(text) ||
    /\[[^\]\n]*\]|\]\([^)]+\)/.test(text) ||
    /(^|\n)[ \t]{0,3}#{1,6}[ \t]/.test(text) ||
    /(^|\n)[ \t]*(?:[-*+]|\d+\.)[ \t]+/.test(text) ||
    /(^|\n)[ \t]*>[ \t]?/.test(text)
  )
}

function markdownFormattingSignature(text: string): string {
  const markers: string[] = []
  const markerPattern = /(^|\n)([ \t]{0,3}#{1,6}[ \t]+)|(^|\n)([ \t]*>[ \t]?)|(^|\n)([ \t]*(?:[-*+]|\d+\.)[ \t]+)|(\*\*|__|\*|_|`)|(\[)|(\]\([^)]+\))/g
  for (const match of text.matchAll(markerPattern)) {
    markers.push(match[2] ?? match[4] ?? match[6] ?? match[7] ?? match[8] ?? match[9] ?? '')
  }
  return markers.join('|')
}

function changesMarkdownFormatting(change: AttributedChange): boolean {
  return markdownFormattingSignature(change.compareOldText) !== markdownFormattingSignature(change.compareNewText)
}

function pushText(out: CompareSidePart[], kind: CompareSidePart['kind'], text: string, formatting = false): void {
  if (!text) return
  const previous = out.at(-1)
  if (previous?.kind === kind && previous.formatting === formatting && previous.style === undefined) previous.text += text
  else out.push({ kind, text, ...(formatting ? { formatting: true } : {}) })
}

function inlineMarkdownMarkerParts(text: string, sideKind: 'added' | 'removed'): CompareSidePart[] {
  const out: CompareSidePart[] = []
  let pos = 0

  const nextMatch = (): { index: number; length: number; before: string; visible: string; after: string } | null => {
    const patterns = [
      /(\*\*|__)(.+?)\1/s,
      /(\*|_)([^*_]+?)\1/s,
      /`([^`\n]+)`/s,
      /\[([^\]\n]+)\]\(([^)]+)\)/s,
    ] as const
    let best: { index: number; length: number; before: string; visible: string; after: string } | null = null
    for (const pattern of patterns) {
      pattern.lastIndex = 0
      const match = pattern.exec(text.slice(pos))
      if (!match) continue
      let candidate: { index: number; length: number; before: string; visible: string; after: string }
      if (pattern.source.startsWith('\\`')) {
        candidate = { index: pos + match.index, length: match[0].length, before: '`', visible: match[1], after: '`' }
      } else if (pattern.source.startsWith('\\[')) {
        candidate = { index: pos + match.index, length: match[0].length, before: '[', visible: match[1], after: `](${match[2]})` }
      } else {
        const marker = match[1]
        candidate = { index: pos + match.index, length: match[0].length, before: marker, visible: match[2], after: marker }
      }
      if (!best || candidate.index < best.index) best = candidate
    }
    return best
  }

  for (;;) {
    const match = nextMatch()
    if (!match) break
    pushText(out, 'equal', text.slice(pos, match.index))
    pushText(out, sideKind, match.before, true)
    pushText(out, 'equal', match.visible)
    pushText(out, sideKind, match.after, true)
    pos = match.index + match.length
  }
  pushText(out, 'equal', text.slice(pos))
  return out
}

function formattingOnlyLineParts(line: string, sideKind: 'added' | 'removed'): CompareSidePart[] {
  const out: CompareSidePart[] = []
  let rest = line
  const heading = /^([ \t]{0,3})(#{1,6}[ \t]+)/.exec(rest)
  const quote = /^([ \t]*)(>[ \t]?)/.exec(rest)
  const list = /^([ \t]*)((?:[-*+]|\d+\.)[ \t]+)/.exec(rest)
  const marker = heading ?? quote ?? list
  if (marker) {
    pushText(out, 'equal', marker[1])
    pushText(out, sideKind, marker[2], true)
    rest = rest.slice(marker[0].length)
  }
  out.push(...inlineMarkdownMarkerParts(rest, sideKind))
  return out
}

function formattingOnlyParts(text: string, side: 'left' | 'right'): CompareSidePart[] {
  const sideKind = side === 'left' ? 'removed' : 'added'
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? []
  return lines.flatMap((line) => formattingOnlyLineParts(line, sideKind))
}

function partsFor(change: AttributedChange, side: 'left' | 'right'): CompareSidePart[] {
  if (change.diffKind === 'changed' && isFormattingOnlyChange(change.compareOldText, change.compareNewText)) {
    return formattingOnlyParts(side === 'left' ? change.compareOldText : change.compareNewText, side)
  }

  if (!change.compareSegments?.length) {
    return side === 'left'
      ? part(change.diffKind === 'added' ? 'equal' : 'removed', change.compareOldText)
      : part(change.diffKind === 'removed' ? 'equal' : 'added', change.compareNewText)
  }

  const formattingChanged = change.diffKind === 'changed' && changesMarkdownFormatting(change)
  const parts: CompareSidePart[] = []
  for (const segment of change.compareSegments) {
    if (segment.kind === 'equal') parts.push({ kind: 'equal', text: segment.text })
    else if (side === 'left' && segment.kind === 'removed') parts.push({ kind: 'removed', text: segment.text, ...(formattingChanged && touchesMarkdownFormatting(segment.text) ? { formatting: true } : {}) })
    else if (side === 'right' && segment.kind === 'added') parts.push({ kind: 'added', text: segment.text, ...(formattingChanged && touchesMarkdownFormatting(segment.text) ? { formatting: true } : {}) })
  }
  return parts
}

function categoryKey(change: AttributedChange): string {
  return change.category ?? 'uncategorised'
}

function changeKinds(change: AttributedChange): CompareChangeKind[] {
  if (change.diffKind === 'added') return ['added']
  if (change.diffKind === 'removed') return ['removed']
  return ['added', 'removed']
}

function dimmedByFilters(change: AttributedChange, filters: CompareSideBySideFilters): boolean {
  if (filters.hiddenProvenance?.has(change.provenance)) return true
  if (authorFilterKeys(change.author).some((key) => filters.hiddenAuthors?.has(key))) return true
  const kinds = changeKinds(change)
  if (kinds.every((kind) => filters.hiddenChangeKinds?.has(kind))) return true
  return false
}

function equalRow(id: string, left: string[], right: string[]): CompareSideBySideRow | null {
  const leftText = left.join('')
  const rightText = right.join('')
  if (!leftText && !rightText) return null
  return {
    id,
    kind: 'equal',
    category: 'unchanged',
    provenance: null,
    author: null,
    sourceVersionName: null,
    changeKinds: [],
    dimmed: false,
    left: part('equal', leftText),
    right: part('equal', rightText),
  }
}

export function buildSideBySideCompareRows(
  result: VersionCompareResult | null,
  filters: CompareSideBySideFilters = {},
): CompareSideBySideRow[] {
  if (!result) return []
  const leftLines = splitLines(result.fromContent)
  const rightLines = splitLines(result.toContent)
  const rows: CompareSideBySideRow[] = []
  let leftIndex = 0
  let rightIndex = 0

  const hunks = [...result.changes].sort((a, b) => {
    const left = (a.compareOldStart ?? Number.MAX_SAFE_INTEGER) - (b.compareOldStart ?? Number.MAX_SAFE_INTEGER)
    if (left !== 0) return left
    return (a.compareNewStart ?? Number.MAX_SAFE_INTEGER) - (b.compareNewStart ?? Number.MAX_SAFE_INTEGER)
  })

  hunks.forEach((change, index) => {
    const oldStart = Math.max(leftIndex, (change.compareOldStart ?? leftIndex + 1) - 1)
    const newStart = Math.max(rightIndex, (change.compareNewStart ?? rightIndex + 1) - 1)
    const unchanged = equalRow(`equal_${index}`, leftLines.slice(leftIndex, oldStart), rightLines.slice(rightIndex, newStart))
    if (unchanged) rows.push(unchanged)

    rows.push({
      id: change.id,
      kind: change.diffKind ?? 'changed',
      category: categoryKey(change),
      provenance: change.provenance,
      author: change.author,
      sourceVersionName: change.sourceVersionName,
      changeKinds: changeKinds(change),
      dimmed: dimmedByFilters(change, filters),
      left: partsFor(change, 'left'),
      right: partsFor(change, 'right'),
    })

    leftIndex = oldStart + (change.compareOldLines ?? splitLines(change.compareOldText).length)
    rightIndex = newStart + (change.compareNewLines ?? splitLines(change.compareNewText).length)
  })

  const tail = equalRow('equal_tail', leftLines.slice(leftIndex), rightLines.slice(rightIndex))
  if (tail) rows.push(tail)
  return rows
}

type CharPart = {
  ch: string
  kind: CompareSidePart['kind']
  formatting?: boolean
  style?: CompareSidePart['style']
}

function charsFromParts(parts: CompareSidePart[]): CharPart[] {
  return parts.flatMap((item) => Array.from(item.text).map((ch) => ({ ch, kind: item.kind, formatting: item.formatting, style: item.style })))
}

function textFromChars(chars: CharPart[]): string {
  return chars.map((item) => item.ch).join('')
}

function spanFromChars(chars: CharPart[], style?: CompareSidePart['style']): CompareMarkdownSpan | null {
  const text = textFromChars(chars)
  if (!text) return null
  return {
    kind: chars.some((item) => item.kind === 'added') ? 'added' : chars.some((item) => item.kind === 'removed') ? 'removed' : 'equal',
    text,
    ...(chars.some((item) => item.formatting) ? { formatting: true } : {}),
    ...(style ? { style } : {}),
  }
}

function splitLineChars(chars: CharPart[]): CharPart[][] {
  const lines: CharPart[][] = []
  let line: CharPart[] = []
  for (const item of chars) {
    if (item.ch === '\n') {
      lines.push(line)
      line = []
    } else {
      line.push(item)
    }
  }
  if (line.length || lines.length === 0) lines.push(line)
  return lines
}

function plainPrefix(chars: CharPart[], pattern: RegExp): RegExpExecArray | null {
  const match = pattern.exec(textFromChars(chars))
  if (!match) return null
  const markerLength = match[0].length
  return chars.slice(0, markerLength).some((item) => item.formatting) ? null : match
}

function pushSpan(out: CompareMarkdownSpan[], chars: CharPart[], style?: CompareSidePart['style']): void {
  const span = spanFromChars(chars, style)
  if (!span) return
  const previous = out.at(-1)
  if (
    previous &&
    previous.kind === span.kind &&
    previous.formatting === span.formatting &&
    previous.style === span.style
  ) previous.text += span.text
  else out.push(span)
}

function parseInlineChars(chars: CharPart[], inheritedStyle?: CompareSidePart['style']): CompareMarkdownSpan[] {
  const out: CompareMarkdownSpan[] = []
  let i = 0

  const markerPlain = (from: number, to: number): boolean =>
    chars.slice(from, to).every((item) => !item.formatting)

  while (i < chars.length) {
    const text = textFromChars(chars.slice(i))
    const strong = /^(\*\*|__)(.+?)\1/.exec(text)
    if (strong && markerPlain(i, i + strong[1].length) && markerPlain(i + strong[0].length - strong[1].length, i + strong[0].length)) {
      const start = i + strong[1].length
      const end = i + strong[0].length - strong[1].length
      parseInlineChars(chars.slice(start, end), 'strong').forEach((span) => out.push(span))
      i += strong[0].length
      continue
    }

    const emphasis = /^(\*|_)([^*_]+?)\1/.exec(text)
    if (emphasis && markerPlain(i, i + emphasis[1].length) && markerPlain(i + emphasis[0].length - emphasis[1].length, i + emphasis[0].length)) {
      const start = i + emphasis[1].length
      const end = i + emphasis[0].length - emphasis[1].length
      parseInlineChars(chars.slice(start, end), 'emphasis').forEach((span) => out.push(span))
      i += emphasis[0].length
      continue
    }

    const code = /^`([^`\n]+)`/.exec(text)
    if (code && markerPlain(i, i + 1) && markerPlain(i + code[0].length - 1, i + code[0].length)) {
      pushSpan(out, chars.slice(i + 1, i + code[0].length - 1), 'code')
      i += code[0].length
      continue
    }

    const link = /^\[([^\]\n]+)\]\(([^)]+)\)/.exec(text)
    if (link && markerPlain(i, i + 1) && markerPlain(i + 1 + link[1].length, i + link[0].length)) {
      pushSpan(out, chars.slice(i + 1, i + 1 + link[1].length), 'link')
      i += link[0].length
      continue
    }

    pushSpan(out, [chars[i]], inheritedStyle)
    i += 1
  }

  return out
}

export function buildMarkdownBlocks(parts: CompareSidePart[]): CompareMarkdownBlock[] {
  const lines = splitLineChars(charsFromParts(parts))
  return lines.map((line): CompareMarkdownBlock => {
    if (line.length === 0) return { kind: 'blank', children: [] }

    const headingMatch = plainPrefix(line, /^([ \t]{0,3})(#{1,6})[ \t]+/)
    if (headingMatch) {
      const markerLength = headingMatch[0].length
      return { kind: 'heading', level: headingMatch[2].length, children: parseInlineChars(line.slice(markerLength)) }
    }

    const visibleHeading = /^([ \t]{0,3})(#{1,6})[ \t]+/.exec(textFromChars(line))
    if (visibleHeading) {
      return { kind: 'heading', level: visibleHeading[2].length, children: parseInlineChars(line) }
    }

    const quoteMatch = plainPrefix(line, /^([ \t]*)(>[ \t]?)/)
    if (quoteMatch) return { kind: 'blockquote', children: parseInlineChars(line.slice(quoteMatch[0].length)) }

    const listMatch = plainPrefix(line, /^([ \t]*)(([-*+])|(\d+\.))[ \t]+/)
    if (listMatch) {
      return {
        kind: 'list-item',
        ordered: /\d+\./.test(listMatch[2]),
        children: parseInlineChars(line.slice(listMatch[0].length)),
      }
    }

    const visibleList = /^([ \t]*)(([-*+])|(\d+\.))[ \t]+/.exec(textFromChars(line))
    if (visibleList) {
      return { kind: 'list-item', ordered: /\d+\./.test(visibleList[2]), children: parseInlineChars(line) }
    }

    return { kind: 'paragraph', children: parseInlineChars(line) }
  })
}

export function syncScrollPair(
  source: ScrollPane,
  target: ScrollPane,
  state: ScrollSyncState,
  release: (unlock: () => void) => void,
): boolean {
  if (state.locked) return false
  state.locked = true
  target.scrollTop = source.scrollTop
  release(() => {
    state.locked = false
  })
  return true
}
