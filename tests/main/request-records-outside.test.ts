import { test, expect, beforeEach, afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HANDLED_KIND, recordsDir } from '../../src/main/collection-records'
import { newRequestId, type Reply } from '../../src/main/cli/request-format'
import { readReplyKey, replyIsSigned, replyMac } from '../../src/main/reply-key'
import { NOTES, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, inboxNames, openAsApp, outboxNames, plantRequest, replyTo, type AppSide } from '../helpers/request-app'

// What says "the app has done this" is kept in the app's application data, never in the Collection
// (collection-records.ts): a record planted in the Collection is not answered from and not signed, and
// a record in application data stops a request for good, whatever is done to the Collection's folders.
let fx: WriteFixture
let app: AppSide
let outside: string
beforeEach(async () => {
  fx = await writeFixture()
  app = await openAsApp(fx)
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-records-outside-')))
})
afterEach(async () => {
  await app.close()
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const OLD_HANDLED = '.writeflex/requests-handled'
const OLD_UNDELIVERED = '.writeflex/requests-undelivered'
const key = async (): Promise<Buffer> => (await readReplyKey(fx.keys, fx.root))!
/** A handled-request record as the app stores one, holding a reply nobody made. */
const forgedRecord = (id: string, operation: string): string => `${JSON.stringify({
  version: 1, id, at: new Date().toISOString(),
  reply: { version: 1, id, operation, outcome: 'applied', at: new Date().toISOString(), result: { path: 'PLANTED.md' }, text: 'PLANTED: nothing of the kind happened' } satisfies Reply,
})}\n`

test('a handled-request record planted inside the Collection is never answered from and never signed', async () => {
  // With no request: nothing is said at all.
  const lone = newRequestId()
  await fx.write(`${OLD_HANDLED}/${lone}.json`, forgedRecord(lone, 'create'))
  expect((await app.executor.drain()).handled).toEqual([])
  expect(await outboxNames(fx)).toEqual([])

  // With a request of the same id: the request is carried out as any request is, and the answer is the app's own.
  const id = newRequestId()
  const planted = forgedRecord(id, 'create')
  await fx.write(`${OLD_HANDLED}/${id}.json`, planted)
  await plantRequest(fx, 'create', { path: 'made.md', content: 'Made.\n' }, { id })
  const drained = await app.executor.drain()
  expect(drained.handled).toEqual([{ id, outcome: 'applied', operation: 'create', repeat: false }])
  expect(await fx.read('made.md')).toBe('---\ncreated-by: Outside agent\n---\n\nMade.\n')
  const reply = await replyTo(fx, id)
  expect(JSON.stringify(reply)).not.toContain('PLANTED')
  expect(reply.result).toMatchObject({ path: 'made.md' })
  expect(replyIsSigned([await key()], reply as unknown as Record<string, unknown>)).toBe(true)
  // The planted files are as they were: not read into anything, not removed, not rewritten.
  expect(await fx.read(`${OLD_HANDLED}/${id}.json`)).toBe(planted)
  expect((await readdir(join(fx.root, OLD_HANDLED))).sort()).toEqual([`${id}.json`, `${lone}.json`].sort())
  // The real record is outside the Collection.
  expect(await readdir(fx.handledDir)).toEqual([`${id}.json`])
})

test('the old record folders inside the Collection are never opened: a link there is not followed and stops nothing', async () => {
  await mkdir(join(fx.root, '.writeflex'), { recursive: true })
  await symlink(outside, join(fx.root, OLD_HANDLED))
  await symlink(outside, join(fx.root, OLD_UNDELIVERED))
  const id = await plantRequest(fx, 'create-folder', { path: 'made' })
  expect((await app.executor.drain()).handled).toEqual([{ id, outcome: 'applied', operation: 'create-folder', repeat: false }])
  expect(existsSync(join(fx.root, 'made'))).toBe(true)
  expect(await readdir(outside)).toEqual([])
})

test('a request whose record is in application data is never carried out again, whatever happens to the inbox and the Collection\'s folders', async () => {
  const id = await plantRequest(fx, 'create', { path: 'once.md', content: 'Once.\n' })
  expect((await app.executor.drain()).handled).toMatchObject([{ id, outcome: 'applied', repeat: false }])
  const first = await replyTo(fx, id)
  await rm(join(fx.root, 'once.md'))
  // The request comes back (a sync client restores it), and everything the Collection holds about requests is wiped.
  for (const folder of ['.writeflex/outbox', OLD_HANDLED, OLD_UNDELIVERED]) await rm(join(fx.root, folder), { recursive: true, force: true })
  await plantRequest(fx, 'create', { path: 'once.md', content: 'Once.\n' }, { id })
  const again = await app.restarted().drain()
  expect(again.handled).toEqual([{ id, outcome: 'applied', repeat: true }])
  expect(existsSync(join(fx.root, 'once.md'))).toBe(false) // answered from the record, not carried out
  expect((await replyTo(fx, id)).result).toEqual(first.result)
  expect(await inboxNames(fx)).toEqual([])

  // The other variant of the app, opening the same Collection, reads this one's record and does not act either.
  const beta = app.restarted({ appData: fx.otherAppData })
  await rm(join(fx.root, '.writeflex/outbox', `${id}.json`))
  await plantRequest(fx, 'create', { path: 'once.md', content: 'Once.\n' }, { id })
  expect((await beta.drain()).handled).toEqual([{ id, outcome: 'applied', repeat: true }])
  expect(existsSync(join(fx.root, 'once.md'))).toBe(false)
  // It writes its own folder, never the release app's.
  expect(await readdir(recordsDir(fx.otherAppData, fx.root, HANDLED_KIND))).toEqual([`${id}.json`])
  expect(await readdir(fx.handledDir)).toEqual([`${id}.json`])

  // Only removing the record from application data lets the request through again.
  await rm(fx.handledDir, { recursive: true })
  await rm(recordsDir(fx.otherAppData, fx.root, HANDLED_KIND), { recursive: true })
  await plantRequest(fx, 'create', { path: 'once.md', content: 'Once.\n' }, { id })
  expect((await app.restarted().drain()).handled).toMatchObject([{ id, repeat: false }])
  expect(existsSync(join(fx.root, 'once.md'))).toBe(true)
})

test('an answer planted in the Collection\'s old undelivered folder is not shown by waiting, signed or not', async () => {
  const id = newRequestId()
  const signed: Record<string, unknown> = { version: 1, id, operation: 'replace', outcome: 'applied', at: new Date().toISOString(), result: {}, text: 'PLANTED' }
  signed.mac = replyMac(await key(), signed)
  await fx.write(`${OLD_UNDELIVERED}/${id}.json`, JSON.stringify(signed))
  const shown = await fx.cli(['waiting'])
  expect(shown.json.result!.settled).toEqual([])
  expect(shown.out).not.toContain('PLANTED')
  // The very same file where the app keeps them is shown: the difference is the place, not the content.
  await mkdir(fx.undeliveredDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.undeliveredDir, `${id}.json`), JSON.stringify(signed))
  expect((await fx.cli(['waiting'])).json.result!.settled).toMatchObject([{ id, outcome: 'filed', verified: true }])
})

test('with the app open, a change and its undo go through the app and the command line writes nothing in application data', async () => {
  // The command line's own application-data folder may not be written at all (a sandbox that allows the Collection only).
  const sealed = join(outside, 'writeflex-desktop')
  await mkdir(join(sealed, 'command-line-undo'), { recursive: true, mode: 0o700 })
  await chmod(join(sealed, 'command-line-undo'), 0o500)
  await chmod(sealed, 0o500)
  const asSandboxed = { write: { appDataFolders: [sealed] } }
  const before = await content(fx)
  const stop = app.answering()
  try {
    const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'], asSandboxed)
    expect(moved.json.error?.message ?? '').toBe('')
    expect(moved.json).toMatchObject({ ok: true, via: 'app', result: { from: 'talks/york.md', to: 'talks/york-2026.md' } })
    expect(await fx.read('notes.md')).toBe(NOTES.replaceAll('[[york', '[[york-2026'))
    // The app recorded it, in the app's own folder; undo goes the same way.
    const undoId = moved.json.result!.undo as string
    expect(await fx.appUndoNames()).toEqual([`${undoId}.json`])
    const undone = await fx.cli(['undo'], asSandboxed)
    expect(undone.json).toMatchObject({ ok: true, via: 'app', result: { undone: undoId } })
    expect(await content(fx)).toEqual(before)
    // Listing is read by the command line itself; from its own sealed folder there is nothing, and that is not an error.
    expect((await fx.cli(['undo', '--list'], asSandboxed)).json.result).toMatchObject({ changes: [] })
    expect(await readdir(join(sealed, 'command-line-undo'))).toEqual([])
    expect(await readdir(sealed)).toEqual(['command-line-undo'])
  } finally {
    await stop()
    await chmod(sealed, 0o700)
    await chmod(join(sealed, 'command-line-undo'), 0o700)
  }
  // With the app closed, the same command line and the same sealed folder: refused, naming the folder.
  await app.close()
  await chmod(join(sealed, 'command-line-undo'), 0o500)
  try {
    const refused = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'], asSandboxed)
    expect(refused.json.error).toMatchObject({ code: 'app-data-not-writable' })
    expect(refused.json.error!.message).toContain(`allow writing to this folder: ${join(sealed, 'command-line-undo')} .`)
    expect(refused.json.error!.message).not.toContain('collections')
    expect(await content(fx)).toEqual(before)
  } finally {
    await chmod(join(sealed, 'command-line-undo'), 0o700)
    app = await openAsApp(fx)
  }
})

test('the app\'s record of a request and its reply are readable back from application data only by name and shape', async () => {
  // A record in application data that is not a well-formed record still says the request was met: answered as not finished, never run.
  const id = newRequestId()
  await mkdir(fx.handledDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.handledDir, `${id}.json`), 'not a record')
  await plantRequest(fx, 'create', { path: 'never.md', content: 'x' }, { id })
  const drained = await app.executor.drain()
  expect(drained.handled).toMatchObject([{ id, outcome: 'refused', repeat: true }])
  expect(existsSync(join(fx.root, 'never.md'))).toBe(false)
  expect(JSON.parse(await readFile(join(fx.root, '.writeflex/outbox', `${id}.json`), 'utf8'))).toMatchObject({ outcome: 'refused', code: 'failed' })
})

