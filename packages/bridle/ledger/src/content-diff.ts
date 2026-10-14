export type ContentDiffSegment = {
  kind: 'equal' | 'added' | 'removed'
  text: string
}

export type ContentDiffHunk = {
  id: string
  kind: 'added' | 'removed' | 'changed'
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  oldText: string
  newText: string
  segments: ContentDiffSegment[]
}

type DiffOp<T> =
  | { kind: 'equal'; value: T }
  | { kind: 'removed'; value: T }
  | { kind: 'added'; value: T }

type DiffLine = {
  text: string
  key: string
}

type LineAlignment =
  | { kind: 'paired'; oldText: string; newText: string }
  | { kind: 'removed'; oldText: string }
  | { kind: 'added'; newText: string }

// Requiring half of the combined token mass to overlap keeps ordinary sentence
// edits paired while preventing unrelated neighbouring lines from becoming word soup.
const LINE_PAIR_SIMILARITY = 0.5

// Word LCS uses quadratic time and memory. Beyond this per-line budget, two
// related lines remain readable and bounded as a removed block plus an added block.
const MAX_WORD_DIFF_CHARACTERS = 2_000

function normaliseLine(text: string): string {
  const hasLineEnding = /(?:\r\n|\r|\n)$/.test(text)
  const body = text.replace(/(?:\r\n|\r|\n)$/, '').replace(/[\t\f\v ]+$/, '')
  return hasLineEnding ? `${body}\n` : body
}

function splitLines(text: string): DiffLine[] {
  return (text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? []).map((line) => ({
    text: line,
    key: normaliseLine(line),
  }))
}

function splitWords(text: string): string[] {
  const tokens: string[] = []
  let index = 0
  let atLineStart = true

  while (index < text.length) {
    const rest = text.slice(index)
    const whitespace = /^\s+/.exec(rest)?.[0]
    if (whitespace) {
      tokens.push(whitespace)
      index += whitespace.length
      if (whitespace.includes('\n') || whitespace.includes('\r')) atLineStart = true
      continue
    }

    if (atLineStart) {
      const leadingMarker = /^(?:#{1,6}|>|-|\d+\.)/.exec(rest)?.[0]
      if (leadingMarker) {
        tokens.push(leadingMarker)
        index += leadingMarker.length
        atLineStart = false
        continue
      }
    }

    const character = text[index]!
    if ('[]()*_`'.includes(character)) {
      tokens.push(character)
      index += 1
      atLineStart = false
      continue
    }

    let end = index + 1
    while (end < text.length && !/\s/.test(text[end]!) && !'[]()*_`'.includes(text[end]!)) end += 1
    tokens.push(text.slice(index, end))
    index = end
    atLineStart = false
  }

  return tokens
}

function lcsOps<T>(
  oldItems: readonly T[],
  newItems: readonly T[],
  equals: (oldItem: T, newItem: T) => boolean = (oldItem, newItem) => oldItem === newItem,
): DiffOp<T>[] {
  const table = Array.from({ length: oldItems.length + 1 }, () => Array<number>(newItems.length + 1).fill(0))
  for (let i = oldItems.length - 1; i >= 0; i -= 1) {
    for (let j = newItems.length - 1; j >= 0; j -= 1) {
      table[i]![j] = equals(oldItems[i]!, newItems[j]!)
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }

  const ops: DiffOp<T>[] = []
  let i = 0
  let j = 0
  while (i < oldItems.length && j < newItems.length) {
    if (equals(oldItems[i]!, newItems[j]!)) {
      // Equal line ops deliberately retain the new-side bytes.
      ops.push({ kind: 'equal', value: newItems[j]! })
      i += 1
      j += 1
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ kind: 'removed', value: oldItems[i]! })
      i += 1
    } else {
      ops.push({ kind: 'added', value: newItems[j]! })
      j += 1
    }
  }
  while (i < oldItems.length) {
    ops.push({ kind: 'removed', value: oldItems[i]! })
    i += 1
  }
  while (j < newItems.length) {
    ops.push({ kind: 'added', value: newItems[j]! })
    j += 1
  }
  return ops
}

