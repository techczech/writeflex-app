import { clearFlagAtCursor, openFlagMenu } from './flag-actions'
import { EditorSelection, type EditorState, type StateCommand } from '@codemirror/state'
import { copyLineDown } from '@codemirror/commands'
import { selectNextOccurrence } from '@codemirror/search'
import type { KeyBinding } from '@codemirror/view'
import { outlinerKeymap } from './outliner'
import { toggleComment } from './comments'
import { foldCurrentHeading, foldAllHeadings, unfoldAll } from './folding'
import { typewriterCompartment, typewriterExtension } from './typewriter'
import { codeObjectConversion, objectToCode, objectToText, outlineToMindMap } from './block-conversions'
import { livePreviewBlocks, type LivePreviewBlock } from './live-preview'
import { skipWriterReviewTracking } from './writer-review'
import { frontmatterSafeInsertPosition } from '../../../shared/object-markup'
import { clearFormatting, duplicateBlock, turnIntoCodeBlock, turnIntoTable } from './block-actions'
import { makeTaskList } from './block-marks'

const MARK = '=='

/** The inline markers this app toggles: `*` italic, `**` bold, `~~` strikethrough (ADR-0040), `` ` `` inline code. */
type InlineMarker = '*' | '**' | '~~' | '`'

/** True when `marker` starts at `position` AND is not part of a longer run of its own character —
 *  so `**` is never read as one `*` of a bold pair, and `~~~` is not read as a strikethrough pair. */
function markerAt(state: EditorState, position: number, marker: InlineMarker): boolean {
  if (state.sliceDoc(position, position + marker.length) !== marker) return false
  const character = marker[0]
  return state.sliceDoc(position - 1, position) !== character
    && state.sliceDoc(position + marker.length, position + marker.length + 1) !== character
}

function enclosingMarkerSpan(state: EditorState, position: number, marker: InlineMarker): { from: number; to: number } | null {
  const line = state.doc.lineAt(position)
  // Code spans sit side by side in a line: a caret between two of them is outside both, so only an
  // odd number of backticks before the caret means it is inside one.
  if (marker === '`') {
    const before = state.sliceDoc(line.from, position).split('`').length - 1
    if (before % 2 === 0) return null
  }
  for (let from = position - marker.length; from >= line.from; from--) {
    if (!markerAt(state, from, marker)) continue
    for (let to = from + marker.length; to <= line.to - marker.length; to++) {
      if (to >= position && markerAt(state, to, marker)) return { from, to: to + marker.length }
    }
  }
  return null
}

/** Toggle an inline Markdown marker for every selection. Empty selections insert a fresh pair,
 * except when the caret is already inside that marker span, where the same command unwraps it. */
function toggleInlineMarker(marker: InlineMarker, options: { wordAtCaret?: boolean } = {}): StateCommand {
  return ({ state, dispatch }) => {
    const transaction = state.changeByRange((caretRange) => {
      let range = caretRange
      if (range.empty) {
        const enclosed = enclosingMarkerSpan(state, range.head, marker)
        if (enclosed) {
          const caret = range.head - enclosed.from - marker.length
          return {
            changes: [
              { from: enclosed.from, to: enclosed.from + marker.length },
              { from: enclosed.to - marker.length, to: enclosed.to },
            ],
            range: EditorSelection.cursor(enclosed.from + Math.max(0, caret)),
          }
        }
        // Inline code (and any marker that asks for it) wraps the word under a bare caret, as Mark does.
        const word = options.wordAtCaret ? state.wordAt(range.head) : null
        if (!word) {
          return {
            changes: { from: range.head, insert: marker + marker },
            range: EditorSelection.cursor(range.head + marker.length),
          }
        }
        range = EditorSelection.range(word.from, word.to)
      }

      const selected = state.sliceDoc(range.from, range.to)
      const leading = selected.match(/^\s*/)?.[0].length ?? 0
      const trailing = selected.match(/\s*$/)?.[0].length ?? 0
      const from = range.from + leading
      const to = Math.max(from, range.to - trailing)
      const inner = state.sliceDoc(from, to)

      if (inner.length >= marker.length * 2 && markerAt(state, from, marker) && markerAt(state, to - marker.length, marker)) {
        return {
          changes: [
            { from, to: from + marker.length },
            { from: to - marker.length, to },
          ],
          range: EditorSelection.range(from, to - marker.length * 2),
        }
      }
      if (markerAt(state, from - marker.length, marker) && markerAt(state, to, marker)) {
        return {
          changes: [
            { from: from - marker.length, to: from },
            { from: to, to: to + marker.length },
          ],
          range: EditorSelection.range(from - marker.length, to - marker.length),
        }
      }
      if (from === to) {
        return {
          changes: { from, insert: marker + marker },
          range: EditorSelection.cursor(from + marker.length),
        }
      }
      return {
        changes: [{ from, insert: marker }, { from: to, insert: marker }],
        range: EditorSelection.range(from, to + marker.length * 2),
      }
    })
    // Markdown punctuation is command-owned structure. Letting prose review rewrite these inserts
    // remaps the returned range, so the next keystroke no longer receives the formatted span.
    dispatch(state.update(transaction, {
      annotations: skipWriterReviewTracking.of(true),
      userEvent: 'input',
      scrollIntoView: true,
    }))
    return true
  }
}

