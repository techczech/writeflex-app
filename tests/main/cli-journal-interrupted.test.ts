import { test, expect, beforeEach, afterEach } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { link, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_NAME } from '../../src/main/folio'
import { INTRO, NOTES, YORK, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'

// Part A: a write that is killed partway leaves an intent the journal can undo, file by file.
// Part B (further down): an UNDO that is killed partway can be finished by the next undo.
//
// Every test takes its fixture into a constant of its own. A fixture refuses to be used once it is
// disposed, so a body that outlived its test stops at its next step, and never meets the next test's folder.
let fx: WriteFixture
const children = new Set<ChildProcess>()
beforeEach(async () => { fx = await writeFixture() })
afterEach(async () => {
  // A child a failed test left running is ended before the folders it works in are removed.
  await Promise.all([...children].map((child) => new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done()
    child.once('close', () => done())
    child.kill('SIGKILL')
  })))
  children.clear()
  await fx.dispose()
})

const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const REPAIRED = ['notes.md', 'talks/intro.md', `talks/${MANIFEST_NAME}`]
/** How long a child may take to reach its write step. It normally takes a fifth of a second; this is the test's own limit, not the runner's. */
const CHILD_DEADLINE_MS = 30_000
/** The runner's limit for a test with children: beyond every child's own deadline, so the deadline is what speaks. */
const withChildren = (count: number): number => count * CHILD_DEADLINE_MS + 30_000

/**
 * Run a write in a child process and kill it (SIGKILL) at its `stopAt`-th write step. The child says
 * where it is as it goes (tests/fixtures/cli-killed-write.ts); this waits for `stopped`, for the child
 * to end, or for the deadline, whichever comes first, and in every case the child is killed and has
 * gone before this returns. A child that ended or ran out of time fails the test with all it said.
 */
async function killedAt(f: WriteFixture, stopAt: number, argv: string[]): Promise<void> {
  const child = spawn(process.execPath, [join(import.meta.dir, '..', 'fixtures', 'cli-killed-write.ts'), f.root, f.appData, String(stopAt), ...argv], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.add(child)
  let said = ''
  let errors = ''
  const gone = new Promise<void>((resolve) => { child.once('close', () => { children.delete(child); resolve() }) })
  const told = (): string => `It said:\n${said}${errors ? `\nOn standard error:\n${errors}` : ''}`
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`The child did not reach write step ${stopAt} of "${argv.join(' ')}" within ${CHILD_DEADLINE_MS} ms. ${told()}`)), CHILD_DEADLINE_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
        if (said.includes('\nstopped\n')) { clearTimeout(deadline); resolve() }
      })
      child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString('utf8') })
      child.once('error', (error) => { clearTimeout(deadline); reject(error) })
      void gone.then(() => { clearTimeout(deadline); reject(new Error(`The child ended before write step ${stopAt} of "${argv.join(' ')}". ${told()}`)) })
    })
  } finally {
    child.kill('SIGKILL')
    await gone
  }
}

/** Write steps of `move talks/york.md talks/york-2026.md`: 1 the folder, 2 the move, 3 to 5 the three repaired files. */
const killedBetweenTwoRepairs = (f: WriteFixture): Promise<void> => killedAt(f, 4, ['move', 'talks/york.md', 'talks/york-2026.md'])

