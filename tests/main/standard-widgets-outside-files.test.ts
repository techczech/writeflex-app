/**
 * Bringing a file from anywhere on the Mac into a widget (ticket 04c), against a real temporary Workspace, a real
 * folder outside it and a real grant store in a third folder (the app's data folder stands in):
 *   1. the picker: a file in the document's folders is used in place; any other comes back as a token, never a path;
 *      a link, a non-file or an oversize file is refused;
 *   2. Copy: the copy in resources/, the item `copy` with its capture, the recipe naming it, no trace of the
 *      original's location anywhere in the Folio, no grant;
 *   3. Keep in sync: the same plus a grant bound to (Folio identity, resource id, origin);
 *   4. builds: an edited original refreshes the copy and the page; a deleted one keeps the last copy and names it; a
 *      grant id copied into another item or another Folio, or unknown here, never reads the original; a link, a
 *      folder, a device or an oversize file at the original is refused; a copy changed during the refresh is kept;
 *   5. one undo puts back every file and the grant store exactly; a failure part-way does too;
 *   6. a single document in no Folio: the own-folder sheet first, then the intake into the new Folio;
 *   7. the IPC: tokens bound to their window and document, no channel that writes a grant, a forged pick refused.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { buildStandardWidgetNow, createStandardWidget, exactBefore, leftAsBefore, previewStandardWidgetDraft, snapshotSeams, StandardWidgetUndoDesk, updateStandardWidgetRecipe, type ExactSnapshot } from '../../src/main/standard-widgets/operations'
import { folioContaining } from '../../src/main/folio-place'
import { rollBackOperationWrites } from '../../src/main/operation-rollback'
import { noteBytesBefore, recordingBytesBefore } from '../../src/main/standard-widgets/step-bytes-before'
import { operationSeams } from '../../src/main/standard-widgets/step-folders'
import { syncRefreshSeams } from '../../src/main/standard-widgets/build'
import { registerStandardWidgetHandlers } from '../../src/main/standard-widgets/ipc'
import { readOwnFolderFacts } from '../../src/main/standard-widgets/own-folder'
import { intakeOutsideFile, newResourceId, PickDesk, pickStandardWidgetSource, pickStillAuthorised, type OutsidePick, type PickAnswer } from '../../src/main/standard-widgets/outside-files'
import { parseRecipeText, type RecipeMap } from '../../src/main/standard-widgets/recipe'
import { addResourceItemText, ResourcesManifestRefused, setResourceItemCaptureText } from '../../src/main/standard-widgets/resources-manifest'
import { GRANT_ID, lookupGrant, newGrantId, originSeams, setAppSyncGrantStore, SyncGrantStore, type GrantWrite } from '../../src/main/standard-widgets/sync-grants'
import { Workspace, type OperationWrite } from '../../src/main/workspace'
import { initialOwnFolderChoice, planFingerprint, planOwnFolder, type OwnFolderChoice } from '../../src/shared/own-folder-plan'

const FIXTURES = new URL('../fixtures/standard-widgets/', import.meta.url).pathname
const COURSES = readFileSync(join(FIXTURES, 'csv/courses.csv'), 'utf8')
const EDITED = COURSES.replace('Prompting basics', 'Prompting, edited at the original')
const DOC = '# Report\n\nThe courses.\n'
const OWNER = 7

const roots: string[] = []
afterEach(() => {
  delete originSeams.beforeOpen
  delete syncRefreshSeams.beforeReplace
  delete snapshotSeams.afterStep
  delete operationSeams.beforeRemovingOriginals
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}
function put(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
}
const FOLIO = (files: string[]) => `${JSON.stringify({ schema_version: 1, content_root: '', files: files.map((path) => ({ path, role: 'section' })) }, null, 2)}\n`

type World = { root: string; ws: Workspace; outside: string; store: SyncGrantStore; storeFile: string; desk: StandardWidgetUndoDesk; picks: PickDesk }
/** A Workspace with a Folio `report/` (one document), a folder outside the Workspace holding `attendance.csv`, and
 *  a grant store in a third folder. */
