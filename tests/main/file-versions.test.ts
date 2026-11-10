/**
 * Ticket 19 of Folio versions (ADR-0052): versions of an inserted file (a table, a widget page, an image).
 *
 * Seams: the file-version operations (src/main/file-versions.ts: list, save, compare, restore, save as a copy) over a synthetic Folio on a temporary
 * Collection, with real Folio versions made by the app's own save (`requestedFolioVersionSave`) so that "used by" is derived from real members; the
 * shared reader a read-only Folio version opens through, to show that an old Folio version keeps its old numbers; and the app's binding
 * (`requestedFileVersion`), which owns the Collection-binding and `confirmOwner` rules. Synthetic files only.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotHashesOf } from '../../src/main/cli/history-store'
import { gatedSnapshots } from '../../src/main/gated-snapshots'
import { ChangeStore } from '../../src/main/changes'
import { resumeCollectionWrites } from '../../src/main/collection-write-gate'
import { FolioVersionStore } from '../../src/main/folio-versions'
import { readMemberAtVersion } from '../../src/main/folio-version-reader'
import { defaultReaderSources } from '../../src/main/folio-version-sources'
import { requestedFolioVersionSave } from '../../src/main/requested-folio-version-save'
import { snapshotBytesOfSavedText, snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import { readSnapshotBytesWithin } from '../../src/main/file-version-sources'
import { checkedFilePath, compareFileVersions, FileVersionRefused, listFileVersions, restoreFileVersion, saveFileVersion, saveFileVersionAsCopy, type FileVersionStores } from '../../src/main/file-versions'
import { requestedFileVersion } from '../../src/main/requested-file-version'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { restoredName, suggestedCopyName, usedBySentence, versionTitle, workingSentence } from '../../src/shared/file-versions'

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const author = { name: 'App Writer' }
const FOLIO = 'report'
const INDEX = `${FOLIO}/_report_INDEX.md`
const CSV = `${FOLIO}/data/scores-3.csv`
const PNG_PATH = `${FOLIO}/assets/fig.png`
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01])
const CSV_1 = 'Judge,Pairs,Prefer A,Ties\nJudge 1,120,51,9\nJudge 2,120,47,7\n'
const CSV_2 = 'Judge,Pairs,Prefer A,Ties\nJudge 1,120,49,11\nJudge 2,120,47,7\n'
const CSV_3 = 'Judge,Pairs,Prefer A,Ties\nJudge 1,120,49,11\nJudge 2,120,45,9\nJudge 3,120,55,7\n'

let root: string
let ws: Workspace
let versions: VersionStore
let folio: FolioVersionStore
const owner = async (): Promise<void> => {}

async function put(rel: string, content: string | Buffer): Promise<void> {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content)
}
async function buildFolio(): Promise<void> {
  await put(INDEX, '---\ntitle: Pilot paper\n---\n\n# Pilot paper\n\n## Running order\n\n- [[./p01.md|Part 1]]\n- [[./p02.md|Part 2]]\n')
  await put(`${FOLIO}/p01.md`, '# Part 1\n\nText 1.\n\n![Scores](data/scores-3.csv)\n')
  await put(`${FOLIO}/p02.md`, '# Part 2\n\nText 2.\n\n![Figure](assets/fig.png)\n')
  await put(CSV, CSV_1)
  await put(PNG_PATH, PNG)
}

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf19-fv-')))
  ws = new Workspace(root)
  versions = new VersionStore(ws)
  folio = new FolioVersionStore(ws)
})
const copies: string[] = []
afterEach(async () => {
  resumeCollectionWrites(root)
  await rm(root, { recursive: true, force: true })
  for (const copy of copies.splice(0)) await rm(copy, { recursive: true, force: true })
})

async function snapshot(path: string): Promise<{ versionId: string; snapshotId: string }> {
  const { SnapshotStore } = await import('@bridle/core')
  const snapshots = gatedSnapshots(root, await SnapshotStore.open({ dir: join(root, '.bridle') }))
  return snapshotVersionOfSavedText({ workspace: ws, snapshots, sessionId: 'test-session', path })
}
/** What the app's agent does for a file version (`snapshotVersionBytes`): the bytes it is given, never a read of the file. */
async function snapshotBytes(path: string, bytes: Uint8Array): Promise<{ versionId: string; snapshotId: string }> {
  const { SnapshotStore } = await import('@bridle/core')
  const snapshots = gatedSnapshots(root, await SnapshotStore.open({ dir: join(root, '.bridle') }))
  return snapshotBytesOfSavedText({ workspace: ws, snapshots, sessionId: 'test-session', path, bytes })
}
function stores(over: Partial<FileVersionStores> = {}): FileVersionStores {
  return {
    workspace: ws, versions, folioVersions: folio, snapshotBytes, author,
    snapshotHashes: (ids) => snapshotHashesOf(root, ids),
    readSnapshotBytes: (id, max) => readSnapshotBytesWithin(root, id, max),
    confirmOwner: owner,
    ...over,
  }
}
/** A real Folio save by the app's own code, with the backup scope widened (inserted files are not Markdown). */
function folioSave(): ReturnType<typeof requestedFolioVersionSave> {
  return requestedFolioVersionSave({
    workspace: ws, versions, changes: new ChangeStore(ws), live: () => true, author: async () => author,
    agent: async () => ({ workspace: ws, snapshotReviewVersion: snapshot }),
  }, { isDocument: () => true })
}
const objects = async (): Promise<string[]> => (await readdir(join(root, '.bridle/objects')).catch(() => [] as string[])).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort()
const versionLines = async (): Promise<string[]> => (await readFile(join(root, '.writeflex/versions.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
const strays = async (rel: string): Promise<string[]> => (await readdir(join(root, rel))).filter((name) => /\.tmp$|~$/.test(name))

test('saving a version of scores-3.csv, editing it, and opening the old Folio version read-only still shows the old numbers', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  expect(v1.version.number).toBe(1)
  const sheet = await folioSave()({ dir: FOLIO, name: 'First full draft' }, owner)
  await writeFile(join(root, CSV), CSV_2)
  await saveFileVersion(stores(), { path: CSV, name: 'Outliers removed' })
  await writeFile(join(root, CSV), CSV_3)
  // The Folio version's reader (what the read-only view, Compare and Export read through) still has the first numbers.
  const member = await readMemberAtVersion(defaultReaderSources(ws), FOLIO, sheet.record.id, CSV)
  expect(member?.text).toBe(CSV_1)
  // And so does the saved copy of that file version, byte for byte.
  expect(Buffer.from(member!.bytes).equals(Buffer.from(CSV_1))).toBe(true)
})

test('each file version lists the Folio versions that used it, derived from the members and stored nowhere', async () => {
  await buildFolio()
  await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  const a = await folioSave()({ dir: FOLIO, name: 'First full draft' }, owner)
  const b = await folioSave()({ dir: FOLIO, name: 'Draft for Sam Rowe' }, owner)
  await writeFile(join(root, CSV), CSV_2)
  await saveFileVersion(stores(), { path: CSV, name: 'Outliers removed' })
  const c = await folioSave()({ dir: FOLIO, name: 'After pilot numbers' }, owner)

  const before = await versionLines()
  const folioLines = await readFile(join(root, '.writeflex/folio-versions.jsonl'), 'utf8')
  const listing = await listFileVersions(stores(), CSV)
  // Nothing was written to read it.
  expect(await versionLines()).toEqual(before)
  expect(await readFile(join(root, '.writeflex/folio-versions.jsonl'), 'utf8')).toBe(folioLines)

  expect(listing.versions.map((row) => [row.number, row.name])).toEqual([[2, 'Outliers removed'], [1, 'Pilot run']])
  const [v2, v1] = listing.versions
  expect(v1!.usedBy.map((use) => use.id).sort()).toEqual([a.record.id, b.record.id].sort())
  expect(v2!.usedBy.map((use) => use.id)).toEqual([c.record.id])
  expect(usedBySentence(v2!.usedBy)).toBe('used by Folio “After pilot numbers”')
  expect(usedBySentence(v1!.usedBy)).toMatch(/^used by 2 Folio versions, the last “Draft for Sam Rowe”$/)
  expect(usedBySentence([])).toBe('not used by any Folio version')
  // Reuse by a Folio save appended no per-file record for the file: the version the Folio saves point at are the writer's own.
  expect(listing.versions.every((row) => !row.automatic)).toBe(true)
  // The working copy is the newest version.
  expect(listing.working).toMatchObject({ state: 'same', as: { number: 2 } })
  expect(v2!.isWorking).toBe(true)
})

test('a Folio save that finds a changed file adds an automatic version, labelled so, which the file lists with the Folio version that made it', async () => {
  await buildFolio()
  const first = await folioSave()({ dir: FOLIO, name: 'First' }, owner)
  const listing = await listFileVersions(stores(), CSV)
  expect(listing.versions).toHaveLength(1)
  expect(listing.versions[0]).toMatchObject({ name: 'Folio version: First', automatic: true, number: 1 })
  expect(listing.versions[0]!.usedBy.map((use) => use.id)).toEqual([first.record.id])
})

test('the working copy is reported against the newest version: changed (with cells for a table), same, unversioned, missing', async () => {
  await buildFolio()
  expect((await listFileVersions(stores(), CSV)).working).toEqual({ state: 'unversioned' })
  await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  const changed = await listFileVersions(stores(), CSV)
  expect(changed.working).toMatchObject({ state: 'changed', since: { number: 1, name: 'Pilot run' }, cellsChanged: 2 })
  expect(workingSentence(changed.working, changed.kind)).toBe('unsaved · 2 cells changed since v1')
  expect(changed.workingSha256).toBe(sha(CSV_2))
  await rm(join(root, CSV))
  expect((await listFileVersions(stores(), CSV)).working).toEqual({ state: 'missing' })
})

test('saving refuses a name that is blank, a file with no change since its newest version, a Markdown document, a hidden folder, a path out of the Collection and a missing file', async () => {
  await buildFolio()
  await expect(saveFileVersion(stores(), { path: CSV, name: '   ' })).rejects.toThrow('Name the version')
  await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await expect(saveFileVersion(stores(), { path: CSV, name: 'Again' })).rejects.toMatchObject({ code: 'unchanged' })
  await expect(saveFileVersion(stores(), { path: `${FOLIO}/p01.md`, name: 'x' })).rejects.toMatchObject({ code: 'markdown' })
  for (const path of ['../outside.csv', '/etc/passwd', `${FOLIO}\\data\\scores-3.csv`, `${FOLIO}/data/../data/scores-3.csv`, '.writeflex/versions.jsonl', '.bridle/journal.jsonl', 'node_modules/x.csv', '']) {
    await expect(saveFileVersion(stores(), { path, name: 'x' })).rejects.toBeInstanceOf(FileVersionRefused)
  }
  await expect(saveFileVersion(stores(), { path: `${FOLIO}/data/none.csv`, name: 'x' })).rejects.toMatchObject({ code: 'not-found' })
  expect((await versions.list({ path: CSV })).length).toBe(1)
  expect(() => checkedFilePath(ws, 12)).toThrow(FileVersionRefused)
})

test('a file that is a link is refused: nothing is saved, listed, restored or copied through it', async () => {
  await buildFolio()
  await put('elsewhere.csv', 'a,b\n1,2\n')
  await symlink(join(root, 'elsewhere.csv'), join(root, `${FOLIO}/data/linked.csv`))
  await expect(saveFileVersion(stores(), { path: `${FOLIO}/data/linked.csv`, name: 'x' })).rejects.toBeInstanceOf(FileVersionRefused)
  expect((await listFileVersions(stores(), `${FOLIO}/data/linked.csv`)).working).toMatchObject({ state: 'unreadable' })
  expect(await versionLines()).toEqual([])
})

test('two versions of identical image bytes store one object, however many versions say so', async () => {
  await buildFolio()
  await saveFileVersion(stores(), { path: PNG_PATH, name: 'First' })
  await writeFile(join(root, PNG_PATH), Buffer.from([1, 2, 3]))
  await saveFileVersion(stores(), { path: PNG_PATH, name: 'Different' })
  await writeFile(join(root, PNG_PATH), PNG)
  await saveFileVersion(stores(), { path: PNG_PATH, name: 'First again' })
  const listing = await listFileVersions(stores(), PNG_PATH)
  expect(listing.versions).toHaveLength(3)
  expect(listing.versions[0]!.sha256).toBe(listing.versions[2]!.sha256)
  expect(listing.versions[0]!.sha256).toBe(sha(PNG))
  expect(await objects()).toEqual([sha(PNG), sha(Buffer.from([1, 2, 3]))].sort())
})

test('a file over 25 MiB is not given versions, and is not read: it is a reference, and the answer says so', async () => {
  await buildFolio()
  const big = `${FOLIO}/assets/big.bin`
  await put(big, 'x')
  await truncate(join(root, big), 25 * 1024 * 1024 + 1)
  const listing = await listFileVersions(stores(), big)
  expect(listing.working).toMatchObject({ state: 'too-large', bytes: 25 * 1024 * 1024 + 1 })
  expect(workingSentence(listing.working, listing.kind)).toContain('reference')
  expect(listing.workingSha256).toBeNull()
  await expect(saveFileVersion(stores(), { path: big, name: 'Big' })).rejects.toMatchObject({ code: 'too-large' })
  await expect(saveFileVersion(stores(), { path: big, name: 'Big' })).rejects.toThrow(/25 MiB.*reference/s)
  expect(await versionLines()).toEqual([])
  expect(await objects()).toEqual([])
  // Exactly at the cap is still kept.
  const edge = `${FOLIO}/assets/edge.bin`
  await put(edge, 'x')
  await truncate(join(root, edge), 25 * 1024 * 1024)
  expect((await saveFileVersion(stores(), { path: edge, name: 'Edge' })).version.number).toBe(1)
})

test('a saved copy over the cap is refused from its object size, before it is read', async () => {
  await buildFolio()
  await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  const small = stores({ cap: 10 })
  expect(await readSnapshotBytesWithin(root, (await versions.list({ path: CSV }))[0]!.snapshotId!, 10)).toBe('too-large')
  await writeFile(join(root, CSV), CSV_2)
  await expect(compareFileVersions(small, { path: CSV, from: (await versions.list({ path: CSV }))[0]!.id, to: 'working' })).rejects.toMatchObject({ code: 'too-large' })
})

test('Compare shows the cells that differ, and counts them', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  const v2 = await saveFileVersion(stores(), { path: CSV, name: 'Outliers removed' })
  await writeFile(join(root, CSV), CSV_3)

  const result = await compareFileVersions(stores(), { path: CSV, from: v1.version.id, to: v2.version.id })
  expect(result.kind).toBe('table')
  if (result.kind !== 'table') return
  expect(result.cellsDiffering).toBe(2)
  expect(result.from.label).toBe('v1 · Pilot run')
  expect(result.to.label).toBe('v2 · Outliers removed')
  expect(result.header.map((cell) => cell.after)).toEqual(['Judge', 'Pairs', 'Prefer A', 'Ties'])
  const changed = result.rows.flatMap((row, r) => row.flatMap((cell, c) => (cell.before !== cell.after ? [[r, c, cell.before, cell.after]] : [])))
  expect(changed).toEqual([[0, 2, '51', '49'], [0, 3, '9', '11']])

  // Against the working copy: a row added counts each of its cells.
  const against = await compareFileVersions(stores(), { path: CSV, from: v2.version.id, to: 'working' })
  expect(against.kind === 'table' && against.cellsDiffering).toBe(2 + 4)
  if (against.kind === 'table') expect(against.to.label).toBe('Working copy')
  // A refused end: an id that is not this file's.
  await expect(compareFileVersions(stores(), { path: CSV, from: 'nope', to: 'working' })).rejects.toMatchObject({ code: 'not-found' })
})

test('Compare of an image or a widget says whether it differs, and counts the lines of a page that reads as text', async () => {
  await buildFolio()
  const html = `${FOLIO}/assets/widget.html`
  await put(html, '<p>one</p>\n<p>two</p>\n<p>three</p>\n')
  const h1 = await saveFileVersion(stores(), { path: html, name: 'First widget' })
  await put(html, '<p>one</p>\n<p>TWO</p>\n<p>three</p>\n')
  const page = await compareFileVersions(stores(), { path: html, from: h1.version.id, to: 'working' })
  expect(page).toMatchObject({ kind: 'other', fileKind: 'widget', same: false, linesChanged: 1 })
  const p1 = await saveFileVersion(stores(), { path: PNG_PATH, name: 'First' })
  await writeFile(join(root, PNG_PATH), Buffer.from([0x89, 0xff, 0x00]))
  const image = await compareFileVersions(stores(), { path: PNG_PATH, from: p1.version.id, to: 'working' })
  expect(image).toMatchObject({ kind: 'other', fileKind: 'image', same: false, linesChanged: null })
  expect(image.from.bytes).toBe(PNG.length)
  expect(image.to.bytes).toBe(3)
})

test('restoring a file version appends a new version, keeps the earlier ones, and puts the saved bytes back whole', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  await saveFileVersion(stores(), { path: CSV, name: 'Outliers removed' })
  const before = await listFileVersions(stores(), CSV)
  const row = before.versions.find((candidate) => candidate.id === v1.version.id)!
  const lines = (await versionLines()).length

  const done = await restoreFileVersion(stores(), { path: CSV, versionId: row.id, expectVersionSha256: row.sha256!, expectWorkingSha256: before.workingSha256 })
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_1)
  // The working copy equalled v2, so nothing needed saving first; one version was appended.
  expect(done.safety).toBeNull()
  expect(done.restored).toMatchObject({ name: 'Restored: Pilot run', number: 3 })
  expect((await versionLines()).length).toBe(lines + 1)
  const after = await listFileVersions(stores(), CSV)
  expect(after.versions.map((r) => r.name)).toEqual(['Restored: Pilot run', 'Outliers removed', 'Pilot run'])
  expect(after.versions[0]!.sha256).toBe(after.versions[2]!.sha256)
  expect(after.versions[0]!.note).toContain('v1')
  // Earlier versions are as they were, and no second object was stored for the same bytes.
  expect(after.versions.slice(1).map((r) => r.sha256)).toEqual(before.versions.map((r) => r.sha256))
  expect(await objects()).toEqual([sha(CSV_1), sha(CSV_2)].sort())
  expect(await strays(`${FOLIO}/data`)).toEqual([])
  expect(after.working).toMatchObject({ state: 'same', as: { number: 3 } })
})

