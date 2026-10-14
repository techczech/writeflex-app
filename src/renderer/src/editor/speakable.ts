import { frontmatterBlock } from '../../../shared/markdown/frontmatter'
import { segmentSentences } from './sentences'

export type SpokenPiece = {
  spokenFrom: number
  spokenTo: number
  sourceFrom: number
  sourceTo: number
}

export type Speakable = {
  text: string
  pieces: SpokenPiece[]
}

export type PendingChange = {
  id: string
  from: number
  to: number
  kind: 'replace' | 'insert' | 'delete' | 'held'
  words: number
}

export type SpeakableOptions = {
  announce: 'announce' | 'silent' | 'tone'
  changes?: PendingChange[]
}

const NUMBER_WORDS = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
]

class SpeakableBuilder {
  text = ''
  readonly pieces: SpokenPiece[] = []
  private needsGapAfterAnnouncement = false

  constructor(
    private readonly source: string,
    private readonly baseOffset = 0,
  ) {}

  appendSource(sourceFrom: number, sourceTo: number, text = this.source.slice(sourceFrom, sourceTo)): void {
    if (text.length === 0) return

    if (this.needsGapAfterAnnouncement && !/^\s/.test(text)) {
      this.ensureGap(sourceFrom)
    }
    this.needsGapAfterAnnouncement = false

    const spokenFrom = this.text.length
    const absoluteFrom = sourceFrom + this.baseOffset
    const absoluteTo = sourceTo + this.baseOffset
    this.text += text
    const previous = this.pieces[this.pieces.length - 1]
    if (
      previous &&
      previous.spokenTo === spokenFrom &&
      previous.sourceTo === absoluteFrom &&
      previous.sourceFrom !== previous.sourceTo
    ) {
      previous.spokenTo = this.text.length
      previous.sourceTo = absoluteTo
      return
    }

    this.pieces.push({
      spokenFrom,
      spokenTo: this.text.length,
      sourceFrom: absoluteFrom,
      sourceTo: absoluteTo,
    })
  }

  appendSynthetic(text: string, sourceOffset: number): void {
    if (text.length === 0) return
    const spokenFrom = this.text.length
    const absoluteOffset = sourceOffset + this.baseOffset
    this.text += text
    this.pieces.push({
      spokenFrom,
      spokenTo: this.text.length,
      sourceFrom: absoluteOffset,
      sourceTo: absoluteOffset,
    })
  }

  appendAnnouncement(text: string, sourceOffset: number): void {
    this.ensureGap(sourceOffset)
    this.appendSynthetic(text, sourceOffset)
    this.needsGapAfterAnnouncement = true
  }

  ensureGap(sourceOffset: number): void {
    if (this.text.length > 0 && !/\s$/.test(this.text)) {
      this.appendSynthetic(' ', sourceOffset)
    }
  }
}

type ChangeAnnouncer = {
  nextFrom(): number | null
  emitThrough(sourceOffset: number): void
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf('\n', from)
  return end === -1 ? source.length : end
}

function nextLineStart(source: string, from: number): number {
  const end = lineEnd(source, from)
  return end < source.length ? end + 1 : source.length
}

function firstContentOffset(source: string, from: number, to: number): number {
  let offset = from
  while (offset < to && (source[offset] === ' ' || source[offset] === '\t')) offset++
  return offset
}

function isBlockPosition(source: string, offset: number): boolean {
  const previousNewline = source.lastIndexOf('\n', offset - 1)
  const lineFrom = previousNewline + 1
  const indent = source.slice(lineFrom, offset)
  return /^[ \t]{0,3}$/.test(indent)
}

type FenceOpening = {
  marker: '`' | '~'
  width: number
  contentFrom: number
}

function fenceOpeningAt(source: string, offset: number): FenceOpening | null {
  const marker = source[offset]
  if (marker !== '`' && marker !== '~') return null

  let markerTo = offset
  while (source[markerTo] === marker) markerTo++
  const width = markerTo - offset
  if (width < 3) return null

  const end = lineEnd(source, offset)
  return {
    marker,
    width,
    contentFrom: end < source.length ? end + 1 : end,
  }
}

