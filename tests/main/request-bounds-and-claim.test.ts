/**
 * Review parcel P5. Two things:
 *  - BOUNDS: one look at a folder a Collection controls takes at most MAX_ENTRIES_LISTED directory
 *    entries, whatever the folder holds, and what is remembered from look to look is kept to a count;
 *  - THE CLAIM: the app renames a request to `<id>.json.taken` before it reads it, so `withdraw`
 *    never says "will not be shown" for a request the app has read.
 * Nothing here waits on a clock: each race is arranged through the executor's `beforeRead` seam.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChangeStore, closedCodeOf, type Change } from '../../src/main/changes'
import { outsideRequestOf } from '../../src/main/outside-change'
import { holdFolder, keepUpTo, rememberUpTo } from '../../src/main/cli/request-files'
import { INBOX_DIR, OUTBOX_DIR, claimedFileName, idOfClaimedName, looksLikeConflictCopy, newRequestId } from '../../src/main/cli/request-format'
import { MAX_ENTRIES_LISTED, MAX_NAMES_REMEMBERED, MAX_REQUESTS_PER_PASS } from '../../src/main/cli/review-format'
import { STALE_TEMPORARY_MS, removeStaleTemporaryFiles } from '../../src/main/cli/stale-temporary-files'
import { InboxClaims } from '../../src/main/request-claims'
import { STALE_FILE_MS, type RequestExecutorOptions } from '../../src/main/request-executor'
import { ToldOnce } from '../../src/main/request-inbox-watch'
import { Workspace } from '../../src/main/workspace'
import { createdBy, writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { inboxNames, openAsApp, plantRequest, replyTo, type AppSide } from '../helpers/request-app'

let fx: WriteFixture
let app: AppSide | undefined
beforeEach(async () => {
  fx = await writeFixture()
  app = undefined
})
afterEach(async () => {
  await app?.close()
  await fx.dispose()
})

const open = async (options: Partial<RequestExecutorOptions> = {}): Promise<AppSide> => (app = await openAsApp(fx, { changes: new ChangeStore(new Workspace(fx.root)), ...options }))
const ledgerIds = async (): Promise<Array<string | undefined>> => (await new ChangeStore(new Workspace(fx.root)).list()).map((change) => outsideRequestOf(change)?.id)
const INSERT = (text: string) => ({ path: 'notes.md', text, source: 'claude-code' })
/** Many small files in one folder of the Collection, written a few hundred at a time. */
async function fill(dir: string, names: string[], at?: Date): Promise<void> {
  await mkdir(join(fx.root, dir), { recursive: true })
  for (let from = 0; from < names.length; from += 250) {
    await Promise.all(names.slice(from, from + 250).map(async (name) => {
      await writeFile(join(fx.root, dir, name), '{}')
      if (at) await utimes(join(fx.root, dir, name), at, at)
    }))
  }
}
const numbered = (count: number, name: (index: number) => string): string[] => Array.from({ length: count }, (_, index) => name(index))

// ── Bounds ──────────────────────────────────────────────────────────────────────────────────────

test('an inbox of 10,000 stray names: one look takes at most the listing limit of them, says the listing was cut, and never grows what it remembers', async () => {
  const side = await open()
  await fill(INBOX_DIR, numbered(10_000, (index) => `stray-${String(index).padStart(5, '0')}.bin`))
  const look = await side.executor.drain()
  expect(look.cut).toEqual(['inbox'])
  expect(look.ignored.length).toBe(MAX_ENTRIES_LISTED)
  expect(look.handled).toEqual([])
  // Nothing was removed or renamed: stray files are not the app's.
  expect((await readdir(join(fx.root, INBOX_DIR))).length).toBe(10_000)
  // The watch tells each ignored name once and keeps at most so many names, however many looks meet however many names.
  const told = new ToldOnce()
  for (let round = 0; round < 3; round += 1) for (const ignored of look.ignored) told.first(`ignored:${round}:${ignored.name}`)
  expect(told.size).toBe(MAX_NAMES_REMEMBERED)
  expect(side.executor.remembered).toEqual({ repeated: 0, deferred: 0 })
}, 120_000)

