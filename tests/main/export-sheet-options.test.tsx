import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DEFAULT_EXPORT_SHEET_OPTIONS,
  ExportOptionControls,
  exportDisclosure,
  exportedPhrase,
  exportLeftOutLines,
  exportPresetChoice,
  exportSheetChoice,
  exportSheetStorageKey,
  loadExportSheetOptions,
  loadExportPresetLastUsed,
  saveExportPresetLastUsed,
  saveExportSheetOptions,
  type ExportSheetOptions,
} from '../../src/renderer/src/components/ExportSheet'
import { ExportPresetControls } from '../../src/renderer/src/components/ExportPresetControls'
import { createExportPresetState, reduceExportPresetState, shippedExportPresetSettings } from '../../src/shared/export-presets'
import { sheetTocDepth } from '../../src/renderer/src/components/export-sheet-options'

type ElementLike = {
  type?: unknown
  props?: Record<string, unknown> & { children?: unknown }
}

function findButton(node: unknown, label: string): ElementLike {
  if (!node || typeof node !== 'object') throw new Error(`Could not find ${label}`)
  const element = node as ElementLike
  if (element.type === 'button' && element.props?.['aria-label'] === label) return element
  if (typeof element.type === 'function' && element.props) {
    return findButton((element.type as (props: Record<string, unknown>) => unknown)(element.props), label)
  }
  const children = element.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    try { return findButton(child, label) } catch { /* keep looking */ }
  }
  throw new Error(`Could not find ${label}`)
}

test('the HTML controls render the locked defaults with reader editing enabled', () => {
  const html = renderToStaticMarkup(
    <ExportOptionControls format="html" options={DEFAULT_EXPORT_SHEET_OPTIONS} onChange={() => {}} />,
  )

  expect(html).toContain('Document features')
  expect(html).toContain('Contents sidebar')
  expect(html).toContain('Title block and details')
  expect(html).toContain('Include word count and dates')
  expect(html).toContain('Report')
  expect(html).toContain('Editorial')
  expect(html).toContain('Masthead fields')
  expect(html).toContain('Date')
  expect(html).toContain('Status')
  expect(html).toContain('Author')
  expect(html).toContain('Purpose')
  expect(html).toContain('Tags')
  expect(html).toContain('Series')
  expect(html).toContain('Reader can add comments')
  expect(html).toContain('Reader can edit and return changes')
  expect(html).not.toContain('Coming')
  expect(html).not.toContain('Export presets')
})

test('the controls emit switch, design and masthead-field changes through one event', () => {
  const changes: ExportSheetOptions[] = []
  const tree = ExportOptionControls({
    format: 'html',
    options: DEFAULT_EXPORT_SHEET_OPTIONS,
    onChange: (next) => changes.push(next),
  })

  ;(findButton(tree, 'Contents sidebar on').props?.onClick as () => void)()
  ;(findButton(tree, 'Reader can add comments off').props?.onClick as () => void)()
  ;(findButton(tree, 'Reader can edit and return changes off').props?.onClick as () => void)()
  ;(findButton(tree, 'Editorial design').props?.onClick as () => void)()
  ;(findButton(tree, 'Purpose masthead field off').props?.onClick as () => void)()

  expect(changes[0]).toEqual({ ...DEFAULT_EXPORT_SHEET_OPTIONS, sidebar: false })
  expect(changes[1]).toEqual({ ...DEFAULT_EXPORT_SHEET_OPTIONS, readerNotes: true })
  expect(changes[2]).toEqual({ ...DEFAULT_EXPORT_SHEET_OPTIONS, readerEdits: true })
  expect(changes[3]).toEqual({ ...DEFAULT_EXPORT_SHEET_OPTIONS, design: 'b' })
  expect(changes[4]).toEqual({
    ...DEFAULT_EXPORT_SHEET_OPTIONS,
    frontmatterFields: ['date', 'status', 'author', 'purpose'],
  })
})

