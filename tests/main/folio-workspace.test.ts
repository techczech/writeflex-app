/**
 * Folio room ticket 02 (spec-folio-room-data-model § 9 D-WRITE-1, invariants I-2, I-4, I-6): `FolioWorkspace`, the one
 * pinned workspace view room code is given.
 *
 * Seams: `new FolioWorkspace(ws, dir)` and its five writers; the reused writers called with it in place of `ws`
 * (`reorderParts` / `movePart` / `insertPart` / `removePart` / `adoptParts` through `commitPlanDocuments`,
 * `materialisePart` and its clean-up, `setCollectionPieceStatus` (the status route's writer), `undoRecordedAdd`).
 * Where another program acts: the Plan writers' checkpoints (`beforeIndexWrite` / `beforeManifestWrite`), a failing
 * manifest write (the real Workspace's `saveFileWithoutReadBack` replaced for the manifest's path, as
 * plan-lock-and-rollback.test.ts does) and `documentSaveSeams.afterStage` (between the stage and the commit).
 *
 * Fixtures (synthetic): F-PANGRAM (tests/fixtures/folio-room) as `paper/`, a second Folio `other/`, and F-LINK:
 * `paper/contents` (or the Folio folder itself) a symbolic link into `other/`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { setCollectionPieceStatus } from '../../src/main/collection'
import { documentOnlyView } from '../../src/main/document-only-workspace'
import { forgetAddUndoRecords, recordingAdd, undoRecordedAdd } from '../../src/main/folio-add-undo'
import { invalidateFolioOrderFacts } from '../../src/main/folio-order-cache'
import { invalidateFolioPlaces } from '../../src/main/folio-place'
import {
  FOLIO_BLOCKED, FOLIO_READERS, FOLIO_REFUSAL, FOLIO_WRITERS, FolioWorkspace, NotAllowedFromFolioRoom, NotInsideFolioError,
  ROOM_REFUSAL, unclassifiedWorkspaceMembers,
} from '../../src/main/folio-workspace'
import { documentSaveSeams, type FolderIdentity } from '../../src/main/guarded-document-write'
import { adoptParts, insertPart, materialisePart, movePart, readPlan, removePart, reorderParts } from '../../src/main/plan'
import { withPlanLock } from '../../src/main/plan-lock'
import { NotADocumentPathError, Workspace } from '../../src/main/workspace'
import { pangramFolio } from '../fixtures/folio-room/folio-room-fixtures'

const DIR = 'paper'
const INDEX = `${DIR}/_paper_INDEX.md`
const MANIFEST = `${DIR}/_report-structure.json`
const SUMMARY = `${DIR}/contents/01-summary.md`
let root: string
let ws: Workspace
let fws: FolioWorkspace

const fresh = async (): Promise<string> => {
  const at = realpathSync(await mkdtemp(join(tmpdir(), 'wf-folio-workspace-')))
  invalidateFolioPlaces(at)
  invalidateFolioOrderFacts(at)
  return at
}
beforeEach(async () => {
  root = await fresh()
  await pangramFolio(root, DIR)
  await mkdir(join(root, 'other/contents'), { recursive: true })
  await writeFile(join(root, 'other/_other_INDEX.md'), '# Other\n\n## Running order\n\n- [[Notes]]\n')
  await writeFile(join(root, 'other/contents/notes.md'), '# Notes\n\nNotes of the other Folio.\n')
  ws = new Workspace(root)
  fws = new FolioWorkspace(ws, DIR)
  forgetAddUndoRecords()
})
afterEach(async () => {
  delete documentSaveSeams.afterStage
  await rm(root, { recursive: true, force: true })
})

/** Every entry under `dir`, never following a link: path → file text, `link → target` or `folder`. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name)
      const key = relative(dir, path)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) out[key] = `link → ${await readlink(path)}`
      else if (stat.isDirectory()) { out[key] = 'folder'; await walk(path) }
      else {
        const text = await readFile(path, 'utf8')
        // Compare provenance content across twin folders; timestamps and filesystem identities differ.
        out[key] = key.endsWith('.writeflex-backup.json')
          ? JSON.stringify({ ...JSON.parse(text), createdAt: '<time>', identity: '<identity>' })
          : text
      }
    }
  }
  await walk(dir)
  return out
}
const read = (rel: string, at = root): Promise<string> => readFile(join(at, rel), 'utf8')

/** F-LINK on the parts folder: `paper/contents` becomes a link to the other Folio's `contents/`, which receives the
 *  folder that stood there (so the link leads to the very folder the writer read). */
const linkContentsIntoOther = async (): Promise<void> => {
  await rm(join(root, 'other/contents'), { recursive: true })
  await rename(join(root, 'paper/contents'), join(root, 'other/contents'))
  await symlink(join(root, 'other/contents'), join(root, 'paper/contents'))
}
/** F-LINK on the Folio folder: `paper/` moved inside the other Folio and a link to it put at its old name. */
const linkFolioIntoOther = async (): Promise<void> => {
  await rename(join(root, 'paper'), join(root, 'other/paper'))
  await symlink(join(root, 'other/paper'), join(root, 'paper'))
}

// ---- The view: what it is and what it lets through -------------------------------------------------------------

test('prototype enumeration: every own key of Workspace.prototype (constructor and symbols included) and of a Workspace is a pinned writer, a reader or blocked, and no member is in two lists', () => {
  expect(unclassifiedWorkspaceMembers()).toEqual([])
  expect(unclassifiedWorkspaceMembers(ws)).toEqual([])
  expect(Reflect.ownKeys(Workspace.prototype)).toContain('constructor')
  expect(FOLIO_BLOCKED.has('constructor')).toBe(true)
  const lists = [FOLIO_WRITERS, FOLIO_READERS, FOLIO_BLOCKED]
  for (const name of new Set(lists.flatMap((list) => [...list]))) expect(lists.filter((list) => list.has(name)).length).toBe(1)
  expect([...FOLIO_WRITERS].sort()).toEqual(['createFile', 'removeFileOverRead', 'saveFile', 'saveFileOver', 'saveFileWithoutReadBack', 'setAsideBackupRecord'])
})

