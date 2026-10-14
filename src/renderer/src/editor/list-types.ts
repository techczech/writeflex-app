import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorSelection, Prec, type ChangeSpec, type EditorState, type Extension, type StateCommand } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { labelFor, ordinalOf, type ListNumbering } from '../../../shared/markdown/fancy-lists'
import {
  itemLineAt,
  listRunAt,
  numberingOfRun,
  prefixOf,
  readListLine,
  relist,
  renumberRun,
  spacingAfter,
  startOfRun,
  type ListLine,
  type ListType,
  type Lines,
} from './list-lines'
import { skipWriterReviewTracking } from './writer-review'

/**
 * Lettered and roman lists in the editor, and changing a list's type
 * (docs/design/2026-09-27-checkbox-lists/mockup/hifi-direction-1.html, frames 5–6).
 *
 * The parser (FancyLists in shared/markdown/dialect.ts) makes `a.`, `A.`, `i.`, `I.` lines list items, so
 * their markers are muted and hang like every other list with no code here. This module adds the
 * three things a writer DOES with them:
 *
 *  - **Return** continues a lettered or roman item with the next letter or numeral (a→b, z→aa,
 *    ii→iii, xxxix→xl), carrying a box on as `[ ]`; an empty item ends the list the way numbered
 *    items do. Continuation only ever happens on Return — typing `I. ` rewrites nothing.
 *  - **Tab / Shift-Tab** nest a lettered or roman item as the outline commands nest numbered ones:
 *    two columns, children with it, both lists renumbered.
 *  - **List type** commands rewrite the markers of the list the cursor is in, as one undo step.
 *
 * Numbered and bullet lists keep lang-markdown's and Bridle's own behaviour: every command here
 * declines (returns false) off a lettered or roman item, except List type, which works on any list.
 */

function documentLines(state: EditorState): Lines {
  return { count: state.doc.lines, text: (index) => state.doc.line(index + 1).text }
}

/** The syntax node at a line's marker, when it is a real list marker (not text in code). */
function listMarkNode(state: EditorState, lineNumber: number, parse: boolean) {
  const line = state.doc.line(lineNumber)
  const read = readListLine(line.text)
  if (!read) return null
  const tree = (parse ? ensureSyntaxTree(state, line.to, 50) : null) ?? syntaxTree(state)
  const node = tree.resolveInner(line.from + read.indent.length, 1)
  return node.name === 'ListMark' ? node : null
}

/** Is line `lineNumber` (1-based) an item of a lettered or roman list? */
export function isLetteredItem(state: EditorState, lineNumber: number, parse = true): boolean {
  return listMarkNode(state, lineNumber, parse)?.parent?.parent?.name === 'FancyList'
}

/** Is line `lineNumber` (1-based) a real list item of any kind? */
function isListItem(state: EditorState, lineNumber: number): boolean {
  return listMarkNode(state, lineNumber, true) !== null
}

/**
 * The ordinal of the item on line `index` in its run's numbering: its own label read in the list's
 * numbering (an `i.` in a list that opened on `a.` is the ninth letter), or its place in the run when
 * the label does not fit.
 */
function ordinalAt(lines: Lines, index: number, line: ListLine): { numbering: ListNumbering; ordinal: number } {
  const run = listRunAt(lines, index)
  const numbering = (run && numberingOfRun(lines, run)) ?? 'decimal'
  const own = line.label === null ? null : ordinalOf(line.label, numbering)
  const ordinal = own ?? (run ? startOfRun(lines, run, numbering) + run.members.indexOf(index) : 1)
  return { numbering, ordinal }
}

/** The marker for the item after `line` in its run: next label, or the same bullet. */
function followingMarker(lines: Lines, index: number, line: ListLine): { marker: string; spacing: string } {
  if (line.kind === 'bullet' || line.label === null || line.delimiter === null) return { marker: line.marker, spacing: line.spacing || ' ' }
  const { numbering, ordinal } = ordinalAt(lines, index, line)
  const label = labelFor(ordinal + 1, numbering)
  return { marker: `${label}${line.delimiter}`, spacing: spacingAfter(label, line.delimiter, line.spacing || ' ') }
}

/** The item a nested item hangs from: the nearest item line above it at a shallower indent. */
function parentItem(lines: Lines, index: number, level: number): number | null {
  for (let at = index - 1; at >= 0; at -= 1) {
    const text = lines.text(at)
    if (text.trim() === '') return null
    const item = readListLine(text)
    if (item && item.indentColumns < level) return at
  }
  return null
}