test('the reader-notes switch is enabled and honestly reflects an applied preset', () => {
  const html = renderToStaticMarkup(
    <ExportOptionControls
      format="html"
      options={{ ...DEFAULT_EXPORT_SHEET_OPTIONS, readerNotes: true }}
      onChange={() => {}}
    />,
  )
  expect(html).toContain('aria-label="Reader can add comments on"')
  expect(html).toContain('aria-checked="true"')
  expect(html).not.toMatch(/aria-label="Reader can add comments on"[^>]*disabled/)
})

test('arrow keys operate the Design picker without a mouse', () => {
  const changes: ExportSheetOptions[] = []
  const tree = ExportOptionControls({
    format: 'html',
    options: DEFAULT_EXPORT_SHEET_OPTIONS,
    onChange: (next) => changes.push(next),
  })
  let prevented = false
  ;(findButton(tree, 'Report design').props?.onKeyDown as (event: unknown) => void)({
    key: 'ArrowRight',
    preventDefault: () => { prevented = true },
    currentTarget: { parentElement: null },
  })

  expect(prevented).toBe(true)
  expect(changes).toEqual([{ ...DEFAULT_EXPORT_SHEET_OPTIONS, design: 'b' }])
})

test('the sheet event includes HTML options and leaves them off the Word payload', () => {
  expect(exportSheetChoice('collection', 'html', DEFAULT_EXPORT_SHEET_OPTIONS)).toEqual({
    scope: 'collection',
    format: 'html',
    html: {
      sidebar: true,
      titleBlock: true,
      readerNotes: false,
      readerEdits: false,
      summaryTiles: false,
      frontPage: false,
      design: 'a',
      frontmatterFields: ['date', 'status', 'author'],
    },
  })
  expect(exportSheetChoice('piece', 'docx', DEFAULT_EXPORT_SHEET_OPTIONS)).toEqual({
    scope: 'piece',
    format: 'docx',
  })
})

test('HTML-only controls stay visible but disabled when the format is Word', () => {
  const html = renderToStaticMarkup(
    <ExportOptionControls format="docx" options={DEFAULT_EXPORT_SHEET_OPTIONS} onChange={() => {}} />,
  )

  expect(html).toContain('HTML-only options')
  expect(html).toContain('disabled=""')
  expect(html).toContain('These choices apply to HTML exports')
})

test('sheet choices persist under separate workspace keys and malformed state falls back safely', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const changed: ExportSheetOptions = {
    sidebar: false,
    titleBlock: true,
    readerNotes: false,
    readerEdits: false,
    summaryTiles: true,
    frontPage: false,
    design: 'b',
    frontmatterFields: ['status', 'purpose'],
  }

  saveExportSheetOptions('/work/one', changed, storage)

  expect(exportSheetStorageKey('/work/one')).not.toBe(exportSheetStorageKey('/work/two'))
  expect(loadExportSheetOptions('/work/one', storage)).toEqual(changed)
  expect(loadExportSheetOptions('/work/two', storage)).toEqual(DEFAULT_EXPORT_SHEET_OPTIONS)
  values.set(exportSheetStorageKey('/work/two'), '{broken')
  expect(loadExportSheetOptions('/work/two', storage)).toEqual(DEFAULT_EXPORT_SHEET_OPTIONS)
})

test('the complete last-used applied or drifted choice stays under the existing per-Workspace key', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
  const lastUsed = {
    choice: exportPresetChoice('docx', { ...DEFAULT_EXPORT_SHEET_OPTIONS, design: 'b', readerNotes: true }),
    sourcePresetId: 'for-comments',
  }
  saveExportPresetLastUsed('/work/one', lastUsed, storage)
  expect(loadExportPresetLastUsed('/work/one', storage)).toEqual(lastUsed)
  expect(loadExportPresetLastUsed('/work/two', storage)).toBeNull()
})

test('applying a preset changes the export values without touching contextual scope', () => {
  const edits = shippedExportPresetSettings().presets[2]
  let state = createExportPresetState(shippedExportPresetSettings())
  const scope = 'collection' as const
  state = reduceExportPresetState(state, { type: 'apply', presetId: edits.id })
  expect(exportSheetChoice(scope, state.choice.format, state.choice)).toMatchObject({
    scope: 'collection',
    format: edits.choice.format,
  })
})

