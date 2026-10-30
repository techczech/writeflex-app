/**
 * Review parcel P3 (R1.8, the write half, and D9): a `documentOnly` save stages through a no-follow
 * handle whose real location is checked, never writes through a link, and with `expect` refuses when
 * the document's bytes are not the ones its new text was worked out from. Seam: `Workspace.saveFile`,
 * with `documentSaveSeams.betweenCheckAndWrite` standing where another program would act.
 */
import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fingerprintOf } from '../../src/main/guarded-document-read'
import { GuardedWriteRefused, documentSaveSeams } from '../../src/main/guarded-document-write'
import { DocumentChangedError, NotADocumentPathError, Workspace, documentChangedMessage } from '../../src/main/workspace'

const DOC = '# Draft\n\nThe document itself.\n'
let root: string
let outside: string
let ws: Workspace

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-guarded-save-root-'))
  outside = await mkdtemp(join(tmpdir(), 'wf-guarded-save-outside-'))
  ws = new Workspace(root)
  await mkdir(join(root, 'notes'))
  await writeFile(join(root, 'notes/draft.md'), DOC)
})
afterEach(async () => {
  delete documentSaveSeams.betweenCheckAndWrite
  delete documentSaveSeams.afterFingerprint
  delete documentSaveSeams.afterFingerprintRead
  for (const dir of [root, outside]) await rm(dir, { recursive: true, force: true })
})

test('a folder swapped for a link between the check and the write: nothing is written at the far end, and nothing is left behind', async () => {
  await writeFile(join(outside, 'draft.md'), 'OUTSIDE\n')
  await mkdir(join(root, '.writeflex'))
  await writeFile(join(root, '.writeflex/draft.md'), 'HIDDEN\n')
  for (const [target, untouched] of [[outside, 'OUTSIDE\n'], [join(root, '.writeflex'), 'HIDDEN\n']] as const) {
    documentSaveSeams.betweenCheckAndWrite = async () => {
      delete documentSaveSeams.betweenCheckAndWrite
      await rename(join(root, 'notes'), join(root, 'notes-moved'))
      await symlink(target, join(root, 'notes'))
    }
    await expect(ws.saveFile('notes/draft.md', 'REPLACED\n', { documentOnly: true })).rejects.toBeInstanceOf(NotADocumentPathError)
    expect(await readFile(join(target, 'draft.md'), 'utf8')).toBe(untouched)
    expect((await readdir(target)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    expect(await readFile(join(root, 'notes-moved/draft.md'), 'utf8')).toBe(DOC)
    await rm(join(root, 'notes'))
    await rename(join(root, 'notes-moved'), join(root, 'notes'))
  }
})

test('a document that is itself a link is never written through, even to a document of the Collection', async () => {
  await writeFile(join(root, 'notes/real.md'), DOC)
  await symlink(join(root, 'notes/real.md'), join(root, 'notes/link.md'))
  const refused = await ws.saveFile('notes/link.md', 'REPLACED\n', { documentOnly: true }).then(() => null, (error: unknown) => error)
  expect(refused).toBeInstanceOf(GuardedWriteRefused)
  expect((refused as GuardedWriteRefused).code).toBe('is-a-link')
  expect(await readFile(join(root, 'notes/real.md'), 'utf8')).toBe(DOC)
})

test('with expect, the save writes only over the bytes its text was worked out from', async () => {
  const expectDoc = { documentOnly: true, expect: { fingerprint: fingerprintOf(DOC) } } as const
  const saved = await ws.saveFile('notes/draft.md', 'Second.\n', expectDoc)
  expect(saved.content).toBe('Second.\n')
  expect(ws.wasRecentlyWrittenByApp('notes/draft.md')).toBe(true)

  // The document is no longer DOC: refused, with the sentence for the writer, and nothing written.
  const refused = await ws.saveFile('notes/draft.md', 'Third.\n', expectDoc).then(() => null, (error: unknown) => error)
  expect(refused).toBeInstanceOf(DocumentChangedError)
  expect((refused as Error).message).toBe(documentChangedMessage('notes/draft.md'))
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe('Second.\n')
  expect((await readdir(join(root, 'notes'))).sort()).toEqual(['draft.md'])

  // Changed by another program after the path was judged, inside the save itself: refused the same way.
  documentSaveSeams.betweenCheckAndWrite = async () => { delete documentSaveSeams.betweenCheckAndWrite; await writeFile(join(root, 'notes/draft.md'), 'Second, edited elsewhere.\n') }
  await expect(ws.saveFile('notes/draft.md', 'Third.\n', { documentOnly: true, expect: { fingerprint: fingerprintOf('Second.\n') } })).rejects.toBeInstanceOf(DocumentChangedError)
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe('Second, edited elsewhere.\n')

  // A document that has gone is not written back as a new one.
  await rm(join(root, 'notes/draft.md'))
  await expect(ws.saveFile('notes/draft.md', 'Third.\n', expectDoc)).rejects.toBeInstanceOf(DocumentChangedError)
  expect(await readdir(join(root, 'notes'))).toEqual([])
})

test('with expect, a document changed or replaced after its bytes were matched is refused in the tick of the rename: the newer version stays, no temporary file is left', async () => {
  const expectDoc = { documentOnly: true, expect: { fingerprint: fingerprintOf(DOC) } } as const
  const changes: Array<[string, () => Promise<void>, string]> = [
    // Rewritten in place (same file, other bytes and size) while the checked handle closed.
    ['rewritten', () => writeFile(join(root, 'notes/draft.md'), 'EXTERNAL NEWER VERSION\n'), 'EXTERNAL NEWER VERSION\n'],
    // Replaced by another file of the same size (an editor's own atomic save): another inode at the name.
    ['replaced', async () => { await writeFile(join(root, 'notes/other.tmp-x'), DOC.toUpperCase()); await rename(join(root, 'notes/other.tmp-x'), join(root, 'notes/draft.md')) }, DOC.toUpperCase()],
  ]
  for (const [, change, newer] of changes) {
    await writeFile(join(root, 'notes/draft.md'), DOC)
    documentSaveSeams.afterFingerprint = async () => { delete documentSaveSeams.afterFingerprint; await change() }
    const refused = await ws.saveFile('notes/draft.md', 'MY STALE WRITE\n', expectDoc).then(() => null, (error: unknown) => error)
    expect(refused).toBeInstanceOf(DocumentChangedError)
    expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe(newer)
    expect((await readdir(join(root, 'notes'))).sort()).toEqual(['draft.md'])
  }
})

test('with expect, a document rewritten after its bytes were read but before its state was looked at again is refused: the newer version stays, no temporary file is left', async () => {
  documentSaveSeams.afterFingerprintRead = async () => { delete documentSaveSeams.afterFingerprintRead; await writeFile(join(root, 'notes/draft.md'), 'EXTERNAL NEWER VERSION\n') }
  const refused = await ws.saveFile('notes/draft.md', 'MY STALE WRITE\n', { documentOnly: true, expect: { fingerprint: fingerprintOf(DOC) } }).then(() => null, (error: unknown) => error)
  expect(refused).toBeInstanceOf(DocumentChangedError)
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe('EXTERNAL NEWER VERSION\n')
  expect((await readdir(join(root, 'notes'))).sort()).toEqual(['draft.md'])
})

test('with expect, a document rewritten while its bytes were being read (the read returns the old bytes) is refused: the newer version stays, no temporary file is left', async () => {
  const probe = await open(join(root, 'notes/draft.md'), 'r')
  const handles = Object.getPrototypeOf(probe) as { readFile: (...args: unknown[]) => Promise<Buffer> }
  await probe.close()
  const realReadFile = handles.readFile
  let rewritten = false
  const spy = spyOn(handles, 'readFile').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const bytes = await realReadFile.apply(this, args)
    // Another program rewrites the document before the read resolves; the read hands back what it had.
    if (!rewritten) { rewritten = true; await writeFile(join(root, 'notes/draft.md'), 'EXTERNAL NEWER VERSION\n') }
    return bytes
  })
  try {
    const refused = await ws.saveFile('notes/draft.md', 'MY STALE WRITE\n', { documentOnly: true, expect: { fingerprint: fingerprintOf(DOC) } }).then(() => null, (error: unknown) => error)
    expect(rewritten).toBe(true)
    expect(refused).toBeInstanceOf(DocumentChangedError)
  } finally {
    spy.mockRestore()
  }
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe('EXTERNAL NEWER VERSION\n')
  expect((await readdir(join(root, 'notes'))).sort()).toEqual(['draft.md'])
})

