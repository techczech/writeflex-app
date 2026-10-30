/**
 * Folio room ticket 01 (spec-folio-room-data-model § 9 D-WRITE-1, invariant I-2): the guarded write's folder pin is
 * physical. At the commit, the pinned folder's real path must still be the pinned real path and the name itself a
 * folder, not a link, so a pinned folder moved away and replaced by a link to it (same device and inode at the far
 * end) is refused. `createFile` and `removeFileOverRead` carry the pin; without it they behave as before.
 *
 * Seams: `Workspace.saveFile` / `saveFileOver` / `createFile` / `removeFileOverRead` with `documentOnly` and
 * `inFolder`; `documentSaveSeams.afterStage` (between the stage and the commit) stands where another program acts;
 * `link` of `node:fs/promises` is spied on for the disk without hard links.
 *
 * Fixtures: two Folios, `paper/` and `other/`, in one Collection. F-LINK here is `paper/contents` a link to
 * `other/contents`, where `other/contents` is the folder the writer pinned as `paper/contents` (moved there), so the
 * link leads to exactly the pinned device and inode: only the physical check tells them apart.
 */
import { test, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile, lstat } from 'node:fs/promises'
import { lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { guardedReadSeams } from '../../src/main/guarded-document-read'
import { documentSaveSeams, isPinnedFolder, standsAsPinnedFolder, type FolderIdentity } from '../../src/main/guarded-document-write'
import { ChangedSinceRead, EmptyWriteRefusal, NotADocumentPathError, Workspace } from '../../src/main/workspace'

const PART = '# Introduction\n\nThe paper starts here.\n'
const OTHER_INDEX = '# Other\n\n## Running order\n\n1. [[Notes]]\n'
let root: string
let ws: Workspace

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-folder-pin-')))
  ws = new Workspace(root)
  await mkdir(join(root, 'paper/contents'), { recursive: true })
  await writeFile(join(root, 'paper/_paper_INDEX.md'), '# Paper\n')
  await writeFile(join(root, 'paper/contents/01-intro.md'), PART)
  await mkdir(join(root, 'other'))
  await writeFile(join(root, 'other/_other_INDEX.md'), OTHER_INDEX)
  await writeFile(join(root, 'other/notes.md'), 'Notes of the other Folio.\n')
})
afterEach(async () => {
  delete documentSaveSeams.afterStage
  delete documentSaveSeams.betweenCheckAndWrite
  await rm(root, { recursive: true, force: true })
})

/** The pin a caller takes when it authorises a folder: real path, then lstat (as `pinTheFolio` does). */
const pin = (rel: string): FolderIdentity => {
  const real = realpathSync.native(join(root, rel))
  const stat = lstatSync(real)
  return { real, dev: stat.dev, ino: stat.ino }
}

/** Every entry under `dir`, never following a link: path → file text, `link → target` or `folder`. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (at: string): Promise<void> => {
    for (const name of (await readdir(at)).sort()) {
      const path = join(at, name)
      const key = relative(dir, path)
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) out[key] = `link → ${await fsp.readlink(path)}`
      else if (stat.isDirectory()) { out[key] = 'folder'; await walk(path) }
      else out[key] = await readFile(path, 'utf8')
    }
  }
  await walk(dir)
  return out
}

/** Makes F-LINK out of the pinned `paper/contents`: the folder becomes the other Folio's `contents/`, and a link to
 *  it stands at its old name. The link's far end has the pinned device and inode. */
const moveIntoOtherAndRelink = async (): Promise<void> => {
  await rename(join(root, 'paper/contents'), join(root, 'other/contents'))
  await symlink(join(root, 'other/contents'), join(root, 'paper/contents'))
}

const OTHER_AFTER_MOVE = {
  '_other_INDEX.md': OTHER_INDEX,
  contents: 'folder',
  'contents/01-intro.md': PART,
  'notes.md': 'Notes of the other Folio.\n',
}

