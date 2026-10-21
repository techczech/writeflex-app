import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserPatch, browserRecipe, csvRows, embedTarget, fieldOfMapped, guessMapping, insertLine, isStandardWidgetPath, readRecipe, readSource, refusalText, resolveFrom, sourceKindOf, sourceLabel, titleFromFile, undoesWidgetCreate } from '../../src/renderer/src/widgets/standard-widget-model'
import { checkRecipe } from '../../src/main/standard-widgets/recipe'
import { EditorState, Transaction } from '@codemirror/state'
import { history, isolateHistory, undo, undoDepth } from '@codemirror/commands'

/** The record browser's authoring model (ticket 04b): what the Source and preview tab knows before it asks the engine. */
const FIXTURES = new URL('../fixtures/standard-widgets/', import.meta.url).pathname
const fixture = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8')

test('a CSV is read to its fields and rows, quoted cells and line breaks included', () => {
  const read = readSource('csv', fixture('csv/courses.csv'))
  expect(read.ok && read.fields).toEqual(['course_id', 'title', 'audience', 'duration_hours', 'description', 'provider'])
  expect(read.ok && read.count).toBe(5)
  expect(read.ok && read.rows[1].description).toBe('Covers "personal data" and consent.')
  expect(read.ok && read.rows[2].description).toBe('Line one of the description.\nLine two, after a quoted newline.')
  expect(csvRows('a,b\r\n1,"x,y"\r\n')).toEqual([['a', 'b'], ['1', 'x,y']])
})

test('a CSV or JSON that cannot be records is refused in a plain sentence', () => {
  expect(readSource('csv', '')).toMatchObject({ ok: false })
  expect(readSource('csv', 'a,a\n1,2\n')).toMatchObject({ ok: false, message: expect.stringContaining('names a field twice') })
  expect(readSource('csv', 'a,b\n')).toMatchObject({ ok: false, message: expect.stringContaining('no records') })
  expect(readSource('json', '{ "items": [')).toMatchObject({ ok: false, message: expect.stringContaining('cannot be read') })
  expect(readSource('json', '{ "note": "x" }')).toMatchObject({ ok: false, message: expect.stringContaining('no list of records') })
})

test('a JSON source offers the lists of records it holds, outermost first, and the fields that are text or numbers', () => {
  const read = readSource('json', fixture('json/courses.json'))
  expect(read.ok && read.pointers).toEqual(['/catalogue/courses'])
  expect(read.ok && read.pointer).toBe('/catalogue/courses')
  expect(read.ok && read.fields).toEqual(['id', 'title', 'audience', 'hours', 'places', 'enrolment_ref', 'notes'])
  expect(readSource('json', fixture('json/courses-root-array.json'))).toMatchObject({ ok: true, pointer: '' })
  const two = readSource('json', '{"a":[{"x":"1"}],"b":[{"y":"2"}]}', '/b')
  expect(two).toMatchObject({ ok: true, pointer: '/b', fields: ['y'], pointers: ['/a', '/b'] })
})

test('the first mapping is the best-named field for each role, and detail does not repeat the title when it need not', () => {
  expect(guessMapping(['course_id', 'title', 'audience', 'description'])).toEqual({ title: 'title', detail: 'description', group: 'audience' })
  expect(guessMapping(['a', 'b', 'c'])).toEqual({ title: 'a', detail: 'b', group: null })
  expect(guessMapping(['only'])).toEqual({ title: 'only', detail: 'only', group: null })
})

