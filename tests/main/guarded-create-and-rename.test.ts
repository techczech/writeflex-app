/**
 * Review parcel P6, driver addition 1: `createFile`, `renameFile`, `renameFolder` and the two picture
 * saves, when the path came from an agent (`documentOnly`, which the document-only view always
 * passes), go through the guarded write and the guarded move, as `saveFile` does. Seam: the Workspace
 * methods, with `documentSaveSeams.betweenCheckAndWrite` standing where another program would act.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { documentOnlyView } from '../../src/main/document-only-workspace'
import { GuardedMoveRefused } from '../../src/main/guarded-document-move'
import { documentSaveSeams } from '../../src/main/guarded-document-write'
import { NotADocumentPathError, Workspace } from '../../src/main/workspace'

const DOC = '# Draft\n\nThe document itself.\n'
let root: string
let outside: string
let ws: Workspace
let agent: Workspace

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-guarded-rename-root-')))
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-guarded-rename-outside-')))
  ws = new Workspace(root)
  agent = documentOnlyView(ws).workspace
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/draft.md'), DOC)
})
afterEach(async () => {
  delete documentSaveSeams.betweenCheckAndWrite
  for (const dir of [root, outside]) await rm(dir, { recursive: true, force: true })
})

/** Once, at the gap: `notes` is put aside and a link to `target` stands in its place. */
const swapNotesFor = (target: string): void => {
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await rename(join(root, 'notes'), join(root, 'notes-moved'))
    await symlink(target, join(root, 'notes'))
  }
}
const failure = (work: Promise<unknown>): Promise<unknown> => work.then(() => null, (error: unknown) => error)

test('an agent\'s create never replaces a file that appeared at the name while it was being written', async () => {
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await writeFile(join(root, 'notes/new.md'), 'SOMEBODY ELSE\n')
  }
  const refused = await failure(agent.createFile('notes/new.md', 'AGENT\n'))
  expect((refused as Error).message).toBe('File already exists: notes/new.md')
  expect(await readFile(join(root, 'notes/new.md'), 'utf8')).toBe('SOMEBODY ELSE\n')
  expect((await readdir(join(root, 'notes'))).sort()).toEqual(['draft.md', 'new.md'])
  // With nothing in the way it is created, in a folder made for it, and recorded as the app's own write.
  const made = await agent.createFile('fresh/piece', 'AGENT\n')
  expect(made).toMatchObject({ content: 'AGENT\n', file: { path: 'fresh/piece.md' } })
  expect(ws.wasRecentlyWrittenByApp('fresh/piece.md')).toBe(true)
})

test('an agent\'s create writes nothing through a folder swapped for a link between the check and the write', async () => {
  swapNotesFor(outside)
  expect(await failure(agent.createFile('notes/new.md', 'AGENT\n'))).toBeInstanceOf(NotADocumentPathError)
  expect(await readdir(outside)).toEqual([])
  expect(await readdir(join(root, 'notes-moved'))).toEqual(['draft.md'])
})

test('an agent\'s rename never replaces a file that appeared at the new name, and leaves the document where it was', async () => {
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await writeFile(join(root, 'notes/final.md'), 'SOMEBODY ELSE\n')
  }
  const refused = await failure(agent.renameFile('notes/draft.md', 'notes/final.md'))
  expect((refused as Error).message).toBe('File already exists: notes/final.md')
  expect(await readFile(join(root, 'notes/final.md'), 'utf8')).toBe('SOMEBODY ELSE\n')
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe(DOC)
})