// ---- The commit check itself ---------------------------------------------------------------------------------------

test('isPinnedFolder: the pinned folder passes; a link at its name, or a link on the way, fails although it leads to the same inode', async () => {
  const pinned = pin('paper/contents')
  expect(isPinnedFolder(pinned.real, pinned)).toBe(true)
  await moveIntoOtherAndRelink()
  // The old check (statSync, which follows the link) saw the same device and inode here and passed.
  expect(isPinnedFolder(pinned.real, pinned)).toBe(false)
  // A link on the way: `paper` itself replaced by a link to a folder holding the pinned folder.
  await rm(join(root, 'paper/contents'))
  await rename(join(root, 'other/contents'), join(root, 'paper/contents'))
  const p2 = pin('paper/contents')
  await rename(join(root, 'paper'), join(root, 'paper-moved'))
  await symlink(join(root, 'paper-moved'), join(root, 'paper'))
  expect(standsAsPinnedFolder(join(root, 'paper/contents'), p2)).toBe(false)
  expect(standsAsPinnedFolder(join(root, 'paper-moved/contents'), p2)).toBe(false) // its real path is not the pinned one
  expect(isPinnedFolder(p2.real, p2)).toBe(false)
})

// ---- F-LINK: pinned save, create and remove are refused, the other Folio byte-identical ----------------------------

