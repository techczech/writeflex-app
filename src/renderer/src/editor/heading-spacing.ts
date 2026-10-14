import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { parseMarkdown } from '../../../shared/markdown/dialect'
import { frontmatterBlock } from '../../../shared/markdown/frontmatter'
import { blockRangesOf } from './focus-modes'
import { HEADING_SIZE_EM } from './theme'

/**
 * Heading spacing, ADR-0041 ("Calm"): a heading gets roughly one blank line of air above it and a
 * hair below — 1.15em above, 0.30em below — in Writing and Reviewing alike. The locked artefact is
 * docs/design/2026-08-28-quality-of-life-0-21/heading-spacing.html.
 *
 * DISPLAY ONLY. Nothing is written into the file: no blank lines are inserted and no text is
 * rewritten. ADR-0039 is explicit that the document on disk stays exactly what the writer typed,
 * and this decision does not weaken it — every value below is CSS padding on a rendered line.
 *
 * Where a block starts is NOT decided here. ADR-0039's one block rule lives in focus-modes.ts
 * ({@link blockRangesOf}) and this module asks it, so the heading's neighbours are the same
 * neighbours read-aloud, Fade and Sentence breakup see.
 *
 * Decoration law (live-preview.ts): anything that affects block layout is a StateField, never a
 * ViewPlugin. Vertical padding changes line heights, so these decorations are doc-wide state.
 */

/** The em values ADR-0041 locks, against the heading's own rendered size (see {@link paddingAbove}). */
export const HEADING_SPACE_ABOVE_EM = 1.15
/** Two headings in a row are one heading stack: the pair gets the full space, the join a reduced one. */
export const HEADING_SPACE_REDUCED_EM = 0.5
/** The hair below. Same element as the space above in the drawing, so the same em: the heading's. */
export const HEADING_SPACE_BELOW_EM = 0.3

/** Why a heading's space above is what it is — the three cases ADR-0041 governs. */
export type HeadingSpaceAbove =
  /** The ordinary case: roughly one blank line of air. */
  | 'full'
  /** Straight after another heading: one heading stack, so only a join. */
  | 'reduced'
  /** At the very top of the document, or after a typed blank line that already gives the air. */
  | 'none'

export type HeadingSpacing = {
  /** Start of the block the heading opens (the line start, per ADR-0039). */
  from: number
  /** End of the heading's syntax (a Setext heading's underline included). */
  to: number
  level: number
  above: HeadingSpaceAbove
}

type HeadingRange = { from: number; to: number; level: number }

/**
 * The headings the app's ONE dialect sees — so `# hash` inside a fenced code block is code, exactly
 * as the outline panel and the exporters read it. ATX and Setext both count.
 */
function headingRangesOf(text: string): HeadingRange[] {
  const headings: HeadingRange[] = []
  parseMarkdown(text).iterate({
    enter(node) {
      const match = node.name.match(/^(?:ATX|Setext)Heading(\d)$/)
      if (!match) return
      headings.push({ from: node.from, to: node.to, level: Number(match[1]) })
      return false
    },
  })
  return headings
}

/**
 * Every heading in `text` with the space that belongs above it. Pure geometry, unit-tested in
 * tests/main/heading-spacing.test.ts.
 *
 * The three states that are not the ordinary case, in the order they are decided:
 * 1. **Top of the document** — no block precedes the heading, so the space is suppressed. A page
 *    that opens with an inch of nothing looks broken rather than airy.
 * 2. **A typed blank line above** — the writer's own empty line already carries more air than
 *    1.15em, so the heading adds nothing and the blank line collapses into its space instead of
 *    stacking. This is the state that keeps old documents from growing craters.
 * 3. **Another heading directly above** — H2 then H3 is one heading stack; the join is reduced and
 *    the full space belongs above the pair.
 *
 * Frontmatter is stage-truth, not writing (ADR-0019), and the buffer shows it as a metadata card
 * rather than as lines. It is therefore invisible here twice over: its closing `---` fence parses as
 * a Setext heading and must never be spaced like one, and the first real heading after it is still
 * the top of the writing, so its space stays suppressed rather than opening a hole under the card.
 */
