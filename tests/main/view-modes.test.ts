import { expect, test } from 'bun:test'
import { SearchQuery, search, setSearchQuery } from '@codemirror/search'
import { EditorSelection, EditorState } from '@codemirror/state'
import { baseExtensions } from '../../src/renderer/src/editor/setup'
import { livePreview, livePreviewBlocks } from '../../src/renderer/src/editor/live-preview'
import {
  concealedMarkupRanges,
  editorViewMode,
  editorViewModeOf,
  nextEditorViewMode,
  normaliseEditorViewMode,
  setEditorViewMode,
} from '../../src/renderer/src/editor/view-mode'

const DOC = '# Heading\n\nA **bold** word, [label](https://example.test), `code`, and ~~gone~~.\n\n> quote\n\n- list item\n'

function state(doc = DOC): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.cursor(doc.length),
    extensions: [
      ...baseExtensions({ onDocChanged: () => {} }),
      search(),
      livePreview({ assetBaseUrl: () => '' }),
    ],
  })
}

function textAtRanges(current: EditorState): string[] {
  return concealedMarkupRanges(current).map(({ from, to }) => current.doc.sliceString(from, to))
}

test('Clean is the default and conceals the specified marks without hiding list markers', () => {
  const current = state()
  expect(editorViewModeOf(current)).toBe('clean')
  expect(textAtRanges(current)).toEqual(['# ', '**', '**', '[', '](https://example.test)', '`', '`', '~~', '~~', '> '])
  expect(textAtRanges(current)).not.toContain('- ')
})

test('Clean reveals one whole heading, emphasis span, or link when the caret enters it', () => {
  const initial = state()
  const heading = initial.update({ selection: EditorSelection.cursor(4) }).state
  expect(textAtRanges(heading)).not.toContain('# ')

  const bold = initial.update({ selection: EditorSelection.cursor(DOC.indexOf('bold') + 1) }).state
  expect(textAtRanges(bold)).not.toContain('**')
  expect(textAtRanges(bold)).toContain('[',)

  const link = initial.update({ selection: EditorSelection.cursor(DOC.indexOf('label') + 1) }).state
  expect(textAtRanges(link)).not.toContain('[')
  expect(textAtRanges(link)).not.toContain('](https://example.test)')
})

test('Clean reveals an element overlapped by a selection and conceals it again after deselection', () => {
  const initial = state()
  const boldFrom = DOC.indexOf('bold')
  const selected = initial.update({
    selection: EditorSelection.range(boldFrom + 2, boldFrom - 3),
  }).state
  expect(textAtRanges(selected)).not.toContain('**')

  const deselected = selected.update({ selection: EditorSelection.cursor(DOC.length) }).state
  expect(textAtRanges(deselected).filter((marker) => marker === '**')).toHaveLength(2)
})

test('a search hit reveals the containing Clean element so its match highlight stays visible', () => {
  const initial = state()
  const searched = initial.update({ effects: setSearchQuery.of(new SearchQuery({ search: 'example.test' })) }).state
  expect(textAtRanges(searched)).not.toContain('[')
  expect(textAtRanges(searched)).not.toContain('](https://example.test)')
})

test('Markup and Raw expose all source marks while a mode round trip leaves bytes unchanged', () => {
  const initial = state()
  const markup = initial.update({ effects: setEditorViewMode.of('markup') }).state
  expect(editorViewModeOf(markup)).toBe('markup')
  expect(concealedMarkupRanges(markup)).toEqual([])

  const raw = markup.update({ effects: setEditorViewMode.of('raw') }).state
  expect(editorViewModeOf(raw)).toBe('raw')
  expect(concealedMarkupRanges(raw)).toEqual([])

  const clean = raw.update({ effects: setEditorViewMode.of('clean') }).state
  expect(clean.doc.toString()).toBe(DOC)
})

test('Raw disables StateField-owned object rendering while Markup and Clean keep it', () => {
  const doc = '---\ntitle: Modes\n---\n\n```js\nconst mode = "raw"\n```\n'
  const clean = state(doc)
  expect(livePreviewBlocks(clean).map((block) => block.kind)).toEqual(['frontmatter', 'code'])

  const markup = clean.update({ effects: setEditorViewMode.of('markup') }).state
  expect(livePreviewBlocks(markup).map((block) => block.kind)).toEqual(['frontmatter', 'code'])

  const raw = markup.update({ effects: setEditorViewMode.of('raw') }).state
  expect(livePreviewBlocks(raw)).toEqual([])
})

test('persisted mode values default safely and the status control cycles in grammar order', () => {
  expect(normaliseEditorViewMode(undefined)).toBe('clean')
  expect(normaliseEditorViewMode('unknown')).toBe('clean')
  expect(normaliseEditorViewMode('raw')).toBe('raw')
  expect(nextEditorViewMode('clean')).toBe('markup')
  expect(nextEditorViewMode('markup')).toBe('raw')
  expect(nextEditorViewMode('raw')).toBe('clean')
})

// ---- <kbd> key caps (onboarding ticket 05) ----

test('Clean conceals the <kbd> tags and reveals them when the caret is in or on the cap', () => {
  const doc = 'Press <kbd>⌘K</kbd> now.\n\nElsewhere.'
  const away = state(doc)
  expect(textAtRanges(away)).toEqual(['<kbd>', '</kbd>'])
  const inside = away.update({ selection: EditorSelection.cursor(doc.indexOf('⌘') + 1) }).state
  expect(textAtRanges(inside)).toEqual([])
  expect(inside.doc.toString()).toBe(doc) // viewing never rewrites the file
})

test('an unpaired or attributed <kbd> tag stays visible source', () => {
  expect(textAtRanges(state('Press <kbd>⌘K now.\n\nx'))).toEqual([])
  expect(textAtRanges(state('Press <kbd class="x">⌘K</kbd> now.\n\nx'))).toEqual([])
})
