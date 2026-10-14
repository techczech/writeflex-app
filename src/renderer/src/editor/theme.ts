import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { BLOCK_INDENT_STEP_PX } from './list-typography'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * Custom highlight tags for WriteFlex's own Markdown extensions — the `==mark==` highlighter and the
 * `[^1]` / `^[…]` footnotes. They are DEFINED with the dialect (shared/markdown/dialect.ts), because
 * the tags are part of its node definitions and the dialect must stand alone in the main process;
 * re-exported here so the theme remains the one place the visual vocabulary is named and styled.
 */
import { highlightMarkTag, footnoteTag } from '../../../shared/markdown/dialect'
export { highlightMarkTag, footnoteTag }

/**
 * The locked v4 mockup's essay rendering (ADR-0009: docs/design/writeflex-main-window/mockup/
 * writeflex-mockup-v4.html, `.doc` + `.editor-scroll`), expressed as the CodeMirror theme so the
 * buffer IS the designed page. Sources, rule by rule:
 *   .editor-scroll  padding 56px 72px 30vh            → .cm-content padding
 *   .doc            max-width 660px                   → .cm-content measure, centred (border-box:
 *                                                       660px + 2×72px side padding)
 *   .doc p          Source Serif 4 18.5px/1.68 #26262a → .cm-content type
 *   .caret          2px, var(--accent)                → .cm-cursor
 * Heading sizes are the mockup's h1/h2 RATIOS against the 18.5px body (41/18.5 and 24/18.5) so a
 * future base-size setting (Task 17 typography) scales the whole hierarchy together.
 *
 * Deviations from the mockup, deliberate:
 * - Block margins (.doc p/h1/h2 margin-*) are NOT re-created: in a source buffer the blank line
 *   between blocks ~matches them (18.5px × 1.68 ≈ 31px); adding decoration padding on top would
 *   double-space the page. Headings are the one exception, decided later and separately by ADR-0041
 *   and owned by editor/heading-spacing.ts — which is why a typed blank line above a heading adds
 *   nothing there rather than stacking.
 * - .editor-scroll's scroll-behavior:smooth is dropped: CM6 corrects scrollTop programmatically
 *   during its measure pass, and CSS-smooth would animate those internal corrections.
 */
const editorChrome = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-content': {
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif',
    // The locked literals (18.5px / #26262a / 660px) moved into tokens.css as defaults (Task 17)
    // so the Editor settings (prose size, line width) and the dark theme can restate them; the
    // untouched values are byte-equal to the mockup's.
    fontSize: 'var(--prose-size, 18.5px)',
    lineHeight: '1.68',
    color: 'var(--prose-ink, #26262a)',
    // measure + the mockup's 72px side padding (border-box), centred in the pane.
    maxWidth: 'calc(var(--prose-measure, 660px) + 2 * 72px)',
    margin: '0 auto',
    padding: '56px 72px 30vh',
    caretColor: 'var(--accent)',
  },
  '.cm-line': { padding: '0' },
  // The mockup's .caret: 2px hairline in the accent colour (drawSelection draws this layer).
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground': { backgroundColor: 'var(--line-soft)' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent-soft)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--line-soft)' },
  '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(46,107,230,.25)' }, // stronger --accent tint
  // Blockquote hairline per .doc blockquote (border 3px var(--line), 18px gutter, --ink-2 text);
  // applied per line by quoteLineHighlight below.
  '.cm-line.wf-quote-line': {
    borderLeft: '3px solid var(--line)',
    paddingLeft: `${BLOCK_INDENT_STEP_PX}px`, // the ONE block indent step; lists use the same (list-typography.ts)
    color: 'var(--ink-2)',
  },
  // `<kbd>…</kbd>` key cap (view-mode.ts), as the locked lesson drawing draws it (.cm code): a filled
  // --pill chip in --mono, no border, radius 4, padding 1px 4px, never below 12px.
  // The highlighter's italic (tags.quote) lands on a span INSIDE the cap, so the cap's own
  // font-style never reaches the glyphs: the rule must cover every descendant.
  '.wf-kbd, .wf-kbd *': { fontStyle: 'normal' },
  '.wf-kbd': {
    fontFamily: 'var(--mono)',
    fontSize: 'max(12px, 0.78em)',
    fontStyle: 'normal',
    fontWeight: '400',
    color: 'var(--ink)',
    backgroundColor: 'var(--pill)',
    borderRadius: '4px',
    padding: '1px 4px',
    whiteSpace: 'nowrap',
  },
  // `// ` comment lines read as the mockup's post-it marginalia: grey (--ink-3), italic. Applied
  // per line by the ViewPlugin in editor/comments.ts (token styling can't reach the whole line).
  '.cm-line.cm-comment-line': { color: 'var(--ink-3)', fontStyle: 'italic' },
  // CM panels (in-buffer search) pick up the app chrome, not the browser default.
  '.cm-panels': {
    backgroundColor: 'var(--bg-toolbar)',
    color: 'var(--ink)',
    fontFamily: 'var(--ui)',
    fontSize: '12.5px',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
  // Folded-section placeholder (⌘8/⌘9): a quiet pill in the UI face, not CM's default underline.
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--pill)',
    color: 'var(--ink-3)',
    border: 'none',
    borderRadius: '5px',
    margin: '0 6px',
    padding: '0 7px',
    fontFamily: 'var(--ui)',
    fontSize: '13px',
  },
})

