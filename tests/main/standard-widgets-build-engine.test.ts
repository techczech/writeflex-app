/**
 * The record browser's build engine (ticket 04a) at its seams, on the shared fixtures
 * (tests/fixtures/standard-widgets/, contracts.md):
 *   - recipe reading and writing (the nested frontmatter subset, C2) and the recipe check;
 *   - the CSV and JSON adapters, whose output must equal the fixtures' expected files and expected errors;
 *   - the build: same inputs give the same bytes, one edited source value changes one record, a hand-edited page
 *     is kept, a failed build keeps the last good page, and sources outside the Folio or behind a link are refused;
 *   - create and insert: a document in no Folio becomes one silently, and one undo puts every byte back.
 * Production code only: the test-only reference reader is not used here.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseManifest } from '../../src/main/folio'
import { folioContaining } from '../../src/main/folio-place'
import { parseNestedFrontmatter } from '../../src/main/frontmatter'
import { readCsvRecords, readJsonRecords, type RecordRead } from '../../src/main/standard-widgets/adapters'
import { buildStandardWidget } from '../../src/main/standard-widgets/build'
import { BUILD_ERROR_CODES, severityOf } from '../../src/main/standard-widgets/build-errors'
import { createStandardWidget, StandardWidgetUndoDesk, updateStandardWidgetRecipe } from '../../src/main/standard-widgets/operations'
import { createInPlace } from '../helpers/own-folder-answer'
import { checkRecipe, declaredTypes, mappedFields, parseRecipeText, recipeText, RecipeWriteRefused, updatedRecipeText, type RecipeMap } from '../../src/main/standard-widgets/recipe'
import { checkWidgetHtml } from '../../src/main/widget-create'
import { Workspace } from '../../src/main/workspace'
import { toHtml } from '../../src/shared/markdown/to-html'
import { WIDGET_SANDBOX } from '../../src/shared/widget-document'

const FIXTURES = new URL('../fixtures/standard-widgets/', import.meta.url).pathname
const fixture = (path: string): string => readFileSync(join(FIXTURES, path), 'utf8')
const json = <T = any>(path: string): T => JSON.parse(fixture(path)) as T
const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

function recipe(path: string): RecipeMap {
  const parsed = parseRecipeText(fixture(path))
  if (!parsed.ok) throw new Error(`${path}: ${JSON.stringify(parsed.errors)}`)
  return parsed.recipe
}
const optionsOf = (r: RecipeMap) => ({ idField: (r.mapping as RecipeMap).id as string | undefined, types: declaredTypes(r), mapped: mappedFields(r) })
const errorsOf = (result: RecordRead) => (result.ok ? [] : result.errors)

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function workspace(files: Record<string, string>): { ws: Workspace; root: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wf-standard-widgets-')))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return { ws: new Workspace(root), root }
}
/** Every file (with its bytes) and every folder under `root`: the state an undo must restore exactly. */
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
/** The data a built page carries. */
const pageData = (html: string): { v: number; views: string[]; records: Array<Record<string, unknown>> } =>
  JSON.parse(/<script type="application\/json" id="wf-widget-data">([\s\S]*?)<\/script>/.exec(html)![1])

// ------------------------------------------------------------------------------------------------ recipes

