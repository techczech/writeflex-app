import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../../src/main/workspace'
import { setCollectionPieceMode } from '../../src/main/collection'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import { setFolderPieceModeFlushed } from '../../src/renderer/src/app/folder-piece-mode'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import type { WriteFlexApi } from '../../src/preload'

const FOLDER = 'series/Long Work'
const INDEX = 'series/Long Work/_Long Work_INDEX.md'
const ORIGINAL = '---\npiece: one\n---\n\n# Long Work\n'
const DRAFT = ORIGINAL + '\nFirst edit in the resident buffer.\n'
const PATCHED = DRAFT.replace('piece: one', 'piece: many')

let root: string
let workspace: Workspace
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-folder-piece-mode-'))
  await mkdir(join(root, FOLDER), { recursive: true })
  await writeFile(join(root, INDEX), ORIGINAL, 'utf8')
  workspace = new Workspace(root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function editor() {
  let buffer = ORIGINAL
  const registry = createUnsavedRegistry()
  const owner = createDocumentOwner({
    buffer: (path) => path === INDEX ? buffer : null,
    notice: () => undefined,
    registry,
    write: (path, text, basis) => workspace.saveEditorText(path, text, basis),
    setReadOnly: () => {},
    forgetBuffer: () => {},
    renameBuffer: () => {},
    replaceBuffer: (path, text) => { if (path === INDEX) buffer = text },
    dirtyChanged: () => {},
    report: { slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {}, saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {} },
  })
  owner.activated(INDEX, ORIGINAL, () => buffer)
  const type = (text: string) => { buffer = text; owner.edited(INDEX, text) }
  const run = (setMode: WriteFlexApi['collection']['setPieceMode']) => setFolderPieceModeFlushed(owner, setMode, 'series', FOLDER, 'many')
  return { owner, registry, type, run, text: () => buffer }
}

test('Folder Piece mode flushes a dirty Index Note and reconciles the receipt to the editor', async () => {
  const note = editor()
  note.type(DRAFT)

  const result = await note.run(async (dir, folder, mode) => {
    expect((await workspace.readFile(INDEX)).content).toBe(DRAFT)
    return setCollectionPieceMode(workspace, dir, folder, mode)
  })

  expect(result).toEqual({ path: INDEX, outcome: { kind: 'clean' } })
  expect((await workspace.readFile(INDEX)).content).toBe(PATCHED)
  expect(note.text()).toBe(PATCHED)
  expect(note.owner.isSaved(INDEX)).toBe(true)
})

test('typing during the Folder Piece write stays in the buffer and unsaved registry', async () => {
  const note = editor()
  note.type(DRAFT)
  const latest = DRAFT + '\nTyped after the mode writer read the note.\n'
  const didRead = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = workspace.readFile.bind(workspace)
  const write = note.run(async (dir, folder, mode) => {
    workspace.readFile = async (path) => {
      const answer = await read(path)
      if (path === INDEX) {
        didRead.resolve()
        await release.promise
      }
      return answer
    }
    return setCollectionPieceMode(workspace, dir, folder, mode)
  })
  try {
    await Promise.race([didRead.promise, write.then(() => { throw new Error('Mode write completed before the read barrier') })])
    expect((await read(INDEX)).content).toBe(DRAFT)
    note.type(latest)
  } finally {
    release.resolve()
    await write
  }

  expect(await write).toEqual({ path: INDEX, outcome: { kind: 'moved', diskText: PATCHED } })
  expect((await read(INDEX)).content).toBe(PATCHED)
  expect(note.text()).toBe(latest)
  expect(note.registry.textOf(INDEX)).toBe(latest)
  expect(note.owner.isSaved(INDEX)).toBe(false)
})
