import { expect, test } from 'bun:test'
import { markdown } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { GFM } from '@lezer/markdown'
import {
  HEADING_SPACE_ABOVE_EM,
  HEADING_SPACE_BELOW_EM,
  HEADING_SPACE_REDUCED_EM,
  headingSpacing,
  headingSpacingDecorations,
  headingSpacingOf,
  headingSpacingOfState,
  paddingAbove,
  paddingBelow,
} from '../../src/renderer/src/editor/heading-spacing'
import { markdownDialect } from '../../src/shared/markdown/dialect'
import { HEADING_SIZE_EM } from '../../src/renderer/src/editor/theme'
import {
  pendingWriterChanges,
  setWriterMode,
  writerReviewing,
} from '../../src/renderer/src/editor/writer-review'

// Ticket H / ADR-0041 ("Calm"): 1.15em of air above a heading, 0.30em below, display only — the
// four states that decide it are the four groups below. The drawing is
// docs/design/2026-08-28-quality-of-life-0-21/heading-spacing.html.

/** Compact fixture: no blank lines anywhere, so the block rule (ADR-0039) does all the work. */
const TIGHT = [
  '# Sources of hallucination',
  'Sometimes we say wrong things because we did not know the answer.',
  '## Lack of context',
  'Sometimes we say wrong things because we did not have a complete picture.',
].join('\n')

const above = (text: string): string[] => headingSpacingOf(text).map((spacing) => spacing.above)

// --- the ordinary case -------------------------------------------------------------------------

test('a heading with prose directly above it gets the full space, and every heading gets the hair below', () => {
  expect(headingSpacingOf(TIGHT).map((spacing) => ({ level: spacing.level, above: spacing.above }))).toEqual([
    { level: 1, above: 'none' }, // the very top — state 2 below
    { level: 2, above: 'full' },
  ])
  const styles = flatten(headingSpacingDecorations(stateOf(TIGHT)))
  // The H2's line carries both: the locked 1.15em against ITS size (24px/18.5px), and the hair below.
  expect(styles.find((line) => line.cls.includes('wf-heading-space'))?.style)
    .toBe('padding-top:1.492em;padding-bottom:0.389em')
  // The H1 at the top gets no space above at all, only the hair below — at ITS size, not the body's.
  expect(styles[0]).toEqual({ from: 0, cls: 'wf-heading-tail', style: 'padding-bottom:0.665em' })
  expect(paddingAbove({ level: 2, above: 'full' })).toBeCloseTo(HEADING_SPACE_ABOVE_EM * HEADING_SIZE_EM[2]!, 6)
  expect(paddingBelow({ level: 2 })).toBeCloseTo(HEADING_SPACE_BELOW_EM * HEADING_SIZE_EM[2]!, 6)
})

test('a hash inside a fenced code block is code, not a heading', () => {
  const fenced = ['Prose before.', '```bash', '# not a heading', '```', 'Prose after.'].join('\n')
  expect(headingSpacingOf(fenced)).toEqual([])
})

test('both sides of a heading scale with the heading, so every level keeps the same proportions', () => {
  // The relationship, not the pixels: whatever the theme's heading scale becomes, the space above
  // and the hair below stay the SAME multiple of the heading's own size at every level. Measuring
  // the live app caught these two drifting apart — a flat hair below left an H1 with less clear
  // space under it than an H3, because its tighter line-height gives back less half-leading.
  const ladder = 'An opening line.\n# One\nProse.\n## Two\nProse.\n### Three\nProse.'
  const styles = flatten(headingSpacingDecorations(stateOf(ladder)))
  const em = (line: { style: string }, property: string): number =>
    Number(new RegExp(`${property}:([0-9.]+)em`).exec(line.style)![1])

  const perLevel = headingSpacingOf(ladder).map((spacing) => {
    const line = styles.find((candidate) => candidate.from === spacing.from)!
    const scale = HEADING_SIZE_EM[spacing.level]!
    return { level: spacing.level, above: em(line, 'padding-top') / scale, below: em(line, 'padding-bottom') / scale }
  })
  expect(perLevel.map((level) => level.level)).toEqual([1, 2, 3]) // the ladder really is three levels

  for (const level of perLevel) {
    expect(level.above).toBeCloseTo(HEADING_SPACE_ABOVE_EM, 2)
    expect(level.below).toBeCloseTo(HEADING_SPACE_BELOW_EM, 2)
  }
  // Stated as a relationship between levels as well: one constant ratio, three heading sizes.
  const ratios = perLevel.map((level) => level.above / level.below)
  expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(0.01)
  // And the sizes really do differ, so a constant ratio is a finding rather than an accident.
  expect(new Set(perLevel.map((level) => HEADING_SIZE_EM[level.level])).size).toBe(3)
})

// --- state 1: the writer did type a blank line ---------------------------------------------------