function isFenceClosingLine(line: string, marker: '`' | '~', width: number): boolean {
  let offset = 0
  while (offset < line.length && offset < 3 && line[offset] === ' ') offset++

  const markerFrom = offset
  while (offset < line.length && line[offset] === marker) offset++
  if (offset - markerFrom < width) return false

  while (offset < line.length && (line[offset] === ' ' || line[offset] === '\t' || line[offset] === '\r')) {
    offset++
  }
  return offset === line.length
}

function scanFence(
  source: string,
  opening: FenceOpening,
): { after: number; lineCount: number } {
  let cursor = opening.contentFrom
  let lineCount = 0

  while (cursor < source.length) {
    const end = lineEnd(source, cursor)
    const line = source.slice(cursor, end)
    if (isFenceClosingLine(line, opening.marker, opening.width)) {
      return {
        after: end < source.length ? end + 1 : end,
        lineCount,
      }
    }

    lineCount++
    cursor = end < source.length ? end + 1 : end
  }

  return { after: source.length, lineCount }
}

type Heading = {
  level: number
  contentFrom: number
  contentTo: number
  after: number
}

function headingAt(source: string, offset: number): Heading | null {
  if (source[offset] !== '#') return null

  let markerTo = offset
  while (source[markerTo] === '#') markerTo++
  const level = markerTo - offset
  if (level > 6 || (markerTo < source.length && !/[ \t\n]/.test(source[markerTo]))) return null

  const end = lineEnd(source, offset)
  let contentFrom = markerTo
  while (contentFrom < end && (source[contentFrom] === ' ' || source[contentFrom] === '\t')) contentFrom++

  let contentTo = end
  while (contentTo > contentFrom && /[ \t\r]/.test(source[contentTo - 1])) contentTo--

  let closingFrom = contentTo
  while (closingFrom > contentFrom && source[closingFrom - 1] === '#') closingFrom--
  if (closingFrom < contentTo && closingFrom > contentFrom && /[ \t]/.test(source[closingFrom - 1])) {
    contentTo = closingFrom - 1
    while (contentTo > contentFrom && /[ \t]/.test(source[contentTo - 1])) contentTo--
  }

  return {
    level,
    contentFrom,
    contentTo,
    after: end < source.length ? end + 1 : end,
  }
}

function isLineContentStart(source: string, offset: number): boolean {
  const lineFrom = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*$/.test(source.slice(lineFrom, offset))
}

function listItemPrefixEnd(source: string, offset: number, limit: number): number | null {
  if (!isLineContentStart(source, offset)) return null
  const lineTo = Math.min(lineEnd(source, offset), limit)
  const line = source.slice(offset, lineTo)
  const list = /^(?:[-+*]|\d{1,9}[.)])[ \t]+(?:\[(?: |x|X)\][ \t]+)?/.exec(line)
  return list ? offset + list[0].length : null
}

function commentAfter(source: string, offset: number, limit = source.length): number {
  const close = source.indexOf('-->', offset + 4)
  if (close !== -1 && close + 3 <= limit) return close + 3
  return Math.min(nextLineStart(source, offset), limit)
}

function inlinePrefixEnd(source: string, offset: number, limit: number): number | null {
  if (!isLineContentStart(source, offset)) return null
  const lineTo = Math.min(lineEnd(source, offset), limit)
  const line = source.slice(offset, lineTo)
  const quote = /^(?:>[ \t]?)+/.exec(line)
  if (quote) return offset + quote[0].length
  return listItemPrefixEnd(source, offset, limit)
}

function closingBracket(source: string, opening: number, limit: number): number {
  let depth = 0
  for (let cursor = opening; cursor < limit; cursor++) {
    if (source[cursor] === '\\') {
      cursor++
      continue
    }
    if (source[cursor] === '[') depth++
    if (source[cursor] === ']') {
      depth--
      if (depth === 0) return cursor
    }
  }
  return -1
}

function closingParenthesis(source: string, opening: number, limit: number): number {
  let depth = 0
  for (let cursor = opening; cursor < limit; cursor++) {
    if (source[cursor] === '\\') {
      cursor++
      continue
    }
    if (source[cursor] === '(') depth++
    if (source[cursor] === ')') {
      depth--
      if (depth === 0) return cursor
    }
  }
  return -1
}

type MarkdownLink = {
  labelFrom: number
  labelTo: number
  after: number
}