test('a version a Folio save took is named by that Folio version; restoring it is named "Restored v1", not by the long automatic name', async () => {
  await buildFolio()
  await folioSave()({ dir: FOLIO, name: 'First full draft' }, owner)
  await writeFile(join(root, CSV), CSV_2)
  await saveFileVersion(stores(), { path: CSV, name: 'Outliers removed' })
  const listing = await listFileVersions(stores(), CSV)
  const first = listing.versions.find((row) => row.number === 1)!
  expect(first).toMatchObject({ name: 'Folio version: First full draft', automatic: true })
  expect(versionTitle(first)).toBe('Saved with “First full draft”')
  expect(versionTitle(listing.versions[0]!)).toBe('Outliers removed')
  const done = await restoreFileVersion(stores(), { path: CSV, versionId: first.id, expectVersionSha256: first.sha256!, expectWorkingSha256: listing.workingSha256 })
  expect(done.restored.name).toBe('Restored v1')
  expect(restoredName(first)).toBe('Restored v1')
  expect(restoredName(listing.versions[0]!)).toBe('Restored: Outliers removed')
})

test('a restore keeps a working copy no version holds: it is saved first as "Before restoring v1", then replaced', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_3)
  const listing = await listFileVersions(stores(), CSV)
  const done = await restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: listing.workingSha256 })
  expect(done.safety).toMatchObject({ name: 'Before restoring v1' })
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_1)
  const after = await listFileVersions(stores(), CSV)
  expect(after.versions.map((r) => r.name)).toEqual(['Restored: Pilot run', 'Before restoring v1', 'Pilot run'])
  // The replaced text is a version, byte for byte.
  expect(after.versions[1]!.sha256).toBe(sha(CSV_3))
  expect(done.restored.number).toBe(3)
})

