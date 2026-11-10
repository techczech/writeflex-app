import { test, expect, beforeEach, afterEach } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { newRequestId } from '../../src/main/cli/request-format'
import { INTRO, MANIFEST, NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, openAsApp, plantRequest, type AppSide } from '../helpers/request-app'

// Review parcel P7: putting back is a write like any other. A file is put back only if it holds exactly
// what the operation wrote to it; and once the app has closed the Collection under a request, nothing
// more is written, putting back included. (The owner-lock cases were removed with the lock on
// 2026-11-03: docs/plans/2026-11-03-sync-replicas-and-duplicate-reconciliation.md.)
//
// The write steps of `move talks/york.md talks/york-2026.md`: 1 the folder, 2 the move, 3 to 5 the
// three repaired files (notes.md, talks/intro.md, the manifest). No test here waits on a clock: each
// acts at a write step it is told of.
let fx: WriteFixture
const apps: AppSide[] = []
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close().catch(() => {})
  await fx.dispose()
})

const MOVE = ['move', 'talks/york.md', 'talks/york-2026.md']
const THEIRS = '# Notes\n\nThe next owner wrote this while the command was stopped.\n'
const intents = async (names: () => Promise<string[]>): Promise<string[]> => (await names()).filter((name) => name.endsWith('.intent.jsonl'))

test('a failed operation puts back only the files that hold what it wrote; one written since is left, named, and kept on record', async () => {
  const seen: string[] = []
  const result = await fx.cli(MOVE, {
    write: { seams: { beforeWrite: async (path) => {
      seen.push(path)
      // Another program (a sync client, an editor) saves into notes.md after
      // this command repaired it; then the command fails at its next file for an ordinary reason.
      if (seen.length === 4) await fx.write('notes.md', THEIRS)
      if (seen.length === 5) throw new Error('disk fault')
    } } },
  })
  expect(result.code).toBe(1)
  expect(result.json.error!.message).toContain('disk fault')
  expect(result.json.error!.message).toContain('Not everything could be put back: notes.md: it has changed since this operation wrote it, so it was left as it is.')
  expect(result.json.error!.message).toContain('writeflex undo --list')
  expect(await fx.read('notes.md')).toBe(THEIRS)
  // Everything that still held what the command wrote is back, and the path with it.
  expect(await fx.read('talks/intro.md')).toBe(INTRO)
  expect(await fx.read('talks/york.md')).toBe(YORK)
  expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(false)
  expect(await intents(fx.journalNames)).toHaveLength(1)
  expect(NOTES).not.toBe(THEIRS)
})

test('the app carrying out a request when its window closes the Collection: nothing more is written, nothing is put back, and the answer says so', async () => {
  const seen: string[] = []
  const app: AppSide = await openAsApp(fx, { seams: { write: { beforeWrite: async (path) => {
    seen.push(path)
    if (seen.length !== 4) return
    app.owns.value = false
    await fx.write('notes.md', THEIRS)
  } } } })
  apps.push(app)
  const id = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' }, { id: newRequestId() })
  const drained = await app.executor.drain()
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused', operation: 'move' }])
  const reason = drained.handled[0].reason!
  expect(reason).toContain('WriteFlex closed this Collection partway through this request')
  expect(reason).toContain('Already changed: talks/york.md was moved to talks/york-2026.md; notes.md was rewritten.')
  expect(reason).toContain('Nothing further was written, and nothing was put back.')
  expect(reason).toContain('writeflex undo --list')
  expect(JSON.parse(await readFile(join(fx.root, '.writeflex/outbox', `${id}.json`), 'utf8'))).toMatchObject({ outcome: 'refused', code: 'collection-closed' })
  expect(await fx.read('notes.md')).toBe(THEIRS)
  expect(await fx.read('talks/york-2026.md')).toBe(YORK)
  expect(existsSync(join(fx.root, 'talks/york.md'))).toBe(false)
  expect(await fx.read('talks/intro.md')).toBe(INTRO)
  // On record in the app's own undo journal, as interrupted.
  expect(await intents(fx.appUndoNames)).toHaveLength(1)
})

test('an executor disposed midway still has the Collection open: it puts back what holds exactly what it wrote, and leaves a file written since', async () => {
  const seen: string[] = []
  let disposed: Promise<void> | null = null
  const app: AppSide = await openAsApp(fx, { seams: { write: { beforeWrite: async (path) => {
    seen.push(path)
    if (seen.length === 4) await fx.write('notes.md', THEIRS)
    // Two files repaired, the first since written by someone else: now the window closes.
    if (seen.length === 5) disposed = app.executor.dispose()
  } } } })
  apps.push(app)
  const before = await content(fx)
  const id = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' }, { id: newRequestId() })
  const drained = await app.executor.drain()
  await disposed
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused' }])
  expect(drained.handled[0].reason).toContain('Not everything could be put back: notes.md: it has changed since this operation wrote it, so it was left as it is.')
  expect(await content(fx)).toEqual({ ...before, 'notes.md': Buffer.from(THEIRS).toString('base64') })
  expect(await intents(fx.appUndoNames)).toHaveLength(1)
})