test('F-LINK: a pinned save, save-over, create and remove into a Folio whose contents/ is a link to the other Folio\'s contents/ are refused; the other Folio is byte-identical', async () => {
  const pinned = pin('paper/contents')
  await moveIntoOtherAndRelink()
  const before = await tree(join(root, 'other'))
  expect(before).toEqual(OTHER_AFTER_MOVE)

  await expect(ws.saveFile('paper/contents/01-intro.md', 'HIJACKED\n', { documentOnly: true, inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
  await expect(ws.saveFileOver('paper/contents/01-intro.md', 'HIJACKED\n', { kind: 'disk', text: PART }, { documentOnly: true, inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
  await expect(ws.createFile('paper/contents/02-new.md', 'NEW\n', { inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', PART, { inFolder: pinned })).toThrow(NotADocumentPathError)
  // In plain words.
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', PART, { inFolder: pinned })).toThrow('paper/contents/01-intro.md is outside this Collection.')

  expect(await tree(join(root, 'other'))).toEqual(before)
})

// ---- The move-and-relink race, between the stage and the commit ----------------------------------------------------

for (const [name, write] of [
  ['saveFile', (p: FolderIdentity) => ws.saveFile('paper/contents/01-intro.md', 'HIJACKED\n', { documentOnly: true, inFolder: p })],
  ['saveFileOver', (p: FolderIdentity) => ws.saveFileOver('paper/contents/01-intro.md', 'HIJACKED\n', { kind: 'disk', text: PART }, { documentOnly: true, inFolder: p })],
  ['createFile', (p: FolderIdentity) => ws.createFile('paper/contents/02-new.md', 'NEW\n', { inFolder: p })],
] as const) {
  test(`move-and-relink race (${name}): the pinned folder moved away and a link to it put at its old name after the stage → refused, nothing lands, no temporary file is left`, async () => {
    const pinned = pin('paper/contents')
    let raced = false
    documentSaveSeams.afterStage = async () => {
      delete documentSaveSeams.afterStage
      raced = true
      await moveIntoOtherAndRelink()
    }
    await expect(write(pinned)).rejects.toBeInstanceOf(NotADocumentPathError)
    expect(raced).toBe(true)
    expect(await tree(join(root, 'other'))).toEqual(OTHER_AFTER_MOVE)
  })
}

test('move-and-relink race on a disk without hard links: the check in the rename tick refuses after the link fails', async () => {
  const pinned = pin('paper/contents')
  const realLink = fsp.link
  // The link that fails is where the folder is swapped: the first commit check has passed, the second must refuse.
  const spy = spyOn(fsp, 'link').mockImplementation(async () => {
    await moveIntoOtherAndRelink()
    throw Object.assign(new Error('not supported'), { code: 'ENOTSUP' })
  })
  try {
    await expect(ws.createFile('paper/contents/02-new.md', 'NEW\n', { inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
    expect(spy).toHaveBeenCalledTimes(1)
  } finally {
    spy.mockRestore()
  }
  expect(fsp.link).toBe(realLink)
  expect(await tree(join(root, 'other'))).toEqual(OTHER_AFTER_MOVE)
})

test('the same race without a pin is today\'s behaviour: the save lands through the link (the pin is what refuses it)', async () => {
  documentSaveSeams.afterStage = async () => {
    delete documentSaveSeams.afterStage
    await moveIntoOtherAndRelink()
  }
  await ws.saveFile('paper/contents/01-intro.md', 'WRITTEN\n', { documentOnly: true })
  expect(await readFile(join(root, 'other/contents/01-intro.md'), 'utf8')).toBe('WRITTEN\n')
})

// ---- createFile with inFolder ---------------------------------------------------------------------------------------

test('createFile with inFolder: writes into the pinned folder by the guarded write and reads it back', async () => {
  const created = await ws.createFile('paper/contents/02-new.md', 'NEW\n', { inFolder: pin('paper/contents') })
  expect(created.content).toBe('NEW\n')
  expect(await readFile(join(root, 'paper/contents/02-new.md'), 'utf8')).toBe('NEW\n')
  expect((await readdir(join(root, 'paper/contents'))).filter((n) => n.endsWith('.tmp'))).toEqual([])
})

test('createFile with inFolder into a missing folder is refused in plain words and makes no folder; without inFolder the folder is made, as today', async () => {
  const pinned = pin('paper/contents')
  await expect(ws.createFile('paper/drafts/01-new.md', 'NEW\n', { inFolder: pinned })).rejects.toThrow('The folder for paper/drafts/01-new.md does not exist.')
  expect(await lstat(join(root, 'paper/drafts')).catch(() => null)).toBeNull()
  // A missing nested folder under the pinned one too.
  await expect(ws.createFile('paper/contents/deep/01-new.md', 'NEW\n', { inFolder: pinned })).rejects.toThrow('does not exist')
  expect(await lstat(join(root, 'paper/contents/deep')).catch(() => null)).toBeNull()
  expect(await tree(join(root, 'paper'))).toEqual({ '_paper_INDEX.md': '# Paper\n', contents: 'folder', 'contents/01-intro.md': PART })

  await ws.createFile('paper/drafts/01-new.md', 'NEW\n')
  expect(await readFile(join(root, 'paper/drafts/01-new.md'), 'utf8')).toBe('NEW\n')
})

test('createFile with inFolder into an existing folder that is not the pinned one is refused', async () => {
  await expect(ws.createFile('other/02-new.md', 'NEW\n', { inFolder: pin('paper/contents') })).rejects.toBeInstanceOf(NotADocumentPathError)
  expect(await lstat(join(root, 'other/02-new.md')).catch(() => null)).toBeNull()
})

test('createFile with inFolder still refuses a taken name', async () => {
  await expect(ws.createFile('paper/contents/01-intro.md', 'NEW\n', { inFolder: pin('paper/contents') })).rejects.toThrow('File already exists: paper/contents/01-intro.md')
  expect(await readFile(join(root, 'paper/contents/01-intro.md'), 'utf8')).toBe(PART)
})

// ---- removeFileOverRead with inFolder ------------------------------------------------------------------------------

test('removeFileOverRead with inFolder: removes the file while its folder is the pinned one and it holds what was read', async () => {
  ws.removeFileOverRead('paper/contents/01-intro.md', PART, { inFolder: pin('paper/contents') })
  expect(await lstat(join(root, 'paper/contents/01-intro.md')).catch(() => null)).toBeNull()
})

test('removeFileOverRead with inFolder keeps its byte check: other bytes → ChangedSinceRead, nothing removed; a file already gone is what was asked for', async () => {
  const pinned = pin('paper/contents')
  await writeFile(join(root, 'paper/contents/01-intro.md'), 'CHANGED\n')
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', PART, { inFolder: pinned })).toThrow(ChangedSinceRead)
  expect(await readFile(join(root, 'paper/contents/01-intro.md'), 'utf8')).toBe('CHANGED\n')
  await rm(join(root, 'paper/contents/01-intro.md'))
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', PART, { inFolder: pinned })).not.toThrow()
})

test('removeFileOverRead with inFolder refuses when the folder was swapped after the read: for a link to the moved folder, and for another folder of the same name', async () => {
  const pinned = pin('paper/contents')
  const read = await readFile(join(root, 'paper/contents/01-intro.md'), 'utf8')
  // Another folder now stands at the name, holding a file with the same name and bytes.
  await rename(join(root, 'paper/contents'), join(root, 'paper/contents-aside'))
  await mkdir(join(root, 'paper/contents'))
  await writeFile(join(root, 'paper/contents/01-intro.md'), PART)
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', read, { inFolder: pinned })).toThrow(NotADocumentPathError)
  expect(await readFile(join(root, 'paper/contents/01-intro.md'), 'utf8')).toBe(PART)
  // The pinned folder itself back behind a link at the name: refused too, the file at the far end kept.
  await rm(join(root, 'paper/contents'), { recursive: true })
  await symlink(join(root, 'paper/contents-aside'), join(root, 'paper/contents'))
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', read, { inFolder: pinned })).toThrow(NotADocumentPathError)
  expect(await readFile(join(root, 'paper/contents-aside/01-intro.md'), 'utf8')).toBe(PART)
  // The folder gone altogether: refused, not mistaken for a file already gone.
  await rm(join(root, 'paper/contents'))
  await rename(join(root, 'paper/contents-aside'), join(root, 'other/contents'))
  expect(() => ws.removeFileOverRead('paper/contents/01-intro.md', read, { inFolder: pinned })).toThrow(NotADocumentPathError)
  expect(await readFile(join(root, 'other/contents/01-intro.md'), 'utf8')).toBe(PART)
})

test('removeFileOverRead without inFolder behaves as today: it removes through a link standing at the folder\'s name', async () => {
  await moveIntoOtherAndRelink()
  ws.removeFileOverRead('paper/contents/01-intro.md', PART)
  expect(await lstat(join(root, 'other/contents/01-intro.md')).catch(() => null)).toBeNull()
})

// ---- An empty pinned save over prose: the pin is checked before the rescue copies are written (fix round 1) --------

for (const [name, save] of [
  ['saveFile', (p: FolderIdentity) => ws.saveFile('paper/contents/01-intro.md', '', { documentOnly: true, inFolder: p })],
  ['saveFileOver', (p: FolderIdentity) => ws.saveFileOver('paper/contents/01-intro.md', '', { kind: 'disk', text: PART }, { documentOnly: true, inFolder: p })],
] as const) {
  test(`F-LINK, empty ${name} over the other Folio's prose: refused as swapped, and the whole Collection (.writeflex/ too) is byte-identical`, async () => {
    const pinned = pin('paper/contents')
    await moveIntoOtherAndRelink()
    const before = await tree(root)
    await expect(save(pinned)).rejects.toBeInstanceOf(NotADocumentPathError)
    await expect(save(pinned)).rejects.toThrow('paper/contents/01-intro.md is outside this Collection.')
    expect(await tree(root)).toEqual(before)
    expect(await lstat(join(root, '.writeflex')).catch(() => null)).toBeNull()
  })
}

test('empty pinned save over prose while the pin holds: EmptyWriteRefusal with no rescue copies, and the whole Collection (.writeflex/ too) is byte-identical', async () => {
  const before = await tree(root)
  const refusal = await ws.saveFile('paper/contents/01-intro.md', '', { documentOnly: true, inFolder: pin('paper/contents') }).catch((error: unknown) => error)
  expect(refusal).toBeInstanceOf(EmptyWriteRefusal)
  const { rescueDirectory, previousRescuePath, rejectedRescuePath, previousText, message } = refusal as EmptyWriteRefusal
  expect([rescueDirectory, previousRescuePath, rejectedRescuePath]).toEqual([null, null, null])
  expect(previousText).toBe(PART)
  expect(message).not.toContain('Rescue copies')
  expect(await tree(root)).toEqual(before)
  expect(await lstat(join(root, '.writeflex')).catch(() => null)).toBeNull()
})

test('an empty save without inFolder keeps today\'s rescue: two rescue copies, the file kept', async () => {
  const refusal = await ws.saveFile('paper/contents/01-intro.md', '', { documentOnly: true }).catch((error: unknown) => error)
  expect(refusal).toBeInstanceOf(EmptyWriteRefusal)
  const { previousRescuePath, rejectedRescuePath, rescueDirectory } = refusal as EmptyWriteRefusal
  expect(rescueDirectory).toBe('.writeflex/rescue')
  expect(await readFile(join(root, previousRescuePath!), 'utf8')).toBe(PART)
  expect(await readFile(join(root, rejectedRescuePath!), 'utf8')).toBe('')
  expect((await readdir(join(root, '.writeflex/rescue'))).length).toBe(2)
  expect(await readFile(join(root, 'paper/contents/01-intro.md'), 'utf8')).toBe(PART)
})

test('saveFile with inFolder but without documentOnly is the guarded, pinned save: F-LINK is refused and the other Folio is byte-identical; with the pin holding it writes', async () => {
  const pinned = pin('paper/contents')
  await ws.saveFile('paper/contents/01-intro.md', 'KEPT\n', { inFolder: pinned })
  expect(await readFile(join(root, 'paper/contents/01-intro.md'), 'utf8')).toBe('KEPT\n')
  await writeFile(join(root, 'paper/contents/01-intro.md'), PART)
  await moveIntoOtherAndRelink()
  const before = await tree(join(root, 'other'))
  await expect(ws.saveFile('paper/contents/01-intro.md', 'HIJACKED\n', { inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
  await expect(ws.saveFileOver('paper/contents/01-intro.md', 'HIJACKED\n', { kind: 'disk', text: PART }, { inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
  expect(await tree(join(root, 'other'))).toEqual(before)
})

test('empty pinned save, the folder moved and relinked while the old prose is read: refused after the read, before any rescue copy; the whole Collection byte-identical', async () => {
  const pinned = pin('paper/contents')
  let raced = false
  guardedReadSeams.beforeOpen = async () => {
    delete guardedReadSeams.beforeOpen
    raced = true
    await moveIntoOtherAndRelink()
  }
  try {
    const before = { ...(await tree(root)) }
    await expect(ws.saveFile('paper/contents/01-intro.md', '', { documentOnly: true, inFolder: pinned })).rejects.toBeInstanceOf(NotADocumentPathError)
    expect(raced).toBe(true)
    // Only the swap itself changed the tree: the folder now under other/, a link at its old name.
    const { 'paper/contents': _was, 'paper/contents/01-intro.md': _part, ...unmoved } = before
    expect(await tree(root)).toEqual({ ...unmoved, 'paper/contents': `link → ${join(root, 'other/contents')}`, 'other/contents': 'folder', 'other/contents/01-intro.md': PART })
    expect(await lstat(join(root, '.writeflex')).catch(() => null)).toBeNull()
  } finally {
    delete guardedReadSeams.beforeOpen
  }
})