function compactSegments(ops: DiffOp<string>[]): ContentDiffSegment[] {
  const out: ContentDiffSegment[] = []
  for (const op of ops) {
    const previous = out.at(-1)
    if (previous?.kind === op.kind) {
      previous.text += op.value
    } else {
      out.push({ kind: op.kind, text: op.value })
    }
  }
  return out
}

function wordSegments(oldText: string, newText: string): ContentDiffSegment[] {
  return compactSegments(lcsOps(splitWords(oldText), splitWords(newText)))
}

function lineTokens(text: string): string[] {
  const visibleText = normaliseLine(text)
    .toLocaleLowerCase()
    .replace(/^([ \t]{0,3})(?:#{1,6}|>|-|\d+\.)[ \t]+/, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
  return visibleText.trim().match(/\S+/g) ?? []
}

function tokenOverlapRatio(oldTokens: readonly string[], newTokens: readonly string[]): number {
  if (oldTokens.length === 0 || newTokens.length === 0) return 0
  const remaining = new Map<string, number>()
  for (const token of newTokens) remaining.set(token, (remaining.get(token) ?? 0) + 1)

  let overlap = 0
  for (const token of oldTokens) {
    const count = remaining.get(token) ?? 0
    if (count === 0) continue
    overlap += 1
    remaining.set(token, count - 1)
  }

  // Sørensen-Dice overlap is symmetric and penalises large insertions/deletions,
  // unlike overlap divided only by the shorter line.
  return (2 * overlap) / (oldTokens.length + newTokens.length)
}

function alignChangedLines(removed: readonly string[], added: readonly string[]): LineAlignment[] {
  const oldTokens = removed.map(lineTokens)
  const newTokens = added.map(lineTokens)
  const similarities = removed.map((_, oldIndex) => (
    added.map((__, newIndex) => tokenOverlapRatio(oldTokens[oldIndex]!, newTokens[newIndex]!))
  ))
  const table = Array.from({ length: removed.length + 1 }, () => Array<number>(added.length + 1).fill(0))

  for (let oldIndex = removed.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = added.length - 1; newIndex >= 0; newIndex -= 1) {
      const similarity = similarities[oldIndex]![newIndex]!
      const paired = similarity >= LINE_PAIR_SIMILARITY
        ? similarity + table[oldIndex + 1]![newIndex + 1]!
        : Number.NEGATIVE_INFINITY
      table[oldIndex]![newIndex] = Math.max(
        paired,
        table[oldIndex + 1]![newIndex]!,
        table[oldIndex]![newIndex + 1]!,
      )
    }
  }

  const alignment: LineAlignment[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < removed.length && newIndex < added.length) {
    const similarity = similarities[oldIndex]![newIndex]!
    const paired = similarity >= LINE_PAIR_SIMILARITY
      ? similarity + table[oldIndex + 1]![newIndex + 1]!
      : Number.NEGATIVE_INFINITY
    if (paired >= table[oldIndex + 1]![newIndex]!
      && paired >= table[oldIndex]![newIndex + 1]!) {
      alignment.push({ kind: 'paired', oldText: removed[oldIndex]!, newText: added[newIndex]! })
      oldIndex += 1
      newIndex += 1
    } else if (table[oldIndex + 1]![newIndex]! >= table[oldIndex]![newIndex + 1]!) {
      alignment.push({ kind: 'removed', oldText: removed[oldIndex]! })
      oldIndex += 1
    } else {
      alignment.push({ kind: 'added', newText: added[newIndex]! })
      newIndex += 1
    }
  }
  while (oldIndex < removed.length) {
    alignment.push({ kind: 'removed', oldText: removed[oldIndex]! })
    oldIndex += 1
  }
  while (newIndex < added.length) {
    alignment.push({ kind: 'added', newText: added[newIndex]! })
    newIndex += 1
  }
  return alignment
}

export function diffContent(oldContent: string, newContent: string): ContentDiffHunk[] {
  const oldLines = splitLines(oldContent)
  const newLines = splitLines(newContent)
  const ops = lcsOps(oldLines, newLines, (oldLine, newLine) => oldLine.key === newLine.key)
  const hunks: ContentDiffHunk[] = []
  let oldLine = 1
  let newLine = 1
  let index = 1

  const appendHunk = (hunk: Omit<ContentDiffHunk, 'id'>): void => {
    const previous = hunks.at(-1)
    const joinsRemoved = hunk.kind === 'removed'
      && previous?.kind === 'removed'
      && previous.oldStart + previous.oldLines === hunk.oldStart
      && previous.newStart === hunk.newStart
    const joinsAdded = hunk.kind === 'added'
      && previous?.kind === 'added'
      && previous.newStart + previous.newLines === hunk.newStart
      && previous.oldStart === hunk.oldStart

    if (previous && (joinsRemoved || joinsAdded)) {
      previous.oldLines += hunk.oldLines
      previous.newLines += hunk.newLines
      previous.oldText += hunk.oldText
      previous.newText += hunk.newText
      previous.segments[0]!.text += hunk.segments[0]!.text
      return
    }

    hunks.push({ id: `hunk_${index}`, ...hunk })
    index += 1
  }

  const appendRemoved = (oldStart: number, newStart: number, oldText: string): void => {
    appendHunk({
      kind: 'removed',
      oldStart,
      oldLines: 1,
      newStart,
      newLines: 0,
      oldText,
      newText: '',
      segments: [{ kind: 'removed', text: oldText }],
    })
  }

  const appendAdded = (oldStart: number, newStart: number, newText: string): void => {
    appendHunk({
      kind: 'added',
      oldStart,
      oldLines: 0,
      newStart,
      newLines: 1,
      oldText: '',
      newText,
      segments: [{ kind: 'added', text: newText }],
    })
  }

  for (let i = 0; i < ops.length;) {
    const op = ops[i]!
    if (op.kind === 'equal') {
      oldLine += 1
      newLine += 1
      i += 1
      continue
    }

    const oldStart = oldLine
    const newStart = newLine
    const removed: string[] = []
    const added: string[] = []
    while (i < ops.length && ops[i]!.kind !== 'equal') {
      const current = ops[i]!
      if (current.kind === 'removed') {
        removed.push(current.value.text)
        oldLine += 1
      } else {
        added.push(current.value.text)
        newLine += 1
      }
      i += 1
    }

    const alignment = alignChangedLines(removed, added)
    let oldOffset = 0
    let newOffset = 0
    for (const line of alignment) {
      if (line.kind === 'removed') {
        appendRemoved(oldStart + oldOffset, newStart + newOffset, line.oldText)
        oldOffset += 1
      } else if (line.kind === 'added') {
        appendAdded(oldStart + oldOffset, newStart + newOffset, line.newText)
        newOffset += 1
      } else if (line.oldText.length + line.newText.length > MAX_WORD_DIFF_CHARACTERS) {
        appendRemoved(oldStart + oldOffset, newStart + newOffset, line.oldText)
        oldOffset += 1
        appendAdded(oldStart + oldOffset, newStart + newOffset, line.newText)
        newOffset += 1
      } else {
        appendHunk({
          kind: 'changed',
          oldStart: oldStart + oldOffset,
          oldLines: 1,
          newStart: newStart + newOffset,
          newLines: 1,
          oldText: line.oldText,
          newText: line.newText,
          segments: wordSegments(line.oldText, line.newText),
        })
        oldOffset += 1
        newOffset += 1
      }
    }
  }

  return hunks
}
