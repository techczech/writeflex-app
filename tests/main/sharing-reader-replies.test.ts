// 0.24 ticket 08: readers hear back. Seams: the outcome sender against the fake sharing service (every
// outcome kind and the replies reach the reader's own notes; retried while the service cannot be
// reached, a reply sent once; only notes from that share, with its owner token, and nothing else from
// the Collection), the ledger's reply door (plain text, a reader's record only, never a decision and
// never a write to a piece). Spec 4.4, 6.2 "Outcome recorded", 9 "Hearing back"; section 5 rule 1.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as service from '../../sharing-service/index.ts'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore, isReaderReply, READER_REPLIES_MOST, type Change } from '../../src/main/changes'
import { readerNoteOf } from '../../src/main/outside-change-fields'
import { createServiceClient } from '../../src/main/sharing-client'
import { registerSharingIpc } from '../../src/main/sharing-ipc'
import type { SharingSetup } from '../../src/main/sharing-setup'
import { repliesNeedServiceUpdate, setReaderNotesSource, startReaderNotesCollection } from '../../src/main/sharing-reader-notes-run'
import { collectReaderNotes, guardedDocumentReader, type ReaderLinkSource } from '../../src/main/sharing-reader-notes'
import { LEGACY_ANSWERS_AT_MOST, LEGACY_RETRY_MS, owedFor, readerOutcomeOf, readerReplyFor, sendReaderOutcomes, type LegacyAnswers, type OutcomeItem, type ReaderRepliesPorts } from '../../src/main/sharing-reader-replies'
import { Workspace } from '../../src/main/workspace'
import { ADMIN_KEY, ORIGIN, fakeService, type ServiceModule } from '../helpers/sharing-service-runtime.ts'

import {fakeBearer} from '../helpers/fake-auth'

const PIECE = 'reading-list.md'
const DOC = '# What a reading list is for\n\nMost reading lists are written as if the reader will finish them. They are long, they are ordered by when the author found each item.\n\nA list owes its reader a reason for each entry. One line is enough.\n'
const TEXT = 'Most reading lists are written as if the reader will finish them. They are long, they are ordered by when the author found each item. A list owes its reader a reason for each entry. One line is enough.'

let roots: string[] = []
let agents: WorkspaceAgent[] = []
beforeEach(() => { roots = []; agents = [] })
afterEach(async () => {
  for (const agent of agents) agent.dispose()
  for (const dir of roots) await rm(dir, { recursive: true, force: true })
})

async function collection() {
  const root = await mkdtemp(join(tmpdir(), 'wf-reader-replies-'))
  roots.push(root)
  await writeFile(join(root, PIECE), DOC)
  const workspace = new Workspace(root)
  return { root, workspace, changes: new ChangeStore(workspace) }
}