function world(files: Record<string, string> = { 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']) }): World {
  const root = tempDir('wf-outside-ws-')
  put(root, files)
  const outside = tempDir('wf-outside-original-')
  put(outside, { 'attendance.csv': COURSES })
  const appData = tempDir('wf-outside-appdata-')
  const storeFile = join(appData, 'widget-sync-grants.json')
  return { root, ws: new Workspace(root), outside, store: new SyncGrantStore(storeFile), storeFile, desk: new StandardWidgetUndoDesk(), picks: new PickDesk() }
}
const dialogFor = (path: string) => async () => ({ canceled: false, filePaths: [path] })
async function pick(w: World, path: string, documentPath = 'report/report.md'): Promise<PickAnswer> {
  return pickStandardWidgetSource(w.ws, w.picks, OWNER, documentPath, dialogFor(path))
}
async function outsidePick(w: World, path = join(w.outside, 'attendance.csv'), documentPath = 'report/report.md'): Promise<OutsidePick> {
  const answer = await pick(w, path, documentPath)
  if (!answer.ok || answer.inside) throw new Error(`outside pick expected: ${JSON.stringify(answer)}`)
  return w.picks.get(answer.token, OWNER, w.ws.root, documentPath)!
}
const recipe = (): RecipeMap => {
  const parsed = parseRecipeText(readFileSync(join(FIXTURES, 'recipes/browser-from-csv.widget.md'), 'utf8'))
  if (!parsed.ok) throw new Error('fixture')
  const { widget_schema: _ignored, source, ...rest } = parsed.recipe
  void _ignored
  return { ...rest, title: 'Attendance', source: { format: (source as RecipeMap).format } }
}
async function bringIn(w: World, inclusion: 'copy' | 'sync', documentPath = 'report/report.md', extra: Record<string, unknown> = {}) {
  const p = await outsidePick(w, join(w.outside, 'attendance.csv'), documentPath)
  return createStandardWidget(w.ws, w.desk, { documentPath, name: 'Attendance', recipe: recipe(), outside: { pick: p, inclusion }, ...extra }, { grants: w.store })
}
/** Every file under `root`, byte for byte (folders as 'dir', links as 'link'); `.writeflex` is the app's own. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
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
const manifest = (w: World, folio = 'report') => JSON.parse(read(w.root, `${folio}/_report-structure.json`)) as { resources?: { version: number; items: Array<Record<string, unknown>> } }
/** No file in `folder` mentions the original's location in any form. */
function noOriginIn(w: World, folder: string): void {
  for (const [path, text] of Object.entries(snapshot(join(w.root, folder)))) {
    expect({ path, leak: text.includes(w.outside) }).toEqual({ path, leak: false })
    expect({ path, leak: /"origin"\s*:/.test(text) }).toEqual({ path, leak: false })
  }
}

describe('The picker', () => {
  test('a file in the document\'s folders is used in place; any other comes back as a token and its text, never its path', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/data/courses.csv': COURSES, 'elsewhere/other.csv': COURSES })
    expect(await pick(w, join(w.root, 'report/data/courses.csv'))).toEqual({ ok: true, inside: true, path: 'report/data/courses.csv', name: 'courses.csv', text: COURSES })
    for (const path of [join(w.outside, 'attendance.csv'), join(w.root, 'elsewhere/other.csv')]) {
      const answer = await pick(w, path)
      expect(answer).toMatchObject({ ok: true, inside: false, text: COURSES })
      expect(JSON.stringify(answer)).not.toContain(dirname(path))
      expect(Object.keys(answer).sort()).toEqual(['inside', 'name', 'ok', 'text', 'token'])
    }
    expect(await pickStandardWidgetSource(w.ws, w.picks, OWNER, 'report/report.md', async () => ({ canceled: true, filePaths: [] }))).toEqual({ ok: false, cancelled: true })
  })

  test('a link, a folder, a file over the size cap, and a file that is not CSV or JSON are refused, nothing held', async () => {
    const w = world()
    symlinkSync(join(w.outside, 'attendance.csv'), join(w.outside, 'linked.csv'))
    mkdirSync(join(w.outside, 'folder.csv'))
    writeFileSync(join(w.outside, 'huge.csv'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
    writeFileSync(join(w.outside, 'notes.txt'), 'x')
    expect(await pick(w, join(w.outside, 'linked.csv'))).toEqual({ ok: false, message: 'linked.csv is a link. Choose the file it points to instead.' })
    expect(await pick(w, join(w.outside, 'folder.csv'))).toEqual({ ok: false, message: 'folder.csv is not a plain file.' })
    expect(await pick(w, join(w.outside, 'huge.csv'))).toMatchObject({ ok: false, message: expect.stringContaining('larger than 8 MiB') })
    expect(await pick(w, join(w.outside, 'notes.txt'))).toEqual({ ok: false, message: 'notes.txt is not a CSV or JSON file.' })
  })

  test('a token is good only for its window, Workspace and document', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/other.md': DOC })
    const answer = await pick(w, join(w.outside, 'attendance.csv'))
    if (!answer.ok || answer.inside) throw new Error('token expected')
    expect(w.picks.get(answer.token, OWNER, w.ws.root, 'report/report.md')).not.toBeNull()
    expect(w.picks.get(answer.token, OWNER + 1, w.ws.root, 'report/report.md')).toBeNull()
    expect(w.picks.get(answer.token, OWNER, '/elsewhere', 'report/report.md')).toBeNull()
    expect(w.picks.get(answer.token, OWNER, w.ws.root, 'report/other.md')).toBeNull()
    expect(w.picks.get('0'.repeat(32), OWNER, w.ws.root, 'report/report.md')).toBeNull()
  })
})

describe('Copy and Keep in sync', () => {
  test('Copy: the copy in resources/, the item `copy`, the recipe names it, nothing of the original\'s location, no grant', async () => {
    const w = world()
    const made = await bringIn(w, 'copy')
    if (!made.ok) throw new Error(made.message)
    expect(made.intake).toEqual({ id: 'attendance', path: 'report/resources/attendance.csv', inclusion: 'copy' })
    expect(read(w.root, 'report/resources/attendance.csv')).toBe(COURSES)
    const item = manifest(w).resources!.items[0]
    expect(manifest(w).resources!.version).toBe(1)
    expect(item).toMatchObject({ id: 'attendance', path: 'resources/attendance.csv', inclusion: 'copy', capture: { bytes: Buffer.byteLength(COURSES), media_type: 'text/csv' } })
    expect('grant' in item).toBe(false)
    expect((parseRecipeText(read(w.root, made.recipePath)) as { recipe: RecipeMap }).recipe.source).toEqual({ resource: 'attendance', format: 'csv' })
    expect(made.build.result).toBe('built')
    expect(read(w.root, made.outputPath)).toContain('Prompting basics')
    expect(read(w.root, 'report/report.md')).toContain('[Simulation: visualisations/attendance/widget.html]')
    noOriginIn(w, 'report')
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('Keep in sync: the same, plus a grant bound to (the Folio folder\'s real path, the item id, the original\'s real path)', async () => {
    const w = world()
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    const item = manifest(w).resources!.items[0]
    expect(item).toMatchObject({ id: 'attendance', path: 'resources/attendance.csv', inclusion: 'sync' })
    expect(item.grant).toMatch(GRANT_ID)
    const grants = w.store.grants()
    expect(grants).toEqual([{ id: item.grant as string, folio: join(w.root, 'report'), resource: 'attendance', kind: 'file', origin: join(w.outside, 'attendance.csv'), granted_at: expect.any(String) }])
    expect(made.build.receipt?.states).toEqual(['sync-current:attendance'])
    noOriginIn(w, 'report')
  })

  test('a name taken in resources/ gives the copy a free name and the item a free id; the file there is untouched', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/resources/attendance.csv': 'kept,as,is\n' })
    const made = await bringIn(w, 'copy')
    if (!made.ok) throw new Error(made.message)
    expect(made.intake?.path).toBe('report/resources/attendance-2.csv')
    expect(read(w.root, 'report/resources/attendance.csv')).toBe('kept,as,is\n')
    expect(newResourceId('attendance.csv', new Set(['attendance']))).toBe('attendance-csv')
    expect(newResourceId('attendance.csv', new Set(['attendance', 'attendance-csv']))).toBe('attendance-csv-2')
  })

  test('the preview of an outside file is the page the create builds, with nothing written', async () => {
    const w = world()
    const p = await outsidePick(w)
    const before = snapshot(w.root)
    const preview = await previewStandardWidgetDraft(w.ws, { documentPath: 'report/report.md', recipe: recipe(), outside: p, name: 'Attendance' })
    if (!preview.ok) throw new Error(preview.message)
    expect(snapshot(w.root)).toEqual(before)
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), outside: { pick: p, inclusion: 'copy' } }, { grants: w.store })
    if (!made.ok) throw new Error(made.message)
    expect(read(w.root, made.outputPath)).toBe(preview.html)
  })
})