test('state 1 — a typed blank line above a heading adds no space, so old documents do not grow craters', () => {
  const withBlank = 'People fail tests while being perfectly capable.\n\n## Lack of context\nSometimes we say wrong things.'
  expect(above(withBlank)).toEqual(['none'])
  // Nothing at all is drawn above it: the only decoration on that line is the hair below.
  const heading = withBlank.indexOf('## Lack')
  expect(flatten(headingSpacingDecorations(stateOf(withBlank))).find((line) => line.from === heading))
    .toEqual({ from: heading, cls: 'wf-heading-tail', style: 'padding-bottom:0.389em' })
  // The same document without the blank line DOES get the full space — the two states differ.
  expect(above(withBlank.replace('\n\n', '\n'))).toEqual(['full'])
})

test('state 1 — the document text is never touched: this is display only (ADR-0039)', () => {
  const state = stateOf(TIGHT)
  const decorated = state.update({ changes: { from: state.doc.length, insert: '\n## Later\nMore prose.' } }).state
  expect(decorated.doc.toString()).toBe(`${TIGHT}\n## Later\nMore prose.`)
  expect(above(decorated.doc.toString())).toEqual(['none', 'full', 'full'])
})

// --- state 2: the very top of the document -------------------------------------------------------

test('state 2 — a heading at the very top of the document gets no space above', () => {
  expect(above('# Sources of hallucination\nSometimes we say wrong things.')).toEqual(['none'])
  expect(paddingAbove({ level: 1, above: 'none' })).toBe(0)
  // Push one line of prose above it and the same heading takes the full space.
  expect(above('An opening line.\n# Sources of hallucination\nSometimes we say wrong things.')).toEqual(['full'])
})

// --- state 3: two headings in a row ---------------------------------------------------------------

test('state 3 — consecutive headings share one stack: the join is reduced, the full space sits above the pair', () => {
  const stacked = 'Prose above the pair.\n## Sources of hallucination\n### Lack of understanding\nSometimes we say wrong things.'
  expect(above(stacked)).toEqual(['full', 'reduced'])
  const spacings = headingSpacingOf(stacked)
  const pairTop = paddingAbove(spacings[0]!)
  const join = paddingAbove(spacings[1]!)
  expect(join).toBeCloseTo(HEADING_SPACE_REDUCED_EM * HEADING_SIZE_EM[3]!, 6)
  expect(join).toBeLessThan(pairTop) // reduced, and reduced against the full space above the pair
  expect(join).toBeGreaterThan(0)
  // A blank line between the two headings is still the writer's own air, so nothing is added.
  expect(above(stacked.replace('\n### ', '\n\n### '))).toEqual(['full', 'none'])
})

// --- state 4: Writing and Reviewing are identical --------------------------------------------------

const installedSets = (state: EditorState): DecorationSet[] =>
  state.facet(EditorView.decorations).filter((value): value is DecorationSet => typeof value !== 'function')

/** Every heading-spacing line decoration a real extension stack ends up providing, in either mode. */
const spacingIn = (state: EditorState): Array<{ from: number; cls: string; style: string }> =>
  installedSets(state).flatMap((set) => flatten(set)).filter((line) => line.cls.includes('wf-heading'))

/** The writer-review wash, as one set, so a test can see a mark lying over a heading. */
const marksIn = (state: EditorState): DecorationSet =>
  installedSets(state).find((set) => flatten(set).some((mark) => mark.cls.includes('writer-change')))
    ?? installedSets(state)[0]!

test('state 4 — heading spacing is identical in Writing and in Reviewing', () => {
  const drafting = modeState('drafting')
  const reviewing = modeState('reviewing')
  expect(spacingIn(drafting)).not.toEqual([]) // the extension is actually installed in both
  expect(spacingIn(reviewing)).toEqual(spacingIn(drafting))
  // And switching mode live moves nothing.
  const switched = drafting.update({ effects: setWriterMode.of('reviewing') }).state
  expect(spacingIn(switched)).toEqual(spacingIn(drafting))
})

test("state 4 — a change mark running over a heading leaves the heading's own space untouched", () => {
  // The complaint that started this round: in Reviewing a wash ran across the heading and joined it
  // to the paragraph after it. A mark may still cover a heading the writer really did edit across —
  // trimming the mark itself is the minimal-span half of this round, a separate ticket — but the
  // heading's space is a property of the heading and survives any wash lying over it.
  const before = TIGHT.indexOf('did not know')
  const after = TIGHT.indexOf('did not have')
  const reviewing = modeState('reviewing').update({ changes: { from: before, to: after, insert: 'never knew ' } }).state
  const washed = flatten(marksIn(reviewing)).filter((mark) => mark.cls.includes('writer-change'))
  expect(washed).not.toEqual([]) // the wash really is there, and really does run over the heading
  const heading = headingSpacingOf(reviewing.doc.toString()).find((spacing) => spacing.level === 2)!
  expect(spacingIn(reviewing).find((line) => line.from === heading.from))
    .toEqual({ from: heading.from, cls: 'wf-heading-space wf-heading-tail', style: 'padding-top:1.492em;padding-bottom:0.389em' })
  // And identical in Writing: same document, same space, mark or no mark.
  expect(spacingIn(reviewing)).toEqual(spacingIn(stateOf(reviewing.doc.toString())))
})