test('a save that expects is a guarded save whether or not it says documentOnly; a hidden path is refused', async () => {
  await mkdir(join(root, '.writeflex'))
  await writeFile(join(root, '.writeflex/state.md'), 'STATE\n')
  await expect(ws.saveFile('.writeflex/state.md', 'x\n', { expect: { fingerprint: fingerprintOf('STATE\n') } })).rejects.toBeInstanceOf(NotADocumentPathError)
  expect(await readFile(join(root, '.writeflex/state.md'), 'utf8')).toBe('STATE\n')
})

test('a guarded save keeps the file\'s permissions, makes a new document when there is none, and still rescues an emptied one', async () => {
  await chmod(join(root, 'notes/draft.md'), 0o600)
  await ws.saveFile('notes/draft.md', 'Second.\n', { documentOnly: true })
  expect((await stat(join(root, 'notes/draft.md'))).mode & 0o777).toBe(0o600)

  const made = await ws.saveFile('notes/new.md', 'New.\n', { documentOnly: true })
  expect([made.file.path, made.content]).toEqual(['notes/new.md', 'New.\n'])

  await expect(ws.saveFile('notes/draft.md', '   \n', { documentOnly: true })).rejects.toThrow(/prevented an empty save/)
  expect(await readFile(join(root, 'notes/draft.md'), 'utf8')).toBe('Second.\n')
  expect((await readdir(join(root, '.writeflex/rescue'))).some((name) => name.endsWith('--previous.md'))).toBe(true)
})
