// 0.24 ticket 07, part 2, at the Sharing page's seam (src/main/sharing-piece-ipc.ts `sharing:notes`,
// `sharing:clear-handled`, `sharing:raise-limit`, `sharing:set-comments`) over the real publisher, the
// real collector and the real sharing service in memory. Spec 4.6 (notes waiting, notes handled) and
// 6.1 "Limits reached" (frame `problems`): how many were refused and on which link; Clear, Raise the
// limit for this link, Turn comments off. The authority of tickets 03 and 10 holds: only links main
// bound for the window, no answer carries a token, and nothing here writes to a piece.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerSharingPieceIpc } from '../../src/main/sharing-piece-ipc.ts'
import { createServiceClient } from '../../src/main/sharing-client.ts'
import { READER_CLOSED_KEPT, readerNoteRecords } from '../../src/main/sharing-reader-notes.ts'
import { limitsFor, readerLinksChanged, refusedFor, setLimitsFor, setReaderNotesSource, startReaderNotesCollection } from '../../src/main/sharing-reader-notes-run.ts'
import { ChangeStore } from '../../src/main/changes.ts'
import { Workspace } from '../../src/main/workspace.ts'
import { NOTE_LIMITS } from '../../sharing-service/reader-notes.ts'
import { LIMITS_NOT_HERE, LIMITS_OLD_SERVICE, type LimitsActionResult, type NotesCounts } from '../../src/shared/sharing-notes.ts'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const PIECE = 'Reading list.md'
const TEXT = '# Reading list\n\nA list owes its reader a reason for each entry. One line is enough.\n'