/**
 * Styled-as-you-type Markdown. Heading em sizes are the mockup ratios (see module comment);
 * strong/em match .doc's 700/italic; markers (#, -, >, ** fences) recede to --ink-3 so the page
 * reads as prose while staying source-faithful.
 */
/**
 * Each heading level's rendered size, as a multiple of the prose size. Sources: .doc h1 is
 * 41px/18.5px and .doc h2 24px/18.5px in the locked mockup; h3+ have no sample, so they step the h2
 * scale down (h4–h6 stay at prose size and carry weight alone). Exported because ADR-0041's heading
 * spacing is measured against the heading's OWN size — editor/heading-spacing.ts must scale with
 * whatever this table says, so the two can never drift.
 */
export const HEADING_SIZE_EM: Record<number, number> = { 1: 2.216, 2: 1.297, 3: 1.15, 4: 1, 5: 1, 6: 1 }

const proseHighlight = HighlightStyle.define([
  // .doc h1: 41px/18.5px = 2.216em, 700, -0.5px, 1.12
  { tag: tags.heading1, fontSize: `${HEADING_SIZE_EM[1]}em`, fontWeight: '700', letterSpacing: '-0.5px', lineHeight: '1.12' },
  // .doc h2: 24px/18.5px = 1.297em, 700, -0.2px (mockup line-height is the browser default ≈1.25)
  { tag: tags.heading2, fontSize: `${HEADING_SIZE_EM[2]}em`, fontWeight: '700', letterSpacing: '-0.2px', lineHeight: '1.25' },
  // h3+ have no .doc sample; step the h2 scale down and keep the 700 weight family.
  { tag: tags.heading3, fontSize: `${HEADING_SIZE_EM[3]}em`, fontWeight: '700', lineHeight: '1.3' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' }, // .doc p strong / .doc li strong
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.url, color: 'var(--ink-3)' },
  // Inline code: the mockup's code chip pattern (.scrap code — var(--mono) on var(--pill)) at prose scale.
  {
    tag: tags.monospace,
    fontFamily: 'var(--mono)',
    fontSize: '0.78em',
    fontStyle: 'normal', // upright inside an italic quotation, as the lesson drawing keeps it
    backgroundColor: 'var(--pill)',
    borderRadius: '4px',
    padding: '1px 4px',
  },
  { tag: tags.quote, color: 'var(--ink-2)', fontStyle: 'italic' }, // .doc blockquote p
  // ==mark== highlighter: a soft amber wash (the --amber favourites token at low alpha), distinct
  // from the blue accent of links and the grey of comments. The `==` markers recede as usual.
  { tag: highlightMarkTag, backgroundColor: 'rgba(185,125,16,.18)', borderRadius: '2px' },
  // Footnotes ([^1] refs and ^[…] inline notes): accent-coloured and slightly smaller so they read
  // as secondary reference marks, distinct from body prose. Ship 1 is highlighting only (no popover).
  { tag: footnoteTag, color: 'var(--accent)', fontSize: '0.85em' },
  { tag: tags.processingInstruction, color: 'var(--ink-3)' }, // #, -, >, ** … markers recede
  { tag: tags.meta, color: 'var(--ink-3)' },
  { tag: tags.contentSeparator, color: 'var(--ink-3)' },
])

const quoteLine = Decoration.line({ class: 'wf-quote-line' })

function quoteLineDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const seen = new Set<number>()
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== 'Blockquote') return
        const first = view.state.doc.lineAt(node.from).number
        const last = view.state.doc.lineAt(node.to).number
        for (let lineNo = first; lineNo <= last; lineNo++) {
          if (seen.has(lineNo)) continue // nested quotes revisit lines; the builder needs sorted adds
          seen.add(lineNo)
          const line = view.state.doc.line(lineNo)
          builder.add(line.from, line.from, quoteLine)
        }
      },
    })
  }
  return builder.finish()
}

/**
 * Marks every line inside a Blockquote so the theme can draw the mockup's hairline + gutter across
 * the whole block — token-level styling (tags.quote) can only colour text spans, never the line.
 */
const quoteLineHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = quoteLineDecorations(view)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState))
        this.decorations = quoteLineDecorations(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/** The complete locked-typography stack: chrome theme, prose highlighting, quote-line hairlines. */
export const writeflexTheme: Extension[] = [editorChrome, syntaxHighlighting(proseHighlight), quoteLineHighlight]