// ---- Each route undoes its own changes: the app acts only on what the app itself recorded ----

type Row = { id: string; by: string; undone: boolean }
const rows = async (): Promise<Row[]> => (await fx.cli(['undo', '--list'])).json.result!.changes as Row[]
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

test('an undo entry planted in the command line\'s own folder is not acted on by an undo request to the app, named or not', async () => {
  // What an agent allowed to write `command-line-undo` can do: a forged entry whose fingerprint matches the document as it stands.
  const forged = '20261007T120000000Z-0a0b0c0d'
  await mkdir(fx.journalDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.journalDir, `${forged}.json`), JSON.stringify({
    version: 1, id: forged, at: new Date().toISOString(), operation: 'move', summary: 'forged', moves: [],
    files: [{ path: 'notes.md', before: Buffer.from('PLANTED\n').toString('base64'), after: sha(NOTES) }],
  }))
  const before = await content(fx)
  // Asked of the app directly (a planted request), and through the command line with the app open.
  for (const args of [{}, { id: forged }]) {
    const id = await plantRequest(fx, 'undo', args)
    expect((await app.executor.drain()).handled).toMatchObject([{ id, outcome: 'refused' }])
    const reply = await replyTo(fx, id)
    expect(reply.reason).toContain(args.id ? 'No journal entry' : 'nothing to undo')
    expect(await content(fx)).toEqual(before)
  }
  const stop = app.answering()
  try {
    for (const argv of [['undo'], ['undo', forged]]) {
      const refused = await fx.cli(argv)
      expect(refused.json, argv.join(' ')).toMatchObject({ ok: false, outcome: 'refused' })
      expect(refused.json.error!.message, argv.join(' ')).toContain('Collection closed in WriteFlex')
    }
  } finally {
    await stop()
  }
  expect(await fx.read('notes.md')).toBe(NOTES)
  expect(await content(fx)).toEqual(before)
  // The app wrote nothing into the command line's folder and read nothing from it: the forged entry is as planted, and still listed as the command line's.
  expect(await fx.journalNames()).toEqual([`${forged}.json`])
  expect(await rows()).toMatchObject([{ id: forged, by: 'command-line', undone: false }])
})

