import { ChangeSet, EditorSelection, EditorState, type ChangeSpec, type StateCommand } from '@codemirror/state'
import {
  deleteCurrentSection,
  getSectionRange,
  lowerSubtreeLevel,
  moveSubtreeDown,
  moveSubtreeUp,
  raiseSubtreeLevel,
} from '@app-patterns/outline'
import { extractOutline, type OutlineHeading } from './outline'

/**
 * Pure outline edits over document text (outline package, tickets 13 and 17). The panel's rows are
 * headings; every edit here takes heading start offsets and returns document changes, so the panel,
 * the editor chords and the tests all share one implementation and one undo step per call.
 *
 * Section ranges, moves and level changes come from `@app-patterns/outline` (getSectionRange and the
 * subtree commands, run against a scratch state). Only the arbitrary-target drop is composed here,
 * from the section range, because Bridle's moves are adjacent swaps.
 */

export type SectionSpan = { from: number; to: number; level: number }

/**
 * The heading's section including everything under it, as WHOLE LINES: from the heading line's start
 * to the start of the next heading at the same or a higher level (or the document end). Trailing blank
 * lines belong to the section, so a moved section carries its own spacing.
 */
export function sectionSpan(doc: string, headingFrom: number): SectionSpan | null {
  const range = getSectionRange(doc, headingFrom)
  if (!range || range.kind !== 'heading') return null
  let to = range.to
  if (to < doc.length && doc[to] === '\n') to += 1
  // Swallow the blank lines that follow, so the span ends at the next heading's line.
  while (to < doc.length) {
    const end = doc.indexOf('\n', to)
    const line = doc.slice(to, end === -1 ? doc.length : end)
    if (line.trim() !== '') break
    to = end === -1 ? doc.length : end + 1
  }
  return { from: range.from, to, level: range.level }
}

/** Keep only the headings that are not inside another listed heading's section. */
export function sectionRoots(doc: string, froms: readonly number[]): number[] {
  const sorted = [...new Set(froms)].sort((a, b) => a - b)
  const roots: number[] = []
  let coveredTo = -1
  for (const from of sorted) {
    if (from < coveredTo) continue
    const span = sectionSpan(doc, from)
    if (!span) continue
    roots.push(from)
    coveredTo = span.to
  }
  return roots
}

export type DropEdit = { changes: ChangeSpec[]; movedFrom: number }

/**
 * Drop a section before another heading (`beforeFrom`) or at the end of the document (null). Returns
 * null when the drop would not change anything: onto its own subtree, or just before the heading that
 * already follows it. The section keeps its levels. Offsets are in the ORIGINAL document, so the
 * changes apply as one transaction.
 */
export function dropSection(doc: string, sourceFrom: number, beforeFrom: number | null): DropEdit | null {
  const span = sectionSpan(doc, sourceFrom)
  if (!span) return null
  const target = beforeFrom ?? doc.length
  if (target >= span.from && target <= span.to) return null
  const endsWithoutNewline = doc.length > 0 && !doc.endsWith('\n')
  let block = doc.slice(span.from, span.to)
  if (target < span.from) {
    // The last section of a document with no final newline: the newline before it goes with it.
    const lastBare = span.to === doc.length && endsWithoutNewline && span.from > 0
    if (lastBare) block += '\n'
    return {
      changes: [{ from: target, insert: block }, { from: lastBare ? span.from - 1 : span.from, to: span.to }],
      movedFrom: target,
    }
  }
  const length = span.to - span.from
  const atBareEnd = target === doc.length && endsWithoutNewline
  if (atBareEnd) {
    block = `\n${block.replace(/\n+$/, '')}`
    return { changes: [{ from: span.from, to: span.to }, { from: target, insert: block }], movedFrom: target - length + 1 }
  }
  return { changes: [{ from: span.from, to: span.to }, { from: target, insert: block }], movedFrom: target - length }
}

