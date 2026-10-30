import { VersionStore } from '../../src/main/versions'
/**
 * The own-folder step of Create and insert (contracts §14 C5, all amendments; locked drawing
 * docs/design/2026-10-20-folio-on-widget-insert/), against a real temporary Workspace:
 *   1. the plan: what the sheet shows, read without writing anything; name clash and its suggestion;
 *   2. just this document: it moves into the new folder, the data file is copied, links in it still resolve;
 *   3. links to it from other documents (relative links and wikilinks) follow it;
 *   4. other documents chosen: they move together, the outline in the chosen order; all chosen: nothing moves;
 *   5. the data file moved with the documents, links to it following;
 *   6. a failure part-way puts everything back; a link swapped in during the move is refused;
 *   7. one undo restores the exact layout and text; a moved document changed since makes it refuse.
 * Every "nothing written" and "exactly as before" is a whole-tree snapshot.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { createStandardWidget, operationSeams, StandardWidgetUndoDesk } from '../../src/main/standard-widgets/operations'
import { readOwnFolderFacts } from '../../src/main/standard-widgets/own-folder'
import { cleanUpLeftoverStep, forgetLeftoverStep, readLeftoverSteps } from '../../src/main/standard-widgets/step-journal'
import { parseRecipeText, type RecipeMap } from '../../src/main/standard-widgets/recipe'
import { Workspace } from '../../src/main/workspace'
import { initialOwnFolderChoice, planFingerprint, planOwnFolder, type OwnFolderChoice, type OwnFolderFacts } from '../../src/shared/own-folder-plan'

const FIXTURES = new URL('../fixtures/standard-widgets/', import.meta.url).pathname
const COURSES = readFileSync(join(FIXTURES, 'csv/courses.csv'), 'utf8')
const W = 'Workshop notes'

const roots: string[] = []
afterEach(() => {
  delete operationSeams.afterMoveWrite
  delete operationSeams.afterOriginalRemoved
  delete operationSeams.beforePutBack
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wf-own-folder-')))
  roots.push(dir)
  return dir
}
function workspace(files: Record<string, string>): { ws: Workspace; root: string } {
  const root = tempDir()
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    if (path.endsWith('/')) continue
    writeFileSync(join(root, path), text)
  }
  return { ws: new Workspace(root), root }
}
/** The step journals left in the Workspace's `.writeflex` folder (none once a step is done or put back). */
function journals(root: string): string[] {
  try { return readdirSync(join(root, '.writeflex')).filter((name) => name.startsWith('widget-step-')) } catch { return [] }
}
/** Every file and folder, byte for byte; the app's own `.writeflex` folder is checked apart: no step journal may be left in it. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  out['(journals)'] = journals(root).join(',')
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir).sort()) {
      if (rel === '' && name === '.writeflex') continue
      const abs = join(dir, name)
      const path = rel ? `${rel}/${name}` : name
      const info = lstatSync(abs)
      if (info.isSymbolicLink()) out[path] = 'link'
      else if (info.isDirectory()) { out[`${path}/`] = 'dir'; walk(abs, path) } else out[path] = readFileSync(abs, 'utf8')
    }
  }
  walk(root, '')
  return out
}
const read = (root: string, path: string): string => readFileSync(join(root, path), 'utf8')
const recipe = (): RecipeMap => {
  const parsed = parseRecipeText(readFileSync(join(FIXTURES, 'recipes/browser-from-csv.widget.md'), 'utf8'))
  if (!parsed.ok) throw new Error('fixture')
  const { widget_schema: _ignored, source, ...rest } = parsed.recipe
  void _ignored
  return { ...rest, title: 'Course catalogue', source: { format: (source as RecipeMap).format } }
}

const NOTES = '# Course notes\n\nSee the [plan](planning.md) and the ![logo](img/logo.png).\n\nThe [catalogue data](courses.csv) is below.\n'
const PLANNING = '# Planning\n\nRead the [course notes](course-notes.md#top) and [[course-notes]].\n'
const READING = '# Reading list\n\nBack to the [plan](planning.md).\n'
const ATTENDEES = '# Attendees\n\nThe list is in [the data](courses.csv).\n'
const ELSEWHERE = '# Index\n\nThe [notes](../Workshop%20notes/course-notes.md) and [reading](<../Workshop notes/reading-list.md>).\n'
const workshop = (): Record<string, string> => ({
  [`${W}/course-notes.md`]: NOTES,
  [`${W}/planning.md`]: PLANNING,
  [`${W}/reading-list.md`]: READING,
  [`${W}/attendees.md`]: ATTENDEES,
  [`${W}/courses.csv`]: COURSES,
  [`${W}/img/logo.png`]: 'png',
  'other/index.md': ELSEWHERE,
})

async function factsOf(ws: Workspace): Promise<OwnFolderFacts> {
  const answer = await readOwnFolderFacts(ws, { documentPath: `${W}/course-notes.md`, sourceFile: `${W}/courses.csv`, name: 'Course catalogue' })
  if (!answer.ok || !answer.needed) throw new Error('facts expected')
  return answer.facts
}
const request = (placement?: OwnFolderChoice) => ({
  documentPath: `${W}/course-notes.md`, name: 'Course catalogue', recipe: recipe(), sourceFile: `${W}/courses.csv`,
  documentBasis: NOTES, ...(placement ? { placement } : {}),
})
async function create(ws: Workspace, desk: StandardWidgetUndoDesk, placement?: OwnFolderChoice) {
  return createStandardWidget(ws, desk, request(placement))
}
/** The sheet's answer as the sheet sends it: the choice and the fingerprint of the plan it showed over `facts`. */
const choice = (facts: OwnFolderFacts, change: Partial<OwnFolderChoice> = {}): OwnFolderChoice => {
  const answer = { ...initialOwnFolderChoice(facts), ...change }
  return { ...answer, fingerprint: planFingerprint(planOwnFolder(facts, answer)) }
}