describe('Recipes: the nested frontmatter subset and the recipe check', () => {
  test('every fixture recipe reads with the nested subset; the browser recipes pass the check', () => {
    for (const name of readdirSync(join(FIXTURES, 'recipes'))) expect(parseRecipeText(fixture(`recipes/${name}`)).ok).toBe(true)
    const csv = recipe('recipes/browser-from-csv.widget.md')
    expect(csv).toEqual({
      widget_schema: 1, template: 'browser', template_version: 1, title: 'Courses to browse (CSV)',
      source: { path: '../csv/courses.csv', format: 'csv' },
      mapping: { id: 'course_id', title: 'title', detail: 'description', group: 'audience' }, views: ['browser', 'list'],
    })
    expect(checkRecipe(csv)).toEqual([])
    expect(checkRecipe(recipe('recipes/browser-from-json.widget.md'))).toEqual([])
    expect(recipe('recipes/course-json.widget.md').mapping).toEqual({ id: '/id', title: '/title', columns: ['/title', '/audience', '/hours', '/places', '/provider/name'], types: { '/hours': 'number', '/places': 'number' } })
  })

  test('each malformed recipe fixture yields exactly its named errors', () => {
    const cases = json<{ cases: Array<{ fixture: string; errors: unknown[] }> }>('fixture-errors.expected.json').cases.filter((c) => c.fixture.startsWith('recipes/'))
    expect(cases.length).toBe(4)
    for (const c of cases) {
      const parsed = parseRecipeText(fixture(c.fixture))
      expect(parsed.ok ? checkRecipe(parsed.recipe) : parsed.errors).toEqual(c.errors as never)
    }
  })

  test('what the subset refuses is recipe-unreadable with its line, never a guess', () => {
    const read = (body: string) => parseRecipeText(`---\n${body}\n---\n`)
    expect(read('source:\n\tpath: a.csv')).toEqual({ ok: false, errors: [{ code: 'recipe-unreadable', line: 3, detail: 'indented with a tab' }] })
    expect(read('source:\n   path: a.csv')).toEqual({ ok: false, errors: [{ code: 'recipe-unreadable', line: 3, detail: 'indented by an odd number of spaces' }] })
    expect(read('title: a\ntitle: b')).toEqual({ ok: false, errors: [{ code: 'recipe-unreadable', line: 3, detail: 'the key title is written twice' }] })
    expect(read('views:\n  - browser')).toMatchObject({ ok: false, errors: [{ code: 'recipe-unreadable', line: 3 }] })
    expect(read('a:\n  b:\n    c:\n      d: 1')).toMatchObject({ ok: false, errors: [{ code: 'recipe-unreadable', line: 4 }] })
    expect(read('title: a\n  stray: b')).toMatchObject({ ok: false, errors: [{ code: 'recipe-unreadable', line: 3 }] })
    expect(parseRecipeText('no frontmatter here')).toMatchObject({ ok: false, errors: [{ code: 'recipe-unreadable' }] })
    // The flat organ's reader is unchanged by the nested one: indented keys still read raw there.
    expect(parseNestedFrontmatter('---\nmapping:\n  types:\n    Hours: number\n---\n')).toMatchObject({ ok: true, value: { mapping: { types: { Hours: 'number' } } } })
  })

  test('a written recipe reads back as written; an update changes only the keys it names', () => {
    const r: RecipeMap = { widget_schema: 1, template: 'browser', template_version: 1, title: 'Codes: 2026 "draft"', source: { path: '../../data/a.csv', format: 'csv' }, mapping: { id: '001', title: 'title', detail: 'notes' }, views: ['browser'] }
    const text = recipeText(r, 'Intro.\n')
    expect(parseRecipeText(text)).toEqual({ ok: true, recipe: r, body: 'Intro.\n' })
    // The catalogue recipe keeps its unknown key, its body and every untouched line.
    const original = fixture('recipes/course-catalogue.widget.md')
    const updated = updatedRecipeText(original, { title: 'Courses', views: ['table'], chart: null, initial: { view: 'table' } })
    const back = parseRecipeText(updated)
    expect(back.ok && back.recipe.x_author_note).toBe('kept by every recipe writer')
    expect(back.ok && back.body).toBe(parseRecipeText(original).ok && (parseRecipeText(original) as { body: string }).body)
    expect(back.ok && [back.recipe.title, back.recipe.views, 'chart' in back.recipe, back.recipe.initial]).toEqual(['Courses', ['table'], false, { view: 'table' }])
    const kept = original.split('\n').filter((line) => !/^(title|views|chart|  category|  metric):/.test(line))
    for (const line of kept) expect(updated.split('\n')).toContain(line)
    // Values the format cannot carry are refused, not written approximately.
    expect(() => recipeText({ ...r, title: 'two\nlines' })).toThrow(RecipeWriteRefused)
    expect(() => recipeText({ ...r, views: ['a, b'] })).toThrow(RecipeWriteRefused)
    expect(() => recipeText({ ...r, template_version: 1.5 })).toThrow(RecipeWriteRefused)
  })
})

// ------------------------------------------------------------------------------------------------ adapters