/** ⌘B / ⌘I — Markdown-native inline emphasis toggles. */
export const toggleBold = toggleInlineMarker('**')
export const toggleItalic = toggleInlineMarker('*')
/**
 * Strikethrough — the drawing's third inline mark (ADR-0040, action-bar-hifi-v1), and deliberately
 * the SAME code path as bold and italic rather than a second one: it sits in the bar's inline-mark
 * group beside them, so it must wrap, unwrap and round-trip by exactly their rules.
 */
export const toggleStrikethrough = toggleInlineMarker('~~')
/** Inline code (`edit.inlineCode`): the same path again, with the word under a bare caret wrapped. */
export const toggleInlineCode = toggleInlineMarker('`', { wordAtCaret: true })

export function isHttpUrl(text: string): boolean {
  if (!text || text !== text.trim() || /\s/.test(text)) return false
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** The synchronous core of ⌥⌘K. Keeping clipboard I/O outside the transaction makes every range
 * land in one CodeMirror history event and gives unit tests the exact same formatting path. */
export function insertMarkdownLinkFromClipboard(clipboardText: string): StateCommand {
  return ({ state, dispatch }) => {
    const useClipboard = isHttpUrl(clipboardText)
    const target = useClipboard ? clipboardText : ''
    const transaction = state.changeByRange((range) => {
      const label = state.sliceDoc(range.from, range.to)
      const insert = `[${label}](${target})`
      const labelFrom = range.from + 1
      const urlFrom = range.from + label.length + 3
      return {
        changes: { from: range.from, to: range.to, insert },
        range: useClipboard || range.empty
          ? EditorSelection.range(labelFrom, labelFrom + label.length)
          : EditorSelection.cursor(urlFrom),
      }
    })
    // Keep the selected label a true replacement. Prose review otherwise retains the old label and
    // appends the link, while also remapping the requested URL/label selection.
    dispatch(state.update(transaction, {
      annotations: skipWriterReviewTracking.of(true),
      userEvent: 'input',
      scrollIntoView: true,
    }))
    return true
  }
}

/** ⌥⌘K — document-editor link insertion. Object-editor shells stop propagation before this keymap. */
export const insertMarkdownLink: StateCommand = (target) => {
  const clipboardText = typeof window !== 'undefined' && typeof window.writeflex?.clipboardText === 'function'
    ? window.writeflex.clipboardText()
    : ''
  return insertMarkdownLinkFromClipboard(clipboardText)(target)
}

function selectedPreviewBlock(state: EditorState): LivePreviewBlock | null {
  const head = state.selection.main.head
  return livePreviewBlocks(state).find((block) => head >= block.from && (head < block.to || (block.to >= state.doc.length && head <= block.to))) ?? null
}

function replaceBlock(command: Parameters<StateCommand>[0], block: LivePreviewBlock, replacement: string): boolean {
  command.dispatch?.(command.state.update({
    changes: { from: block.from, to: block.to, insert: replacement },
    selection: { anchor: block.from },
    annotations: [skipWriterReviewTracking.of(true)],
    userEvent: 'input',
    scrollIntoView: true,
  }))
  return true
}

export const canConvertBlockToText = (state: EditorState): boolean => selectedPreviewBlock(state) !== null
export const canConvertBlockToCode = (state: EditorState): boolean => {
  const block = selectedPreviewBlock(state)
  return !!block && block.kind !== 'code'
}
export const canConvertCodeToObject = (state: EditorState): boolean => {
  const block = selectedPreviewBlock(state)
  return !!block && codeObjectConversion(block) !== null
}
export const canConvertCodeToObjectKind = (state: EditorState, kind: 'mermaid' | 'markmap' | 'table'): boolean => {
  const block = selectedPreviewBlock(state)
  return !!block && codeObjectConversion(block)?.kind === kind
}
export const canConvertOutlineToMindMap = (state: EditorState): boolean => {
  const { from, to } = state.selection.main
  return outlineToMindMap(state.doc.toString(), from, to) !== null
}

export const convertBlockToText: StateCommand = (command) => {
  const block = selectedPreviewBlock(command.state)
  return block ? replaceBlock(command, block, objectToText(block)) : false
}

export const convertBlockToCode: StateCommand = (command) => {
  const block = selectedPreviewBlock(command.state)
  return block && block.kind !== 'code' ? replaceBlock(command, block, objectToCode(block)) : false
}

export const convertCodeToObject: StateCommand = (command) => {
  const block = selectedPreviewBlock(command.state)
  const conversion = block ? codeObjectConversion(block) : null
  return block && conversion ? replaceBlock(command, block, conversion.replacement) : false
}

export const convertOutlineToMindMap: StateCommand = (command) => {
  const { from, to } = command.state.selection.main
  const conversion = outlineToMindMap(command.state.doc.toString(), from, to)
  if (!conversion) return false
  command.dispatch?.(command.state.update({
    changes: { from: conversion.from, to: conversion.to, insert: conversion.replacement },
    selection: { anchor: conversion.from },
    annotations: [skipWriterReviewTracking.of(true)],
    userEvent: 'input',
    scrollIntoView: true,
  }))
  return true
}

/** ⌘A — select the writable body while leaving closed document-leading metadata untouched. */
export const selectBodyExceptMetadata: StateCommand = ({ state, dispatch }) => {
  const from = frontmatterSafeInsertPosition(state.doc.toString(), 0)
  dispatch(state.update({
    selection: EditorSelection.range(from, state.doc.length),
    userEvent: 'select',
    scrollIntoView: true,
  }))
  return true
}

/**
 * ⌘E — wrap or unwrap the selection in `==…==` highlight markers (PRD S10, mockup cheat-sheet
 * "Mark ==text== ⌘E"). Empty selections expand to the word under the caret so a bare cursor marks
 * a whole word. Already-marked text toggles back off, whether the markers sit inside the selection
 * (`==bravo==` selected) or just outside it (`bravo` selected between existing `==`). Per-range via
 * changeByRange so multi-cursor marking maps correctly.
 */
export const toggleMark: StateCommand = ({ state, dispatch }) => {
  let changed = false
  const tr = state.changeByRange((range) => {
    let { from, to } = range
    if (from === to) {
      const word = state.wordAt(from)
      if (word) ({ from, to } = word)
    }
    if (from === to) return { range } // nothing markable under the caret
    const before = state.sliceDoc(Math.max(0, from - MARK.length), from)
    const after = state.sliceDoc(to, Math.min(state.doc.length, to + MARK.length))
    const inner = state.sliceDoc(from, to)
    if (before === MARK && after === MARK) {
      // Markers flank the selection: strip them, keeping the same text selected.
      changed = true
      return {
        changes: [{ from: from - MARK.length, to: from }, { from: to, to: to + MARK.length }],
        range: EditorSelection.range(from - MARK.length, to - MARK.length),
      }
    }
    if (inner.length >= MARK.length * 2 && inner.startsWith(MARK) && inner.endsWith(MARK)) {
      // Selection includes the markers: remove the inner pair.
      changed = true
      return {
        changes: [{ from, to: from + MARK.length }, { from: to - MARK.length, to }],
        range: EditorSelection.range(from, to - MARK.length * 2),
      }
    }
    changed = true
    return {
      changes: [{ from, insert: MARK }, { from: to, insert: MARK }],
      range: EditorSelection.range(from + MARK.length, to + MARK.length),
    }
  })
  if (!changed) return false
  dispatch(state.update(tr, { userEvent: 'input', scrollIntoView: true }))
  return true
}

/** Duplicate the current line(s) below. Thin alias over CM6's copyLineDown so the command carries a
 *  WriteFlex name for the palette registry. Keyless since the Actions here menu: ⇧⌘D is `block.duplicate`. */
export const duplicateLine: StateCommand = copyLineDown

/**
 * ⌘⇧J — join the current line with the following one (or collapse every line of a multi-line
 * selection) into a single line, each break replaced by one space with the next line's leading
 * indent trimmed. Bound to ⌘⇧J, never ⌘J — that key is reserved for the agent (Task 15).
 */
export const joinLines: StateCommand = ({ state, dispatch }) => {
  const { doc } = state
  const changes: { from: number; to: number; insert: string }[] = []
  for (const range of state.selection.ranges) {
    const startLine = doc.lineAt(range.from).number
    let endLine = doc.lineAt(range.to).number
    if (startLine === endLine) endLine = Math.min(startLine + 1, doc.lines) // caret: join with next
    for (let n = startLine; n < endLine; n++) {
      const line = doc.line(n)
      const next = doc.line(n + 1)
      const nextIndent = next.text.match(/^\s*/)?.[0].length ?? 0
      changes.push({ from: line.to, to: next.from + nextIndent, insert: ' ' })
    }
  }
  if (changes.length === 0) return false
  dispatch(state.update({ changes, userEvent: 'delete' }))
  return true
}

/** Build a case-transform command: transform every non-empty selection range, expanding a bare
 *  caret to the word under it. Per-range via changeByRange so multi-cursor edits map cleanly. */
function transformCase(fn: (text: string) => string): StateCommand {
  return ({ state, dispatch }) => {
    let changed = false
    const tr = state.changeByRange((range) => {
      let { from, to } = range
      if (from === to) {
        const word = state.wordAt(from)
        if (word) ({ from, to } = word)
      }
      if (from === to) return { range }
      const text = state.sliceDoc(from, to)
      const next = fn(text)
      if (next === text) return { range: EditorSelection.range(from, to) }
      changed = true
      return { changes: { from, to, insert: next }, range: EditorSelection.range(from, from + next.length) }
    })
    if (!changed) return false
    dispatch(state.update(tr, { userEvent: 'input' }))
    return true
  }
}

/** Palette-only (no keybinding) case transforms — the palette rows arrive in Task 13. */
export const upperCase = transformCase((text) => text.toUpperCase())
export const lowerCase = transformCase((text) => text.toLowerCase())
export const titleCase = transformCase((text) =>
  text.replace(/\p{L}[\p{L}\p{M}']*/gu, (word) => word[0].toUpperCase() + word.slice(1).toLowerCase()),
)

/** True when the typewriter compartment holds its active (non-empty) extension. The compartment is
 *  seeded with `[]` (off) in setup.ts and reconfigured to `typewriterExtension()` (on); reading its
 *  live content is the single source of truth for the mode, so EditorPane's per-switch reapply and
 *  the toggle command below never drift out of sync. */
export function isTypewriterOn(state: EditorState): boolean {
  const configured = typewriterCompartment.get(state)
  return Array.isArray(configured) && configured.length > 0
}

/**
 * ⌘T — toggle typewriter (centred-cursor) mode by reconfiguring the compartment in place. The
 * palette registry drives this StateCommand; App owns the ⌘T keydown + the status flash and drives
 * the same compartment through EditorPane's handle, so both paths flip the one source of truth and
 * the mode survives tab switches (EditorPane.switchTo reapplies it to each swapped-in EditorState).
 */
export const toggleTypewriter: StateCommand = ({ state, dispatch }) => {
  dispatch(
    state.update({
      effects: typewriterCompartment.reconfigure(isTypewriterOn(state) ? [] : typewriterExtension()),
    }),
  )
  return true
}

export { selectNextOccurrence }

/**
 * Structural fallbacks (⇥ outside a list, ⌥↑/⌥↓ line moves), assembled BEFORE defaultKeymap in
 * setup.ts so they win. The chord-command bindings that used to sit beside them
 * (⌘E, ⌘D, ⇧⌘D, ⌥⌘J, ⌘8/⌘9, ⌃⌘]/⌃⌘[, ⌘B/⌘I/⌥⌘K, ⌘A) now come from the resolver-built editor
 * chord keymap (commands/chords.ts, Round A T6): a chord fires exactly once, and an override
 * retires the default in the same act. ⌘J stays unbound here (reserved for the agent, Task 15).
 */
export const structuralEditingKeymap: KeyBinding[] = [...outlinerKeymap]

/** A palette-facing command descriptor. Task 13's command palette consumes `paletteCommands`:
 *  `id` is the stable command id, `label` the row text, `run` the StateCommand, and `keys` the
 *  optional CodeMirror key hint shown on the row (omitted for palette-only commands). */
export type PaletteCommand = {
  id: string
  label: string
  keywords?: string[]
  run: StateCommand
  keys?: string | string[]
}

/** The Turn into targets that are commands of their own (Actions here menu). Registered after the block verbs, so the Guide's sub-groups keep their order. */
export const turnIntoCommands: PaletteCommand[] = [
  { id: 'turn.taskList', label: 'Turn into a task list', keywords: ['checkbox', 'todo', 'checklist', 'task'], run: makeTaskList },
  { id: 'turn.codeBlock', label: 'Turn into a code block', keywords: ['fence', 'code'], run: turnIntoCodeBlock },
  { id: 'turn.table', label: 'Turn into a table', keywords: ['pipe', 'grid', 'rows', 'columns'], run: turnIntoTable },
]

/** Every editing command Task 13's palette should list, keyed and keyless alike. Kept here (not in
 *  the keymap) so palette-only commands (case transforms) and bound commands share one registry. */
export const paletteCommands: PaletteCommand[] = [
  { id: 'edit.flagSelection', label: 'Flag the selection…', keywords: ['citation', 'rewrite', 'fact', 'expand'], run: openFlagMenu, keys: 'Alt-f' },
  { id: 'edit.clearFlag', label: 'Clear flag at cursor', run: clearFlagAtCursor },
  { id: 'edit.selectBodyExceptMetadata', label: 'Select all text (keep metadata)', run: selectBodyExceptMetadata, keys: 'Mod-a' },
  { id: 'edit.bold', label: 'Bold', run: toggleBold, keys: 'Mod-b' },
  { id: 'edit.italic', label: 'Italic', run: toggleItalic, keys: 'Mod-i' },
  { id: 'edit.link', label: 'Link', run: insertMarkdownLink, keys: 'Alt-Mod-k' },
  { id: 'edit.mark', label: 'Mark ==text==', run: toggleMark, keys: 'Mod-e' },
  { id: 'edit.toggleComment', label: 'Toggle Comment', run: toggleComment, keys: 'Alt-Mod-/' },
  { id: 'edit.selectNextOccurrence', label: 'Select Next Occurrence', run: selectNextOccurrence, keys: 'Mod-d' },
  { id: 'edit.duplicateLine', label: 'Duplicate Line', run: duplicateLine },
  { id: 'block.duplicate', label: 'Duplicate block', keywords: ['copy', 'clone', 'repeat'], run: duplicateBlock, keys: 'Shift-Mod-d' },
  { id: 'edit.inlineCode', label: 'Inline code', keywords: ['code', 'monospace', 'backtick'], run: toggleInlineCode },
  { id: 'edit.clearFormatting', label: 'Clear formatting', keywords: ['plain', 'remove formatting', 'strip marks'], run: clearFormatting },
  { id: 'edit.joinLines', label: 'Join Lines', run: joinLines, keys: 'Alt-Mod-j' },
  { id: 'fold.current', label: 'Fold Current Heading', run: foldCurrentHeading, keys: ['⌘8', '⌃⇧['] },
  { id: 'fold.all', label: 'Fold All Headings', run: foldAllHeadings, keys: ['⌘9', '⌃⇧]'] },
  { id: 'fold.none', label: 'Unfold All', run: unfoldAll, keys: '⌃⌘0' },
  // Typewriter (PRD S12): the actual ⌘T shortcut is owned by App's keydown handler (menu.ts shows
  // it registerAccelerator:false, the Toggle Outline precedent); this row is the palette path.
  { id: 'view.typewriter', label: 'Toggle Typewriter Mode', run: toggleTypewriter, keys: 'Mod-t' },
  { id: 'text.upperCase', label: 'Transform to UPPERCASE', run: upperCase },
  { id: 'text.lowerCase', label: 'Transform to lowercase', run: lowerCase },
  { id: 'text.titleCase', label: 'Transform to Title Case', run: titleCase },
]