test('a move killed between two file writes is listed as interrupted, and undo puts every byte and path back', async () => {
  const f = fx
  const before = await f.snapshot()
  await killedBetweenTwoRepairs(f)

  // The kill really fell between two writes: the file moved, one repair was written, two were not.
  expect(existsSync(join(f.root, 'talks/york-2026.md'))).toBe(true)
  expect(existsSync(join(f.root, 'talks/york.md'))).toBe(false)
  const rewritten: string[] = []
  for (const path of REPAIRED) if ((await f.bytes(path)).toString('base64') !== before[path]) rewritten.push(path)
  expect(rewritten).toHaveLength(1)
  // No finished entry, and one intent.
  const names = await f.journalNames()
  expect(names).toHaveLength(1)
  expect(names[0]).toEndWith('.intent.jsonl')

  const listed = await f.cli(['undo', '--list'])
  const [row] = listed.json.result!.changes as Array<{ id: string; operation: string; interrupted: boolean; undone: boolean; files: number }>
  expect(row).toMatchObject({ operation: 'move', interrupted: true, undone: false })
  expect(row.files).toBe(2) // the moved document and the one repaired file: what had been announced

  const undone = await f.cli(['undo'])
  expect(undone.json.error?.message ?? '').toBe('')
  expect(undone.json.result).toMatchObject({ undone: row.id, interrupted: true, moved: [{ from: 'talks/york-2026.md', to: 'talks/york.md', kind: 'file' }], restored: rewritten })
  expect(await f.snapshot()).toEqual(before)
  // The intent has become a finished, undone entry; it cannot be undone twice.
  expect(await f.journalNames()).toEqual([`${row.id}.json`])
  expect((await f.cli(['undo', row.id])).json.error!.message).toContain('already undone')
  expect((await f.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ id: row.id, undone: true, interrupted: true }])
}, withChildren(1))

test('undo of an interrupted change refuses, by name, a file somebody has written since, and restores the rest', async () => {
  const f = fx
  const before = await f.snapshot()
  await killedAt(f, 5, ['move', 'talks/york.md', 'talks/york-2026.md']) // two repairs written, the third not
  const rewritten: string[] = []
  for (const path of REPAIRED) if ((await f.bytes(path)).toString('base64') !== before[path]) rewritten.push(path)
  expect(rewritten).toHaveLength(2)
  const [edited, untouched] = rewritten
  const mine = `${await f.read(edited)}\nA line the writer added since.\n`
  await f.write(edited, mine)

  const refused = await f.cli(['undo'])
  expect(refused.code).toBe(1)
  expect(refused.json.error).toMatchObject({ code: 'refused' })
  expect(refused.json.error!.message).toContain(`${edited} has changed since the command line wrote it`)
  expect(refused.json.error!.message).not.toContain(`${untouched} has changed`)
  // The writer's file is exactly as they left it; the other is back; the document is back at its name.
  expect(await f.read(edited)).toBe(mine)
  expect((await f.bytes(untouched)).toString('base64')).toBe(before[untouched])
  expect(await f.read('talks/york.md')).toBe(YORK)
  // Still on record as interrupted, so it can be finished once the file is dealt with.
  expect((await f.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ interrupted: true, undone: false }])
  await f.write(edited, Buffer.from(before[edited], 'base64'))
  expect((await f.cli(['undo'])).json.result).toMatchObject({ restored: [] })
  expect(await f.snapshot()).toEqual(before)
  // Nothing of the two undos is left beside the entry.
  expect((await f.journalNames()).filter((name) => name.endsWith('.intent.jsonl'))).toEqual([])
}, withChildren(1))

// Part B. Undo's write steps for the finished move: 1 to 3 the three repaired files put back, 4 the
// folder above the old name, 5 the move back.
const UNDO_STEPS = 5

