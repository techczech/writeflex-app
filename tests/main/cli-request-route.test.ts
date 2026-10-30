import { ScratchpadStore } from '../../src/main/scratchpad-store'
import { Workspace } from '../../src/main/workspace'
import { configureScratchpadHolders, scratchpadHolder } from '../../src/main/scratchpad-holders'
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { INBOX_DIR, MAX_REPLY_BYTES, OUTBOX_DIR, REQUEST_OPERATIONS, idOfFileName, parseRequest } from '../../src/main/cli/request-format'
import { runCli } from '../../src/main/cli/run'
import { unshow } from '../../src/main/cli/terminal-text'
import { CollectionOwnership } from '../../src/main/collection-ownership'
import { createReplyKey, readReplyKey, replyKeyPath, replyMac } from '../../src/main/reply-key'
import { buildOperationTable } from '../../src/main/cli/table'
import { acquireOwnerLock, inspectOwnerLock, releaseOwnerLock } from '../../src/main/owner-lock'
import { NOTES, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { content, inboxNames, openAsApp, outboxNames, type AppSide } from '../helpers/request-app'

// Ticket 05, the command line's side: who writes is decided by the owner lock (app -> one request file).
let fx: WriteFixture
let app: AppSide
let outside: string
beforeEach(async () => {
  fx = await writeFixture()
  app = await openAsApp(fx)
  outside = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-export-')))
})
afterEach(async () => {
  configureScratchpadHolders(() => [])
  await app.close()
  await fx.dispose()
  await rm(outside, { recursive: true, force: true })
})

const QUICK = { write: { request: { waitMs: 40, pollMs: 10 } } }

test('the operations that can be requested are exactly the operation table\'s writers, with export the one exception', () => {
  const writers = buildOperationTable().filter((operation) => operation.writes !== undefined && operation.writes !== false).map((operation) => operation.name)
  expect(writers).toContain('export')
  expect(REQUEST_OPERATIONS as readonly string[]).not.toContain('export')
  expect([...REQUEST_OPERATIONS, 'export'].sort()).toEqual(writers.sort())
})

test('with the app owning the Collection, export --confirm writes the target itself, from what is on disk, and files no request', async () => {
  const before = await fx.snapshot({ journal: true })
  const target = join(outside, 'n.html')
  const exported = await fx.cli(['export', 'notes.md', '--to', target, '--confirm'], QUICK)
  expect(exported.json.error?.message ?? '').toBe('')
  expect(exported.code).toBe(0)
  expect(exported.json).not.toHaveProperty('via')
  expect(exported.json.result).toMatchObject({ target, source: 'saved-on-disk', appOpen: true })
  expect(await readFile(target, 'utf8')).toContain('Notes')
  // Nothing in the Collection changed: no request, no journal, no lock taken from the app.
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  expect(await inboxNames(fx)).toEqual([])
  expect((await inspectOwnerLock(fx.root)).owner?.kind).toBe('app')

  // In plain text it says that unsaved text in the app is not in the export.
  let out = ''
  expect(await runCli(['--root', fx.root, 'export', 'notes.md', '--to', join(outside, 'm.html'), '--confirm'], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData] } })).toBe(0)
  expect(out).toContain('what is saved on disk')
  // Still only with --confirm, and never into the Collection the app holds.
  expect((await fx.cli(['export', 'notes.md', '--to', join(outside, 'o.html')], QUICK)).json.error!.message).toContain('Export refused')
  const inside = await fx.cli(['export', 'notes.md', '--to', join(fx.root, 'inside.html'), '--confirm'], QUICK)
  expect(inside.json.error!.message).toContain('inside the Collection, which WriteFlex has open')
  expect(await fx.snapshot({ journal: true })).toEqual(before)
  // With the app closed, the same export says the app is not there.
  await app.close()
  expect((await fx.cli(['export', 'notes.md', '--to', join(outside, 'p.html'), '--confirm'])).json.result).toMatchObject({ source: 'saved-on-disk', appOpen: false })
  app = await openAsApp(fx)
})

