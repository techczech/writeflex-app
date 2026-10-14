import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { folioPlace, invalidateFolioPlaces } from '../../src/main/folio-place'
import { Workspace } from '../../src/main/workspace'
import { folioPlaceFacts } from '../../src/shared/folio-place'
import { askFolioPlace } from '../../src/renderer/src/app/folio-place-request'

const INDEX = 'paper/_paper_INDEX.md'
const pieces = ['paper/a.md', 'paper/b.md', 'paper/c.md']

test('a piece in the middle has both neighbours and a position', () => {
  expect(folioPlaceFacts('paper/b.md', pieces, INDEX)).toEqual({ kind: 'piece', position: 2, total: 3, previous: 'paper/a.md', next: 'paper/c.md' })
})

test('the first piece has no previous, the last no next', () => {
  expect(folioPlaceFacts('paper/a.md', pieces, INDEX)).toMatchObject({ position: 1, previous: null, next: 'paper/b.md' })
  expect(folioPlaceFacts('paper/c.md', pieces, INDEX)).toMatchObject({ position: 3, previous: 'paper/b.md', next: null })
})

test('a Folio of one piece has neither neighbour', () => {
  expect(folioPlaceFacts('paper/a.md', ['paper/a.md'], INDEX)).toEqual({ kind: 'piece', position: 1, total: 1, previous: null, next: null })
})

test('the Index Note is not a position and leads to the first piece', () => {
  expect(folioPlaceFacts(INDEX, pieces, INDEX)).toEqual({ kind: 'index', position: null, total: 3, previous: null, next: 'paper/a.md' })
  expect(folioPlaceFacts(INDEX, [], INDEX).next).toBeNull()
})

test('an Index Note the manifest lists as a piece is a piece', () => {
  expect(folioPlaceFacts(INDEX, [INDEX, ...pieces], INDEX)).toMatchObject({ kind: 'piece', position: 1, total: 4 })
})

test('a file the running order does not list has no position and no neighbours', () => {
  expect(folioPlaceFacts('paper/extra.md', pieces, INDEX)).toEqual({ kind: 'unlisted', position: null, total: 3, previous: null, next: null })
})

test('a piece listed twice takes its first position and counts once', () => {
  const twice = ['paper/a.md', 'paper/b.md', 'paper/a.md', 'paper/c.md']
  expect(folioPlaceFacts('paper/a.md', twice, INDEX)).toMatchObject({ position: 1, total: 3, previous: null, next: 'paper/b.md' })
  expect(folioPlaceFacts('paper/c.md', twice, INDEX)).toMatchObject({ position: 3, previous: 'paper/b.md' })
})

let root: string
let ws: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folio-place-'))
  ws = new Workspace(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})
const write = async (rel: string, content: string): Promise<void> => {
  await mkdir(join(root, rel, '..'), { recursive: true })
  await writeFile(join(root, rel), content, 'utf8')
}
const manifest = (files: string[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema_version: 1, content_root: '', files: files.map((path) => ({ path })), ...extra })

test('resolves the Folio, titles and position from a manifest, skipping missing and outside entries', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'gone.md', '../outside.md', 'b.md', 'a.md', 'evidence/e.md']))
  await write('paper/a.md', '# Alpha\n')
  await write('paper/b.md', 'no heading here\n')
  await write('paper/evidence/e.md', '# Evidence\n')
  const middle = await folioPlace(ws, 'paper/b.md')
  expect(middle).toEqual({
    dir: 'paper', name: 'paper', kind: 'piece', position: 2, total: 3,
    previous: { path: 'paper/a.md', title: 'Alpha' },
    next: { path: 'paper/evidence/e.md', title: 'Evidence' },
  })
  // A piece in a sub-folder belongs to the same Folio.
  expect(await folioPlace(ws, 'paper/evidence/e.md')).toMatchObject({ dir: 'paper', position: 3, next: null })
  // Neighbour title falls back to the file name.
  expect(await folioPlace(ws, 'paper/a.md')).toMatchObject({ position: 1, previous: null, next: { title: 'b' } })
})

test('the Index Note and an unlisted file inside the Folio folder', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  await write('paper/a.md', '# Alpha\n')
  await write('paper/_paper_INDEX.md', '# Paper\n')
  await write('paper/loose.md', '# Loose\n')
  expect(await folioPlace(ws, 'paper/_paper_INDEX.md')).toMatchObject({ kind: 'index', position: null, next: { path: 'paper/a.md' } })
  expect(await folioPlace(ws, 'paper/loose.md')).toMatchObject({ kind: 'unlisted', previous: null, next: null })
})

test('a folder with a Plan and no manifest uses the fallback order', async () => {
  await write('talk/_talk_INDEX.md', '# Talk\n\n## Running order\n\n- Start\n- Middle\n')
  await write('talk/02-middle.md', '# Middle\n')
  await write('talk/01-start.md', '# Start\n')
  expect(await folioPlace(ws, 'talk/02-middle.md')).toMatchObject({ dir: 'talk', position: 2, total: 2, previous: { title: 'Start' } })
})

