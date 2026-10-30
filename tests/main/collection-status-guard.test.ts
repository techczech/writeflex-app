// The shared status route commits only over the text it planned from (spec-folio-room-data-model § 3 D-STA-1,
// I-6; T-STATUS in § 13): a save another editor makes between the plan's read and the commit is refused and
// the file keeps that editor's bytes. The IPC probe (bottom) checks the route's answer and that a refusal
// sends no change notice.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskChangedUnderBuffer, Workspace, type FileReadResult } from '../../src/main/workspace'
import { planCollectionPieceStatus, setCollectionPieceStatus } from '../../src/main/collection'
import type { SaveBasis } from '../../src/shared/save-basis'

const ORIGINAL = '---\ntitle: The Piece\nstatus: idea\ndescription: Keep this\n---\n\n# The Piece\n\nBody.\n'
const OTHER = '---\ntitle: The Piece\nstatus: idea\ndescription: Keep this\n---\n\n# The Piece\n\nBody, edited in another app.\n'
const PIECE = 'series/piece.md'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wf-status-guard-'))
  await mkdir(join(root, 'series'), { recursive: true })
  await writeFile(join(root, PIECE), ORIGINAL, 'utf8')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const onDisk = (): Promise<string> => readFile(join(root, PIECE), 'utf8')
const folderNames = (): string[] => readdirSync(join(root, 'series')).sort()

/** Another editor saves the piece right after the plan's read of it (the plan then awaits the pattern scan). */
class EditedAfterRead extends Workspace {
  armed = true
  constructor(dir: string, readonly edit: () => Promise<void>) { super(dir) }
  override async readFile(path: string): Promise<FileReadResult> {
    const read = await super.readFile(path)
    if (this.armed && path === PIECE) { this.armed = false; await this.edit() }
    return read
  }
}

/** Another editor saves the piece in the tick of the rename: after the pre-check, before the commit check. */
class EditedAtRename extends Workspace {
  override commitOnlyOver(path: string, basis: SaveBasis): () => void {
    const guard = super.commitOnlyOver(path, basis)
    let calls = 0
    return () => {
      calls += 1
      if (calls === 2) writeFileSync(join(root, PIECE), OTHER, 'utf8')
      guard()
    }
  }
}

test('a save by another editor between plan and commit is refused, and the file holds that editor’s bytes', async () => {
  const ws = new EditedAfterRead(root, () => writeFile(join(root, PIECE), OTHER, 'utf8'))
  const before = folderNames()
  const refused = await setCollectionPieceStatus(ws, 'series', PIECE, 'editing').catch((error: unknown) => error)
  expect(refused).toBeInstanceOf(DiskChangedUnderBuffer)
  expect((refused as Error).message).toBe('series/piece.md changed on disk, so the editor\'s text was not written over it.')
  expect(await onDisk()).toBe(OTHER)
  expect(folderNames()).toEqual(before) // no staged file left behind
})

test('a save by another editor in the tick of the rename is refused too', async () => {
  const ws = new EditedAtRename(root)
  await expect(setCollectionPieceStatus(ws, 'series', PIECE, 'editing')).rejects.toBeInstanceOf(DiskChangedUnderBuffer)
  expect(await onDisk()).toBe(OTHER)
  expect(folderNames()).toEqual(['piece.md'])
})

test('a piece removed between plan and commit is not written back', async () => {
  const ws = new EditedAfterRead(root, () => unlink(join(root, PIECE)))
  await expect(setCollectionPieceStatus(ws, 'series', PIECE, 'editing')).rejects.toBeInstanceOf(DiskChangedUnderBuffer)
  expect(existsSync(join(root, PIECE))).toBe(false)
  expect(folderNames()).toEqual([])
})

test('a status write of an unchanged file writes exactly the planned bytes, as before', async () => {
  const ws = new Workspace(root)
  const plan = await planCollectionPieceStatus(ws, 'series', PIECE, 'editing')
  const saved = await setCollectionPieceStatus(ws, 'series', PIECE, 'editing')
  const expected = '---\ntitle: The Piece\nstatus: editing\ndescription: Keep this\n---\n\n# The Piece\n\nBody.\n'
  expect(plan.next).toBe(expected)
  expect(saved.content).toBe(expected)
  expect('written' in saved && saved.written).toBe(expected)
  expect(await onDisk()).toBe(expected)
})