/** Every relative Markdown link in `path` resolves to a file that exists. */
function linksResolve(root: string, path: string): void {
  const text = read(root, path)
  for (const match of text.matchAll(/\]\((<[^>]+>|[^)\s]+)/g)) {
    let target = match[1].replace(/^<|>$/g, '')
    if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
    target = target.replace(/[#?].*$/, '')
    if (!match[1].startsWith('<')) target = decodeURIComponent(target)
    expect(existsSync(join(root, posix.dirname(path), target))).toBe(true)
  }
}

describe('The plan: what the sheet shows, nothing written', () => {
  test('facts and the default plan: just this document, the title as the folder name, the data file copied', async () => {
    const { ws, root } = workspace(workshop())
    const before = snapshot(root)
    const facts = await factsOf(ws)
    expect(facts.documents).toEqual(['attendees.md', 'planning.md', 'reading-list.md'])
    expect(facts.files).toEqual(['courses.csv'])
    expect(facts.folders).toEqual(['img'])
    expect(facts.defaultName).toBe('Course notes')
    expect(facts.widgetFolder.ownFolder).toBe('course-catalogue')
    const plan = planOwnFolder(facts, initialOwnFolderChoice(facts))
    expect(plan).toMatchObject({ inPlace: false, moving: ['course-notes.md'], newFolder: 'Course notes', ready: true, dataFile: { asked: true, effect: 'copy' }, primary: 'Move and insert widget', title: 'course-notes will get a folder of its own' })
    expect(plan.after.map((row) => `${'  '.repeat(row.depth)}${row.name}${row.tag ? ` [${row.tag}]` : ''}`)).toEqual([
      'Workshop notes', '  img', '  Course notes [new]', '    course-notes.md [moves]', '    _report-structure.json [new]', '    AGENTS.md [new]', '    CLAUDE.md [new]',
      '    visualisations [new]', '      course-catalogue [new]', '        courses.csv [copy]', '        widget.md [new]', '        widget.html [new]', '        widget.build.json [new]',
      '  attendees.md', '  courses.csv', '  planning.md', '  reading-list.md',
    ])
    expect(snapshot(root)).toEqual(before)
  })

  test('a lone document, and one already in a Folio, need no sheet', async () => {
    const { ws } = workspace({ 'solo/only.md': '# Only\n', 'solo/data/x.csv': COURSES, 'f/_report-structure.json': '{"schema_version":1,"files":[{"path":"a.md"}]}\n', 'f/a.md': '# A\n', 'f/b.md': '# B\n' })
    expect(await readOwnFolderFacts(ws, { documentPath: 'solo/only.md', name: 'x' })).toEqual({ ok: true, needed: false })
    expect(await readOwnFolderFacts(ws, { documentPath: 'f/a.md', name: 'x' })).toEqual({ ok: true, needed: false })
  })

  test('a name already used (folder or file, any case) is refused with the lowest free suggestion, and create writes nothing', async () => {
    const { ws, root } = workspace({ ...workshop(), [`${W}/Course notes/keep.md`]: '# Keep\n', [`${W}/course notes 2`]: 'a file' })
    const facts = await factsOf(ws)
    const plan = planOwnFolder(facts, initialOwnFolderChoice(facts))
    expect(plan.ready).toBe(false)
    expect(plan.nameProblem).toEqual({ text: 'Workshop notes already has a folder called “Course notes”. Nothing in it would be changed, but the new folder needs a different name.', suggest: 'Course notes 3' })
    expect(planOwnFolder(facts, choice(facts, { name: 'COURSE NOTES 2' })).nameProblem?.text).toContain('a file called “course notes 2”')
    expect(planOwnFolder(facts, choice(facts, { name: ' ' })).nameProblem?.text).toBe('Type a name for the new folder.')
    expect(planOwnFolder(facts, choice(facts, { name: 'a/b' })).nameProblem?.text).toBe('A folder name cannot contain / or :.')
    const before = snapshot(root)
    const refused = await create(ws, new StandardWidgetUndoDesk(), choice(facts))
    expect(refused.ok).toBe(false)
    expect(snapshot(root)).toEqual(before)
  })

  test('a sheet drawn before a document appeared is refused, writing nothing', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    writeFileSync(join(root, W, 'late.md'), '# Late\n')
    const before = snapshot(root)
    const refused = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: [...facts.documents] }))
    expect(refused).toMatchObject({ ok: false, code: 'own-folder-changed', message: 'Workshop notes changed since the folder sheet was drawn, so nothing was written. Review the sheet again.' })
    expect(snapshot(root)).toEqual(before)
  })
})