/**
 * Return on a lettered or roman item. Declines anywhere else, and with the caret before the item's
 * words, so numbered and bullet lists keep lang-markdown's continuation.
 */
export const continueLetteredList: StateCommand = ({ state, dispatch }) => {
  const { main } = state.selection
  if (state.readOnly || state.selection.ranges.length !== 1 || !main.empty) return false
  const line = state.doc.lineAt(main.head)
  if (!isLetteredItem(state, line.number)) return false
  const read = readListLine(line.text)!
  const contentFrom = line.from + prefixOf(read).length
  if (main.head < contentFrom) return false
  const lines = documentLines(state)
  const index = line.number - 1
  const run = listRunAt(lines, index)

  if (read.body.trim() === '') {
    const first = run ? run.members[0] === index : true
    const blankAbove = index > 0 && lines.text(index - 1).trim() === ''
    if (!first && !blankAbove) {
      // A tight list's empty item: loosen the list first, exactly as numbered items do.
      dispatch(state.update({
        changes: { from: line.from, insert: state.lineBreak },
        selection: { anchor: main.head + state.lineBreak.length },
        userEvent: 'input',
        scrollIntoView: true,
      }))
      return true
    }
    // End this level: the line becomes the parent list's next item, or plain text at the margin.
    const parent = parentItem(lines, index, read.indentColumns)
    const parentLine = parent === null ? null : readListLine(lines.text(parent))
    let insert = ''
    if (parent !== null && parentLine) {
      const next = followingMarker(lines, parent, parentLine)
      insert = parentLine.indent + next.marker + next.spacing + (parentLine.box ? '[ ] ' : '')
    }
    dispatch(state.update({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
      userEvent: 'input',
      scrollIntoView: true,
    }))
    return true
  }

  // Split the item at the caret; the words after it move to the new item.
  let from = main.head
  while (from > contentFrom && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from -= 1
  const next = followingMarker(lines, index, read)
  const prefix = read.indent + next.marker + next.spacing + (read.box ? '[ ] ' : '')
  const changes: ChangeSpec[] = [{ from, to: main.head, insert: state.lineBreak + prefix }]
  // The items after it move up one letter, so the list still reads a, b, c.
  if (run && read.label !== null) {
    const { numbering, ordinal } = ordinalAt(lines, index, read)
    const after = run.members.filter((member) => member > index)
    const texts = after.map((member) => lines.text(member))
    renumberRun(texts, after.map((_, i) => i), numbering, ordinal + 2)
    after.forEach((member, i) => {
      const old = lines.text(member)
      if (old === texts[i]) return
      const target = state.doc.line(member + 1)
      const oldPrefix = prefixOf(readListLine(old)!)
      const newPrefix = prefixOf(readListLine(texts[i])!)
      changes.push({ from: target.from, to: target.from + oldPrefix.length, insert: newPrefix })
    })
  }
  dispatch(state.update({
    changes,
    selection: { anchor: from + state.lineBreak.length + prefix.length },
    userEvent: 'input',
    scrollIntoView: true,
  }))
  return true
}

/** The lines a root item carries with it when it moves: itself, then deeper lines until a blank. */
function subtreeOf(lines: Lines, index: number, level: number): number[] {
  const covered = [index]
  for (let at = index + 1; at < lines.count; at += 1) {
    const text = lines.text(at)
    if (text.trim() === '' || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(text)) break
    const item = readListLine(text)
    const indent = item ? item.indentColumns : /^[ \t]*/.exec(text)![0].replace(/\t/g, '    ').length
    if (indent <= level) break
    covered.push(at)
  }
  return covered
}

/** Renumber the ordered run holding line `index` of `texts`; `restart` counts it from 1. */
function renumberRunIn(texts: string[], index: number, restart: boolean): void {
  const lines: Lines = { count: texts.length, text: (at) => texts[at] ?? '' }
  const run = listRunAt(lines, index)
  if (!run) return
  const numbering: ListNumbering | null = numberingOfRun(lines, run)
  if (!numbering) return
  renumberRun(texts, run.members, numbering, restart ? 1 : startOfRun(lines, run, numbering))
}

/**
 * Tab / Shift-Tab on lettered or roman items: each selected item moves two columns with its
 * children, the list it left is renumbered, and the list it joined is renumbered — from 1 when the
 * item heads it, otherwise on from the item above. The same rule Bridle's outline commands give
 * numbered items. Declines when the selection holds no lettered or roman item.
 */
export function changeLetteredListLevel(delta: 1 | -1): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const lines = documentLines(state)
    const selected = new Set<number>()
    for (const range of state.selection.ranges) {
      const first = state.doc.lineAt(range.from).number
      const last = state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1)).number
      for (let number = first; number <= last; number += 1) if (isLetteredItem(state, number)) selected.add(number - 1)
    }
    if (selected.size === 0) return false
    const texts = Array.from({ length: lines.count }, (_, at) => lines.text(at))
    const roots: Array<{ index: number; covered: number[]; siblingsBefore: number[]; siblingsAfter: number[] }> = []
    for (const index of [...selected].sort((a, b) => a - b)) {
      if (roots.some((root) => root.covered.includes(index))) continue
      const item = readListLine(texts[index])!
      if (delta < 0 && !/^( {2}|\t)/.test(texts[index])) continue
      const run = listRunAt(lines, index)
      roots.push({
        index,
        covered: subtreeOf(lines, index, item.indentColumns),
        siblingsBefore: run ? run.members.filter((member) => member < index) : [],
        siblingsAfter: run ? run.members.filter((member) => member > index) : [],
      })
    }
    if (roots.length === 0) return false
    const moved = new Set(roots.flatMap((root) => root.covered))
    for (const at of moved) texts[at] = delta > 0 ? `  ${texts[at]}` : texts[at].replace(/^( {2}|\t)/, '')
    for (const root of roots) {
      const departed = [...root.siblingsBefore, ...root.siblingsAfter].find((member) => !moved.has(member))
      if (departed !== undefined) renumberRunIn(texts, departed, false)
      const joined = listRunAt({ count: texts.length, text: (at) => texts[at] ?? '' }, root.index)
      const headsIt = joined ? joined.members[0] === root.index : true
      renumberRunIn(texts, root.index, headsIt)
    }
    const changes: ChangeSpec[] = []
    texts.forEach((text, at) => {
      const old = lines.text(at)
      if (text === old) return
      let start = 0
      while (start < old.length && start < text.length && old[start] === text[start]) start += 1
      let endOld = old.length
      let endNew = text.length
      while (endOld > start && endNew > start && old[endOld - 1] === text[endNew - 1]) { endOld -= 1; endNew -= 1 }
      const line = state.doc.line(at + 1)
      changes.push({ from: line.from + start, to: line.from + endOld, insert: text.slice(start, endNew) })
    })
    if (changes.length === 0) return false
    dispatch(state.update({ changes, userEvent: 'change.level', scrollIntoView: true }))
    return true
  }
}