test('what is told once is kept to a count, the oldest forgotten first; a name still remembered is not told again', () => {
  const told = new ToldOnce(3)
  expect(['a', 'b', 'c', 'a', 'b'].map((key) => told.first(key))).toEqual([true, true, true, false, false])
  expect(told.first('d')).toBe(true) // forgets the oldest, a
  expect(told.size).toBe(3)
  expect(told.first('c')).toBe(false)
  expect(told.first('a')).toBe(true)
  const set = new Set<number>()
  for (let value = 0; value < 10_000; value += 1) rememberUpTo(set, value, 5)
  expect([...set]).toEqual([9995, 9996, 9997, 9998, 9999])
  const map = new Map<string, number>()
  for (let value = 0; value < 10_000; value += 1) keepUpTo(map, `k${value}`, value, 5)
  expect([...map.keys()]).toEqual(['k9995', 'k9996', 'k9997', 'k9998', 'k9999'])
})

test('requests answered again from their record are remembered up to a count, however many are met', async () => {
  const side = await open()
  await mkdir(fx.handledDir, { recursive: true, mode: 0o700 })
  // Three inboxes' worth of requests that each have a receipt and a file that cannot be removed (a
  // folder stands at the name), so each is remembered as answered again: more than is ever kept.
  const perRound = Math.ceil(MAX_NAMES_REMEMBERED / 3) + 100
  let met = 0
  for (let round = 0; round < 3; round += 1) {
    const ids = numbered(perRound, (index) => newRequestId(new Date(Date.UTC(2026, round, 1) + index * 1000)))
    for (let from = 0; from < ids.length; from += 250) {
      await Promise.all(ids.slice(from, from + 250).map(async (id) => {
        await writeFile(join(fx.handledDir, `${id}.json`), JSON.stringify({ version: 1, id, at: new Date().toISOString() }))
        await mkdir(join(fx.root, INBOX_DIR, `${id}.json`), { recursive: true })
      }))
    }
    for (let looks = 0; looks < Math.ceil(perRound / MAX_REQUESTS_PER_PASS); looks += 1) {
      met += (await side.executor.drain()).handled.length
      expect(side.executor.remembered.repeated).toBeLessThanOrEqual(MAX_NAMES_REMEMBERED)
    }
    await rm(join(fx.root, INBOX_DIR), { recursive: true, force: true })
  }
  expect(met).toBeGreaterThan(MAX_NAMES_REMEMBERED)
  expect(side.executor.remembered.repeated).toBe(MAX_NAMES_REMEMBERED)
}, 240_000)

test('clearing the outbox is bounded too: a look removes what is stale among the entries it lists, says the listing was cut, and the next look goes on', async () => {
  const side = await open()
  const old = new Date(Date.now() - STALE_FILE_MS - 60_000)
  const replies = numbered(MAX_ENTRIES_LISTED + 300, (index) => `${newRequestId(new Date(Date.UTC(2026, 0, 1) + index * 1000))}.json`)
  await fill(OUTBOX_DIR, replies, old)
  const first = await side.executor.drain()
  expect(first.cut).toEqual(['outbox'])
  expect((await readdir(join(fx.root, OUTBOX_DIR))).length).toBe(300)
  const second = await side.executor.drain()
  expect(second.cut).toBeUndefined()
  expect(await readdir(join(fx.root, OUTBOX_DIR))).toEqual([])
}, 120_000)

test('the stale-temporary sweep lists the inbox up to the limit: what is stale beyond it goes at the next run', async () => {
  const old = new Date(Date.now() - STALE_TEMPORARY_MS - 60_000)
  const stale = numbered(MAX_ENTRIES_LISTED + 120, (index) => `.${newRequestId(new Date(Date.UTC(2026, 0, 1) + index * 1000))}.json.0a1b2c3d.tmp`)
  await fill(INBOX_DIR, stale, old)
  expect((await removeStaleTemporaryFiles(fx.root)).length).toBe(MAX_ENTRIES_LISTED)
  expect((await removeStaleTemporaryFiles(fx.root)).length).toBe(120)
  expect(await readdir(join(fx.root, INBOX_DIR))).toEqual([])
}, 120_000)