test('first touch keeps adding the Collection pattern’s missing keys, CRLF and BOM kept', async () => {
  const ws = new Workspace(root)
  const bare = '﻿# Bare\r\n\r\nProse.\r\n'
  await writeFile(join(root, 'series/bare.md'), bare, 'utf8')
  const plan = await planCollectionPieceStatus(ws, 'series', 'series/bare.md', 'ready')
  await setCollectionPieceStatus(ws, 'series', 'series/bare.md', 'ready')
  const written = await readFile(join(root, 'series/bare.md'), 'utf8')
  expect(written).toBe(plan.next!)
  // The sibling's observed pattern (title, status, description): the missing key is added, title never is.
  expect(written).toBe('\uFEFF---\r\nstatus: ready\r\ndescription: ""\r\n---\r\n\r\n# Bare\r\n\r\nProse.\r\n')
})

test('planning a status writes nothing (I-4)', async () => {
  const ws = new Workspace(root)
  const before = await stat(join(root, PIECE))
  await Bun.sleep(15)
  await planCollectionPieceStatus(ws, 'series', PIECE, 'editing')
  expect(await onDisk()).toBe(ORIGINAL)
  expect((await stat(join(root, PIECE))).mtimeMs).toBe(before.mtimeMs)
  expect(folderNames()).toEqual(['piece.md'])
})

const probe = String.raw`
  import { mock } from 'bun:test'
  import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
  import { join } from 'node:path'
  import { tmpdir } from 'node:os'
  import { EventEmitter } from 'node:events'
  const root = await mkdtemp(join(tmpdir(), 'wf-status-guard-ipc-'))
  const handlers = new Map()
  const sent = []
  mock.module('electron', () => ({
    app: { getPath: () => root, getVersion: () => '0.0.0-test', isPackaged: false },
    clipboard: {}, dialog: {}, shell: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) },
  }))
  const [{ registerIpc }, { registerWindow }, { Workspace }] = await Promise.all([
    import('./src/main/ipc.ts'), import('./src/main/state.ts'), import('./src/main/workspace.ts'),
  ])
  let edit = null
  class Raced extends Workspace {
    async readFile(path) {
      const read = await super.readFile(path)
      const now = edit; edit = null
      if (now && path === 'series/piece.md') await now()
      return read
    }
  }
  const sender = Object.assign(new EventEmitter(), { id: 72, send: (channel, value) => sent.push([channel, value]) })
  const state = registerWindow({ webContents: sender, on: () => {}, isDestroyed: () => false })
  state.workspace = new Raced(root)
  state.agent = null
  state.agentReady = null
  registerIpc({ openFolder: async () => {}, openFile: async () => {}, recents: () => [], openRecent: async () => {} }, { modelDefaults: () => ({}), recents: () => [] }, {})
  const invoke = (name, value) => handlers.get(name)({ sender }, value)
  const file = join(root, 'series', 'piece.md')
  const changes = () => sent.filter(([channel]) => channel === 'collection:changed').length
  try {
    await mkdir(join(root, 'series'))
    await writeFile(file, '---\nstatus: idea\n---\n\n# Piece\n')
    edit = () => writeFile(file, '---\nstatus: idea\n---\n\n# Piece\n\nTyped elsewhere.\n')
    let message = null
    try { await invoke('collection:set-status', { dir: 'series', path: 'series/piece.md', status: 'editing' }) }
    catch (error) { message = error.message }
    const refusedDisk = await readFile(file, 'utf8')
    const changesAfterRefusal = changes()
    const saved = await invoke('collection:set-status', { dir: 'series', path: 'series/piece.md', status: 'editing' })
    console.log(JSON.stringify({ message, refusedDisk, changesAfterRefusal, saved: saved.content, disk: await readFile(file, 'utf8'), changes: changes() }))
  } finally { await rm(root, { recursive: true, force: true }) }
`

test('the status IPC answers a refused save with the app’s plain answer and announces no change', async () => {
  const child = Bun.spawn([process.execPath, '-e', probe], { cwd: new URL('../..', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`Status guard IPC probe failed: ${stderr}`)
  expect(JSON.parse(stdout.trim().split('\n').at(-1)!)).toEqual({
    message: 'Could not save this document. Try again.',
    refusedDisk: '---\nstatus: idea\n---\n\n# Piece\n\nTyped elsewhere.\n',
    changesAfterRefusal: 0,
    saved: '---\nstatus: editing\n---\n\n# Piece\n\nTyped elsewhere.\n',
    disk: '---\nstatus: editing\n---\n\n# Piece\n\nTyped elsewhere.\n',
    changes: 1,
  })
})
