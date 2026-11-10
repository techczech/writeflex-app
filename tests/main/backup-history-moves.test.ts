import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { SnapshotStore } from '@bridle/core'
import { appendFileSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { WRITEFLEX_SCOPE, WRITEFLEX_HISTORY } from '../../src/main/backup-helper/enrolment'
import { historySeams, readHistoryProjection } from '../../src/backup-helper/history-projection'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'
import { prepareVersionMove, readMovedVersions, followVersionMap, undoVersionMap } from '../../src/main/version-moves'
import { versionTextReader } from '../../src/main/cli/history-store'
import { readVersionContent, restoreVersionContent } from '../../src/main/version-content'

const roots: string[] = []
afterEach(async () => { delete historySeams.afterFirstRead; while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }) })
async function fixture(count = 1) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'backup-moves-'))); roots.push(root)
  const snapshots = await SnapshotStore.open({ dir: join(root, '.bridle') })
  const versions = new VersionStore(new Workspace(root))
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, 'a.md'), `Synthetic named text ${i}\n`)
    const versionId = await snapshots.beginRestorePoint('synthetic', 'synthetic-session')
    const snapshot = await snapshots.snapshotFile(join(root, 'a.md'), { sessionId: 'synthetic-session', capability: 'change.save-version' })
    await versions.append({ id: `v_synthetic_${i}`, ts: i + 1, path: 'a.md', name: `Synthetic ${i}`, author: { name: 'Synthetic Writer' }, snapshotId: snapshot.id, versionId })
  }
  const move = (from: string, to: string, finish = true) => {
    const intent = prepareVersionMove(root, from, to)
    renameSync(join(root, from), join(root, to))
    if (finish) intent.finish()
    return intent
  }
  const read = () => readHistoryProjection(root, p => p.endsWith('.md'))
  return { root, versions, move, read }
}
function complete(r: Awaited<ReturnType<typeof readHistoryProjection>>) {
  if (r.state !== 'complete') throw new Error(r.reason)
  return r
}
async function copyProjection(f: Awaited<ReturnType<typeof fixture>>) {
  const before = [readFileSync(join(f.root, '.writeflex/versions.jsonl')), readFileSync(join(f.root, '.bridle/journal.jsonl'))]
  const projected = complete(await f.read())
  expect([readFileSync(join(f.root, '.writeflex/versions.jsonl')), readFileSync(join(f.root, '.bridle/journal.jsonl'))]).toEqual(before)
  const copy = await realpath(await mkdtemp(join(tmpdir(), 'backup-moves-copy-'))); roots.push(copy)
  for (const file of projected.files) { mkdirSync(dirname(join(copy, file.path)), { recursive: true }); writeFileSync(join(copy, file.path), file.content) }
  return { copy, projected }
}
test('217 synthetic journal records: chained physical moves preserve all names, identities and content in a restored copy and second capture', async () => {
  const f = await fixture(213)
  f.move('a.md', 'b.md'); f.move('b.md', 'c.md')
  expect(readFileSync(join(f.root, '.writeflex/versions.jsonl'), 'utf8').trim().split('\n')).toHaveLength(217)
  const isolated = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: f.root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', TMPDIR: tmpdir() }
  expect(spawnSync('/usr/bin/git', ['init', '-q', f.root], { env: isolated }).status).toBe(0)
  const config = join(f.root, 'synthetic-preview.json')
  writeFileSync(config, JSON.stringify({ configVersion: 2, machineId: 'synthetic', tools: { git: '/Library/Developer/CommandLineTools/usr/bin/git', gitleaks: '/opt/homebrew/bin/gitleaks' }, vaults: [{ id: 'v', path: f.root, include: WRITEFLEX_SCOPE.include, exclude: WRITEFLEX_SCOPE.exclude, history: WRITEFLEX_HISTORY }] }))
  const sourceBeforePreview = [readFileSync(join(f.root, '.writeflex/versions.jsonl')), readFileSync(join(f.root, '.bridle/journal.jsonl'))]
  const previewRun = spawnSync('/usr/local/bin/node', [resolve(import.meta.dir, '../../out/backup-helper/writeflex-backup-helper.js'), 'preview', '--config', config, '--vault', 'v'], { env: isolated, maxBuffer: 4 * 1024 * 1024, timeout: 10000 })
  expect(previewRun.status).toBe(0)
  const preview = JSON.parse(previewRun.stdout.toString())
  expect(preview.refused).toBeNull()
  expect(preview.files).toEqual({ count: 1, items: ['c.md'], omitted: 0 })
  expect(preview.history).toMatchObject({ state: 'complete', summary: { namedVersions: 213 } })
  expect([readFileSync(join(f.root, '.writeflex/versions.jsonl')), readFileSync(join(f.root, '.bridle/journal.jsonl'))]).toEqual(sourceBeforePreview)
  const { copy, projected } = await copyProjection(f)
  expect(preview.history.bytes).toBe(projected.files.reduce((n, file) => n + file.content.length, 0))
  expect(projected.summary.namedVersions).toBe(213)
  const ws = new Workspace(copy), versions = new VersionStore(ws), reader = versionTextReader(copy)
  expect(await versions.list()).toEqual(await f.versions.list())
  for (let i = 0; i < 213; i++) expect((await readVersionContent(versions, reader, { id: `v_synthetic_${i}`, path: 'c.md' }))?.content).toBe(`Synthetic named text ${i}\n`)
  writeFileSync(join(copy, 'c.md'), 'Current copy\n')
  const snapshots = await SnapshotStore.open({ dir: join(copy, '.bridle') })
  const restored = await restoreVersionContent(versions, { ...reader, checkpointFile: async path => { await snapshots.snapshotFile(join(copy, path), { sessionId: 'copy', capability: 'restore' }) } }, ws, { id: 'v_synthetic_0', path: 'c.md', basis: { kind: 'disk', text: 'Current copy\n' } })
  expect(restored?.written).toBe('Synthetic named text 0\n')
  expect(readFileSync(join(copy, 'c.md'), 'utf8')).toBe('Synthetic named text 0\n')
  const second = complete(await readHistoryProjection(copy, p => p.endsWith('.md')))
  expect(second.files).toEqual(projected.files)
  console.log(JSON.stringify({ records: 217, namedVersions: 213, path: 'c.md', sourceBytesUnchanged: true, previewBytes: preview.history.bytes, restored: true, secondCaptureIdentical: true }))
})
for (const state of ['cancelled', 'not-happened', 'happened', 'held-back'] as const) test(`unfinished/cancelled move: ${state}`, async () => {
  const f = await fixture()
  const intent = prepareVersionMove(f.root, 'a.md', 'b.md')
  if (state === 'cancelled') intent.cancel()
  if (state === 'happened') renameSync(join(f.root, 'a.md'), join(f.root, 'b.md'))
  if (state === 'held-back') rmSync(join(f.root, 'a.md'))
  const projected = complete(await f.read())
  expect(projected.summary.namedVersions).toBe(state === 'held-back' ? 0 : 1)
  if (state !== 'held-back') {
    const row = JSON.parse(projected.files.find(x => x.path === '.writeflex/versions.jsonl')!.content.toString())
    expect(row.path).toBe(state === 'happened' ? 'b.md' : 'a.md')
  }
  expect(readMovedVersions(f.root)).toHaveLength(projected.summary.namedVersions)
})
test('reattach and undo retain held-back semantics', async () => {
  const f = await fixture(); prepareVersionMove(f.root, 'a.md', 'b.md'); rmSync(join(f.root, 'a.md'))
  writeFileSync(join(f.root, 'c.md'), 'Synthetic named text 0\n')
  const mapped = followVersionMap(f.root, 'a.md\tc.md')
  expect(mapped.attached).toBe(1)
  expect(complete(await f.read()).summary.namedVersions).toBe(1)
  undoVersionMap(f.root, mapped.undo!)
  expect(complete(await f.read()).summary.namedVersions).toBe(0)
})
for (const row of [ { kind: 'unknown', id: 'x' }, { kind: 'version-paths', id: 'x', assignments: [{ id: 'v_synthetic_0', from: 'a.md', to: '../escape.md' }] }, { kind: 'version-paths-finish', id: 'x', state: 'maybe' } ]) test(`malformed move refused: ${JSON.stringify(row)}`, async () => {
  const f = await fixture(); appendFileSync(join(f.root, '.writeflex/versions.jsonl'), JSON.stringify(row) + '\n')
  expect((await f.read()).state).toBe('unavailable')
})

