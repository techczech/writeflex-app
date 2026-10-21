// 0.24 ticket 07: readers' notes into the review ledger. Seams: the collector against the fake sharing
// service (collect once; restarts; two Macs), the outside-changes door with the reader source (limits,
// de-dup), and the existing accept path (Accept changes only the proposed words; Done and Decline write
// nothing). Spec section 5 rule 1: no message from the sharing service writes to a piece.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as service from '../../sharing-service/index.ts'
import { WorkspaceAgent } from '../../src/main/agent'
import { ChangeStore, closedReasonOf, type Change } from '../../src/main/changes'
import { MAX_CHANGES_PER_REQUEST, MAX_REFUSED_OUTSIDE_RECORDS, MAX_UNDECIDED_OUTSIDE_BYTES, MAX_UNDECIDED_OUTSIDE_CHANGES, MAX_UNDECIDED_PER_SOURCE, declaredSource } from '../../src/main/cli/review-format'
import { isRefusedOutsideChange, readerNoteOf } from '../../src/main/outside-change-fields'
import { createServiceClient } from '../../src/main/sharing-client'
import { READER_CLOSED_KEPT, READER_EDIT_CHANGED, READER_EDIT_GONE, READER_EDIT_MULTILINE, READER_EDIT_REPEATED_PASSAGE, checkedLimits, checkedNote, collectReaderNotes, guardedDocumentReader, limitReachedOf, readerChangeFor, readerNoteRecords, readerRequestId, type ReaderLinkSource, type ReaderNotesPorts } from '../../src/main/sharing-reader-notes'
import { readerOutcomeOf } from '../../src/main/sharing-reader-replies'
import { Workspace } from '../../src/main/workspace'
import { ADMIN_KEY, ORIGIN, fakeService, type ServiceModule } from '../helpers/sharing-service-runtime.ts'
import { NOTE_LIMITS } from '../../sharing-service/reader-notes.ts'

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

async function collection(text = DOC): Promise<{ root: string; workspace: Workspace; changes: ChangeStore }> {
  const root = await mkdtemp(join(tmpdir(), 'wf-reader-notes-'))
  roots.push(root)
  await writeFile(join(root, PIECE), text)
  const workspace = new Workspace(root)
  return { root, workspace, changes: new ChangeStore(workspace) }
}

