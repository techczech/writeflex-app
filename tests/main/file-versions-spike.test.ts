/**
 * Ticket 19 of Folio versions (ADR-0052): the spike. Before any file-version operation is built, does the EXISTING snapshot store
 * (Bridle's `.bridle/journal.jsonl` and content-addressed `.bridle/objects/<sha256>`, written by `snapshotVersionOfSavedText`) take a
 * snapshot of a CSV, an HTML file and a PNG, give the same bytes back after the working file changed, and put them back whole?
 *
 * Synthetic files only. The PNG holds bytes that are not valid UTF-8, so a text decode anywhere on the way would change them.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshotBytes, snapshotHashOf } from '../../src/main/cli/history-store'
import { gatedSnapshots } from '../../src/main/gated-snapshots'
import { snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import { writeWhole } from '../../src/main/cli/guarded-fs'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'

const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
// 0x89 and 0xff can never begin a UTF-8 sequence: a utf8 round trip turns them into U+FFFD.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01, 0x80, 0x81])
const FILES: Array<{ path: string; first: string | Buffer; then: string | Buffer }> = [
  { path: 'data/scores-3.csv', first: 'Judge,Pairs,Prefer A\nJudge 1,120,51\n', then: 'Judge,Pairs,Prefer A\nJudge 1,120,49\n' },
  { path: 'assets/agreement.html', first: '<html><body>First widget</body></html>\n', then: '<html><body>Second widget</body></html>\n' },
  { path: 'assets/pipeline.png', first: PNG, then: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xc3, 0x28]) },
]

let root: string
let ws: Workspace
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf19-spike-')))
  ws = new Workspace(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function snapshot(path: string): Promise<{ versionId: string; snapshotId: string }> {
  const { SnapshotStore } = await import('@bridle/core')
  const snapshots = gatedSnapshots(root, await SnapshotStore.open({ dir: join(root, '.bridle') }))
  return snapshotVersionOfSavedText({ workspace: ws, snapshots, sessionId: 'spike', path })
}

for (const file of FILES) {
  test(`${file.path}: a snapshot keeps the saved bytes, survives the file changing, and restores byte for byte`, async () => {
    await mkdir(join(root, file.path, '..'), { recursive: true })
    await writeFile(join(root, file.path), file.first)
    const taken = await snapshot(file.path)
    expect(await snapshotHashOf(root, taken.snapshotId)).toBe(sha(file.first))

    // The working file changes; the snapshot still holds the first bytes, exactly.
    await writeFile(join(root, file.path), file.then)
    const saved = await readSnapshotBytes(root, taken.snapshotId)
    expect(saved).not.toBeNull()
    expect(sha(saved!)).toBe(sha(file.first))

    // Put them back whole through the app's own guarded write: temp file and rename, never in place.
    await writeWhole(ws, file.path, saved!, 'replace', {}, { fingerprint: sha(file.then) })
    expect(sha(await readFile(join(root, file.path)))).toBe(sha(file.first))
    // A restore leaves nothing beside the file.
    expect((await readdir(join(root, file.path, '..'))).filter((name) => name.includes('.tmp') || name.includes('~'))).toEqual([])
  })
}

test('two snapshots of identical bytes name one object; different bytes name another', async () => {
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets/pipeline.png'), PNG)
  const one = await snapshot('assets/pipeline.png')
  await writeFile(join(root, 'assets/pipeline.png'), Buffer.from([1, 2, 3]))
  await snapshot('assets/pipeline.png')
  await writeFile(join(root, 'assets/pipeline.png'), PNG)
  const three = await snapshot('assets/pipeline.png')
  expect(one.snapshotId).not.toBe(three.snapshotId)
  expect(await snapshotHashOf(root, one.snapshotId)).toBe(await snapshotHashOf(root, three.snapshotId))
  // Three snapshots, two distinct contents, two objects.
  expect((await readdir(join(root, '.bridle/objects'))).filter((name) => /^[0-9a-f]{64}$/.test(name)).sort()).toEqual([sha(PNG), sha(Buffer.from([1, 2, 3]))].sort())
})

test('the version store lists a version of a non-Markdown file by its path', async () => {
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, 'data/scores-3.csv'), 'a,b\n1,2\n')
  const taken = await snapshot('data/scores-3.csv')
  const store = new VersionStore(ws)
  await store.append({ path: 'data/scores-3.csv', name: 'Pilot run', author: { name: 'Writer' }, snapshotId: taken.snapshotId, versionId: taken.versionId })
  expect((await store.list({ path: 'data/scores-3.csv' })).map((version) => version.name)).toEqual(['Pilot run'])
})