describe('Adapters: output equals the expected fixture files', () => {
  const pick = (set: Record<string, unknown>) => Object.fromEntries(['source', 'selection', 'fields', 'records'].map((key) => [key, set[key]]))

  test('csv/courses.csv read with the catalogue recipe equals csv/courses.expected.json', () => {
    const expected = json('csv/courses.expected.json')
    const r = recipe('recipes/course-catalogue.widget.md')
    expect(join('recipes', (r.source as RecipeMap).path as string)).toBe(join('recipes', '..', expected.source.path))
    const result = readCsvRecords(expected.source.path, fixture('csv/courses.csv'), optionsOf(r))
    expect(errorsOf(result)).toEqual([])
    expect(result.ok && pick(result.value as never)).toEqual(pick(expected))
  })

  test('json/courses.json read with the JSON recipe equals json/courses.expected.json', () => {
    const expected = json('json/courses.expected.json')
    const r = recipe('recipes/course-json.widget.md')
    expect((r.source as RecipeMap).select).toEqual(expected.selection)
    const result = readJsonRecords(expected.source.path, fixture('json/courses.json'), expected.selection, optionsOf(r))
    expect(errorsOf(result)).toEqual([])
    expect(result.ok && pick(result.value as never)).toEqual(pick(expected))
  })

  test('the browser recipes read the same records: ids, values and locators as expected', () => {
    for (const [recipePath, expectedPath] of [['recipes/browser-from-csv.widget.md', 'csv/courses.expected.json'], ['recipes/browser-from-json.widget.md', 'json/courses.expected.json']]) {
      const expected = json(expectedPath)
      const r = recipe(recipePath)
      const text = fixture(expected.source.path)
      const result = expected.source.format === 'csv'
        ? readCsvRecords(expected.source.path, text, optionsOf(r))
        : readJsonRecords(expected.source.path, text, (r.source as RecipeMap).select as { pointer: string }, optionsOf(r))
      expect(errorsOf(result)).toEqual([])
      const records = result.ok ? result.value.records : []
      expect(records.map(({ id, id_origin, locator, values }) => ({ id, id_origin, locator, values }))).toEqual(expected.records.map(({ id, id_origin, locator, values }: any) => ({ id, id_origin, locator, values })))
    }
  })

  test('the root-array JSON source reads with the empty pointer', () => {
    const result = readJsonRecords('json/courses-root-array.json', fixture('json/courses-root-array.json'), { pointer: '' }, { idField: '/id' })
    expect(result.ok && result.value.records.map((record) => [record.id, record.locator])).toEqual([['001', { pointer: '/0', line: 2 }], ['002', { pointer: '/1', line: 3 }]])
  })

  test('every malformed CSV and JSON fixture yields exactly its named errors', () => {
    type Case = { fixture: string; recipe?: string; selection?: { pointer: string }; id_field?: string; errors: unknown[] }
    const cases = json<{ cases: Case[] }>('fixture-errors.expected.json').cases.filter((c) => c.fixture.startsWith('csv/') || c.fixture.startsWith('json/'))
    expect(cases.length).toBe(13)
    for (const c of cases) {
      const options = c.recipe ? optionsOf(recipe(c.recipe)) : { idField: c.id_field }
      const result = c.fixture.endsWith('.csv') ? readCsvRecords(c.fixture, fixture(c.fixture), options) : readJsonRecords(c.fixture, fixture(c.fixture), c.selection!, options)
      expect({ fixture: c.fixture, errors: errorsOf(result) }).toEqual({ fixture: c.fixture, errors: c.errors as never })
    }
  })

  test('every code the build can name is in the closed list with its severity', () => {
    const codes = json<{ codes: Record<string, { severity: string }> }>('build-error-codes.json').codes
    expect([...BUILD_ERROR_CODES].sort()).toEqual(Object.keys(codes).sort())
    for (const [code, entry] of Object.entries(codes)) expect(severityOf(code)).toBe(entry.severity as never)
  })
})

// ------------------------------------------------------------------------------------------------ build

/** A Folio with the fixture sources and the browser recipe at report/visualisations/courses/widget.md. */
function folioWithBrowser(recipeFixture: string): { ws: Workspace; root: string; recipePath: string } {
  const text = fixture(recipeFixture).replace('path: ../csv/', 'path: ../../csv/').replace('path: ../json/', 'path: ../../json/')
  const { ws, root } = workspace({
    'report/_report-structure.json': JSON.stringify({ schema_version: 1, files: [{ path: 'report.md', role: 'section' }] }),
    'report/report.md': '# Report\n',
    'report/csv/courses.csv': fixture('csv/courses.csv'),
    'report/json/courses.json': fixture('json/courses.json'),
    'report/visualisations/courses/widget.md': text,
  })
  return { ws, root, recipePath: 'report/visualisations/courses/widget.md' }
}
/** A one-paragraph detail as the app's own Markdown renderer writes it. */
const paragraph = (text: string): string => toHtml(text, { links: 'external-only' }).html
const clock = (iso: string) => ({ now: () => new Date(iso) })