async function limitsWorld() {
  const w = await publishWorld({ files: { [PIECE]: TEXT, 'Other.md': '# Other\n\nAnother piece.\n' } })
  const handlers = new Map<string, (event: { sender: { id: number } }, input?: unknown) => unknown>()
  const workspace = new Workspace(w.root)
  const changes = new ChangeStore(workspace)
  registerSharingPieceIpc({ handle: (channel, listener) => { handlers.set(channel, listener) } }, w.publisher, {
    isAppWindow: (id) => id === 1 || id === 2,
    rootFor: (id) => (id === 1 || id === 2 ? w.root : null),
    openExternal: () => {},
    readerNotes: async () => readerNoteRecords(await changes.list()),
    readerNotesGone: (_sender, shareId, keys) => changes.markReaderNotesGone(shareId, keys, Date.now(), READER_CLOSED_KEPT),
  })
  const call = <T = unknown>(channel: string, sender: number, input?: unknown) => handlers.get(channel)!({ sender: { id: sender } }, input) as Promise<T>
  const made = await w.publisher.make(w.root, PIECE, { name: 'Workshop group', comments: true })
  if (!made.ok || !made.shareId) throw new Error('no link')
  const shareId = made.shareId
  await w.publisher.idle()
  const base = w.setup.serviceAccess()!.base
  const client = createServiceClient({ fetch: (input, init) => w.fake.serviceFetch(input, init) })
  setReaderNotesSource({
    links: (root) => w.publisher.noteSources(root),
    shareIds: () => w.publisher.noteShareIds(),
    fetchNotes: (b, id, owner) => client.notes(b, id, owner),
    markCollected: (b, id, owner, keys) => client.collected(b, id, owner, keys),
  })
  const run = startReaderNotesCollection({ workspace, changes, owns: () => true, onCollected: () => {}, intervalMs: 3_600_000 })
  let n = 0
  const post = (note: Record<string, unknown>, network = '198.51.100.1') => w.fake.serviceFetch(`${base}/s/${shareId}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': network },
    body: JSON.stringify({ reader: `${'r'.repeat(40)}${String(n++).padStart(3, '0')}`, note: { id: `note-${n}-${Date.now()}`, kind: 'note', name: 'Marta', text: 'Which reason?', anchor: { quote: 'a reason', before: 'owes its reader', after: 'for each entry' }, writtenAt: Date.now(), revision: 1, ...note } }),
  })
  const db = () => (w.svc.shares.states.get(shareId) as unknown as { db: { query: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] } } }).db
  /** Fill the share's hour with notes already collected, as a busy workshop would. */
  const fillHour = (count: number) => {
    const fill = db().query(`INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, received_at, collected_at) VALUES (?, ?, 'note', 'Annabel', 'x', 'x', '', '', ?, ?)`)
    for (let i = 0; i < count; i += 1) fill.run(`${i}`.padStart(64, 'c'), `filled-${i}`, Date.now(), Date.now())
  }
  const tokens = () => Object.values(JSON.parse(w.secrets.store.read('sharing-links')!).tokens as Record<string, string>)
  return { w, call, shareId, changes, run, post, db, fillHour, tokens }
}

test('notes waiting and handled: the window\'s own review list, per link it has bound, and nothing for a window that has bound none', async () => {
  const t = await limitsWorld()
  expect((await t.post({})).status).toBe(201)
  expect((await t.post({ text: 'Another question' })).status).toBe(201)
  await t.run.look()
  await t.call('sharing:open', 1, PIECE)
  let counts = await t.call<NotesCounts>('sharing:notes', 1)
  expect(counts[t.shareId]).toEqual({ waiting: 2, handled: 0, limit: null })
  const [first] = (await t.changes.list()).filter((change) => change.outsideSource === 'reader')
  await t.changes.setStatus(first.id, 'accepted')
  counts = await t.call<NotesCounts>('sharing:notes', 1)
  expect(counts[t.shareId]).toEqual({ waiting: 1, handled: 1, limit: null })
  // Window 2 has bound nothing; on another piece's page, not this link.
  expect(await t.call('sharing:notes', 2)).toEqual({})
  await t.call('sharing:open', 2, 'Other.md')
  expect(Object.keys(await t.call<NotesCounts>('sharing:notes', 2))).toEqual([])
  // The Shares list binds every link of the Workspace: the same counts.
  await t.call('sharing:open-list', 2)
  expect((await t.call<NotesCounts>('sharing:notes', 2))[t.shareId]).toMatchObject({ waiting: 1, handled: 1 })
  // The piece was never written.
  expect(readFileSync(join(t.w.root, PIECE), 'utf8')).toBe(TEXT)
  t.run.dispose()
})

test('a link that reached its limit shows how many were refused; Raise the limit for this link lets notes in again, and the panel goes', async () => {
  const t = await limitsWorld()
  t.fillHour(NOTE_LIMITS.sharePerHour)
  expect((await t.post({})).status).toBe(429)
  expect((await t.post({}, '198.51.100.2')).status).toBe(429)
  await t.run.look()
  await t.call('sharing:open', 1, PIECE)
  const counts = await t.call<NotesCounts>('sharing:notes', 1)
  expect(counts[t.shareId].limit).toEqual({ refused: 2, more: false, kind: 'share_rate', figure: NOTE_LIMITS.sharePerHour, raisable: true })
  // Another window's page, not bound to this link, cannot raise or clear it.
  await t.call('sharing:open', 2, 'Other.md')
  expect(await t.call<LimitsActionResult>('sharing:raise-limit', 2, { shareId: t.shareId })).toEqual({ ok: false, problem: LIMITS_NOT_HERE })
  expect(await t.call<LimitsActionResult>('sharing:clear-handled', 2, { shareId: t.shareId })).toEqual({ ok: false, problem: LIMITS_NOT_HERE })
  expect(t.db().query('SELECT note_factor FROM share').get()).toEqual({ note_factor: 1 })

  const raised = await t.call<LimitsActionResult>('sharing:raise-limit', 1, { shareId: t.shareId })
  expect(raised).toEqual({ ok: true, message: `The limit for this link is raised: it now takes ${(2 * NOTE_LIMITS.sharePerHour).toLocaleString('en-GB')} comments an hour.` })
  expect(t.db().query('SELECT note_factor FROM share').get()).toEqual({ note_factor: 2 })
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit).toBeNull()
  expect((await t.post({}, '198.51.100.3')).status).toBe(201)
  // No answer carries an owner token.
  for (const token of t.tokens()) expect(JSON.stringify([raised, await t.call('sharing:notes', 1)])).not.toContain(token)
  t.run.dispose()
})

test('Clear handled notes deletes on the service only the link\'s notes decided in the review list, never one still waiting', async () => {
  const t = await limitsWorld()
  for (let i = 0; i < 3; i += 1) expect((await t.post({ text: `Question ${i}` })).status).toBe(201)
  await t.run.look()
  const records = (await t.changes.list()).filter((change) => change.outsideSource === 'reader')
  await t.changes.setStatus(records[0].id, 'accepted')
  await t.changes.setStatus(records[1].id, 'rejected')
  t.fillHour(NOTE_LIMITS.sharePerHour)
  expect((await t.post({}, '198.51.100.9')).status).toBe(429)
  await t.run.look()
  await t.call('sharing:open', 1, PIECE)
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit?.refused).toBe(1)
  const cleared = await t.call<LimitsActionResult>('sharing:clear-handled', 1, { shareId: t.shareId })
  expect(cleared).toEqual({ ok: true, message: 'Cleared 2 handled comments from the sharing service.' })
  const left = (t.db().query('SELECT text FROM notes WHERE text != ?').all('x') as Array<{ text: string }>).map((row) => row.text)
  expect(left).toEqual(['Question 2'])
  // The review list keeps every record; only the service's copies went.
  expect((await t.changes.list()).filter((change) => change.outsideSource === 'reader')).toHaveLength(3)
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId]).toEqual({ waiting: 1, handled: 2, limit: null })
  // Refused again later: the panel comes back with only the new refusals.
  expect((await t.post({}, '198.51.100.10')).status).toBe(429)
  await t.run.look()
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit?.refused).toBe(1)
  expect(readFileSync(join(t.w.root, PIECE), 'utf8')).toBe(TEXT)
  t.run.dispose()
})

test('Turn comments off publishes the link with comments off and takes the panel away; a service older than build 5 is told plainly', async () => {
  const t = await limitsWorld()
  t.fillHour(NOTE_LIMITS.sharePerHour)
  expect((await t.post({})).status).toBe(429)
  await t.run.look()
  await t.call('sharing:open', 1, PIECE)
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit).not.toBeNull()
  const off = await t.call<{ ok: boolean }>('sharing:set-comments', 1, { shareId: t.shareId, comments: false })
  expect(off.ok).toBe(true)
  await t.w.publisher.idle()
  expect(t.w.publishes().at(-1)?.body.comments).toBe(false)
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit).toBeNull()
  // Refused because comments are off is no limit: no panel.
  expect((await t.post({}, '198.51.100.4')).status).toBe(403)
  await t.run.look()
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit).toBeNull()
  // A service that states no limits (older than build 5) has neither route.
  setLimitsFor(t.shareId, null)
  expect(await t.call<LimitsActionResult>('sharing:raise-limit', 1, { shareId: t.shareId })).toEqual({ ok: false, problem: LIMITS_OLD_SERVICE })
  expect(await t.call<LimitsActionResult>('sharing:clear-handled', 1, { shareId: t.shareId })).toEqual({ ok: false, problem: LIMITS_OLD_SERVICE })
  t.run.dispose()
})

test('review round 1, P3-2: Raise answered "at most" with a body not as the service promises keeps the limits last known, never "older service"', async () => {
  const t = await limitsWorld()
  t.fillHour(NOTE_LIMITS.sharePerHour)
  expect((await t.post({})).status).toBe(429)
  await t.run.look()
  await t.call('sharing:open', 1, PIECE)
  const known = limitsFor(t.shareId)
  expect(known).toMatchObject({ factor: 1, perHour: NOTE_LIMITS.sharePerHour })
  const real = t.w.publisher.raiseLimit
  t.w.publisher.raiseLimit = async () => ({ ok: false as const, why: 'at-most' as const, limits: { factor: 'lots' } })
  const answer = await t.call<LimitsActionResult>('sharing:raise-limit', 1, { shareId: t.shareId })
  expect(answer.ok).toBe(false)
  expect(limitsFor(t.shareId)).toEqual(known)
  // The page still offers Raise: the service is not taken for one older than build 5.
  expect((await t.call<NotesCounts>('sharing:notes', 1))[t.shareId].limit?.raisable).toBe(true)
  // A malformed success body says nothing either.
  t.w.publisher.raiseLimit = async () => ({ ok: true as const, limits: null })
  expect((await t.call<LimitsActionResult>('sharing:raise-limit', 1, { shareId: t.shareId })).ok).toBe(true)
  expect(limitsFor(t.shareId)).toEqual(known)
  t.w.publisher.raiseLimit = real
  // Clear is not refused as an older service.
  expect(await t.call<LimitsActionResult>('sharing:clear-handled', 1, { shareId: t.shareId })).not.toEqual({ ok: false, problem: LIMITS_OLD_SERVICE })
  t.run.dispose()
})

test('review round 1, P3-4: what is kept per link (refused, limits) goes when the link is removed', async () => {
  const t = await limitsWorld()
  await t.run.look()
  expect(refusedFor(t.shareId)).not.toBeNull()
  expect(limitsFor(t.shareId)).not.toBeUndefined()
  expect(t.w.publisher.noteShareIds()).toContain(t.shareId)
  // Another link's entry, kept while that link is live.
  setLimitsFor('kept-elsewhere', null)
  const live = new Set([...(t.w.publisher.noteShareIds() ?? []), 'kept-elsewhere'])
  setReaderNotesSource({ links: () => [], fetchNotes: async () => ({ kind: 'unreachable' as const }), markCollected: async () => ({ kind: 'unreachable' as const }), shareIds: () => [...live] })
  readerLinksChanged()
  expect(refusedFor(t.shareId)).not.toBeNull()
  // The link removed: its owner token gone, so it is no longer a note source anywhere.
  const store = JSON.parse(t.w.secrets.store.read('sharing-links')!) as { format: unknown; tokens: Record<string, string> }
  delete store.tokens[t.shareId]
  t.w.secrets.store.write('sharing-links', JSON.stringify(store))
  live.delete(t.shareId)
  for (const id of t.w.publisher.noteShareIds() ?? []) live.add(id)
  expect(t.w.publisher.noteShareIds()).not.toContain(t.shareId)
  readerLinksChanged()
  expect(refusedFor(t.shareId)).toBeNull()
  expect(limitsFor(t.shareId)).toBeUndefined()
  expect(limitsFor('kept-elsewhere')).toBeNull()
  t.run.dispose()
})

test('ticket 11, review 07 P3-B: a token read that fails prunes nothing; after a good look the link\'s limits and refusals are intact', async () => {
  const t = await limitsWorld()
  await t.run.look()
  const refused = refusedFor(t.shareId)
  const limits = limitsFor(t.shareId)
  expect(refused).not.toBeNull()
  expect(limits).not.toBeUndefined()
  // The Keychain cannot be read just now: the publisher cannot say which links have a token.
  const read = t.w.secrets.files.read
  t.w.secrets.files.read = () => { throw Object.assign(new Error('keychain locked'), { code: 'EACCES' }) }
  expect(t.w.publisher.noteShareIds()).toBeNull()
  readerLinksChanged()
  await t.run.look()
  expect(refusedFor(t.shareId)).toEqual(refused)
  expect(limitsFor(t.shareId)).toEqual(limits)
  // Read again: the next look finds the link and keeps what it holds.
  t.w.secrets.files.read = read
  await t.run.look()
  expect(refusedFor(t.shareId)).not.toBeNull()
  expect(limitsFor(t.shareId)).not.toBeUndefined()
  t.run.dispose()
})

test('ticket 11, review 07 P3-C: a look whose only outcome is a link skipped writes its log line, with counts only', async () => {
  const t = await limitsWorld()
  t.run.dispose()
  const reports: Array<{ event: string; details: Record<string, unknown> }> = []
  setReaderNotesSource({
    links: (root) => t.w.publisher.noteSources(root),
    shareIds: () => t.w.publisher.noteShareIds(),
    fetchNotes: async () => ({ kind: 'unreachable' as const }),
    markCollected: async () => ({ kind: 'unreachable' as const }),
  })
  const run = startReaderNotesCollection({ workspace: new Workspace(t.w.root), changes: t.changes, owns: () => true, onCollected: () => {}, report: (event, details) => { reports.push({ event, details }) }, intervalMs: 3_600_000 })
  await run.look()
  run.dispose()
  expect(reports.filter((entry) => entry.event === 'reader-notes.look').map((entry) => entry.details)).toContainEqual({ added: 0, repeats: 0, full: 0, dropped: 0, failed: 1 })
  const logged = JSON.stringify(reports)
  for (const token of t.tokens()) expect(logged).not.toContain(token)
  expect(logged).not.toContain(t.shareId)
})

test('ticket 11, review round 1 F3: a link removed while the token read failed has its limits and refusals pruned by the next look with no link left', async () => {
  const t = await limitsWorld()
  await t.run.look()
  expect(refusedFor(t.shareId)).not.toBeNull()
  expect(limitsFor(t.shareId)).not.toBeUndefined()
  // The link removed (its owner token gone) while the Keychain cannot be read: the change prunes nothing.
  const store = JSON.parse(t.w.secrets.store.read('sharing-links')!) as { format: unknown; tokens: Record<string, string> }
  delete store.tokens[t.shareId]
  t.w.secrets.store.write('sharing-links', JSON.stringify(store))
  const read = t.w.secrets.files.read
  t.w.secrets.files.read = () => { throw Object.assign(new Error('keychain locked'), { code: 'EACCES' }) }
  expect(t.w.publisher.noteShareIds()).toBeNull()
  readerLinksChanged()
  await t.run.look()
  expect(refusedFor(t.shareId)).not.toBeNull()
  expect(limitsFor(t.shareId)).not.toBeUndefined()
  // Read again: a healthy look finds no link in the Collection and forgets what was kept for the removed one.
  t.w.secrets.files.read = read
  expect(t.w.publisher.noteSources(t.w.root)).toEqual([])
  await t.run.look()
  expect(refusedFor(t.shareId)).toBeNull()
  expect(limitsFor(t.shareId)).toBeUndefined()
  t.run.dispose()
})

test('ticket 11, review round 1 F1: Clear handled notes marks the cleared notes\' records as no longer on the service, and only those', async () => {
  const t = await limitsWorld()
  expect((await t.post({})).status).toBe(201)
  expect((await t.post({ text: 'Another question' })).status).toBe(201)
  await t.run.look()
  await t.call('sharing:open', 1, PIECE)
  const [decided, open] = (await t.changes.list()).filter((change) => change.outsideSource === 'reader')
  await t.changes.setStatus(decided.id, 'accepted')
  expect(await t.call<LimitsActionResult>('sharing:clear-handled', 1, { shareId: t.shareId })).toMatchObject({ ok: true })
  const gone = (id: string) => t.changes.get(id).then((change) => (change as { readerGone?: unknown } | undefined)?.readerGone)
  expect(typeof await gone(decided.id)).toBe('number')
  expect(await gone(open.id)).toBeUndefined()
  t.run.dispose()
})
