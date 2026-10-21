/**
 * Second-review parcel P10, invariant 1: rollback and undo write a file only if, at the moment of the
 * rename, its bytes still have the fingerprint that was checked; otherwise the file is left, named, and
 * the record kept.
 *
 * Schedule, in every test: the command checks the file's fingerprint; then, at the write's own seam
 * (`betweenCheckAndWrite`, inside the guarded write, after the check and before the rename), another
 * program (here the test, standing for file sync) writes the file. Nothing here waits on the clock.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { CommandLineWorkspace } from '../../src/main/cli/guarded-workspace'
import { WriteSession } from '../../src/main/cli/write-session'
import { scrapsPathFor } from '../../src/main/scraps'
import { NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

let fx: WriteFixture
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => { await fx.dispose() })

const SYNCED = '# Notes\n\nA paragraph file sync brought in from another Mac.\n'
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const b64 = (text: string): string => Buffer.from(text).toString('base64')

test('rollback: a file written by sync after rollback checked it, and before the rename, is left as sync wrote it and named; the rest is put back', async () => {
  const before = await fx.snapshot()
  // `move talks/york.md talks/york-2026.md`: write steps 1 the folder, 2 the move, 3 to 5 the repairs.
  // Step 5 fails, so the two repairs written are rolled back; sync writes the first of them meanwhile.
  let step = 0
  const repaired: string[] = []
  let rollingBack = false
  let synced = ''
  const failed = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'], {
    write: {
      seams: {
        beforeWrite: async (path) => {
          step += 1
          if (step === 3 || step === 4) repaired.push(path)
          if (step === 5) { rollingBack = true; throw new Error('disk fault') }
        },
        betweenCheckAndWrite: async (path) => {
          if (rollingBack && synced === '' && path === repaired[0]) { synced = path; await writeFile(join(fx.root, path), SYNCED) }
        },
      },
    },
  })
  // The schedule ran: rollback reached the write of the first repaired file.
  expect(synced).toBe(repaired[0])
  expect(failed.code).toBe(1)
  expect(failed.json.error!.message).toContain(`${synced}: it has changed since this operation wrote it, so it was left as it is`)
  // Sync's text stands; the other repaired file and the moved document are back.
  expect(await fx.read(synced)).toBe(SYNCED)
  const after = await fx.snapshot()
  for (const path of Object.keys(before)) if (path !== synced) expect(after[path], path).toBe(before[path])
  expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(false)
  // What is left is on record as an interrupted change.
  expect((await fx.journalNames()).filter((name) => name.endsWith('.intent.jsonl'))).toHaveLength(1)
})

test('WriteSession.rollback: a file written by sync after rollback checked it, and before the rename, is left and named', async () => {
  // The session's own rollback, with nothing in front of it: it rewrote notes.md, then puts it back.
  let rollingBack = false
  let synced = false
  const session = new WriteSession(new CommandLineWorkspace(fx.root), {
    confirmOwner: async () => {},
    seams: { betweenCheckAndWrite: async (path) => { if (rollingBack && path === 'notes.md') { synced = true; await writeFile(join(fx.root, path), SYNCED) } } },
  })
  await session.replace('notes.md', '# Notes, rewritten by the operation\n')
  rollingBack = true
  const back = await session.rollback()
  expect(synced).toBe(true)
  expect(back.problems).toEqual(['notes.md: it has changed since this operation wrote it, so it was left as it is'])
  expect(await fx.read('notes.md')).toBe(SYNCED)
})

test('undo: a file written by sync after undo checked it, and before the rename, is not overwritten; the undo is refused and nothing else is left changed', async () => {
  const id = (await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])).json.result!.undo as string
  const after = await fx.snapshot()
  const target = 'talks/intro.md'
  let synced = false
  const refused = await fx.cli(['undo'], {
    write: { seams: { betweenCheckAndWrite: async (path) => { if (path === target && !synced) { synced = true; await writeFile(join(fx.root, path), SYNCED) } } } },
  })
  expect(synced).toBe(true)
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toContain(`Undo refused: ${target} has changed since the command line wrote it`)
  expect(await fx.read(target)).toBe(SYNCED)
  // Every other file is as the move left it: what undo had put back before the refusal is put back again.
  const now = await fx.snapshot()
  for (const path of Object.keys(after)) if (path !== target) expect(now[path], path).toBe(after[path])
  // The entry is still there to undo.
  expect((await fx.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ id, undone: false }])
})

test('interrupted undo: a file written by sync after the file-by-file check, and before the rename, is refused by name and kept on record', async () => {
  // What a move killed after one repair leaves: the repaired file holds what the command line wrote, and the intent says so.
  const ID = '20261009T120000000Z-0a0b0c0d'
  const OLD = '# Notes\n\nSee [[york]].\n'
  await mkdir(fx.journalDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.journalDir, `${ID}.intent.jsonl`), [
    { version: 1, id: ID, intent: true, at: new Date().toISOString(), operation: 'move' },
    { file: { path: 'notes.md', before: b64(OLD), wrote: sha(NOTES) } },
  ].map((line) => `${JSON.stringify(line)}\n`).join(''))
  expect(await fx.read('notes.md')).toBe(NOTES)
  let synced = false
  const refused = await fx.cli(['undo', ID], {
    write: { seams: { betweenCheckAndWrite: async (path) => { if (path === 'notes.md' && !synced) { synced = true; await writeFile(join(fx.root, path), SYNCED) } } } },
  })
  expect(synced).toBe(true)
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toContain('notes.md has changed since the command line wrote it')
  expect(await fx.read('notes.md')).toBe(SYNCED)
  // Still on record, so it can be finished once the file is dealt with.
  expect((await fx.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ id: ID, interrupted: true, undone: false }])
  expect(await fx.read('talks/york.md')).toBe(YORK)
})

test('scrap: an existing scraps file written by sync after it was read, and before the rename, is not overwritten', async () => {
  const scraps = scrapsPathFor('notes.md')
  expect((await fx.cli(['scrap', 'notes.md', '--text', 'first'])).code).toBe(0)
  let synced = false
  const refused = await fx.cli(['scrap', 'notes.md', '--text', 'second'], {
    write: { seams: { betweenCheckAndWrite: async (path) => { if (path === scraps) { synced = true; await writeFile(join(fx.root, path), SYNCED) } } } },
  })
  expect(synced).toBe(true)
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toContain(`${scraps} changed while it was being saved, so nothing was written.`)
  expect(await fx.read(scraps)).toBe(SYNCED)
})