/** Row index → document edit: drop `headings[sourceIndex]` before `headings[beforeIndex]` (or the end). */
export function dropHeadingEdit(doc: string, headings: readonly OutlineHeading[], sourceIndex: number, beforeIndex: number | null): DropEdit | null {
  const source = headings[sourceIndex]
  if (!source) return null
  const before = beforeIndex == null || beforeIndex >= headings.length ? null : headings[beforeIndex].from
  return dropSection(doc, source.from, before)
}

type Target = Parameters<StateCommand>[0]

type Scratch = { state: EditorState; changes: ChangeSet | null }

function newScratch(doc: string, head = 0): Scratch {
  return { state: EditorState.create({ doc, selection: EditorSelection.cursor(head) }), changes: null }
}

/** Run a Bridle command with the cursor at `head`; returns that one step's changes (null when nothing changed). */
function runOnScratch(scratch: Scratch, command: StateCommand, head: number): ChangeSet | null {
  scratch.state = scratch.state.update({ selection: EditorSelection.cursor(Math.min(head, scratch.state.doc.length)) }).state
  let step: ChangeSet | null = null
  const target: Target = {
    state: scratch.state,
    dispatch: (tr) => {
      if (!tr.changes.empty) step = step ? step.compose(tr.changes) : tr.changes
      scratch.state = tr.state
    },
  }
  command(target)
  if (step) scratch.changes = scratch.changes ? scratch.changes.compose(step) : step
  return step
}

export type SectionsEdit = { changes: ChangeSet; froms: number[] }

/**
 * Promote (`delta` -1) or demote (+1) whole sections, each with everything under it, `steps` levels.
 * Sections already at the limit are left alone. One composed change set, positions mapped between steps.
 */
export function shiftSections(doc: string, froms: readonly number[], delta: -1 | 1, steps = 1): SectionsEdit | null {
  const roots = sectionRoots(doc, froms)
  if (roots.length === 0) return null
  const scratch = newScratch(doc)
  const positions = [...roots]
  for (let step = 0; step < steps; step += 1) {
    for (let index = 0; index < positions.length; index += 1) {
      const change = runOnScratch(scratch, delta === -1 ? raiseSubtreeLevel : lowerSubtreeLevel, positions[index])
      if (change) for (let j = 0; j < positions.length; j += 1) positions[j] = change.mapPos(positions[j], -1)
    }
  }
  if (!scratch.changes) return null
  return { changes: scratch.changes, froms: positions }
}

/**
 * Move whole sections up or down one place each, together: going up they move in document order, going
 * down in reverse, so neighbours that are selected travel as a block. Returns the new heading offsets.
 */
export function moveSections(doc: string, froms: readonly number[], direction: 'up' | 'down'): SectionsEdit | null {
  const roots = sectionRoots(doc, froms)
  if (roots.length === 0) return null
  const scratch = newScratch(doc)
  const order = direction === 'up' ? roots : [...roots].reverse()
  for (const from of order) runOnScratch(scratch, direction === 'up' ? moveSubtreeUp : moveSubtreeDown, from)
  if (!scratch.changes) return null
  // Follow each section by heading text and occurrence (moves are swaps, so equal headings keep their order).
  const before = extractOutline(doc)
  const after = extractOutline(scratch.state.doc.toString())
  const identity = (list: OutlineHeading[], index: number): string => `${list[index].text}\u0000${list.slice(0, index).filter((h) => h.text === list[index].text).length}`
  const afterByIdentity = new Map(after.map((heading, index) => [identity(after, index), heading.from]))
  const newFroms = roots.map((from) => {
    const index = before.findIndex((heading) => heading.from === from)
    return index === -1 ? from : (afterByIdentity.get(identity(before, index)) ?? from)
  })
  return { changes: scratch.changes, froms: newFroms }
}

/** Delete whole sections (each with everything under it), as one change set. */
export function deleteSections(doc: string, froms: readonly number[]): SectionsEdit | null {
  const roots = sectionRoots(doc, froms)
  if (roots.length === 0) return null
  const scratch = newScratch(doc)
  for (const from of [...roots].reverse()) runOnScratch(scratch, deleteCurrentSection, from)
  if (!scratch.changes) return null
  return { changes: scratch.changes, froms: [] }
}