test('a restore is bound to what the writer saw: a different working copy, or a different saved copy, writes nothing', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  const listing = await listFileVersions(stores(), CSV)
  const wanted = listing.versions[0]!.sha256!
  const lines = await versionLines()
  // The file changed after the writer looked.
  await writeFile(join(root, CSV), CSV_3)
  await expect(restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: wanted, expectWorkingSha256: listing.workingSha256 })).rejects.toMatchObject({ code: 'changed' })
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_3)
  // The saved copy is not the one the writer was looking at.
  await expect(restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: sha('another'), expectWorkingSha256: sha(CSV_3) })).rejects.toMatchObject({ code: 'changed' })
  // A malformed fingerprint is not a restore at all.
  await expect(restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: 'abc', expectWorkingSha256: sha(CSV_3) })).rejects.toBeInstanceOf(FileVersionRefused)
  await expect(restoreFileVersion(stores(), { path: CSV, versionId: 'v_nope', expectVersionSha256: wanted, expectWorkingSha256: sha(CSV_3) })).rejects.toMatchObject({ code: 'not-found' })
  expect(await versionLines()).toEqual(lines)
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_3)
})

test('a restore of what the file already holds is refused, and a restore of a deleted file creates it', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  const listing = await listFileVersions(stores(), CSV)
  await expect(restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: listing.workingSha256 })).rejects.toMatchObject({ code: 'same' })
  await rm(join(root, CSV))
  const done = await restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: null })
  expect(done.safety).toBeNull()
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_1)
  // A file that appeared after the writer saw "no file" is not overwritten.
  await rm(join(root, CSV))
  await put(CSV, 'new,file\n')
  await expect(restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: null })).rejects.toMatchObject({ code: 'changed' })
  expect(await readFile(join(root, CSV), 'utf8')).toBe('new,file\n')
})