/** A share on the fake service, published, with readers posting through the page's own route. */
async function sharedPiece() {
  const svc = fakeService(service as unknown as ServiceModule)
  const made = await svc.call('/shares', { method: 'POST', headers: { authorization: fakeBearer(ADMIN_KEY) } })
  const { shareId, ownerToken } = await made.json() as { shareId: string; ownerToken: string }
  const published = await svc.call(`/shares/${shareId}/page`, {
    method: 'PUT', headers: { authorization: fakeBearer(ownerToken), 'content-type': 'application/json' },
    body: JSON.stringify({ revision: 1, savedAt: Date.now(), comments: true, kind: 'piece', title: 'What a reading list is for', parts: [{ html: `<p>${TEXT}</p>` }], images: [] }),
  })
  expect(published.status).toBe(200)
  const reader = randomBytes(32).toString('base64url')
  const post = async (note: Record<string, unknown>, who = reader) => {
    const sent = await svc.call(`/s/${shareId}/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ reader: who, note: { id: randomBytes(12).toString('base64url'), writtenAt: Date.now(), revision: 1, ...note } }),
    })
    expect(sent.status).toBe(201)
  }
  const client = createServiceClient({ fetch: (input, init) => svc.call(new URL(String(input)).pathname, init) })
  const link: ReaderLinkSource = { shareId, label: 'For Marta', paths: [PIECE], base: ORIGIN, owner: ownerToken }
  const waiting = async (): Promise<number> => {
    const answer = await client.notes(ORIGIN, shareId, ownerToken)
    return answer.kind === 'ok' ? answer.body.notes.length : -1
  }
  return { svc, shareId, ownerToken, post, client, link, waiting }
}

function ports(c: { workspace: Workspace; changes: ChangeStore }, client: ReturnType<typeof createServiceClient>, over: Partial<ReaderNotesPorts> = {}): ReaderNotesPorts {
  return {
    fetchNotes: (base, id, owner) => client.notes(base, id, owner),
    markCollected: (base, id, owner, keys) => client.collected(base, id, owner, keys),
    readDocument: guardedDocumentReader(c.workspace),
    changes: c.changes,
    now: () => Date.now(),
    ...over,
  }
}

const NOTE = { kind: 'note', name: 'Marta', text: 'Which kind of book do you mean?', anchor: { quote: 'they are ordered', before: 'They are long,', after: 'by when', block: 'n:0', start: 81, end: 97 } }
const EDIT = { kind: 'edit', name: 'Jonas', text: 'a one-line reason', anchor: { quote: 'a reason', before: 'A list owes its reader', after: 'for each entry', block: 'n:1', start: 23, end: 31 } }

const readers = (list: Change[]): Change[] => list.filter((change) => readerNoteOf(change) !== null)

describe('the collector', () => {
  test('a note arrives once, as a reader record, and is marked collected; the piece is not touched', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    const first = await collectReaderNotes(ports(c, s.client), [s.link])
    expect(first).toMatchObject({ added: 1, repeats: 0, full: 0, failed: [] })
    const second = await collectReaderNotes(ports(c, s.client), [s.link])
    expect(second.added + second.repeats).toBe(0)
    expect(await s.waiting()).toBe(0)
    const [record] = readers(await c.changes.list())
    expect(record).toMatchObject({ outsideSource: 'reader', status: 'pending', oldText: 'they are ordered', newText: 'they are ordered', author: { name: 'Marta' } })
    expect(readerNoteOf(record)).toMatchObject({ kind: 'note', name: 'Marta', link: 'For Marta', quote: 'they are ordered', anchored: 'unchanged', text: NOTE.text })
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(DOC)
  })

  test('marking collected failed: the note is asked for again after a restart and held once', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    await collectReaderNotes(ports(c, s.client, { markCollected: async () => { throw new Error('offline') } }), [s.link])
    expect(await s.waiting()).toBe(1)
    // A restart: a new store over the same Collection.
    const again = await collectReaderNotes(ports({ workspace: c.workspace, changes: new ChangeStore(c.workspace) }, s.client), [s.link])
    expect(again).toMatchObject({ added: 0, repeats: 1 })
    expect(readers(await c.changes.list())).toHaveLength(1)
    expect(await s.waiting()).toBe(0)
  })

  test('two Macs on one synced Collection: the second Mac finds the note already held', async () => {
    // Only the window that holds the Collection's owner lock collects (ipc.ts), so two looks never run
    // at once on one Collection; this is the case the lock leaves: Mac A held it and could not mark it.
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    await s.post(EDIT)
    const a = await collectReaderNotes(ports(c, s.client, { markCollected: async () => ({ kind: 'unreachable' as const }) }), [s.link])
    expect(a.added).toBe(2)
    const otherMac = { workspace: new Workspace(c.root), changes: new ChangeStore(new Workspace(c.root)) }
    const b = await collectReaderNotes(ports(otherMac, s.client), [s.link])
    expect(b).toMatchObject({ added: 0, repeats: 2 })
    expect(readers(await c.changes.list())).toHaveLength(2)
    expect(await s.waiting()).toBe(0)
  })

  test('two Macs with their own copies: a Mac that looks after another collected is given nothing', async () => {
    const one = await collection()
    const two = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    expect((await collectReaderNotes(ports(one, s.client), [s.link])).added).toBe(1)
    expect((await collectReaderNotes(ports(two, s.client), [s.link])).added).toBe(0)
    expect(readers(await two.changes.list())).toHaveLength(0)
  })

  test('a link the service does not answer for is named and nothing is added', async () => {
    const c = await collection()
    const s = await sharedPiece()
    const out = await collectReaderNotes(ports(c, s.client), [{ ...s.link, owner: ['fake', 'test', 'token', 'one', 'x'.repeat(20)].join('-') }])
    expect(out.failed).toEqual([s.shareId])
    expect(JSON.stringify(out)).not.toContain('fake-test-token')
  })
})

describe('the outside-changes door with the reader source', () => {
  test('the command line can never declare itself a reader', () => {
    expect(declaredSource('reader')).toBe('outside-agent')
    expect(declaredSource('Reader')).toBe('outside-agent')
  })

  test('the ledger full: the note is not marked collected and comes again', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    const full: ReaderNotesPorts['changes'] = { addOutside: async (entries) => entries.map((entry) => ({ requestId: entry.requestId, outcome: 'full' as const, changes: [], full: { undecided: 400, ofSource: 400, because: 'source' as const } })) }
    const out = await collectReaderNotes(ports(c, s.client, { changes: full }), [s.link])
    expect(out).toMatchObject({ added: 0, full: 1 })
    expect(await s.waiting()).toBe(1)
    expect((await collectReaderNotes(ports(c, s.client), [s.link])).added).toBe(1)
  })

  test('one request id per note: the same note offered twice is added once', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    const noMark: Partial<ReaderNotesPorts> = { markCollected: async () => ({ kind: 'unreachable' as const }) }
    await collectReaderNotes(ports(c, s.client, noMark), [s.link])
    await collectReaderNotes(ports(c, s.client, noMark), [s.link])
    const list = readers(await c.changes.list())
    expect(list).toHaveLength(1)
    expect(list[0].outsideRequest?.id).toBe(readerRequestId(s.shareId, readerNoteOf(list[0])!.key))
  })

  test('markup and script in name and note stay plain text in the record', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post({ ...NOTE, name: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script> **bold**' })
    await collectReaderNotes(ports(c, s.client), [s.link])
    const [record] = readers(await c.changes.list())
    expect(readerNoteOf(record)).toMatchObject({ name: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script> **bold**' })
  })
})

describe('anchoring states as records', () => {
  test('passage edited since: a note sits on the nearest match, flagged, with the quoted words', async () => {
    const c = await collection(DOC.replace('they are ordered by', 'they are sorted by'))
    const s = await sharedPiece()
    await s.post(NOTE)
    await collectReaderNotes(ports(c, s.client), [s.link])
    const [record] = readers(await c.changes.list())
    expect(readerNoteOf(record)).toMatchObject({ anchored: 'changed', quote: 'they are ordered' })
    expect(record.status).toBe('pending')
    expect(record.oldText).toContain('sorted')
  })

  test('passage gone: a note is kept without a place, with the quoted words', async () => {
    const c = await collection('# Something else entirely\n\nNothing of the old text is here.\n')
    const s = await sharedPiece()
    await s.post(NOTE)
    await collectReaderNotes(ports(c, s.client), [s.link])
    const [record] = readers(await c.changes.list())
    expect(readerNoteOf(record)).toMatchObject({ anchored: 'gone', quote: 'they are ordered' })
    expect(record.oldText).toBe('they are ordered')
  })

  test('a proposed edit on changed text is closed with its reason, the wording kept, never acceptable', async () => {
    const c = await collection(DOC.replace('a reason for each entry', 'a reason for every entry'))
    const s = await sharedPiece()
    await s.post({ ...EDIT, anchor: { ...EDIT.anchor, quote: 'a reason for each entry', after: '. One line', start: null, end: null } })
    await collectReaderNotes(ports(c, s.client), [s.link])
    const [record] = readers(await c.changes.list())
    expect(closedReasonOf(record)).toBe(READER_EDIT_CHANGED('Jonas'))
    expect(record.outsideIntended).toMatchObject({ oldText: 'a reason for each entry', newText: EDIT.text })
    expect(record.oldText).toBe('')
  })
})

describe('only Accept writes', () => {
  async function withAgent(c: { root: string; workspace: Workspace; changes: ChangeStore }) {
    const appData = await mkdtemp(join(tmpdir(), 'wf-reader-notes-data-'))
    roots.push(appData)
    const agent = await WorkspaceAgent.create({ workspace: c.workspace, appDataDir: appData, changes: c.changes, onChangesChanged: () => {}, onTrace: () => {}, onApprovalRequest: () => {}, onSuggestionsChanged: () => {} })
    agents.push(agent)
    return agent
  }

  test('Accept on a proposed edit changes exactly the proposed words and nothing else', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(EDIT)
    await collectReaderNotes(ports(c, s.client), [s.link])
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(DOC)
    const [record] = readers(await c.changes.list())
    const agent = await withAgent(c)
    const result = await agent.resolveChange(record.id, 'accept')
    expect(result.applied).toBe(true)
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(DOC.replace('its reader a reason for', 'its reader a one-line reason for'))
  })

  test('Done on a note and Decline on an edit write nothing', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    await s.post(EDIT)
    await collectReaderNotes(ports(c, s.client), [s.link])
    const agent = await withAgent(c)
    const [note, edit] = readers(await c.changes.list()).sort((a) => (readerNoteOf(a)!.kind === 'note' ? -1 : 1))
    // The note's words edited since: Done still settles it, and still writes nothing.
    await writeFile(join(c.root, PIECE), DOC.replace('they are ordered', 'they come ordered'))
    const before = await readFile(join(c.root, PIECE))
    expect((await agent.resolveChange(note.id, 'accept')).applied).toBe(true)
    expect((await agent.resolveChange(edit.id, 'reject')).applied).toBe(true)
    expect(Buffer.compare(await readFile(join(c.root, PIECE)), before)).toBe(0)
    expect((await c.changes.get(note.id))?.status).toBe('accepted')
  })

  test('the words now stand twice, after their place: Accept writes at the place the reader wrote on, and the reader is told Accepted (ticket 14)', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(EDIT)
    await collectReaderNotes(ports(c, s.client), [s.link])
    const [record] = readers(await c.changes.list())
    // The same words added later in the piece: the record's text is no longer unique, its span still holds it.
    const twice = `${DOC}\nGive a reason for the order too.\n`
    expect(twice.split(record.oldText).length - 1).toBe(2)
    await writeFile(join(c.root, PIECE), twice)
    const agent = await withAgent(c)
    const result = await agent.resolveChange(record.id, 'accept')
    expect(result.applied).toBe(true)
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(twice.replace('its reader a reason for', 'its reader a one-line reason for'))
    expect(readerOutcomeOf((await c.changes.get(record.id))!)).toBe('accepted')
  })

  test('the words changed after collecting: Accept writes nothing and decides nothing; no outcome goes to the reader (ticket 14)', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(EDIT)
    await collectReaderNotes(ports(c, s.client), [s.link])
    const changed = DOC.replace('a reason for each entry', 'a cause for each entry')
    await writeFile(join(c.root, PIECE), changed)
    const [record] = readers(await c.changes.list())
    const agent = await withAgent(c)
    const result = await agent.resolveChange(record.id, 'accept')
    expect(result.applied).toBe(false)
    expect(result.message).toMatch(/not found/)
    expect(result.closed).toBeUndefined()
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(changed)
    const after = (await c.changes.get(record.id))!
    expect(after.status).toBe('pending')
    expect(closedReasonOf(after)).toBeNull()
    // Still waiting: the reader's page is told nothing (neither Declined nor Could not be applied).
    expect(readerOutcomeOf(after)).toBeNull()
  })
})

describe('part 2: a Folio link, the Limits panel, counts', () => {
  const PART_A = 'pack/a.md'
  const PART_B = 'pack/b.md'
  // The same sentence stands in both parts; the reader wrote on part B.
  const SAME = 'Start with a question that the list answers.'
  async function folio(): Promise<{ root: string; workspace: Workspace; changes: ChangeStore }> {
    const c = await collection()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(c.root, 'pack'), { recursive: true })
    await writeFile(join(c.root, PART_A), `# Part A\n\nOpening words. ${SAME} Then part A goes on.\n`)
    await writeFile(join(c.root, PART_B), `# Part B\n\nClosing words. ${SAME} Then part B goes on.\n`)
    return c
  }
  const onSame = (block: string | null) => ({ kind: 'note', name: 'Marta', text: 'Which question?', anchor: { quote: 'a question that the list answers', before: 'Start with', after: '. Then part', block, start: null, end: null } })

  test('a note on a Folio link lands in the part its block hint names (the part key), even when the words stand in another part too', async () => {
    const c = await folio()
    const s = await sharedPiece()
    // Part keys as the publisher keeps them (ShareRecord.partKeys): every id in part B starts with "kbbbbb-".
    const link: ReaderLinkSource = { ...s.link, paths: [PART_A, PART_B], partKeys: { [PART_A]: 'kaaaaa', [PART_B]: 'kbbbbb' } }
    await s.post(onSame('id:kbbbbb-p-1'))
    await collectReaderNotes(ports(c, s.client), [link])
    const [record] = readers(await c.changes.list())
    expect(record.path).toBe(PART_B)
    expect(readerNoteOf(record)).toMatchObject({ anchored: 'unchanged' })
    expect(readerNoteOf(record)?.ambiguous).toBeUndefined()
    // The words it sits beside, as they stand once in part B.
    const partB = await readFile(join(c.root, PART_B), 'utf8')
    expect(partB.slice(record.anchor!.from, record.anchor!.to)).toBe(readerNoteOf(record)!.words!)
    expect(partB.indexOf(readerNoteOf(record)!.words!)).toBe(partB.lastIndexOf(readerNoteOf(record)!.words!))
  })

  test('the same words in two parts and no hint naming either: placed in the first part and flagged ambiguous', async () => {
    const c = await folio()
    const s = await sharedPiece()
    const link: ReaderLinkSource = { ...s.link, paths: [PART_A, PART_B], partKeys: { [PART_A]: 'kaaaaa', [PART_B]: 'kbbbbb' } }
    await s.post(onSame('id:kzzzzz-p-1'))
    await collectReaderNotes(ports(c, s.client), [link])
    const [record] = readers(await c.changes.list())
    expect(record.path).toBe(PART_A)
    expect(readerNoteOf(record)?.ambiguous).toBe(true)
  })

  test('the hint never wins over the words: the hinted part changed, another part has them as written', async () => {
    const c = await folio()
    await writeFile(join(c.root, PART_B), '# Part B\n\nClosing words. Start with a puzzle that the list answers. Then part B goes on.\n')
    const s = await sharedPiece()
    const link: ReaderLinkSource = { ...s.link, paths: [PART_A, PART_B], partKeys: { [PART_A]: 'kaaaaa', [PART_B]: 'kbbbbb' } }
    await s.post(onSame('id:kbbbbb-p-1'))
    await collectReaderNotes(ports(c, s.client), [link])
    const [record] = readers(await c.changes.list())
    expect(record.path).toBe(PART_A)
    expect(readerNoteOf(record)).toMatchObject({ anchored: 'unchanged' })
  })

  test('a closed edit keeps the words it was placed beside, so the margin can draw it there', async () => {
    const c = await collection(DOC.replace('a reason for each entry', 'a good reason for each entry'))
    const s = await sharedPiece()
    await s.post(EDIT)
    await collectReaderNotes(ports(c, s.client), [s.link])
    const [record] = readers(await c.changes.list())
    expect(record.status).toBe('rejected')
    const words = readerNoteOf(record)!.words!
    expect(words).toContain('reason')
    const doc = await readFile(join(c.root, PIECE), 'utf8')
    expect(doc.slice(record.anchor!.from, record.anchor!.to)).toBe(words)
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(DOC.replace('a reason for each entry', 'a good reason for each entry'))
  })

  test('the service states each link\'s limits; collecting carries them and what was refused', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    const outcome = await collectReaderNotes(ports(c, s.client), [s.link])
    expect(outcome.limits[s.shareId]).toEqual({ factor: 1, most: 4, perHour: 200, waiting: 1000, total: 5000 })
    expect(outcome.refused[s.shareId]).toMatchObject({ total: 0 })
    expect(checkedLimits({ factor: 8, most: 4, perHour: 1, waiting: 1, total: 1 })).toBeNull()
    expect(checkedLimits(undefined)).toBeNull()
  })

  test('the Limits panel counts only refusals under a limit since the writer last acted, and names the limit most ran into', () => {
    const refused = { total: 30, byReason: { share_rate: 14, reader_rate: 3, comments_off: 13 }, more: [], lastAt: 1 }
    const limits = { factor: 1, most: 4, perHour: 200, waiting: 1000, total: 5000 }
    expect(limitReachedOf(refused, {}, limits)).toEqual({ refused: 17, more: false, kind: 'share_rate', figure: 200, raisable: true })
    // Acted on: nothing new, no panel. Comments off is no limit.
    expect(limitReachedOf(refused, { share_rate: 14, reader_rate: 3 }, limits)).toBeNull()
    expect(limitReachedOf({ ...refused, byReason: { ...refused.byReason, share_rate: 20 }, more: ['share_rate'] }, { share_rate: 14, reader_rate: 3 }, { ...limits, factor: 4 })).toEqual({ refused: 6, more: true, kind: 'share_rate', figure: 200, raisable: false })
    // A service older than build 5 states no limits: the default figure, and no Raise.
    expect(limitReachedOf({ total: 2, byReason: { share_total: 2 }, more: [], lastAt: 1 }, {}, null)).toMatchObject({ kind: 'share_total', figure: 5000, raisable: false })
    expect(limitReachedOf(null, {}, limits)).toBeNull()
  })

  test('readers\' records per link: undecided are waiting, decided (done, declined, closed) are handled', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(NOTE)
    await s.post(EDIT)
    await s.post({ ...EDIT, name: 'Jonas', anchor: { ...EDIT.anchor, quote: 'words that are gone', before: 'nowhere', after: 'at all', start: null, end: null } })
    await collectReaderNotes(ports(c, s.client), [s.link])
    const list = await c.changes.list()
    const note = readers(list).find((change) => readerNoteOf(change)?.kind === 'note')!
    await c.changes.setStatus(note.id, 'accepted')
    const records = readerNoteRecords(await c.changes.list())
    expect(records.filter((r) => r.shareId === s.shareId && !r.settled)).toHaveLength(1)
    expect(records.filter((r) => r.shareId === s.shareId && r.settled)).toHaveLength(2)
    expect(records.every((r) => r.key.includes('.'))).toBe(true)
  })
})

