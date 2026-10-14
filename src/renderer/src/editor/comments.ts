import { Prec, RangeSetBuilder, type EditorState, type Extension, type StateCommand } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type KeyBinding,
  type ViewUpdate,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { selectedLines } from './outliner'

/** A WriteFlex `// ` line comment: leading whitespace, `//`, then an optional single space. This is
 *  the app's own post-it convention (excluded from the word count), NOT a Markdown/HTML comment —
 *  distinct from CodeMirror's language-aware toggleComment. */
const COMMENT_LINE = /^(\s*)\/\/ ?/

/** True for any line whose text reads as a WriteFlex comment (used by the decorator and word-count).
 *  Text-only — fence context is applied separately via {@link isInsideCodeBlock}. */
export function isCommentLine(text: string): boolean {
  return /^\s*\/\//.test(text)
}

/**
 * True when the LINE holding `pos` is inside a fenced or indented code block, per the Markdown
 * syntax tree. A `//` line there is real code, not a WriteFlex post-it comment — so the decorator
 * must not paint it, and the export must not delete it (shared/markdown/dialect.ts asks its own
 * parser the same question before every copy and export).
 *
 * The question is resolved at the line's FIRST NON-BLANK character, not at its start: an indented
 * block's `CodeBlock` node begins past the four spaces that make it code, so resolving at line.from
 * put the block's opening line outside it — the one line of an example the editor still greyed out
 * as a note while the export kept it. (word-count.ts keeps its pure line scanner and so still drops
 * an indented `// x` from the COUNT; a documented divergence, and no text is lost by it.) Cheap:
 * resolves one node rather than walking the tree.
 */
export function isInsideCodeBlock(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos)
  const ink = line.from + (line.text.length - line.text.trimStart().length)
  // `topNode` is typed as SyntaxNode; reusing it here walks the ancestor chain without importing the
  // SyntaxNode type from the transitive @lezer/common.
  let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(ink, 1)
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true
    node = node.parent
  }
  return false
}

/**
 * ⌥⌘/ — toggle `// ` comments over the selected lines. If every non-blank target line is already
 * commented the whole block is un-commented;
 * otherwise the uncommented lines gain a `// ` prefix (already-commented lines are left as-is).
 */
export const toggleComment: StateCommand = ({ state, dispatch }) => {
  const lines = selectedLines(state)
  const nonBlank = lines.filter((n) => state.doc.line(n).text.trim() !== '')
  const target = nonBlank.length > 0 ? nonBlank : lines
  const allCommented = target.every((n) => COMMENT_LINE.test(state.doc.line(n).text))
  const changes: { from: number; to?: number; insert?: string }[] = []
  for (const n of target) {
    const line = state.doc.line(n)
    if (allCommented) {
      const match = line.text.match(COMMENT_LINE)
      if (match) changes.push({ from: line.from, to: line.from + match[0].length })
    } else if (!COMMENT_LINE.test(line.text)) {
      changes.push({ from: line.from, insert: '// ' })
    }
  }
  if (changes.length === 0) return false
  dispatch(state.update({ changes, userEvent: allCommented ? 'delete' : 'input' }))
  return true
}

/** Typing-adjacent slash binding: high precedence keeps it ahead of browser/editor defaults. */
/** Kept for reference/tests; the LIVE ⌥⌘/ binding comes from the resolver-built editor chord
 *  keymap (commands/chords.ts, Round A T6) so a reassigned chord retires this default with it. */
export const commentKeymap: KeyBinding[] = [{ key: 'Alt-Mod-/', run: toggleComment, preventDefault: true }]

const commentLine = Decoration.line({ class: 'cm-comment-line' })

function commentLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const { state } = view
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos)
      // A `//` line inside a fenced code block is code, not a WriteFlex comment — don't paint it.
      if (isCommentLine(line.text) && !isInsideCodeBlock(state, line.from)) {
        builder.add(line.from, line.from, commentLine)
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * Line-decorates every `//`-prefixed line with `cm-comment-line` so the theme can render it in the
 * mockup's post-it grey (--ink-3, italic). Comments read as marginal notes, not prose.
 */
const commentDecorator = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = commentLineDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState))
        this.decorations = commentLineDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** The comment feature's decoration layer. Its ⌥⌘/ binding moved into the resolver-built editor
 *  chord keymap (T6) — a second static claim here would keep firing after a reassignment. */
export const comments: Extension = commentDecorator