test('a restore through a binary file puts the bytes back exactly (an image is not decoded as text)', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: PNG_PATH, name: 'First' })
  await writeFile(join(root, PNG_PATH), Buffer.from([9, 9, 9]))
  const listing = await listFileVersions(stores(), PNG_PATH)
  await restoreFileVersion(stores(), { path: PNG_PATH, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: listing.workingSha256 })
  expect((await readFile(join(root, PNG_PATH))).equals(PNG)).toBe(true)
})

test('a restore leaves the old file whole if the write is refused (a link standing at the name): nothing is written, no version recorded', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  const listing = await listFileVersions(stores(), CSV)
  const lines = await versionLines()
  await put('elsewhere.csv', 'precious,data\n')
  await expect(restoreFileVersion(stores({ seams: { betweenCheckAndWrite: async () => { await rm(join(root, CSV)); await symlink(join(root, 'elsewhere.csv'), join(root, CSV)) } } }), {
    path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: listing.workingSha256,
  })).rejects.toBeInstanceOf(FileVersionRefused)
  expect(await readFile(join(root, 'elsewhere.csv'), 'utf8')).toBe('precious,data\n')
  expect(await strays(`${FOLIO}/data`)).toEqual([])
  expect((await versionLines()).length).toBe(lines.length + 1) // only the safety version of the file as it stood: nothing says "Restored"
  expect((await versions.list({ path: CSV })).some((v) => v.name.startsWith('Restored'))).toBe(false)
})