describe('Moving into the new folder', () => {
  test('just this document: it moves, the data file is copied, its links still resolve and the widget is in it', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts))
    if (!result.ok) throw new Error(result.message)
    const moved = `${W}/Course notes/course-notes.md`
    expect(result.documentPath).toBe(moved)
    expect(result.moved).toEqual([{ from: `${W}/course-notes.md`, to: moved }])
    expect(existsSync(join(root, W, 'course-notes.md'))).toBe(false)
    expect(read(root, moved)).toBe('# Course notes\n\nSee the [plan](../planning.md) and the ![logo](../img/logo.png).\n\nThe [catalogue data](../courses.csv) is below.\n\n[Simulation: visualisations/course-catalogue/widget.html]\n')
    linksResolve(root, moved)
    expect(JSON.parse(read(root, `${W}/Course notes/_report-structure.json`)).files).toEqual([{ path: 'course-notes.md', role: 'section' }])
    expect(read(root, `${W}/Course notes/visualisations/course-catalogue/courses.csv`)).toBe(COURSES)
    expect(read(root, `${W}/courses.csv`)).toBe(COURSES)
    expect(read(root, `${W}/Course notes/visualisations/course-catalogue/widget.md`)).toContain('path: courses.csv')
    expect(existsSync(join(root, W, 'Course notes/AGENTS.md'))).toBe(true)
    expect(existsSync(join(root, W, '_report-structure.json'))).toBe(false)
  })

  test('links to it follow it: relative links (encoded and in angle brackets) and wikilinks', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['reading-list.md'], order: ['course-notes.md', 'reading-list.md', 'planning.md', 'attendees.md'] }))
    if (!result.ok) throw new Error(result.message)
    expect(read(root, `${W}/planning.md`)).toBe('# Planning\n\nRead the [course notes](Course%20notes/course-notes.md#top) and [[course-notes]].\n')
    expect(read(root, 'other/index.md')).toBe('# Index\n\nThe [notes](../Workshop%20notes/Course%20notes/course-notes.md) and [reading](<../Workshop notes/Course notes/reading-list.md>).\n')
    // Between two moved documents the link is carried to where both are now.
    expect(read(root, `${W}/Course notes/reading-list.md`)).toBe('# Reading list\n\nBack to the [plan](../planning.md).\n')
    for (const path of [`${W}/planning.md`, 'other/index.md', `${W}/Course notes/reading-list.md`, `${W}/Course notes/course-notes.md`]) linksResolve(root, path)
  })

  test('other documents chosen: they move together and the outline keeps the chosen order', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['reading-list.md', 'planning.md'], order: ['course-notes.md', 'reading-list.md', 'planning.md', 'attendees.md'], name: 'Course pack' }))
    if (!result.ok) throw new Error(result.message)
    expect(readdirSync(join(root, W, 'Course pack')).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', '_report-structure.json', 'course-notes.md', 'planning.md', 'reading-list.md', 'visualisations'])
    expect(JSON.parse(read(root, `${W}/Course pack/_report-structure.json`)).files.map((file: { path: string }) => file.path)).toEqual(['course-notes.md', 'reading-list.md', 'planning.md'])
    expect(read(root, `${W}/attendees.md`)).toBe(ATTENDEES)
    // Links between documents that moved together read as they did.
    expect(read(root, `${W}/Course pack/reading-list.md`)).toBe(READING)
    expect(read(root, `${W}/Course pack/planning.md`)).toBe(PLANNING)
  })

  test('every document chosen: the folder itself becomes the Folio and nothing moves; the data file is used where it is', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: [...facts.documents], order: ['course-notes.md', 'planning.md', 'reading-list.md', 'attendees.md'] }))
    if (!result.ok) throw new Error(result.message)
    expect(result.moved).toEqual([])
    expect(result.documentPath).toBe(`${W}/course-notes.md`)
    expect(JSON.parse(read(root, `${W}/_report-structure.json`)).files.map((file: { path: string }) => file.path)).toEqual(['course-notes.md', 'planning.md', 'reading-list.md', 'attendees.md'])
    for (const name of ['planning.md', 'reading-list.md', 'attendees.md']) expect(existsSync(join(root, W, name))).toBe(true)
    expect(read(root, `${W}/visualisations/course-catalogue/widget.md`)).toContain('path: ../../courses.csv')
    expect(existsSync(join(root, W, 'visualisations/course-catalogue/courses.csv'))).toBe(false)
    expect(read(root, `${W}/planning.md`)).toBe(PLANNING)
  })

  test('the data file moved with the documents: it leaves its folder and links to it follow', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    expect(planOwnFolder(facts, choice(facts, { dataFile: 'move' })).after.find((row) => row.name === 'courses.csv')).toMatchObject({ tag: 'moves', depth: 4 })
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { dataFile: 'move' }))
    if (!result.ok) throw new Error(result.message)
    const data = `${W}/Course notes/visualisations/course-catalogue/courses.csv`
    expect(result.moved).toContainEqual({ from: `${W}/courses.csv`, to: data })
    expect(existsSync(join(root, W, 'courses.csv'))).toBe(false)
    expect(read(root, data)).toBe(COURSES)
    expect(read(root, `${W}/attendees.md`)).toBe('# Attendees\n\nThe list is in [the data](Course%20notes/visualisations/course-catalogue/courses.csv).\n')
    expect(read(root, `${W}/Course notes/course-notes.md`)).toContain('[catalogue data](visualisations/course-catalogue/courses.csv)')
    linksResolve(root, `${W}/attendees.md`)
    linksResolve(root, `${W}/Course notes/course-notes.md`)
  })
})