test('an agent\'s rename moves nothing through a swapped folder, never moves a link, and never moves a file swapped in at the old name', async () => {
  // The folder to move INTO becomes a link to outside the Collection.
  await mkdir(join(root, 'archive'))
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await rm(join(root, 'archive'), { recursive: true })
    await symlink(outside, join(root, 'archive'))
  }
  expect(await failure(agent.renameFile('notes/draft.md', 'archive/draft.md'))).toBeInstanceOf(NotADocumentPathError)
  expect(await readdir(outside)).toEqual([])
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe(DOC)
  await rm(join(root, 'archive'))

  // The document is replaced by another file at the same name in the gap: that other file is not moved.
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await rename(join(root, 'notes/draft.md'), join(root, 'notes/put-aside.md'))
    await writeFile(join(root, 'notes/draft.md'), 'SWAPPED IN\n')
  }
  expect(await failure(agent.renameFile('notes/draft.md', 'notes/moved.md'))).toBeInstanceOf(NotADocumentPathError)
  expect(existsSync(join(root, 'notes/moved.md'))).toBe(false)
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe('SWAPPED IN\n')

  // A link is not a document of its own: it is not moved, and neither is what it points at.
  await writeFile(join(outside, 'secret.md'), 'OUTSIDE\n')
  await symlink(join(root, 'notes/put-aside.md'), join(root, 'notes/link.md'))
  const link = await failure(ws.renameFile('notes/link.md', 'notes/link-moved.md', { documentOnly: true }))
  expect(link).toBeInstanceOf(GuardedMoveRefused)
  expect((link as GuardedMoveRefused).code).toBe('is-a-link')
  expect(existsSync(join(root, 'notes/link-moved.md'))).toBe(false)
})

test('an agent\'s rename works as before when nothing interferes: a new name, another folder made for it, another letter case', async () => {
  expect(await agent.renameFile('notes/draft.md', 'final')).toMatchObject({ content: DOC, file: { path: 'notes/final.md' } })
  expect(await agent.renameFile('notes/final.md', 'made/for/it.md')).toMatchObject({ content: DOC, file: { path: 'made/for/it.md' } })
  expect(ws.wasRecentlyWrittenByApp('made/for/it.md')).toBe(true)
  expect((await agent.renameFile('made/for/it.md', 'made/for/IT.md')).file.path).toBe('made/for/IT.md')
  expect(await readdir(join(root, 'made/for'))).toEqual(['IT.md'])
  expect(await readdir(join(root, 'notes'))).toEqual([])
  expect((await failure(agent.renameFile('made/for/IT.md', 'notes/../made/for/IT.md')))).toBeNull()
})

test('an agent\'s folder rename moves nothing when the folder above it was swapped for a link, and refuses a name that is taken', async () => {
  await mkdir(join(root, 'notes/inner'))
  await writeFile(join(root, 'notes/inner/a.md'), 'A\n')
  await mkdir(join(outside, 'inner'))
  swapNotesFor(outside)
  expect(await failure(agent.renameFolder('notes/inner', 'renamed'))).toBeInstanceOf(NotADocumentPathError)
  expect(await readdir(outside)).toEqual(['inner'])
  expect((await readdir(join(root, 'notes-moved'))).sort()).toEqual(['draft.md', 'inner'])
  await rm(join(root, 'notes'))
  await rename(join(root, 'notes-moved'), join(root, 'notes'))

  expect(await agent.renameFolder('notes/inner', 'renamed')).toEqual({ path: 'notes/renamed' })
  expect(await readFile(join(root, 'notes/renamed/a.md'), 'utf8')).toBe('A\n')
  await mkdir(join(root, 'notes/taken'))
  expect(((await failure(agent.renameFolder('notes/renamed', 'taken'))) as Error).message).toContain('already exists here')
})

test('a picture an agent saves is a new file written by the guarded write: nothing lands through a swapped assets folder', async () => {
  await mkdir(join(root, 'assets'))
  documentSaveSeams.betweenCheckAndWrite = async () => {
    delete documentSaveSeams.betweenCheckAndWrite
    await rm(join(root, 'assets'), { recursive: true })
    await symlink(outside, join(root, 'assets'))
  }
  expect(await failure(agent.saveNamedImage(new Uint8Array([1, 2, 3]), 'figure.png'))).toBeInstanceOf(NotADocumentPathError)
  expect(await readdir(outside)).toEqual([])
  await rm(join(root, 'assets'))
  expect(await agent.saveNamedImage(new Uint8Array([1, 2, 3]), 'figure.png')).toEqual({ path: 'assets/figure.png' })
  expect([...(await readFile(join(root, 'assets/figure.png')))]).toEqual([1, 2, 3])
  expect((await agent.saveImage(new Uint8Array([4]), 'png')).path).toMatch(/^assets\/pasted-.*\.png$/)
})