test('with the app owning the Collection, each direct operation produces exactly one request file, whole, and no other write', async () => {
  const table = buildOperationTable()
  const operations: string[][] = [
    ['create', 'x.md', '--content', 'New.\n'], ['create-folder', 'drafts'], ['duplicate', 'notes.md'], ['note', 'talks/york.md', '--body', 'A note.'],
    ['scrap', 'talks/york.md', '--text', 'A scrap.'], ['create-manifest', 'drafts'], ['capture', 'talks/york.md', '--kind', 'snippet', '--title', 'A line', '--body', 'A line.'], ['move', 'talks/york.md', 'talks/y.md'], ['move-folder', 'talks', 'events'],
    ['follow-history', '--map', 'moves.tsv'], ['undo-history', 'history-attachment-id'],
    ['trash', 'notes.md'], ['undo'], ['save-version', 'notes.md', '--name', 'Before the rewrite', '--note', 'As sent to York.'],
  ]
  expect(operations.map(([name]) => name).sort()).toEqual([...REQUEST_OPERATIONS].sort())
  for (const argv of operations) {
    const before = await fx.snapshot({ journal: true })
    const sent = await fx.cli(argv, QUICK)
    // Nobody answered: sent, not confirmed, and the request stays for the app.
    expect(sent.code, argv.join(' ')).toBe(3)
    expect(sent.json).toMatchObject({ ok: true, via: 'app', result: {} })
    const after = await fx.snapshot({ journal: true })
    const added = Object.keys(after).filter((path) => !(path in before))
    expect(added, argv.join(' ')).toHaveLength(1)
    expect(added[0].startsWith(`${INBOX_DIR}/`)).toBe(true)
    const id = idOfFileName(added[0].slice(INBOX_DIR.length + 1))
    expect(id).toBe(sent.json.result!.request as string)
    expect(Object.fromEntries(Object.entries(after).filter(([path]) => path !== added[0]))).toEqual(before)
    // The file is a complete, valid request for that operation.
    const parsed = parseRequest(await readFile(join(fx.root, added[0]), 'utf8'), id!, table)
    expect(parsed).toMatchObject({ ok: true, request: { operation: argv[0] } })
    await rm(join(fx.root, added[0]))
  }
  expect(await fx.journalNames()).toEqual([])
  expect((await inspectOwnerLock(fx.root)).owner?.kind).toBe('app')
  // Reading, and listing the journal, are not writes: they go straight through.
  expect((await fx.cli(['undo', '--list'])).json).not.toHaveProperty('via')
})

test('the app carries the operation out and the command line reports its reply; undo goes through the same channel', async () => {
  const before = await content(fx)
  const stop = app.answering()
  try {
    const moved = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
    expect(moved.json.error?.message ?? '').toBe('')
    expect(moved.code).toBe(0)
    expect(moved.json).toMatchObject({ ok: true, via: 'app', result: { from: 'talks/york.md', to: 'talks/york-2026.md' } })
    expect(await fx.read('notes.md')).toBe(NOTES.replaceAll('[[york', '[[york-2026'))
    // The request was removed by the app, the reply by the command line.
    expect(await inboxNames(fx)).toEqual([])
    expect(await outboxNames(fx)).toEqual([])
    // The app, which made the change, journalled it; the command line is told the id to undo it by.
    const undoId = moved.json.result!.undo as string
    expect(await fx.appUndoNames()).toEqual([`${undoId}.json`])
    expect(await fx.journalNames()).toEqual([])

    const undone = await fx.cli(['undo'])
    expect(undone.json).toMatchObject({ ok: true, via: 'app', result: { undone: undoId } })
    expect(await content(fx)).toEqual(before)
    expect(await inboxNames(fx)).toEqual([])
    expect(await outboxNames(fx)).toEqual([])
  } finally {
    await stop()
  }
  expect((await inspectOwnerLock(fx.root)).owner?.kind).toBe('app')
})