test('state 4 — two edits in two blocks stay two changes, so no single wash joins them across the heading', () => {
  let state = modeState('reviewing')
  const beforeTypo = state.doc.toString().indexOf('did not know')
  state = state.update({ changes: { from: beforeTypo, to: beforeTypo + 12, insert: 'never knew' } }).state
  const afterTypo = state.doc.toString().indexOf('complete picture')
  state = state.update({ changes: { from: afterTypo, to: afterTypo + 8, insert: 'full' } }).state

  const changes = pendingWriterChanges(state)
  expect(changes).toHaveLength(2)
  const heading = headingSpacingOf(state.doc.toString()).find((spacing) => spacing.level === 2)!
  for (const change of changes) {
    expect(change.anchor.from < heading.to && change.anchor.to > heading.from).toBe(false)
  }
})

// --- helpers ---------------------------------------------------------------------------------------

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [headingSpacing] })
}

function modeState(mode: 'drafting' | 'reviewing'): EditorState {
  return EditorState.create({
    doc: TIGHT,
    extensions: [markdown({ extensions: [GFM] }), writerReviewing({ initialMode: mode }), headingSpacing],
  })
}

function flatten(deco: DecorationSet): Array<{ from: number; cls: string; style: string }> {
  const lines: Array<{ from: number; cls: string; style: string }> = []
  deco.between(0, Number.MAX_SAFE_INTEGER, (from, _to, value) => {
    const spec = value.spec as { class?: string; attributes?: { style?: string } }
    lines.push({ from, cls: spec.class ?? '', style: spec.attributes?.style ?? '' })
  })
  return lines
}

// --- frontmatter is stage-truth, not writing (ADR-0019) --------------------------------------------

test("a document's frontmatter is never spaced as a heading, and the title after it stays at the top", () => {
  const withMetadata = `---\ntitle: A piece\nstage: draft\n---\n${TIGHT}`
  // Without the guard the closing `---` fence parses as a Setext H2 over the whole metadata block.
  expect(headingSpacingOf(withMetadata).map((spacing) => withMetadata.slice(spacing.from, spacing.to)))
    .toEqual(['# Sources of hallucination', '## Lack of context'])
  expect(above(withMetadata)).toEqual(['none', 'full'])
})

// --- 0.24.1: headings read off the editor's syntax tree answer exactly what the text parse did ----

const FIXTURES: Record<string, string> = {
  tight: TIGHT,
  fenced: ['Prose.', '```bash', '# not a heading', '```', '## Real', 'After.'].join('\n'),
  setext: ['Title', '=====', 'Body line', 'Sub', '-----', '', 'Para', '# After para'].join('\n'),
  frontmatter: ['---', 'title: x', '---', '# First', 'text', '## Second', '', '### Third'].join('\n'),
  frontmatterLoose: ['---', 'title: x', '---', '', '# First', '## Second'].join('\n'),
  unclosedFence: ['---', 'a: b', '# Heading', 'text'].join('\n'),
  nestedLists: ['- item', '  # nested heading', '  more', '- other', '## Heading', '1. one', '   continued', '# H'].join('\n'),
  quote: ['> # quoted', '> text', '', '# top', '## stacked', '### stacked again', 'prose', '#### deep'].join('\n'),
  blankLines: ['# A', '', '', '## B', '   ', '### C', '', 'text'].join('\n'),
  crlf: ['# A', 'text', '## B', ''].join('\r\n'),
  empty: '',
}

function treeState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ extensions: markdownDialect() }), headingSpacing] })
}

for (const [name, text] of Object.entries(FIXTURES)) {
  test(`tree-based spacing equals the text parse: ${name}`, () => {
    const state = treeState(text)
    // CodeMirror normalises line breaks, so the old field saw doc.toString(), not the raw text.
    const seen = state.doc.toString()
    expect(headingSpacingOfState(state)).toEqual(headingSpacingOf(seen))
    expect(flatten(headingSpacingDecorations(state))).toEqual(flatten(headingSpacingDecorations(stateOf(seen))))
  })
}

test('tree-based spacing stays equal to the text parse across edits and on random documents', () => {
  const pieces = ['# H', '## Sub', 'prose', '', '- item', '  cont', '```', '---', 'Title', '====', '> quote', '   ', '1. one']
  let seed = 7
  const next = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  for (let round = 0; round < 60; round++) {
    const text = Array.from({ length: 4 + next(12) }, () => pieces[next(pieces.length)]).join('\n')
    let state = treeState(text)
    for (let edit = 0; edit < 3; edit++) {
      const at = next(state.doc.length + 1)
      state = state.update({ changes: { from: at, insert: pieces[next(pieces.length)]! + (next(2) ? '\n' : '') } }).state
      expect(headingSpacingOfState(state)).toEqual(headingSpacingOf(state.doc.toString()))
    }
  }
})

test('the heading-spacing field follows a typed edit', () => {
  let state = treeState('text\n\nmore')
  state = state.update({ changes: { from: 0, insert: '## ' } }).state
  const provided = state.facet(EditorView.decorations).flatMap((source) => typeof source === 'function' ? [] : [source])
  expect(provided.flatMap((set) => flatten(set)).map((line) => line.cls)).toEqual(['wf-heading-tail'])
})
