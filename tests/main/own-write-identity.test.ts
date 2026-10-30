/**
 * Folio room ticket 05 (spec-folio-room § 6.6 D-WATCH-1, test matrix T-WATCH): the folder watcher drops an event
 * for a path only while the path still holds exactly the state the app's own write left there (the staged file's
 * device, inode, size and modification time, taken before the rename), or nothing, for a delete. Anything else is
 * delivered: another program's save a second after the app's, an edit in place, a look that fails, a replacement
 * landing right after the app's rename. Seams: `Workspace.saveFile` (the atomic write and the guarded write), the
 * other write routes that record an own write, and the watcher's router (`createWatchRouter`).
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { chmodSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { Workspace, atomicWriteSeams } from '../../src/main/workspace'
import { createWatchRouter, fileIdentityOf, type OwnWriteExpectation } from '../../src/main/workspace-watcher'
import { WriteSession } from '../../src/main/cli/write-session'

const MINE = '# Draft\n\nWritten in WriteFlex.\n'
let root: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-own-write-identity-'))
  ws = new Workspace(root)
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/draft.md'), '# Draft\n')
})
afterEach(async () => {
  delete documentSaveSeams.afterCommit
  delete atomicWriteSeams.afterCommit
  try { chmodSync(join(root, 'notes'), 0o755) } catch { /* already readable */ }
  await rm(root, { recursive: true, force: true })
})

/** Another program's atomic save: a new file beside the name, renamed over it (a new inode). */
function externalAtomicSave(path: string, text: string): void {
  const temporary = join(root, `${path}.outside-save`)
  writeFileSync(temporary, text)
  renameSync(temporary, join(root, path))
}

const SAVES: Array<[string, (path: string, text: string) => Promise<unknown>]> = [
  ['the atomic save', (path, text) => ws.saveFile(path, text)],
  ['the guarded save (documentOnly)', (path, text) => ws.saveFile(path, text, { documentOnly: true })],
  ['the editor save', async (path, text) => ws.saveEditorText(path, text, { kind: 'disk', text: await readFile(join(root, path), 'utf8') })],
]

for (const [name, save] of SAVES) {
  test(`${name}: the app's own write alone is suppressed`, async () => {
    await save('notes/draft.md', MINE)
    expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(true)
    expect(ws.wasRecentlyWrittenByApp('notes/draft.md', Date.now() + 4_000)).toBe(true)
  })

  test(`${name}: another program's atomic save a second after it is delivered`, async () => {
    const savedAt = Date.now()
    await save('notes/draft.md', MINE)
    externalAtomicSave('notes/draft.md', '# Draft\n\nWritten in Obsidian.\n')
    expect(ws.wasRecentlyWrittenByApp('notes/draft.md', savedAt + 1_000)).toBe(false)
  })

  test(`${name}: another program's write in place (same inode, same size, new time) a second after it is delivered`, async () => {
    const savedAt = Date.now()
    await save('notes/draft.md', MINE)
    const before = lstatSync(join(root, 'notes/draft.md'), { bigint: true })
    await new Promise((resolve) => setTimeout(resolve, 5))
    writeFileSync(join(root, 'notes/draft.md'), MINE.replace('WriteFlex', 'Elsewhere'))
    const after = lstatSync(join(root, 'notes/draft.md'), { bigint: true })
    // The case this test is about: the same file and the same size, only its time differs.
    expect([after.ino, after.size]).toEqual([before.ino, before.size])
    expect(after.mtimeNs).not.toBe(before.mtimeNs)
    expect(ws.wasRecentlyWrittenByApp('notes/draft.md', savedAt + 1_000)).toBe(false)
  })

  test(`${name}: a look at the path that fails is delivered`, async () => {
    await save('notes/draft.md', MINE)
    chmodSync(join(root, 'notes'), 0o000) // lstat of notes/draft.md now fails with EACCES
    expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
  })
}

test('a replacement landing right after the rename of the atomic save is delivered, not recorded as the app\'s', async () => {
  atomicWriteSeams.afterCommit = async (absolute) => {
    delete atomicWriteSeams.afterCommit
    if (absolute === join(root, 'notes/draft.md')) externalAtomicSave('notes/draft.md', 'REPLACED\n')
  }
  await ws.saveFile('notes/draft.md', MINE)
  expect(readFileSync(join(root, 'notes/draft.md'), 'utf8')).toBe('REPLACED\n')
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
})