test('a refusal by the app is reported as refused with its reason; piped text travels as the text', async () => {
  const stop = app.answering()
  try {
    const taken = await fx.cli(['create', 'notes.md', '--content', 'x'])
    expect(taken.code).toBe(1)
    expect(taken.json.error).toMatchObject({ code: 'refused' })
    expect(taken.json.error!.message).toContain('notes.md already exists')
    expect(await fx.read('notes.md')).toBe(NOTES)

    expect((await fx.cli(['create', 'piped.md', '--stdin'], { stdin: 'Piped in.\n' })).json.result).toMatchObject({ path: 'piped.md' })
    expect(await fx.read('piped.md')).toBe('---\ncreated-by: Outside agent\n---\n\nPiped in.\n')
    expect((await fx.cli(['create', 'both.md', '--content', 'x', '--stdin'], { stdin: 'y' })).json.error).toMatchObject({ code: 'usage' })
    // An export without --confirm is refused before anything is sent.
    const names = await inboxNames(fx)
    expect((await fx.cli(['export', 'notes.md', '--to', join(outside, 'n.html')])).json.error!.message).toContain('Export refused')
    expect(await inboxNames(fx)).toEqual(names)
    const exported = await fx.cli(['export', 'notes.md', '--to', 'n.html', '--confirm'], { cwd: outside })
    expect(exported.json.result).toMatchObject({ target: join(outside, 'n.html') })
    expect(existsSync(join(outside, 'n.html'))).toBe(true)
  } finally {
    await stop()
  }
})