test('a mutating method added to Workspace.prototype later is caught by the enumeration and refused from the room', () => {
  const proto = Workspace.prototype as unknown as Record<string, unknown>
  let called = false
  proto.eraseEverything = function eraseEverything() { called = true }
  try {
    expect(unclassifiedWorkspaceMembers()).toEqual(['eraseEverything'])
    const view = fws as unknown as Record<string, () => void>
    expect(() => view.eraseEverything()).toThrow(ROOM_REFUSAL)
    expect(called).toBe(false)
  } finally {
    delete proto.eraseEverything
  }
  expect(unclassifiedWorkspaceMembers()).toEqual([])
})

test('a symbol-keyed member of Workspace is caught by the enumeration and refused from the room; a symbol Workspace lacks reads as absent', () => {
  const proto = Workspace.prototype as unknown as Record<symbol, unknown>
  const key = Symbol('eraseEverything')
  let called = false
  proto[key] = function eraseEverything() { called = true }
  try {
    expect(unclassifiedWorkspaceMembers()).toEqual([key])
    const view = fws as unknown as Record<symbol, () => void>
    expect(() => view[key]()).toThrow(ROOM_REFUSAL)
    expect(() => (Object.getPrototypeOf(fws) as Record<symbol, () => void>)[key].call(fws)).toThrow(ROOM_REFUSAL)
    expect(called).toBe(false)
  } finally {
    delete proto[key]
  }
  expect((fws as unknown as Record<symbol, unknown>)[Symbol.iterator]).toBeUndefined()
})

/** The Workspace members that write, move, remove or make something other than the five writers, listed here by
 *  hand from workspace.ts (an oracle independent of the view's own lists). */
const KNOWN_MUTATING = [
  'saveFileOverRead', 'saveEditorText', 'saveImage', 'saveNamedImage', 'duplicateFile', 'moveToTrash',
  'createFolder', 'renameFolder', 'renameFile', 'receiptForOwnRoute', 'writeAppStoreFile',
]
/** Blocked though they write nothing themselves: `constructor` makes a bare Workspace; `assertWritable` is the gate a
 *  Workspace method taken from the class and run on the view asks first. */
const BLOCKED_GATES = ['constructor', 'assertWritable']