function markdownLinkAt(source: string, offset: number, limit: number): MarkdownLink | null {
  const image = source[offset] === '!' && source[offset + 1] === '['
  const opening = image ? offset + 1 : offset
  if (source[opening] !== '[' || source[opening + 1] === '[') return null

  const labelTo = closingBracket(source, opening, limit)
  if (labelTo === -1 || source[labelTo + 1] !== '(') return null
  const destinationTo = closingParenthesis(source, labelTo + 1, limit)
  if (destinationTo === -1) return null

  return {
    labelFrom: opening + 1,
    labelTo,
    after: destinationTo + 1,
  }
}

function isEmphasisMarker(source: string, offset: number): boolean {
  if (source[offset] === '*') return true
  if (source[offset] !== '_') return false

  const before = offset > 0 ? source[offset - 1] : ''
  const after = offset + 1 < source.length ? source[offset + 1] : ''
  return !(/[\p{L}\p{N}]/u.test(before) && /[\p{L}\p{N}]/u.test(after))
}

function appendInline(
  source: string,
  builder: SpeakableBuilder,
  from: number,
  to: number,
): void {
  let cursor = from
  let runFrom = from
  let pendingSpace: { sourceOffset: number; synthetic: boolean } | null = null

  const appendPendingSpace = (): void => {
    if (pendingSpace === null) return
    if (builder.text.length > 0 && !/\s$/.test(builder.text)) {
      if (pendingSpace.synthetic) {
        builder.appendSynthetic(' ', pendingSpace.sourceOffset)
      } else {
        builder.appendSource(pendingSpace.sourceOffset, pendingSpace.sourceOffset + 1, ' ')
      }
    }
    pendingSpace = null
  }

  const appendRun = (runTo: number): void => {
    if (runTo <= runFrom) return
    appendPendingSpace()
    builder.appendSource(runFrom, runTo)
  }

  while (cursor < to) {
    if (/\s/.test(source[cursor])) {
      appendRun(cursor)
      const whitespaceFrom = cursor
      cursor++
      while (cursor < to && /\s/.test(source[cursor])) cursor++
      if (pendingSpace === null) {
        const relativeSpace = source.slice(whitespaceFrom, cursor).indexOf(' ')
        const hasLiteralSpace = relativeSpace !== -1
        pendingSpace = {
          sourceOffset: hasLiteralSpace ? whitespaceFrom + relativeSpace : whitespaceFrom,
          synthetic: !hasLiteralSpace,
        }
      }
      runFrom = cursor
      continue
    }

    const prefixTo = inlinePrefixEnd(source, cursor, to)
    if (prefixTo !== null) {
      appendRun(cursor)
      cursor = prefixTo
      runFrom = cursor
      continue
    }

    if (source.startsWith('<!--', cursor)) {
      appendRun(cursor)
      const commentFrom = cursor
      cursor = commentAfter(source, cursor, to)
      if (pendingSpace === null) pendingSpace = { sourceOffset: commentFrom, synthetic: true }
      runFrom = cursor
      continue
    }

    if (source.startsWith('[[', cursor)) {
      const close = source.indexOf(']]', cursor + 2)
      if (close !== -1 && close + 2 <= to) {
        appendRun(cursor)
        appendPendingSpace()

        const separator = source.indexOf('|', cursor + 2)
        const hasDisplay = separator !== -1 && separator < close && separator + 1 < close
        const visibleFrom = hasDisplay ? separator + 1 : cursor + 2
        const visibleTo = close
        appendInline(source, builder, visibleFrom, visibleTo)

        cursor = close + 2
        runFrom = cursor
        continue
      }
    }

    const link = markdownLinkAt(source, cursor, to)
    if (link) {
      appendRun(cursor)
      appendPendingSpace()
      appendInline(source, builder, link.labelFrom, link.labelTo)
      cursor = link.after
      runFrom = cursor
      continue
    }

    if (isEmphasisMarker(source, cursor)) {
      appendRun(cursor)
      cursor++
      runFrom = cursor
      continue
    }

    cursor++
  }

  appendRun(to)
}