test('a file in no Folio gives null', async () => {
  await write('notes/loose.md', '# Loose\n')
  await write('top.md', '# Top\n')
  expect(await folioPlace(ws, 'notes/loose.md')).toBeNull()
  expect(await folioPlace(ws, 'top.md')).toBeNull()
  expect(await folioPlace(ws, 'wf://board')).toBeNull()
})

test('a refused content_root lists no pieces and reads nothing outside the folder', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md'], { content_root: '../other' }))
  await write('paper/a.md', '# Alpha\n')
  await write('other/a.md', '# Other\n')
  expect(await folioPlace(ws, 'paper/a.md')).toMatchObject({ kind: 'unlisted', total: 0, previous: null, next: null })
})

test('a path that is not workspace-relative is refused like the other channels', async () => {
  for (const bad of ['  ', '', '../escape.md', 'paper/../../escape.md', '/etc/passwd']) {
    await expect(folioPlace(ws, bad)).rejects.toThrow('workspace-relative')
  }
})

test('switching between pieces of a Folio walks nothing in the workspace, and a manifest change is seen after invalidation', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(2, '0')}-piece.md`)
  await write(`paper/${MANIFEST_NAME}`, manifest(names))
  for (const name of names) await write(`paper/${name}`, `# Title ${name}\n`)
  // A few thousand files outside the Folio, which the answer must never list or read.
  for (let d = 0; d < 20; d++) {
    await mkdir(join(root, `archive/d${d}`), { recursive: true })
    await Promise.all(Array.from({ length: 150 }, (_, i) => writeFile(join(root, `archive/d${d}/n${i}.md`), '# n\n')))
  }
  const counts = { whole: 0, folder: 0 }
  const wholeWalk = ws.listFiles.bind(ws)
  const folderWalk = ws.listFilesIn.bind(ws)
  ws.listFiles = async () => { counts.whole += 1; return wholeWalk() }
  ws.listFilesIn = async (dir, options) => { counts.folder += 1; return folderWalk(dir, options) }

  const first = await folioPlace(ws, 'paper/10-piece.md')
  expect(first).toMatchObject({ dir: 'paper', position: 10, total: 30, previous: { path: 'paper/09-piece.md', title: 'Title 09-piece.md' }, next: { path: 'paper/11-piece.md' } })
  for (const n of [11, 12, 11, 1, 30, 15]) {
    const place = await folioPlace(ws, `paper/${names[n - 1]}`)
    expect(place).toMatchObject({ position: n, total: 30 })
  }
  expect(counts.whole).toBe(0)
  expect(counts.folder).toBe(1)
  console.log('walk counts', JSON.stringify(counts))

  // A manifest change followed by the change event the app already raises: the next answer is fresh.
  await write(`paper/${MANIFEST_NAME}`, manifest([names[1], names[0]]))
  invalidateFolioPlaces(ws.root)
  expect(await folioPlace(ws, `paper/${names[0]}`)).toMatchObject({ position: 2, total: 2, previous: { path: `paper/${names[1]}` }, next: null })
  expect(counts.whole).toBe(0)
  expect(counts.folder).toBe(2)
})

test('a neighbour title comes from the start of a large file', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'b.md']))
  await write('paper/a.md', `# Alpha\n\n${'word '.repeat(200_000)}\n`)
  await write('paper/b.md', '# Bravo\n')
  expect(await folioPlace(ws, 'paper/b.md')).toMatchObject({ previous: { title: 'Alpha' } })
})

test('main drops the cached answers on the two pushes that report a collection or file change', async () => {
  const source = await Bun.file(join(import.meta.dir, '../../src/main/ipc.ts')).text()
  const sendSafe = source.slice(source.indexOf('function sendSafe'), source.indexOf('}\n', source.indexOf('function sendSafe')))
  expect(sendSafe).toContain("channel === 'collection:changed'")
  expect(sendSafe).toContain("channel === 'file:changed-on-disk'")
  expect(sendSafe).toContain('invalidateFolioPlaces(state.workspace.root)')
})

test('the Running order heading is found by the Plan\'s rule: exact, with trailing text, and with no parts', async () => {
  await write('exact/_exact_INDEX.md', '# Exact\n\n## Running order\n\n- One\n')
  await write('exact/01-one.md', '# One\n')
  await write('draft/_draft_INDEX.md', '# Draft\n\n## Running order (draft)\n\n- One\n- Two\n')
  await write('draft/01-one.md', '# One\n')
  await write('draft/02-two.md', '# Two\n')
  await write('empty/_empty_INDEX.md', '# Empty\n\n## Running order (draft)\n')
  await write('empty/01-one.md', '# One\n')
  expect(await folioPlace(ws, 'exact/01-one.md')).toMatchObject({ dir: 'exact', position: 1, total: 1 })
  expect(await folioPlace(ws, 'draft/02-two.md')).toMatchObject({ dir: 'draft', position: 2, total: 2, previous: { title: 'One' } })
  // readPlan gives a Plan for a heading with no parts under it, so the folder is still a Folio.
  expect(await folioPlace(ws, 'empty/01-one.md')).toMatchObject({ dir: 'empty', position: 1, total: 1 })
})