test('"Save v1 as a copy" writes one new ordinary file beside the original, keeps its type, and writes no version', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  const listing = await listFileVersions(stores(), CSV)
  const before = await readdir(join(root, FOLIO, 'data'))
  const lines = await versionLines()
  expect(before).toEqual(['scores-3.csv'])

  const done = await saveFileVersionAsCopy(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, name: suggestedCopyName(CSV, 1) })
  expect(done.path).toBe(`${FOLIO}/data/scores-3 (v1).csv`)
  expect(await readFile(join(root, done.path), 'utf8')).toBe(CSV_1)
  // The working file is untouched; the copy is the only new file; no version record was written for it.
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_2)
  expect((await readdir(join(root, FOLIO, 'data'))).sort()).toEqual(['scores-3 (v1).csv', 'scores-3.csv'])
  expect(await versionLines()).toEqual(lines)
  expect(await strays(`${FOLIO}/data`)).toEqual([])
  // A name with no extension takes the file's own.
  const second = await saveFileVersionAsCopy(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, name: 'pilot numbers' })
  expect(second.path).toBe(`${FOLIO}/data/pilot numbers.csv`)
})

test('"Save as a copy" never overwrites: a name that is taken is refused, even by a file that appears at the last moment', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  const listing = await listFileVersions(stores(), CSV)
  const input = { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, name: 'taken.csv' }
  await put(`${FOLIO}/data/taken.csv`, 'mine,do not touch\n')
  await expect(saveFileVersionAsCopy(stores(), input)).rejects.toMatchObject({ code: 'exists' })
  expect(await readFile(join(root, `${FOLIO}/data/taken.csv`), 'utf8')).toBe('mine,do not touch\n')
  // Created between the check and the write.
  await rm(join(root, `${FOLIO}/data/taken.csv`))
  await expect(saveFileVersionAsCopy(stores({ seams: { betweenCheckAndWrite: async () => { await writeFile(join(root, `${FOLIO}/data/taken.csv`), 'appeared\n') } } }), input)).rejects.toMatchObject({ code: 'exists' })
  expect(await readFile(join(root, `${FOLIO}/data/taken.csv`), 'utf8')).toBe('appeared\n')
  // The original name is a name that is taken too.
  await expect(saveFileVersionAsCopy(stores(), { ...input, name: 'scores-3.csv' })).rejects.toMatchObject({ code: 'exists' })
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_1)
  // A link at the name is not followed.
  await put('elsewhere.csv', 'outside\n')
  await symlink(join(root, 'elsewhere.csv'), join(root, `${FOLIO}/data/linked.csv`))
  await expect(saveFileVersionAsCopy(stores(), { ...input, name: 'linked.csv' })).rejects.toBeInstanceOf(FileVersionRefused)
  expect(await readFile(join(root, 'elsewhere.csv'), 'utf8')).toBe('outside\n')
})