test('an undo killed at any of its writes is finished by the next undo: every byte and path is back, and the entry is undone once', async () => {
  const f = fx
  const before = await f.snapshot()
  for (let step = 1; step <= UNDO_STEPS; step++) {
    const moved = await f.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
    const id = moved.json.result!.undo as string
    const after = await f.snapshot()
    await killedAt(f, step, ['undo'])
    // The kill fell where it was meant to: before step 1 nothing is put back, before step 5 all three files are and the path is not.
    const state = await f.snapshot()
    expect(REPAIRED.filter((path) => state[path] === before[path]), `step ${step}`).toHaveLength(Math.min(step - 1, 3))
    expect(existsSync(join(f.root, 'talks/york-2026.md')), `step ${step}`).toBe(true)
    if (step > 1) expect(state, `step ${step}`).not.toEqual(after)
    // On record: the entry, not undone, and that an undo of it did not finish. (Killed before its
    // first write, the undo had announced nothing and changed nothing: there is nothing to finish.)
    const begun = step > 1
    const listed = (await f.cli(['undo', '--list'])).json.result!.changes as Array<{ id: string; undone: boolean; undoStopped: boolean }>
    expect(listed.find((row) => row.id === id), `step ${step}`).toMatchObject({ undone: false, undoStopped: begun })
    expect(listed.filter((row) => !row.undone), `step ${step}`).toHaveLength(1) // the undo's own intent is not a change to undo

    const finished = await f.cli(['undo'])
    expect(finished.json.error?.message ?? '', `step ${step}`).toBe('')
    expect(finished.json.result, `step ${step}`).toMatchObject({ undone: id, ...(begun ? { resumed: true } : {}) })
    expect(await f.snapshot(), `step ${step}`).toEqual(before)
    expect((await f.journalNames()).filter((name) => name.endsWith('.intent.jsonl')), `step ${step}`).toEqual([])
    expect((await f.cli(['undo', id])).json.error!.message, `step ${step}`).toContain('already undone')
  }
}, withChildren(UNDO_STEPS))

test('finishing a killed undo refuses, by name, a file somebody has written since, puts the rest back, and can be finished later', async () => {
  const f = fx
  const before = await f.snapshot()
  const id = (await f.cli(['move', 'talks/york.md', 'talks/york-2026.md'])).json.result!.undo as string
  const after = await f.snapshot()
  await killedAt(f, 2, ['undo']) // one file put back, two not
  const pending = REPAIRED.filter((path) => (after[path] !== before[path]))
  const state = await f.snapshot()
  const notYet = pending.filter((path) => state[path] === after[path])
  expect(notYet).toHaveLength(2)
  const [edited, other] = notYet
  const mine = `${await f.read(edited)}\nA line the writer added since.\n`
  await f.write(edited, mine)

  const refused = await f.cli(['undo'])
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toContain(`${edited} has changed since the command line wrote it`)
  expect(refused.json.error!.message).not.toContain(`${other} has changed`)
  expect(await f.read(edited)).toBe(mine)
  expect((await f.bytes(other)).toString('base64')).toBe(before[other])
  expect(await f.read('talks/york.md')).toBe(YORK)
  // Still on record as an undo that did not finish: the next undo goes file by file again.
  expect((await f.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ id, undone: false, undoStopped: true }])
  await f.write(edited, Buffer.from(after[edited], 'base64'))
  expect((await f.cli(['undo'])).json.result).toMatchObject({ undone: id, resumed: true, restored: [edited] })
  expect(await f.snapshot()).toEqual(before)
  expect(await f.journalNames()).toEqual([`${id}.json`])
}, withChildren(1))

/** An intent written by a program that can write this user's application data: still data, never instructions. */
const plantIntent = async (id: string, lines: unknown[]): Promise<void> => {
  await mkdir(fx.journalDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.journalDir, `${id}.intent.jsonl`), [{ version: 1, id, intent: true, at: new Date().toISOString(), operation: 'move' }, ...lines].map((line) => `${JSON.stringify(line)}\n`).join(''))
}
const ID = '20261007T120000000Z-0a0b0c0d'
const b64 = (text: string): string => Buffer.from(text).toString('base64')

test('every path in an intent is judged before undo acts: a planted intent cannot write, move or restore outside document paths', async () => {
  await fx.write('outside-target.md', 'mine\n')
  const cases: unknown[][] = [
    [{ file: { path: '.writeflex/changes.jsonl', before: b64('forged\n'), wrote: sha('{"change":"fixture"}\n') } }],
    [{ file: { path: '../escape.md', before: b64('x'), wrote: sha('x') } }],
    [{ file: { path: 'talks/picture.png', before: b64('x'), wrote: sha('x') } }],
    [{ move: { from: 'notes.md', to: '.bridle/notes.md', kind: 'file' } }],
    [{ move: { from: '.writeflex', to: 'visible', kind: 'folder' } }],
    // A move that would carry a recorded file out of a hidden folder.
    [{ file: { path: 'talks/york.md', before: b64('x'), wrote: sha(YORK) } }, { move: { from: '.git', to: 'talks', kind: 'folder' } }],
  ]
  for (const lines of cases) {
    await plantIntent(ID, lines)
    const before = await fx.snapshot({ journal: true })
    const refused = await fx.cli(['undo', ID])
    expect(refused.code, JSON.stringify(lines)).toBe(1)
    expect(refused.json.error!.message, JSON.stringify(lines)).toContain('Undo refused')
    expect(await fx.snapshot({ journal: true })).toEqual(before)
  }
})

