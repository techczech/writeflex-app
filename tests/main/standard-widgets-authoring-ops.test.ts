/**
 * The engine operations the Source and preview workbench needs (record browser, ticket 04b follow-up):
 *   1. preview before create: the page a recipe draft and source would build, with nothing written;
 *   2. the CSV and JSON files a widget may read: contained, no links, bounded;
 *   3. edited source text saved through the guarded write, as part of the undoable create or update step;
 *   4. the embed line put where a caret on a given line puts it, the line checked against the document basis.
 * Each runs against a real temporary Workspace; every "nothing written" is a whole-tree snapshot.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { allGroupsLabel, renderBrowserPage } from '../../src/main/standard-widgets/browser-template'
import { createStandardWidget, operationSeams, previewStandardWidgetDraft, StandardWidgetUndoDesk, updateStandardWidgetRecipe } from '../../src/main/standard-widgets/operations'
import { createInPlace } from '../helpers/own-folder-answer'
import { parseRecipeText, type RecipeMap } from '../../src/main/standard-widgets/recipe'
import { listStandardWidgetSources } from '../../src/main/standard-widgets/source-files'
import { Workspace } from '../../src/main/workspace'

const FIXTURES = new URL('../fixtures/standard-widgets/', import.meta.url).pathname
const fixture = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8')
const COURSES = fixture('csv/courses.csv')

const roots: string[] = []
afterEach(() => {
  delete documentSaveSeams.betweenCheckAndWrite
  delete documentSaveSeams.afterStage
  delete operationSeams.afterSourceCheck
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wf-standard-widgets-authoring-')))
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
const pageData = (html: string): { records: Array<{ title: string; group: string | null }> } =>
  JSON.parse(/<script type="application\/json" id="wf-widget-data">([\s\S]*?)<\/script>/.exec(html)![1])
const browserRecipe = (): RecipeMap => {
  const parsed = parseRecipeText(fixture('recipes/browser-from-csv.widget.md'))
  if (!parsed.ok) throw new Error('fixture')
  const { widget_schema: _ignored, source, ...rest } = parsed.recipe
  void _ignored
  return { ...rest, title: 'Courses', source: { format: (source as RecipeMap).format } }
}
const essay = '# Essay\n\nOpening paragraph,\nstill the opening.\n\nClosing paragraph.\n'

describe('Preview before create: the page, nothing written', () => {
  test('a draft previews to the very bytes Create then writes, and the preview writes no file or folder', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES })
    const before = snapshot(root)
    const preview = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!preview.ok) throw new Error(preview.message)
    expect(preview.title).toBe('Courses')
    expect(pageData(preview.html).records.map((record) => record.title)).toEqual(['Prompting basics', 'Data, privacy and you', 'Evaluating sources', 'Café conversations — Zürich', 'Spreadsheet confidence'])
    // Not a byte written: no Folio manifest, no visualisations folder, no receipt.
    expect(snapshot(root)).toEqual(before)

    const created = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!created.ok) throw new Error(created.message)
    expect(readFileSync(join(root, created.outputPath), 'utf8')).toBe(preview.html)
  })

  test('edited source text stands in for the file: the preview shows it, the file keeps its text', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES })
    const before = snapshot(root)
    const edited = COURSES.replace('Prompting basics', 'Prompting, edited')
    const preview = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv', sourceText: edited })
    expect(preview.ok && pageData(preview.html).records[0].title).toBe('Prompting, edited')
    // An edit the adapter refuses is named, as a build names it; still nothing written.
    const broken = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv', sourceText: 'course_id,title\n001,"never closed\n' })
    expect(!broken.ok && broken.errors.map((error) => error.code)).toEqual(['csv-malformed'])
    expect(snapshot(root)).toEqual(before)
  })

  test('a source outside the document\'s folder, or reached through a link, is refused and never read', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'elsewhere/courses.csv': COURSES })
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.csv'), 'course_id,title,description\n1,Secret,Hidden\n')
    symlinkSync(join(outside, 'secret.csv'), join(root, 'notes/linked.csv'))
    const before = snapshot(root)
    const far = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', recipe: browserRecipe(), sourceFile: 'elsewhere/courses.csv' })
    expect(far).toMatchObject({ ok: false })
    expect(!far.ok && far.message).toContain('is outside notes')
    const linked = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', recipe: browserRecipe(), sourceFile: 'notes/linked.csv' })
    expect(!linked.ok && linked.errors.map((error) => error.code)).toEqual(['source-unreadable'])
    expect(JSON.stringify(linked)).not.toContain('Secret')
    expect(snapshot(root)).toEqual(before)
  })
})

describe('Preview authority: the real document, not the caller\'s recipe path', () => {
  test('a recipe path forged under another folder, or a document that is not there, is refused and returns no records', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES, 'private/data/secret.csv': COURSES.replace('Prompting basics', 'Secret course') })
    const before = snapshot(root)
    const forged = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', recipe: browserRecipe(), recipePath: 'private/visualisations/x/widget.md', sourceFile: 'private/data/secret.csv' })
    expect(forged).toMatchObject({ ok: false })
    expect(JSON.stringify(forged)).not.toContain('Secret')
    // A recipe outside the document's visualisations folder is refused even with the document's own source.
    const elsewhere = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', recipe: browserRecipe(), recipePath: 'private/visualisations/x/widget.md', sourceFile: 'notes/data/courses.csv' })
    expect(elsewhere).toMatchObject({ ok: false, message: "private/visualisations/x/widget.md is not one of notes/essay.md's widgets (they are in notes/visualisations)." })
    // The reviewer's form: neither named document exists.
    const ghost = await previewStandardWidgetDraft(ws, { documentPath: 'nowhere/ghost.md', recipe: browserRecipe(), recipePath: 'private/visualisations/x/widget.md', sourceFile: 'private/data/secret.csv' })
    expect(ghost).toMatchObject({ ok: false })
    expect(JSON.stringify(ghost)).not.toContain('Secret')
    const ghostNoRecipe = await previewStandardWidgetDraft(ws, { documentPath: 'private/ghost.md', recipe: browserRecipe(), sourceFile: 'private/data/secret.csv' })
    expect(ghostNoRecipe).toMatchObject({ ok: false })
    expect(JSON.stringify(ghostNoRecipe)).not.toContain('Secret')
    // The document's own widget still previews.
    const own = await previewStandardWidgetDraft(ws, { documentPath: 'notes/essay.md', recipe: browserRecipe(), recipePath: 'notes/visualisations/courses/widget.md', sourceFile: 'notes/data/courses.csv' })
    expect(own.ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })
})

describe('Source files: the CSV and JSON files a widget may read', () => {
  test('the Folio folder and below, nearest first; no links, no hidden folders, none of WriteFlex\'s own files', async () => {
    const { ws, root } = workspace({
      'report/_report-structure.json': '{ "schema_version": 1, "content_root": "", "files": [ { "path": "report.md" } ] }\n',
      'report/report.md': '# Report\n',
      'report/people.json': '[]\n',
      'report/data/courses.csv': COURSES,
      'report/data/notes.md': '# not data\n',
      'report/data/deep/a/b.json': '[]\n',
      'report/visualisations/old/widget.build.json': '{}\n',
      'report/visualisations/old/rows.csv': 'a\n1\n',
      'report/.cache/hidden.csv': 'a\n1\n',
      'elsewhere/outside.csv': 'a\n1\n',
    })
    const outside = tempDir()
    writeFileSync(join(outside, 'far.csv'), 'a\n1\n')
    mkdirSync(join(outside, 'folder'))
    writeFileSync(join(outside, 'folder/inner.csv'), 'a\n1\n')
    symlinkSync(join(outside, 'far.csv'), join(root, 'report/far.csv'))
    symlinkSync(join(outside, 'folder'), join(root, 'report/linked-folder'))
    symlinkSync(join(root, 'report/data/courses.csv'), join(root, 'report/inside-link.csv'))
    const listing = await listStandardWidgetSources(ws, 'report/report.md')
    expect(listing).toEqual({ ok: true, folder: 'report', truncated: false, files: ['report/people.json', 'report/data/courses.csv', 'report/visualisations/old/rows.csv', 'report/data/deep/a/b.json'] })
  })

  test('a document in no Folio lists its own folder; a folder reached through a link is refused', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/courses.csv': COURSES, 'real/essay.md': essay })
    expect(await listStandardWidgetSources(ws, 'notes/essay.md')).toEqual({ ok: true, folder: 'notes', truncated: false, files: ['notes/courses.csv'] })
    symlinkSync(join(root, 'notes'), join(root, 'via-link'))
    const refused = await listStandardWidgetSources(ws, 'via-link/essay.md')
    expect(refused.ok).toBe(false)
  })

  test('bounded: at most the files and entries asked for, and the answer says so', async () => {
    const files: Record<string, string> = { 'notes/essay.md': essay }
    for (let i = 0; i < 12; i += 1) files[`notes/d${String(i).padStart(2, '0')}.csv`] = 'a\n1\n'
    const { ws } = workspace(files)
    const few = await listStandardWidgetSources(ws, 'notes/essay.md', { maxFiles: 3 })
    expect(few).toEqual({ ok: true, folder: 'notes', truncated: true, files: ['notes/d00.csv', 'notes/d01.csv', 'notes/d02.csv'] })
    const glance = await listStandardWidgetSources(ws, 'notes/essay.md', { maxEntries: 5 })
    expect(glance.ok && glance.truncated).toBe(true)
    expect(glance.ok && glance.files.length).toBe(5)
    expect((await listStandardWidgetSources(ws, 'notes/essay.md')).ok && (await listStandardWidgetSources(ws, 'notes/essay.md') as { files: string[] }).files.length).toBe(12)
  })
})

describe('Editable source: saved by the guarded write, in the undoable step', () => {
  test('create with an edited source writes it, builds from it, and one undo puts the source back too', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES })
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const edited = COURSES.replace('Prompting basics', 'Prompting, edited')
    const created = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv', sourceEdit: { text: edited, basis: COURSES } })
    if (!created.ok) throw new Error(created.message)
    expect(readFileSync(join(root, 'notes/data/courses.csv'), 'utf8')).toBe(edited)
    expect(created.written).toContain('notes/data/courses.csv')
    expect(pageData(readFileSync(join(root, created.outputPath), 'utf8')).records[0].title).toBe('Prompting, edited')
    expect((await desk.undo(ws, created.undoId)).ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  test('update with an edited source rebuilds from it; undo puts the source and page back', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES })
    const desk = new StandardWidgetUndoDesk()
    const created = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!created.ok) throw new Error(created.message)
    const before = snapshot(root)
    const recipeText = readFileSync(join(root, created.recipePath), 'utf8')
    const edited = COURSES.replace('Spreadsheet confidence', 'Spreadsheets edited')
    const updated = await updateStandardWidgetRecipe(ws, desk, { recipePath: created.recipePath, patch: {}, basis: recipeText, sourceEdit: { text: edited, basis: COURSES } })
    if (!updated.ok) throw new Error(updated.message)
    // The recipe did not change, so it is not rewritten; the source and the page are.
    expect(updated.written).not.toContain(created.recipePath)
    expect(updated.written).toContain('notes/data/courses.csv')
    expect(pageData(readFileSync(join(root, created.outputPath), 'utf8')).records.at(-1)!.title).toBe('Spreadsheets edited')
    expect((await desk.undo(ws, updated.undoId)).ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  test('refused before any write: a source changed since it was read, one that is a link, one that is not CSV or JSON, empty text', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES, 'notes/data/table.txt': COURSES })
    const outside = tempDir()
    writeFileSync(join(outside, 'far.csv'), COURSES)
    symlinkSync(join(outside, 'far.csv'), join(root, 'notes/data/far.csv'))
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const make = (sourceFile: string, text: string, basis: string) => createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile, sourceEdit: { text, basis } })
    expect(await make('notes/data/courses.csv', `${COURSES}x`, 'what the caller read before someone else saved')).toMatchObject({ ok: false, message: 'notes/data/courses.csv changed since it was read; nothing was written.' })
    expect(await make('notes/data/far.csv', `${COURSES}\n`, COURSES)).toMatchObject({ ok: false })
    expect(await make('notes/data/table.txt', `${COURSES}\n`, COURSES)).toMatchObject({ ok: false, message: 'notes/data/table.txt is not a CSV or JSON file, so WriteFlex does not edit it here.' })
    expect(await make('notes/data/courses.csv', '  \n', COURSES)).toMatchObject({ ok: false, message: 'The source is empty, so it was not saved. Nothing was written.' })
    expect(snapshot(root)).toEqual(before)
    expect(readFileSync(join(outside, 'far.csv'), 'utf8')).toBe(COURSES)
  })

  test('the source swapped for a link to outside between the guarded write\'s check and its write: nothing outside changes, the step is put back', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES })
    const outside = tempDir()
    writeFileSync(join(outside, 'far.csv'), 'outside\n')
    const before = snapshot(root)
    let swapped = false
    documentSaveSeams.betweenCheckAndWrite = async (path) => {
      if (swapped || !path.endsWith('courses.csv')) return
      unlinkSync(join(root, 'notes/data/courses.csv'))
      symlinkSync(join(outside, 'far.csv'), join(root, 'notes/data/courses.csv'))
      swapped = true
    }
    const result = await createInPlace(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv', sourceEdit: { text: COURSES.replace('Prompting', 'Edited'), basis: COURSES } })
    expect(swapped).toBe(true)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(outside, 'far.csv'), 'utf8')).toBe('outside\n')
    const after = snapshot(root)
    expect(after['notes/essay.md']).toBe(before['notes/essay.md'])
    expect(after['notes/data/courses.csv']).toBe('link')
    expect(Object.keys(after).some((path) => path.startsWith('notes/visualisations') || path === 'notes/_report-structure.json')).toBe(false)
  })
})

describe('Editable source: the write lands only in the folder that was checked', () => {
  const manifest = (part: string): string => `${JSON.stringify({ schema_version: 1, content_root: '', files: [{ path: part, role: 'section' }] }, null, 2)}\n`
  /** Two Folios; the other holds a source with the same text, so a write through a link would pass its basis check. */
  async function twoFolios() {
    const { ws, root } = workspace({
      'notes/_report-structure.json': manifest('essay.md'), 'notes/essay.md': essay, 'notes/data/courses.csv': COURSES,
      'other/_report-structure.json': manifest('paper.md'), 'other/paper.md': '# Paper\n', 'other/data/courses.csv': COURSES,
    })
    const desk = new StandardWidgetUndoDesk()
    const created = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!created.ok) throw new Error(created.message)
    return { ws, root, desk, created, recipeText: readFileSync(join(root, created.recipePath), 'utf8') }
  }
  const linkToOther = (root: string): void => {
    renameSync(join(root, 'notes/data'), join(root, 'notes/data-moved'))
    symlinkSync(join(root, 'other/data'), join(root, 'notes/data'))
  }

  test('the source\'s folder swapped for a link to another Folio\'s folder after the check: refused, the other file never written', async () => {
    const { ws, root, desk, created, recipeText } = await twoFolios()
    let swapped = false
    operationSeams.afterSourceCheck = () => { linkToOther(root); swapped = true }
    const edited = COURSES.replace('Prompting basics', 'Written through a link')
    const result = await updateStandardWidgetRecipe(ws, desk, { recipePath: created.recipePath, patch: {}, basis: recipeText, sourceEdit: { text: edited, basis: COURSES } })
    expect(swapped).toBe(true)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(root, 'other/data/courses.csv'), 'utf8')).toBe(COURSES)
    expect(readFileSync(join(root, 'notes/data-moved/courses.csv'), 'utf8')).toBe(COURSES)
  })

  test('swapped for the link and back again before the commit: still refused, the other file never written', async () => {
    const { ws, root, desk, created, recipeText } = await twoFolios()
    let back = false
    operationSeams.afterSourceCheck = () => linkToOther(root)
    // Back after the guarded write staged its bytes in the folder it judged (the other Folio's, through the link).
    documentSaveSeams.afterStage = async (path) => {
      if (back || !path.endsWith('courses.csv')) return
      unlinkSync(join(root, 'notes/data'))
      renameSync(join(root, 'notes/data-moved'), join(root, 'notes/data'))
      back = true
    }
    const edited = COURSES.replace('Prompting basics', 'Written through a link')
    const result = await updateStandardWidgetRecipe(ws, desk, { recipePath: created.recipePath, patch: {}, basis: recipeText, sourceEdit: { text: edited, basis: COURSES } })
    expect(back).toBe(true)
    expect(result.ok).toBe(false)
    expect(readFileSync(join(root, 'other/data/courses.csv'), 'utf8')).toBe(COURSES)
    expect(readFileSync(join(root, 'notes/data/courses.csv'), 'utf8')).toBe(COURSES)
  })
})