describe('review round 1: nothing is closed or marked collected because of a passing failure', () => {
  /** A service answering exactly these notes (checked as any answer is), recording what is marked collected. */
  function served(notes: unknown[], limits?: unknown) {
    const marked: string[] = []
    const over: Partial<ReaderNotesPorts> = {
      fetchNotes: async () => ({ kind: 'ok' as const, status: 200, body: { notes, more: false, refused: {}, ...(limits === undefined ? {} : { limits }) } }),
      markCollected: async (_b, _id, _o, keys) => { marked.push(...keys); return { kind: 'ok' as const, status: 200, body: {} } },
    }
    return { over, marked }
  }
  /** Never asked: every answer here comes from `served`. */
  const noNetwork = () => createServiceClient({ fetch: async () => { throw new Error('no network in tests') } })
  const asServed = (note: Record<string, unknown>, key: string) => ({ key, id: key, writtenAt: 1, receivedAt: 1, ...note })

  test('P2-1: a note the ledger drops is counted and left on the service, never marked collected, and comes again', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(EDIT)
    const dropped: ReaderNotesPorts['changes'] = { addOutside: async (entries) => entries.map((entry) => ({ requestId: entry.requestId, outcome: 'dropped' as const, changes: [] })) }
    const out = await collectReaderNotes(ports(c, s.client, { changes: dropped }), [s.link])
    expect(out).toMatchObject({ added: 0, repeats: 0, full: 0, dropped: 1 })
    expect(await s.waiting()).toBe(1)
    expect((await collectReaderNotes(ports(c, s.client), [s.link])).added).toBe(1)
    expect(await s.waiting()).toBe(0)
  })

  test('P2-2: a document that cannot be read just now skips the link: nothing filed, nothing marked, and the next look places it', async () => {
    const c = await collection()
    const s = await sharedPiece()
    await s.post(EDIT)
    for (const unreadable of [async () => null, async () => { throw new Error('iCloud placeholder') }]) {
      const out = await collectReaderNotes(ports(c, s.client, { readDocument: unreadable }), [s.link])
      expect(out).toMatchObject({ added: 0, failed: [s.shareId] })
      expect(readers(await c.changes.list())).toHaveLength(0)
      expect(await s.waiting()).toBe(1)
    }
    expect((await collectReaderNotes(ports(c, s.client), [s.link])).added).toBe(1)
    const [record] = readers(await c.changes.list())
    expect(readerNoteOf(record)).toMatchObject({ anchored: 'unchanged' })
    expect(record.status).toBe('pending')
    expect(closedReasonOf(record)).not.toBe(READER_EDIT_GONE('Jonas', EDIT.anchor.quote))
  })

  test('P2-2: one part of a Folio link unreadable skips the whole link; "gone" is filed only against documents read', async () => {
    const c = await collection()
    await writeFile(join(c.root, 'other.md'), '# Other\n\nNothing like it.\n')
    const s = await sharedPiece()
    await s.post(EDIT)
    const link: ReaderLinkSource = { ...s.link, paths: ['other.md', PIECE] }
    const read = guardedDocumentReader(c.workspace)
    const out = await collectReaderNotes(ports(c, s.client, { readDocument: async (path) => (path === PIECE ? null : read(path)) }), [link])
    expect(out.failed).toEqual([s.shareId])
    expect(readers(await c.changes.list())).toHaveLength(0)
    expect(await s.waiting()).toBe(1)
    // A link with no documents at all is not "gone" either.
    expect((await collectReaderNotes(ports(c, s.client), [{ ...s.link, paths: [] }])).failed).toEqual([s.shareId])
    expect(await s.waiting()).toBe(1)
  })

  test('P3-1: the words stand once as the reader saw them but the passage around them is repeated: its own reason, not "no longer in the piece"', async () => {
    const c = await collection('# T\n\nFirst part.\n\nOne line is enough.\n\nSecond part.\n\nOne line is enough.\n')
    const { over, marked } = served([asServed({ kind: 'edit', name: 'Jonas', text: 'sentence', anchor: { quote: 'line', before: 'Second part. One', after: 'is enough.', block: null, start: null, end: null } }, 'k.1')])
    await collectReaderNotes(ports(c, noNetwork(), over), [{ shareId: 'share-one', label: 'For Marta', paths: [PIECE], base: ORIGIN, owner: 'x' }])
    const [record] = readers(await c.changes.list())
    expect(record.status).toBe('rejected')
    expect(closedReasonOf(record)).toBe(READER_EDIT_REPEATED_PASSAGE('Jonas', 'line'))
    expect(closedReasonOf(record)).not.toContain('no longer in the piece')
    expect(record.outsideIntended).toMatchObject({ oldText: 'line', newText: 'sentence' })
    expect(marked).toEqual(['k.1'])
  })

  test('P3-3: an edit whose replacement runs over more than one line is born closed with its own reason, the wording kept for Copy', async () => {
    const c = await collection()
    for (const [key, text] of [['k.lf', 'a reason\n\n# Heading'], ['k.cr', 'a reason\r- item'], ['k.ls', 'a reason\u2028more']] as const) {
      const { over } = served([asServed({ ...EDIT, text }, key)])
      await collectReaderNotes(ports(c, noNetwork(), over), [{ shareId: 'share-one', label: 'For Marta', paths: [PIECE], base: ORIGIN, owner: 'x' }])
    }
    const list = readers(await c.changes.list())
    expect(list).toHaveLength(3)
    for (const record of list) {
      expect(record.status).toBe('rejected')
      expect(closedReasonOf(record)).toBe(READER_EDIT_MULTILINE('Jonas'))
      expect(record.newText).toBe('')
    }
    expect(list.map((record) => record.outsideIntended?.newText)).toEqual(['a reason\n\n# Heading', 'a reason\r- item', 'a reason\u2028more'])
    expect(await readFile(join(c.root, PIECE), 'utf8')).toBe(DOC)
  })

  test('P3-2: limits not as the service promises are not reported, so the limits last known stand; absent limits read as an older service', async () => {
    const c = await collection()
    const link: ReaderLinkSource = { shareId: 'share-one', label: 'For Marta', paths: [PIECE], base: ORIGIN, owner: 'x' }
    const malformed = await collectReaderNotes(ports(c, noNetwork(), served([], { factor: 'two' }).over), [link])
    expect('share-one' in malformed.limits).toBe(false)
    const absent = await collectReaderNotes(ports(c, noNetwork(), served([]).over), [link])
    expect(absent.limits['share-one']).toBeNull()
  })
})