describe('Builds of a file kept in sync', () => {
  test('an edited original refreshes the copy, its capture and the page; an unchanged one writes nothing', async () => {
    const w = world()
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    writeFileSync(join(w.outside, 'attendance.csv'), EDITED)
    const outcome = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })
    expect(outcome.errors).toEqual([])
    expect(outcome.receipt?.states).toEqual(['sync-refreshed:attendance'])
    expect(read(w.root, 'report/resources/attendance.csv')).toBe(EDITED)
    expect(read(w.root, made.outputPath)).toContain('Prompting, edited at the original')
    expect((manifest(w).resources!.items[0].capture as { bytes: number }).bytes).toBe(Buffer.byteLength(EDITED))
    expect(outcome.written).toEqual(expect.arrayContaining(['report/resources/attendance.csv', 'report/_report-structure.json']))
    const again = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })
    expect(again.receipt?.states).toEqual(['sync-current:attendance'])
    expect(again.written).toEqual(['report/visualisations/attendance/widget.build.json'])
    noOriginIn(w, 'report')
  })

  test('a deleted original: the build uses the last copy and names the missing source as a warning', async () => {
    const w = world()
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    unlinkSync(join(w.outside, 'attendance.csv'))
    const outcome = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })
    expect(outcome.result).toBe('built')
    expect(outcome.errors.map((error) => [error.code, error.severity, error.source.path, error.value])).toEqual([['source-original-missing', 'warning', 'report/resources/attendance.csv', 'attendance']])
    expect(outcome.errors[0].message).toContain('The original of a file kept in sync is not there')
    expect(outcome.receipt?.states).toEqual(['source-original-missing:attendance'])
    expect(read(w.root, 'report/resources/attendance.csv')).toBe(COURSES)
    expect(read(w.root, made.outputPath)).toContain('Prompting basics')
  })

  test('a grant id copied into another item or another Folio never reads the original: sync-grant-mismatch, the copy used', async () => {
    const w = world({
      'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']),
      'other/other.md': DOC, 'other/_report-structure.json': FOLIO(['other.md']),
    })
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    const grant = manifest(w).resources!.items[0].grant as string
    writeFileSync(join(w.outside, 'attendance.csv'), EDITED)
    // Another item in the same Folio, its own copy, declared with the transplanted grant id.
    put(w.root, { 'report/resources/second.csv': COURSES, 'report/visualisations/second/widget.md': read(w.root, made.recipePath).replace('resource: attendance', 'resource: second') })
    const report = read(w.root, 'report/_report-structure.json')
    writeFileSync(join(w.root, 'report/_report-structure.json'), addResourceItemText(report, { id: 'second', path: 'resources/second.csv', inclusion: 'sync', grant, capture: { sha256: 'x', bytes: 1, media_type: 'text/csv', captured_at: '2026-10-20T00:00:00Z' } }))
    // Another Folio: the same item id and the same grant id.
    put(w.root, { 'other/resources/attendance.csv': COURSES, 'other/visualisations/attendance/widget.md': read(w.root, made.recipePath) })
    writeFileSync(join(w.root, 'other/_report-structure.json'), addResourceItemText(read(w.root, 'other/_report-structure.json'), { id: 'attendance', path: 'resources/attendance.csv', inclusion: 'sync', grant, capture: { sha256: 'x', bytes: 1, media_type: 'text/csv', captured_at: '2026-10-20T00:00:00Z' } }))
    const opened: string[] = []
    originSeams.beforeOpen = (origin) => { opened.push(origin) }
    for (const recipePath of ['report/visualisations/second/widget.md', 'other/visualisations/attendance/widget.md']) {
      const outcome = await buildStandardWidgetNow(w.ws, recipePath, { grants: w.store })
      expect(outcome.result).toBe('built')
      expect(outcome.errors.map((error) => [error.code, error.severity])).toEqual([['sync-grant-mismatch', 'warning']])
    }
    expect(opened).toEqual([])
    expect(read(w.root, 'report/resources/second.csv')).toBe(COURSES)
    expect(read(w.root, 'other/resources/attendance.csv')).toBe(COURSES)
    // A moved Folio folder loses its grants the same way (§1.1 consequence).
    expect(lookupGrant(w.store, join(w.root, 'moved-report'), 'attendance', grant)).toEqual({ ok: false, code: 'sync-grant-mismatch' })
    // The rightful item still reads it.
    expect(lookupGrant(w.store, join(w.root, 'report'), 'attendance', grant)).toMatchObject({ ok: true, origin: join(w.outside, 'attendance.csv') })
  })

  test('a grant unknown on this Mac: origin-not-on-this-mac, the copy used, nothing opened', async () => {
    const w = world()
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    const opened: string[] = []
    originSeams.beforeOpen = (origin) => { opened.push(origin) }
    const other = new SyncGrantStore(join(tempDir('wf-other-mac-'), 'grants.json'))
    const outcome = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: other })
    expect(outcome.errors.map((error) => [error.code, error.severity])).toEqual([['origin-not-on-this-mac', 'warning']])
    expect(opened).toEqual([])
    expect(lookupGrant(w.store, 'x', 'y', 'g-bad')).toEqual({ ok: false, code: 'resource-declaration-invalid' })
  })

  test('an original swapped for a link, a folder, a device, an oversize or non-UTF-8 file is not read: the copy is kept', async () => {
    const w = world()
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    const original = join(w.outside, 'attendance.csv')
    const elsewhere = join(tempDir('wf-elsewhere-'), 'secret.csv')
    writeFileSync(elsewhere, EDITED)
    const check = async (label: string, detail: string): Promise<void> => {
      const outcome = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })
      expect({ label, errors: outcome.errors.map((error) => [error.code, error.detail]) }).toEqual({ label, errors: [['source-original-unreadable', detail]] })
      expect({ label, copy: read(w.root, 'report/resources/attendance.csv') }).toEqual({ label, copy: COURSES })
    }
    unlinkSync(original); symlinkSync(elsewhere, original)
    await check('link at the leaf', 'it is reached through a link; the last copy was used')
    unlinkSync(original); mkdirSync(original)
    await check('a folder', 'it is not a plain file; the last copy was used')
    rmSync(original, { recursive: true }); writeFileSync(original, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61))
    await check('oversize', 'it is larger than 8 MiB; the last copy was used')
    writeFileSync(original, Buffer.from([0x61, 0xff, 0xfe, 0x0a]))
    await check('not UTF-8', 'it is not UTF-8 text; the last copy was used')
    // A link on the way to the original (its folder swapped for a link): O_NOFOLLOW_ANY refuses it.
    rmSync(original)
    const realFolder = tempDir('wf-real-folder-')
    writeFileSync(join(realFolder, 'attendance.csv'), EDITED)
    rmSync(w.outside, { recursive: true }); symlinkSync(realFolder, w.outside)
    await check('link on the way', 'it is reached through a link; the last copy was used')
    // A device: a grant written by the store's own writer pointing at /dev/null.
    rmSync(w.outside); mkdirSync(w.outside)
    const grant = manifest(w).resources!.items[0].grant as string
    writeFileSync(w.storeFile, `${JSON.stringify({ version: 1, grants: [{ id: grant, folio: join(w.root, 'report'), resource: 'attendance', kind: 'file', origin: '/dev/null', granted_at: '2026-10-20T00:00:00Z' }] })}\n`)
    await check('a device', 'it is not a plain file; the last copy was used')
  })

  test('a copy changed while the refresh ran is kept: the refresh writes only over the copy it read', async () => {
    const w = world()
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    writeFileSync(join(w.outside, 'attendance.csv'), EDITED)
    syncRefreshSeams.beforeReplace = (path) => { writeFileSync(join(w.root, path), `${COURSES}009,"Hand edit",All,1,"x",y\n`) }
    const outcome = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })
    expect(outcome.result).toBe('failed')
    expect(outcome.errors.map((error) => error.code)).toEqual(['output-write-failed'])
    expect(read(w.root, 'report/resources/attendance.csv')).toContain('Hand edit')
  })
})

describe('Undo and rollback', () => {
  test('one undo puts back every file and the grant store exactly (none before; another grant before)', async () => {
    for (const storeBefore of [null, 'another']) {
      const w = world()
      if (storeBefore) w.store.add({ id: newGrantId(), folio: '/somewhere', resource: 'x', kind: 'file', origin: '/x.csv', granted_at: '2026-10-19T00:00:00Z' })
      const files = snapshot(w.root)
      const store = existsSync(w.storeFile) ? readFileSync(w.storeFile, 'utf8') : null
      const made = await bringIn(w, 'sync')
      if (!made.ok) throw new Error(made.message)
      expect(w.store.grants()).toHaveLength(storeBefore ? 2 : 1)
      const undone = await w.desk.undo(w.ws, made.undoId)
      expect(undone.ok).toBe(true)
      expect(snapshot(w.root)).toEqual(files)
      expect(existsSync(w.storeFile) ? readFileSync(w.storeFile, 'utf8') : null).toBe(store)
    }
  })

  test('undo of an intake into a Folio that already declared resources restores the manifest byte for byte', async () => {
    const declared = `{\n  "schema_version": 1,\n  "content_root": "",\n  "files": [{ "path": "report.md" }],\n  "resources": {\n    "version": 1,\n    "items": [\n      { "id": "kept", "path": "resources/kept.md", "inclusion": "in-place", "x_later_field": 9007199254740993 }\n    ]\n  },\n  "x_top": [1, 2]\n}\n`
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': declared, 'report/resources/kept.md': '# Kept\n' })
    const files = snapshot(w.root)
    const made = await bringIn(w, 'copy')
    if (!made.ok) throw new Error(made.message)
    const after = read(w.root, 'report/_report-structure.json')
    expect(after.startsWith(declared.slice(0, declared.indexOf('\n    ]')))).toBe(true)
    expect(after).toContain('"x_later_field": 9007199254740993')
    expect(after.endsWith('  },\n  "x_top": [1, 2]\n}\n')).toBe(true)
    expect(existsSync(join(w.root, 'report/_report-structure.json.writeflex-backup'))).toBe(true)
    expect((await w.desk.undo(w.ws, made.undoId)).ok).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
  })

  test('a step that fails part-way (the build) puts back every file and takes the grant back', async () => {
    const w = world()
    const files = snapshot(w.root)
    const p = await outsidePick(w)
    const bad = { ...recipe(), mapping: { ...(recipe().mapping as RecipeMap), title: 'no_such_column' } }
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: bad, outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(made.ok).toBe(false)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('a pick not made by the picker is refused, nothing written, no grant', async () => {
    const w = world()
    const files = snapshot(w.root)
    const forged = Object.freeze({ name: 'attendance.csv', origin: join(w.outside, 'attendance.csv'), bytes: Buffer.from(COURSES), kind: 'csv' as const })
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), outside: { pick: forged, inclusion: 'sync' } }, { grants: w.store })
    expect(made).toMatchObject({ ok: false, message: expect.stringContaining('file picker') })
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
    const preview = await previewStandardWidgetDraft(w.ws, { documentPath: 'report/report.md', recipe: recipe(), outside: forged })
    expect(preview.ok).toBe(false)
  })
})