describe('Failure, a swapped link, and undo', () => {
  test('a failure part-way through the moves puts every file back as it was', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const before = snapshot(root)
    let moves = 0
    operationSeams.afterMoveWrite = () => { moves += 1; if (moves === 2) throw new Error('disk full') }
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['planning.md', 'reading-list.md'] }))
    expect(result.ok === false && result.message).toContain('disk full')
    expect(moves).toBe(2)
    expect(snapshot(root)).toEqual(before)
  })

  test('the new folder swapped for a link during the move: nothing is written through it, and the documents stay', async () => {
    const { ws, root } = workspace(workshop())
    const outside = tempDir()
    const facts = await factsOf(ws)
    operationSeams.afterMoveWrite = (from, to) => {
      if (!to.endsWith('course-notes.md')) return
      delete operationSeams.afterMoveWrite
      renameSync(join(root, W, 'Course notes'), join(root, 'swapped-away'))
      symlinkSync(outside, join(root, W, 'Course notes'))
      void from
    }
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['planning.md'] }))
    expect(result.ok).toBe(false)
    expect(readdirSync(outside)).toEqual([])
    for (const [name, text] of [['course-notes.md', NOTES], ['planning.md', PLANNING], ['reading-list.md', READING], ['attendees.md', ATTENDEES]]) expect(read(root, `${W}/${name}`)).toBe(text)
  })

  test('the new folder swapped for a link to another folder of the Workspace: nothing lands there, and the documents stay', async () => {
    const { ws, root } = workspace({ ...workshop(), 'elsewhere/keep.md': '# Keep\n' })
    const facts = await factsOf(ws)
    // What stood in elsewhere/ each time a later move had written (none may happen: the next write is refused).
    const seenThere: string[][] = []
    operationSeams.afterMoveWrite = (_from, to) => {
      if (!to.endsWith('course-notes.md')) { seenThere.push(readdirSync(join(root, 'elsewhere'))); return }
      renameSync(join(root, W, 'Course notes'), join(root, 'swapped-away'))
      symlinkSync(join(root, 'elsewhere'), join(root, W, 'Course notes'))
    }
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['planning.md'] }))
    expect(result.ok === false && result.message).toContain('Workshop notes/Course notes changed while')
    expect(seenThere).toEqual([])
    expect(readdirSync(join(root, 'elsewhere'))).toEqual(['keep.md'])
    for (const [name, text] of [['course-notes.md', NOTES], ['planning.md', PLANNING], ['reading-list.md', READING], ['attendees.md', ATTENDEES]]) expect(read(root, `${W}/${name}`)).toBe(text)
  })

  test('one undo restores the exact layout and text: documents, data file, links elsewhere, and no new folder', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const before = snapshot(root)
    const desk = new StandardWidgetUndoDesk()
    const result = await create(ws, desk, choice(facts, { mode: 'several', checked: ['reading-list.md'], dataFile: 'move' }))
    if (!result.ok) throw new Error(result.message)
    expect(snapshot(root)).not.toEqual(before)
    const undone = await desk.undo(ws, result.undoId)
    expect(undone.ok && undone.movedBack).toEqual(result.moved.map((move) => ({ from: move.to, to: move.from })))
    expect(snapshot(root)).toEqual(before)
  })

  test('a moved document changed after the step: the undo refuses and changes nothing', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const desk = new StandardWidgetUndoDesk()
    const result = await create(ws, desk, choice(facts))
    if (!result.ok) throw new Error(result.message)
    writeFileSync(join(root, result.documentPath), `${result.documentText}More.\n`)
    const after = snapshot(root)
    const undone = await desk.undo(ws, result.undoId)
    expect(undone.ok === false && undone.code).toBe('changed')
    expect(snapshot(root)).toEqual(after)
  })
})

describe('The sheet is required, and must be the one the folder makes now (review r1, spec P1 and P2)', () => {
  test('no answer in a folder that needs the sheet: refused by name, nothing written', async () => {
    const { ws, root } = workspace(workshop())
    const before = snapshot(root)
    const refused = await create(ws, new StandardWidgetUndoDesk())
    expect(refused).toMatchObject({ ok: false, code: 'placement-required' })
    expect(snapshot(root)).toEqual(before)
  })

  test('the sheet showed "just this document" moving; its last sibling went meanwhile: refused as changed, not done in place', async () => {
    const { ws, root } = workspace({ [`${W}/course-notes.md`]: NOTES, [`${W}/planning.md`]: PLANNING, [`${W}/data/courses.csv`]: COURSES })
    const answer = await readOwnFolderFacts(ws, { documentPath: `${W}/course-notes.md`, sourceFile: `${W}/data/courses.csv`, name: 'Course catalogue' })
    if (!answer.ok || !answer.needed) throw new Error('facts expected')
    const shown = choice(answer.facts)
    expect(planOwnFolder(answer.facts, shown).moving).toEqual(['course-notes.md'])
    rmSync(join(root, W, 'planning.md'))
    const before = snapshot(root)
    const refused = await createStandardWidget(ws, new StandardWidgetUndoDesk(), { documentPath: `${W}/course-notes.md`, name: 'Course catalogue', recipe: recipe(), sourceFile: `${W}/data/courses.csv`, placement: shown })
    expect(refused).toMatchObject({ ok: false, code: 'own-folder-changed', message: 'Workshop notes changed since the folder sheet was drawn, so nothing was written. Review the sheet again.' })
    expect(snapshot(root)).toEqual(before)
  })

  test('a file appeared that changes what the sheet drew (the same documents): refused as changed', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    writeFileSync(join(root, W, 'notes.txt'), 'new file')
    const before = snapshot(root)
    expect(await create(ws, new StandardWidgetUndoDesk(), choice(facts))).toMatchObject({ ok: false, code: 'own-folder-changed' })
    expect(snapshot(root)).toEqual(before)
  })

  test('an answer without the fingerprint, or with another one, is refused as changed', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const before = snapshot(root)
    const { fingerprint: _drop, ...bare } = choice(facts)
    void _drop
    expect(await create(ws, new StandardWidgetUndoDesk(), bare)).toMatchObject({ ok: false, code: 'own-folder-changed' })
    expect(await create(ws, new StandardWidgetUndoDesk(), { ...choice(facts), fingerprint: '00000000deadbeef-1' })).toMatchObject({ ok: false, code: 'own-folder-changed' })
    expect(snapshot(root)).toEqual(before)
  })
})