test('what the Plan does not take as its heading declares no Plan', async () => {
  await write('deeper/_deeper_INDEX.md', '# Deeper\n\n### Running order\n\n- One\n')
  await write('deeper/01-one.md', '# One\n')
  await write('fenced/_fenced_INDEX.md', '# Fenced\n\n```\n## Running order\n```\n')
  await write('fenced/01-one.md', '# One\n')
  await write('joined/_joined_INDEX.md', '# Joined\n\n## Running orders\n\n- One\n')
  await write('joined/01-one.md', '# One\n')
  for (const dir of ['deeper', 'fenced', 'joined']) expect(await folioPlace(ws, `${dir}/01-one.md`)).toBeNull()
})

test('a Plan folder reached through a symlink is no Folio, as in the whole-workspace listing', async () => {
  await write('talk/_talk_INDEX.md', '# Talk\n\n## Running order\n\n- Start\n')
  await write('talk/01-start.md', '# Start\n')
  await mkdir(join(root, 'alias-home'))
  await symlink(join(root, 'talk'), join(root, 'alias-home/talk'))
  expect(await folioPlace(ws, 'talk/01-start.md')).toMatchObject({ dir: 'talk', position: 1 })
  expect(await folioPlace(ws, 'alias-home/talk/01-start.md')).toBeNull()
})

test('a manifest Folio reached through a symlink lists no pieces', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'b.md']))
  await write('paper/a.md', '# Alpha\n')
  await write('paper/b.md', '# Bravo\n')
  await symlink(join(root, 'paper'), join(root, 'mirror'))
  expect(await folioPlace(ws, 'mirror/a.md')).toMatchObject({ dir: 'mirror', kind: 'unlisted', total: 0, previous: null, next: null })
})

test('a refused question clears the controls like a null answer and is not left unhandled', async () => {
  const unhandled: unknown[] = []
  const note = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', note)
  try {
    const applied: unknown[] = []
    await askFolioPlace(() => Promise.reject(new Error('favourite path must be workspace-relative')), () => true, (next) => applied.push(next))
    expect(applied).toEqual([null])
    // The real refusal, end to end: main rejects, the controls get null.
    applied.length = 0
    await askFolioPlace(() => folioPlace(ws, '../escape.md'), () => true, (next) => applied.push(next))
    expect(applied).toEqual([null])
    // A reader that throws before it returns a promise is handled the same way.
    applied.length = 0
    await askFolioPlace(() => { throw new Error('no bridge') }, () => true, (next) => applied.push(next))
    expect(applied).toEqual([null])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unhandled).toEqual([])
  } finally {
    process.off('unhandledRejection', note)
  }
})

test('a late refusal or a late answer for an earlier file leaves the newer answer alone', async () => {
  let newest = 0
  const applied: unknown[] = []
  const ask = (read: () => Promise<{ dir: string } | null>): Promise<void> => {
    const request = ++newest
    return askFolioPlace(read, () => request === newest, (next) => applied.push(next))
  }
  let refuseOld!: (reason: Error) => void
  let answerOld!: (value: { dir: string }) => void
  const oldRefused = ask(() => new Promise((_, reject) => { refuseOld = reject }))
  const oldAnswered = ask(() => new Promise((resolve) => { answerOld = resolve }))
  await ask(async () => ({ dir: 'paper' }))
  refuseOld(new Error('workspace-relative'))
  answerOld({ dir: 'stale' })
  await Promise.all([oldRefused, oldAnswered])
  expect(applied).toEqual([{ dir: 'paper' }])
})

test('opening or re-opening a workspace drops the cached answers for the root left and the root opened', async () => {
  const source = await Bun.file(join(import.meta.dir, '../../src/main/ipc.ts')).text()
  const bind = source.slice(source.indexOf('export async function bindWorkspace'))
  const before = bind.slice(0, bind.indexOf('state.workspace = new Workspace(root)'))
  expect(before).toContain('if (previousWorkspace) invalidateFolioPlaces(previousWorkspace.root)')
  expect(before).toContain('invalidateFolioPlaces(root)\n')
  expect(before).toContain('invalidateFolioOutlines(previousWorkspace.root)')
  expect(before).toContain('invalidateFolioOutlines(root)\n')
})

test('a re-opened workspace root answers from the disk, not from the earlier Workspace', async () => {
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md', 'b.md']))
  await write('paper/a.md', '# Alpha\n')
  await write('paper/b.md', '# Bravo\n')
  expect(await folioPlace(ws, 'paper/a.md')).toMatchObject({ total: 2 })
  await write(`paper/${MANIFEST_NAME}`, manifest(['a.md']))
  // What bindWorkspace does on open: drop the root's answers, then a new Workspace on the same root.
  invalidateFolioPlaces(root)
  expect(await folioPlace(new Workspace(root), 'paper/a.md')).toMatchObject({ total: 1 })
})