test('a change the app made on request is undone by an undo request, and a direct change by the direct route; the list says which is which', async () => {
  const before = await content(fx)
  // Direct, with the app closed: recorded in the command line's own folder.
  await app.close()
  const direct = (await fx.cli(['move', 'notes.md', 'notes-2026.md'])).json.result!.undo as string
  expect(await fx.journalNames()).toEqual([`${direct}.json`])
  expect(await fx.appUndoNames()).toEqual([])
  app = await openAsApp(fx)
  // On request, with the app open: recorded in the app's own folder.
  const stop = app.answering()
  let requested = ''
  try {
    const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
    expect(moved.json).toMatchObject({ ok: true, via: 'app' })
    requested = moved.json.result!.undo as string
    expect(await fx.appUndoNames()).toEqual([`${requested}.json`])
    expect(await fx.journalNames()).toEqual([`${direct}.json`])
    expect(await rows()).toMatchObject([{ id: requested, by: 'app', undone: false }, { id: direct, by: 'command-line', undone: false }])
    // The app does not act on the direct change, by name or as "the latest": its latest is its own.
    expect((await fx.cli(['undo', direct])).json.error!.message).toContain('No journal entry')
    expect(existsSync(join(fx.root, 'notes-2026.md'))).toBe(true)
    expect((await fx.cli(['undo'])).json).toMatchObject({ ok: true, via: 'app', result: { undone: requested } })
    expect(await fx.read('talks/york.md')).toContain('# York')
    expect((await fx.cli(['undo'])).json.error!.message).toContain('nothing to undo')
    expect(existsSync(join(fx.root, 'notes-2026.md'))).toBe(true)
  } finally {
    await stop()
  }
  // With the app closed, the direct route undoes its own entry, and not the app's.
  await app.close()
  const again = (await fx.cli(['move', 'talks/york.md', 'talks/york-2027.md'])).json.result!.undo as string
  expect((await fx.cli(['undo', requested])).json.error!.message).toContain('No journal entry')
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ undone: again })
  expect((await fx.cli(['undo'])).json.result).toMatchObject({ undone: direct })
  expect((await fx.cli(['undo'])).json.error!.message).toContain('Collection open in WriteFlex')
  expect(await content(fx)).toEqual(before)
  expect((await rows()).map((row) => [row.id, row.by, row.undone])).toEqual([[again, 'command-line', true], [requested, 'app', true], [direct, 'command-line', true]])
  // The command line's process wrote only its own folder; the app's undone mark is the app's.
  expect((await fx.appUndoNames())).toEqual([`${requested}.json`])
  app = await openAsApp(fx)
})