function appendProjectionSlice(
  builder: SpeakableBuilder,
  projection: Speakable,
  from: number,
  to: number,
  pieceIndex: number,
  changes: ChangeAnnouncer,
): number {
  while (
    pieceIndex < projection.pieces.length &&
    projection.pieces[pieceIndex].spokenTo <= from
  ) {
    pieceIndex++
  }

  while (
    pieceIndex < projection.pieces.length &&
    projection.pieces[pieceIndex].spokenFrom < to
  ) {
    const piece = projection.pieces[pieceIndex]

    const spokenFrom = Math.max(from, piece.spokenFrom)
    const spokenTo = Math.min(to, piece.spokenTo)
    const text = projection.text.slice(spokenFrom, spokenTo)
    if (piece.sourceFrom === piece.sourceTo) {
      changes.emitThrough(piece.sourceFrom)
      builder.appendSynthetic(text, piece.sourceFrom)
    } else {
      const sourceFrom = piece.sourceFrom + (spokenFrom - piece.spokenFrom)
      const sourceTo = sourceFrom + text.length
      let textFrom = 0

      changes.emitThrough(sourceFrom)
      let nextChange = changes.nextFrom()
      while (nextChange !== null && nextChange < sourceTo) {
        const textTo = nextChange - sourceFrom
        builder.appendSource(sourceFrom + textFrom, nextChange, text.slice(textFrom, textTo))
        changes.emitThrough(nextChange)
        textFrom = textTo
        nextChange = changes.nextFrom()
      }
      builder.appendSource(sourceFrom + textFrom, sourceTo, text.slice(textFrom))
    }

    if (piece.spokenTo > to) break
    pieceIndex++
  }

  return pieceIndex
}

function projectionSourceAnchor(
  projection: Speakable,
  spokenIndex: number,
  pieceIndex: number,
): number {
  while (
    pieceIndex < projection.pieces.length &&
    projection.pieces[pieceIndex].spokenTo <= spokenIndex
  ) {
    pieceIndex++
  }

  const piece = projection.pieces[pieceIndex]
  if (!piece) return projection.pieces[projection.pieces.length - 1]?.sourceTo ?? 0
  if (piece.sourceFrom === piece.sourceTo) return piece.sourceFrom
  return piece.sourceFrom + Math.max(0, spokenIndex - piece.spokenFrom)
}