describe('Links into a folder whose name has #, and a data file named like the build\'s files (review r1, P1)', () => {
  test('moving into "Notes #2": links from elsewhere and from the moved document still resolve', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { name: 'Notes #2' }))
    if (!result.ok) throw new Error(result.message)
    expect(read(root, `${W}/planning.md`)).toBe('# Planning\n\nRead the [course notes](Notes%20%232/course-notes.md#top) and [[course-notes]].\n')
    for (const path of [`${W}/planning.md`, 'other/index.md', `${W}/Notes #2/course-notes.md`]) linksResolve(root, path)
  })

  for (const mode of ['copy', 'move'] as const) {
    test(`a dataset called widget.build.json (${mode}): it goes in as data-widget.build.json, the sheet says so, and it is never the receipt`, async () => {
      const COURSES_JSON = readFileSync(join(FIXTURES, 'json/courses.json'), 'utf8')
      const { ws, root } = workspace({ [`${W}/course-notes.md`]: NOTES, [`${W}/planning.md`]: PLANNING, [`${W}/widget.build.json`]: COURSES_JSON })
      const answer = await readOwnFolderFacts(ws, { documentPath: `${W}/course-notes.md`, sourceFile: `${W}/widget.build.json`, name: 'Course catalogue' })
      if (!answer.ok || !answer.needed) throw new Error('facts expected')
      const shown = choice(answer.facts, { dataFile: mode })
      expect(planOwnFolder(answer.facts, shown).after.map((row) => row.name)).toContain('data-widget.build.json')
      const parsed = parseRecipeText(readFileSync(join(FIXTURES, 'recipes/browser-from-json.widget.md'), 'utf8'))
      if (!parsed.ok) throw new Error('fixture')
      const { widget_schema: _ignored, source, ...rest } = parsed.recipe
      void _ignored
      const { path: _path, ...sourceRest } = source as RecipeMap
      void _path
      const desk = new StandardWidgetUndoDesk()
      const result = await createStandardWidget(ws, desk, { documentPath: `${W}/course-notes.md`, name: 'Course catalogue', recipe: { ...rest, source: sourceRest }, sourceFile: `${W}/widget.build.json`, placement: shown })
      if (!result.ok) throw new Error(result.message)
      const widget = `${W}/Course notes/visualisations/course-catalogue`
      expect(read(root, `${widget}/data-widget.build.json`)).toBe(COURSES_JSON)
      expect(read(root, `${widget}/widget.md`)).toContain('path: data-widget.build.json')
      expect(JSON.parse(read(root, `${widget}/widget.build.json`))).not.toEqual(JSON.parse(COURSES_JSON))
      expect(existsSync(join(root, W, 'widget.build.json'))).toBe(mode === 'copy')
      // A rebuild reads the data, not the receipt.
      const page = read(root, `${widget}/widget.html`)
      expect(page).toContain('Prompting basics')
      const undone = await desk.undo(ws, result.undoId)
      expect(undone.ok).toBe(true)
      expect(read(root, `${W}/widget.build.json`)).toBe(COURSES_JSON)
    })
  }
})

describe('Files the step itself makes are not bystanders (shot pass, defect 1)', () => {
  test('the happy path says nothing: the new manifest, agent files and widget are not scanned or reported', async () => {
    const { ws } = workspace(workshop())
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(await factsOf(ws)))
    if (!result.ok) throw new Error(result.message)
    expect(result.notices).toEqual([])
  })

  test('only the exact files the step wrote are left alone: a document that turns up in the new folder meanwhile is repaired like any bystander', async () => {
    const { ws, root } = workspace(workshop())
    operationSeams.afterMoveWrite = () => {
      delete operationSeams.afterMoveWrite
      writeFileSync(join(root, `${W}/Course notes/bystander.md`), '# Bystander\n\nSee [notes](../course-notes.md).\n')
    }
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(await factsOf(ws)))
    if (!result.ok) throw new Error(result.message)
    expect(read(root, `${W}/Course notes/bystander.md`)).toBe('# Bystander\n\nSee [notes](course-notes.md).\n')
    expect(result.notices).toEqual([])
  })

  test('a genuine "could not carry" still reaches the notices beside it', async () => {
    const { ws, root } = workspace(workshop())
    writeFileSync(join(root, 'other/latin.md'), Buffer.concat([Buffer.from('# Caf'), Buffer.from([0xff]), Buffer.from('\n\nSee [notes](../Workshop%20notes/course-notes.md).\n')]))
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(await factsOf(ws)))
    if (!result.ok) throw new Error(result.message)
    expect(result.notices).toEqual(['Links in other/latin.md were not updated: it is not plain UTF-8 text, so WriteFlex did not rewrite it.'])
  })
})

describe('Bytes that are not UTF-8 text are never rewritten (review r1, standards P1)', () => {
  test('a linked document holding byte FF is left byte for byte, named in the notices, and undo keeps it so', async () => {
    const latin = Buffer.concat([Buffer.from('# Caf'), Buffer.from([0xff]), Buffer.from('\n\nThe [notes](../Workshop%20notes/course-notes.md) and [[Workshop notes/course-notes]].\n')])
    const { ws, root } = workspace(workshop())
    writeFileSync(join(root, 'other/latin.md'), latin)
    const facts = await factsOf(ws)
    const desk = new StandardWidgetUndoDesk()
    const result = await create(ws, desk, choice(facts))
    if (!result.ok) throw new Error(result.message)
    expect(readFileSync(join(root, 'other/latin.md')).equals(latin)).toBe(true)
    expect(result.notices).toContain('Links in other/latin.md were not updated: it is not plain UTF-8 text, so WriteFlex did not rewrite it.')
    const undone = await desk.undo(ws, result.undoId)
    expect(undone.ok).toBe(true)
    expect(readFileSync(join(root, 'other/latin.md')).equals(latin)).toBe(true)
  })

  test('the document itself not UTF-8 text: refused, nothing written', async () => {
    const { ws, root } = workspace({ 'solo/only.md': '' })
    writeFileSync(join(root, 'solo/only.md'), Buffer.from([0x23, 0x20, 0xff, 0x0a]))
    writeFileSync(join(root, 'solo/courses.csv'), COURSES)
    const before = snapshot(root)
    const answer = await readOwnFolderFacts(ws, { documentPath: 'solo/only.md', sourceFile: 'solo/courses.csv', name: 'x' })
    if (!answer.ok || !answer.needed) throw new Error('facts expected')
    const result = await createStandardWidget(ws, new StandardWidgetUndoDesk(), { documentPath: 'solo/only.md', name: 'x', recipe: recipe(), sourceFile: 'solo/courses.csv', placement: choice(answer.facts) })
    expect(result.ok === false && result.message).toContain('is not plain UTF-8 text')
    expect(snapshot(root)).toEqual(before)
  })
})