describe('ticket 11: review follow-ups', () => {
  /**
   * A link's notes as the service hands them to the author (shared-piece.ts `waitingNotes`): the oldest
   * 200 not yet collected, `more` when there are others, no later page. Collected ones go.
   */
  function pagedService(notes: Array<Record<string, unknown>>) {
    const waiting = [...notes]
    const over: Partial<ReaderNotesPorts> = {
      fetchNotes: async () => ({ kind: 'ok' as const, status: 200, body: { notes: waiting.slice(0, NOTE_LIMITS.collectBatch), more: waiting.length > NOTE_LIMITS.collectBatch, refused: {} } }),
      markCollected: async (_b, _id, _o, keys) => {
        for (const key of keys) { const at = waiting.findIndex((note) => note.key === key); if (at >= 0) waiting.splice(at, 1) }
        return { kind: 'ok' as const, status: 200, body: {} }
      },
    }
    return { over, waiting }
  }
  const noNetwork = () => createServiceClient({ fetch: async () => { throw new Error('no network in tests') } })
  const asServed = (note: Record<string, unknown>, key: string) => ({ key, id: key, writtenAt: 1, receivedAt: 1, ...note })
  /** An edit on words no longer in the piece: filed closed, never acceptable. */
  const GONE_EDIT = { ...EDIT, anchor: { quote: 'words that were cut', before: '', after: '', block: null, start: null, end: null } }

  test('07-A: with the closed-records limit reached, 200 closed edits at the head of a link do not stall its later notes', async () => {
    const c = await collection()
    const link: ReaderLinkSource = { shareId: 'share-one', label: 'For Marta', paths: [PIECE], base: ORIGIN, owner: 'x' }
    const documents = [{ path: PIECE, content: DOC }]
    // The ledger already holds as many closed records from outside as it takes.
    const seed = Array.from({ length: MAX_REFUSED_OUTSIDE_RECORDS }, (_, i) => ({ requestId: `seed-${i}`, changes: [readerChangeFor(checkedNote(asServed(GONE_EDIT, `seed${i}`))!, { ...link, shareId: 'share-old' }, documents, Date.now())] }))
    const seeded = await c.changes.addOutside(seed, { maxUndecided: MAX_UNDECIDED_OUTSIDE_CHANGES, maxUndecidedBytes: MAX_UNDECIDED_OUTSIDE_BYTES, maxRefused: MAX_REFUSED_OUTSIDE_RECORDS, maxPerSource: MAX_UNDECIDED_PER_SOURCE, maxPerRequest: MAX_CHANGES_PER_REQUEST })
    expect(seeded.every((result) => result.outcome === 'added')).toBe(true)
    // 200 edits that cannot be applied, then a note: the service shows the 200 first.
    const s = pagedService([...Array.from({ length: 200 }, (_, i) => asServed(GONE_EDIT, `edit${i}`)), asServed(NOTE, 'later')])
    let arrived = false
    for (let look = 0; look < 3 && !arrived; look += 1) {
      await collectReaderNotes(ports(c, noNetwork(), s.over), [link])
      arrived = readers(await c.changes.list()).some((change) => readerNoteOf(change)?.key === 'later')
    }
    expect(arrived).toBe(true)
    expect(s.waiting).toHaveLength(0)
  })

  test('review round 1 F1: repeated clear-and-collect cycles keep a link\'s closed records within the bound; a note the service still holds is never dropped or filed twice', async () => {
    const c = await collection()
    const link: ReaderLinkSource = { shareId: 'share-one', label: 'For Marta', paths: [PIECE], base: ORIGIN, owner: 'x' }
    // The service: notes waiting (not collected) and held (collected, not cleared). Clear takes held ones off.
    const s = pagedService([])
    const held = new Set<string>()
    const markCollected = s.over.markCollected!
    s.over.markCollected = async (b, id, o, keys) => { for (const key of keys) held.add(key); return markCollected(b, id, o, keys) }
    const closedOf = async () => (await c.changes.list()).filter((change) => isRefusedOutsideChange(change) && readerNoteOf(change)?.shareId === link.shareId)
    const clearAll = async () => {
      const keys = (await closedOf()).map((change) => readerNoteOf(change)!.key).filter((key) => held.has(key))
      for (const key of keys) held.delete(key)
      await c.changes.markReaderNotesGone(link.shareId, keys, Date.now(), READER_CLOSED_KEPT)
    }
    const cycles = Math.ceil(READER_CLOSED_KEPT / NOTE_LIMITS.collectBatch) + 3
    let n = 0
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let i = 0; i < NOTE_LIMITS.collectBatch; i += 1) s.waiting.push(asServed(GONE_EDIT, `edit${n++}`))
      await collectReaderNotes(ports(c, noNetwork(), s.over), [link])
      expect(s.waiting).toHaveLength(0)
      expect((await closedOf()).length).toBeLessThanOrEqual(READER_CLOSED_KEPT)
      await clearAll()
      expect((await closedOf()).length).toBeLessThanOrEqual(READER_CLOSED_KEPT)
    }
    expect(n).toBeGreaterThan(READER_CLOSED_KEPT)
    // The oldest went first: the newest are kept.
    const keptKeys = (await closedOf()).map((change) => readerNoteOf(change)!.key)
    expect(keptKeys.at(-1)).toBe(`edit${n - 1}`)
    expect(keptKeys).not.toContain('edit0')
    // A batch the service still holds (not cleared): never dropped, whatever the bound.
    for (let i = 0; i < NOTE_LIMITS.collectBatch; i += 1) s.waiting.push(asServed(GONE_EDIT, `edit${n++}`))
    await collectReaderNotes(ports(c, noNetwork(), s.over), [link])
    const closed = await closedOf()
    expect(closed.length).toBeLessThanOrEqual(READER_CLOSED_KEPT)
    const stillHeld = closed.filter((change) => typeof (change as Change & { readerGone?: number }).readerGone !== 'number').map((change) => readerNoteOf(change)!.key)
    expect(stillHeld.sort()).toEqual([...held].sort())
    // Every note the service holds and asks for again (marking failed) is a repeat, never filed twice.
    s.waiting.push(...[...held].map((key) => asServed(GONE_EDIT, key)))
    const again = await collectReaderNotes(ports(c, noNetwork(), s.over), [link])
    expect(again).toMatchObject({ added: 0, repeats: held.size })
    const keys = (await c.changes.list()).map((change) => readerNoteOf(change)?.key).filter((key) => key !== undefined)
    expect(new Set(keys).size).toBe(keys.length)
  }, 60_000)
})