function appendSegmented(
  source: string,
  builder: SpeakableBuilder,
  from: number,
  to: number,
  ensureTerminal: boolean,
  changes: ChangeAnnouncer,
): void {
  const inline = new SpeakableBuilder(source)
  appendInline(source, inline, from, to)
  const projection: Speakable = { text: inline.text, pieces: inline.pieces }
  const sentences = segmentSentences(projection.text)
  let pieceIndex = 0

  for (const sentence of sentences) {
    const sourceAnchor = projectionSourceAnchor(projection, sentence.from, pieceIndex)
    changes.emitThrough(sourceAnchor)
    builder.ensureGap(sourceAnchor)
    pieceIndex = appendProjectionSlice(builder, projection, sentence.from, sentence.to, pieceIndex, changes)
  }

  changes.emitThrough(to)

  if (
    ensureTerminal &&
    sentences.length > 0 &&
    !/[.!?…]["'”’)\]]?$/.test(builder.text)
  ) {
    builder.appendSynthetic('.', to)
  }
}

function paragraphEnd(source: string, from: number): number {
  let end = lineEnd(source, from)

  while (end < source.length) {
    const nextFrom = end + 1
    const nextEnd = lineEnd(source, nextFrom)
    const contentFrom = firstContentOffset(source, nextFrom, nextEnd)
    if (contentFrom === nextEnd) return end

    if (
      isBlockPosition(source, contentFrom) &&
      (
        headingAt(source, contentFrom) ||
        fenceOpeningAt(source, contentFrom) ||
        source.startsWith('<!--', contentFrom)
      )
    ) {
      return end
    }

    end = nextEnd
  }

  return end
}

function listItemEnd(source: string, from: number, contentFrom: number): number {
  let end = lineEnd(source, from)
  const contentColumn = contentFrom - (source.lastIndexOf('\n', from - 1) + 1)

  while (end < source.length) {
    const nextFrom = end + 1
    const nextEnd = lineEnd(source, nextFrom)
    const nextContentFrom = firstContentOffset(source, nextFrom, nextEnd)
    if (nextContentFrom === nextEnd) break
    if (listItemPrefixEnd(source, nextContentFrom, nextEnd) !== null) break
    if (nextContentFrom - nextFrom < contentColumn) break
    end = nextEnd
  }

  return end
}

function thematicBreakAfter(source: string, offset: number): number | null {
  if (!isBlockPosition(source, offset)) return null
  const end = lineEnd(source, offset)
  const line = source.slice(offset, end).replace(/\r$/, '')
  const thematic = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(line)
  return thematic ? (end < source.length ? end + 1 : end) : null
}

function setextHeadingAt(source: string, offset: number): Heading | null {
  if (!isBlockPosition(source, offset)) return null
  const contentEnd = lineEnd(source, offset)
  if (contentEnd === source.length) return null

  const underlineFrom = contentEnd + 1
  const underlineEnd = lineEnd(source, underlineFrom)
  const underline = source.slice(underlineFrom, underlineEnd).replace(/\r$/, '')
  const match = /^[ \t]{0,3}(=+|-+)[ \t]*$/.exec(underline)
  if (!match) return null

  let contentTo = contentEnd
  while (contentTo > offset && /[ \t\r]/.test(source[contentTo - 1])) contentTo--
  if (contentTo === offset) return null

  return {
    level: match[1][0] === '=' ? 1 : 2,
    contentFrom: offset,
    contentTo,
    after: underlineEnd < source.length ? underlineEnd + 1 : underlineEnd,
  }
}

function indentedCodeAt(source: string, offset: number): { after: number; lineCount: number } | null {
  const lineFrom = source.lastIndexOf('\n', offset - 1) + 1
  const indent = source.slice(lineFrom, offset)
  if (!/^(?: {4,}|\t)/.test(indent)) return null

  let cursor = lineFrom
  let lineCount = 0
  while (cursor < source.length) {
    const end = lineEnd(source, cursor)
    const line = source.slice(cursor, end).replace(/\r$/, '')
    if (line.trim() !== '' && !/^(?: {4}|\t)/.test(line)) break
    if (line.trim() !== '') lineCount++
    cursor = end < source.length ? end + 1 : end
  }

  return { after: cursor, lineCount }
}

function tableAfter(source: string, offset: number): number | null {
  if (!isBlockPosition(source, offset)) return null
  const headerEnd = lineEnd(source, offset)
  if (headerEnd === source.length) return null
  const header = source.slice(offset, headerEnd).replace(/\r$/, '')
  if (!header.includes('|')) return null

  const delimiterFrom = headerEnd + 1
  const delimiterEnd = lineEnd(source, delimiterFrom)
  const delimiter = source.slice(delimiterFrom, delimiterEnd).replace(/\r$/, '').trim()
  const cells = delimiter.replace(/^\|/, '').replace(/\|$/, '').split('|')
  if (cells.length === 0 || cells.some((cell) => !/^[ \t]*:?-+:?[ \t]*$/.test(cell))) {
    return null
  }

  let cursor = delimiterEnd < source.length ? delimiterEnd + 1 : delimiterEnd
  while (cursor < source.length) {
    const end = lineEnd(source, cursor)
    const line = source.slice(cursor, end).replace(/\r$/, '')
    if (line.trim() === '' || !line.includes('|')) break
    cursor = end < source.length ? end + 1 : end
  }
  return cursor
}

function numberWord(value: number): string {
  return NUMBER_WORDS[value] || String(value)
}

function changeAnnouncer(
  builder: SpeakableBuilder,
  changes: PendingChange[],
  mode: SpeakableOptions['announce'],
): ChangeAnnouncer {
  let index = 0

  return {
    nextFrom: () => changes[index]?.from ?? null,
    emitThrough: (sourceOffset) => {
      while (index < changes.length && changes[index].from <= sourceOffset) {
        const change = changes[index]
        if (mode === 'announce') {
          const wordCount = `${numberWord(change.words)} ${change.words === 1 ? 'word' : 'words'}`
          const label = change.kind === 'held' ? 'agent proposal held' : 'agent proposal'
          builder.appendAnnouncement(`${label}, ${wordCount}.`, change.from)
        }
        index++
      }
    },
  }
}

/**
 * Project one source slice into speech. `from` shifts every source coordinate in the returned
 * piece map, matching segmentSentences(text, from): callers may project a paragraph while keeping
 * the map in document-absolute space.
 */
export function projectSpeakable(
  source: string,
  options: SpeakableOptions,
  from = 0,
): Speakable {
  const builder = new SpeakableBuilder(source, from)
  const sortedChanges = [...(options.changes ?? [])].sort((left, right) => left.from - right.from)
  const changes = changeAnnouncer(builder, sortedChanges, options.announce)
  const frontmatter = frontmatterBlock(source)
  let cursor = frontmatter?.end ?? (source.startsWith('\uFEFF') ? 1 : 0)

  while (cursor < source.length) {
    while (cursor < source.length && /\s/.test(source[cursor])) cursor++
    changes.emitThrough(cursor)
    if (cursor >= source.length) break

    if (source.startsWith('<!--', cursor)) {
      cursor = commentAfter(source, cursor)
      changes.emitThrough(cursor)
      continue
    }

    const indentedCode = indentedCodeAt(source, cursor)
    if (indentedCode) {
      if (options.announce === 'announce') {
        builder.appendAnnouncement(
          `Code block, ${numberWord(indentedCode.lineCount)} ${indentedCode.lineCount === 1 ? 'line' : 'lines'}, skipped.`,
          cursor,
        )
      }
      cursor = indentedCode.after
      changes.emitThrough(cursor)
      continue
    }

    if (isBlockPosition(source, cursor)) {
      const table = tableAfter(source, cursor)
      if (table !== null) {
        cursor = table
        changes.emitThrough(cursor)
        continue
      }

      const fence = fenceOpeningAt(source, cursor)
      if (fence) {
        const skipped = scanFence(source, fence)
        if (options.announce === 'announce') {
          builder.ensureGap(cursor)
          builder.appendSynthetic(
            `Code block, ${numberWord(skipped.lineCount)} ${skipped.lineCount === 1 ? 'line' : 'lines'}, skipped.`,
            cursor,
          )
        }
        cursor = skipped.after
        changes.emitThrough(cursor)
        continue
      }

      const setext = setextHeadingAt(source, cursor)
      if (setext) {
        builder.ensureGap(cursor)
        if (options.announce === 'announce') {
          builder.appendSynthetic(`Heading, level ${numberWord(setext.level)}: `, cursor)
        }
        appendSegmented(source, builder, setext.contentFrom, setext.contentTo, true, changes)
        cursor = setext.after
        continue
      }

      const heading = headingAt(source, cursor)
      if (heading) {
        builder.ensureGap(cursor)
        if (options.announce === 'announce') {
          builder.appendSynthetic(`Heading, level ${numberWord(heading.level)}: `, cursor)
        }
        appendSegmented(source, builder, heading.contentFrom, heading.contentTo, true, changes)
        cursor = heading.after
        continue
      }

      const listContentFrom = listItemPrefixEnd(source, cursor, lineEnd(source, cursor))
      if (listContentFrom !== null) {
        const end = listItemEnd(source, cursor, listContentFrom)
        appendSegmented(source, builder, listContentFrom, end, true, changes)
        cursor = end
        continue
      }

      const thematicBreak = thematicBreakAfter(source, cursor)
      if (thematicBreak !== null) {
        cursor = thematicBreak
        changes.emitThrough(cursor)
        continue
      }
    }

    const end = paragraphEnd(source, cursor)
    appendSegmented(source, builder, cursor, end, false, changes)
    cursor = end
  }

  changes.emitThrough(source.length)

  return {
    text: builder.text,
    pieces: builder.pieces,
  }
}

export function sourceOffsetAt(speakable: Speakable, spokenIndex: number): number | null {
  let low = 0
  let high = speakable.pieces.length - 1

  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2)
    const piece = speakable.pieces[middle]

    if (spokenIndex < piece.spokenFrom) {
      high = middle - 1
    } else if (spokenIndex >= piece.spokenTo) {
      low = middle + 1
    } else if (piece.sourceFrom === piece.sourceTo) {
      return null
    } else {
      return piece.sourceFrom + (spokenIndex - piece.spokenFrom)
    }
  }

  return null
}