describe('A single document in no Folio', () => {
  test('a folder with other files: the own-folder sheet first, then the intake into the new Folio; one undo puts it all back', async () => {
    const w = world({ 'notes/report.md': DOC, 'notes/other.md': '# Other\n' })
    const files = snapshot(w.root)
    const refused = await bringIn(w, 'sync', 'notes/report.md')
    expect(refused).toMatchObject({ ok: false, code: 'placement-required' })
    expect(snapshot(w.root)).toEqual(files)
    const facts = await readOwnFolderFacts(w.ws, { documentPath: 'notes/report.md', name: 'Attendance' })
    if (!facts.ok || !facts.needed) throw new Error('sheet expected')
    const answer: OwnFolderChoice = initialOwnFolderChoice(facts.facts)
    const placement = { ...answer, fingerprint: planFingerprint(planOwnFolder(facts.facts, answer)) }
    const made = await bringIn(w, 'sync', 'notes/report.md', { placement })
    if (!made.ok) throw new Error(made.message)
    expect(made.documentPath).toBe('notes/Report/report.md')
    expect(made.intake?.path).toBe('notes/Report/resources/attendance.csv')
    expect(read(w.root, 'notes/Report/resources/attendance.csv')).toBe(COURSES)
    expect(manifest(w, 'notes/Report').resources!.items[0]).toMatchObject({ id: 'attendance', inclusion: 'sync' })
    expect(w.store.grants()[0]).toMatchObject({ folio: join(w.root, 'notes/Report'), resource: 'attendance' })
    expect(read(w.root, 'notes/other.md')).toBe('# Other\n')
    noOriginIn(w, 'notes/Report')
    expect((await w.desk.undo(w.ws, made.undoId)).ok).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('a lone document: its folder becomes the Folio in place, then the intake', async () => {
    const w = world({ 'solo/report.md': DOC })
    const made = await bringIn(w, 'copy', 'solo/report.md')
    if (!made.ok) throw new Error(made.message)
    expect(made.folio).toEqual({ dir: 'solo', created: true })
    expect(manifest(w, 'solo').resources!.items[0]).toMatchObject({ id: 'attendance', path: 'resources/attendance.csv', inclusion: 'copy' })
    expect(existsSync(join(w.root, 'solo/_report-structure.json.writeflex-backup'))).toBe(false)
  })
})

describe('Edit mode: a made widget given an outside file', () => {
  test('update brings it in and points the recipe at it; one undo puts back the recipe, the copy, the manifest and the grant', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/data/courses.csv': COURSES })
    const first = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: w.store })
    if (!first.ok) throw new Error(first.message)
    const files = snapshot(w.root)
    const p = await outsidePick(w)
    const updated = await updateStandardWidgetRecipe(w.ws, w.desk, { recipePath: first.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' } }, outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    if (!updated.ok) throw new Error(updated.message)
    expect((parseRecipeText(updated.recipeText) as { recipe: RecipeMap }).recipe.source).toEqual({ resource: 'attendance', format: 'csv' })
    expect(w.store.grants()).toHaveLength(1)
    expect((await w.desk.undo(w.ws, updated.undoId)).ok).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })
})

describe('The IPC', () => {
  type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>
  function channels(w: World, dialogPath: string): Map<string, Handler> {
    const handlers = new Map<string, Handler>()
    registerStandardWidgetHandlers({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } } as never, {
      workspaceFor: () => w.ws, notifyChanged: () => {}, pickDialog: () => dialogFor(dialogPath),
    }, w.desk, w.picks)
    return handlers
  }

  test('pick → create through the channels: a token, not a path; another window\'s token is refused; no channel writes grants', async () => {
    const w = world()
    const handlers = channels(w, join(w.outside, 'attendance.csv'))
    expect([...handlers.keys()].filter((channel) => /grant|sync|origin/i.test(channel))).toEqual([])
    const picked = await handlers.get('standard-widget:pick-source')!({ sender: { id: OWNER } }, { documentPath: 'report/report.md' }) as PickAnswer
    if (!picked.ok || picked.inside) throw new Error('token expected')
    const files = snapshot(w.root)
    const stolen = await handlers.get('standard-widget:create')!({ sender: { id: OWNER + 1 } }, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), pick: { token: picked.token, inclusion: 'copy' } })
    expect(stolen).toMatchObject({ ok: false, message: expect.stringContaining('no longer held') })
    expect(snapshot(w.root)).toEqual(files)
    // A path in place of a token is not a pick.
    await expect(handlers.get('standard-widget:create')!({ sender: { id: OWNER } }, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), pick: { token: join(w.outside, 'attendance.csv'), inclusion: 'sync' } })).rejects.toThrow('pick is not a token')
    const preview = await handlers.get('standard-widget:preview')!({ sender: { id: OWNER } }, { documentPath: 'report/report.md', recipe: recipe(), pick: { token: picked.token }, name: 'Attendance' }) as { ok: boolean }
    expect(preview.ok).toBe(true)
    const made = await handlers.get('standard-widget:create')!({ sender: { id: OWNER } }, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), pick: { token: picked.token, inclusion: 'copy' } }) as { ok: boolean }
    expect(made.ok).toBe(true)
    // Used: the token is gone.
    expect(w.picks.get(picked.token, OWNER, w.ws.root, 'report/report.md')).toBeNull()
  })

  test('only the picker intake writes grants: no other source file reaches the store\'s writer', () => {
    const src = new URL('../../src/', import.meta.url).pathname
    const found = spawnSync('grep', ['-rlE', '\\.(add|undoAdd)\\(|SyncGrantStore', src], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((path) => relative(src, path))
    const writers = found.filter((path) => /\.(add|undoAdd)\(/.test(readFileSync(join(src, path), 'utf8')) && readFileSync(join(src, path), 'utf8').includes('store'))
    expect(writers.filter((path) => /\b(store|context\.store)!?\??\.(add|undoAdd)\(/.test(readFileSync(join(src, path), 'utf8'))).sort()).toEqual(['main/standard-widgets/outside-files.ts'])
    expect(readFileSync(join(src, 'preload/index.ts'), 'utf8')).not.toMatch(/grant/i)
  })
})

describe('The resources writer', () => {
  test('appends without touching any other byte; refuses a manifest whose carried values would change', () => {
    const item = { id: 'a', path: 'resources/a.csv', inclusion: 'copy' as const, capture: { sha256: 's', bytes: 1, media_type: 'text/csv', captured_at: 't' } }
    const plain = '{\n  "schema_version": 1,\n  "files": []\n}\n'
    const added = addResourceItemText(plain, item)
    expect(added.startsWith('{\n  "schema_version": 1,\n  "files": []')).toBe(true)
    expect(JSON.parse(added).resources).toEqual({ version: 1, items: [item] })
    const twice = addResourceItemText(added, { ...item, id: 'b' })
    expect(twice.startsWith(added.slice(0, added.lastIndexOf('}\n    ]')))).toBe(true)
    expect(JSON.parse(twice).resources.items.map((entry: { id: string }) => entry.id)).toEqual(['a', 'b'])
    expect(() => addResourceItemText('{ "files": [], "big": 9007199254740993 }', item)).toThrow(ResourcesManifestRefused)
    expect(() => addResourceItemText('{ "files": [], "resources": [] }', item)).toThrow(ResourcesManifestRefused)
    const captured = setResourceItemCaptureText(twice, 'b', { sha256: 'n', bytes: 2, media_type: 'text/csv', captured_at: 'u' })
    expect(JSON.parse(captured).resources.items[1].capture).toEqual({ sha256: 'n', bytes: 2, media_type: 'text/csv', captured_at: 'u' })
    expect(JSON.parse(captured).resources.items[0]).toEqual(item)
  })
})

describe('Review r1 fixes', () => {
  type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>
  function channels(w: World, dialogPath: string): Map<string, Handler> {
    const handlers = new Map<string, Handler>()
    registerStandardWidgetHandlers({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } } as never, {
      workspaceFor: () => w.ws, notifyChanged: () => {}, pickDialog: () => dialogFor(dialogPath),
    }, w.desk, w.picks)
    return handlers
  }
  const event = { sender: { id: OWNER } }
  async function token(handlers: Map<string, Handler>, documentPath = 'report/report.md'): Promise<string> {
    const picked = await handlers.get('standard-widget:pick-source')!(event, { documentPath }) as PickAnswer
    if (!picked.ok || picked.inside) throw new Error('token expected')
    return picked.token
  }
  const withStore = <T>(w: World, run: () => Promise<T>): Promise<T> => { setAppSyncGrantStore(w.store); return run().finally(() => setAppSyncGrantStore(null)) }

  test('P1: a pick for document A cannot update a widget of Folio B: refused by name, nothing written, no grant', async () => {
    const w = world({
      'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']),
      'other/other.md': DOC, 'other/_report-structure.json': FOLIO(['other.md']), 'other/data/courses.csv': COURSES,
    })
    const b = await createStandardWidget(w.ws, w.desk, { documentPath: 'other/other.md', name: 'Courses', recipe: recipe(), sourceFile: 'other/data/courses.csv' }, { grants: w.store })
    if (!b.ok) throw new Error(b.message)
    const handlers = channels(w, join(w.outside, 'attendance.csv'))
    const t = await token(handlers)
    const files = snapshot(w.root)
    const answer = await withStore(w, () => handlers.get('standard-widget:update-recipe')!(event, { documentPath: 'report/report.md', recipePath: b.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' } }, pick: { token: t, inclusion: 'sync' } }))
    expect(answer).toMatchObject({ ok: false, message: `${b.recipePath} is not a widget of report/report.md, the document attendance.csv was chosen for, so nothing was written.` })
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
    // And the engine on its own: a pick made for A, a create into B.
    const p = await outsidePick(w)
    const created = await createStandardWidget(w.ws, w.desk, { documentPath: 'other/other.md', name: 'Attendance', recipe: recipe(), outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(created).toMatchObject({ ok: false, message: 'attendance.csv was chosen for report/report.md, not other/other.md, so nothing was written.' })
    expect(snapshot(w.root)).toEqual(files)
  })

  test('P2: two creates at once with one token: exactly one brings the file in; a refused step that wrote nothing hands the token back', async () => {
    const w = world()
    const handlers = channels(w, join(w.outside, 'attendance.csv'))
    const t = await token(handlers)
    // Refused before anything is written (a mapped column that is not there): the token is handed back.
    const bad = { ...recipe(), mapping: { ...(recipe().mapping as RecipeMap), title: 'no_such_column' } }
    const refused = await withStore(w, () => handlers.get('standard-widget:create')!(event, { documentPath: 'report/report.md', name: 'Attendance', recipe: bad, pick: { token: t, inclusion: 'sync' } })) as { ok: boolean; nothingLeft?: boolean }
    expect(refused).toMatchObject({ ok: false, nothingLeft: true })
    expect(w.picks.get(t, OWNER, w.ws.root, 'report/report.md')).not.toBeNull()
    const create = () => handlers.get('standard-widget:create')!(event, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), pick: { token: t, inclusion: 'sync' } }) as Promise<{ ok: boolean; message?: string }>
    const both = await withStore(w, () => Promise.all([create(), create()]))
    expect(both.map((result) => result.ok).sort()).toEqual([false, true])
    expect(both.find((result) => !result.ok)!.message).toContain('no longer held')
    expect(readdirSync(join(w.root, 'report/resources'))).toEqual(['attendance.csv'])
    expect(manifest(w).resources!.items).toHaveLength(1)
    expect(w.store.grants()).toHaveLength(1)
  })

  test('P3: an update that brings a file in and then fails to build puts the whole step back: copy, item, grant; the build error is the answer', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/data/courses.csv': COURSES })
    const first = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: w.store })
    if (!first.ok) throw new Error(first.message)
    const files = snapshot(w.root)
    const p = await outsidePick(w)
    const mapping = { ...(recipe().mapping as RecipeMap), title: 'no_such_column' }
    const updated = await updateStandardWidgetRecipe(w.ws, w.desk, { recipePath: first.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' }, mapping }, outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(updated.ok).toBe(false)
    if (updated.ok) return
    expect(updated.errors.map((error) => error.code)).toContain('column-missing')
    expect(updated.nothingLeft).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P4: an undo whose grant cannot be removed is incomplete, names it and stays held; the retry finishes it', async () => {
    const w = world()
    const files = snapshot(w.root)
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    const appData = dirname(w.storeFile)
    chmodSync(appData, 0o500)
    let first: Awaited<ReturnType<StandardWidgetUndoDesk['undo']>>
    try { first = await w.desk.undo(w.ws, made.undoId) } finally { chmodSync(appData, 0o700) }
    expect(first).toMatchObject({ ok: false, code: 'incomplete', message: expect.stringContaining('the record of the file kept in sync could not be removed') })
    expect(w.store.grants()).toHaveLength(1)
    expect(w.desk.has(made.undoId)).toBe(true)
    const again = await w.desk.undo(w.ws, made.undoId)
    expect(again.ok).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P5: a file with a byte-order mark (and CRLF lines) is copied and refreshed byte for byte, its capture matching', async () => {
    const w = world()
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(COURSES.replace(/\n/g, '\r\n'), 'utf8')])
    writeFileSync(join(w.outside, 'attendance.csv'), bom)
    const made = await bringIn(w, 'sync')
    if (!made.ok) throw new Error(made.message)
    const copy = readFileSync(join(w.root, 'report/resources/attendance.csv'))
    expect(copy.equals(bom)).toBe(true)
    const capture = manifest(w).resources!.items[0].capture as { sha256: string; bytes: number }
    expect(capture.bytes).toBe(copy.byteLength)
    expect(capture.sha256).toBe(createHash('sha256').update(copy).digest('hex'))
    const edited = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(EDITED.replace(/\n/g, '\r\n'), 'utf8')])
    writeFileSync(join(w.outside, 'attendance.csv'), edited)
    const outcome = await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })
    expect(outcome.receipt?.states).toEqual(['sync-refreshed:attendance'])
    const refreshed = readFileSync(join(w.root, 'report/resources/attendance.csv'))
    expect(refreshed.equals(edited)).toBe(true)
    expect((manifest(w).resources!.items[0].capture as { sha256: string }).sha256).toBe(createHash('sha256').update(refreshed).digest('hex'))
    // Unchanged since: the next build sees the same bytes and writes nothing.
    expect((await buildStandardWidgetNow(w.ws, made.recipePath, { grants: w.store })).receipt?.states).toEqual(['sync-current:attendance'])

    // Copy (no refresh to mend it): the intake itself writes the bytes exactly.
    const c = world()
    writeFileSync(join(c.outside, 'attendance.csv'), bom)
    const copied = await bringIn(c, 'copy')
    if (!copied.ok) throw new Error(copied.message)
    expect(readFileSync(join(c.root, 'report/resources/attendance.csv')).equals(bom)).toBe(true)
    expect((manifest(c).resources!.items[0].capture as { bytes: number }).bytes).toBe(bom.byteLength)
  })
})