test('the recipe a create sends passes the engine\'s own recipe check once the engine adds its keys', () => {
  const csv = browserRecipe({ title: ' Courses ', kind: 'csv', pointer: '', mapping: { title: 'title', detail: 'description', group: 'audience' } })
  expect(csv).toEqual({ template: 'browser', template_version: 1, title: 'Courses', source: { format: 'csv' }, mapping: { title: 'title', detail: 'description', group: 'audience' }, views: ['browser', 'list'] })
  expect(checkRecipe({ widget_schema: 1, ...csv, source: { ...(csv.source as object), path: '../../x.csv' } })).toEqual([])
  const json = browserRecipe({ title: 'T', kind: 'json', pointer: '/catalogue/courses', mapping: { title: 'title', detail: 'audience', group: null } })
  expect(json.source).toEqual({ format: 'json', select: { pointer: '/catalogue/courses' } })
  expect(json.mapping).toEqual({ title: '/title', detail: '/audience' })
  expect(checkRecipe({ widget_schema: 1, ...json, source: { ...(json.source as object), path: '../../x.json' } })).toEqual([])
  expect(fieldOfMapped('json', '/a~1b')).toBe('a/b')
})

test('an existing recipe is read back as settings, and a patch keeps the keys the writer did not touch', () => {
  const text = fixture('recipes/browser-from-csv.widget.md')
  const read = readRecipe(text)
  expect(read).toMatchObject({ ok: true, kind: 'csv', title: 'Courses to browse (CSV)', sourcePath: '../csv/courses.csv', mapping: { title: 'title', detail: 'description', group: 'audience' } })
  if (!read.ok) throw new Error('unreadable')
  const patch = browserPatch(read.recipe, { title: 'Courses', kind: 'csv', pointer: '', mapping: { title: 'title', detail: 'description', group: null } })
  expect(patch).toEqual({ title: 'Courses', mapping: { id: 'course_id', title: 'title', detail: 'description' } })
  expect(Object.keys(patch)).not.toContain('source')
  const moved = browserPatch(read.recipe, { title: 'Courses', kind: 'csv', pointer: '', mapping: read.mapping }, 'report/data/other.csv')
  expect(moved.source).toEqual({ file: 'report/data/other.csv', format: 'csv' })
  expect(readRecipe(fixture('recipes/process-browser.widget.md'))).toMatchObject({ ok: false, message: expect.stringContaining('other than a CSV or JSON') })
  expect(readRecipe(fixture('recipes/course-table.widget.md'))).toMatchObject({ ok: false, message: expect.stringContaining('not a record browser') })
  expect(readRecipe('not a recipe')).toMatchObject({ ok: false })
})

test('an embed line names its recipe only when it points at a made widget\'s page', () => {
  expect(embedTarget('report/report.md', '[Simulation: visualisations/courses/widget.html]')).toEqual({ rawPath: 'visualisations/courses/widget.html', pagePath: 'report/visualisations/courses/widget.html', recipePath: 'report/visualisations/courses/widget.md' })
  expect(embedTarget('report/chapters/one.md', '[Simulation: ../visualisations/a/widget.html]')?.recipePath).toBe('report/visualisations/a/widget.md')
  expect(embedTarget('report/report.md', '[Simulation: assets/inflation.html]')).toBeNull()
  expect(embedTarget('report/report.md', 'Plain text')).toBeNull()
  expect(embedTarget('report/report.md', '[Embed: https://example.com/visualisations/a/widget.html]')).toBeNull()
  expect(isStandardWidgetPath('../visualisations/a/widget.html')).toBe(true)
  expect(isStandardWidgetPath('assets/widget.html')).toBe(false)
})

test('small helpers: kinds by extension, paths folded, a refusal read as one sentence, a title from a file name', () => {
  expect([sourceKindOf('a/b.CSV'), sourceKindOf('b.json'), sourceKindOf('b.md')]).toEqual(['csv', 'json', null])
  expect(resolveFrom('a/b/visualisations/x', '../../../data/c.csv')).toBe('a/data/c.csv')
  expect(resolveFrom('', '../x')).toBeNull()
  expect(refusalText({ message: 'The widget could not be built.', errors: [{ message: 'A chosen field is not in the source.', severity: 'error' }, { message: 'warn', severity: 'warning' }] })).toBe('The widget could not be built. A chosen field is not in the source.')
  expect(titleFromFile('data/course-catalogue_2026.csv')).toBe('Course catalogue 2026')
})