test('"Save as a copy" takes a file name only: a folder, a hidden name or a Markdown name is refused and nothing is written', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  const listing = await listFileVersions(stores(), CSV)
  const base = { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256! }
  for (const name of ['', '   ', '../escape.csv', 'sub/dir.csv', '/abs.csv', '.hidden.csv', '..', 'a\\b.csv', 'a:b.csv', 'x'.repeat(300)]) {
    await expect(saveFileVersionAsCopy(stores(), { ...base, name })).rejects.toBeInstanceOf(FileVersionRefused)
  }
  await expect(saveFileVersionAsCopy(stores(), { ...base, name: 'wrong hash.csv', expectVersionSha256: sha('other') })).rejects.toMatchObject({ code: 'changed' })
  await expect(saveFileVersionAsCopy(stores(), { ...base, name: 'x.csv', versionId: 'v_nope' })).rejects.toMatchObject({ code: 'not-found' })
  expect(await readdir(join(root, FOLIO, 'data'))).toEqual(['scores-3.csv'])
  expect(await stat(join(root, FOLIO, 'data'))).toBeTruthy()
})

test('every write asks the owner first: a Collection this process no longer holds is never written', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await writeFile(join(root, CSV), CSV_2)
  const listing = await listFileVersions(stores(), CSV)
  const lost = stores({ confirmOwner: async () => { throw new FileVersionRefused('Another WriteFlex has this Collection.') } })
  const lines = await versionLines()
  await expect(saveFileVersion(lost, { path: CSV, name: 'Later' })).rejects.toThrow('Another WriteFlex')
  await expect(restoreFileVersion(lost, { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: listing.workingSha256 })).rejects.toThrow('Another WriteFlex')
  await expect(saveFileVersionAsCopy(lost, { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, name: 'copy.csv' })).rejects.toThrow('Another WriteFlex')
  expect(await versionLines()).toEqual(lines)
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_2)
  expect(await readdir(join(root, FOLIO, 'data'))).toEqual(['scores-3.csv'])
  // And it is asked again after each wait: a loss part-way through a restore stops before the file is written.
  let asked = 0
  const losesAtThird = stores({ confirmOwner: async () => { asked += 1; if (asked >= 2) throw new FileVersionRefused('Lost it.') } })
  await expect(restoreFileVersion(losesAtThird, { path: CSV, versionId: v1.version.id, expectVersionSha256: listing.versions[0]!.sha256!, expectWorkingSha256: listing.workingSha256 })).rejects.toThrow('Lost it.')
  expect(await readFile(join(root, CSV), 'utf8')).not.toBe(CSV_1)
})

test('the app binding is tied to its Collection: a window that moved on writes nothing, and a read-only file is refused whole', async () => {
  await buildFolio()
  let live = true
  const bound = requestedFileVersion({
    workspace: ws, versions, live: () => live, author: async () => author,
    agent: async () => ({ workspace: ws, snapshotVersionBytes: snapshotBytes }),
  })
  const saved = await bound.save({ path: CSV, name: 'Pilot run' }, owner)
  expect(saved.version.number).toBe(1)
  live = false
  await writeFile(join(root, CSV), CSV_2)
  await expect(bound.save({ path: CSV, name: 'Too late' }, owner)).rejects.toThrow('no longer has this Collection open')
  const other = new VersionStore(new Workspace(realpathSync(await mkdtemp(join(tmpdir(), 'wf19-other-')))))
  copies.push(other.root)
  const wrong = requestedFileVersion({ workspace: ws, versions: other, live: () => true, author: async () => author, agent: async () => ({ workspace: ws, snapshotVersionBytes: snapshotBytes }) })
  await expect(wrong.save({ path: CSV, name: 'Wrong store' }, owner)).rejects.toThrow('another Collection')
  const noAgent = requestedFileVersion({ workspace: ws, versions, live: () => true, author: async () => author, agent: async () => null })
  await expect(noAgent.save({ path: CSV, name: 'No agent' }, owner)).rejects.toThrow('no history store')
  expect((await versions.list({ path: CSV })).map((v) => v.name)).toEqual(['Pilot run'])
  await chmod(join(root, CSV), 0o644)
})

