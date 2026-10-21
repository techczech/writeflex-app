/**
 * The Folio's heading flow (ADR-0046, rule B): the headings of the running order read as one document, with
 * each file's start marked. The sidebar Outline draws it; the export's contents and the Folio outline's
 * "continues" chip read the same facts. Pure and read-only (nothing here touches a file).
 *
 * Chapter level: the most common level of the contents parts' first headings, each part counted once; a tie
 * goes to the shallower level. A part whose first heading is at that level or shallower is a chapter. A part
 * that opens deeper continues the part before it and nests under that part's chapter. A part with no heading
 * (none in the text, or `heading: none`) is a chapter titled by its title. Front matter is outside the count,
 * is never a chapter and never nests. A first heading that is the part's own title (`mode` `own`, decided
 * by folio-part-title.ts) counts at its level like any other and is the part's row, not listed again.
 */

import { partChildHeadings, type PartHeadingMode } from './folio-part-title'
import type { FolioOutline } from './folio-outline'

export type FlowPartInput<T extends { level: number; text: string }> = {
  path: string
  /** The part's title (the title rule's answer). */
  title: string
  /** The title rule's mode (folio-part-title.ts): `own` = the first heading is the title. */
  mode: PartHeadingMode
  /** Every ATX heading of the part, in order. */
  headings: readonly T[]
  frontMatter?: boolean
}

export type FlowPart<T extends { level: number; text: string }> = {
  /** Index in the input (the running order). */
  index: number
  path: string
  title: string
  /** `front`: before the contents. `chapter`: a chapter row. `continues`: opens deeper than the chapter level, so it nests under the part before it. */
  role: 'front' | 'chapter' | 'continues'
  /** Contents parts only: the 1-based number of the chapter this part is (chapter) or sits under (continues). */
  chapterNumber: number | null
  /** The input index of that chapter's part. */
  chapterIndex: number | null
  /** Nesting depth of the part's own row: 0 for a chapter, 1 or more for a continuing part. */
  depth: number
  /** Level of the part's first heading that counted (null: none, or `heading: none`). */
  firstLevel: number | null
  /** The part's headings without its own title heading, each with its nesting depth (1 = directly under the part's row). */
  children: Array<T & { depth: number }>
}

export type FlowRow<T extends { level: number; text: string }> =
  | { kind: 'mark'; partIndex: number; path: string }
  | { kind: 'part'; partIndex: number; path: string; text: string; depth: number; continues: boolean }
  | { kind: 'heading'; partIndex: number; path: string; text: string; depth: number; heading: T & { depth: number } }

export type HeadingFlow<T extends { level: number; text: string }> = {
  /** The chapter level (1 when no contents part has a heading). */
  chapterLevel: number
  chapters: number
  /** Input indexes of the front-matter parts, in order. */
  front: number[]
  /** One entry per input part, in order. */
  parts: Array<FlowPart<T>>
  /** The contents as one flat list: a mark where each file starts, its row, its headings. Front matter has none. */
  rows: Array<FlowRow<T>>
}

/** The most common level; a tie goes to the shallower one. */
function commonLevel(levels: readonly number[]): number {
  const counts = new Map<number, number>()
  for (const level of levels) counts.set(level, (counts.get(level) ?? 0) + 1)
  let best = 1
  let bestCount = 0
  for (const [level, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) { best = level; bestCount = count }
  }
  return best
}

export function folioHeadingFlow<T extends { level: number; text: string }>(inputs: readonly FlowPartInput<T>[]): HeadingFlow<T> {
  const firstLevelOf = (part: FlowPartInput<T>): number | null => (part.mode === 'none' ? null : part.headings[0]?.level ?? null)
  const counted = inputs.flatMap((part) => (part.frontMatter === true ? [] : [firstLevelOf(part)])).filter((level): level is number => level !== null)
  const chapterLevel = counted.length === 0 ? 1 : commonLevel(counted)

  let chapters = 0
  let chapterIndex: number | null = null
  const front: number[] = []
  const parts: Array<FlowPart<T>> = inputs.map((part, index) => {
    const firstLevel = firstLevelOf(part)
    const shown = partChildHeadings<T>(part.headings, part.mode, part.title)
    // The title heading's level, when the first heading is the part's own title.
    const titleLevel = part.mode === 'own' && part.headings.length > 0 ? part.headings[0].level : null
    if (part.frontMatter === true) {
      front.push(index)
      return { index, path: part.path, title: part.title, role: 'front', chapterNumber: null, chapterIndex: null, depth: 0, firstLevel, children: shown.map((heading) => ({ ...heading, depth: 1 })) }
    }
    const continues = chapterIndex !== null && firstLevel !== null && firstLevel > chapterLevel
    if (!continues) { chapters += 1; chapterIndex = index }
    const depth = continues ? Math.max((titleLevel ?? firstLevel ?? chapterLevel) - chapterLevel, 1) : 0
    const shallowest = shown.reduce((least, heading) => Math.min(least, heading.level), 7)
    // A chapter's headings nest under its row (relative to its own heading); a continuing part's sit by level below the chapter level.
    const base = titleLevel ?? (shown.length > 0 ? shallowest - 1 : chapterLevel)
    return {
      index, path: part.path, title: part.title, role: continues ? 'continues' : 'chapter', chapterNumber: chapters, chapterIndex, depth, firstLevel,
      children: shown.map((heading) => ({ ...heading, depth: continues ? Math.max(heading.level - chapterLevel, 1) : Math.max(heading.level - base, 1) })),
    }
  })

  const rows: Array<FlowRow<T>> = []
  for (const part of parts) {
    if (part.role === 'front') continue
    rows.push({ kind: 'mark', partIndex: part.index, path: part.path })
    rows.push({ kind: 'part', partIndex: part.index, path: part.path, text: part.title, depth: part.depth, continues: part.role === 'continues' })
    for (const heading of part.children) rows.push({ kind: 'heading', partIndex: part.index, path: part.path, text: heading.text, depth: heading.depth, heading })
  }
  return { chapterLevel, chapters, front, parts, rows }
}

/** The Folio's heading flow read from the disk facts of `folio:outline` (no editor buffer). */
export function folioOutlineFlow(outline: FolioOutline): HeadingFlow<{ level: number; text: string }> {
  return folioHeadingFlow(outline.pieces.map((file) => ({
    path: file.path,
    title: file.title,
    mode: file.heading ?? 'own',
    frontMatter: file.frontMatter === true,
    headings: file.headings.map((heading) => ({ level: heading.level, text: heading.text })),
  })))
}

/** The chip beside a running-order part's role: "continues 2 · Kapitola 2" for a part that nests under chapter 2; null for any other part. */
export function continuesChip<T extends { level: number; text: string }>(flow: HeadingFlow<T>, index: number): string | null {
  const part = flow.parts[index]
  if (!part || part.role !== 'continues' || part.chapterNumber === null || part.chapterIndex === null) return null
  return `continues ${part.chapterNumber} \u00b7 ${flow.parts[part.chapterIndex].title}`
}