test('a replacement landing right after the rename of the guarded save is delivered, not recorded as the app\'s', async () => {
  documentSaveSeams.afterCommit = async (path) => {
    delete documentSaveSeams.afterCommit
    if (path === 'notes/draft.md') externalAtomicSave('notes/draft.md', 'REPLACED\n')
  }
  await ws.saveFile('notes/draft.md', MINE, { documentOnly: true })
  expect(readFileSync(join(root, 'notes/draft.md'), 'utf8')).toBe('REPLACED\n')
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
})

test('a new file (guarded create by hard link, and the exclusive create) is suppressed until another program saves over it', async () => {
  documentSaveSeams.afterCommit = async (path) => {
    delete documentSaveSeams.afterCommit
    if (path === 'notes/linked.md') externalAtomicSave('notes/linked.md', 'REPLACED\n')
  }
  await ws.createFile('notes/linked.md', MINE, { documentOnly: true })
  expect(ws.wasRecentlyWrittenByApp('notes/linked.md')).toBe(false) // replaced right after its link: delivered
  await ws.createFile('notes/fresh.md', MINE, { documentOnly: true })
  await ws.createFile('notes/plain.md', MINE)
  expect(ws.wasRecentlyWrittenByApp('notes/fresh.md')).toBe(true)
  expect(ws.wasRecentlyWrittenByApp('notes/plain.md')).toBe(true)
  externalAtomicSave('notes/plain.md', 'Outside.\n')
  expect(ws.wasRecentlyWrittenByApp('notes/plain.md')).toBe(false)
})

test('a move records nothing at the old name and the moved file at the new one, both routes', async () => {
  await writeFile(join(root, 'notes/other.md'), 'Other.\n')
  await ws.renameFile('notes/draft.md', 'notes/moved.md')
  await ws.renameFile('notes/other.md', 'notes/moved-guarded.md', { documentOnly: true })
  for (const [from, to] of [['notes/draft.md', 'notes/moved.md'], ['notes/other.md', 'notes/moved-guarded.md']]) {
    expect(ws.wasRecentlyWrittenByApp(from)).toBe(true)
    expect(ws.wasRecentlyWrittenByApp(to)).toBe(true)
    // Another program puts a file at the old name, and saves over the new one: both delivered.
    writeFileSync(join(root, from), 'Back.\n')
    externalAtomicSave(to, 'Outside.\n')
    expect(ws.wasRecentlyWrittenByApp(from)).toBe(false)
    expect(ws.wasRecentlyWrittenByApp(to)).toBe(false)
  }
})

test('a folder move records the moved folder at its new name and nothing at the old one', async () => {
  await ws.renameFolder('notes', 'papers')
  expect(ws.wasRecentlyWrittenByApp('notes')).toBe(true)
  expect(ws.wasRecentlyWrittenByApp('papers')).toBe(true)
  await mkdir(join(root, 'notes'))
  expect(ws.wasRecentlyWrittenByApp('notes')).toBe(false)
})

test('a trash records the path as absent: suppressed while nothing is there, delivered once another program puts a file back', async () => {
  await ws.moveToTrash('notes/draft.md', async (absolute) => { unlinkSync(absolute) })
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(true)
  writeFileSync(join(root, 'notes/draft.md'), 'Recreated outside.\n')
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
})

test('a trash that fails leaves the file there: delivered', async () => {
  await expect(ws.moveToTrash('notes/draft.md', async () => { throw new Error('no Trash') })).rejects.toThrow('no Trash')
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
})

test('a trash that fails, then another program deletes the file within five seconds: the delete is delivered', async () => {
  const delivered: string[][] = []
  const router = createWatchRouter(ws, (paths) => delivered.push(paths), 5)
  await expect(ws.moveToTrash('notes/draft.md', async () => { throw new Error('no Trash') })).rejects.toThrow('no Trash')
  unlinkSync(join(root, 'notes/draft.md'))
  router.take('notes/draft.md')
  await new Promise((resolve) => setTimeout(resolve, 20))
  router.dispose()
  expect(delivered).toEqual([['notes/draft.md']])
})