test('versions are listed by path: another file with the same name in another folder has none', async () => {
  await buildFolio()
  await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  // The listing is by path; an unrelated file with the same name elsewhere has none.
  await put(`${FOLIO}/data/other/scores-3.csv`, CSV_2)
  expect((await listFileVersions(stores(), `${FOLIO}/data/other/scores-3.csv`)).versions).toEqual([])
})

// ---- Codex review of PR 229 ---------------------------------------------------------------------------------------------------

test('restore does not count a working copy as kept when the object that held it is gone: it is saved again first, and the restore goes on', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'First' })
  await writeFile(join(root, CSV), CSV_2)
  const v2 = await saveFileVersion(stores(), { path: CSV, name: 'Second' })
  // The history store loses v2's object; the journal and versions.jsonl still name it, and the file still holds those bytes.
  await rm(join(root, '.bridle/objects', sha(CSV_2)))
  expect(await objects()).toEqual([sha(CSV_1)])
  const listing = await listFileVersions(stores(), CSV)
  const done = await restoreFileVersion(stores(), { path: CSV, versionId: v1.version.id, expectVersionSha256: sha(CSV_1), expectWorkingSha256: sha(CSV_2) })
  expect(done.safety).toMatchObject({ name: 'Before restoring v1' })
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_1)
  // The replaced bytes are back in the store and held by the safety version, byte for byte.
  expect(await objects()).toEqual([sha(CSV_1), sha(CSV_2)].sort())
  const after = await listFileVersions(stores(), CSV)
  expect(after.versions.map((row) => row.name)).toEqual(['Restored: First', 'Before restoring v1', 'Second', 'First'])
  const safety = (await versions.list({ path: CSV })).find((version) => version.id === done.safety!.id)!
  expect((await readSnapshotBytesWithin(root, safety.snapshotId!, 1024)) as Buffer).toEqual(Buffer.from(CSV_2))
  expect(listing.versions[0]!.id).toBe(v2.version.id)
})

test('saving a file whose newest version has lost its object is not "unchanged": the bytes are saved again', async () => {
  await buildFolio()
  await saveFileVersion(stores(), { path: CSV, name: 'Pilot run' })
  await rm(join(root, '.bridle/objects', sha(CSV_1)))
  const again = await saveFileVersion(stores(), { path: CSV, name: 'Pilot run, kept again' })
  expect(again.version.number).toBe(2)
  expect(await objects()).toEqual([sha(CSV_1)])
})

test('a restore and a copy check the Collection binding in the tick of the commit: ownership lost while the bytes were staged writes nothing', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'First' })
  await writeFile(join(root, CSV), CSV_2)
  await saveFileVersion(stores(), { path: CSV, name: 'Second' })
  const lines = await versionLines()
  let bound = true
  const revoking = stores({
    assertBound: () => { if (!bound) throw new FileVersionRefused('WriteFlex no longer has this Collection open in that window, so nothing was written.') },
    seams: { afterStage: async () => { bound = false } },
  })
  // The earlier checks all passed; the binding goes in the writer's own wait between staging and the rename.
  await expect(restoreFileVersion(revoking, { path: CSV, versionId: v1.version.id, expectVersionSha256: sha(CSV_1), expectWorkingSha256: sha(CSV_2) })).rejects.toThrow('no longer has this Collection open')
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_2)
  bound = true
  await expect(saveFileVersionAsCopy(revoking, { path: CSV, versionId: v1.version.id, expectVersionSha256: sha(CSV_1), name: 'first copy.csv' })).rejects.toThrow('no longer has this Collection open')
  expect(await readdir(join(root, FOLIO, 'data'))).toEqual(['scores-3.csv'])
  expect(await versionLines()).toEqual(lines)
  expect(await strays(`${FOLIO}/data`)).toEqual([])
})

// ---- Codex re-check of PR 229: the snapshot stores the bytes that were judged, never a second read of the file ------------------------------------

const MIB = 1024 * 1024

test('a small file that grows to the bytes of an existing 26 MiB object during the save: that object is untouched, and the version holds the bytes that were judged', async () => {
  await buildFolio()
  const big = Buffer.alloc(26 * MIB, 7)
  const wide = stores({ cap: 30 * MIB })
  const first = `${FOLIO}/assets/big-one.bin`
  const twin = `${FOLIO}/assets/big-twin.bin`
  await put(first, big)
  await put(twin, big)
  await saveFileVersion(wide, { path: first, name: 'Big one' })
  await saveFileVersion(wide, { path: twin, name: 'Big twin' })
  // Two versions share the one object.
  expect(await objects()).toEqual([sha(big)])

  // The file the writer saves is small when it is judged and is the 26 MiB again by the time the snapshot would look.
  const growing = stores({ snapshotBytes: async (at, bytes) => { await writeFile(join(root, CSV), big); return snapshotBytes(at, bytes) } })
  const saved = await saveFileVersion(growing, { path: CSV, name: 'Grows' }).then((done) => done, (error: unknown) => error)

  // Whatever the outcome, nothing over the cap was stored and the earlier object is whole and still read by both of its versions.
  const object = await readFile(join(root, '.bridle/objects', sha(big)))
  expect(sha(object)).toBe(sha(big))
  const names = await objects()
  expect(names).toContain(sha(big))
  for (const name of names) expect(sha(await readFile(join(root, '.bridle/objects', name)))).toBe(name)
  for (const path of [first, twin]) {
    const [version] = await versions.list({ path })
    expect(await readSnapshotBytesWithin(root, version!.snapshotId!, 30 * MIB)).toEqual(big)
  }
  if (saved instanceof Error) {
    expect(saved).toBeInstanceOf(FileVersionRefused)
    expect(await versions.list({ path: CSV })).toEqual([])
  } else {
    // The version holds the small bytes that were read and judged, not what the file became.
    const [version] = await versions.list({ path: CSV })
    expect(await readSnapshotBytesWithin(root, version!.snapshotId!, 1024)).toEqual(Buffer.from(CSV_1))
    expect(names).toEqual([sha(CSV_1), sha(big)].sort())
  }
})

