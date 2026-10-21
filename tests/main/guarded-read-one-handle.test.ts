/**
 * Review parcel P3 (R1.8, R3.6): no read made for the command line, for a request or for an agent
 * capability returns bytes from a file that was a link, or from outside a document path, at the moment
 * the bytes were read. Seams: the command line's `readBytes` (its `betweenCheckAndWrite` seam), the
 * guarded Workspace and the document-only view (`guardedReadSeams.beforeOpen`), and the copy made by
 * `duplicateFile`. Every swap is planted through a seam that runs after the path has been judged.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBytes } from '../../src/main/cli/guarded-fs'
import { CommandLineWorkspace } from '../../src/main/cli/guarded-workspace'
import { documentOnlyView } from '../../src/main/document-only-workspace'
import { fingerprintOf, fingerprintOfRead, guardedReadSeams, readDocumentBytesGuarded } from '../../src/main/guarded-document-read'
import { Workspace } from '../../src/main/workspace'

const SECRET = 'SECRET: not a document of this Collection.\n'
const DOC = '# Draft\n\nThe document itself.\n'

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-one-handle-root-'))
  outside = await mkdtemp(join(tmpdir(), 'wf-one-handle-outside-'))
  await mkdir(join(root, 'notes'))
  await mkdir(join(root, '.writeflex'))
  await writeFile(join(root, 'notes/draft.md'), DOC)
  await writeFile(join(root, '.writeflex/hidden.md'), SECRET)
  await writeFile(join(outside, 'secret.md'), SECRET)
})
afterEach(async () => {
  delete guardedReadSeams.beforeOpen
  for (const dir of [root, outside]) await rm(dir, { recursive: true, force: true })
})

/** Put a link to `target` where the document is, as a program would between the check and the read. */
const plantLink = async (target: string): Promise<void> => {
  await unlink(join(root, 'notes/draft.md'))
  await symlink(target, join(root, 'notes/draft.md'))
}
/** Replace the document's folder with a link to `target`, a folder that holds a `draft.md` of its own. */
const swapFolder = async (target: string): Promise<void> => {
  await rename(join(root, 'notes'), join(root, 'notes-moved'))
  await symlink(target, join(root, 'notes'))
}

test('readBytes: a link put at the document between the check and the read is refused, and nothing at its far end is returned', async () => {
  const ws = new CommandLineWorkspace(root)
  expect((await readBytes(ws, 'notes/draft.md')).toString('utf8')).toBe(DOC)

  for (const target of [join(outside, 'secret.md'), join(root, '.writeflex/hidden.md')]) {
    await rm(join(root, 'notes/draft.md'), { force: true })
    await writeFile(join(root, 'notes/draft.md'), DOC)
    let planted = 0
    const read = readBytes(ws, 'notes/draft.md', { betweenCheckAndWrite: async (path) => { expect(path).toBe('notes/draft.md'); planted += 1; await plantLink(target) } })
    await expect(read).rejects.toThrow(/is a link; the command line does not read or write through a linked file/)
    expect(planted).toBe(1)
  }
})

test('readBytes: a folder above the document swapped for a link between the check and the read is refused by the opened file\'s real location', async () => {
  const ws = new CommandLineWorkspace(root)
  await writeFile(join(outside, 'draft.md'), SECRET)
  await writeFile(join(root, '.writeflex/draft.md'), SECRET)
  for (const target of [outside, join(root, '.writeflex')]) {
    const read = readBytes(ws, 'notes/draft.md', { betweenCheckAndWrite: () => swapFolder(target) })
    await expect(read).rejects.toThrow(/notes\/draft\.md was not read: its folder changed while the command was running/)
    await unlink(join(root, 'notes'))
    await rename(join(root, 'notes-moved'), join(root, 'notes'))
  }
})

test('the guarded Workspace and the document-only view read through the same one handle: a link planted after the path is judged is refused', async () => {
  const commandLine = new CommandLineWorkspace(root)
  const view = documentOnlyView(new Workspace(root))
  for (const [name, read] of [
    ['command line', (path: string) => commandLine.readFile(path)],
    ['document-only view', (path: string) => view.workspace.readFile(path)],
  ] as const) {
    await rm(join(root, 'notes/draft.md'), { force: true })
    await writeFile(join(root, 'notes/draft.md'), DOC)
    expect((await read('notes/draft.md')).content, name).toBe(DOC)

    guardedReadSeams.beforeOpen = async () => { delete guardedReadSeams.beforeOpen; await plantLink(join(outside, 'secret.md')) }
    const refused = await read('notes/draft.md').then((result) => result.content, (error: unknown) => error)
    expect(refused, name).toBeInstanceOf(Error)
    expect(String((refused as Error).message), name).not.toContain('SECRET')
    expect((refused as NodeJS.ErrnoException).code, name).toBe('ELOOP')
  }
  // A document that is itself a link is refused even when nothing races: its text is whatever the link points at.
  await rm(join(root, 'notes/draft.md'), { force: true })
  await writeFile(join(root, 'notes/real.md'), DOC)
  await symlink(join(root, 'notes/real.md'), join(root, 'notes/draft.md'))
  await expect(commandLine.readFile('notes/draft.md')).rejects.toMatchObject({ code: 'ELOOP' })
  await expect(view.workspace.readFile('notes/draft.md')).rejects.toMatchObject({ code: 'ELOOP' })
})

test('a path that is hidden or outside reads as a file that is not there; a folder as a folder', async () => {
  const commandLine = new CommandLineWorkspace(root)
  await expect(commandLine.readFile('.writeflex/hidden.md')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(commandLine.readFile('notes/none.md')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(commandLine.readFile('notes')).rejects.toMatchObject({ code: 'EISDIR' })
})

test('duplicate through the document-only view copies the bytes of one guarded read: a link planted at the source makes no copy', async () => {
  const view = documentOnlyView(new Workspace(root))
  guardedReadSeams.beforeOpen = async () => { delete guardedReadSeams.beforeOpen; await plantLink(join(outside, 'secret.md')) }
  await expect(view.workspace.duplicateFile('notes/draft.md')).rejects.toMatchObject({ code: 'ELOOP' })
  expect((await readdir(join(root, 'notes'))).sort()).toEqual(['draft.md'])

  // With nothing planted the copy is the document's own bytes, byte for byte.
  await unlink(join(root, 'notes/draft.md'))
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('# Draft\r\n\r\nWith a BOM and CRLF.\r\n')])
  await writeFile(join(root, 'notes/draft.md'), bytes)
  const copy = await view.workspace.duplicateFile('notes/draft.md')
  expect(copy.file.path).toBe('notes/draft (copy).md')
  expect(Buffer.compare(await readFile(join(root, 'notes/draft (copy).md')), bytes)).toBe(0)
})

test('a guarded read carries the fingerprint of the very bytes it read, out of sight of anything that copies the result', async () => {
  const ws = new CommandLineWorkspace(root)
  const read = await ws.readFile('notes/draft.md')
  expect(fingerprintOfRead(read)).toBe(fingerprintOf(Buffer.from(DOC)))
  expect(Object.keys(read).sort()).toEqual(['content', 'file'])
  expect(JSON.parse(JSON.stringify(read))).toEqual({ file: read.file, content: DOC })
  // A read made any other way is fingerprinted by its text.
  expect(fingerprintOfRead({ ...read })).toBe(fingerprintOf(DOC))
  expect((await readDocumentBytesGuarded(ws, 'notes/draft.md')).bytes.toString('utf8')).toBe(DOC)
})