export function headingSpacingOf(text: string): HeadingSpacing[] {
  const metadataEnd = frontmatterBlock(text)?.end ?? 0
  const headings = headingRangesOf(text).filter((heading) => heading.from >= metadataEnd)
  if (headings.length === 0) return []

  const blocks = blockRangesOf(text)
  // Adjacent blocks are separated by the newline between them, so a heading that overlaps a block's
  // range at all IS that block (a Setext underline overlaps its own trailing block too).
  const blockIsHeading = blocks.map((block) =>
    headings.some((heading) => heading.from <= block.to && heading.to >= block.from),
  )

  return headings.map((heading) => {
    const index = blocks.findIndex((block) => block.from <= heading.from && heading.from <= block.to)
    const block = index >= 0 ? blocks[index]! : { from: heading.from, to: heading.to }
    const before = index > 0 ? blocks[index - 1]! : null
    const previous = before && before.from >= metadataEnd ? before : null
    // A blank line leaves a gap of more than the single newline that separates adjacent blocks.
    const typedBlankLineAbove = previous !== null && block.from - previous.to > 1
    const above: HeadingSpaceAbove = previous === null || typedBlankLineAbove
      ? 'none'
      : blockIsHeading[index - 1]
        ? 'reduced'
        : 'full'
    return { from: block.from, to: Math.max(heading.to, block.to), level: heading.level, above }
  })
}

/**
 * BOTH locked values are the heading's OWN ems. The drawing puts `margin-top: 1.15em` and the hair
 * below on the same element, where an em is that element's font size; a CodeMirror line box carries
 * the prose size instead, so every locked ratio is re-expressed against the same heading scale the
 * theme renders (a 24px H2 gets its share of ITS size, not of the 18.5px body).
 *
 * Scaling one side and not the other is what the live measurement caught: a flat hair below left an
 * H1 with less clear space under it than an H3, because its tighter line-height gives back less
 * half-leading. ADR-0041 has the heading binding downward to the text it names, so the two sides
 * scale together or the biggest heading reads as dropped rather than attached.
 */
function scaled(em: number, level: number): number {
  return em * (HEADING_SIZE_EM[level] ?? 1)
}

/** The padding above a heading, in body ems. Zero takes no decoration on that line at all. */
export function paddingAbove(spacing: Pick<HeadingSpacing, 'level' | 'above'>): number {
  if (spacing.above === 'none') return 0
  return scaled(spacing.above === 'reduced' ? HEADING_SPACE_REDUCED_EM : HEADING_SPACE_ABOVE_EM, spacing.level)
}

/** The hair below a heading, in body ems — the same heading scale as {@link paddingAbove}. */
export function paddingBelow(spacing: Pick<HeadingSpacing, 'level'>): number {
  return scaled(HEADING_SPACE_BELOW_EM, spacing.level)
}

const round = (em: number): string => String(Number(em.toFixed(3)))

type LineSpacing = { classes: string[]; style: string[] }

/** Merge the two decorations a single-line heading wants (space above, hair below) into one. */
function lineSpacings(state: EditorState): Map<number, LineSpacing> {
  const byLine = new Map<number, LineSpacing>()
  const at = (pos: number): LineSpacing => {
    const lineStart = state.doc.lineAt(pos).from
    const existing = byLine.get(lineStart)
    if (existing) return existing
    const created: LineSpacing = { classes: [], style: [] }
    byLine.set(lineStart, created)
    return created
  }

  for (const spacing of headingSpacingOf(state.doc.toString())) {
    const above = paddingAbove(spacing)
    if (above > 0) {
      const head = at(spacing.from)
      head.classes.push(spacing.above === 'reduced' ? 'wf-heading-space wf-heading-space-reduced' : 'wf-heading-space')
      head.style.push(`padding-top:${round(above)}em`)
    }
    // The hair below hangs on the heading's LAST line, so a Setext underline keeps it too.
    const tail = at(Math.min(spacing.to, state.doc.length))
    tail.classes.push('wf-heading-tail')
    tail.style.push(`padding-bottom:${round(paddingBelow(spacing))}em`)
  }
  return byLine
}

/** The line decorations ADR-0041 asks for, over the whole document (never the viewport alone). */
export function headingSpacingDecorations(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const [lineStart, spacing] of [...lineSpacings(state)].sort((a, b) => a[0] - b[0])) {
    builder.add(lineStart, lineStart, Decoration.line({
      class: spacing.classes.join(' '),
      attributes: { style: spacing.style.join(';') },
    }))
  }
  return builder.finish()
}

const headingSpacingField = StateField.define<DecorationSet>({
  create: (state) => headingSpacingDecorations(state),
  update(value, transaction) {
    return transaction.docChanged ? headingSpacingDecorations(transaction.state) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Always on, and identical in Writing and Reviewing (ADR-0041): a heading that moves when the mode
 * changes is worse than a heading with no space at all. Nothing here reads the writer-review mode.
 */
export const headingSpacing: Extension = headingSpacingField
