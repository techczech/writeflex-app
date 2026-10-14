import { Compartment, EditorState, Facet, RangeSetBuilder, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { findHighlightField, setFindMatches, type FindMatch } from './find-highlight'
import { readAloudRanges } from './read-aloud'
import { anchoredLayer } from './anchored-reading'
import { segmentSentences, type SentenceRange } from './sentences'
import { blockRangesOf, type ParagraphRange } from '../../../shared/markdown/line-blocks'

/**
 * The five Round A focus modes (ADR-0028, all display-only — the document text NEVER changes):
 * Fade other paragraphs · Highlight sentence · Segment focus · Sentence breakup · Anchored Reading.
 * Everything lives in one compartment (the typewriter pattern): `setFocusMode` reconfigures it in
 * place, EditorPane.switchTo reapplies the live choice to every swapped-in EditorState.
 *
 * Decoration law (live-preview.ts:261-264): line/mark decorations may come from ViewPlugins (fade,
 * sentence, segment — viewport-bounded); anything that affects block layout (breakup's line-break
 * widgets) is a StateField, never a ViewPlugin. Anchored's marks are mark-only, so it is a ViewPlugin
 * (anchored-reading.ts) that maps its marks through edits and decorates just the visible window.
 */

export type FocusMode = '' | 'fade' | 'sentence' | 'segment' | 'breakup' | 'anchored'
export type LeadStyle = 'bold' | 'colour' | 'contrast'

/** The Focus Chip's short names (`Focus: Fade`); picker rows use the registry's full labels. */
export const FOCUS_CHIP_NAMES: Record<Exclude<FocusMode, ''>, string> = {
  fade: 'Fade',
  sentence: 'Sentence',
  segment: 'Segment',
  breakup: 'Breakup',
  anchored: 'Anchored',
}

export const LEAD_STYLE_NAMES: Record<LeadStyle, string> = { bold: 'Bold', colour: 'Colour', contrast: 'Contrast' }

/** Persisted-value guards: settings arrive as unknown; anything unexpected reads as the default. */
export function normaliseFocusMode(value: unknown): FocusMode {
  return value === 'fade' || value === 'sentence' || value === 'segment' || value === 'breakup' || value === 'anchored' ? value : ''
}
export function normaliseLeadStyle(value: unknown): LeadStyle {
  return value === 'bold' || value === 'colour' || value === 'contrast' ? value : 'contrast'
}

/** ADR-0029: while the voice speaks it OWNS segmentation. Segment-marking modes yield for the
 *  duration and are restored on stop; anchored (within-segment typography) and fade (attenuation,
 *  re-anchored to the spoken paragraph by the caller) both combine. */
const SUPPRESSED_WHILE_SPEAKING = new Set<FocusMode>(['sentence', 'segment', 'breakup'])
export function effectiveFocusMode(declared: FocusMode, speaking: boolean): FocusMode {
  return speaking && SUPPRESSED_WHILE_SPEAKING.has(declared) ? '' : declared
}

// ---------------------------------------------------------------------------
// Pure geometry (unit-tested in tests/main/focus-modes.test.ts)
// ---------------------------------------------------------------------------

// ADR-0039's block rule is shared with the main process; one rule, one place (src/shared/markdown/line-blocks.ts).
export { blockRangesOf, type ParagraphRange } from '../../../shared/markdown/line-blocks'

/** The typed-line block containing `pos` in `text`, or null on a blank line. */
export function paragraphAt(text: string, pos: number): ParagraphRange | null {
  return blockRangesOf(text).find((block) => pos >= block.from && pos <= block.to) ?? null
}

/**
 * The caret's sentence: the one containing `pos`, else the nearest PRECEDING one (the writer just
 * ended it — the natural focus while typing the gap), else the first (caret before any sentence).
 */
export function caretSentence(sentences: SentenceRange[], pos: number): SentenceRange | null {
  if (sentences.length === 0) return null
  let previous: SentenceRange | null = null
  for (const sentence of sentences) {
    if (pos >= sentence.from && pos <= sentence.to) return sentence
    if (sentence.to < pos) previous = sentence
  }
  return previous ?? sentences[0]
}

export type NumberedSentence = SentenceRange & { n: number }
export type BreakupSpec = { sentences: NumberedSentence[]; breaks: number[] }

/**
 * Sentence breakup geometry for the WHOLE text: sentences numbered continuously across paragraphs
 * (the mockup's countable beats), and the positions where a visual line-break widget goes — before
 * every sentence that is not the first of its paragraph (paragraph starts already begin a line).
 */
export function breakupSpec(text: string): BreakupSpec {
  const sentences: NumberedSentence[] = []
  const breaks: number[] = []
  let n = 0
  for (const paragraph of paragraphsOf(text)) {
    const inParagraph = segmentSentences(text.slice(paragraph.from, paragraph.to), paragraph.from)
    inParagraph.forEach((sentence, index) => {
      sentences.push({ ...sentence, n: ++n })
      if (index > 0) breaks.push(sentence.from)
    })
  }
  return { sentences, breaks }
}

function paragraphsOf(text: string): ParagraphRange[] {
  return blockRangesOf(text)
}

// ---------------------------------------------------------------------------
// Doc-based geometry (the same block scan adapted to CodeMirror's immutable Text)
// ---------------------------------------------------------------------------

/** The block around `pos` in a CM document, using the same text seam as read-aloud and breakup. */
function paragraphAround(doc: Text, pos: number): ParagraphRange | null {
  return paragraphAt(doc.toString(), pos)
}

/** Call `f` for every paragraph intersecting [from, to], each EXTENDED to its full extent. */
function forEachParagraphBetween(doc: Text, from: number, to: number, f: (paragraph: ParagraphRange) => void): void {
  for (const paragraph of blockRangesOf(doc.toString())) {
    if (paragraph.to < from) continue
    if (paragraph.from > to) break
    f(paragraph)
  }
}

// ---------------------------------------------------------------------------
// The decoration layers
// ---------------------------------------------------------------------------

/**
 * Find beats focus (PRD §1 states table): a range holding a search hit is never dimmed. The
 * exemption must happen HERE, at decoration-build time — `.wf-focus-dim-hard` dims via `opacity`,
 * which no descendant CSS rule (including the match's own highlight) can undo.
 */
export function overlapsFindMatch(matches: readonly FindMatch[], from: number, to: number): boolean {
  for (const match of matches) if (match.from < to && match.to > from) return true
  return false
}

/** Every live find-match range on `state` ([] when Find is closed or the field is absent). */
function findMatchesOf(state: EditorState): FindMatch[] {
  const highlights = state.field(findHighlightField, false)
  if (!highlights || highlights.size === 0) return []
  const matches: FindMatch[] = []
  highlights.between(0, state.doc.length, (from, to) => {
    matches.push({ from, to })
  })
  return matches
}

const dimLine = Decoration.line({ class: 'wf-focus-dim' })
const sentenceMark = Decoration.mark({ class: 'wf-focus-sent' })
const dimHardMark = Decoration.mark({ class: 'wf-focus-dim-hard' })

/** Fade other paragraphs: line-dim everything outside the caret's paragraph (viewport-bounded). */
function fadeDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const head = state.selection.main.head
  // ADR-0029: while read-aloud owns the active segment, attenuation follows its paragraph.
  const paragraph = readAloudRanges(state).paragraph ?? paragraphAround(state.doc, head)
  // On a blank line the caret's own line is the (empty) active paragraph — everything else dims.
  const activeFrom = paragraph?.from ?? state.doc.lineAt(head).from
  const activeTo = paragraph?.to ?? state.doc.lineAt(head).to
  const matches = findMatchesOf(state)
  const builder = new RangeSetBuilder<Decoration>()
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos)
      if ((line.to < activeFrom || line.from > activeTo) && !overlapsFindMatch(matches, line.from, line.to)) builder.add(line.from, line.from, dimLine)
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/** Highlight sentence: a quiet accent-soft tint over the caret's sentence. */
function sentenceDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const head = state.selection.main.head
  const paragraph = paragraphAround(state.doc, head)
  if (!paragraph) return Decoration.none
  const sentences = segmentSentences(state.doc.sliceString(paragraph.from, paragraph.to), paragraph.from)
  const active = caretSentence(sentences, head)
  if (!active || active.to <= active.from) return Decoration.none
  return Decoration.set(sentenceMark.range(active.from, active.to))
}