test('the command line\'s trash, move and second-name removal that fail leave no absent record: a later delete elsewhere is delivered', async () => {
  const session = new WriteSession(ws, { confirmOwner: async () => {}, onWrite: (path, expected) => ws.recordOwnWrite(path, expected) })
  await expect(session.trash('notes/draft.md', 'file', async () => { throw new Error('no Trash') })).rejects.toThrow('no Trash')
  unlinkSync(join(root, 'notes/draft.md'))
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)

  await writeFile(join(root, 'notes/kept.md'), MINE)
  await writeFile(join(root, 'notes/extra.md'), 'Not a second name.\n')
  await expect(session.dropSecondName('notes/extra.md', 'notes/kept.md')).rejects.toThrow()
  unlinkSync(join(root, 'notes/extra.md'))
  expect(ws.wasRecentlyWrittenByApp('notes/extra.md')).toBe(false)

  // The move's hard link fails after the commit check told the app the old name would be left empty.
  const link = spyOn(fsp, 'link').mockImplementation(async () => { throw Object.assign(new Error('disk error'), { code: 'EIO' }) })
  try {
    await expect(session.move('notes/kept.md', 'notes/moved.md', 'file')).rejects.toThrow()
  } finally {
    link.mockRestore()
  }
  unlinkSync(join(root, 'notes/kept.md'))
  expect(ws.wasRecentlyWrittenByApp('notes/kept.md')).toBe(false)
})

test('a guarded rename whose link fails after the move was recorded, then another program deletes the file: delivered', async () => {
  const link = spyOn(fsp, 'link').mockImplementation(async () => { throw Object.assign(new Error('disk error'), { code: 'EIO' }) })
  try {
    await expect(ws.renameFile('notes/draft.md', 'notes/moved.md', { documentOnly: true })).rejects.toThrow()
  } finally {
    link.mockRestore()
  }
  unlinkSync(join(root, 'notes/draft.md'))
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
})

test('a rename that fails after its move was recorded, then another program deletes the file: delivered', async () => {
  // The rename fails at the system call: the new name's folder does not exist and is not made.
  await expect(ws.renameFile('notes/draft.md', 'gone/draft.md', { requireExistingDirectory: true })).rejects.toThrow()
  unlinkSync(join(root, 'notes/draft.md'))
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(false)
})

test('a route that records no state (making a folder) is delivered', async () => {
  await ws.createFolder('made')
  expect(ws.wasRecentlyWrittenByApp('made')).toBe(false)
})

test('the command line\'s session tells the app the staged file\'s identity in the tick of the commit, and absent for a trash', async () => {
  const told: Array<[string, OwnWriteExpectation | undefined]> = []
  const session = new WriteSession(ws, { confirmOwner: async () => {}, onWrite: (path, expected) => { told.push([path, expected]) } })
  await session.create('notes/new.md', MINE)
  await session.replace('notes/draft.md', 'Rewritten.\n')
  const id = (path: string): OwnWriteExpectation => fileIdentityOf(lstatSync(join(root, path), { bigint: true }))
  const rewritten = id('notes/draft.md')
  await session.move('notes/new.md', 'notes/moved.md', 'file')
  await session.trash('notes/draft.md', 'file', async (absolute) => { unlinkSync(absolute) })
  // Each path is told first with no state (about to be written), then with the state its commit left.
  expect(told).toEqual([
    ['notes', undefined],
    ['notes/new.md', undefined], ['notes/new.md', id('notes/moved.md')],
    ['notes/draft.md', undefined], ['notes/draft.md', rewritten],
    ['notes', undefined],
    ['notes/new.md', undefined], ['notes/moved.md', undefined], ['notes/new.md', 'absent'], ['notes/moved.md', id('notes/moved.md')],
    ['notes/draft.md', undefined], ['notes/draft.md', 'absent'],
  ])
})

test('the watcher\'s router drops the app\'s own save and delivers another program\'s save made a moment later', async () => {
  const delivered: string[][] = []
  const router = createWatchRouter(ws, (paths) => delivered.push(paths), 5)
  await ws.saveFile('notes/draft.md', MINE)
  router.take('notes/draft.md')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(delivered).toEqual([])
  externalAtomicSave('notes/draft.md', 'Outside.\n')
  router.take('notes/draft.md')
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(delivered).toEqual([['notes/draft.md']])
  router.dispose()
})