for (const mode of ['foreign-root', 'wrong-owner', 'case-owner', 'same-snapshot-two-targets'] as const) test(`moves do not weaken snapshot ownership: ${mode}`, async () => {
  const f = await fixture(); f.move('a.md', 'b.md')
  if (mode === 'same-snapshot-two-targets') {
    const row = JSON.parse(readFileSync(join(f.root, '.writeflex/versions.jsonl'), 'utf8').split('\n')[0]!)
    appendFileSync(join(f.root, '.writeflex/versions.jsonl'), JSON.stringify({ ...row, id: 'v_other', path: 'a.md' }) + '\n')
  } else {
    const path = join(f.root, '.bridle/journal.jsonl')
    const rows = readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    rows.find(r => r.kind === 'snapshot').file = mode === 'foreign-root' ? '/synthetic-foreign-root/a.md' : `${f.root}/${mode === 'case-owner' ? 'A.md' : 'other.md'}`
    writeFileSync(path, rows.map(r => JSON.stringify(r) + '\n').join(''))
  }
  expect((await f.read()).state).toBe('unavailable')
})

for (const mode of ['hard-link', 'copy-hash', 'case-only', 'linked-target', 'unrelated-target'] as const) test(`physical evidence matches canonical app reader: ${mode}`, async () => {
  const f = await fixture()
  const to = mode === 'case-only' ? 'A.md' : 'b.md'
  prepareVersionMove(f.root, 'a.md', to, mode === 'copy-hash')
  if (mode === 'hard-link') linkSync(join(f.root, 'a.md'), join(f.root, to))
  if (mode === 'case-only') renameSync(join(f.root, 'a.md'), join(f.root, to))
  if (mode === 'copy-hash') writeFileSync(join(f.root, to), 'Synthetic named text 0\n')
  if (mode === 'linked-target') { rmSync(join(f.root, 'a.md')); symlinkSync('missing.md', join(f.root, to)) }
  if (mode === 'unrelated-target') writeFileSync(join(f.root, to), 'Unrelated\n')
  const { copy, projected } = await copyProjection(f)
  expect(await new VersionStore(new Workspace(copy)).list()).toEqual(await f.versions.list())
  expect(projected.summary.namedVersions).toBe(mode === 'linked-target' ? 0 : 1)
})
test('destination keeps its own history after overwrite then reverse; changed name retains original snapshot binding', async () => {
  const f = await fixture()
  writeFileSync(join(f.root, 'b.md'), 'Destination own text\n')
  const snapshots = await SnapshotStore.open({ dir: join(f.root, '.bridle') })
  const snapshot = await snapshots.snapshotFile(join(f.root, 'b.md'), { sessionId: 'synthetic', capability: 'change.save-version' })
  const other = await f.versions.append({ path: 'b.md', name: 'Destination', author: { name: 'Synthetic' }, snapshotId: snapshot.id })
  f.move('a.md', 'b.md'); f.move('b.md', 'a.md')
  await f.versions.rename('v_synthetic_0', 'Changed synthetic label')
  const { copy } = await copyProjection(f)
  const versions = new VersionStore(new Workspace(copy)), reader = versionTextReader(copy)
  expect((await readVersionContent(versions, reader, { id: 'v_synthetic_0' }))?.path).toBe('a.md')
  expect((await readVersionContent(versions, reader, { id: other.id }))?.path).toBe('b.md')
  expect((await readVersionContent(versions, reader, { id: other.id }))?.content).toBe('Destination own text\n')
  expect((await readVersionContent(versions, reader, { id: 'v_synthetic_0' }))?.version?.name).toBe('Changed synthetic label')
})
test('unfinished physical evidence changing during read refuses the whole projection', async () => {
  const f = await fixture(); prepareVersionMove(f.root, 'a.md', 'b.md')
  historySeams.afterFirstRead = () => { renameSync(join(f.root, 'a.md'), join(f.root, 'b.md')) }
  expect(await f.read()).toMatchObject({ state: 'unavailable', reason: expect.stringContaining('evidence changed') })
})
