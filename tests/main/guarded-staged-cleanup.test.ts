/**
 * The guarded write's cleanup of its staged file when the write fails after staging (review finding: the pinned folder
 * moved after the file was staged and a replacement made at its old path). Cleanup removes a file at the staged name
 * only if it is the staged file itself (device and inode taken from its handle when it was created), so a different
 * file found standing at that name is left. Narrowed, not eliminated: Node has no unlinkat, so a file put at the name
 * between that check and the unlink can still be removed; these tests plant it before the check. When the staged file
 * cannot be removed, the refusal names it and the folder it was last known in, after its own reason; after a create
 * that committed, the write succeeds and reports the leftover (review r2). Seams: `afterStage` (the folder moved or the
 * name replanted in between) and `unlink` of `node:fs/promises` (a removal that fails).
 */
import { test, expect, beforeEach, afterEach, describe, spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuardedWriteRefused, documentSaveSeams, leftoverNote, writeDocumentGuarded, type FolderIdentity } from '../../src/main/guarded-document-write'
import { writeWhole } from '../../src/main/cli/guarded-fs'
import { WriteSession } from '../../src/main/cli/write-session'
import { ChangeStore } from '../../src/main/changes'
import { writeFixture } from '../helpers/cli-write-fixture'
import { openAsApp, plantRequest, replyTo } from '../helpers/request-app'
import { Workspace } from '../../src/main/workspace'

let root: string
let ws: Workspace
let folder: string
let moved: string
const PLANTED = 'a different file at the staged name\n'

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'wf-staged-cleanup-')))
  ws = new Workspace(root)
  folder = join(root, 'notes')
  moved = join(root, 'notes-moved')
  mkdirSync(folder)
  writeFileSync(join(folder, 'a.md'), 'old\n')
})
afterEach(async () => {
  delete documentSaveSeams.afterStage
  await rm(root, { recursive: true, force: true })
})

const pin = (): FolderIdentity => {
  const now = statSync(folder)
  return { real: folder, dev: now.dev, ino: now.ino }
}
const stagedName = (dir: string): string => {
  const names = readdirSync(dir).filter((name) => name.endsWith('.tmp'))
  expect(names).toHaveLength(1)
  return names[0]!
}

/** Moves the folder away with the staged file in it and makes a replacement at its old path holding `a.md` and a
 *  different file at the staged name. Returns that name. */
const moveAndReplace = (): string => {
  const name = stagedName(folder)
  renameSync(folder, moved)
  mkdirSync(folder)
  writeFileSync(join(folder, 'a.md'), 'replacement\n')
  writeFileSync(join(folder, name), PLANTED)
  return name
}

/** The leftover is named after the reason: the staged file's name and the folder it was last known in. */
const expectLeftoverNamed = (message: string, reason: string, name: string): void => {
  expect(message.startsWith(reason)).toBe(true)
  expect(message).toContain(name)
  expect(message).toContain(`the folder last known as ${folder}`)
}

test('folder moved after staging, replacement at its old path: the pin refuses, the file found at the staged name is left, the leftover is named', async () => {
  let name = ''
  const refused = await writeDocumentGuarded(ws, 'notes/a.md', 'new\n', 'replace', {
    inFolder: pin(),
    seams: { afterStage: async () => { name = moveAndReplace() } },
  }).catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(GuardedWriteRefused)
  expect((refused as GuardedWriteRefused).code).toBe('swapped')
  // Nothing at the replacement path was removed.
  expect(readFileSync(join(folder, name), 'utf8')).toBe(PLANTED)
  expect(readFileSync(join(folder, 'a.md'), 'utf8')).toBe('replacement\n')
  // The staged file could not be reached through its old name: it stays in the moved folder and is named.
  expect(readdirSync(moved).sort()).toEqual(['a.md', name].sort())
  expectLeftoverNamed((refused as Error).message, new GuardedWriteRefused('swapped', 'notes/a.md').message, name)
  expect(leftoverNote(refused)).toContain(name)
})

test('afterStage throws after moving the folder: the file found at the staged name in the replacement is left, the leftover is named', async () => {
  let name = ''
  const thrown = await writeDocumentGuarded(ws, 'notes/a.md', 'new\n', 'replace', {
    seams: { afterStage: async () => { name = moveAndReplace(); throw new Error('the seam failed.') } },
  }).catch((error: unknown) => error as Error)
  expect(readFileSync(join(folder, name), 'utf8')).toBe(PLANTED)
  expect(readdirSync(moved)).toContain(name)
  expectLeftoverNamed(thrown.message, 'the seam failed.', name)
})

test('a different file planted at the staged name before the cleanup checks it (the staged file moved aside) is left', async () => {
  let name = ''
  const thrown = await writeDocumentGuarded(ws, 'notes/a.md', 'new\n', 'replace', {
    seams: {
      afterStage: async () => {
        name = stagedName(folder)
        renameSync(join(folder, name), join(folder, 'aside.bin'))
        writeFileSync(join(folder, name), PLANTED)
        throw new Error('the seam failed.')
      },
    },
  }).catch((error: unknown) => error as Error)
  expect(readFileSync(join(folder, name), 'utf8')).toBe(PLANTED)
  expect(readFileSync(join(folder, 'a.md'), 'utf8')).toBe('old\n')
  expectLeftoverNamed(thrown.message, 'the seam failed.', name)
})

test('a failure with the staged file still at its name: it is removed and nothing is added to the reason', async () => {
  const thrown = await writeDocumentGuarded(ws, 'notes/a.md', 'new\n', 'replace', {
    seams: { afterStage: async () => { throw new Error('the seam failed.') } },
  }).catch((error: unknown) => error as Error)
  expect(thrown.message).toBe('the seam failed.')
  expect(leftoverNote(thrown)).toBeUndefined()
  expect(readdirSync(folder)).toEqual(['a.md'])
})