/**
 * The words a heading's section holds, its heading and everything under it included. One pass over the
 * heading list (a section ends at the next heading of the same or a higher level), so it stays cheap on
 * long documents; the panel recomputes it on every edit.
 */
export function sectionWordCounts(doc: string, headings: readonly OutlineHeading[] = extractOutline(doc)): number[] {
  return headings.map((heading, index) => {
    let end = index + 1
    while (end < headings.length && headings[end].level > heading.level) end += 1
    return countWords(doc.slice(heading.from, end < headings.length ? headings[end].from : doc.length))
  })
}

export function countWords(text: string): number {
  const words = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)
  return words ? words.length : 0
}

/** The words that deleting these sections would remove (nested picks counted once). */
export function wordsInSections(doc: string, froms: readonly number[]): number {
  return sectionRoots(doc, froms).reduce((sum, from) => {
    const span = sectionSpan(doc, from)
    return sum + (span ? countWords(doc.slice(span.from, span.to)) : 0)
  }, 0)
}

/** The deepest heading level present (the Levels list is Level 1 … Level n). */
export function deepestLevel(headings: readonly OutlineHeading[]): number {
  return headings.reduce((deepest, heading) => Math.max(deepest, heading.level), 0)
}

/**
 * Which headings the Levels drop-down shows: every heading down to `limit`, plus the cursor's section
 * and its ancestors, which stay visible whatever the level (null limit = all levels).
 */
export function levelVisibility(headings: readonly OutlineHeading[], limit: number | null, cursorIndex: number): boolean[] {
  const visible = headings.map((heading) => limit === null || heading.level <= limit)
  if (cursorIndex >= 0 && cursorIndex < headings.length) {
    visible[cursorIndex] = true
    let level = headings[cursorIndex].level
    for (let i = cursorIndex - 1; i >= 0 && level > 1; i -= 1) {
      if (headings[i].level < level) {
        visible[i] = true
        level = headings[i].level
      }
    }
  }
  return visible
}

/**
 * For each heading, how many sections beneath it are hidden (the row's "+N"). `shown` says which
 * headings are visible after every filter (levels and collapse together).
 */
export function hiddenBeneath(headings: readonly OutlineHeading[], shown: readonly boolean[]): number[] {
  return headings.map((heading, index) => {
    let hidden = 0
    for (let i = index + 1; i < headings.length && headings[i].level > heading.level; i += 1) {
      if (!shown[i]) hidden += 1
    }
    return hidden
  })
}

/** The section of the heading at or before `position` — index into `headings`, -1 above the first. */
export function headingIndexAt(headings: readonly OutlineHeading[], position: number): number {
  let index = -1
  for (let i = 0; i < headings.length; i += 1) {
    if (headings[i].from <= position) index = i
    else break
  }
  return index
}

/** Insert a new heading line before this section (same level) or as its first subheading. */
export function newHeadingEdit(doc: string, headingFrom: number, mode: 'before' | 'sub'): { changes: ChangeSpec; cursor: number } | null {
  const headings = extractOutline(doc)
  const heading = headings.find((entry) => entry.from === headingFrom)
  if (!heading) return null
  if (mode === 'before') {
    const marks = '#'.repeat(heading.level)
    return { changes: { from: headingFrom, insert: `${marks} \n\n` }, cursor: headingFrom + marks.length + 1 }
  }
  const marks = '#'.repeat(Math.min(heading.level + 1, 6))
  const headingEnd = doc.indexOf('\n', headingFrom)
  const insertAt = headingEnd === -1 ? doc.length : headingEnd + 1
  const lead = headingEnd === -1 ? '\n\n' : ''
  // Directly under the parent heading: first subheading, then a blank line.
  return { changes: { from: insertAt, insert: `${lead}${marks} \n\n` }, cursor: insertAt + lead.length + marks.length + 1 }
}