test('an intent line cut short by the kill is dropped; a malformed line elsewhere makes the intent unreadable', async () => {
  await plantIntent(ID, [{ file: { path: 'notes.md', before: b64('# Old notes\n'), wrote: sha(NOTES) } }])
  const path = join(fx.journalDir, `${ID}.intent.jsonl`)
  await writeFile(path, `${await readFile(path, 'utf8')}{"file":{"path":"talks/intro.md","bef`)
  expect((await fx.cli(['undo', '--list'])).json.result!.changes).toMatchObject([{ id: ID, interrupted: true, files: 1 }])
  expect((await fx.cli(['undo', ID])).json.result).toMatchObject({ restored: ['notes.md'] })
  expect(await fx.read('notes.md')).toBe('# Old notes\n')
  expect(await fx.read('talks/intro.md')).toBe(INTRO)

  const other = '20261007T130000000Z-0a0b0c0d'
  await plantIntent(other, [{ file: { path: 'notes.md', before: b64('x'), wrote: 'not a fingerprint' } }])
  const listed = (await fx.cli(['undo', '--list'])).json.result as { changes: Array<{ id: string }>; unreadable: string[] }
  expect(listed.unreadable).toEqual([`${other}.intent.jsonl`])
  expect(listed.changes.map((row) => row.id)).toEqual([ID])
})

test('a file move stopped between making the new name and removing the old is put back without losing the file', async () => {
  // What the move leaves at that moment: two names for one file, and the intent announcing the move.
  await link(join(fx.root, 'talks/york.md'), join(fx.root, 'talks/york-2026.md'))
  await plantIntent(ID, [{ file: { path: 'talks/york.md', before: b64(YORK), wrote: sha(YORK) } }, { move: { from: 'talks/york.md', to: 'talks/york-2026.md', kind: 'file' } }])
  expect((await fx.cli(['undo', ID])).json.error?.message ?? '').toBe('')
  expect(existsSync(join(fx.root, 'talks/york-2026.md'))).toBe(false)
  expect(await fx.read('talks/york.md')).toBe(YORK)

  // Two different files at the two names are not that state: refused, both left.
  const second = '20261007T140000000Z-0a0b0c0d'
  await fx.write('talks/york-2026.md', 'another document\n')
  await plantIntent(second, [{ move: { from: 'talks/york.md', to: 'talks/york-2026.md', kind: 'file' } }])
  const refused = await fx.cli(['undo', second])
  expect(refused.json.error!.message).toContain('both talks/york.md and talks/york-2026.md exist')
  expect(await fx.read('talks/york-2026.md')).toBe('another document\n')
  expect(await fx.read('talks/york.md')).toBe(YORK)
})

test('a finished write leaves no intent behind, and a write that failed and was put back leaves none either', async () => {
  expect((await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])).code).toBe(0)
  expect((await fx.journalNames()).every((name) => name.endsWith('.json'))).toBe(true)
  expect((await fx.cli(['undo'])).code).toBe(0)
  let writes = 0
  const failed = await fx.cli(['move', 'talks/york.md', 'talks/york-2027.md'], { write: { seams: { beforeWrite: async () => { if (++writes === 4) throw new Error('disk fault') } } } })
  expect(failed.code).toBe(1)
  expect((await fx.journalNames()).filter((name) => name.endsWith('.intent.jsonl'))).toEqual([])
})