/** Segment focus: every sentence except the caret's (or the selection's) fades to near-invisible. */
function segmentDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const selection = state.selection.main
  let active: { from: number; to: number } | null = null
  if (!selection.empty) {
    active = { from: selection.from, to: selection.to }
  } else {
    const paragraph = paragraphAround(state.doc, selection.head)
    if (paragraph) {
      const sentences = segmentSentences(state.doc.sliceString(paragraph.from, paragraph.to), paragraph.from)
      active = caretSentence(sentences, selection.head)
    }
  }
  const matches = findMatchesOf(state)
  const builder = new RangeSetBuilder<Decoration>()
  let covered = -1 // paragraphs extend past viewport edges; never re-add ranges already built
  for (const { from, to } of view.visibleRanges) {
    forEachParagraphBetween(state.doc, Math.max(from, covered + 1), to, (paragraph) => {
      if (paragraph.to <= covered) return
      for (const sentence of segmentSentences(state.doc.sliceString(paragraph.from, paragraph.to), paragraph.from)) {
        if (sentence.to <= sentence.from || sentence.from <= covered) continue
        // Overlap keeps contrast: finding/selection must beat focusing, so any intersection stays lit.
        if (active && sentence.from < active.to + 1 && sentence.to > active.from) continue
        if (overlapsFindMatch(matches, sentence.from, sentence.to)) continue
        builder.add(sentence.from, sentence.to, dimHardMark)
      }
      covered = Math.max(covered, paragraph.to)
    })
  }
  return builder.finish()
}