test('the app save names the leftover in its own refusal', async () => {
  let name = ''
  documentSaveSeams.afterStage = async () => { name = moveAndReplace() }
  const refused = await ws.saveFileWithoutReadBack('notes/a.md', 'new\n', { documentOnly: true, inFolder: pin() }).catch((error: unknown) => error as Error)
  expect(refused.name).toBe('NotADocumentPathError')
  expect(readFileSync(join(folder, name), 'utf8')).toBe(PLANTED)
  expect(refused.message).toContain(name)
  expect(refused.message).toContain(`the folder last known as ${folder}`)
})

test('the command line names the leftover in its own refusal', async () => {
  let name = ''
  const refused = await writeWhole(ws, 'notes/a.md', 'new\n', 'replace', {
    afterStage: async () => { name = moveAndReplace(); throw new GuardedWriteRefused('changed', 'notes/a.md') },
  }).catch((error: unknown) => error as Error)
  expect(refused.name).not.toBe('GuardedWriteRefused')
  expect(readFileSync(join(folder, name), 'utf8')).toBe(PLANTED)
  expect(refused.message).toContain(name)
  expect(refused.message).toContain(`the folder last known as ${folder}`)
})

/** `unlink` of a temporary name fails with EACCES; every other unlink is the real one. */
const failTemporaryUnlink = (): (() => void) => {
  const real = fsp.unlink
  const spy = spyOn(fsp, 'unlink').mockImplementation(async (path) => {
    if (String(path).endsWith('.tmp')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return real(path)
  })
  return () => spy.mockRestore()
}

test('a create committed by a hard link whose temporary name cannot be removed: success, the leftover reported, both names one file', async () => {
  const restore = failTemporaryUnlink()
  try {
    const result = await writeDocumentGuarded(ws, 'notes/b.md', 'new\n', 'create')
    expect(readFileSync(join(folder, 'b.md'), 'utf8')).toBe('new\n')
    const name = stagedName(folder)
    expect(statSync(join(folder, 'b.md')).nlink).toBe(2)
    expect(statSync(join(folder, name)).ino).toBe(statSync(join(folder, 'b.md')).ino)
    expect(result.leftover).toContain(name)
    expect(result.leftover).toContain(folder)
  } finally {
    restore()
  }
})

test('the app save shows the committed leftover as a notice', async () => {
  const notices: string[] = []
  ws.onWriteNotice = (message) => { notices.push(message) }
  const restore = failTemporaryUnlink()
  try {
    await ws.saveFileWithoutReadBack('notes/b.md', 'new\n', { documentOnly: true })
  } finally {
    restore()
  }
  expect(readFileSync(join(folder, 'b.md'), 'utf8')).toBe('new\n')
  expect(notices).toHaveLength(1)
  expect(notices[0]).toContain(stagedName(folder))
})

test('the command line prints the committed leftover on stderr', async () => {
  const printed: string[] = []
  const stderr = spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { printed.push(String(chunk)); return true }) as typeof process.stderr.write)
  const restore = failTemporaryUnlink()
  try {
    await new WriteSession(ws, { confirmOwner: async () => {} }).create('notes/b.md', 'new\n')
  } finally {
    restore()
    stderr.mockRestore()
  }
  expect(readFileSync(join(folder, 'b.md'), 'utf8')).toBe('new\n')
  expect(printed.join('')).toContain(`writeflex: note: notes/b.md was saved, but its temporary file ${stagedName(folder)}`)
})

test('a notice that throws does not turn a committed app save into a failure', async () => {
  ws.onWriteNotice = () => { throw new Error('the window is gone') }
  const restore = failTemporaryUnlink()
  try {
    await ws.saveFileWithoutReadBack('notes/b.md', 'new\n', { documentOnly: true })
  } finally {
    restore()
  }
  expect(readFileSync(join(folder, 'b.md'), 'utf8')).toBe('new\n')
  expect(statSync(join(folder, 'b.md')).nlink).toBe(2)
})

describe('a create the app carries out on request', () => {
  test('its leftover goes to the window notice, and the request is applied', async () => {
    const fx = await writeFixture()
    const side = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)) })
    const notices: string[] = []
    side.workspace.onWriteNotice = (message) => { notices.push(message) }
    const restore = failTemporaryUnlink()
    try {
      const id = await plantRequest(fx, 'create', { path: 'made.md', content: 'Made.\n' })
      await side.executor.drain()
      expect((await replyTo(fx, id)).outcome).toBe('applied')
    } finally {
      restore()
      await side.close()
    }
    const name = readdirSync(fx.root).find((entry) => entry.startsWith('made.md.') && entry.endsWith('.tmp'))!
    expect(name).toBeDefined()
    expect(statSync(join(fx.root, 'made.md')).nlink).toBe(2)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(name)
    await fx.dispose()
  })

  test('a notice that throws leaves the request applied', async () => {
    const fx = await writeFixture()
    const side = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)) })
    side.workspace.onWriteNotice = () => { throw new Error('the window is gone') }
    const restore = failTemporaryUnlink()
    try {
      const id = await plantRequest(fx, 'create', { path: 'made.md', content: 'Made.\n' })
      await side.executor.drain()
      expect((await replyTo(fx, id)).outcome).toBe('applied')
    } finally {
      restore()
      await side.close()
    }
    expect(readFileSync(join(fx.root, 'made.md'), 'utf8')).toContain('Made.')
    await fx.dispose()
  })
})