// ── The claim before read ───────────────────────────────────────────────────────────────────────

test('withdraw racing a look: a request the app has already read is reported as being added, never as "will not be shown", and it is added', async () => {
  const older = await plantRequest(fx, 'insert', INSERT('Read first.'), { id: newRequestId(new Date(Date.now() - 2000)) })
  const newer = await plantRequest(fx, 'insert', INSERT('Read second.'), { id: newRequestId(new Date(Date.now() - 1000)) })
  let withdrawn: Awaited<ReturnType<WriteFixture['cli']>> | undefined
  let listed: Awaited<ReturnType<WriteFixture['cli']>> | undefined
  let names: string[] = []
  const side = await open({ seams: { beforeRead: async (id) => {
    // The older request is read and held for the ledger; the app is about to read the newer one.
    if (id !== newer) return
    names = await inboxNames(fx)
    listed = await fx.cli(['waiting'])
    withdrawn = await fx.cli(['withdraw', older])
  } } })
  await side.executor.drain()
  expect(names).toEqual([claimedFileName(older), `${newer}.json`])
  expect(withdrawn!.code).toBe(1)
  expect(withdrawn!.json.error!.message).toBe(
    `Request ${older} is being added to WriteFlex's review dock now, so it was not withdrawn. Reject it in WriteFlex. `
    + `(If it does not appear there, WriteFlex left it for later: run "writeflex withdraw ${older}" again.)`,
  )
  expect(withdrawn!.json.error!.message).not.toContain('will not be shown')
  // `waiting` shows a claimed request as being added, and an unclaimed one as before.
  expect(listed!.json.result!.waiting).toMatchObject([{ id: older, beingAdded: true }, { id: newer }])
  expect((listed!.json.result!.waiting as Array<{ beingAdded?: true }>)[1].beingAdded).toBeUndefined()
  // Both were added, and neither file is left under either name.
  expect((await ledgerIds()).sort()).toEqual([older, newer])
  expect(await inboxNames(fx)).toEqual([])
})

test('withdraw before the app reads it wins: the file is gone, the app finds nothing to claim, and nothing is added', async () => {
  const id = await plantRequest(fx, 'insert', INSERT('Taken back in time.'))
  let withdrawn: Awaited<ReturnType<WriteFixture['cli']>> | undefined
  const side = await open({ seams: { beforeRead: async () => { withdrawn = await fx.cli(['withdraw', id]) } } })
  await side.executor.drain()
  expect(withdrawn!.json).toMatchObject({ outcome: 'done', result: { withdrawn: true, request: id } })
  expect(await ledgerIds()).toEqual([])
  expect(await inboxNames(fx)).toEqual([])
})

test('a request the app leaves for a later look is given its own name back, and can then be withdrawn', async () => {
  const id = await plantRequest(fx, 'insert', INSERT('Not addable yet.'))
  const side = await open()
  side.owns.value = false // the app does not hold the Collection: a shown-first request waits
  const look = await side.executor.drain()
  expect(look.review).toMatchObject({ left: 1, leftBecause: ['not-held'] })
  expect(await inboxNames(fx)).toEqual([`${id}.json`])
  expect((await fx.cli(['waiting'])).json.result!.waiting).toEqual([expect.not.objectContaining({ beingAdded: true })])
  expect((await fx.cli(['withdraw', id])).json).toMatchObject({ outcome: 'done', result: { withdrawn: true } })
})