async function withAgent(c: Awaited<ReturnType<typeof collection>>) {
  const appData = await mkdtemp(join(tmpdir(), 'wf-reader-replies-data-'))
  roots.push(appData)
  const agent = await WorkspaceAgent.create({ mode: 'work', workspace: c.workspace, appDataDir: appData, changes: c.changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
  agents.push(agent)
  return agent
}

/** A published share on the fake service; readers post through the page's own route and read their own notes back. */
async function sharedPiece(svc = fakeService(service as unknown as ServiceModule), label = 'For Marta') {
  const made = await svc.call('/shares', { method: 'POST', headers: { authorization: fakeBearer(ADMIN_KEY) } })
  const { shareId, ownerToken } = await made.json() as { shareId: string; ownerToken: string }
  expect((await svc.call(`/shares/${shareId}/page`, {
    method: 'PUT', headers: { authorization: fakeBearer(ownerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, savedAt: Date.now(), sharedBy: 'Dominik', comments: true, kind: 'piece', title: 'What a reading list is for', parts: [{ html: `<p>${TEXT}</p>` }], images: [] }),
  })).status).toBe(200)
  const marta = randomBytes(32).toString('base64url')
  const post = async (note: Record<string, unknown>, who = marta) => {
    const id = randomBytes(12).toString('base64url')
    const sent = await svc.call(`/s/${shareId}/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ reader: who, note: { id, writtenAt: Date.now(), revision: 1, ...note } }),
    })
    expect(sent.status).toBe(201)
    return id
  }
  const mine = async (who = marta) => ((await (await svc.call(`/s/${shareId}/notes/mine`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: who }) })).json()) as { notes: Array<{ id: string; status: string; outcomeAt: number | null; replies: Array<{ id: string; text: string }> }> }).notes
  const client = createServiceClient({ fetch: (input, init) => svc.call(new URL(String(input)).pathname, init) })
  const link: ReaderLinkSource = { shareId, label, paths: [PIECE], base: ORIGIN, owner: ownerToken }
  return { svc, shareId, ownerToken, post, mine, client, link, marta }
}

type Piece = Awaited<ReturnType<typeof sharedPiece>>

async function collect(c: Awaited<ReturnType<typeof collection>>, s: Piece) {
  await collectReaderNotes({ fetchNotes: (b, id, o) => s.client.notes(b, id, o), markCollected: (b, id, o, k) => s.client.collected(b, id, o, k), readDocument: guardedDocumentReader(c.workspace), changes: c.changes, now: Date.now }, [s.link])
}

/** The sender's ports, recording every request it makes. */
function sender(c: { changes: ChangeStore }, s: Piece, over: Partial<ReaderRepliesPorts> = {}) {
  const requests: Array<{ base: string; shareId: string; owner: string; items: OutcomeItem[] }> = []
  const ports: ReaderRepliesPorts = {
    sendOutcomes: async (base, shareId, owner, items) => { requests.push({ base, shareId, owner, items: JSON.parse(JSON.stringify(items)) }); return s.client.outcomes(base, shareId, owner, items) },
    changes: c.changes,
    now: () => Date.now(),
    ...over,
  }
  return { ports, requests }
}

const NOTE = { kind: 'note', name: 'Marta', text: 'Which kind of book do you mean?', anchor: { quote: 'they are ordered', before: 'They are long,', after: 'by when', block: 'n:0', start: 81, end: 97 } }
const EDIT = { kind: 'edit', name: 'Marta', text: 'a one-line reason', anchor: { quote: 'a reason', before: 'A list owes its reader', after: 'for each entry', block: 'n:1', start: 23, end: 31 } }
const EDIT_OTHER = { kind: 'edit', name: 'Marta', text: 'they are sorted', anchor: { quote: 'they are ordered', before: 'They are long,', after: 'by when', block: 'n:0', start: 81, end: 97 } }
const EDIT_CHANGED = { kind: 'edit', name: 'Marta', text: 'One line is plenty', anchor: { quote: 'One line is ample', before: 'for each entry.', after: '', block: 'n:1', start: null, end: null } }

const recordFor = async (c: { changes: ChangeStore }, id: string): Promise<Change> => (await c.changes.list()).find((change) => readerNoteOf(change)?.key.endsWith(`.${id}`))!
const reply = (text: string) => readerReplyFor(text, 'Dominik', Date.now())

describe('the outcome of a reader record', () => {
  test('accepted, declined, done and could not be applied; none while it waits', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const ids = { accepted: await s.post(EDIT), declined: await s.post(EDIT_OTHER), done: await s.post(NOTE), failed: await s.post(EDIT_CHANGED), open: await s.post({ ...NOTE, text: 'Pages or hours?' }) }
    await collect(c, s)
    const agent = await withAgent(c)
    expect((await agent.resolveChange((await recordFor(c, ids.accepted)).id, 'accept')).applied).toBe(true)
    expect((await agent.resolveChange((await recordFor(c, ids.declined)).id, 'reject')).applied).toBe(true)
    expect((await agent.resolveChange((await recordFor(c, ids.done)).id, 'accept')).applied).toBe(true)
    for (const [kind, id] of Object.entries(ids)) expect(readerOutcomeOf(await recordFor(c, id))).toBe(kind === 'open' ? null : kind)
  })
})

describe('the outcome sender', () => {
  test('every outcome kind and the replies reach the reader\'s own notes, and show again on every load', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const ids = { accepted: await s.post(EDIT), declined: await s.post(EDIT_OTHER), done: await s.post(NOTE), failed: await s.post(EDIT_CHANGED), open: await s.post({ ...NOTE, text: 'Pages or hours?' }) }
    await collect(c, s)
    const agent = await withAgent(c)
    await agent.resolveChange((await recordFor(c, ids.accepted)).id, 'accept')
    await c.changes.addReaderReply((await recordFor(c, ids.declined)).id, reply('Decoding is the word the course uses.'))
    await agent.resolveChange((await recordFor(c, ids.declined)).id, 'reject')
    await c.changes.addReaderReply((await recordFor(c, ids.done)).id, reply('Added an example to the next draft.'))
    await agent.resolveChange((await recordFor(c, ids.done)).id, 'accept')
    await c.changes.addReaderReply((await recordFor(c, ids.open)).id, reply('Hours, I think.'))
    const { ports } = sender(c, s)
    expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 5, left: 0, gone: 0, failed: [], outdated: [] })
    for (let load = 0; load < 2; load += 1) {
      const byId = new Map((await s.mine()).map((n) => [n.id, n]))
      expect(byId.get(ids.accepted)).toMatchObject({ status: 'accepted', replies: [] })
      expect(byId.get(ids.declined)).toMatchObject({ status: 'declined', replies: [{ text: 'Decoding is the word the course uses.' }] })
      expect(byId.get(ids.done)).toMatchObject({ status: 'done', replies: [{ text: 'Added an example to the next draft.' }] })
      expect(byId.get(ids.failed)).toMatchObject({ status: 'failed', replies: [] })
      expect(byId.get(ids.open)).toMatchObject({ status: 'open', outcomeAt: null, replies: [{ text: 'Hours, I think.' }] })
    }
    // Confirmed in the ledger: nothing is owed now, and a second look sends nothing.
    for (const change of (await c.changes.list()).filter((x) => readerNoteOf(x))) expect(owedFor(change)).toBeNull()
    const again = sender(c, s)
    expect(await sendReaderOutcomes(again.ports, [s.link])).toEqual({ sent: 0, left: 0, gone: 0, failed: [], outdated: [] })
    expect(again.requests).toEqual([])
  })

  test('offline: nothing is marked sent; on return the reply written offline is sent once', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    await c.changes.addReaderReply(record.id, reply('A history of phonics teaching, for example.'))
    let online = false
    const { ports, requests } = sender(c, s, { sendOutcomes: async (base, shareId, owner, items) => {
      requests.push({ base, shareId, owner, items })
      return online ? s.client.outcomes(base, shareId, owner, items) : { kind: 'unreachable' as const }
    } })
    for (let look = 0; look < 3; look += 1) expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 0, left: 1, gone: 0, failed: [s.shareId], outdated: [] })
    expect((await c.changes.get(record.id))?.readerReplies?.[0].sent).toBeUndefined()
    expect((await s.mine())[0].replies).toEqual([])
    online = true
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1, left: 0 })
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 0, left: 0 })
    expect(requests).toHaveLength(4)
    expect((await c.changes.get(record.id))?.readerReplies?.[0].sent).toBeNumber()
    expect((await s.mine())[0].replies.map((r) => r.text)).toEqual(['A history of phonics teaching, for example.'])
    // An answer lost on the way: the same reply sent again is kept once.
    const replyId = (await c.changes.get(record.id))!.readerReplies![0].id
    await s.client.outcomes(ORIGIN, s.shareId, s.ownerToken, [{ key: readerNoteOf(record)!.key, outcome: null, at: null, replies: [{ id: replyId, text: 'A history of phonics teaching, for example.', at: Date.now() }] }])
    expect((await s.mine())[0].replies).toHaveLength(1)
  })

  test('a decision taken back is sent as open again; a note the service has not got yet waits', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    await (await withAgent(c)).resolveChange(record.id, 'accept')
    const { ports } = sender(c, s)
    await sendReaderOutcomes(ports, [s.link])
    expect((await s.mine())[0].status).toBe('done')
    await c.changes.setReviewStatus(record.id, 'pending')
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1 })
    expect((await s.mine())[0]).toMatchObject({ status: 'open', outcomeAt: null })
    // Waiting: the service lists the note as not collected (marking it failed earlier): left for the next look.
    const waiting = sender(c, s, { sendOutcomes: async () => ({ kind: 'ok', status: 200, body: { recorded: [], waiting: [readerNoteOf(record)!.key], unknown: [], full: [] } }) })
    await c.changes.addReaderReply(record.id, reply('Later.'))
    expect(await sendReaderOutcomes(waiting.ports, [s.link])).toEqual({ sent: 0, left: 1, gone: 0, failed: [], outdated: [] })
    expect(owedFor((await c.changes.get(record.id))!)).not.toBeNull()
  })

  test('only notes from that share, with that share\'s owner token, and nothing else from the Collection', async () => {
    const c = await collection()
    const svc = fakeService(service as unknown as ServiceModule)
    const s = await sharedPiece(svc, 'For Marta')
    const other = await sharedPiece(svc, 'Workshop group')
    const elsewhere = await sharedPiece(svc, 'A link not asked about')
    const mineId = await s.post({ ...NOTE, text: 'On link one' })
    const otherId = await other.post({ ...NOTE, text: 'On link two' })
    const elsewhereId = await elsewhere.post({ ...NOTE, text: 'On a link of another Collection' })
    await collect(c, s)
    await collect(c, other)
    await collect(c, elsewhere)
    // The writer's own change and an agent's: never sent.
    await c.changes.add({ path: PIECE, provenance: 'writer', editClass: 'content', category: null, summary: 'Mine', oldText: 'Most', newText: 'Many', isCorrection: false } as never)
    for (const id of [mineId, otherId, elsewhereId]) await c.changes.addReaderReply((await recordFor(c, id)).id, reply(`Reply to ${id}`))
    const { ports, requests } = sender(c, s)
    expect(await sendReaderOutcomes(ports, [s.link, other.link])).toMatchObject({ sent: 2 })
    expect(requests.map((r) => [r.shareId, r.owner])).toEqual([[s.shareId, s.ownerToken], [other.shareId, other.ownerToken]])
    const sentKeys = requests.flatMap((r) => r.items.map((item) => item.key))
    expect(sentKeys).toEqual([readerNoteOf(await recordFor(c, mineId))!.key, readerNoteOf(await recordFor(c, otherId))!.key])
    // What a request carries: the note key, the outcome and the replies. No path, no piece text, no names.
    const wire = JSON.stringify(requests)
    for (const leak of [PIECE, 'reading list is for', 'Most reading lists', c.root, 'For Marta', 'Workshop group', 'Marta', 'Dominik', 'Many']) expect(wire).not.toContain(leak)
    for (const item of requests.flatMap((r) => r.items)) expect(Object.keys(item).sort()).toEqual(['at', 'key', 'outcome', 'replies'])
    for (const r of requests.flatMap((x) => x.items.flatMap((item) => item.replies))) expect(Object.keys(r).sort()).toEqual(['at', 'id', 'text'])
    // The link not asked about heard nothing.
    expect((await elsewhere.mine())[0].replies).toEqual([])
    expect((await s.mine())[0].replies.map((r) => r.text)).toEqual([`Reply to ${mineId}`])
    expect((await other.mine())[0].replies.map((r) => r.text)).toEqual([`Reply to ${otherId}`])
  })

  test('sending writes nothing to a piece; a reply decides nothing', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(EDIT)
    await collect(c, s)
    const record = await recordFor(c, id)
    const before = await readFile(join(c.root, PIECE))
    await c.changes.addReaderReply(record.id, reply('One line, yes.'))
    await sendReaderOutcomes(sender(c, s).ports, [s.link])
    expect(Buffer.compare(await readFile(join(c.root, PIECE)), before)).toBe(0)
    const after = (await c.changes.get(record.id))!
    expect({ status: after.status, oldText: after.oldText, newText: after.newText, anchor: after.anchor }).toEqual({ status: record.status, oldText: record.oldText, newText: record.newText, anchor: record.anchor })
  })
})

describe('final answers and one outcome per note (Sol review round 1)', () => {
  test('a reply the service refuses because the note has its 20 is never shown as Sent and never sent again; the outcome is still heard', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    const key = readerNoteOf(record)!.key
    // Twenty replies already held for this note (another Mac, an older ledger).
    const held = Array.from({ length: 20 }, (_, i) => ({ id: `held-reply-${String(i).padStart(4, '0')}`, text: `Held ${i}`, at: Date.now() }))
    expect((await s.client.outcomes(ORIGIN, s.shareId, s.ownerToken, [{ key, outcome: null, at: null, replies: held }])).kind).toBe('ok')
    await c.changes.addReaderReply(record.id, reply('One too many.'))
    await (await withAgent(c)).resolveChange(record.id, 'accept')
    const { ports, requests } = sender(c, s)
    expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 1, left: 0, gone: 0, failed: [], outdated: [] })
    const after = (await c.changes.get(record.id))!
    expect(after.readerReplies?.[0]).toMatchObject({ text: 'One too many.', notSent: 'full' })
    expect(after.readerReplies?.[0].sent).toBeUndefined()
    expect(after.readerHeard?.outcome).toBe('done')
    expect((await s.mine())[0]).toMatchObject({ status: 'done' })
    expect((await s.mine())[0].replies.map((r) => r.text)).not.toContain('One too many.')
    // Final: nothing owed, no request on the next look.
    expect(owedFor(after)).toBeNull()
    expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 0, left: 0, gone: 0, failed: [], outdated: [] })
    expect(requests).toHaveLength(1)
  })

  test('a reply already held is confirmed; a reply the answer does not name stays unsent', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    await c.changes.addReaderReply(record.id, reply('First.'))
    await c.changes.addReaderReply(record.id, reply('Second.'))
    const [first, second] = (await c.changes.get(record.id))!.readerReplies!
    const key = readerNoteOf(record)!.key
    // An answer that names only the first reply (held before): the second is not confirmed.
    const partial = sender(c, s, { sendOutcomes: async () => ({ kind: 'ok', status: 200, body: { recorded: [key], waiting: [], unknown: [], full: [], replies: [{ key, kept: [], already: [first.id], full: [] }] } }) })
    expect(await sendReaderOutcomes(partial.ports, [s.link])).toMatchObject({ sent: 1 })
    const after = (await c.changes.get(record.id))!.readerReplies!
    expect(after.find((r) => r.id === first.id)?.sent).toBeNumber()
    expect(after.find((r) => r.id === second.id)?.sent).toBeUndefined()
    expect(after.find((r) => r.id === second.id)?.notSent).toBeUndefined()
    expect(owedFor((await c.changes.get(record.id))!)?.item.replies.map((r) => r.id)).toEqual([second.id])
  })

  test('a note the service no longer holds: its outcome and queued replies are marked not on the reader\'s page, never Sent, never sent again', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    // A reply written offline; the note is cleared on the service before the app is back.
    await c.changes.addReaderReply(record.id, reply('Written on the train.'))
    await (await withAgent(c)).resolveChange(record.id, 'accept')
    expect((await s.client.clearNotes(ORIGIN, s.shareId, s.ownerToken, [readerNoteOf(record)!.key])).kind).toBe('ok')
    const { ports, requests } = sender(c, s)
    expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 0, left: 0, gone: 1, failed: [], outdated: [] })
    const after = (await c.changes.get(record.id))!
    expect(after.readerGone).toBeNumber()
    expect(after.readerHeard).toBeUndefined()
    expect(after.readerReplies?.[0].sent).toBeUndefined()
    expect(after.readerReplies?.[0].notSent).toBe('gone')
    expect(owedFor(after)).toBeNull()
    expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 0, left: 0, gone: 0, failed: [], outdated: [] })
    expect(requests).toHaveLength(1)
  })

  test('two ledger records of one note send one outcome, the latest decision\'s, and keep sending it', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    // The same note filed twice: a second record of it, later in the ledger.
    const journal = join(c.root, '.writeflex', 'changes.jsonl')
    const lines = (await readFile(journal, 'utf8')).split('\n').filter((line) => line.trim() !== '')
    const original = lines.find((line) => line.includes(record.id))!
    const twinId = `${record.id.slice(0, -1)}${record.id.endsWith('z') ? 'y' : 'z'}`
    await writeFile(journal, [...lines, original.split(record.id).join(twinId)].join('\n') + '\n')
    const store = c.changes
    const ledger = { changes: store }
    // The later record is decided first (done), the earlier record after it (declined): declined is the latest decision.
    expect((await store.setStatus(twinId, 'accepted')).status).toBe('accepted')
    await new Promise((resolve) => setTimeout(resolve, 5))
    await store.setReviewStatus(record.id, 'rejected')
    const declinedAt = ((await store.get(record.id)) as Change & { readerDecidedAt?: number }).readerDecidedAt
    expect(declinedAt).toBeNumber()
    const { ports, requests } = sender(ledger, s)
    for (let look = 0; look < 3; look += 1) {
      await sendReaderOutcomes(ports, [s.link])
      expect((await s.mine())[0]).toMatchObject({ status: 'declined', outcomeAt: declinedAt })
    }
    expect(requests.flatMap((r) => r.items.map((item) => item.outcome))).toEqual(['declined'])
    for (const change of [await store.get(record.id), await store.get(twinId)]) expect(change?.readerHeard).toEqual({ outcome: 'declined', at: declinedAt! })
  })

  test('the outcome\'s time is the decision time kept on the record; a resend after a lost answer sends the same time', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(EDIT_OTHER)
    await collect(c, s)
    const record = await recordFor(c, id)
    await c.changes.setReviewStatus(record.id, 'rejected')
    const decidedAt = ((await c.changes.get(record.id)) as Change & { readerDecidedAt?: number }).readerDecidedAt!
    expect(decidedAt).toBeNumber()
    let clock = decidedAt + 60_000
    // The service records it, but the answer is lost: the app sends again, later.
    let lose = true
    const { ports, requests } = sender(c, s, { now: () => clock, sendOutcomes: async (base, shareId, owner, items) => {
      requests.push({ base, shareId, owner, items: JSON.parse(JSON.stringify(items)) })
      const answer = await s.client.outcomes(base, shareId, owner, items)
      return lose ? { kind: 'unreachable' as const } : answer
    } })
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 0, left: 1 })
    clock += 3_600_000
    lose = false
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1 })
    expect(requests.map((r) => r.items[0].at)).toEqual([decidedAt, decidedAt])
    expect((await s.mine())[0]).toMatchObject({ status: 'declined', outcomeAt: decidedAt })
    expect((await c.changes.get(record.id))?.readerHeard).toEqual({ outcome: 'declined', at: decidedAt })
  })
})

describe('an older sharing service (ticket 08 review round 2)', () => {
  test('an answer without per-reply entries confirms no reply: the reply stays unsent and is sent again, up to the bound, then waits for the update', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    await (await withAgent(c)).resolveChange(record.id, 'accept')
    await c.changes.addReaderReply(record.id, reply('Phonics, mostly.'))
    const key = readerNoteOf(record)!.key
    // A service from before build 7: the reply is stored, the outcome recorded, `full` even names the
    // note, but the answer carries no `replies`.
    let older = true
    const legacy = new Map<string, LegacyAnswers>()
    const { ports, requests } = sender(c, s, { legacy, sendOutcomes: async (base, shareId, owner, items) => {
      requests.push({ base, shareId, owner, items: JSON.parse(JSON.stringify(items)) })
      const answer = await s.client.outcomes(base, shareId, owner, items)
      if (!older || answer.kind !== 'ok') return answer
      const { replies: _dropped, ...body } = answer.body
      return { ...answer, body: { ...body, full: [key] } }
    } })
    for (let look = 1; look <= LEGACY_ANSWERS_AT_MOST; look += 1) {
      const result = await sendReaderOutcomes(ports, [s.link])
      expect(result.outdated).toEqual(look < LEGACY_ANSWERS_AT_MOST ? [] : [s.shareId])
      const kept = (await c.changes.get(record.id))!.readerReplies![0]
      expect(kept.sent).toBeUndefined()
      expect(kept.notSent).toBeUndefined()
    }
    expect(requests).toHaveLength(LEGACY_ANSWERS_AT_MOST)
    expect(requests.every((r) => r.items[0].replies.length === 1)).toBe(true)
    // The outcome the older service holds is confirmed; the reply is not.
    expect((await c.changes.get(record.id))?.readerHeard).toMatchObject({ outcome: 'done' })
    // At the bound the reply is no longer sent: no request at all while nothing else is owed.
    for (let look = 0; look < 3; look += 1) expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 0, left: 0, gone: 0, failed: [], outdated: [s.shareId] })
    expect(requests).toHaveLength(LEGACY_ANSWERS_AT_MOST)
    expect(legacy.get(s.shareId)?.count).toBe(LEGACY_ANSWERS_AT_MOST)
    // An outcome still goes, without the reply.
    await c.changes.setReviewStatus(record.id, 'pending')
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1, outdated: [s.shareId] })
    expect(requests.at(-1)!.items[0]).toMatchObject({ outcome: null, replies: [] })
    expect((await c.changes.get(record.id))!.readerReplies![0].sent).toBeUndefined()
    // The service updated: its next answer carries `replies`, and the reply goes on the look after.
    older = false
    await c.changes.setReviewStatus(record.id, 'rejected')
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1, outdated: [] })
    expect(legacy.get(s.shareId)?.count).toBe(0)
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1, outdated: [] })
    expect(requests.at(-1)!.items[0].replies).toHaveLength(1)
    expect((await c.changes.get(record.id))!.readerReplies![0].sent).toBeNumber()
    expect((await s.mine())[0].replies.map((r) => r.text)).toEqual(['Phonics, mostly.'])
  })
})

/** An older service's answer: what the service says, without the per-reply entries. */
const olderAnswer = (answer: Awaited<ReturnType<ReaderRepliesPorts['sendOutcomes']>>) => {
  if (answer.kind !== 'ok') return answer
  const { replies: _dropped, ...body } = answer.body
  return { ...answer, body }
}

describe('an older sharing service: the pause (ticket 08 review round 3)', () => {
  test('older answers are counted per answer: at the bound mid-look, the requests left carry no replies and notes owing only replies are left out', async () => {
    const c = await collection()
    const s = await sharedPiece()
    for (let i = 0; i < 12; i += 1) await s.post({ ...NOTE, text: `Question ${i}?` })
    await collect(c, s)
    const records = (await c.changes.list()).filter((change) => readerNoteOf(change) !== null)
    expect(records).toHaveLength(12)
    // Every note owes 20 long replies (three notes to a request, under the request's bytes): four
    // requests. The last three: two decided notes and one open note.
    for (const record of records) for (let r = 0; r < READER_REPLIES_MOST; r += 1) await c.changes.addReaderReply(record.id, reply(`${r} ${'x'.repeat(990)}`))
    for (const record of records.slice(9, 11)) await c.changes.setReviewStatus(record.id, 'rejected')
    const legacy = new Map<string, LegacyAnswers>()
    const counts: Array<number | undefined> = []
    const { ports, requests } = sender(c, s, { legacy, sendOutcomes: async (base, shareId, owner, items) => {
      counts.push(legacy.get(shareId)?.count)
      requests.push({ base, shareId, owner, items: JSON.parse(JSON.stringify(items)) })
      return olderAnswer(await s.client.outcomes(base, shareId, owner, items))
    } })
    const result = await sendReaderOutcomes(ports, [s.link])
    expect(requests.map((r) => r.items.length)).toEqual([3, 3, 3, 2])
    expect(counts).toEqual([undefined, 1, 2, LEGACY_ANSWERS_AT_MOST])
    expect(requests.slice(0, 3).every((r) => r.items.every((item) => item.replies.length === READER_REPLIES_MOST))).toBe(true)
    // Request 4: the two decided notes' outcomes, without their replies; the open note owing only a reply is not in it.
    expect(requests[3].items).toEqual(records.slice(9, 11).map((record) => expect.objectContaining({ key: readerNoteOf(record)!.key, outcome: 'declined', replies: [] })))
    expect(result.outdated).toEqual([s.shareId])
    expect(legacy.get(s.shareId)?.count).toBe(LEGACY_ANSWERS_AT_MOST + 1)
    for (const record of records) expect((await c.changes.get(record.id))!.readerReplies!.every((r) => r.sent === undefined)).toBe(true)
  })

  test('a paused link\'s replies go once more after LEGACY_RETRY_MS; an older answer starts the wait again, an answer with replies ends the pause', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    // An open note owes no outcome: only its reply.
    await c.changes.addReaderReply(record.id, reply('Phonics, mostly.'))
    const pausedAt = 1_000_000_000
    let clock = pausedAt
    let older = true
    const legacy = new Map<string, LegacyAnswers>([[s.shareId, { count: LEGACY_ANSWERS_AT_MOST, lastAt: pausedAt }]])
    const { ports, requests } = sender(c, s, { legacy, now: () => clock, sendOutcomes: async (base, shareId, owner, items) => {
      requests.push({ base, shareId, owner, items: JSON.parse(JSON.stringify(items)) })
      const answer = await s.client.outcomes(base, shareId, owner, items)
      return older ? olderAnswer(answer) : answer
    } })
    clock = pausedAt + LEGACY_RETRY_MS - 60_000
    expect(await sendReaderOutcomes(ports, [s.link])).toEqual({ sent: 0, left: 0, gone: 0, failed: [], outdated: [s.shareId] })
    expect(requests).toHaveLength(0)
    // At 30 minutes: one ordinary request with the reply. The service is still older: the wait starts again.
    clock = pausedAt + LEGACY_RETRY_MS
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ outdated: [s.shareId] })
    expect(requests).toHaveLength(1)
    expect(requests[0].items[0].replies.map((r) => r.text)).toEqual(['Phonics, mostly.'])
    expect(legacy.get(s.shareId)).toEqual({ count: LEGACY_ANSWERS_AT_MOST + 1, lastAt: clock })
    expect((await c.changes.get(record.id))!.readerReplies![0].sent).toBeUndefined()
    clock += LEGACY_RETRY_MS - 60_000
    await sendReaderOutcomes(ports, [s.link])
    expect(requests).toHaveLength(1)
    // Updated meanwhile (from another Mac): the next try's answer carries `replies`; the pause ends and the reply is sent.
    older = false
    clock += 60_000
    expect(await sendReaderOutcomes(ports, [s.link])).toMatchObject({ sent: 1, outdated: [] })
    expect(requests).toHaveLength(2)
    expect(legacy.get(s.shareId)?.count).toBe(0)
    expect((await c.changes.get(record.id))!.readerReplies![0].sent).toBeNumber()
    expect((await s.mine())[0].replies.map((r) => r.text)).toEqual(['Phonics, mostly.'])
  })

  test('Settings finding the service current (sharing:status, asking the service) ends the pause and looks; finding it older leaves it', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    await c.changes.addReaderReply(record.id, reply('Phonics, mostly.'))
    let older = true
    const requests: OutcomeItem[][] = []
    setReaderNotesSource({
      links: () => [s.link],
      fetchNotes: (b, sid, o) => s.client.notes(b, sid, o),
      markCollected: (b, sid, o, k) => s.client.collected(b, sid, o, k),
      sendOutcomes: async (base, shareId, owner, items) => {
        requests.push(JSON.parse(JSON.stringify(items)))
        const answer = await s.client.outcomes(base, shareId, owner, items)
        return older ? olderAnswer(answer) : answer
      },
      shareIds: () => [s.shareId],
    })
    const looks = startReaderNotesCollection({ workspace: c.workspace, changes: c.changes, owns: () => true, onCollected: () => {}, intervalMs: 3_600_000 })
    const settle = async (until: () => boolean | Promise<boolean>) => { for (let i = 0; i < 200 && !(await until()); i += 1) await new Promise((resolve) => setTimeout(resolve, 10)) }
    try {
      for (let i = 0; i < 10 && !repliesNeedServiceUpdate(s.shareId); i += 1) await looks.look()
      expect(repliesNeedServiceUpdate(s.shareId)).toBe(true)
      const pausedAfter = requests.length
      let service = { installedBuild: 6, appBuild: 7, compare: 'update' }
      const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
      const setup = { status: async () => ({ ready: true, service }) } as unknown as SharingSetup
      registerSharingIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, setup, { openExternal: () => {}, isAppWindow: () => true })
      const status = (input?: unknown) => handlers.get('sharing:status')!({ sender: { id: 1 } }, input)
      // Older than this WriteFlex: still paused, no look.
      await status({ askService: true })
      // Current, but only as recorded (the service not asked): still paused.
      service = { installedBuild: 7, appBuild: 7, compare: 'current' }
      await status()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(repliesNeedServiceUpdate(s.shareId)).toBe(true)
      expect(requests).toHaveLength(pausedAfter)
      // Asked, and current (updated from another Mac): the pause ends and a look sends the reply.
      older = false
      expect(await status({ askService: true })).toMatchObject({ service: { compare: 'current' } })
      expect(repliesNeedServiceUpdate(s.shareId)).toBe(false)
      await settle(async () => (await c.changes.get(record.id))!.readerReplies![0].sent !== undefined)
      expect(requests).toHaveLength(pausedAfter + 1)
      expect(requests.at(-1)![0].replies.map((r) => r.text)).toEqual(['Phonics, mostly.'])
      expect((await c.changes.get(record.id))!.readerReplies![0].sent).toBeNumber()
    } finally {
      looks.dispose()
      setReaderNotesSource(null)
    }
  })
})

describe('a reply both sent and refused (ticket 08 review round 2)', () => {
  test('is not a reply to the ledger: never counted sent, never sent again, but its words are kept on rewrite', async () => {
    const base = { id: 'abcdefgh12', text: 'Yes.', at: 1, by: 'Dominik' }
    expect(isReaderReply({ ...base, sent: 5 })).toBe(true)
    expect(isReaderReply({ ...base, notSent: 'full' })).toBe(true)
    expect(isReaderReply({ ...base, sent: 5, notSent: 'full' })).toBe(false)
    expect(isReaderReply({ ...base, sent: 5, notSent: 'gone' })).toBe(false)
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    // A ledger line written with both marks (by hand, or a fault).
    const path = join(c.root, '.writeflex', 'changes.jsonl')
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    for (const line of lines) if (line.id === record.id) line.readerReplies = [{ ...base, sent: 5, notSent: 'full' }]
    await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
    const read = new ChangeStore(c.workspace)
    expect(owedFor((await read.get(record.id))!)).toBeNull()
    await read.addReaderReply(record.id, reply('Another.'))
    expect((await read.get(record.id))!.readerReplies!.map((r) => r.text)).toEqual(['Yes.', 'Another.'])
  })
})

describe('the reply door', () => {
  test('a reply is plain text: markup kept as text, controls and bidi characters removed, 1 to 1000 characters', () => {
    expect(readerReplyFor('  <b>Yes</b> <script>x()</script>\r\nNext‮\u0000 ', 'Dominik', 1).text).toBe('<b>Yes</b> <script>x()</script>\nNext')
    expect(() => readerReplyFor('   ', 'Dominik', 1)).toThrow('A reply needs some words.')
    expect(() => readerReplyFor('x'.repeat(1001), 'Dominik', 1)).toThrow('at most 1,000 characters')
    expect(() => readerReplyFor({ text: 'x' }, 'Dominik', 1)).toThrow()
    expect(readerReplyFor('x'.repeat(1000), 'Dominik', 1).id).toMatch(/^[A-Za-z0-9_-]{16}$/)
  })

  test('only a reader\'s record takes a reply, at most its limit, and the reply changes nothing else', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const id = await s.post(NOTE)
    await collect(c, s)
    const record = await recordFor(c, id)
    const writer = await c.changes.add({ path: PIECE, provenance: 'writer', editClass: 'content', category: null, summary: 'Mine', oldText: 'Most', newText: 'Many', isCorrection: false } as never)
    await expect(c.changes.addReaderReply(writer.id, reply('No'))).rejects.toThrow('Only a reader')
    await expect(c.changes.addReaderReply(record.id, { id: 'bad id!', text: 'x', at: 1, by: 'D' })).rejects.toThrow()
    await expect(c.changes.addReaderReply(record.id, { ...reply('x'), sent: 5 })).rejects.toThrow()
    for (let i = 0; i < READER_REPLIES_MOST; i += 1) await c.changes.addReaderReply(record.id, reply(`Reply ${i}`))
    await expect(c.changes.addReaderReply(record.id, reply('One too many'))).rejects.toThrow(`at most ${READER_REPLIES_MOST}`)
    const after = (await c.changes.get(record.id))!
    expect(after.status).toBe('pending')
    expect(after.readerReplies).toHaveLength(READER_REPLIES_MOST)
    // A restart keeps them, as the ledger keeps everything else.
    expect((await new ChangeStore(c.workspace).get(record.id))?.readerReplies).toHaveLength(READER_REPLIES_MOST)
  })
})
