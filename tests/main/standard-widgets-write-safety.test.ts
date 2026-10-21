/**
 * The record browser engine (ticket 04a) under the failures the first adversarial review found
 * (docs/reviews/2026-10-19-sol-04a-review-r1.md), each reproduced as the review did, through the seams the
 * production code already has: the guarded write's `documentSaveSeams` (a folder swapped, a file edited or a write
 * refused at the moment of a write) and a Workspace whose put-back of one file fails.
 *   1. a widget folder swapped for a link during creation puts nothing outside the Workspace;
 *   2. a page edited while a rebuild runs is kept, never overwritten;
 *   3. an undo whose document cannot be put back stops, keeps the widget, and can be tried again;
 *   4. a receipt that cannot be written fails the creation, and nothing is left;
 *   5. inherited object names are neither templates nor patches;
 *   6. a source with an error on every line returns the capped list, without throwing.
 * (7 and 8, the page's views, are in tests/browser/standard-widget-browser.test.ts; 8's check is here too.)
 * And the two the second review found (docs/reviews/2026-10-19-sol-04a-review-r2.md):
 *   R2-1. a folder's parent swapped for a link just after the folder is made: nothing outside is removed, and the
 *         answer names the folder left behind;
 *   R2-2. an undo retried after its document was given the embed again refuses, keeping the widget.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { readCsvRecords } from '../../src/main/standard-widgets/adapters'
import { buildStandardWidget } from '../../src/main/standard-widgets/build'
import { BUILD_ERROR_CAP } from '../../src/main/standard-widgets/build-errors'
import { createStandardWidget, operationSeams, StandardWidgetUndoDesk } from '../../src/main/standard-widgets/operations'
import { createInPlace } from '../helpers/own-folder-answer'
import { checkRecipe, parseRecipeText, updatedRecipeText, type RecipeMap } from '../../src/main/standard-widgets/recipe'
import { Workspace } from '../../src/main/workspace'

const FIXTURES = new URL('../fixtures/standard-widgets/', import.meta.url).pathname
const fixture = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8')

const roots: string[] = []
afterEach(() => {
  delete documentSaveSeams.betweenCheckAndWrite
  delete documentSaveSeams.afterStage
  delete operationSeams.afterMakeFolder
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wf-standard-widgets-safety-')))
  roots.push(dir)
  return dir
}
function workspace(files: Record<string, string>): { ws: Workspace; root: string } {
  const root = tempDir()
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { ws: new Workspace(root), root }
}
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name)
      const path = rel ? `${rel}/${name}` : name
      const info = lstatSync(abs)
      if (info.isDirectory()) { out[`${path}/`] = 'dir'; walk(abs, path) } else out[path] = info.isSymbolicLink() ? 'link' : readFileSync(abs, 'utf8')
    }
  }
  walk(root, '')
  return out
}
const essay = '# Essay\n\nOpening paragraph.\n'
const browserRecipe = (extra: RecipeMap = {}): RecipeMap => {
  const parsed = parseRecipeText(fixture('recipes/browser-from-csv.widget.md'))
  if (!parsed.ok) throw new Error('fixture')
  const { widget_schema: _ignored, source, ...rest } = parsed.recipe
  void _ignored
  return { ...rest, source: { format: (source as RecipeMap).format }, ...extra }
}

describe('Writes during creation and rebuild', () => {
  test('1. the widget folder swapped for a link to outside just after the write checked its path: nothing lands outside', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const outside = tempDir()
    const folder = join(root, 'notes/visualisations/courses')
    let swapped = false
    // The review's race: the path is validated (Workspace.absolute), then the folder becomes a link before the write.
    const absolute = ws.absolute.bind(ws)
    ws.absolute = (path: string): string => {
      const checked = absolute(path)
      if (!swapped && path.endsWith('/widget.md') && existsSync(folder)) {
        rmdirSync(folder)
        symlinkSync(outside, folder)
        swapped = true
      }
      return checked
    }
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    expect(swapped).toBe(true)
    expect(readdirSync(outside)).toEqual([])
    expect(result.ok).toBe(false)
    const after = snapshot(root)
    expect(Object.keys(after).filter((path) => !path.startsWith('notes/visualisations'))).toEqual(['notes/', 'notes/data/', 'notes/data/courses.csv', 'notes/essay.md'])
    expect(after['notes/essay.md']).toBe(essay)
  })

  test('1b. the widget folder swapped for a link between the guarded write\'s check and its staging: nothing lands outside, nothing is left', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const outside = tempDir()
    const folder = join(root, 'notes/visualisations/courses')
    let swapped = false
    documentSaveSeams.betweenCheckAndWrite = async (path) => {
      if (swapped || !path.endsWith('/widget.md')) return
      rmdirSync(folder)
      symlinkSync(outside, folder)
      swapped = true
    }
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    expect(swapped).toBe(true)
    expect(result.ok).toBe(false)
    // Not a byte outside: no recipe, no staged file.
    expect(readdirSync(outside)).toEqual([])
    // Inside, the step is gone: the document as it was, no Folio made. Only the link the swap left stands.
    const after = snapshot(root)
    expect(after['notes/essay.md']).toBe(essay)
    expect(Object.keys(after).filter((path) => !path.startsWith('notes/visualisations'))).toEqual(['notes/', 'notes/data/', 'notes/data/courses.csv', 'notes/essay.md'])
    expect(after['notes/visualisations/courses']).toBe('link')
  })

  test('1c. the widget folder swapped for a link to another folder of the Workspace, and back after the write staged there: refused, that folder untouched, the step put back', async () => {
    // Another folder INSIDE the Workspace: a link out of the Workspace is refused by the guarded write itself.
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv'), 'other/visualisations/courses/keep.txt': 'kept\n' })
    const before = snapshot(root)
    const folder = join(root, 'notes/visualisations/courses')
    const elsewhere = join(root, 'other/visualisations/courses')
    let swapped = false
    let back = false
    // To the link just as the recipe write judges its path (so it stages in the other folder) ...
    const absolute = ws.absolute.bind(ws)
    ws.absolute = (path: string): string => {
      if (!swapped && path.endsWith('/widget.md') && existsSync(folder)) {
        renameSync(folder, `${folder}-moved`)
        symlinkSync(elsewhere, folder)
        swapped = true
      }
      return absolute(path)
    }
    // ... and back once the bytes are staged, so the folder path is the very folder again at the commit.
    documentSaveSeams.afterStage = async (path) => {
      if (back || !swapped || !path.endsWith('/widget.md')) return
      rmSync(folder)
      renameSync(`${folder}-moved`, folder)
      back = true
    }
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    expect(swapped && back).toBe(true)
    expect(result.ok).toBe(false)
    expect(readdirSync(elsewhere)).toEqual(['keep.txt'])
    // The step is put back whole: the document, no Folio, no widget folder.
    expect(snapshot(root)).toEqual(before)
  })

  test('R2-1. the parent swapped for a link to outside just after the widget folder is made: the outside folder of that name stays, and the answer names the folder left', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const outside = tempDir()
    mkdirSync(join(outside, 'courses'))
    let swapped = false
    operationSeams.afterMakeFolder = (folder) => {
      if (swapped || folder !== 'notes/visualisations/courses') return
      renameSync(join(root, 'notes/visualisations'), join(root, 'notes/moved-aside'))
      symlinkSync(outside, join(root, 'notes/visualisations'))
      swapped = true
    }
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    expect(swapped).toBe(true)
    expect(result.ok).toBe(false)
    // The outside folder that was there before is not touched.
    expect(lstatSync(join(outside, 'courses')).isDirectory()).toBe(true)
    expect(readdirSync(outside)).toEqual(['courses'])
    // The folder made stands where the swap moved it, and the answer says so rather than "Nothing was changed".
    expect(lstatSync(join(root, 'notes/moved-aside/courses')).isDirectory()).toBe(true)
    const message = result.ok ? '' : result.message
    expect(message).not.toContain('Nothing was changed')
    expect(message).toContain('notes/visualisations/courses could not be put back (it could not be checked to be the folder WriteFlex made')
    expect(snapshot(root)['notes/essay.md']).toBe(essay)
  })

  test('2. a page edited while the rebuild runs is kept; the new page goes to widget.rebuilt.html', async () => {
    const { ws, root } = workspace({
      'report/_report-structure.json': JSON.stringify({ schema_version: 1, files: [{ path: 'report.md', role: 'section' }] }),
      'report/report.md': '# Report\n',
      'report/csv/courses.csv': fixture('csv/courses.csv'),
      'report/visualisations/courses/widget.md': fixture('recipes/browser-from-csv.widget.md').replace('path: ../csv/', 'path: ../../csv/'),
    })
    const recipePath = 'report/visualisations/courses/widget.md'
    const page = join(root, 'report/visualisations/courses/widget.html')
    expect((await buildStandardWidget(ws, recipePath)).result).toBe('built')
    // The source changes, so the rebuild has a new page to write; the author edits the page just before it does.
    writeFileSync(join(root, 'report/csv/courses.csv'), fixture('csv/courses.csv').replace('Prompting basics', 'Prompting, revised'))
    const authorEdit = `${readFileSync(page, 'utf8')}<!-- the author's own note -->\n`
    documentSaveSeams.betweenCheckAndWrite = async (path) => {
      if (path.endsWith('/widget.html')) writeFileSync(page, authorEdit)
    }
    const outcome = await buildStandardWidget(ws, recipePath)
    expect(readFileSync(page, 'utf8')).toBe(authorEdit)
    expect(outcome.result).toBe('kept-hand-edit')
    expect(outcome.errors.map((error) => [error.code, error.severity])).toEqual([['output-hand-edited', 'warning']])
    expect(outcome.writtenOutput).toBe('report/visualisations/courses/widget.rebuilt.html')
    expect(readFileSync(join(root, 'report/visualisations/courses/widget.rebuilt.html'), 'utf8')).toContain('Prompting, revised')
  })

  test('4. a receipt that cannot be written fails the creation, and everything the step wrote is put back', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    documentSaveSeams.betweenCheckAndWrite = async (path) => {
      if (path.endsWith('/widget.build.json')) throw new Error('the disk refused the receipt')
    }
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.errors.map((error) => [error.code, error.source.path])).toEqual([['output-write-failed', 'notes/visualisations/courses/widget.build.json']])
    expect(snapshot(root)).toEqual(before)
  })
})

describe('Undo', () => {
  test('3. the document cannot be put back: the undo stops, the widget it points at stays, and the undo can be tried again', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const result = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!result.ok) throw new Error(result.message)
    const made = snapshot(root)
    const putBack = ws.saveFileOverRead.bind(ws)
    ws.saveFileOverRead = async (path, ...rest) => {
      if (path === 'notes/essay.md') throw new Error('the disk refused the write')
      return putBack(path, ...rest)
    }
    const failed = await desk.undo(ws, result.undoId)
    expect(failed).toMatchObject({ ok: false, code: 'incomplete', restored: [] })
    expect(!failed.ok && failed.message).toContain('notes/essay.md could not be put back')
    // Nothing was removed: the embed and the widget files it points at all stand.
    expect(snapshot(root)).toEqual(made)
    expect(desk.has(result.undoId)).toBe(true)

    ws.saveFileOverRead = putBack
    expect((await desk.undo(ws, result.undoId)).ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
    expect(desk.has(result.undoId)).toBe(false)
  })
})

describe('Undo retried', () => {
  test('R2-2. the receipt cannot be removed after the document was put back; the embed is put back into the document; the retry refuses and keeps the widget', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const result = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!result.ok) throw new Error(result.message)
    const embedded = result.documentText
    const remove = ws.removeFileOverRead.bind(ws)
    ws.removeFileOverRead = (path, read) => {
      if (path.endsWith('/widget.build.json')) throw new Error('the disk refused the removal')
      return remove(path, read)
    }
    const failed = await desk.undo(ws, result.undoId)
    expect(failed).toMatchObject({ ok: false, code: 'incomplete', restored: ['notes/essay.md'] })
    expect(readFileSync(join(root, 'notes/essay.md'), 'utf8')).toBe(essay)

    // The embed goes back into the document; the retry must not remove the widget it points at.
    writeFileSync(join(root, 'notes/essay.md'), embedded)
    ws.removeFileOverRead = remove
    const kept = snapshot(root)
    const retried = await desk.undo(ws, result.undoId)
    expect(retried).toMatchObject({ ok: false, code: 'changed' })
    expect(!retried.ok && retried.message).toContain('notes/essay.md')
    expect(snapshot(root)).toEqual(kept)
    expect(existsSync(join(root, result.outputPath))).toBe(true)
    expect(desk.has(result.undoId)).toBe(true)

    // With the document as the undo left it, the retry finishes.
    writeFileSync(join(root, 'notes/essay.md'), essay)
    expect((await desk.undo(ws, result.undoId)).ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
    expect(desk.has(result.undoId)).toBe(false)
  })
})

describe('Recipe and source boundaries', () => {
  test('5. an inherited name is not a template, and an authored key with one does not block an update', async () => {
    const valid: RecipeMap = { widget_schema: 1, ...browserRecipe(), source: { path: 'a.csv', format: 'csv' } }
    expect(checkRecipe(valid)).toEqual([])
    for (const name of ['toString', 'constructor', '__proto__']) expect(checkRecipe({ ...valid, template: name })).toEqual([{ code: 'recipe-unknown-template', value: name }])
    const { ws, root } = workspace({ 'essay.md': essay, 'courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    const refused = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'essay.md', name: 'b', recipe: browserRecipe({ template: 'toString' }), sourceFile: 'courses.csv' })
    expect(!refused.ok && refused.errors.map((error) => [error.code, error.value])).toEqual([['recipe-unknown-template', 'toString']])
    expect(snapshot(root)).toEqual(before)

    const authored = '---\nwidget_schema: 1\ntoString: the author\'s own key\ntitle: Old\n---\nBody.\n'
    expect(updatedRecipeText(authored, { title: 'New' })).toBe('---\nwidget_schema: 1\ntoString: the author\'s own key\ntitle: New\n---\nBody.\n')
    expect(updatedRecipeText('---\nwidget_schema: 1\ntitle: Old\n---\n', { constructor: 'added' })).toBe('---\nwidget_schema: 1\ntitle: Old\nconstructor: added\n---\n')
  })

  test('6. a CSV with 150,000 missing ids returns the capped error list without throwing', () => {
    const text = `id,title\n${',x\n'.repeat(150_000)}`
    const read = readCsvRecords('big.csv', text, { idField: 'id', mapped: ['id', 'title'] })
    expect(read.ok).toBe(false)
    const errors = read.ok ? [] : read.errors
    expect(errors).toHaveLength(BUILD_ERROR_CAP)
    expect(errors[0]).toEqual({ code: 'id-missing', line: 2, record: 1, field: 'id' })
    // Malformed rows on every line are capped the same way.
    const ragged = readCsvRecords('ragged.csv', `id,title\n${'1\n'.repeat(150_000)}`, { mapped: [] })
    expect(ragged.ok ? 0 : ragged.errors.length).toBe(BUILD_ERROR_CAP)
  })

  test('8. initial.view must be one of the views; the built page opens in it', async () => {
    const valid: RecipeMap = { widget_schema: 1, ...browserRecipe(), source: { path: 'a.csv', format: 'csv' } }
    expect(checkRecipe({ ...valid, initial: { view: 'list' } })).toEqual([])
    expect(checkRecipe({ ...valid, initial: { view: 'table' } })).toEqual([{ code: 'recipe-invalid', field: 'initial.view', value: 'table' }])
    expect(checkRecipe({ ...valid, views: ['browser'], initial: { view: 'list' } })).toEqual([{ code: 'recipe-invalid', field: 'initial.view', value: 'list' }])
    expect(checkRecipe({ ...valid, initial: 'list' })).toEqual([{ code: 'recipe-invalid', field: 'initial' }])
    const { ws, root } = workspace({ 'essay.md': essay, 'courses.csv': fixture('csv/courses.csv') })
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'essay.md', name: 'b', recipe: browserRecipe({ initial: { view: 'list' } }), sourceFile: 'courses.csv' })
    if (!result.ok) throw new Error(result.message)
    const html = readFileSync(join(root, result.outputPath), 'utf8')
    const data = JSON.parse(/<script type="application\/json" id="wf-widget-data">([\s\S]*?)<\/script>/.exec(html)![1])
    expect([data.views, data.initial]).toEqual([['browser', 'list'], 'list'])
    expect(existsSync(join(root, 'visualisations/b/widget.build.json'))).toBe(true)
  })
})