describe('Insert at the caret: the line, checked against the document basis', () => {
  test('a caret line puts the embed after that line\'s paragraph; a blank line takes it there', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/courses.csv': COURSES })
    const desk = new StandardWidgetUndoDesk()
    const created = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/courses.csv', position: { line: 3 }, documentBasis: essay })
    if (!created.ok) throw new Error(created.message)
    expect(readFileSync(join(root, 'notes/essay.md'), 'utf8')).toBe('# Essay\n\nOpening paragraph,\nstill the opening.\n\n[Simulation: visualisations/courses/widget.html]\n\nClosing paragraph.\n')
    expect((await desk.undo(ws, created.undoId)).ok).toBe(true)
    const atTitle = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/courses.csv', position: { line: 1 }, documentBasis: essay })
    expect(atTitle.ok && atTitle.documentText).toBe('# Essay\n\n[Simulation: visualisations/courses/widget.html]\n\nOpening paragraph,\nstill the opening.\n\nClosing paragraph.\n')
  })

  test('a line the basis does not have, or a line with no basis, is refused and nothing is written', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/courses.csv': COURSES })
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const at = (position: { line: number }, documentBasis?: string) => createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'notes/courses.csv', position, documentBasis })
    expect(await at({ line: 7 }, essay)).toMatchObject({ ok: false, message: 'There is no line 7 in notes/essay.md; it has 6. Nothing was written.' })
    expect(await at({ line: 0 }, essay)).toMatchObject({ ok: false })
    expect(await at({ line: 2.5 }, essay)).toMatchObject({ ok: false })
    expect(await at({ line: 2 })).toMatchObject({ ok: false, message: 'A widget placed at a line needs the document text that line was counted in; nothing was written.' })
    expect(snapshot(root)).toEqual(before)
  })
})

describe('The group filter\'s own option', () => {
  test('reads "All groups", and never the name of a group in the data', () => {
    expect(allGroupsLabel(['Staff', 'All'])).toBe('All groups')
    expect(allGroupsLabel(['all groups', 'Staff'])).toBe('Every group')
    const page = renderBrowserPage({ title: 'T', views: ['browser'], groupLabel: 'audience', records: [{ id: '1', title: 'a', group: 'All', detail: '', search: 'a' }, { id: '2', title: 'b', group: 'Staff', detail: '', search: 'b' }] })
    const options = [...page.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((match) => [match[1], match[2]])
    expect(options).toEqual([['', 'All groups'], ['All', 'All'], ['Staff', 'Staff']])
  })
})
