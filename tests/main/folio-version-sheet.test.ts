/**
 * Ticket 04 of Folio versions (ADR-0052): what the Save Folio version sheet shows before anything is written.
 * Seam: `folioSaveSheetFacts` over a synthetic Folio on a temporary Collection (parts, an Index Note, files not in the
 * outline, an inserted CSV, widget and image, a file only linked, decoys in the support folders and the bin), and the
 * save with the sheet's tick box (`includeUnlisted`). Synthetic files only.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { snapshotHashOf } from '../../src/main/cli/history-store'
import { ChangeStore } from '../../src/main/changes'
import { gatedSnapshots } from '../../src/main/gated-snapshots'
import { FolioVersionStore } from '../../src/main/folio-versions'
import { folioSaveSheetFacts } from '../../src/main/folio-version-sheet'
import { readFolioRoom } from '../../src/main/folio-room'
import { FolioSaveChanged } from '../../src/main/folio-version-save'
import { requestedFolioVersionSave } from '../../src/main/requested-folio-version-save'
import { snapshotVersionOfSavedText } from '../../src/main/saved-text-version'
import { VersionStore } from '../../src/main/versions'
import { Workspace } from '../../src/main/workspace'

const FOLIO = 'report'
const INDEX = `${FOLIO}/_report_INDEX.md`
const author = { name: 'App Writer' }
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
const partPath = (n: number): string => `${FOLIO}/p${String(n).padStart(2, '0')}.md`

async function build(root: string, parts = 3): Promise<void> {
  const put = async (rel: string, content: string | Buffer): Promise<void> => {
    await mkdir(join(root, rel, '..'), { recursive: true })
    await writeFile(join(root, rel), content)
  }
  const lines = Array.from({ length: parts }, (_, i) => `- [[./p${String(i + 1).padStart(2, '0')}.md|Part ${i + 1}]]`)
  await put(INDEX, `---\ntitle: Pilot paper\n---\n\n# Pilot paper\n\n## Running order\n\n${lines.join('\n')}\n- [[./planned.md|Planned later]]\n`)
  for (let n = 1; n <= parts; n += 1) {
    const extra = n === 1 ? '\n\n[Simulation: assets/chart.html]\n' : n === 2 ? '\n\n![Scores](data/scores.csv)\n' : n === 3 ? '\n\n![Figure](assets/fig.png)\n\nSee [the paper](data/paper.pdf).\n' : ''
    await put(partPath(n), `# Part ${n}\n\nText ${n} has some words.${extra}`)
  }
  for (const name of ['a', 'b']) await put(`${FOLIO}/extra-${name}.md`, `# Extra ${name}\n\nNot in the outline.\n`)
  await put(`${FOLIO}/assets/chart.html`, '<html><body>chart</body></html>\n')
  await put(`${FOLIO}/assets/fig.png`, PNG)
  await put(`${FOLIO}/data/scores.csv`, 'Judge,Score\nA,4.5\n')
  await put(`${FOLIO}/data/paper.pdf`, 'pdf bytes')
  await put(`${FOLIO}/data/unlinked.csv`, 'a,b\n1,2\n')
  await put(`${FOLIO}/research/notes.md`, '# Notes\n')
  await put(`${FOLIO}/research/more.md`, '# More\n')
  await put(`${FOLIO}/offcuts/cut.md`, '# Cut\n')
  await put(`${FOLIO}/archive/old.md`, '# Old\n')
  await put(`${FOLIO}/.folio-bin/binned.md`, '# Binned\n')
}

let root: string
let ws: Workspace
let versions: VersionStore
let changes: ChangeStore
beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf04-sheet-')))
  ws = new Workspace(root)
  versions = new VersionStore(ws)
  changes = new ChangeStore(ws)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const facts = (dir = FOLIO, insertedFileCap?: number) => folioSaveSheetFacts({
  workspace: ws, versions, changes, folioVersions: new FolioVersionStore(ws), author,
  snapshotHash: (id) => snapshotHashOf(root, id), readBytes: (path) => readFile(join(root, path)),
  ...(insertedFileCap !== undefined ? { insertedFileCap } : {}),
}, dir)

const saver = (options: { insertedFileCap?: number } = {}) => requestedFolioVersionSave({
  workspace: ws, versions, changes, live: () => true, author: async () => author,
  agent: async () => ({
    workspace: ws,
    snapshotReviewVersion: async (path) => {
      const { SnapshotStore } = await import('@bridle/core')
      const snapshots = gatedSnapshots(root, await SnapshotStore.open({ dir: join(root, '.bridle') }))
      return snapshotVersionOfSavedText({ workspace: ws, snapshots, sessionId: 'test-session', path })
    },
  }),
}, { isDocument: () => true, isInsertedFile: () => true, ...options })

const tree = async (): Promise<string[]> => {
  const { readdir } = await import('node:fs/promises')
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(rel)
      else out.push(`${rel}:${createHash('sha256').update(await readFile(join(root, rel))).digest('hex')}`)
    }
  }
  await walk('')
  return out.sort()
}

test('the sheet lists the Index Note, the parts, the files not in the outline, each inserted file, what is only linked and what is left out', async () => {
  await build(root)
  const sheet = await facts()
  expect(sheet).toMatchObject({ dir: FOLIO, indexPath: INDEX, parts: 3, planned: 1, versionCount: 0, author: 'App Writer' })
  expect(sheet.words).toBeGreaterThan(10)
  expect(sheet.partList).toEqual([1, 2, 3].map((n) => ({ path: partPath(n), title: `Part ${n}`, order: n })))
  expect(sheet.unlisted.map((entry) => entry.path).sort()).toEqual([`${FOLIO}/extra-a.md`, `${FOLIO}/extra-b.md`])
  expect(sheet.inserted.map((entry) => [entry.name, entry.kind, entry.version])).toEqual([
    ['chart.html', 'widget', null], ['scores.csv', 'table', null], ['fig.png', 'image', null],
  ])
  expect(sheet.linked).toEqual([`${FOLIO}/data/paper.pdf`])
  // data/ counts only what the text neither inserts nor links.
  expect(sheet.leftOut).toEqual({ research: 2, data: 1, offcuts: 1, archive: 1, bin: 1 })
  expect(sheet.backup).toEqual({ state: 'ok', leftOut: [] })
  expect(sheet.waiting).toEqual([])
  expect(sheet.refused).toBeUndefined()
})

test('opening the sheet writes nothing at all', async () => {
  await build(root)
  const before = await tree()
  await facts()
  await facts()
  expect(await tree()).toEqual(before)
  await expect(readFile(join(root, '.writeflex/folio-versions.jsonl'))).rejects.toThrow()
  await expect(readFile(join(root, '.writeflex/versions.jsonl'))).rejects.toThrow()
})

test('an inserted file shows the version it would use once a Folio version holds its bytes, and a new version once it has changed', async () => {
  await build(root)
  await saver()({ dir: FOLIO, name: 'First' }, async () => {})
  const same = await facts()
  expect(same.versionCount).toBe(1)
  expect(same.inserted.find((entry) => entry.name === 'scores.csv')!.version).toEqual({ number: 1, name: 'Folio version: First' })
  await writeFile(join(root, FOLIO, 'data/scores.csv'), 'Judge,Score\nA,4.6\n')
  const changed = await facts()
  expect(changed.inserted.find((entry) => entry.name === 'scores.csv')!.version).toBeNull()
  expect(changed.inserted.find((entry) => entry.name === 'chart.html')!.version).toEqual({ number: 1, name: 'Folio version: First' })
})

test('waiting changes: the writer\'s own are counted to be settled, an agent\'s are counted to be left out, each by part', async () => {
  await build(root)
  await changes.add({ path: partPath(2), provenance: 'writer', editClass: 'content', summary: 'Reworded', oldText: 'Text 2', newText: 'Text two', isCorrection: false })
  await changes.add({ path: partPath(2), provenance: 'writer', editClass: 'content', summary: 'Again', oldText: 'has', newText: 'holds', isCorrection: false })
  await changes.add({ path: partPath(3), provenance: 'agent', editClass: 'content', summary: 'Suggested', oldText: 'Text 3', newText: 'Text three', isCorrection: false })
  await changes.add({ path: `${FOLIO}/extra-a.md`, provenance: 'agent', editClass: 'content', summary: 'Held', status: 'held', oldText: 'Extra', newText: 'More', isCorrection: false })
  const sheet = await facts()
  expect(sheet.waiting).toEqual([
    { path: partPath(2), role: 'part', title: 'Part 2', order: 2, own: 2, agent: 0 },
    { path: partPath(3), role: 'part', title: 'Part 3', order: 3, own: 0, agent: 1 },
    { path: `${FOLIO}/extra-a.md`, role: 'unlisted', title: 'Extra a', own: 0, agent: 1 },
  ])
})

test('a folder that is not a Folio, and a Folio with no Index Note file, are refused in words with nothing else filled', async () => {
  await build(root)
  await mkdir(join(root, 'plain'), { recursive: true })
  await writeFile(join(root, 'plain/a.md'), '# A\n')
  const plain = await facts('plain')
  expect(plain.refused).toContain('is not a Folio')
  expect(plain).toMatchObject({ parts: 0, inserted: [], unlisted: [], waiting: [] })
  await rm(join(root, INDEX))
  const noIndex = await facts()
  expect(noIndex.refused).toBeDefined()
})

test('the tick box: saving with the files not in the outline left out keeps them out of the version, and their waiting changes alone', async () => {
  await build(root)
  await changes.add({ path: `${FOLIO}/extra-a.md`, provenance: 'agent', editClass: 'content', summary: 'Suggested', oldText: 'Extra', newText: 'More', isCorrection: false })
  const saved = await saver()({ dir: FOLIO, name: 'Without the loose files', includeUnlisted: false }, async () => {})
  expect(saved.record.members.filter((member) => member.role === 'unlisted')).toEqual([])
  expect(saved.waiting).toEqual([])
  // An asset only a left-out file inserts is not found either; the rest is as before.
  expect(saved.record.members.filter((member) => member.role === 'part')).toHaveLength(3)
  const withThem = await saver()({ dir: FOLIO, name: 'With them' }, async () => {})
  expect(withThem.record.members.filter((member) => member.role === 'unlisted')).toHaveLength(2)
})

test('an inserted file over the cap is classified by the save\'s own function: the sheet says too-large exactly where the save writes a reference member', async () => {
  await build(root)
  // chart.html is 32 bytes, scores.csv 18, fig.png 12: a 20-byte cap puts only the widget over.
  const cap = 20
  const sheet = await facts(FOLIO, cap)
  expect(sheet.insertedCapBytes).toBe(cap)
  const bySheet = sheet.inserted.filter((entry) => entry.handling === 'too-large').map((entry) => entry.path)
  expect(bySheet).toEqual([`${FOLIO}/assets/chart.html`])
  expect(sheet.inserted.find((entry) => entry.name === 'chart.html')).toMatchObject({ hash: null, version: null, bytes: 32 })
  expect(sheet.inserted.find((entry) => entry.name === 'scores.csv')).toMatchObject({ handling: 'kept', bytes: 18 })
  const saved = await saver({ insertedFileCap: cap })({ dir: FOLIO, name: 'Capped' }, async () => {})
  const references = saved.record.members.filter((member) => member.role === 'reference' && member.why === 'too-large').map((member) => member.path)
  expect(references).toEqual(bySheet)
  // The default cap is the save's: a 12-byte image is nowhere near it.
  expect((await facts()).inserted.every((entry) => entry.handling === 'kept')).toBe(true)
})

test('the tick box is recomputed whole: an asset only a loose file inserts, that file\'s waiting changes and the data left out all follow the box', async () => {
  await build(root)
  await writeFile(join(root, FOLIO, 'extra-a.md'), '# Extra a\n\nSee ![Only here](data/only-loose.csv) and [a link](data/loose.pdf).\n')
  await writeFile(join(root, FOLIO, 'data/only-loose.csv'), 'x,y\n1,2\n')
  await writeFile(join(root, FOLIO, 'data/loose.pdf'), 'pdf')
  await changes.add({ path: `${FOLIO}/extra-a.md`, provenance: 'writer', editClass: 'content', summary: 'Own', oldText: 'See', newText: 'Look at', isCorrection: false })
  const sheet = await facts()
  expect(sheet.inserted.map((entry) => entry.name)).toContain('only-loose.csv')
  expect(sheet.linked).toContain(`${FOLIO}/data/loose.pdf`)
  expect(sheet.waiting.map((entry) => entry.path)).toContain(`${FOLIO}/extra-a.md`)
  expect(sheet.leftOut.data).toBe(1)
  const without = sheet.withoutUnlisted!
  expect(without.inserted.map((entry) => entry.name)).not.toContain('only-loose.csv')
  expect(without.linked).not.toContain(`${FOLIO}/data/loose.pdf`)
  expect(without.waiting).toEqual([])
  // Neither csv nor pdf is inserted or linked any more, so both are "data the text does not insert".
  expect(without.leftOut.data).toBe(3)
  expect(without.fingerprint).not.toBe(sheet.fingerprint)
  // The unticked preview is the very Folio the save makes with the box unticked.
  const saved = await saver()({ dir: FOLIO, name: 'Without', includeUnlisted: false, expectFingerprint: without.fingerprint }, async () => {})
  expect(saved.record.members.some((member) => member.path.endsWith('only-loose.csv'))).toBe(false)
  // No file outside the outline: nothing to untick.
  await rm(join(root, FOLIO, 'extra-a.md'))
  await rm(join(root, FOLIO, 'extra-b.md'))
  expect((await facts()).withoutUnlisted).toBeNull()
})

test('the fingerprint: the go-ahead is checked under the lock; a file added, an inserted file changed or changes newly waiting write nothing and say so', async () => {
  await build(root)
  const before = await facts()
  expect((await facts()).fingerprint).toBe(before.fingerprint)

  const ready = await tree()
  // A file added meanwhile.
  await writeFile(join(root, FOLIO, 'later.md'), '# Later\n\nAdded after the sheet opened.\n')
  await expect(saver()({ dir: FOLIO, name: 'Stale', expectFingerprint: before.fingerprint }, async () => {})).rejects.toBeInstanceOf(FolioSaveChanged)
  await rm(join(root, FOLIO, 'later.md'))
  expect(await tree()).toEqual(ready)

  // An inserted file's bytes changed meanwhile.
  await writeFile(join(root, FOLIO, 'data/scores.csv'), 'Judge,Score\nA,4.9\n')
  await expect(saver()({ dir: FOLIO, name: 'Stale', expectFingerprint: before.fingerprint }, async () => {})).rejects.toBeInstanceOf(FolioSaveChanged)
  await writeFile(join(root, FOLIO, 'data/scores.csv'), 'Judge,Score\nA,4.5\n')

  // Changes newly waiting.
  await changes.add({ path: partPath(2), provenance: 'agent', editClass: 'content', summary: 'Suggested', oldText: 'Text 2', newText: 'Text two', isCorrection: false })
  await expect(saver()({ dir: FOLIO, name: 'Stale', expectFingerprint: before.fingerprint }, async () => {})).rejects.toBeInstanceOf(FolioSaveChanged)
  expect(await readFile(join(root, partPath(2)), 'utf8')).toContain('Text 2')

  // None of the refused saves wrote a line anywhere.
  await expect(readFile(join(root, '.writeflex/folio-versions.jsonl'))).rejects.toThrow()
  await expect(readFile(join(root, '.writeflex/versions.jsonl'))).rejects.toThrow()

  // The sheet read again carries the new fingerprint, and a go-ahead on it saves.
  await writeFile(join(root, FOLIO, 'later.md'), '# Later\n\nAdded after the sheet opened.\n')
  const again = await facts()
  expect(again.fingerprint).not.toBe(before.fingerprint)
  expect(again.unlisted.map((entry) => entry.path)).toContain(`${FOLIO}/later.md`)
  const saved = await saver()({ dir: FOLIO, name: 'Fresh', expectFingerprint: again.fingerprint }, async () => {})
  expect(saved.record.members.some((member) => member.path === `${FOLIO}/later.md`)).toBe(true)
  // No fingerprint, no check (the command line and the agent).
  await writeFile(join(root, FOLIO, 'later-still.md'), '# Later still\n')
  await saver()({ dir: FOLIO, name: 'No check' }, async () => {})
})

test('the fingerprint follows the box: with it unticked, a file added outside the outline does not make the sheet stale', async () => {
  await build(root)
  const sheet = await facts()
  await writeFile(join(root, FOLIO, 'later.md'), '# Later\n')
  const saved = await saver()({ dir: FOLIO, name: 'Without', includeUnlisted: false, expectFingerprint: sheet.withoutUnlisted!.fingerprint }, async () => {})
  expect(saved.record.members.some((member) => member.role === 'unlisted')).toBe(false)
})

test('the sheet\'s word count is the Index Note and the parts, and says how it divides: the Folio room\'s header counts the parts only', async () => {
  await build(root)
  const sheet = await facts()
  const room = (await readFolioRoom(ws, FOLIO))!
  expect(sheet.words - sheet.indexWords).toBe(room.meta.words)
  expect(sheet.indexWords).toBeGreaterThan(0)
  expect(sheet.words).toBeGreaterThan(room.meta.words)
})