test('the For comments preset reaches the HTML export payload with reader notes enabled', () => {
  const comments = shippedExportPresetSettings().presets[1]
  let state = createExportPresetState(shippedExportPresetSettings())
  state = reduceExportPresetState(state, { type: 'apply', presetId: comments.id })

  expect(comments.name).toBe('For comments')
  expect(exportSheetChoice('piece', state.choice.format, state.choice)).toMatchObject({
    format: 'html',
    html: { readerNotes: true },
  })
})

test('the For edits preset reaches the HTML export payload with reader edits enabled', () => {
  const edits = shippedExportPresetSettings().presets[2]
  let state = createExportPresetState(shippedExportPresetSettings())
  state = reduceExportPresetState(state, { type: 'apply', presetId: edits.id })

  expect(edits.name).toBe('For edits')
  expect(exportSheetChoice('piece', state.choice.format, state.choice)).toMatchObject({
    format: 'html',
    html: { readerEdits: true },
  })
})

test('the omission disclosure names the exact HTML combination and always excludes margin notes', () => {
  expect(exportDisclosure('html', DEFAULT_EXPORT_SHEET_OPTIONS)).toBe(
    'This export includes a contents sidebar, a title block with date, status and author, and print styling. It leaves out the front page, reader comments, reader editing, word-count and modified-date tiles, unselected frontmatter, and your // margin notes never travel.',
  )
  expect(exportDisclosure('html', {
    sidebar: false,
    titleBlock: false,
    readerNotes: false,
    readerEdits: false,
    summaryTiles: true,
    frontPage: false,
    design: 'b',
    frontmatterFields: [],
  })).toBe(
    'This export includes word-count and modified-date tiles, Editorial design, and print styling. It leaves out the contents sidebar, the title block and masthead fields, the front page, reader comments, reader editing, unselected frontmatter, and your // margin notes never travel.',
  )
  expect(exportDisclosure('html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, readerNotes: true })).toContain(
    'reader comments with Markdown and JSON return files',
  )
  expect(exportDisclosure('html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, readerEdits: true })).toContain(
    'reader editing with a JSON diff return file',
  )
  expect(exportDisclosure('html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, frontPage: true })).toContain(
    'a front page cover',
  )
  expect(exportDisclosure('html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, frontPage: true })).not.toContain(
    'the front page,',
  )
  expect(exportDisclosure('docx', DEFAULT_EXPORT_SHEET_OPTIONS)).toContain(
    'HTML-only contents, title details, front page, summary tiles, design and masthead-field choices stay behind',
  )
})

test('the drifted preset surface shows all three locked truth signals', () => {
  const comments = shippedExportPresetSettings().presets[1]
  let state = createExportPresetState(shippedExportPresetSettings())
  state = reduceExportPresetState(state, { type: 'apply', presetId: comments.id })
  state = reduceExportPresetState(state, { type: 'change', choice: { ...state.choice, readerEdits: true } })
  const html = renderToStaticMarkup(<ExportPresetControls state={state} onAction={() => {}} />)
  expect(html).toContain('Changed from “For comments”')
  expect(html).toContain('Update “For comments”')
  expect(html).toContain('Save as new')
  expect(html).toContain('drift-source')
  expect(html).toContain('changed')
})

test('save-as and management remain modes inside the export sheet', () => {
  let state = createExportPresetState(shippedExportPresetSettings())
  state = reduceExportPresetState(state, { type: 'begin-save-as' })
  const naming = renderToStaticMarkup(<ExportPresetControls state={state} onAction={() => {}} />)
  expect(naming).toContain('Save as new preset')
  expect(naming).toContain('stored in this Mac’s app settings, not in the writing folder')
  expect(naming).toContain('Scope is not saved')

  state = reduceExportPresetState(state, { type: 'manage' })
  const managing = renderToStaticMarkup(<ExportPresetControls state={state} onAction={() => {}} />)
  expect(managing).toContain('All presets are editable')
  expect(managing).toContain('Rename')
  expect(managing).toContain('Delete')
  expect(managing).toContain('Move export preset up')
  expect(managing).toContain('Move export preset down')
  expect(managing).toContain('Palette parity')
})

test('the finished line states how many pieces were written, and how many were listed when some were left out', () => {
  expect(exportedPhrase({ pieces: 1, listed: 1 }, false)).toBe('Exported')
  expect(exportedPhrase({ pieces: 31, listed: 31 }, true)).toBe('Exported 31 pieces')
  expect(exportedPhrase({ pieces: 1, listed: 1 }, true)).toBe('Exported 1 piece')
  expect(exportedPhrase({ pieces: 29, listed: 31 }, true)).toBe('Exported 29 of 31 listed pieces')
})

test('left-out Folio entries are named with their authored path and the reason', () => {
  expect(exportLeftOutLines([])).toBeNull()
  expect(exportLeftOutLines([{ path: 'gone.md', reason: 'not-found' }])).toEqual({
    heading: '1 listed piece will be left out:',
    rows: ['gone.md — file not found'],
  })
  expect(exportLeftOutLines([
    { path: 'gone.md', reason: 'not-found' },
    { path: '../journal/private.md', reason: 'outside-folio' },
  ])).toEqual({
    heading: '2 listed pieces will be left out:',
    rows: ['gone.md — file not found', '../journal/private.md — outside this Folio’s folder'],
  })
})

test('with a file home the sheet shows the file’s toc_depth, Default when the key is absent; last-used only without one', () => {
  const folio = { label: 'Paper (toc_depth in its Index Note)', depth: 3 }
  expect(sheetTocDepth(5, folio)).toBe(3)
  expect(sheetTocDepth(undefined, folio)).toBe(3)
  // Sol D1, Spec P2a: last-used 5, a Folio whose Index Note has no toc_depth -> Default, and no explicit depth is sent.
  expect(sheetTocDepth(5, { ...folio, depth: null })).toBeUndefined()
  const choice = exportSheetChoice('collection', 'html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: sheetTocDepth(5, { ...folio, depth: null }) })
  expect(choice.html).not.toHaveProperty('tocDepth')
  // No file home (a folder without an Index Note): the last-used depth, as before.
  expect(sheetTocDepth(5, null)).toBe(5)

  const html = renderToStaticMarkup(
    <ExportOptionControls
      format="html"
      options={{ ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: sheetTocDepth(5, folio) }}
      onChange={() => {}}
      tocDepthHome={folio}
    />,
  )
  expect(html).toMatch(/<option value="3" selected="">Levels 1 to 3<\/option>/)
  expect(html).toContain('Saved with Paper (toc_depth in its Index Note) when you export as HTML.')
})

test('the dropdown never writes: a depth chosen for a file home rides the HTML export request, untouched it does not', () => {
  const folio = { label: 'Paper', depth: 3 }
  // Untouched: the file's value is shown and sent, and main is not asked to save anything.
  const untouched = exportSheetChoice('collection', 'html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: sheetTocDepth(5, folio) }, folio)
  expect(untouched.html?.tocDepth).toBe(3)
  expect(untouched).not.toHaveProperty('keepTocDepth')
  // Chosen 2: sent with the request, which asks main to keep it.
  const two = { ...folio, depth: 2, chosen: true }
  const chosen = exportSheetChoice('collection', 'html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: sheetTocDepth(5, two) }, two)
  expect(chosen).toMatchObject({ scope: 'collection', keepTocDepth: true, html: { tocDepth: 2 } })
  // Chosen Default: no depth sent, and keeping it removes the key.
  const none = { ...folio, depth: null, chosen: true }
  const reset = exportSheetChoice('piece', 'html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: sheetTocDepth(5, none) }, none)
  expect(reset.keepTocDepth).toBe(true)
  expect(reset.html).not.toHaveProperty('tocDepth')
  // Word has no contents depth: nothing is kept.
  expect(exportSheetChoice('piece', 'docx', DEFAULT_EXPORT_SHEET_OPTIONS, two)).not.toHaveProperty('keepTocDepth')
  // No file home: nothing is kept.
  expect(exportSheetChoice('piece', 'html', { ...DEFAULT_EXPORT_SHEET_OPTIONS, tocDepth: 4 }, null)).not.toHaveProperty('keepTocDepth')
})