test('the caret line a create sends: the caret\'s, the last line when the text is shorter now, none without a caret', () => {
  expect(insertLine(3, 'a\n\nb\n\nc\n')).toBe(3)
  expect(insertLine(9, 'a\n\nb\n')).toBe(3)
  expect(insertLine(null, 'a\n')).toBeNull()
  expect(insertLine(0, 'a\n')).toBeNull()
  expect(sourceLabel('report', 'report/data/a.csv')).toBe('data/a.csv')
  expect(sourceLabel('', 'data/a.csv')).toBe('data/a.csv')
})

test('⌘Z undoes the widget step only right after Create, in that document, with nothing typed since', () => {
  const key = { key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
  const step = { kind: 'create' as const, documentPath: 'notes/doc.md', documentText: 'A\n\n[Simulation: x/widget.html]\n', historyDepth: 2 }
  const editor = { inEditor: true, documentPath: 'notes/doc.md', text: step.documentText, undoDepth: 2 }
  expect(undoesWidgetCreate(key, step, editor)).toBe(true)
  expect(undoesWidgetCreate({ ...key, metaKey: false, ctrlKey: true }, step, editor)).toBe(true)
  // Every other ⌘Z is the editor's.
  expect(undoesWidgetCreate({ ...key, shiftKey: true }, step, editor)).toBe(false)
  expect(undoesWidgetCreate({ ...key, metaKey: false }, step, editor)).toBe(false)
  expect(undoesWidgetCreate(key, step, { ...editor, text: `${step.documentText}typed` })).toBe(false)
  expect(undoesWidgetCreate(key, step, { ...editor, inEditor: false })).toBe(false)
  expect(undoesWidgetCreate(key, step, { ...editor, documentPath: 'notes/other.md' })).toBe(false)
  expect(undoesWidgetCreate(key, { ...step, kind: 'update' }, editor)).toBe(false)
  expect(undoesWidgetCreate(key, null, editor)).toBe(false)
  // No history depth taken at the Create: the editor's.
  expect(undoesWidgetCreate(key, { ...step, historyDepth: undefined }, editor)).toBe(false)
})

test('⌘Z after Create, a character typed and deleted: the text is as Create left it, but the undo is the editor\'s', () => {
  const key = { key: 'z', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false }
  const created = 'A\n\n[Simulation: x/widget.html]\n'
  // The editor as the app has it: its own history; the insert came from disk, outside that history.
  let state = EditorState.create({ doc: 'A\n', extensions: [history()] })
  state = state.update({ changes: { from: 2, insert: '\n[Simulation: x/widget.html]\n' }, annotations: Transaction.addToHistory.of(false) }).state
  state = state.update({ annotations: isolateHistory.of('full') }).state
  const step = { kind: 'create' as const, documentPath: 'notes/doc.md', documentText: created, historyDepth: undoDepth(state) }
  const editorOf = (s: EditorState) => ({ inEditor: true, documentPath: 'notes/doc.md', text: s.doc.toString(), undoDepth: undoDepth(s) })
  expect(undoesWidgetCreate(key, step, editorOf(state))).toBe(true)
  // Type a character, delete it: same text, two edits in the editor's history.
  state = state.update({ changes: { from: 1, insert: 'x' }, userEvent: 'input.type' }).state
  state = state.update({ changes: { from: 1, to: 2 }, userEvent: 'delete.backward' }).state
  expect(state.doc.toString()).toBe(created)
  expect(undoesWidgetCreate(key, step, editorOf(state))).toBe(false)
  // The editor's undo takes those back; then ⌘Z is the widget's again (the Create is next in line).
  while (undoDepth(state) > step.historyDepth) {
    let next = state
    undo({ state, dispatch: (tr) => { next = tr.state } })
    state = next
  }
  expect(state.doc.toString()).toBe(created)
  expect(undoesWidgetCreate(key, step, editorOf(state))).toBe(true)
})