test('a request standing under both names (the app stopped with it claimed, and it arrived again) is not reported as withdrawn', async () => {
  const id = newRequestId()
  await plantRequest(fx, 'insert', INSERT('Twice here.'), { id, name: claimedFileName(id) })
  await plantRequest(fx, 'insert', INSERT('Twice here.'), { id })
  const withdrawn = await fx.cli(['withdraw', id])
  expect(withdrawn.code).toBe(1)
  expect(withdrawn.json.error!.message).toContain('is being added to WriteFlex\'s review dock now')
  const side = await open()
  await side.executor.drain()
  expect(await ledgerIds()).toEqual([id])
  expect(await inboxNames(fx)).toEqual([])
})

test('the app stopped with a shown-first request claimed: the next look takes it up from its claimed name and adds it once', async () => {
  const id = newRequestId()
  // What an app that stopped between claiming and adding leaves: the request under its claimed name only.
  await plantRequest(fx, 'insert', INSERT('Claimed, then the app stopped.'), { id, name: claimedFileName(id) })
  expect((await fx.cli(['waiting'])).json.result!.waiting).toMatchObject([{ id, beingAdded: true }])
  expect((await fx.cli(['withdraw', id])).json.error!.message).toContain('is being added to WriteFlex\'s review dock now')
  const side = await open()
  await side.executor.drain()
  expect(await ledgerIds()).toEqual([id])
  expect(await inboxNames(fx)).toEqual([])
  // Sync brings the same request back under its own name: the ledger already has it, and it is not added twice.
  await plantRequest(fx, 'insert', INSERT('Claimed, then the app stopped.'), { id })
  await side.restarted().drain()
  expect(await ledgerIds()).toEqual([id])
  expect(await inboxNames(fx)).toEqual([])
})

test('the app stopped with a direct request claimed: it is acted on at most once, and the receipt in application data decides', async () => {
  // Claimed and never begun (no receipt): the next look carries it out, once.
  const fresh = newRequestId(new Date(Date.now() - 2000))
  await plantRequest(fx, 'create-folder', { path: 'made-once' }, { id: fresh, name: claimedFileName(fresh) })
  // Claimed and begun (a receipt with no reply): never carried out again, whatever the file says.
  const begun = newRequestId(new Date(Date.now() - 1000))
  await plantRequest(fx, 'create-folder', { path: 'never-made' }, { id: begun, name: claimedFileName(begun) })
  await mkdir(fx.handledDir, { recursive: true, mode: 0o700 })
  await writeFile(join(fx.handledDir, `${begun}.json`), JSON.stringify({ version: 1, id: begun, at: new Date().toISOString() }))
  const side = await open()
  const look = await side.executor.drain()
  expect(look.handled).toMatchObject([{ id: fresh, outcome: 'applied', repeat: false }, { id: begun, outcome: 'refused', repeat: true }])
  expect(look.ignored).toEqual([]) // a claimed name is a request's, not a stray file or a conflict copy
  expect(existsSync(join(fx.root, 'made-once'))).toBe(true)
  expect(existsSync(join(fx.root, 'never-made'))).toBe(false)
  expect((await replyTo(fx, begun)).reason).toContain('WriteFlex stopped while it was carrying out this request')
  expect(await inboxNames(fx)).toEqual([])
  // Met again under either name, each is answered from its receipt and not carried out.
  await plantRequest(fx, 'create-folder', { path: 'made-twice' }, { id: fresh, name: claimedFileName(fresh) })
  expect((await side.restarted().drain()).handled).toMatchObject([{ id: fresh, repeat: true }])
  expect(existsSync(join(fx.root, 'made-twice'))).toBe(false)
  expect(await inboxNames(fx)).toEqual([])
})

test('a claimed name is told from a conflict copy, and a request that cannot be claimed is refused unread', async () => {
  const id = newRequestId()
  expect(idOfClaimedName(claimedFileName(id))).toBe(id)
  expect(idOfClaimedName(`${id}.json`)).toBeNull()
  expect(idOfClaimedName(`${id} (conflicted copy).json.taken`)).toBeNull()
  expect(looksLikeConflictCopy(claimedFileName(id))).toBe(false)
  // A folder planted at the claimed name: the rename is refused, the request is answered and cleared, nothing is done.
  await plantRequest(fx, 'create-folder', { path: 'not-made' }, { id })
  await mkdir(join(fx.root, INBOX_DIR, claimedFileName(id)))
  const side = await open()
  const look = await side.executor.drain()
  expect(look.handled).toMatchObject([{ id, outcome: 'refused' }])
  expect(look.handled[0].reason).toContain('could not be taken up to be read')
  expect(existsSync(join(fx.root, 'not-made'))).toBe(false)
  expect(existsSync(join(fx.root, INBOX_DIR, `${id}.json`))).toBe(false)
})