test('every mutating member other than the five writers throws "Not allowed from the Folio room" when called, and writes nothing', async () => {
  const before = await tree(root)
  const view = fws as unknown as Record<string, (...args: unknown[]) => unknown>
  expect([...FOLIO_BLOCKED].sort()).toEqual([...KNOWN_MUTATING, ...BLOCKED_GATES].sort())
  for (const name of KNOWN_MUTATING) expect(FOLIO_READERS.has(name)).toBe(false)
  for (const name of new Set([...KNOWN_MUTATING, ...FOLIO_BLOCKED])) {
    let thrown: unknown
    try { await view[name](SUMMARY, 'x', { kind: 'disk', text: 'x' }) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(NotAllowedFromFolioRoom)
    expect((thrown as Error).message).toBe(ROOM_REFUSAL)
  }
  expect(await tree(root)).toEqual(before)
})

test('S-1: `.constructor` one hop (the view) and two hops (the view\'s prototype) away refuses, and `new` on it writes nothing', async () => {
  const before = await tree(root)
  const Made = (fws as unknown as { constructor: new (root: string) => Workspace }).constructor
  expect(Made).not.toBe(Workspace)
  let thrown: unknown
  try { await new Made(fws.root).saveFile('other/contents/notes.md', 'HIJACKED\n') } catch (error) { thrown = error }
  expect(thrown).toBeInstanceOf(NotAllowedFromFolioRoom)
  expect((thrown as Error).message).toBe(ROOM_REFUSAL)
  expect(() => (Object.getPrototypeOf(fws) as { constructor: new (root: string) => Workspace }).constructor.call(fws, root)).toThrow(ROOM_REFUSAL)
  expect(await tree(root)).toEqual(before)
})

const NOTES = '# Notes\n\nNotes of the other Folio.\n'
/** Arguments that aim each Workspace member at the other Folio (or, for the pictures, at the Collection's assets). */
const aimedAtOther = (trash: (absolute: string) => Promise<void>): Record<string, unknown[]> => ({
  writeAppStoreFile: ['.writeflex/folio-declarations-set-aside.json', () => 'HIJACKED\n'],
  saveFile: ['other/contents/notes.md', 'HIJACKED\n'],
  saveFileWithoutReadBack: ['other/contents/notes.md', 'HIJACKED\n'],
  saveFileOver: ['other/contents/notes.md', 'HIJACKED\n', { kind: 'disk', text: NOTES }],
  createFile: ['other/contents/new.md', 'NEW\n'],
  removeFileOverRead: ['other/contents/notes.md', NOTES],
  saveFileOverRead: ['other/contents/notes.md', 'HIJACKED\n', NOTES],
  saveEditorText: ['other/contents/notes.md', 'HIJACKED\n', { kind: 'disk', text: NOTES }],
  saveImage: [new Uint8Array([1, 2, 3]), 'png'],
  saveNamedImage: [new Uint8Array([1, 2, 3]), 'evil.png'],
  duplicateFile: ['other/contents/notes.md'],
  moveToTrash: ['other/contents/notes.md', trash],
  createFolder: ['other/evil'],
  renameFolder: ['other/contents', 'evil'],
  renameFile: ['other/contents/notes.md', 'other/contents/evil.md'],
  setAsideBackupRecord: ['other/contents/notes.md.writeflex-backup.json', '.writeflex/backup-records-set-aside/record.json'],
  receiptForOwnRoute: ['other/contents/notes.md', 'HIJACKED\n'],
})

for (const route of ['Workspace.prototype', 'Object.getPrototypeOf(fws)'] as const) {
  test(`S-2: every writing member taken from ${route} and called on the view refuses; nothing anywhere changes and the Trash is never asked`, async () => {
    const before = await tree(root)
    let trashed = 0
    const args = aimedAtOther(async () => { trashed += 1 })
    const proto = (route === 'Workspace.prototype' ? Workspace.prototype : Object.getPrototypeOf(fws)) as Record<string, (...a: unknown[]) => unknown>
    expect(Object.keys(args).sort()).toEqual([...FOLIO_WRITERS, ...KNOWN_MUTATING].sort())
    for (const [name, list] of Object.entries(args)) {
      let thrown: unknown
      try { await proto[name].call(fws, ...list) } catch (error) { thrown = error }
      expect(thrown, name).toBeInstanceOf(Error)
      // Taken from the class, `receiptForOwnRoute` needs a private field the view does not have: a TypeError.
      if (route === 'Workspace.prototype' && name === 'receiptForOwnRoute') expect(thrown).toBeInstanceOf(TypeError)
      else expect([ROOM_REFUSAL, FOLIO_REFUSAL], name).toContain((thrown as Error).message)
      if (route === 'Object.getPrototypeOf(fws)' && FOLIO_BLOCKED.has(name)) expect(thrown, name).toBeInstanceOf(NotAllowedFromFolioRoom)
    }
    expect(trashed).toBe(0)
    expect(await tree(root)).toEqual(before)
  })
}

test('S-2 Probe B: createFolder and moveToTrash taken from the class refuse on the view; the other Folio is byte-identical and the Trash is never asked', async () => {
  const other = await tree(join(root, 'other'))
  let trashed = false
  const proto = Workspace.prototype
  await expect(proto.createFolder.call(fws, 'other/evil')).rejects.toThrow(ROOM_REFUSAL)
  await expect(proto.moveToTrash.call(fws, 'other/contents/notes.md', async () => { trashed = true })).rejects.toThrow(ROOM_REFUSAL)
  await expect(proto.renameFolder.call(fws, 'other/contents', 'evil')).rejects.toThrow(ROOM_REFUSAL)
  expect(trashed).toBe(false)
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('S-2: the view\'s prototype inherits from Workspace.prototype, so instanceof holds, and it cannot be changed', () => {
  const shadow = Object.getPrototypeOf(fws) as object
  expect(shadow).not.toBe(Workspace.prototype)
  expect(Object.getPrototypeOf(shadow)).toBe(Workspace.prototype)
  expect(fws instanceof Workspace).toBe(true)
  expect(() => Object.setPrototypeOf(fws, Object.prototype)).toThrow(ROOM_REFUSAL)
  expect(() => { (shadow as Record<string, unknown>).createFolder = () => undefined }).toThrow(ROOM_REFUSAL)
})

test('T-1: the four async writers refuse with a rejected promise, never a synchronous throw; removeFileOverRead throws in place, as the Workspace\'s does', async () => {
  for (const write of [
    () => fws.saveFile('other/contents/notes.md', 'x\n'),
    () => fws.saveFileWithoutReadBack('other/contents/notes.md', 'x\n'),
    () => fws.saveFileOver('other/contents/notes.md', 'x\n', { kind: 'disk', text: NOTES }),
    () => fws.createFile('other/contents/new.md', 'x\n'),
  ]) {
    let promise: Promise<unknown> | undefined
    expect(() => { promise = write() }).not.toThrow()
    await expect(promise as Promise<unknown>).rejects.toThrow(FOLIO_REFUSAL)
  }
  expect(() => fws.removeFileOverRead('other/contents/notes.md', NOTES)).toThrow(FOLIO_REFUSAL)
})

test('every writer is the view\'s own, never the Workspace\'s; the view cannot be changed', () => {
  const view = fws as unknown as Record<string, unknown>
  const proto = Workspace.prototype as unknown as Record<string, unknown>
  for (const name of FOLIO_WRITERS) expect(view[name]).not.toBe(proto[name])
  expect(() => { (fws as unknown as Record<string, unknown>).saveFile = () => undefined }).toThrow(ROOM_REFUSAL)
  expect(() => { fws.onWriteNotice = () => undefined }).toThrow(ROOM_REFUSAL)
})

test('it reads like the Workspace, and is both a Workspace and a FolioWorkspace', async () => {
  expect(fws).toBeInstanceOf(Workspace)
  expect(fws).toBeInstanceOf(FolioWorkspace)
  expect(ws).not.toBeInstanceOf(FolioWorkspace)
  expect(fws.root).toBe(ws.root)
  expect(fws.folioDir).toBe(DIR)
  expect(new FolioWorkspace(ws, './paper/').folioDir).toBe(DIR)
  expect(await fws.readFile('other/contents/notes.md')).toEqual(await ws.readFile('other/contents/notes.md'))
  expect(await fws.listFiles()).toEqual(await ws.listFiles())
  expect(fws.classifyPath(SUMMARY)).toBe('document')
  expect(() => new FolioWorkspace(ws, '../elsewhere')).toThrow('A Folio folder must be a folder inside the open Workspace.')
})

test('I-4: reading through the view writes nothing (no backup, no checkpoint)', async () => {
  const before = await tree(root)
  await readPlan(fws, DIR)
  await fws.listFilesAndFolders()
  await fws.readFile(INDEX)
  await fws.search('Summary')
  expect(await tree(root)).toEqual(before)
})

// ---- Refusals: outside the Folio, `..`, a missing folder -----------------------------------------------------------

const WRITES: Array<[string, (view: FolioWorkspace, path: string) => Promise<unknown> | unknown]> = [
  ['saveFile', (view, path) => view.saveFile(path, 'HIJACKED\n')],
  ['saveFileWithoutReadBack', (view, path) => view.saveFileWithoutReadBack(path, 'HIJACKED\n')],
  ['saveFileOver', (view, path) => view.saveFileOver(path, 'HIJACKED\n', { kind: 'disk', text: '# Notes\n\nNotes of the other Folio.\n' })],
  ['createFile', (view, path) => view.createFile(path.replace(/\.md$/, '-new.md'), 'NEW\n')],
  ['removeFileOverRead', (view, path) => view.removeFileOverRead(path, '# Notes\n\nNotes of the other Folio.\n')],
]

for (const [name, write] of WRITES) {
  test(`${name}: a path outside the Folio, one whose \`..\` leaves it, one leaving the workspace and a missing parent folder are each refused in plain words; nothing is written`, async () => {
    const before = await tree(root)
    for (const path of ['other/contents/notes.md', 'paper/../other/contents/notes.md', '../outside.md', '/etc/x.md', 'paper/drafts/notes.md', 'paper\\..\\other\\notes.md']) {
      let thrown: unknown
      try { await write(fws, path) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(NotInsideFolioError)
      expect(thrown).toBeInstanceOf(NotADocumentPathError)
      expect((thrown as Error).message).toBe(FOLIO_REFUSAL)
    }
    expect(await tree(root)).toEqual(before)
    expect(await lstat(join(root, 'paper/drafts')).catch(() => null)).toBeNull() // the room never makes a folder
  })
}

test('the view writes inside the Folio, at any depth, by the guarded write; a hidden folder inside it is refused as hidden', async () => {
  await fws.saveFile(SUMMARY, '# Summary\n\nRewritten.\n')
  expect(await read(SUMMARY)).toBe('# Summary\n\nRewritten.\n')
  const created = await fws.createFile(`${DIR}/feedback/reviews/second`, 'NEW\n')
  expect(created.file.path).toBe(`${DIR}/feedback/reviews/second.md`)
  fws.removeFileOverRead(`${DIR}/feedback/reviews/second.md`, 'NEW\n')
  expect(await lstat(join(root, DIR, 'feedback/reviews/second.md')).catch(() => null)).toBeNull()
  // documentOnly is forced: a folder WriteFlex keeps for itself is refused, though it is inside the Folio.
  await mkdir(join(root, DIR, '.writeflex'))
  await expect(fws.saveFile(`${DIR}/.writeflex/x.md`, 'x\n')).rejects.toThrow('is in a folder WriteFlex keeps for itself')
  // A removal of a changed file still compares bytes (I-6).
  await expect(Promise.resolve().then(() => fws.removeFileOverRead(SUMMARY, 'not what is there'))).rejects.toThrow()
  expect(await read(SUMMARY)).toBe('# Summary\n\nRewritten.\n')
})

for (const [name, write] of [
  ['saveFile', () => fws.saveFile(SUMMARY, 'HIJACKED\n')],
  ['saveFileOver', async () => fws.saveFileOver(SUMMARY, 'HIJACKED\n', { kind: 'disk', text: await read(SUMMARY) })],
  ['createFile', () => fws.createFile(`${DIR}/contents/03-new.md`, 'NEW\n')],
] as const) {
  test(`move-and-relink race (${name}): the pin is forced, so a parts folder swapped for a link between the stage and the commit is refused in the room's words`, async () => {
    let raced = false
    documentSaveSeams.afterStage = async () => {
      delete documentSaveSeams.afterStage
      raced = true
      await linkContentsIntoOther()
    }
    const after = { snapshot: {} as Record<string, string> }
    const outcome = await Promise.resolve(write()).catch((error: unknown) => error)
    expect(raced).toBe(true)
    expect(outcome).toBeInstanceOf(NotInsideFolioError)
    expect((outcome as Error).message).toBe(FOLIO_REFUSAL)
    after.snapshot = await tree(join(root, 'other'))
    expect(after.snapshot['contents/03-new.md']).toBeUndefined()
    expect(after.snapshot['contents/01-summary.md']).not.toBe('HIJACKED\n')
    expect(Object.keys(after.snapshot).some((key) => key.endsWith('.tmp'))).toBe(false)
  })
}

// ---- T-CONTAIN on F-LINK ----------------------------------------------------------------------------------------

test('T-CONTAIN F-LINK: a status write through the view is refused and the other Folio is byte-identical; through the bare Workspace it would land there', async () => {
  await linkContentsIntoOther()
  const other = await tree(join(root, 'other'))
  const refused = await setCollectionPieceStatus(fws, DIR, SUMMARY, 'draft').catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(NotInsideFolioError)
  expect((refused as Error).message).toBe(FOLIO_REFUSAL)
  expect(await tree(join(root, 'other'))).toEqual(other)
  // Control: the same write without the view goes through the link into the other Folio.
  await setCollectionPieceStatus(ws, DIR, SUMMARY, 'draft')
  expect(await read('other/contents/01-summary.md')).toContain('status: draft')
})

for (const backups of ['absent', 'already made'] as const) test(`T-CONTAIN F-LINK (backups ${backups}): a Plan write and its backup are refused when the Folio folder is a link into the other Folio by the time they write; the other Folio is byte-identical`, async () => {
  // Backups already made: the Plan write skips them, so the Index Note write itself is the one refused.
  if (backups === 'already made') for (const path of [INDEX, MANIFEST]) await writeFile(join(root, `${path}.writeflex-backup`), await read(path))
  let other: Record<string, string> = {}
  const refused = await reorderParts(fws, DIR, [1, 0], {
    beforeIndexWrite: async () => { await linkFolioIntoOther(); other = await tree(join(root, 'other')) },
  }).catch((error: unknown) => error)
  expect((refused as Error).message).toBe(FOLIO_REFUSAL)
  expect(await tree(join(root, 'other'))).toEqual(other)
  if (backups === 'absent') expect(other['paper/_paper_INDEX.md.writeflex-backup']).toBeUndefined() // the backup was refused
  expect(other['paper/_paper_INDEX.md']).toContain('- [[Summary]]')
  expect(other['paper/_paper_INDEX.md'].indexOf('[[Summary]]')).toBeLessThan(other['paper/_paper_INDEX.md'].indexOf('[[Details]]'))
})

test('T-CONTAIN F-LINK: the restore after a failed manifest write is refused when the Folio folder became a link; the other Folio is byte-identical', async () => {
  let other: Record<string, string> = {}
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === MANIFEST) {
      await linkFolioIntoOther()
      other = await tree(join(root, 'other'))
      throw new Error('EACCES: permission denied')
    }
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  const refused = await movePart(fws, DIR, 0, 1).catch((error: unknown) => error)
  expect((refused as Error).message).toContain('the Index Note could not be put back as it was')
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('T-CONTAIN F-LINK: Start this part is refused when the parts folder is a link into the other Folio by the time it creates; the other Folio is byte-identical', async () => {
  await insertPart(ws, DIR, 2, { title: 'Methods' })
  let other: Record<string, string> = {}
  const refused = await materialisePart(fws, DIR, 2, {
    beforeManifestWrite: async () => { await linkContentsIntoOther(); other = await tree(join(root, 'other')) },
  }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(NotInsideFolioError)
  expect((refused as Error).message).toBe(FOLIO_REFUSAL)
  expect(Object.keys(other).length).toBeGreaterThan(0)
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('T-CONTAIN F-LINK: Start\'s clean-up is refused when the parts folder became a link into the other Folio; the new file is left there, named, and nothing else changes', async () => {
  await insertPart(ws, DIR, 2, { title: 'Methods' })
  let other: Record<string, string> = {}
  const original = ws.saveFileWithoutReadBack.bind(ws)
  ws.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
    if (path === MANIFEST) {
      await linkContentsIntoOther()
      other = await tree(join(root, 'other'))
      throw new Error('EACCES: permission denied')
    }
    return original(path, content, options)
  }) as typeof ws.saveFileWithoutReadBack
  const refused = await materialisePart(fws, DIR, 2).catch((error: unknown) => error)
  expect((refused as Error).message).toContain('was left in place')
  const created = Object.keys(other).filter((key) => key.startsWith('contents/') && key.includes('methods'))
  expect(created.length).toBe(1) // created inside the Folio, then moved away with its folder
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('S-3 literal F-LINK: with `paper/contents` a link into the other Folio before the call, the view writes the Plan\'s own documents (Index Note, manifest) in the Folio folder; a Plan write is refused by the Plan\'s own guard, in the same words through the view and the bare Workspace, and neither Folio changes', async () => {
  await linkContentsIntoOther()
  const other = await tree(join(root, 'other'))
  // The Plan's documents stand in the Folio folder itself, which is no link: the view writes them.
  const index = `${await read(INDEX)}\nA line.\n`
  const manifest = await read(MANIFEST)
  await fws.saveFileWithoutReadBack(INDEX, index)
  await fws.saveFileOver(MANIFEST, manifest, { kind: 'disk', text: manifest })
  expect(await read(INDEX)).toBe(index)
  const paper = await tree(join(root, 'paper'))
  // A Plan write: the Plan's own guard refuses it (the parts behind the link are not this Folio's documents).
  const PLAN_REFUSAL = 'Refusing to update the Folio manifest because the write would remove entries for files that still exist'
  const viaView = await insertPart(fws, DIR, 0, { title: 'Methods' }).then(() => 'written', (error: unknown) => (error as Error).message)
  expect(viaView).toContain(PLAN_REFUSAL)
  expect(await tree(join(root, 'paper'))).toEqual(paper)
  expect(await tree(join(root, 'other'))).toEqual(other)
  const viaWorkspace = await insertPart(ws, DIR, 0, { title: 'Methods' }).then(() => 'written', (error: unknown) => (error as Error).message)
  expect(viaView).toBe(viaWorkspace)
  expect(await tree(join(root, 'paper'))).toEqual(paper)
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('S-3: with the Folio folder already a link into the other Folio before the call, a Plan write is refused and the other Folio is byte-identical', async () => {
  await linkFolioIntoOther()
  const other = await tree(join(root, 'other'))
  // The Plan write is refused before it writes (its guarded read does not follow the link) ...
  const refused = await reorderParts(fws, DIR, [1, 0]).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(Error)
  // ... and every writer of the view refuses each of the Folio's files in the room's words.
  const index = other['paper/_paper_INDEX.md']
  await expect(fws.saveFile(INDEX, 'HIJACKED\n')).rejects.toThrow(FOLIO_REFUSAL)
  await expect(fws.saveFileWithoutReadBack(MANIFEST, 'HIJACKED\n')).rejects.toThrow(FOLIO_REFUSAL)
  await expect(fws.saveFileOver(INDEX, 'HIJACKED\n', { kind: 'disk', text: index })).rejects.toThrow(FOLIO_REFUSAL)
  await expect(fws.createFile(`${DIR}/contents/03-new.md`, 'NEW\n')).rejects.toThrow(FOLIO_REFUSAL)
  expect(() => fws.removeFileOverRead(INDEX, index)).toThrow(FOLIO_REFUSAL)
  expect(await tree(join(root, 'other'))).toEqual(other)
})

test('S-4 Probe E: a Folio at the Collection root writes into its own folders (one with a cover-only Index Note included), and refuses every folder below it that is itself a Folio (a manifest, or an Index Note declaring a running order); nothing there changes', async () => {
  const atRoot = new FolioWorkspace(ws, '')
  expect(atRoot.folioDir).toBe('')
  await mkdir(join(root, 'loose'))
  // A cover: an Index Note with no running order. The folder is no Folio.
  await writeFile(join(root, 'loose/_loose_INDEX.md'), '# Loose\n\nA cover.\n')
  await atRoot.saveFile('loose/note.md', 'LOOSE\n')
  await atRoot.createFile('top', 'TOP\n')
  expect(await read('loose/note.md')).toBe('LOOSE\n')
  expect(await read('top.md')).toBe('TOP\n')
  // A Folio known only by its manifest.
  await mkdir(join(root, 'third/contents'), { recursive: true })
  await writeFile(join(root, 'third/_report-structure.json'), '{"files":[]}\n')
  const folios = { other: await tree(join(root, 'other')), paper: await tree(join(root, 'paper')), third: await tree(join(root, 'third')) }
  for (const path of ['other/contents/notes.md', 'other/_other_INDEX.md', 'paper/contents/01-summary.md', `${INDEX}`, 'third/contents/x.md', 'third/x.md']) {
    for (const write of [
      () => atRoot.saveFile(path, 'HIJACKED\n'),
      () => atRoot.saveFileWithoutReadBack(path, 'HIJACKED\n'),
      () => atRoot.createFile(path.replace(/\.md$/, '-new.md'), 'NEW\n'),
    ]) await expect(write()).rejects.toThrow(FOLIO_REFUSAL)
  }
  expect(() => atRoot.removeFileOverRead('other/contents/notes.md', NOTES)).toThrow(FOLIO_REFUSAL)
  expect({ other: await tree(join(root, 'other')), paper: await tree(join(root, 'paper')), third: await tree(join(root, 'third')) }).toEqual(folios)
  // A nested Folio inside a Folio below the root is refused the same way.
  await mkdir(join(root, DIR, 'annex'))
  await writeFile(join(root, DIR, 'annex/_annex_INDEX.md'), '# Annex\n\n## Running order\n\n- [[A]]\n')
  await expect(fws.saveFile(`${DIR}/annex/a.md`, 'A\n')).rejects.toThrow(FOLIO_REFUSAL)
  expect(await lstat(join(root, DIR, 'annex/a.md')).catch(() => null)).toBeNull()
})

test('S-4: a folder inside the Folio whose Index Note is only a cover is no Folio: `paper/research/` takes a write, and `paper/contents/` with a cover still takes part writes', async () => {
  await mkdir(join(root, DIR, 'research'), { recursive: true })
  await writeFile(join(root, DIR, 'research/_research_INDEX.md'), '# Research\n\nA cover, with a status pattern.\n')
  await fws.saveFile(`${DIR}/research/x.md`, 'X\n')
  expect(await read(`${DIR}/research/x.md`)).toBe('X\n')
  await writeFile(join(root, DIR, 'contents/_contents_INDEX.md'), '# Contents\n')
  await fws.saveFile(SUMMARY, '# Summary\n\nRewritten.\n')
  expect(await read(SUMMARY)).toBe('# Summary\n\nRewritten.\n')
  await setCollectionPieceStatus(fws, DIR, SUMMARY, 'draft')
  expect(await read(SUMMARY)).toContain('status: draft')
  await fws.createFile(`${DIR}/contents/03-new.md`, 'NEW\n')
  expect(await read(`${DIR}/contents/03-new.md`)).toBe('NEW\n')
})

test('S-4: a running order inside a code block is no running order; an Index Note that cannot be read counts as a Folio (refused)', async () => {
  await mkdir(join(root, DIR, 'notes'))
  await writeFile(join(root, DIR, 'notes/_notes_INDEX.md'), '# Notes\n\n```\n## Running order\n```\n')
  await fws.saveFile(`${DIR}/notes/x.md`, 'X\n')
  expect(await read(`${DIR}/notes/x.md`)).toBe('X\n')
  if (process.getuid?.() === 0) return // root reads a file whatever its mode
  await chmod(join(root, DIR, 'notes/_notes_INDEX.md'), 0o000)
  try {
    await expect(fws.saveFile(`${DIR}/notes/y.md`, 'Y\n')).rejects.toThrow(FOLIO_REFUSAL)
    expect(await lstat(join(root, DIR, 'notes/y.md')).catch(() => null)).toBeNull()
  } finally {
    await chmod(join(root, DIR, 'notes/_notes_INDEX.md'), 0o644)
  }
})

test('t-1: Object.preventExtensions and Object.freeze on the view are refused, leave the shared Workspace extensible, and the view keeps working', () => {
  expect(() => Object.preventExtensions(fws)).toThrow(ROOM_REFUSAL)
  expect(() => Object.freeze(fws)).toThrow(ROOM_REFUSAL)
  expect(() => Object.seal(fws)).toThrow(ROOM_REFUSAL)
  expect(() => Object.preventExtensions(Object.getPrototypeOf(fws))).toThrow(ROOM_REFUSAL)
  expect(Object.isExtensible(ws)).toBe(true)
  expect(Object.isExtensible(fws)).toBe(true)
  expect(fws instanceof Workspace).toBe(true)
  expect(Object.getPrototypeOf(Object.getPrototypeOf(fws))).toBe(Workspace.prototype)
})

test('t-3: `in` answers as the view reads, and the plain-object members read, so the view can be put in a string', () => {
  expect('folioDir' in fws).toBe(true)
  expect('saveFile' in fws).toBe(true)
  expect('readFile' in fws).toBe(true)
  expect('root' in fws).toBe(true)
  expect('createFolder' in fws).toBe(true) // there, and refuses when called
  expect('then' in fws).toBe(false)
  expect('nothingLikeThis' in fws).toBe(false)
  expect(Symbol.iterator in fws).toBe(false)
  expect('saveFile' in Object.getPrototypeOf(fws)).toBe(true)
  expect(`${fws}`).toBe('[object Object]')
  expect(String(fws)).toBe('[object Object]')
  expect(Object.prototype.toString.call(fws)).toBe('[object Object]')
  expect(fws.hasOwnProperty('root')).toBe(true)
  expect(fws.valueOf()).toBe(fws)
  // `__proto__` is not let through: it would read the Workspace's real prototype past the shadow.
  expect(() => (fws as unknown as { __proto__: () => void }).__proto__()).toThrow(ROOM_REFUSAL)
})

// ---- The room's boundary, by source scan (M-1) -------------------------------------------------------------------

/** Room modules: every source file that imports folio-workspace, the modules of the writers the room reuses
 *  (ticket 02: the Plan writers and Start this part, the status route, the Undo of Add; `wikilinks.ts` holds Start's
 *  create step, `createCollectionStub`), and the room's own modules, which may hold the bare Workspace main hands them
 *  (ticket 11, review follow-up of 02: `folio-room.ts`, `folio-room-ipc.ts`, `folio-room-writes.ts`), and the order
 *  routes the room reuses (`plan-running-order.ts`, main's `folio-running-order.ts` with `reorderFolioPieces` and the
 *  manifest-only branch, `folio-order-assessment.ts`). The shared and renderer `folio-running-order.ts` hold no
 *  Workspace and are not room modules. */
const NAMED_ROOM_MODULES = [
  'src/main/plan.ts', 'src/main/collection.ts', 'src/main/folio-add-undo.ts', 'src/main/wikilinks.ts',
  'src/main/folio-room.ts', 'src/main/folio-room-ipc.ts', 'src/main/folio-room-writes.ts',
  // The order routes the room's writes reuse and the read it makes after a created manifest (ticket 11 review T-6).
  'src/main/plan-running-order.ts', 'src/main/folio-running-order.ts', 'src/main/folio-order-assessment.ts',
]
async function roomModules(): Promise<string[]> {
  const repo = join(import.meta.dir, '../..')
  const found = new Set(NAMED_ROOM_MODULES)
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(repo, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) await walk(rel)
      else if (/\.tsx?$/.test(entry.name) && rel !== 'src/main/folio-workspace.ts' && /['"][^'"]*\/folio-workspace(\.ts)?['"]/.test(await readFile(join(repo, rel), 'utf8'))) found.add(rel)
    }
  }
  await walk('src')
  return [...found].sort()
}

/** The workspace module as any room module may name it: './workspace', '../workspace', '../main/workspace' (with or
 *  without `.ts`), in single or double quotes. */
const WORKSPACE_MODULE = String.raw`['"](?:\.{1,2}\/)+(?:[^'"]*\/)?workspace(?:\.ts)?['"]`

/** What the scan refuses in a room module: `Workspace` imported as a value from the workspace module (a default,
 *  namespace or named value import), the module loaded by `require(…)` or `import(…)`, a `new Workspace`, or a walk
 *  over an object's prototype or constructor. */
function boundaryOffences(source: string): string[] {
  const offences: string[] = []
  for (const match of source.matchAll(new RegExp(String.raw`import\s+(type\s+)?\{([^}]*)\}\s+from\s+${WORKSPACE_MODULE}`, 'g'))) {
    if (match[1]) continue
    if (match[2].split(',').map((name) => name.trim()).some((name) => /^Workspace\b/.test(name))) offences.push('Workspace imported as a value')
  }
  if (new RegExp(String.raw`import\s+(Workspace\b|\*\s+as\s+\w+)[^;]*from\s+${WORKSPACE_MODULE}`).test(source)) offences.push('default or namespace import of workspace')
  if (new RegExp(String.raw`\b(?:require|import)\s*\(\s*${WORKSPACE_MODULE}`).test(source)) offences.push('workspace loaded by require or import()')
  if (/\bnew\s+Workspace\b/.test(source)) offences.push('constructs a Workspace')
  if (/getPrototypeOf|__proto__|\.constructor\b/.test(source)) offences.push('reflects over a prototype or constructor')
  return offences
}

test('M-1 boundary scan: every room module imports Workspace as a type only, never constructs one, and reaches no getPrototypeOf, __proto__ or .constructor', async () => {
  const repo = join(import.meta.dir, '../..')
  const modules = await roomModules()
  expect(modules).toEqual(expect.arrayContaining(NAMED_ROOM_MODULES))
  for (const rel of modules) expect(boundaryOffences(await readFile(join(repo, rel), 'utf8')), rel).toEqual([])
})

test('M-1 boundary scan: catches a value import of Workspace, a construction and a prototype walk (the scan\'s own check)', () => {
  expect(boundaryOffences("import { NameTaken, type Workspace } from './workspace'")).toEqual([])
  expect(boundaryOffences("import type { FileReadResult, Workspace } from './workspace'")).toEqual([])
  expect(boundaryOffences("import { NameTaken, Workspace } from './workspace'")).toEqual(['Workspace imported as a value'])
  expect(boundaryOffences("import { Workspace } from '../workspace'")).toEqual(['Workspace imported as a value'])
  expect(boundaryOffences('import { Workspace } from "../main/workspace.ts"')).toEqual(['Workspace imported as a value'])
  expect(boundaryOffences("import type { Workspace } from '../workspace'")).toEqual([])
  expect(boundaryOffences("import { FolioWorkspace } from './folio-workspace'")).toEqual([])
  expect(boundaryOffences("import * as W from '../workspace'")).toEqual(['default or namespace import of workspace'])
  expect(boundaryOffences("const { Workspace } = require('./workspace')")).toEqual(['workspace loaded by require or import()'])
  expect(boundaryOffences('const loaded = await import("../workspace")')).toEqual(['workspace loaded by require or import()'])
  expect(boundaryOffences("import * as W from './workspace'")).toEqual(['default or namespace import of workspace'])
  expect(boundaryOffences('const w = new Workspace(root)')).toEqual(['constructs a Workspace'])
  expect(boundaryOffences('Object.getPrototypeOf(ws)')).toEqual(['reflects over a prototype or constructor'])
  expect(boundaryOffences('const C = ws.constructor')).toEqual(['reflects over a prototype or constructor'])
  expect(boundaryOffences('ws.__proto__')).toEqual(['reflects over a prototype or constructor'])
})

// ---- The reused writers given the view on an ordinary Folio (F-PANGRAM) behave exactly as given the Workspace -----

/** Answers compared without the clock: a file's modified time differs between the two runs. */
const timeless = (key: string, value: unknown): unknown => (key === 'modifiedAt' || key === 'mtime' || key === 'mtimeMs' ? undefined : value)

/** Run `steps` on two identical F-PANGRAM workspaces, one with the Workspace and one with the view; after each step
 *  the two trees and the answers (root spelled out) are equal. */
async function sameWithView(steps: Array<(w: Workspace) => Promise<unknown>>): Promise<void> {
  const twin = await fresh()
  try {
    await pangramFolio(twin, DIR)
    const plain = new Workspace(twin)
    for (const step of steps) {
      const a = JSON.stringify(await step(plain).catch((error: unknown) => ({ error: (error as Error).message })), timeless).replaceAll(twin, '<root>')
      const b = JSON.stringify(await step(fws).catch((error: unknown) => ({ error: (error as Error).message })), timeless).replaceAll(root, '<root>')
      expect(b).toBe(a)
      expect(await tree(join(root, DIR))).toEqual(await tree(join(twin, DIR)))
    }
  } finally {
    await rm(twin, { recursive: true, force: true })
  }
}

test('F-PANGRAM: insert, Start this part, reorder, status, remove and the backups write the same bytes through the view as through the Workspace', async () => {
  await sameWithView([
    (w) => insertPart(w, DIR, 2, { title: 'Methods', gloss: 'How it was done.' }),
    (w) => materialisePart(w, DIR, 2),
    (w) => reorderParts(w, DIR, [2, 0, 1]),
    (w) => setCollectionPieceStatus(w, DIR, SUMMARY, 'draft'),
    (w) => removePart(w, DIR, 0),
    (w) => readPlan(w, DIR),
  ])
  expect(await read(`${INDEX}.writeflex-backup`)).toContain('## Running order')
  expect(await read(`${MANIFEST}.writeflex-backup`)).toContain('"files"')
})

test('F-PANGRAM: a failed manifest write puts the Index Note back through the view exactly as through the Workspace (I-6)', async () => {
  const failing = (w: Workspace): (() => void) => {
    const original = w.saveFileWithoutReadBack.bind(w)
    w.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
      if (path === MANIFEST) throw new Error('EACCES: permission denied')
      return original(path, content, options)
    }) as typeof w.saveFileWithoutReadBack
    return () => { delete (w as unknown as Record<string, unknown>).saveFileWithoutReadBack }
  }
  const before = await tree(join(root, DIR))
  await sameWithView([
    async (w) => {
      const real = w === fws ? ws : w
      const restore = failing(real)
      try { return await movePart(w, DIR, 0, 1) } finally { restore() }
    },
  ])
  const after = await tree(join(root, DIR))
  // Only the pristine-copy backups were added; the Index Note and the manifest hold the bytes they held.
  expect(Object.keys(after).filter((key) => !(key in before)).sort()).toEqual(['_paper_INDEX.md.writeflex-backup', '_paper_INDEX.md.writeflex-backup.json', '_report-structure.json.writeflex-backup', '_report-structure.json.writeflex-backup.json'])
  for (const key of Object.keys(before)) expect(after[key]).toBe(before[key])
})

test('F-PANGRAM: Start\'s clean-up after a failed manifest write removes the new part through the view exactly as through the Workspace', async () => {
  const failing = (w: Workspace): (() => void) => {
    const original = w.saveFileWithoutReadBack.bind(w)
    w.saveFileWithoutReadBack = (async (path: string, content: string, options?: Parameters<typeof original>[2]) => {
      if (path === MANIFEST) throw new Error('EACCES: permission denied')
      return original(path, content, options)
    }) as typeof w.saveFileWithoutReadBack
    return () => { delete (w as unknown as Record<string, unknown>).saveFileWithoutReadBack }
  }
  await sameWithView([
    (w) => insertPart(w, DIR, 2, { title: 'Methods' }),
    async (w) => {
      const restore = failing(w === fws ? ws : w)
      try { return await materialisePart(w, DIR, 2) } finally { restore() }
    },
  ])
  expect((await readdir(join(root, DIR, 'contents'))).some((name) => name.includes('methods'))).toBe(false)
})

test('F-PANGRAM: an Add and its Undo through the view write the same bytes as through the Workspace', async () => {
  const addAndUndo = async (w: Workspace): Promise<unknown> => {
    await writeFile(join(w.root, DIR, 'contents/03-extra.md'), '---\ntitle: Extra\n---\n\n# Extra\n\nAn extra part.\n')
    invalidateFolioOrderFacts(w.root)
    const plan = (await readPlan(w, DIR))!
    const unlisted = plan.unlisted.findIndex((part) => part.path === `${DIR}/contents/03-extra.md`)
    expect(unlisted).toBeGreaterThanOrEqual(0)
    const added = await withPlanLock(w, DIR, () => recordingAdd(w, DIR, async () => ({ result: { ok: true }, plan: await adoptParts(w, DIR, [unlisted]) })))
    const token = (added.result as { undoToken?: string }).undoToken
    expect(typeof token).toBe('string')
    const midway = await read(INDEX, w.root)
    expect(midway).toContain('[[Extra]]')
    const undone = await withPlanLock(w, DIR, () => undoRecordedAdd(w, DIR, token as string))
    return { undone, plan: added.plan }
  }
  await sameWithView([addAndUndo])
  expect(await read(INDEX)).not.toContain('[[Extra]]')
})

// ---- The document-only view passes a pin on (follow-up from ticket 01) -------------------------------------------

test('document-only view: createFile and removeFileOverRead pass inFolder on; without it they behave as before', async () => {
  const view = documentOnlyView(ws).workspace
  const real = realpathSync.native(join(root, DIR, 'contents'))
  const stat = await lstat(real)
  const pin: FolderIdentity = { real, dev: stat.dev, ino: stat.ino }
  // Without options: as before (a missing folder is made, a file is removed).
  await view.createFile(`${DIR}/drafts/one.md`, 'ONE\n')
  expect(await read(`${DIR}/drafts/one.md`)).toBe('ONE\n')
  view.removeFileOverRead(`${DIR}/drafts/one.md`, 'ONE\n')
  expect(await lstat(join(root, DIR, 'drafts/one.md')).catch(() => null)).toBeNull()
  // With a pin: a create elsewhere is refused, and so is a removal once the folder is a link.
  await expect(view.createFile(`${DIR}/drafts/two.md`, 'TWO\n', { inFolder: pin })).rejects.toBeInstanceOf(NotADocumentPathError)
  await linkContentsIntoOther()
  const other = await tree(join(root, 'other'))
  expect(() => view.removeFileOverRead(SUMMARY, other['contents/01-summary.md'], { inFolder: pin })).toThrow(NotADocumentPathError)
  expect(await tree(join(root, 'other'))).toEqual(other)
})