describe('Build: recipe + source → widget.html and widget.build.json', () => {
  test('a browser from CSV carries every record, only its mapped fields, in source order', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const outcome = await buildStandardWidget(ws, recipePath, clock('2026-10-19T21:00:00.123Z'))
    expect(outcome.errors).toEqual([])
    expect(outcome.result).toBe('built')
    const html = readFileSync(join(root, 'report/visualisations/courses/widget.html'), 'utf8')
    const expected = json('csv/courses.expected.json').records as Array<{ id: string; values: Record<string, string> }>
    const data = pageData(html)
    expect(data.records.map((record) => [record.id, record.title, record.group])).toEqual(expected.map((record) => [record.id, record.values.title, record.values.audience]))
    expect(Object.keys(data.records[0]).sort()).toEqual(['detail', 'group', 'id', 'search', 'title'])
    expect(html).not.toContain('Training Unit') // provider is not mapped, so it is not in the page
    // Detail is the app's safe Markdown: the script-looking cell is text, and a quoted newline stays one value.
    expect(data.records[4].detail).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert(1)')
    expect(data.records[2].search).toContain('Line one of the description.\nLine two, after a quoted newline.')
    const receipt = JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8'))
    expect(receipt).toMatchObject({
      widget_schema: 1, template: 'browser', template_version: 1, recipe_sha256: sha256(readFileSync(join(root, recipePath))),
      inputs: [{ path: '../../csv/courses.csv', sha256: sha256(fixture('csv/courses.csv')) }],
      output_sha256: sha256(html), built_at: '2026-10-19T21:00:00Z', result: 'built', errors: [], states: [], resources: [],
    })
    expect(receipt.template_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a browser from a JSON array reads the selected array by pointer', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-json.widget.md')
    expect((await buildStandardWidget(ws, recipePath)).result).toBe('built')
    const data = pageData(readFileSync(join(root, 'report/visualisations/courses/widget.html'), 'utf8'))
    expect(data.records.map((record) => [record.id, record.title, record.detail])).toEqual([
      ['001', 'Prompting basics', paragraph('Staff')], ['002', 'Data, privacy and you', paragraph('All')],
      ['011', 'Café conversations — Zürich', paragraph('Researchers')], ['120', 'Spreadsheet confidence', paragraph('Staff')],
    ])
    expect(data.views).toEqual(['browser'])
  })

  test('the same inputs give byte-identical pages; the build time is in the receipt only', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const page = join(root, 'report/visualisations/courses/widget.html')
    await buildStandardWidget(ws, recipePath, clock('2026-10-19T21:00:00Z'))
    const first = readFileSync(page)
    await buildStandardWidget(ws, recipePath, clock('2026-10-20T09:30:00Z'))
    expect(readFileSync(page).equals(first)).toBe(true)
    // A second workspace, built at another time, makes the same bytes too.
    const other = folioWithBrowser('recipes/browser-from-csv.widget.md')
    await buildStandardWidget(other.ws, other.recipePath, clock('2030-01-01T00:00:00Z'))
    expect(readFileSync(join(other.root, 'report/visualisations/courses/widget.html')).equals(first)).toBe(true)
    expect(JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8')).built_at).toBe('2026-10-20T09:30:00Z')
  })

  test('editing one mapped source value changes only that record', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const page = join(root, 'report/visualisations/courses/widget.html')
    await buildStandardWidget(ws, recipePath)
    const before = readFileSync(page, 'utf8')
    const csv = join(root, 'report/csv/courses.csv')
    writeFileSync(csv, readFileSync(csv, 'utf8').replace('Evaluating sources', 'Evaluating evidence'))
    expect((await buildStandardWidget(ws, recipePath)).result).toBe('built')
    const after = readFileSync(page, 'utf8')
    const [a, b] = [pageData(before).records, pageData(after).records]
    expect(b.length).toBe(a.length)
    const changed = a.map((record, index) => JSON.stringify(record) !== JSON.stringify(b[index]) ? record.id : null).filter(Boolean)
    expect(changed).toEqual(['010'])
    expect(b[2].title).toBe('Evaluating evidence')
    const outside = (html: string) => html.replace(/<script type="application\/json" id="wf-widget-data">[\s\S]*?<\/script>/, '')
    expect(outside(after)).toBe(outside(before))
  })

  test('a hand-edited page is kept and the rebuild goes to widget.rebuilt.html', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const page = join(root, 'report/visualisations/courses/widget.html')
    await buildStandardWidget(ws, recipePath)
    const edited = readFileSync(page, 'utf8').replace('<title>', '<title>Edited by hand: ')
    writeFileSync(page, edited)
    const outcome = await buildStandardWidget(ws, recipePath)
    expect(outcome.result).toBe('kept-hand-edit')
    expect(outcome.errors.map((error) => [error.code, error.severity])).toEqual([['output-hand-edited', 'warning']])
    expect(readFileSync(page, 'utf8')).toBe(edited)
    const rebuilt = readFileSync(join(root, 'report/visualisations/courses/widget.rebuilt.html'), 'utf8')
    expect(rebuilt).not.toContain('Edited by hand')
    expect(JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8')).output_sha256).toBe(sha256(rebuilt))
    // Still kept on the next build.
    expect((await buildStandardWidget(ws, recipePath)).result).toBe('kept-hand-edit')
    expect(readFileSync(page, 'utf8')).toBe(edited)
  })

  test('a failed build keeps the last good page and names every error in the receipt', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const page = join(root, 'report/visualisations/courses/widget.html')
    await buildStandardWidget(ws, recipePath)
    const good = readFileSync(page, 'utf8')
    writeFileSync(join(root, 'report/csv/courses.csv'), 'course_id,title,audience,description\n001,A,Staff,x\n001,B,Staff,y\n')
    const outcome = await buildStandardWidget(ws, recipePath)
    expect(outcome.result).toBe('failed')
    expect(outcome.errors).toEqual([{
      code: 'id-duplicate', severity: 'error', source: { path: 'report/csv/courses.csv', line: 3, record: 2, field: 'course_id' }, value: '001', first_line: 2,
      message: 'Two records have the same id (“001”) (report/csv/courses.csv, line 3, record 2, field course_id).',
    }])
    expect(readFileSync(page, 'utf8')).toBe(good)
    const receipt = JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8'))
    expect([receipt.result, receipt.output_sha256, receipt.errors.map((error: { code: string }) => error.code)]).toEqual(['failed', sha256(good), ['id-duplicate']])
  })

  test('a source outside the Folio folder, or reached through a link, is refused and never read', async () => {
    const cases: Array<[string, string]> = [
      ['../../../outside.csv', 'source-outside'],
      ['/etc/hosts', 'source-outside'],
      ['../../.hidden/courses.csv', 'source-outside'],
      ['../../linked-file.csv', 'source-unreadable'],
      ['../../linked-folder/courses.csv', 'source-unreadable'],
      ['../../inner-link.csv', 'source-unreadable'],
      ['../../missing.csv', 'source-missing'],
    ]
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const secret = 'course_id,title,audience,description\n999,SECRET,Staff,leaked\n'
    writeFileSync(join(root, 'outside.csv'), secret)
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'elsewhere/courses.csv'), secret)
    mkdirSync(join(root, 'report/.hidden'))
    writeFileSync(join(root, 'report/.hidden/courses.csv'), secret)
    symlinkSync(join(root, 'outside.csv'), join(root, 'report/linked-file.csv'))
    symlinkSync(join(root, 'elsewhere'), join(root, 'report/linked-folder'))
    symlinkSync(join(root, 'report/csv/courses.csv'), join(root, 'report/inner-link.csv')) // a link that stays inside is refused too
    const original = readFileSync(join(root, recipePath), 'utf8')
    for (const [path, code] of cases) {
      writeFileSync(join(root, recipePath), original.replace('../../csv/courses.csv', path))
      const outcome = await buildStandardWidget(ws, recipePath)
      expect({ path, result: outcome.result, codes: outcome.errors.map((error) => error.code) }).toEqual({ path, result: 'failed', codes: [code] })
      expect(existsSync(join(root, 'report/visualisations/courses/widget.html'))).toBe(false)
    }
  })

  test('a declared resource source passes the Folio containment checks; a linked or undeclared one is refused', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    const manifest = (items: unknown[]) => writeFileSync(join(root, 'report/_report-structure.json'), JSON.stringify({ schema_version: 1, files: [{ path: 'report.md' }], resources: { version: 1, items } }))
    mkdirSync(join(root, 'report/resources'))
    cpSync(join(root, 'report/csv/courses.csv'), join(root, 'report/resources/courses.csv'))
    symlinkSync(join(root, 'report/csv/courses.csv'), join(root, 'report/resources/linked.csv'))
    const original = readFileSync(join(root, recipePath), 'utf8')
    writeFileSync(join(root, recipePath), original.replace('path: ../../csv/courses.csv', 'resource: courses'))
    const codes = async () => (await buildStandardWidget(ws, recipePath)).errors.map((error) => error.code)
    manifest([{ id: 'courses', path: 'resources/courses.csv', inclusion: 'copy' }])
    expect(await codes()).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8')).inputs).toEqual([{ resource: 'courses', sha256: sha256(fixture('csv/courses.csv')) }])
    manifest([{ id: 'courses', path: 'resources/linked.csv', inclusion: 'copy' }])
    expect(await codes()).toEqual(['resource-link-refused'])
    manifest([{ id: 'courses', path: '../outside.csv', inclusion: 'copy' }])
    expect(await codes()).toEqual(['resource-outside'])
    manifest([{ id: 'courses', path: 'resources/courses.csv', inclusion: 'copy', origin: '/tmp/example-author/courses.csv' }])
    expect(await codes()).toEqual(['resource-declaration-invalid'])
    manifest([])
    expect(await codes()).toEqual(['resource-id-unknown'])
  })

  test('the receipt lists the declared resources the records link to (informational, §8.1); an undeclared resource value is named', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    writeFileSync(join(root, 'report/_report-structure.json'), JSON.stringify({ schema_version: 1, files: [{ path: 'report.md' }], resources: { version: 1, items: [
      { id: 'policy', path: 'resources/policy.md', inclusion: 'in-place' }, { id: 'notice', path: 'resources/notice.md', inclusion: 'in-place' },
    ] } }))
    writeFileSync(join(root, 'report/csv/courses.csv'), [
      'course_id,title,audience,description,evidence',
      '001,A,Staff,"See [the policy](../resources/policy.md#scope) and [the web](https://example.org).",',
      '002,B,Staff,"Written as code: `[notice](../resources/notice.md)`, and [bad](bad%QZ).",notice',
      '',
    ].join('\n'))
    expect((await buildStandardWidget(ws, recipePath)).errors).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8')).resources).toEqual(['policy'])
    const html = readFileSync(join(root, 'report/visualisations/courses/widget.html'), 'utf8')
    expect(pageData(html).records[0].detail).toContain('href="https://example.org"')
    expect(pageData(html).records[0].detail).not.toContain('resources/policy.md')
    writeFileSync(join(root, recipePath), readFileSync(join(root, recipePath), 'utf8').replace('  group: audience\n', '  group: audience\n  resource: evidence\n'))
    expect((await buildStandardWidget(ws, recipePath)).errors).toEqual([])
    expect(JSON.parse(readFileSync(join(root, 'report/visualisations/courses/widget.build.json'), 'utf8')).resources).toEqual(['notice', 'policy'])
    writeFileSync(join(root, 'report/csv/courses.csv'), readFileSync(join(root, 'report/csv/courses.csv'), 'utf8').replace(',notice', ',not-declared'))
    expect((await buildStandardWidget(ws, recipePath)).errors.map((error) => [error.code, error.source.line, error.source.record, error.value])).toEqual([['resource-id-unknown', 3, 2, 'not-declared']])
  })

  test('the page is a sealed-frame widget: one self-contained file, no network, the frame sandbox unchanged', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    await buildStandardWidget(ws, recipePath)
    const html = readFileSync(join(root, 'report/visualisations/courses/widget.html'), 'utf8')
    expect(checkWidgetHtml(html, null)).toEqual({ ok: true, html })
    expect(html).toMatch(/<title>Courses to browse \(CSV\)<\/title>/)
    expect(html).not.toMatch(/\b(?:src|href)\s*=/i)
    expect(Buffer.byteLength(html)).toBeLessThan(64 * 1024)
    expect([...WIDGET_SANDBOX]).toEqual(['allow-scripts', 'allow-forms'])
  })

  test('templates and sources this version does not build are named, not attempted', async () => {
    const { ws, root, recipePath } = folioWithBrowser('recipes/browser-from-csv.widget.md')
    writeFileSync(join(root, recipePath), fixture('recipes/course-catalogue.widget.md').replace('../csv/', '../../csv/'))
    expect((await buildStandardWidget(ws, recipePath)).errors.map((error) => error.code)).toEqual(['recipe-unknown-template'])
    writeFileSync(join(root, recipePath), fixture('recipes/invalid-unknown-template.widget.md'))
    expect((await buildStandardWidget(ws, recipePath)).errors.map((error) => [error.code, error.value])).toEqual([['recipe-unknown-template', 'spreadsheet']])
  })
})