/** The three viewport-bounded layers share one plugin shape (modelled on comments.ts). */
function viewportLayer(
  build: (view: EditorView) => DecorationSet,
  externalChanged: (update: ViewUpdate) => boolean = () => false,
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = build(view)
      }
      update(update: ViewUpdate): void {
        // Find pushes match ranges as an effect, sometimes without a selection change (clearFind);
        // the exemption must follow it either way, or stale-lit sentences linger after Esc.
        const findChanged = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setFindMatches)))
        if (update.docChanged || update.selectionSet || update.viewportChanged || findChanged || externalChanged(update)) this.decorations = build(update.view)
      }
    },
    { decorations: (plugin) => plugin.decorations },
  )
}

/** The visual line break Sentence breakup inserts before each non-first sentence. Display-only:
 *  the underlying text is untouched; copying always copies the real text. */
class BreakWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'wf-break'
    span.setAttribute('aria-hidden', 'true')
    span.appendChild(document.createElement('br'))
    return span
  }
  eq(other: WidgetType): boolean {
    return other instanceof BreakWidget
  }
  ignoreEvent(): boolean {
    return true
  }
}
const breakWidget = new BreakWidget()

/** Sentence breakup: line-break widgets + numbered-gutter marks. A StateField — the widgets affect
 *  line layout, and block-affecting decorations from a ViewPlugin crash CM's tile DocView (the
 *  live-preview.ts:261 law). Doc-wide by construction (a StateField has no viewport).
 *
 *  Cached: the segmentation is keyed on doc identity — a full re-segment (doc.toString + regex walk)
 *  happens ONLY on tr.docChanged. Selection-only transactions recompute just which sentence is
 *  active from the cached spec and swap the two affected number marks in the existing set. */
type BreakupValue = { spec: BreakupSpec; activeFrom: number | null; deco: DecorationSet }

/** Test seam: counts full re-segmentations (breakup cache misses). */
export const breakupCacheStats = { segmentations: 0 }

/** The numeral rides a one-character mark at the sentence start (a whole-sentence mark would
 *  repeat its ::before on every wrapped-line split span). Active must be the SAME mark's class —
 *  the CSS pairs them as a compound selector (`.wf-break-n.wf-break-active::before`). */
function numberMark(sentence: NumberedSentence, active: boolean): Range<Decoration> {
  return Decoration.mark({
    class: `wf-break-n${active ? ' wf-break-active' : ''}`,
    attributes: { 'data-n': String(sentence.n) },
  }).range(sentence.from, Math.min(sentence.from + 1, sentence.to))
}

/** The sentence the numbering should mark active for a caret at `head` (null when none is markable). */
function markableActiveFrom(spec: BreakupSpec, head: number): number | null {
  const active = caretSentence(spec.sentences, head)
  return active && active.to > active.from ? active.from : null
}