describe('Copy first, remove last; a put-back never loses a document (review r1, standards P1 and P2)', () => {
  test('a failure before the last part leaves every original untouched, even when nothing can be put back', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const originals = Object.fromEntries(Object.entries(workshop()).map(([path, text]) => [path, text]))
    let copies = 0
    operationSeams.afterMoveWrite = () => { copies += 1; if (copies === 2) throw new Error('disk full') }
    operationSeams.beforePutBack = () => { throw new Error('I/O error') }
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['planning.md'] }))
    expect(result.ok === false && result.message).toContain('disk full')
    for (const [path, text] of Object.entries(originals)) expect(read(root, path)).toBe(text)
  })

  test('A\'s old name removed, B\'s removal fails, A cannot be put back: A\'s copy is kept, and the journal stays for Clean up', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const a = `${W}/course-notes.md`
    // After both old names are removed the step fails, and A's old name cannot be made again: something took it.
    operationSeams.afterOriginalRemoved = (from) => {
      if (from !== `${W}/planning.md`) return
      mkdirSync(join(root, a))
      throw new Error('I/O error after removing planning.md')
    }
    const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts, { mode: 'several', checked: ['planning.md'] }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(lstatSync(join(root, a)).isDirectory()).toBe(true)
    const copy = `${W}/Course notes/course-notes.md`
    expect(read(root, copy)).toContain('[plan](planning.md)')
    expect(result.message).toContain(`${a} changed on disk after WriteFlex wrote it, so it was left as it is.`)
    expect(result.message).toContain(copy)
    expect(result.message).toContain('kept')
    // planning.md was put back over its own name.
    expect(read(root, `${W}/planning.md`)).toBe(PLANNING)
    expect(journals(root)).toHaveLength(1)
    expect((await readLeftoverSteps(ws))[0]?.leftover).toContain(copy)
  })

  for (const target of ['outside the Workspace', 'another folder of the Workspace'] as const) {
    test(`the original's folder swapped for a link to ${target} before the rollback: nothing is written there, the copy is kept`, async () => {
      const { ws, root } = workspace({ ...workshop(), 'elsewhere/keep.md': '# Keep\n' })
      const there = target === 'outside the Workspace' ? tempDir() : join(root, 'elsewhere')
      const was = readdirSync(there)
      const facts = await factsOf(ws)
      // The step fails after removing the old name; by the time it is put back, its folder leads elsewhere.
      operationSeams.afterOriginalRemoved = () => {
        renameSync(join(root, W), join(root, 'moved-away'))
        symlinkSync(there, join(root, W))
        throw new Error('I/O error after the first removal')
      }
      const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts))
      expect(result.ok).toBe(false)
      expect(readdirSync(there)).toEqual(was)
      expect(read(root, 'moved-away/Course notes/course-notes.md')).toContain('[plan](../planning.md)')
    })
  }

  test('the same swap to another folder of the Workspace during an undo: nothing lands there, the undo stops, the document stays', async () => {
    const { ws, root } = workspace({ ...workshop(), 'elsewhere/keep.md': '# Keep\n' })
    const facts = await factsOf(ws)
    const desk = new StandardWidgetUndoDesk()
    const result = await create(ws, desk, choice(facts))
    if (!result.ok) throw new Error(result.message)
    operationSeams.beforePutBack = (path) => {
      if (path !== `${W}/course-notes.md`) return
      delete operationSeams.beforePutBack
      renameSync(join(root, W), join(root, 'moved-away'))
      symlinkSync(join(root, 'elsewhere'), join(root, W))
    }
    const undone = await desk.undo(ws, result.undoId)
    expect(undone.ok === false && undone.code).toBe('incomplete')
    expect(readdirSync(join(root, 'elsewhere'))).toEqual(['keep.md'])
    expect(read(root, 'moved-away/Course notes/course-notes.md')).toBe(result.documentText)
  })
})