test('a file that grows past the cap during the save leaves no object over the cap, in a save and in the safety save of a restore', async () => {
  await buildFolio()
  const big = Buffer.alloc(26 * MIB, 9)
  const growing = (path: string) => stores({ snapshotBytes: async (at, bytes) => { await writeFile(join(root, path), big); return snapshotBytes(at, bytes) } })
  await saveFileVersion(growing(CSV), { path: CSV, name: 'Grows' }).catch(() => undefined)
  expect(await objects()).not.toContain(sha(big))

  await writeFile(join(root, CSV), CSV_2)
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'First' })
  await writeFile(join(root, CSV), CSV_3)
  await restoreFileVersion(growing(CSV), { path: CSV, versionId: v1.version.id, expectVersionSha256: sha(CSV_2), expectWorkingSha256: sha(CSV_3) }).catch(() => undefined)
  expect(await objects()).not.toContain(sha(big))
  for (const name of await objects()) expect((await stat(join(root, '.bridle/objects', name))).size).toBeLessThanOrEqual(25 * MIB)
})

test('A to B to A during a restore, with the object that held A gone: the safety version holds A, or the restore refuses; A is never replaced without a verified copy', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'First' })
  await writeFile(join(root, CSV), CSV_2)
  await saveFileVersion(stores(), { path: CSV, name: 'Second' })
  // The history store loses A's object (the working copy's bytes); the journal still names it, so the restore must save A again first.
  await rm(join(root, '.bridle/objects', sha(CSV_2)))
  let flipped = false
  let flippedBack = false
  const aba = stores({
    // The restore has just read A and is asking whether a version holds it: the file becomes B here, for the length of the safety save, and is A again after.
    readSnapshotBytes: async (id, max) => {
      const found = await readSnapshotBytesWithin(root, id, max)
      if (found === null && !flipped) { flipped = true; await writeFile(join(root, CSV), CSV_3) }
      return found
    },
    snapshotBytes: async (at, bytes) => { const taken = await snapshotBytes(at, bytes); if (flipped && !flippedBack) { flippedBack = true; await writeFile(join(root, CSV), CSV_2) } return taken },
  })
  const outcome = await restoreFileVersion(aba, { path: CSV, versionId: v1.version.id, expectVersionSha256: sha(CSV_1), expectWorkingSha256: sha(CSV_2) }).then((done) => done, (error: unknown) => error)
  expect(flipped).toBe(true)
  const now = await readFile(join(root, CSV), 'utf8')
  if (outcome instanceof Error) {
    expect(outcome).toBeInstanceOf(FileVersionRefused)
    expect(now).toBe(CSV_2)
  } else {
    expect(now).toBe(CSV_1)
    expect(outcome.safety).not.toBeNull()
    const safety = (await versions.list({ path: CSV })).find((version) => version.id === outcome.safety!.id)!
    expect(await readSnapshotBytesWithin(root, safety.snapshotId!, 1024)).toEqual(Buffer.from(CSV_2))
    expect(await objects()).toContain(sha(CSV_2))
  }
  // Either way, A is held by a version whose copy verifies, or the file still is A.
  const holdsA = now === CSV_2 || (await Promise.all((await versions.list({ path: CSV })).map(async (version) => {
    const bytes = await readSnapshotBytesWithin(root, version.snapshotId!, 1024)
    return Buffer.isBuffer(bytes) && bytes.toString('utf8') === CSV_2
  }))).some(Boolean)
  expect(holdsA).toBe(true)
})

test('the safety version is checked in the store before the working copy is replaced: a snapshot that kept other bytes stops the restore with the file untouched', async () => {
  await buildFolio()
  const v1 = await saveFileVersion(stores(), { path: CSV, name: 'First' })
  await writeFile(join(root, CSV), CSV_2)
  const lines = await versionLines()
  const wrong = stores({ snapshotBytes: async (at) => snapshotBytes(at, Buffer.from(CSV_3)) })
  await expect(restoreFileVersion(wrong, { path: CSV, versionId: v1.version.id, expectVersionSha256: sha(CSV_1), expectWorkingSha256: sha(CSV_2) })).rejects.toMatchObject({ code: 'unavailable' })
  expect(await readFile(join(root, CSV), 'utf8')).toBe(CSV_2)
  expect(await versionLines()).toEqual(lines)
})