function buildBreakup(state: EditorState): BreakupValue {
  breakupCacheStats.segmentations += 1
  const spec = breakupSpec(state.doc.toString())
  const activeFrom = markableActiveFrom(spec, state.selection.main.head)
  const ranges: Range<Decoration>[] = []
  for (const sentence of spec.sentences) {
    if (sentence.to <= sentence.from) continue
    ranges.push(numberMark(sentence, sentence.from === activeFrom))
  }
  for (const breakPos of spec.breaks) ranges.push(Decoration.widget({ widget: breakWidget, side: -1 }).range(breakPos))
  return { spec, activeFrom, deco: Decoration.set(ranges, true) }
}

/** Selection-only step: same doc, so reuse the cached spec — recompute only the active sentence and,
 *  when it moved, swap the outgoing/incoming number marks in place (widgets and all other marks stay). */
function moveBreakupActive(value: BreakupValue, head: number): BreakupValue {
  const activeFrom = markableActiveFrom(value.spec, head)
  if (activeFrom === value.activeFrom) return value
  const swap = new Set([value.activeFrom, activeFrom].filter((from): from is number => from !== null))
  const add: Range<Decoration>[] = []
  for (const sentence of value.spec.sentences) {
    if (!swap.has(sentence.from) || sentence.to <= sentence.from) continue
    add.push(numberMark(sentence, sentence.from === activeFrom))
  }
  const bounds = [...swap]
  const deco = value.deco.update({
    // Drop only the swapped number marks; zero-length break widgets at the same positions survive.
    filter: (from, to) => to === from || !swap.has(from),
    filterFrom: Math.min(...bounds),
    filterTo: Math.max(...bounds) + 1,
    add,
  })
  return { spec: value.spec, activeFrom, deco }
}

const breakupField = StateField.define<BreakupValue>({
  create: buildBreakup,
  update(value, tr) {
    if (tr.docChanged) return buildBreakup(tr.state)
    if (tr.selection) return moveBreakupActive(value, tr.state.selection.main.head)
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.deco),
})

/** Test seam: the live breakup decoration set on `state` (null when Breakup is off). */
export function breakupDecorations(state: EditorState): DecorationSet | null {
  return state.field(breakupField, false)?.deco ?? null
}

// ---------------------------------------------------------------------------
// The compartmented mode surface
// ---------------------------------------------------------------------------

type FocusConfig = { mode: FocusMode; leadStyle: LeadStyle }

/** Read-side truth for the live mode (getFocusConfig / EditorPane's per-switch reapply). */
const focusConfigFacet = Facet.define<FocusConfig, FocusConfig>({
  combine: (values) => values[0] ?? { mode: '', leadStyle: 'contrast' },
})

/** Empty by default (setup.ts's baseExtensions); setFocusMode reconfigures it in place — the
 *  typewriter-compartment pattern, so switching modes never rebuilds the extension stack. */
export const focusCompartment = new Compartment()

/** The complete extension for one mode: config facet + a root class for CSS + its decoration layer. */
export function focusExtension(mode: FocusMode, leadStyle: LeadStyle): Extension {
  const config = focusConfigFacet.of({ mode, leadStyle })
  if (mode === '') return [config]
  const rootClass = mode === 'anchored' ? `wf-focus-anchored wf-lead-${leadStyle}` : `wf-focus-${mode}`
  const base: Extension[] = [config, EditorView.editorAttributes.of({ class: rootClass })]
  switch (mode) {
    case 'fade':
      return [...base, viewportLayer(fadeDecorations, (update) => {
        const before = readAloudRanges(update.startState).paragraph
        const after = readAloudRanges(update.state).paragraph
        return before?.from !== after?.from || before?.to !== after?.to
      })]
    case 'sentence':
      return [...base, viewportLayer(sentenceDecorations)]
    case 'segment':
      return [...base, viewportLayer(segmentDecorations)]
    case 'breakup':
      return [...base, breakupField]
    case 'anchored':
      return [...base, anchoredLayer()]
  }
}

/** Apply a focus mode to `view` by reconfiguring the (already-installed) compartment. */
export function setFocusMode(view: EditorView, mode: FocusMode, leadStyle: LeadStyle): void {
  view.dispatch({ effects: focusCompartment.reconfigure(focusExtension(mode, leadStyle)) })
}

/** The live mode+style carried by `state` (the single source of truth for chip and reapply). */
export function getFocusConfig(state: EditorState): FocusConfig {
  return state.facet(focusConfigFacet)
}

/** The live mode on `view` ('' = off). */
export function getFocusMode(view: EditorView): FocusMode {
  return getFocusConfig(view.state).mode
}