test('only one of a claim and a removal happens to a request file', async () => {
  const id = newRequestId()
  await plantRequest(fx, 'insert', INSERT('x'), { id })
  const inbox = (await holdFolder(fx.root, INBOX_DIR, false))!
  try {
    const claims = new InboxClaims(inbox)
    expect((await claims.take(id, 1000)).kind).toBe('text')
    expect(await inbox.remove(`${id}.json`)).toBe(false) // what withdraw is told: not removed by it
    await claims.giveBack()
    expect(await inboxNames(fx)).toEqual([`${id}.json`])
    expect(await inbox.remove(`${id}.json`)).toBe(true)
    expect((await claims.take(id, 1000)).kind).toBe('missing')
    await claims.giveBack()
    expect(await inboxNames(fx)).toEqual([])
  } finally {
    await inbox.close()
  }
})

// ── A proposal follows a move made later in the same look (second-review parcel P11) ─────────────

/** Request ids made in the order given, a second apart, so one look reads them oldest first. */
const inOrder = (count: number): string[] => Array.from({ length: count }, (_, index) => newRequestId(new Date(Date.now() - (count - index) * 1000)))
const ledger = async (): Promise<Change[]> => new ChangeStore(new Workspace(fx.root)).list()

test('a proposal read in a look, then its document moved by a later request of the same look: it is added against the new path', async () => {
  const [insert, move] = inOrder(2)
  await plantRequest(fx, 'insert', INSERT('Follow me.'), { id: insert })
  await plantRequest(fx, 'move', { path: 'notes.md', to: 'moved.md' }, { id: move })
  const side = await open()
  const drained = await side.executor.drain()
  // The insertion is read and set aside first; the move is then carried out; then the proposal is added.
  expect(drained.handled).toEqual([{ id: move, outcome: 'applied', operation: 'move', repeat: false }])
  const changes = (await ledger()).filter((change) => outsideRequestOf(change)?.id === insert)
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ path: 'moved.md', status: 'pending' })
  expect(closedCodeOf(changes[0])).toBe('other') // not closed: no closed code recorded
  expect((changes[0] as { closedReason?: unknown }).closedReason).toBeUndefined()
  expect(await inboxNames(fx)).toEqual([])
})

test('a proposal whose document is moved and then removed in the same look is closed as file-missing, never added to a new document at the old path', async () => {
  const [insert, move, trash, create] = inOrder(4)
  await plantRequest(fx, 'insert', INSERT('Meant for the old notes.'), { id: insert })
  await plantRequest(fx, 'move', { path: 'notes.md', to: 'moved.md' }, { id: move })
  await plantRequest(fx, 'trash', { path: 'moved.md' }, { id: trash })
  await plantRequest(fx, 'create', { path: 'notes', content: '# A different document\n' }, { id: create })
  const side = await open()
  const drained = await side.executor.drain()
  expect(drained.handled.map((handled) => [handled.id, handled.outcome])).toEqual([[move, 'applied'], [trash, 'applied'], [create, 'applied']])
  const changes = (await ledger()).filter((change) => outsideRequestOf(change)?.id === insert)
  expect(changes).toHaveLength(1)
  expect(changes[0].path).toBe('moved.md')
  expect(changes[0].status).toBe('rejected')
  expect(closedCodeOf(changes[0])).toBe('file-missing')
  // Nothing of the proposal stands against the new document at the old path.
  expect((await ledger()).filter((change) => change.path === 'notes.md')).toEqual([])
  expect(await fx.read('notes.md')).toBe(createdBy('# A different document\n'))
})