test('the command line does not send into, or read a reply from, a request folder that is a link', async () => {
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-elsewhere-')))
  try {
    await symlink(elsewhere, join(fx.root, INBOX_DIR))
    const refused = await fx.cli(['create', 'x.md'], QUICK)
    expect(refused.code).toBe(1)
    expect(refused.json.error!.message).toContain('not an ordinary folder')
    expect(await rm(join(fx.root, INBOX_DIR)).then(() => existsSync(join(elsewhere, 'anything')))).toBe(false)

    await mkdir(join(fx.root, '.writeflex'), { recursive: true })
    await symlink(elsewhere, join(fx.root, OUTBOX_DIR))
    const unread = await fx.cli(['create', 'x.md'], QUICK)
    expect(unread.code).toBe(1)
    expect(unread.json.error!.message).toContain('reply cannot be read')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('with nobody owning the Collection the command line writes it itself, under the lock, and files no request', async () => {
  await app.close()
  expect((await fx.cli(['create', 'direct.md', '--content', 'x'])).json).not.toHaveProperty('via')
  expect(await fx.read('direct.md')).toBe('---\ncreated-by: Outside agent\n---\n\nx')
  expect(await inboxNames(fx)).toEqual([])
  app = await openAsApp(fx)
})

// ---- The reply is untrusted: its form, its signature, and how it is printed ----

/** Run a write with nobody answering but `plant`, which is called once with the request's id and puts something in the outbox. */
async function answeredBy(plant: (id: string, outbox: string) => Promise<void>, argv = ['create', 'x.md', '--content', 'x'], more: Record<string, unknown> = {}): Promise<Awaited<ReturnType<WriteFixture['cli']>>> {
  await mkdir(join(fx.root, OUTBOX_DIR), { recursive: true })
  for (const name of await inboxNames(fx)) await rm(join(fx.root, INBOX_DIR, name)) // earlier requests nobody answered
  let planted = false
  const watching = setInterval(() => {
    void inboxNames(fx).then(async (names) => {
      const id = names.map(idOfFileName).find((candidate) => candidate !== null)
      if (!id || planted) return
      planted = true
      await plant(id, join(fx.root, OUTBOX_DIR))
    })
  }, 5)
  try {
    return await fx.cli(argv, { write: { request: { waitMs: 400, pollMs: 10 }, ...more } })
  } finally {
    clearInterval(watching)
  }
}
/**
 * Put a file in place whole, as the app does: under a temporary name, then renamed. The command line
 * looks at the outbox every few milliseconds; a file written in place can be met half-written, and a
 * reply cut short reads as an unreadable one whatever the test meant it to be.
 */
async function placeWhole(path: string, text: string | Uint8Array): Promise<void> {
  const staged = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`)
  await writeFile(staged, text)
  await rename(staged, path)
}
/** A test that waits out the reply time once per case (about four seconds in all) says so, and does not lean on the runner's default. */
const MANY_WAITS_MS = 30_000
const currentKey = async (): Promise<Buffer> => (await readReplyKey(fx.keys, fx.root))!
/** A reply as the app writes it, signed with `key` (default: this Collection's current key); `mac` overrides the signature. */
async function reply(id: string, extra: Record<string, unknown> = {}, key?: Buffer | null): Promise<string> {
  const body: Record<string, unknown> = { version: 1, id, operation: 'create', outcome: 'applied', at: new Date().toISOString(), result: { path: 'x.md' }, text: 'MARKER Created x.md', ...extra }
  for (const name of Object.keys(body)) if (body[name] === undefined) delete body[name]
  if (key !== null && !('mac' in extra)) body.mac = replyMac(key ?? await currentKey(), body)
  return JSON.stringify(body)
}
const put = (text: string | Promise<string>) => async (id: string, outbox: string): Promise<void> => { await placeWhole(join(outbox, `${id}.json`), await text) }

test('a correctly signed reply is accepted, also when the app has let the Collection go before the reply is read', async () => {
  const taken = await answeredBy(async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id)))
  expect(taken.code).toBe(0)
  expect(taken.json).toMatchObject({ ok: true, via: 'app', result: { path: 'x.md' } })
  expect(await outboxNames(fx)).toEqual([])
  // The key was read when the request was sent, so a reply the app signed before closing is still its reply.
  const closed = await answeredBy(async (id, outbox) => {
    const text = await reply(id)
    await app.close()
    await placeWhole(join(outbox, `${id}.json`), text)
  })
  expect(closed.code).toBe(0)
  app = await openAsApp(fx)
})

test('a planted reply that is not exactly a reply to this request is not taken: exit 3, and none of it is printed', async () => {
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-elsewhere-')))
  const cases: Array<[string, (id: string, outbox: string) => Promise<void>]> = [
    ['another id inside', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(`${id.slice(0, -1)}${id.endsWith('0') ? '1' : '0'}`))],
    ['an unknown field', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { author: 'WriteFlex' }))],
    ['an unknown outcome', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { outcome: 'accepted' }))],
    ['an unknown version', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { version: 2 }))],
    ['another operation echoed', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { operation: 'trash' }))],
    ['no operation echoed', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { operation: undefined }))],
    ['a result that is not an object', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { result: 'MARKER' }))],
    ['an oversized body', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { text: `MARKER${'x'.repeat(MAX_REPLY_BYTES)}` }))],
    ['a link to a valid reply', async (id, outbox) => { await writeFile(join(elsewhere, 'reply.json'), await reply(id)); await symlink(join(elsewhere, 'reply.json'), join(outbox, `${id}.json`)) }],
  ]
  try {
    for (const [what, plant] of cases) {
      const result = await answeredBy(plant)
      expect(result.code, what).toBe(3)
      expect(result.json.result, what).toMatchObject({ reply: 'unreadable' })
      expect(result.out, what).not.toContain('MARKER')
      expect(await outboxNames(fx), what).toEqual([]) // removed; a link is removed, not what it points at
    }
    expect(existsSync(join(elsewhere, 'reply.json'))).toBe(true)
    // The same in plain text.
    for (const name of await inboxNames(fx)) await rm(join(fx.root, INBOX_DIR, name))
    let out = ''
    const watching = setInterval(() => { void inboxNames(fx).then((names) => Promise.all(names.map((name) => placeWhole(join(fx.root, OUTBOX_DIR, name), '{"MARKER":1}')))) }, 5)
    const code = await runCli(['--root', fx.root, 'create', 'y.md'], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData], request: { waitMs: 400, pollMs: 10 } } })
    clearInterval(watching)
    expect(code).toBe(3)
    expect(out).toContain('WriteFlex\'s reply could not be read')
    expect(out).not.toContain('MARKER')
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
}, MANY_WAITS_MS)

test('a well-formed reply is taken only if it is signed with this Collection\'s current key', async () => {
  // Another Collection the app also has open: its key is a real key, of the wrong Collection.
  const other = await writeFixture()
  const otherKey = await createReplyKey(fx.keys, other.root)
  const earlier = await currentKey()
  await app.close()
  app = await openAsApp(fx) // a new ownership: the key is replaced
  expect((await currentKey()).equals(earlier)).toBe(false)
  const cases: Array<[string, (id: string, outbox: string) => Promise<void>]> = [
    ['no signature', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, {}, null))],
    ['a wrong signature', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { mac: 'ab'.repeat(32) }))],
    ['a signature that is not one', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { mac: 'MARKER' }))],
    ['a signature made with another Collection\'s key', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, {}, otherKey))],
    ['a reply signed under an earlier ownership, the key since replaced', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, {}, earlier))],
    ['a signed reply changed afterwards', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), (await reply(id)).replace('"path":"x.md"', '"path":"MARKER.md"'))],
    ['a signed refusal with only its outcome changed', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), (await reply(id, { outcome: 'refused', reason: 'MARKER no', result: undefined, text: undefined })).replace('"outcome":"refused"', '"outcome":"applied"'))],
    ['a signed refusal with only its reason changed', async (id, outbox) => placeWhole(join(outbox, `${id}.json`), (await reply(id, { outcome: 'refused', reason: 'no', result: undefined, text: undefined })).replace('"reason":"no"', '"reason":"MARKER"'))],
    ['a signed refusal turned into applied', async (id, outbox) => {
      const refused = JSON.parse(await reply(id, { outcome: 'refused', reason: 'MARKER no', result: undefined, text: undefined })) as Record<string, unknown>
      await placeWhole(join(outbox, `${id}.json`), JSON.stringify({ ...refused, outcome: 'applied', reason: undefined, result: {} }))
    }],
  ]
  try {
    for (const [what, plant] of cases) {
      const result = await answeredBy(plant)
      expect(result.code, what).toBe(3)
      expect(result.json.result, what).toMatchObject({ reply: 'unverified' })
      expect(result.out, what).not.toContain('MARKER')
      expect(await outboxNames(fx), what).toEqual([])
    }
    // In plain text the reason says so.
    for (const name of await inboxNames(fx)) await rm(join(fx.root, INBOX_DIR, name))
    let said = ''
    const forging = setInterval(() => { void inboxNames(fx).then((names) => Promise.all(names.map(async (name) => placeWhole(join(fx.root, OUTBOX_DIR, name), await reply(idOfFileName(name)!, {}, otherKey))))) }, 5)
    expect(await runCli(['--root', fx.root, 'create', 'z.md'], { cwd: tmpdir(), stdout: (t) => { said += t }, stderr: () => {}, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData], request: { waitMs: 300, pollMs: 10 } } })).toBe(3)
    clearInterval(forging)
    expect(said).toContain('could not be verified as written by WriteFlex')
    expect(said).not.toContain('MARKER')
    // A forged reply does not shut the app's own out: it is removed and the wait goes on.
    const both = await answeredBy(async (id, outbox) => {
      await placeWhole(join(outbox, `${id}.json`), await reply(id, { text: 'MARKER forged' }, otherKey))
      setTimeout(() => { void reply(id, { text: 'the app\'s own' }).then((text) => placeWhole(join(outbox, `${id}.json`), text)) }, 100)
    })
    expect(both.code).toBe(0)
    expect(both.out).not.toContain('MARKER')
  } finally {
    await other.dispose()
  }
}, MANY_WAITS_MS)

test('a key that is a link, or readable by others, is no key: nothing is sent and the command says the app could not be verified', async () => {
  const elsewhere = realpathSync(await mkdtemp(join(tmpdir(), 'wf-cli-elsewhere-')))
  const keyFile = replyKeyPath(fx.keys, fx.root)
  const key = await currentKey()
  const before = await fx.snapshot({ journal: true })
  const unusable: Array<[string, () => Promise<void>, () => Promise<void>]> = [
    ['the key file is a link to the key', async () => { await rename(keyFile, join(elsewhere, 'key')); await symlink(join(elsewhere, 'key'), keyFile) }, async () => { await rm(keyFile); await rename(join(elsewhere, 'key'), keyFile) }],
    ['the key file is readable by others', () => chmod(keyFile, 0o644), () => chmod(keyFile, 0o600)],
    ['the key file is writable by the group', () => chmod(keyFile, 0o620), () => chmod(keyFile, 0o600)],
    ['the key folder is open to others', () => chmod(fx.keys, 0o755), () => chmod(fx.keys, 0o700)],
    ['the key folder is a link', async () => { await rename(fx.keys, join(elsewhere, 'keys')); await symlink(join(elsewhere, 'keys'), fx.keys) }, async () => { await rm(fx.keys); await rename(join(elsewhere, 'keys'), fx.keys) }],
    ['the key is not 32 bytes', () => writeFile(keyFile, key.subarray(0, 16)), async () => { await writeFile(keyFile, key); await chmod(keyFile, 0o600) }],
    ['there is no key', () => rm(keyFile), async () => { await writeFile(keyFile, key, { mode: 0o600 }) }],
  ]
  try {
    for (const [what, spoil, restore] of unusable) {
      await spoil()
      try {
        // A reply signed with the very key stands ready for any request: it must make no difference.
        const refused = await answeredBy(async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, {}, key)))
        expect(refused.code, what).toBe(1)
        expect(refused.json.error, what).toMatchObject({ code: 'owner-not-verified' })
        expect(refused.json.error!.message, what).toContain('appears to have this Collection open, but that could not be verified')
        expect(refused.json.error!.message, what).toContain('nothing was sent and nothing was changed')
        expect(await inboxNames(fx), what).toEqual([])
      } finally {
        await restore()
      }
    }
    expect(await fx.snapshot({ journal: true })).toEqual(before)
    expect((await answeredBy(async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id)))).code).toBe(0)
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
})

test('a forged lock with a planted reply spoofs nothing: no request, no direct write, and words on how to proceed', async () => {
  // No app at all. Something that can write the Collection writes a lock naming a live app, and a reply.
  await app.close()
  const forged = await acquireOwnerLock(fx.root, { kind: 'app' })
  const before = await fx.snapshot({ journal: true })
  await mkdir(join(fx.root, OUTBOX_DIR), { recursive: true })
  const planting = setInterval(() => {
    void inboxNames(fx).then((names) => Promise.all(names.map(async (name) => placeWhole(join(fx.root, OUTBOX_DIR, name), await reply(idOfFileName(name)!, { text: 'MARKER applied' }, Buffer.alloc(32, 7))))))
  }, 5)
  try {
    const result = await fx.cli(['create', 'x.md', '--content', 'x'], { write: { request: { waitMs: 300, pollMs: 10 } } })
    expect(result.code).toBe(1)
    expect(result.out).not.toContain('MARKER')
    expect(result.json.error!.message).toContain('appears to have this Collection open, but that could not be verified')
    expect(result.json.error!.message).toContain('clears by itself within two minutes')
    // Not sent, and not written directly either while a lock claims a live owner.
    expect(existsSync(join(fx.root, 'x.md'))).toBe(false)
    expect(await fx.snapshot({ journal: true })).toEqual(before)
    // A lock naming WriteFlex on another computer reads differently, and is not overridden either.
    await releaseOwnerLock(forged)
    const remote = await acquireOwnerLock(fx.root, { kind: 'app', host: 'another-mac', pidIsAlive: () => true })
    const far = await fx.cli(['create', 'x.md', '--content', 'x'], { write: { request: { waitMs: 300, pollMs: 10 } } })
    await releaseOwnerLock(remote)
    expect(far.code).toBe(1)
    expect(far.json.error!.message).toContain('WriteFlex on another computer ("another-mac")')
    expect(existsSync(join(fx.root, 'x.md'))).toBe(false)
  } finally {
    clearInterval(planting)
    app = await openAsApp(fx)
  }
})

test('the app makes the key when it takes a Collection, replaces it on the next taking, and removes it on letting go', async () => {
  const other = await writeFixture()
  const folder = join(other.keys, '..', 'made-by-ownership')
  const ownership = new CollectionOwnership({ keyFolder: folder })
  try {
    expect(await ownership.claim(other.root)).toBe('owned')
    const first = (await readReplyKey(folder, other.root))!
    expect(first).toHaveLength(32)
    expect((await stat(folder)).mode & 0o777).toBe(0o700)
    expect((await stat(replyKeyPath(folder, other.root))).mode & 0o777).toBe(0o600)
    expect(replyKeyPath(folder, other.root).startsWith(other.root)).toBe(false)
    expect((await readdir(folder)).filter((name) => name.endsWith('.tmp'))).toEqual([])
    await ownership.release(other.root)
    expect(await readReplyKey(folder, other.root)).toBeNull()
    expect(await ownership.claim(other.root)).toBe('owned')
    expect((await readReplyKey(folder, other.root))!.equals(first)).toBe(false)
  } finally {
    await ownership.releaseAll()
    await other.dispose()
  }
})

// ---- What is printed: hidden characters are shown, never removed ----

const plain = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
  let out = ''
  let err = ''
  const code = await runCli(['--root', fx.root, ...argv], { cwd: tmpdir(), stdout: (t) => { out += t }, stderr: (t) => { err += t }, write: { keyFolders: [fx.keys], appDataFolders: [fx.appData] } })
  return { code, out, err }
}
const RAW = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e\ufdd0-\ufdd2]/

test('hidden characters in a reply are shown, not sent to the terminal and not dropped; a long reason says how much was cut', async () => {
  const hostile = 'Refused\u001b[2J\u001b[1;1H then\rApplied\u009b31m\u202e ok\u0000'
  const refused = await answeredBy(async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { outcome: 'refused', reason: hostile, result: undefined, text: undefined })))
  expect(refused.code).toBe(1)
  expect(refused.json.error!.message).toBe('Refused\\u{1b}[2J\\u{1b}[1;1H then\\u{d}Applied\\u{9b}31m\\u{202e} ok\\u{0}')
  expect(unshow(refused.json.error!.message)).toBe(hostile)
  expect(refused.out).not.toMatch(RAW)

  // A result is data: it arrives exactly as the app sent it, and is printed with nothing raw.
  const result = { path: 'x\u001b[31m.md', list: ['deep\u009b2J'] }
  const applied = await answeredBy(async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { result, text: 'Created\u001b[2K x.md' })))
  expect(applied.code).toBe(0)
  expect(applied.json.result).toEqual(result)
  expect(applied.out).not.toMatch(RAW)

  const long = await answeredBy(async (id, outbox) => placeWhole(join(outbox, `${id}.json`), await reply(id, { outcome: 'refused', reason: `${'r'.repeat(8192)}${'s'.repeat(700)}`, result: undefined, text: undefined })))
  expect(long.json.error!.message).toBe(`${'r'.repeat(8192)}… [700 more characters not shown]`)
})

test('two file names that differ only in a hidden character print differently, and each printed name is the name JSON carries', async () => {
  const names = [
    'talks/ab.md', 'talks/a\u0007b.md', 'talks/a\u001bb.md', 'talks/a\u009bb.md', 'talks/a\u202eb.md',
    // The text of an escape, spelt out with a real backslash, against the character itself.
    'talks/x\\u{1b}.md', 'talks/x\u001b.md', 'talks/x\\u{5c}u{1b}.md',
    // A line break and a tab inside a name are not rows and columns.
    'talks/line\nbreak.md', 'talks/tab\there.md',
  ]
  for (const name of names) await fx.write(name, '# Named\n')
  const listed = await plain(['files'])
  expect(listed.code).toBe(0)
  expect(listed.out + listed.err).not.toMatch(RAW)
  const lines = listed.out.trimEnd().split('\n')
  for (const [name, printed] of [
    ['talks/a\u0007b.md', 'talks/a\\u{7}b.md'], ['talks/a\u001bb.md', 'talks/a\\u{1b}b.md'], ['talks/x\u001b.md', 'talks/x\\u{1b}.md'],
    ['talks/x\\u{1b}.md', 'talks/x\\u{5c}u{1b}.md'], ['talks/x\\u{5c}u{1b}.md', 'talks/x\\u{5c}u{5c}u{1b}.md'],
    ['talks/line\nbreak.md', 'talks/line\\u{a}break.md'], ['talks/tab\there.md', 'talks/tab\\u{9}here.md'], ['talks/ab.md', 'talks/ab.md'],
  ]) {
    expect(lines, name).toContain(printed)
    expect(unshow(printed), name).toBe(name)
  }
  // No two names print the same, and every printed line, unescaped by the rule, is a name JSON carries.
  const json = await fx.cli(['files'])
  expect(json.out).not.toMatch(RAW)
  const carried = [...(json.json.result!.folders as string[]).map((folder) => `${folder}/`), ...(json.json.result!.files as Array<{ path: string }>).map((file) => file.path)]
  expect(new Set(lines).size).toBe(lines.length)
  expect(lines.map(unshow).sort()).toEqual([...carried].sort())
  for (const name of names) expect(carried, name).toContain(name)
  // The rule is in help, in one line.
  expect((await plain(['help'])).out).toContain('shown as \\u{hex}')
})

test('a path argument is taken literally: the escaped form is not decoded, and the command says so', async () => {
  await fx.write('talks/x\u001b.md', '# The real character\n')
  // What plain text printed for that file, passed back as it was printed.
  const printed = 'talks/x\\u{1b}.md'
  const missing = await plain(['read', printed])
  expect(missing.code).toBe(1)
  expect(missing.err).toContain('It was taken literally')
  const asJson = await fx.cli(['read', printed])
  expect(asJson.code).toBe(1)
  expect((asJson.json as unknown as { notes: string[] }).notes[0]).toContain('It was taken literally')
  // It is never decoded into the file with the real character, whose text is not what comes back.
  expect(missing.out + asJson.out).not.toContain('The real character')
  // (A file really named with those characters has a backslash in its name, and the Workspace's own
  // path rule, older than this ticket, refuses any path with a backslash: it is listed but cannot be read.)
  await fx.write(printed, '# Spelt out\n')
  const literal = await plain(['read', printed])
  expect(literal.code).toBe(1)
  expect(literal.out).not.toContain('The real character')
  expect(literal.err).toContain('It was taken literally')
  // The exact name, from JSON, reads the file with the real character; no note.
  const exact = await plain(['read', 'talks/x\u001b.md'])
  expect(exact.out).toBe('# The real character\n')
  expect(exact.err).not.toContain('note:')
  // A document's own text from `read` is printed as it is, so that it can be piped; under --json it is the same text, JSON-escaped.
  await fx.write('raw.md', 'one\r\ntwo\u001b[0m\n')
  expect((await plain(['read', 'raw.md'])).out).toBe('one\r\ntwo\u001b[0m\n')
  expect((await fx.cli(['read', 'raw.md'])).json.result!.content).toBe('one\r\ntwo\u001b[0m\n')
  // A refusal that names a path shows it.
  const refused = await plain(['read', 'talks/missing\u001b[2J.md'])
  expect(refused.code).toBe(1)
  expect(refused.err).not.toMatch(RAW)
  expect(refused.err).toContain('missing\\u{1b}[2J.md')
})


test('CLI scraps asks the owning app for live placements and shows dead-holder candidates after it closes', async () => {
  configureScratchpadHolders((root) => root === fx.root ? [1] : [])
  const store = new ScratchpadStore(new Workspace(fx.root), null)
  const item = await store.addText({ origin: 'notes.md', markdown: 'Placed cutting.', how: 'copy', by: 'writer' })
  await store.confirmCut(item.id)
  await store.recordUse(item.id, { useId: 'u_clilive1', path: 'notes.md', mode: 'put-back', holder: scratchpadHolder(1) })
  const stop = app.answering()
  try {
    const listed = await fx.cli(['scraps'])
    expect(listed.code).toBe(0)
    expect(listed.json.via).toBe('app')
    expect(listed.json.result).toMatchObject({ scraps: [] })
    expect(await fx.journalNames()).toEqual([])
  } finally { await stop() }
  await app.close()
  configureScratchpadHolders(() => [])
  const closed = await fx.cli(['scraps'])
  expect(closed.code).toBe(0)
  expect(closed.json).not.toHaveProperty('via')
  expect((closed.json.result!.scraps as Array<{ id: string }>).map((s) => s.id)).toEqual([item.id])
})