// ------------------------------------------------------------------------------------------------ create, convert, undo

describe('Create and insert: a single document becomes a Folio silently, and one undo restores it', () => {
  const essay = '---\ntitle: Essay\n---\n# Essay\n\nOpening paragraph.\n\nClosing paragraph.\n'
  const browserRecipe = (): RecipeMap => {
    const { widget_schema: _ignored, source, ...rest } = recipe('recipes/browser-from-csv.widget.md')
    void _ignored
    return { ...rest, source: { format: (source as RecipeMap).format } }
  }

  test('a document in no Folio whose folder holds other files: refused without the own-folder sheet\'s answer, nothing written', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/other.md': '# Other\n', 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    const result = await createStandardWidget(ws, new StandardWidgetUndoDesk(), { documentPath: 'notes/essay.md', name: 'Course browser', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    expect(result).toMatchObject({ ok: false, code: 'placement-required', message: 'notes holds other files, so WriteFlex asks first which documents go with the widget. Nothing was written.' })
    expect(snapshot(root)).toEqual(before)
  })

  test('a lone document in no Folio: its folder becomes a Folio in place; text and location stay; undo puts every byte back', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/data/courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    expect(await folioContaining(ws, 'notes/essay.md')).toBeNull()
    const desk = new StandardWidgetUndoDesk()
    const result = await createStandardWidget(ws, desk, { documentPath: 'notes/essay.md', name: 'Course browser', recipe: browserRecipe(), sourceFile: 'notes/data/courses.csv' })
    if (!result.ok) throw new Error(result.message)
    expect(result.folio).toEqual({ dir: 'notes', created: true })
    expect(result.recipePath).toBe('notes/visualisations/course-browser/widget.md')
    // The document is where it was, with its text unchanged apart from the one embed line.
    const text = readFileSync(join(root, 'notes/essay.md'), 'utf8')
    expect(text).toBe(`${essay}\n[Simulation: visualisations/course-browser/widget.html]\n`)
    expect(result.documentText).toBe(text)
    // The folder is a Folio whose one part is this document.
    expect(parseManifest('notes', readFileSync(join(root, 'notes/_report-structure.json'), 'utf8'))?.files).toEqual([{ path: 'essay.md', role: 'section' }])
    expect(await folioContaining(ws, 'notes/essay.md')).toEqual({ dir: 'notes', pieces: ['notes/essay.md'], frontMatter: new Set(), manifest: true })
    expect(existsSync(join(root, 'notes/AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, 'notes/CLAUDE.md'))).toBe(true)
    // The recipe names its source relative to itself, and the widget was built.
    expect(parseRecipeText(readFileSync(join(root, result.recipePath), 'utf8'))).toMatchObject({ ok: true, recipe: { widget_schema: 1, source: { path: '../../data/courses.csv', format: 'csv' } } })
    expect(pageData(readFileSync(join(root, result.outputPath), 'utf8')).records).toHaveLength(5)

    const undone = await desk.undo(ws, result.undoId)
    expect(undone.ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
    expect(await folioContaining(ws, 'notes/essay.md')).toBeNull()
    expect(desk.has(result.undoId)).toBe(false)
  })

  test('a document already in a Folio keeps its manifest; the widget goes to the Folio folder', async () => {
    const manifest = '{\n  "schema_version": 1,\n  "content_root": "contents",\n  "files": [ { "path": "01-intro.md" } ],\n  "x_unknown": true\n}\n'
    const { ws, root } = workspace({ 'report/_report-structure.json': manifest, 'report/contents/01-intro.md': '# Intro\n', 'report/data/courses.csv': fixture('csv/courses.csv') })
    const desk = new StandardWidgetUndoDesk()
    const result = await createInPlace(ws, desk, { documentPath: 'report/contents/01-intro.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'report/data/courses.csv', position: 'start' })
    if (!result.ok) throw new Error(result.message)
    expect(result.folio).toEqual({ dir: 'report', created: false })
    expect(readFileSync(join(root, 'report/_report-structure.json'), 'utf8')).toBe(manifest)
    expect(existsSync(join(root, 'report/AGENTS.md'))).toBe(false)
    expect(readFileSync(join(root, 'report/contents/01-intro.md'), 'utf8')).toBe('[Simulation: ../visualisations/courses/widget.html]\n\n# Intro\n')
    // A second widget of the same name gets a free folder.
    const second = await createInPlace(ws, desk, { documentPath: 'report/contents/01-intro.md', name: 'courses', recipe: browserRecipe(), sourceFile: 'report/data/courses.csv' })
    expect(second.ok && second.recipePath).toBe('report/visualisations/courses-2/widget.md')
  })

  test('undo refuses, changing nothing, when a file the step wrote has changed since', async () => {
    const { ws, root } = workspace({ 'essay.md': essay, 'courses.csv': fixture('csv/courses.csv') })
    const desk = new StandardWidgetUndoDesk()
    const result = await createInPlace(ws, desk, { documentPath: 'essay.md', name: 'b', recipe: browserRecipe(), sourceFile: 'courses.csv' })
    if (!result.ok) throw new Error(result.message)
    writeFileSync(join(root, 'essay.md'), `${result.documentText}More words.\n`)
    const now = snapshot(root)
    const undone = await desk.undo(ws, result.undoId)
    expect(undone).toEqual({ ok: false, code: 'changed', message: 'essay.md changed after the widget was made, so nothing was undone.' })
    expect(snapshot(root)).toEqual(now)
    expect(desk.has(result.undoId)).toBe(true)
  })

  test('a step that cannot build, or a source outside the Folio folder, leaves nothing behind', async () => {
    const { ws, root } = workspace({ 'notes/essay.md': essay, 'notes/bad.csv': 'course_id,title\n001,"never closed\n', 'elsewhere/courses.csv': fixture('csv/courses.csv') })
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const failed = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'b', recipe: browserRecipe(), sourceFile: 'notes/bad.csv' })
    expect(failed.ok).toBe(false)
    expect(!failed.ok && failed.errors.map((error) => error.code)).toEqual(['csv-malformed'])
    expect(snapshot(root)).toEqual(before)
    const outside = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'b', recipe: browserRecipe(), sourceFile: 'elsewhere/courses.csv' })
    expect(outside.ok).toBe(false)
    expect(snapshot(root)).toEqual(before)
    const changed = await createInPlace(ws, desk, { documentPath: 'notes/essay.md', name: 'b', recipe: browserRecipe(), sourceFile: 'notes/bad.csv', documentBasis: 'not what is on disk' })
    expect(changed).toMatchObject({ ok: false, message: 'notes/essay.md changed since it was read; nothing was written.' })
    expect(snapshot(root)).toEqual(before)
  })

  test('updating a recipe rewrites only the named keys, rebuilds, and undoes as one step', async () => {
    const { ws, root } = workspace({ 'essay.md': essay, 'courses.csv': fixture('csv/courses.csv') })
    const desk = new StandardWidgetUndoDesk()
    const created = await createInPlace(ws, desk, { documentPath: 'essay.md', name: 'b', recipe: { ...browserRecipe(), x_kept: 'unknown keys survive' }, sourceFile: 'courses.csv' })
    if (!created.ok) throw new Error(created.message)
    const before = snapshot(root)
    const updated = await updateStandardWidgetRecipe(ws, desk, { recipePath: created.recipePath, patch: { title: 'Renamed courses', mapping: { id: 'course_id', title: 'title', detail: 'provider' } } })
    if (!updated.ok) throw new Error(updated.message)
    expect(updated.build.result).toBe('built')
    expect(parseRecipeText(updated.recipeText)).toMatchObject({ ok: true, recipe: { title: 'Renamed courses', x_kept: 'unknown keys survive' } })
    expect(pageData(readFileSync(join(root, created.outputPath), 'utf8')).records[0].detail).toBe(paragraph('Training Unit'))
    expect((await desk.undo(ws, updated.undoId)).ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })
})