export const indentLetteredListItem = changeLetteredListLevel(1)
export const outdentLetteredListItem = changeLetteredListLevel(-1)

/**
 * A List type command (palette "List type: a. b. c." … "List type: checkboxes", and the action bar's
 * list menu): rewrites the markers of the list the cursor is in — only that list, only its markers —
 * and keeps every `[x]`. One transaction, so one undo step. Declines off a list, and when the list
 * is already that type.
 */
export function setListType(target: ListType): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const lines = documentLines(state)
    const item = itemLineAt(lines, state.doc.lineAt(state.selection.main.head).number - 1)
    if (item === null || !isListItem(state, item + 1)) return false
    const run = listRunAt(lines, item)
    if (!run) return false
    const before = Array.from({ length: run.to - run.from + 1 }, (_, offset) => lines.text(run.from + offset))
    const after = relist(before, target)
    const changes: ChangeSpec[] = []
    before.forEach((old, offset) => {
      if (after[offset] === old) return
      const line = state.doc.line(run.from + offset + 1)
      const oldPrefix = prefixOf(readListLine(old)!)
      const newPrefix = prefixOf(readListLine(after[offset])!)
      changes.push({ from: line.from, to: line.from + oldPrefix.length, insert: newPrefix })
    })
    if (changes.length === 0) return false
    const changeSet = state.changes(changes)
    dispatch(state.update({
      changes: changeSet,
      // A caret inside a rewritten marker lands after it, in the words (block-marks.ts's rule).
      selection: EditorSelection.create(
        state.selection.ranges.map((range) => EditorSelection.range(changeSet.mapPos(range.anchor, 1), changeSet.mapPos(range.head, 1))),
        state.selection.mainIndex,
      ),
      // List markers are command-owned punctuation, like the block marks (block-marks.ts).
      annotations: skipWriterReviewTracking.of(true),
      userEvent: 'input',
      scrollIntoView: true,
    }))
    return true
  }
}

/** Return on a lettered or roman item, ahead of the checkbox and lang-markdown continuations. */
export const letteredLists: Extension = Prec.high(keymap.of([{ key: 'Enter', run: continueLetteredList }]))