describe('Review r2 fixes', () => {
  type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>
  const event = { sender: { id: OWNER } }
  const withStore = <T>(w: World, run: () => Promise<T>): Promise<T> => { setAppSyncGrantStore(w.store); return run().finally(() => setAppSyncGrantStore(null)) }
  /** The reviewer's layout: a Folio `report/` whose document is in a subfolder, `chapters/doc.md`. */
  const CHAPTERS = { 'report/chapters/doc.md': DOC, 'report/_report-structure.json': FOLIO(['chapters/doc.md']), 'report/data/courses.csv': COURSES }
  /** A widget of report/chapters/doc.md built from a file in its Folio, and an outside file picked for that document. */
  async function madeAndPicked(w: World) {
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/chapters/doc.md', name: 'Courses', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: w.store })
    if (!made.ok) throw new Error(made.message)
    return { made, picked: await outsidePick(w, join(w.outside, 'attendance.csv'), 'report/chapters/doc.md') }
  }
  const update = (w: World, recipePath: string, picked: OutsidePick, extra: Record<string, unknown> = {}) =>
    updateStandardWidgetRecipe(w.ws, w.desk, { recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' }, ...extra }, outside: { pick: picked, inclusion: 'sync' } }, { grants: w.store })

  test('P2a: the document\'s folder moved and replaced by a link to outside after the pick: the update is refused by name, nothing written anywhere, no grant', async () => {
    const w = world(CHAPTERS)
    const { made, picked } = await madeAndPicked(w)
    const away = tempDir('wf-outside-moved-')
    renameSync(join(w.root, 'report/chapters'), join(away, 'chapters'))
    symlinkSync(join(away, 'chapters'), join(w.root, 'report/chapters'))
    const inside = snapshot(w.root)
    const moved = snapshot(away)
    const answer = await update(w, made.recipePath, picked)
    expect(answer).toMatchObject({ ok: false, message: 'report/chapters/doc.md, the document attendance.csv was chosen for, is no longer a plain file reached without a link, so nothing was written.' })
    expect(snapshot(w.root)).toEqual(inside)
    expect(snapshot(away)).toEqual(moved)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P2a: the Folio folder replaced by another real folder with the same files: update and create are refused by name, nothing written, no grant', async () => {
    const w = world(CHAPTERS)
    const { made, picked } = await madeAndPicked(w)
    cpSync(join(w.root, 'report'), join(w.root, 'report-copy'), { recursive: true })
    renameSync(join(w.root, 'report'), join(w.root, 'report-old'))
    renameSync(join(w.root, 'report-copy'), join(w.root, 'report'))
    const files = snapshot(w.root)
    const changed = 'report, the folder report/chapters/doc.md was in when attendance.csv was chosen, has changed since, so nothing was written. Choose the file again.'
    expect(await update(w, made.recipePath, picked)).toMatchObject({ ok: false, message: changed })
    const created = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/chapters/doc.md', name: 'Attendance', recipe: recipe(), outside: { pick: picked, inclusion: 'sync' } }, { grants: w.store })
    expect(created).toMatchObject({ ok: false, message: changed })
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P2b: an existing receipt holding byte FF: the update that would bring a file in is refused by name before writing; the receipt is byte for byte as it was', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/data/courses.csv': COURSES })
    const first = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: w.store })
    if (!first.ok) throw new Error(first.message)
    const receiptPath = join(w.root, 'report/visualisations/attendance/widget.build.json')
    const receipt = Buffer.concat([readFileSync(receiptPath), Buffer.from([0xff, 0x0a])])
    writeFileSync(receiptPath, receipt)
    const files = snapshot(w.root)
    const p = await outsidePick(w)
    const mapping = { ...(recipe().mapping as RecipeMap), title: 'no_such_column' }
    const updated = await updateStandardWidgetRecipe(w.ws, w.desk, { recipePath: first.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' }, mapping }, outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(updated).toMatchObject({ ok: false, message: 'report/visualisations/attendance/widget.build.json is not plain UTF-8 text, so WriteFlex could not put it back exactly if the step failed; nothing was written.' })
    expect(readFileSync(receiptPath).equals(receipt)).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P2b: nothingLeft is a byte comparison: a receipt given byte FF by another writer during the step comes back lossy, so the answer is not "nothing left"', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/data/courses.csv': COURSES })
    const first = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: w.store })
    if (!first.ok) throw new Error(first.message)
    const receiptPath = join(w.root, 'report/visualisations/attendance/widget.build.json')
    const p = await outsidePick(w)
    // Passes the check before the step; changed under it while the build reads the original.
    originSeams.beforeOpen = () => { writeFileSync(receiptPath, Buffer.concat([readFileSync(receiptPath), Buffer.from([0xff, 0x0a])])); delete originSeams.beforeOpen }
    const mapping = { ...(recipe().mapping as RecipeMap), title: 'no_such_column' }
    const updated = await updateStandardWidgetRecipe(w.ws, w.desk, { recipePath: first.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' }, mapping }, outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(updated.ok).toBe(false)
    if (updated.ok) return
    expect(updated.errors.map((error) => error.code)).toContain('column-missing')
    expect(updated.nothingLeft).toBe(false)
  })

  test('P2b: the byte comparison itself, on the reviewer\'s repro: FF written over, rolled back as EF BF BD, the rollback reporting no change', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/receipt.json': '' })
    const path = 'report/receipt.json'
    const original = Buffer.from([0x7b, 0xff, 0x7d, 0x0a])
    writeFileSync(join(w.root, path), original)
    expect(await exactBefore(w.root, [path])).toEqual({ ok: false, message: `${path} is not plain UTF-8 text, so WriteFlex could not put it back exactly if the step failed; nothing was written.` })
    const log: OperationWrite[] = []
    await w.ws.recordingOperationWrites(log, async () => { await w.ws.saveFile(path, '{"new":1}\n', { documentOnly: true }) })
    const outcome = await rollBackOperationWrites(w.ws, log)
    expect(outcome.changed.length + outcome.failed.length).toBe(0)
    expect(readFileSync(join(w.root, path)).equals(Buffer.from([0x7b, 0xef, 0xbf, 0xbd, 0x7d, 0x0a]))).toBe(true)
    expect(await leftAsBefore(w.root, log, new Map([[path, original]]))).toBe(false)
    expect(await leftAsBefore(w.root, log, new Map())).toBe(false)
    // An exact file put back exactly, and a file made then removed: as before.
    const exact = Buffer.from('{"old":1}\n')
    writeFileSync(join(w.root, path), exact)
    const again: OperationWrite[] = []
    await w.ws.recordingOperationWrites(again, async () => {
      await w.ws.saveFile(path, '{"new":2}\n', { documentOnly: true })
      await w.ws.saveFile('report/made.json', '{}\n', { documentOnly: true })
    })
    await rollBackOperationWrites(w.ws, again)
    expect(await leftAsBefore(w.root, again, new Map([[path, exact]]))).toBe(true)
  })

  test('P3: a malformed request (recipe: null, patch: null) throws before the pick is taken; the token stays held', async () => {
    const w = world()
    const handlers = new Map<string, Handler>()
    registerStandardWidgetHandlers({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } } as never, {
      workspaceFor: () => w.ws, notifyChanged: () => {}, pickDialog: () => dialogFor(join(w.outside, 'attendance.csv')),
    }, w.desk, w.picks)
    const picked = await handlers.get('standard-widget:pick-source')!(event, { documentPath: 'report/report.md' }) as PickAnswer
    if (!picked.ok || picked.inside) throw new Error('token expected')
    const pickArg = { token: picked.token, inclusion: 'sync' }
    await expect(handlers.get('standard-widget:create')!(event, { documentPath: 'report/report.md', name: 'Attendance', recipe: null, pick: pickArg })).rejects.toThrow('Invalid widget request')
    expect(w.picks.get(picked.token, OWNER, w.ws.root, 'report/report.md')).not.toBeNull()
    await expect(handlers.get('standard-widget:update-recipe')!(event, { documentPath: 'report/report.md', recipePath: 'report/visualisations/a/widget.md', patch: null, pick: pickArg })).rejects.toThrow('Invalid widget request')
    expect(w.picks.get(picked.token, OWNER, w.ws.root, 'report/report.md')).not.toBeNull()
    // And the token still makes the step.
    const made = await withStore(w, () => handlers.get('standard-widget:create')!(event, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), pick: pickArg })) as { ok: boolean }
    expect(made.ok).toBe(true)
  })
})