describe('A crash part-way: the originals stay, the launch notice names what is left, Clean up removes only the step\'s own (review r1, standards P2)', () => {
  const killedAt = (root: string, stopAt: string, body: object): void => {
    const child = spawnSync(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'widget-step-killed.ts'), root, stopAt, JSON.stringify(body)], { encoding: 'utf8', timeout: 60_000 })
    expect(child.signal, `${child.stdout}\n${child.stderr}`).toBe('SIGKILL')
  }

  test('killed after the second copy: the originals are all there, the copies are named, Clean up puts the Workspace back exactly', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const before = snapshot(root)
    killedAt(root, 'copy:2', request(choice(facts, { mode: 'several', checked: ['planning.md'] })))
    for (const [path, text] of Object.entries(workshop())) expect(read(root, path)).toBe(text)
    const [left, ...more] = await readLeftoverSteps(ws)
    expect(more).toEqual([])
    expect(left).toMatchObject({ phase: 'copying', document: `${W}/course-notes.md`, folder: `${W}/Course notes`, leftover: [`${W}/Course notes/course-notes.md`, `${W}/Course notes/planning.md`] })
    expect(left!.message).toContain('Your documents are where they were.')
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned.ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
    expect(await readLeftoverSteps(ws)).toEqual([])
  })

  test('killed after the links elsewhere were carried: Clean up puts those links back too', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const before = snapshot(root)
    // Everything done but the removal of the old names: the links elsewhere were carried (to the copies).
    killedAt(root, 'before-removing:1', request(choice(facts, { dataFile: 'move' })))
    expect(read(root, `${W}/attendees.md`)).toContain('Course%20notes/visualisations/course-catalogue/courses.csv')
    expect(read(root, `${W}/course-notes.md`)).toBe(NOTES)
    expect(read(root, `${W}/courses.csv`)).toBe(COURSES)
    const [left] = await readLeftoverSteps(ws)
    expect(left?.phase).toBe('copying')
    expect((await cleanUpLeftoverStep(ws, left!.id)).ok).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  test('a leftover copy the writer changed since is never removed: it is named and kept', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    killedAt(root, 'copy:1', request(choice(facts)))
    const copy = `${W}/Course notes/course-notes.md`
    writeFileSync(join(root, copy), 'my own edit\n')
    const [left] = await readLeftoverSteps(ws)
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned.message).toContain(`${copy} changed after WriteFlex wrote it, so it was left as it is.`)
    expect(read(root, copy)).toBe('my own edit\n')
    for (const [path, text] of Object.entries(workshop())) expect(read(root, path)).toBe(text)
  })

  test('killed in the last part: past the commit point, Clean up removes nothing and the old copies left are named', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    killedAt(root, 'removed:1', request(choice(facts, { mode: 'several', checked: ['planning.md'] })))
    expect(existsSync(join(root, W, 'course-notes.md'))).toBe(false)
    expect(read(root, `${W}/planning.md`)).toBe(PLANNING)
    const [left] = await readLeftoverSteps(ws)
    expect(left).toMatchObject({ phase: 'removing', oldCopies: [{ from: `${W}/planning.md`, to: `${W}/Course notes/planning.md` }] })
    expect(left!.message).toContain('WriteFlex does not remove them')
    const after = snapshot(root)
    await forgetLeftoverStep(ws, left!.id)
    expect(await readLeftoverSteps(ws)).toEqual([])
    expect({ ...snapshot(root), '(journals)': after['(journals)'] }).toEqual(after)
  })
})

describe('Review r2: Clean up never removes the only copy left; links with escaped parentheses follow', () => {
  const killedAt = (root: string, stopAt: string, body: object): void => {
    const child = spawnSync(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'widget-step-killed.ts'), root, stopAt, JSON.stringify(body)], { encoding: 'utf8', timeout: 60_000 })
    expect(child.signal, `${child.stdout}\n${child.stderr}`).toBe('SIGKILL')
  }

  test('killed after the first copy, the original removed while the app was stopped: Clean up removes nothing, keeps the copy and the journal, and names it', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    killedAt(root, 'copy:1', request(choice(facts)))
    const copy = `${W}/Course notes/course-notes.md`
    const copied = read(root, copy)
    rmSync(join(root, W, 'course-notes.md'))
    const [left] = await readLeftoverSteps(ws)
    expect(left!.message).toContain(`${copy} was kept because its original ${W}/course-notes.md is missing or changed.`)
    const after = snapshot(root)
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned).toEqual({ ok: false, restored: [], message: `Nothing was removed or put back. ${copy} was kept because its original ${W}/course-notes.md is missing or changed.` })
    expect(read(root, copy)).toBe(copied)
    expect(snapshot(root)).toEqual(after)
    expect(await readLeftoverSteps(ws)).toHaveLength(1)
  })

  test('all or nothing: one original changed (another intact, links elsewhere carried): nothing is removed and no link is put back', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    killedAt(root, 'before-removing:1', request(choice(facts, { mode: 'several', checked: ['planning.md'] })))
    writeFileSync(join(root, W, 'planning.md'), '# Planning, edited while WriteFlex was closed\n')
    const after = snapshot(root)
    const [left] = await readLeftoverSteps(ws)
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned.ok).toBe(false)
    expect(cleaned.message).toBe(`Nothing was removed or put back. ${W}/Course notes/planning.md was kept because its original ${W}/planning.md is missing or changed.`)
    expect(snapshot(root)).toEqual(after)
    // With the original as it was, the same Clean up goes ahead.
    writeFileSync(join(root, W, 'planning.md'), PLANNING)
    expect((await cleanUpLeftoverStep(ws, left!.id)).ok).toBe(true)
    expect(await readLeftoverSteps(ws)).toEqual([])
  })

  test('a link written with escaped parentheses to a moved document follows it: [notes](notes\\(a\\).md)', async () => {
    const { ws, root } = workspace({ [`${W}/notes(a).md`]: '# Notes\n', [`${W}/other.md`]: '# Other\n\nThe [notes](notes\\(a\\).md).\n', [`${W}/third.md`]: '# Third\n\nThe [notes](<notes(a).md>).\n', [`${W}/data/courses.csv`]: COURSES })
    const answer = await readOwnFolderFacts(ws, { documentPath: `${W}/notes(a).md`, sourceFile: `${W}/data/courses.csv`, name: 'x' })
    if (!answer.ok || !answer.needed) throw new Error('facts expected')
    const result = await createStandardWidget(ws, new StandardWidgetUndoDesk(), { documentPath: `${W}/notes(a).md`, name: 'x', recipe: recipe(), sourceFile: `${W}/data/courses.csv`, placement: choice(answer.facts) })
    if (!result.ok) throw new Error(result.message)
    expect(result.documentPath).toBe(`${W}/Notes/notes(a).md`)
    expect(read(root, `${W}/other.md`)).toBe('# Other\n\nThe [notes](Notes/notes\\(a\\).md).\n')
    expect(read(root, `${W}/third.md`)).toBe('# Third\n\nThe [notes](<Notes/notes(a).md>).\n')
  })
})

