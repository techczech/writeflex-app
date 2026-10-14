import { type EditorState, type Extension, type StateCommand, type StateEffect } from '@codemirror/state'
import {
  codeFolding,
  foldEffect,
  foldedRanges,
  foldService,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language'

const HEADING = /^(?:ATX|Setext)Heading(\d)$/

type Section = {
  level: number
  /** Offset where the heading itself starts (used to find the section the cursor sits in). */
  headingFrom: number
  /** Fold start — the end of the heading, so the heading line stays visible when its body folds. */
  from: number
  /** Fold end — up to the heading of the same-or-higher level that closes the section, or doc end. */
  to: number
}

/**
 * Every heading section in the document, in order. A section's foldable body runs from the end of its
 * heading to just before the next heading of the same-or-higher level (or the end of the document).
 * Empty sections (a heading with nothing under it) are dropped — there is nothing to fold. Shared by
 * the fold service (so CM's own fold affordances see heading ranges) and the fold commands.
 */
function headingSections(state: EditorState): Section[] {
  const heads: { level: number; headingFrom: number; from: number }[] = []
  syntaxTree(state).iterate({
    enter(node) {
      const match = node.name.match(HEADING)
      if (!match) return undefined
      heads.push({ level: Number(match[1]), headingFrom: node.from, from: node.to })
      return false
    },
  })
  return heads
    .map((head, i) => {
      let to = state.doc.length
      for (let j = i + 1; j < heads.length; j++) {
        if (heads[j].level <= head.level) {
          to = heads[j].headingFrom - 1
          break
        }
      }
      return { level: head.level, headingFrom: head.headingFrom, from: head.from, to }
    })
    .filter((section) => section.to > section.from)
}

/** foldService entry: if `lineStart` is a heading line, its section range is foldable. This lets CM's
 *  built-in fold affordances (foldable(), a fold gutter) agree with our ⌘8/⌘9 commands. */
function headingSectionOnLine(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): { from: number; to: number } | null {
  const section = headingSections(state).find(
    (candidate) => candidate.headingFrom >= lineStart && candidate.headingFrom <= lineEnd,
  )
  return section ? { from: section.from, to: section.to } : null
}

/** The folding extension for the editor stack (setup.ts): the fold state + our heading fold service. */
export const headingFolding: Extension = [codeFolding(), foldService.of(headingSectionOnLine)]

/** Whether a fold covering exactly `from`..`to` is currently in the fold state. */
function isFolded(state: EditorState, from: number, to: number): boolean {
  let folded = false
  foldedRanges(state).between(from, to, (rangeFrom, rangeTo) => {
    if (rangeFrom === from && rangeTo === to) folded = true
  })
  return folded
}

/**
 * ⌘8 — fold the heading section the cursor sits in; a second ⌘8 on the same section unfolds it.
 * "The section the cursor sits in" is the nearest heading starting at or before the caret, so folding
 * from inside an H3's body collapses that H3, not its enclosing H1.
 */
export const foldCurrentHeading: StateCommand = ({ state, dispatch }) => {
  const pos = state.selection.main.head
  const sections = headingSections(state)
  let target: Section | undefined
  for (const section of sections) {
    if (section.headingFrom <= pos) target = section
    else break
  }
  if (!target) return false
  const range = { from: target.from, to: target.to }
  const effect = isFolded(state, range.from, range.to) ? unfoldEffect.of(range) : foldEffect.of(range)
  dispatch(state.update({ effects: effect }))
  return true
}

/**
 * ⌘9 — fold every top-level (shallowest-level) section; when they are all already folded, unfold the
 * whole document instead (the WM3 fold cycle). Folding the top level hides deeper subsections with it.
 */
export const foldAllHeadings: StateCommand = ({ state, dispatch }) => {
  const sections = headingSections(state)
  if (sections.length === 0) return false
  const minLevel = Math.min(...sections.map((section) => section.level))
  const tops = sections.filter((section) => section.level === minLevel)
  if (tops.every((section) => isFolded(state, section.from, section.to))) {
    return unfoldAll({ state, dispatch })
  }
  const effects = tops
    .filter((section) => !isFolded(state, section.from, section.to))
    .map((section) => foldEffect.of({ from: section.from, to: section.to }))
  if (effects.length === 0) return false
  dispatch(state.update({ effects }))
  return true
}

/** Unfold every folded range in the document (palette-only; the ⌘9 cycle also calls it). */
export const unfoldAll: StateCommand = ({ state, dispatch }) => {
  const effects: StateEffect<{ from: number; to: number }>[] = []
  foldedRanges(state).between(0, state.doc.length, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }))
  })
  if (effects.length === 0) return false
  dispatch(state.update({ effects }))
  return true
}