describe('Review r3 fixes', () => {
  type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>
  const event = { sender: { id: OWNER } }
  const withStore = <T>(w: World, run: () => Promise<T>): Promise<T> => { setAppSyncGrantStore(w.store); return run().finally(() => setAppSyncGrantStore(null)) }
  const badMapping = () => ({ ...recipe(), mapping: { ...(recipe().mapping as RecipeMap), title: 'no_such_column' } })
  function channels(w: World): Map<string, Handler> {
    const handlers = new Map<string, Handler>()
    registerStandardWidgetHandlers({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } } as never, {
      workspaceFor: () => w.ws, notifyChanged: () => {}, pickDialog: () => dialogFor(join(w.outside, 'attendance.csv')),
    }, w.desk, w.picks)
    return handlers
  }
  /** Every write of each step that brings a file in, and the snapshot it ran with. */
  function watchSteps(): Array<{ log: OperationWrite[]; snapshot: ExactSnapshot; bytesBefore: ReadonlyMap<string, Buffer> }> {
    const seen: Array<{ log: OperationWrite[]; snapshot: ExactSnapshot; bytesBefore: ReadonlyMap<string, Buffer> }> = []
    snapshotSeams.afterStep = (log, snapshot, bytesBefore) => { seen.push({ log: [...log], snapshot, bytesBefore }) }
    return seen
  }
  /** The files a step wrote over (they existed before it) that its snapshot did not hold. */
  const overwrittenOutsideSnapshot = (step: { log: OperationWrite[]; snapshot: ExactSnapshot }): string[] => {
    const first = new Map<string, OperationWrite>()
    for (const write of step.log) if (!first.has(write.path)) first.set(write.path, write)
    return [...first.values()].filter((write) => (write.unknown || write.before !== null) && !step.snapshot.has(write.path)).map((write) => write.path)
  }
  const AUTHOR_AGENTS = '# Notes for agents\n\nThe author\'s own words.\n'
  /** The sheet's answer that keeps every document where it is: the folder becomes the Folio in place. */
  async function inPlace(w: World, documentPath: string): Promise<OwnFolderChoice & { fingerprint: string }> {
    const facts = await readOwnFolderFacts(w.ws, { documentPath, name: 'Attendance' })
    if (!facts.ok || !facts.needed) throw new Error('sheet expected')
    const choice: OwnFolderChoice = { ...initialOwnFolderChoice(facts.facts), mode: 'several', checked: [...facts.facts.documents] }
    const plan = planOwnFolder(facts.facts, choice)
    if (!plan.inPlace) throw new Error('in place expected')
    return { ...choice, fingerprint: planFingerprint(plan) }
  }

  test('P2a: a Folio made in place over an AGENTS.md holding byte FF, with a mapping that fails: refused by name before writing; AGENTS.md byte for byte as it was', async () => {
    const w = world({ 'solo/report.md': DOC })
    const agents = Buffer.concat([Buffer.from(AUTHOR_AGENTS), Buffer.from([0xff, 0x0a])])
    writeFileSync(join(w.root, 'solo/AGENTS.md'), agents)
    const files = snapshot(w.root)
    const p = await outsidePick(w, join(w.outside, 'attendance.csv'), 'solo/report.md')
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'solo/report.md', name: 'Attendance', recipe: badMapping(), outside: { pick: p, inclusion: 'sync' }, placement: await inPlace(w, 'solo/report.md') }, { grants: w.store })
    expect(made).toMatchObject({ ok: false, message: 'solo/AGENTS.md is not plain UTF-8 text, so WriteFlex could not put it back exactly if the step failed; nothing was written.' })
    expect(readFileSync(join(w.root, 'solo/AGENTS.md')).equals(agents)).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P2a: the same with a plain UTF-8 AGENTS.md: the failed step is put back exactly, nothingLeft is true and the token is handed back', async () => {
    const w = world({ 'solo/report.md': DOC, 'solo/AGENTS.md': AUTHOR_AGENTS })
    const files = snapshot(w.root)
    const handlers = channels(w)
    const picked = await handlers.get('standard-widget:pick-source')!(event, { documentPath: 'solo/report.md' }) as PickAnswer
    if (!picked.ok || picked.inside) throw new Error('token expected')
    const placement = await inPlace(w, 'solo/report.md')
    const refused = await withStore(w, () => handlers.get('standard-widget:create')!(event, { documentPath: 'solo/report.md', name: 'Attendance', recipe: badMapping(), pick: { token: picked.token, inclusion: 'sync' }, placement })) as { ok: boolean; nothingLeft?: boolean; errors: Array<{ code: string }> }
    expect(refused).toMatchObject({ ok: false, nothingLeft: true })
    expect(refused.errors.map((error) => error.code)).toContain('column-missing')
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
    expect(w.picks.get(picked.token, OWNER, w.ws.root, 'solo/report.md')).not.toBeNull()
  })

  test('P2a: on every path (a Folio made in place, documents moved into their own folder, an update), every file the step writes over is in its snapshot', async () => {
    const seen = watchSteps()
    // In place, with the author's AGENTS.md and CLAUDE.md there to be written over.
    const a = world({ 'solo/report.md': DOC, 'solo/AGENTS.md': AUTHOR_AGENTS, 'solo/CLAUDE.md': '# Mine\n' })
    const madeInPlace = await bringIn(a, 'sync', 'solo/report.md', { placement: await inPlace(a, 'solo/report.md') })
    if (!madeInPlace.ok) throw new Error(madeInPlace.message)
    expect(read(a.root, 'solo/AGENTS.md')).not.toBe(AUTHOR_AGENTS)
    expect(seen).toHaveLength(1)
    expect(seen[0].log.some((write) => write.path === 'solo/AGENTS.md' && write.before === AUTHOR_AGENTS)).toBe(true)
    expect(overwrittenOutsideSnapshot(seen[0])).toEqual([])
    seen.length = 0
    // Moved into its own folder, a document elsewhere linking to it (its links are carried by a writer that checks
    // the bytes itself: allowed outside the snapshot, and checked from the record).
    const b = world({ 'notes/report.md': DOC, 'notes/other.md': '# Other\n', 'elsewhere/links.md': '[r](../notes/report.md) and [[report]]\n' })
    const facts = await readOwnFolderFacts(b.ws, { documentPath: 'notes/report.md', name: 'Attendance' })
    if (!facts.ok || !facts.needed) throw new Error('sheet expected')
    const answer: OwnFolderChoice = initialOwnFolderChoice(facts.facts)
    const moved = await bringIn(b, 'sync', 'notes/report.md', { placement: { ...answer, fingerprint: planFingerprint(planOwnFolder(facts.facts, answer)) } })
    if (!moved.ok) throw new Error(moved.message)
    expect(read(b.root, 'elsewhere/links.md')).not.toBe('[r](../notes/report.md) and [[report]]\n')
    expect(seen).toHaveLength(1)
    expect(seen[0].log.some((write) => write.path === 'notes/report.md' && write.after === null)).toBe(true)
    expect(overwrittenOutsideSnapshot(seen[0])).toEqual(['elsewhere/links.md'])
    // Its writer noted the exact bytes it wrote over.
    expect(seen[0].bytesBefore.get('elsewhere/links.md')?.toString('utf8')).toBe('[r](../notes/report.md) and [[report]]\n')
    // An update over a widget with a hand-edited page (so the rebuilt twin is written) and its receipt.
    const c = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'report/data/courses.csv': COURSES })
    const first = await createStandardWidget(c.ws, c.desk, { documentPath: 'report/report.md', name: 'Attendance', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: c.store })
    if (!first.ok) throw new Error(first.message)
    writeFileSync(join(c.root, first.outputPath), `${read(c.root, first.outputPath)}<!-- hand edit -->\n`)
    writeFileSync(join(c.root, 'report/visualisations/attendance/widget.rebuilt.html'), 'old twin\n')
    seen.length = 0
    const p = await outsidePick(c)
    const updated = await updateStandardWidgetRecipe(c.ws, c.desk, { recipePath: first.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' } }, outside: { pick: p, inclusion: 'sync' } }, { grants: c.store })
    if (!updated.ok) throw new Error(updated.message)
    expect(seen).toHaveLength(1)
    expect(overwrittenOutsideSnapshot(seen[0])).toEqual([])
    expect(seen[0].log.some((write) => write.path.endsWith('widget.rebuilt.html') && write.before !== null)).toBe(true)
  })

  test('P2b: a manifest added in chapters/ after the pick, with the Folio cache still holding the old answer: the update is refused by name; nothing written in report, no grant', async () => {
    const w = world({ 'report/chapters/doc.md': DOC, 'report/_report-structure.json': FOLIO(['chapters/doc.md']), 'report/data/courses.csv': COURSES })
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/chapters/doc.md', name: 'Courses', recipe: recipe(), sourceFile: 'report/data/courses.csv' }, { grants: w.store })
    if (!made.ok) throw new Error(made.message)
    const p = await outsidePick(w, join(w.outside, 'attendance.csv'), 'report/chapters/doc.md')
    expect(p.folder.path).toBe('report')
    // The cache answers `report` for the document; then chapters/ becomes its own Folio, and nothing tells the cache.
    expect((await folioContaining(w.ws, 'report/chapters/doc.md'))?.dir).toBe('report')
    writeFileSync(join(w.root, 'report/chapters/_report-structure.json'), FOLIO(['doc.md']))
    expect((await folioContaining(w.ws, 'report/chapters/doc.md'))?.dir).toBe('report')
    const files = snapshot(w.root)
    const answer = await updateStandardWidgetRecipe(w.ws, w.desk, { recipePath: made.recipePath, patch: { source: { file: 'attendance.csv', format: 'csv' } }, outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(answer).toMatchObject({ ok: false })
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P2b: the check at the write reads the Folio from disk, not the cache: a pick whose Folio gained a nearer manifest is refused there by name', async () => {
    const w = world({ 'report/chapters/doc.md': DOC, 'report/_report-structure.json': FOLIO(['chapters/doc.md']) })
    const p = await outsidePick(w, join(w.outside, 'attendance.csv'), 'report/chapters/doc.md')
    expect((await folioContaining(w.ws, 'report/chapters/doc.md'))?.dir).toBe('report')
    writeFileSync(join(w.root, 'report/chapters/_report-structure.json'), FOLIO(['doc.md']))
    expect(await pickStillAuthorised(w.ws, realpathSync(w.root), p)).toBe('report, the folder report/chapters/doc.md was in when attendance.csv was chosen, has changed since, so nothing was written. Choose the file again.')
  })

  test('P2a: a file written over that the snapshot did not hold (a carried link) counts as put back only when it holds the bytes its writer noted, and those bytes are the recorded text', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'elsewhere/links.md': '[r](../report/report.md)\n' })
    const log: OperationWrite[] = []
    const noted = new Map<string, Buffer>()
    await recordingBytesBefore(noted, () => w.ws.recordingOperationWrites(log, async () => {
      noteBytesBefore('elsewhere/links.md', readFileSync(join(w.root, 'elsewhere/links.md')))
      await w.ws.saveFile('elsewhere/links.md', '[r](../report/Report/report.md)\n', { documentOnly: true })
    }))
    await rollBackOperationWrites(w.ws, log)
    expect(await leftAsBefore(w.root, log, new Map(), noted)).toBe(true)
    // No bytes noted: not shown to be as before.
    expect(await leftAsBefore(w.root, log, new Map())).toBe(false)
    // Noted bytes that are not the text the record kept (the file changed between the note and the write): not as
    // before, even though the file now holds the noted bytes.
    const otherRecord: OperationWrite[] = [{ ...log[0], before: '[r](../report/elsewhere.md)\n' }]
    expect(await leftAsBefore(w.root, otherRecord, new Map(), noted)).toBe(false)
    writeFileSync(join(w.root, 'elsewhere/links.md'), '[r](../report/report.md)\n\n')
    expect(await leftAsBefore(w.root, log, new Map(), noted)).toBe(false)
  })
})