describe('Review r3: every original checked, and checked again in the tick of each copy\'s removal', () => {
  const killedAt = (root: string, stopAt: string, body: object): void => {
    const child = spawnSync(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'widget-step-killed.ts'), root, stopAt, JSON.stringify(body)], { encoding: 'utf8', timeout: 60_000 })
    expect(child.signal, `${child.stdout}\n${child.stderr}`).toBe('SIGKILL')
  }

  test('the original removed after Clean up put the links back: the copy is not removed, Clean up stops and says so, the journal keeps it', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    killedAt(root, 'before-removing:1', request(choice(facts)))
    const copy = `${W}/Course notes/course-notes.md`
    const copied = read(root, copy)
    const [left] = await readLeftoverSteps(ws)
    // Injected once, as Clean up reaches the copy: by then the links elsewhere were already put back.
    operationSeams.beforePutBack = (path) => {
      if (path !== copy) return
      delete operationSeams.beforePutBack
      expect(read(root, `${W}/planning.md`)).toBe(PLANNING)
      rmSync(join(root, W, 'course-notes.md'))
    }
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned.ok).toBe(false)
    expect(cleaned.message).toStartWith(`Clean up stopped. ${copy} was kept because its original ${W}/course-notes.md is missing or changed.`)
    expect(read(root, copy)).toBe(copied)
    const [still] = await readLeftoverSteps(ws)
    expect(still?.id).toBe(left!.id)
    expect(still?.leftover).toContain(copy)
  })

  test('both the original and its copy gone: nothing is put back or removed, the journal stays, and the notice names it', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    killedAt(root, 'before-removing:1', request(choice(facts)))
    rmSync(join(root, W, 'course-notes.md'))
    rmSync(join(root, W, 'Course notes/course-notes.md'))
    const after = snapshot(root)
    const [left] = await readLeftoverSteps(ws)
    const sentence = `${W}/Course notes/course-notes.md was kept because its original ${W}/course-notes.md is missing or changed.`
    expect(left!.message).toContain(sentence)
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned).toEqual({ ok: false, restored: [], message: `Nothing was removed or put back. ${sentence}` })
    expect(snapshot(root)).toEqual(after)
    expect(await readLeftoverSteps(ws)).toHaveLength(1)
  })
})

describe('Review r4: a refused copy stops the folders\' removal too', () => {
  test('an interrupted insertion, its original removed as Clean up reaches the copy: the widget\'s folder and the new folder are still there afterwards', async () => {
    const { ws, root } = workspace(workshop())
    const facts = await factsOf(ws)
    const child = spawnSync(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'widget-step-killed.ts'), root, 'before-removing:1', JSON.stringify(request(choice(facts)))], { encoding: 'utf8', timeout: 60_000 })
    expect(child.signal, `${child.stdout}\n${child.stderr}`).toBe('SIGKILL')
    const copy = `${W}/Course notes/course-notes.md`
    const widget = `${W}/Course notes/visualisations/course-catalogue`
    expect(lstatSync(join(root, widget)).isDirectory()).toBe(true)
    const [left] = await readLeftoverSteps(ws)
    operationSeams.beforePutBack = (path) => {
      if (path !== copy) return
      delete operationSeams.beforePutBack
      rmSync(join(root, W, 'course-notes.md'))
    }
    const cleaned = await cleanUpLeftoverStep(ws, left!.id)
    expect(cleaned.ok).toBe(false)
    expect(cleaned.message).toStartWith('Clean up stopped.')
    // The widget's files went before the copy (newest first); its now-empty folder is not removed.
    expect(lstatSync(join(root, widget)).isDirectory()).toBe(true)
    expect(lstatSync(join(root, W, 'Course notes/visualisations')).isDirectory()).toBe(true)
    expect(existsSync(join(root, copy))).toBe(true)
  })
})

test('an own-folder widget cannot declare a Folio under an Index-Note-only ancestor', async () => {
  const { ws, root } = workspace(workshop())
  const facts = await factsOf(ws)
  writeFileSync(join(root, `_${posix.basename(root)}_INDEX.md`), '## Running order\n')
  const before = snapshot(root)
  const result = await create(ws, new StandardWidgetUndoDesk(), choice(facts))
  expect(result).toMatchObject({ ok: false, message: expect.stringContaining('already occupies this folder tree') })
  expect(snapshot(root)).toEqual(before)
})

test('widget folder moves and their guarded Undo carry document versions', async () => {
  const { ws } = workspace(workshop())
  const versions = new VersionStore(ws)
  const from = `${W}/course-notes.md`
  const first = await versions.append({ path: from, name: 'Before widget', author: { name: 'Writer' } })
  const desk = new StandardWidgetUndoDesk()
  const result = await create(ws, desk, choice(await factsOf(ws)))
  if (!result.ok) throw new Error(result.message)
  expect((await versions.list({ path: result.documentPath }))[0].id).toBe(first.id)
  expect(await versions.list({ path: from })).toEqual([])
  const undone = await desk.undo(ws, result.undoId)
  expect(undone.ok).toBe(true)
  expect((await versions.list({ path: from }))[0].id).toBe(first.id)
})