describe('Review r4 fixes', () => {
  type Handler = (event: { sender: { id: number } }, input: unknown) => Promise<unknown>
  const event = { sender: { id: OWNER } }
  const withStore = <T>(w: World, run: () => Promise<T>): Promise<T> => { setAppSyncGrantStore(w.store); return run().finally(() => setAppSyncGrantStore(null)) }
  function channels(w: World): Map<string, Handler> {
    const handlers = new Map<string, Handler>()
    registerStandardWidgetHandlers({ handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) } } as never, {
      workspaceFor: () => w.ws, notifyChanged: () => {}, pickDialog: () => dialogFor(join(w.outside, 'attendance.csv')),
    }, w.desk, w.picks)
    return handlers
  }

  test('P2a: a linked note holding a literal U+FFFD, rewritten by the move and put back byte for byte after a late failure: nothingLeft is true and the token is handed back', async () => {
    const note = '# Elsewhere \uFFFD kept as written\n\n[r](../notes/report.md) and [[report]]\n'
    const w = world({ 'notes/report.md': DOC, 'notes/other.md': '# Other\n', 'elsewhere/links.md': note })
    const before = readFileSync(join(w.root, 'elsewhere/links.md'))
    const files = snapshot(w.root)
    const handlers = channels(w)
    const picked = await handlers.get('standard-widget:pick-source')!(event, { documentPath: 'notes/report.md' }) as PickAnswer
    if (!picked.ok || picked.inside) throw new Error('token expected')
    const facts = await readOwnFolderFacts(w.ws, { documentPath: 'notes/report.md', name: 'Attendance' })
    if (!facts.ok || !facts.needed) throw new Error('sheet expected')
    const answer: OwnFolderChoice = initialOwnFolderChoice(facts.facts)
    const placement = { ...answer, fingerprint: planFingerprint(planOwnFolder(facts.facts, answer)) }
    let rewritten = ''
    operationSeams.beforeRemovingOriginals = () => { rewritten = read(w.root, 'elsewhere/links.md'); throw new Error('a late failure') }
    const refused = await withStore(w, () => handlers.get('standard-widget:create')!(event, { documentPath: 'notes/report.md', name: 'Attendance', recipe: recipe(), pick: { token: picked.token, inclusion: 'sync' }, placement })) as { ok: boolean; nothingLeft?: boolean }
    expect(rewritten).not.toBe(note)
    expect(refused).toMatchObject({ ok: false, nothingLeft: true })
    expect(readFileSync(join(w.root, 'elsewhere/links.md')).equals(before)).toBe(true)
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
    expect(w.picks.get(picked.token, OWNER, w.ws.root, 'notes/report.md')).not.toBeNull()
  })

  const MALFORMED = '{ "files": [ { "path": "doc.md" }, '
  test('P2b: a malformed manifest in report/chapters/: the pick is refused by name ("can\'t be read"), nothing held', async () => {
    const w = world({ 'report/chapters/doc.md': DOC, 'report/_report-structure.json': FOLIO(['chapters/doc.md']), 'report/chapters/_report-structure.json': MALFORMED })
    const files = snapshot(w.root)
    expect(await pick(w, join(w.outside, 'attendance.csv'), 'report/chapters/doc.md')).toEqual({ ok: false, message: 'The manifest report/chapters/_report-structure.json can\'t be read, so WriteFlex cannot tell which Folio report/chapters/doc.md is in; nothing was written.' })
    expect(snapshot(w.root)).toEqual(files)
  })

  test('P2b: a pick uses the shared outer Folio, and malformed nested metadata still refuses the create by name; nothing written, no grant', async () => {
    const w = world({ 'report/chapters/doc.md': DOC, 'report/_report-structure.json': FOLIO(['chapters/doc.md']), 'report/chapters/_report-structure.json': FOLIO(['doc.md']) })
    const p = await outsidePick(w, join(w.outside, 'attendance.csv'), 'report/chapters/doc.md')
    expect(p.folder.path).toBe('report')
    writeFileSync(join(w.root, 'report/chapters/_report-structure.json'), MALFORMED)
    // Readers select the outer Folio; the pick's original boundary still refuses unreadable metadata.
    expect((await folioContaining(w.ws, 'report/chapters/doc.md'))?.dir).toBe('report')
    const files = snapshot(w.root)
    const made = await createStandardWidget(w.ws, w.desk, { documentPath: 'report/chapters/doc.md', name: 'Attendance', recipe: recipe(), outside: { pick: p, inclusion: 'sync' } }, { grants: w.store })
    expect(made).toMatchObject({ ok: false, message: 'The manifest report/chapters/_report-structure.json can\'t be read, so WriteFlex cannot tell which Folio report/chapters/doc.md is in; nothing was written.' })
    expect(snapshot(w.root)).toEqual(files)
    expect(existsSync(w.storeFile)).toBe(false)
  })

  test('P2b: at the write, a destination that is not the pick\'s Folio is refused by name, nothing written', async () => {
    const w = world({ 'report/report.md': DOC, 'report/_report-structure.json': FOLIO(['report.md']), 'other/other.md': DOC, 'other/_report-structure.json': FOLIO(['other.md']) })
    const p = await outsidePick(w)
    const files = snapshot(w.root)
    const grants: GrantWrite[] = []
    await expect(w.ws.recordingOperationWrites([], () => intakeOutsideFile(w.ws, realpathSync(w.root), 'other', [], p, 'sync', grants, { store: w.store, manifestExisted: true, document: 'report/report.md' })))
      .rejects.toThrow('other is not the Folio report/report.md is in, the document attendance.csv was chosen for, so nothing was written')
    expect(snapshot(w.root)).toEqual(files)
    expect(grants).toEqual([])
    expect(existsSync(w.storeFile)).toBe(false)
  })
})
