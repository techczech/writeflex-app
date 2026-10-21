// Hearing back on the sharing service: the author's outcome and replies on a reader's note, through the entry Worker
// with in-memory Durable Objects. The owner token is needed; the reader who wrote the note sees the
// outcome and the replies on /notes/mine, after a reload too; no other reader can obtain them by any
// request; a reply sent twice is kept once; a reply is plain text. Run from the handler suite, so
// it runs against the sources and against the built bundle.
import { describe, expect, test } from 'bun:test'
import { OUTCOME_LIMITS } from '../../sharing-service/note-outcomes.ts'
import { note, secret, share } from './sharing-service-notes-suite.ts'
import type { ServiceModule } from './sharing-service-runtime.ts'

type Shared = Awaited<ReturnType<typeof share>>['first']
type Mine = { notes: Array<{ id: string; status: string; outcomeAt: number | null; replies: Array<{ id: string; text: string; at: number }> }> }

const AT = Date.UTC(2026, 9, 16, 8, 30)
const replyId = (n: number) => `reply-${String(n).padStart(4, '0')}`

/** Post notes as their readers, collect them all, and answer each note's key by its id. */
async function collected(s: Shared, notes: Array<[string, Record<string, unknown>]>) {
  for (const [reader, n] of notes) expect((await s.post(reader, n)).status).toBe(201)
  const waiting = await (await s.owner('/notes')).json() as { notes: { key: string; id: string }[] }
  const keys = waiting.notes.map((n) => n.key)
  expect((await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys }) })).status).toBe(200)
  return (id: string) => waiting.notes.find((n) => n.id === id)!.key
}

const send = (s: Shared, outcomes: unknown[], token?: string) => s.owner('/notes/outcomes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ outcomes }) }, token)
const mine = async (s: Shared, reader: string) => (await (await s.mine(reader)).json()) as Mine

export function runSharingServiceOutcomesSuite(label: string, module: () => Promise<ServiceModule>) {
  describe(`${label}: hearing back`, () => {
    test('outcomes need the share\'s owner token: no token, a wrong one, another share\'s or a reader\'s secret is refused, and GET is no route', async () => {
      const { make, first: s } = await share(await module())
      const other = await make()
      const marta = secret()
      const n = note()
      const keyOf = await collected(s, [[marta, n]])
      for (const token of ['', 'wrong', other.ownerToken, marta]) {
        const refused = await send(s, [{ key: keyOf(n.id), outcome: 'done', at: AT, replies: [{ id: replyId(1), text: 'forged', at: AT }] }], token)
        expect(refused.status).toBe(401)
        expect((await refused.json()).error.code).toBe('owner_auth_required')
      }
      expect((await s.owner('/notes/outcomes')).status).toBe(404)
      // A reader route under the same name does nothing either.
      const fromPage = await s.post(marta, { outcomes: [] })
      expect(fromPage.status).toBe(400)
      expect((await mine(s, marta)).notes[0]).toMatchObject({ status: 'open', outcomeAt: null, replies: [] })
      expect(JSON.stringify(s.state().db.query('SELECT * FROM note_replies').all())).toBe('[]')
    })

    test('every outcome kind shows on the reader\'s own notes with the replies, after a reload too', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const accepted = note({ kind: 'edit', text: 'they are often ordered' })
      const declined = note({ kind: 'edit', text: 'they are sorted' })
      const done = note({ text: 'Which kind of book do you mean?' })
      const failed = note({ kind: 'edit', text: 'they are all ordered' })
      const open = note({ text: 'Pages or hours?' })
      const keyOf = await collected(s, [[marta, accepted], [marta, declined], [marta, done], [marta, failed], [marta, open]])
      const answer = await send(s, [
        { key: keyOf(accepted.id), outcome: 'accepted', at: AT },
        { key: keyOf(declined.id), outcome: 'declined', at: AT + 60_000, replies: [{ id: replyId(1), text: 'Decoding is the word the course uses.', at: AT + 60_000 }] },
        { key: keyOf(done.id), outcome: 'done', at: AT + 180_000, replies: [{ id: replyId(2), text: 'Added an example to the next draft.', at: AT + 180_000 }] },
        { key: keyOf(failed.id), outcome: 'failed', at: AT + 360_000 },
        { key: keyOf(open.id), outcome: null, replies: [{ id: replyId(3), text: 'Hours, I think.', at: AT + 400_000 }] },
      ])
      expect(answer.status).toBe(200)
      expect(await answer.json()).toEqual({
        recorded: [accepted, declined, done, failed, open].map((n) => keyOf(n.id)), waiting: [], unknown: [], full: [],
        // Each reply sent is answered by id: kept now, kept before, or refused for the limit.
        replies: [[declined, 1], [done, 2], [open, 3]].map(([n, i]) => ({ key: keyOf((n as { id: string }).id), kept: [replyId(i as number)], already: [], full: [] })),
      })
      for (let load = 0; load < 2; load += 1) {
        const byId = new Map((await mine(s, marta)).notes.map((n) => [n.id, n]))
        expect(byId.get(accepted.id)).toMatchObject({ status: 'accepted', outcomeAt: AT, replies: [] })
        expect(byId.get(declined.id)).toMatchObject({ status: 'declined', outcomeAt: AT + 60_000, replies: [{ id: replyId(1), text: 'Decoding is the word the course uses.', at: AT + 60_000 }] })
        expect(byId.get(done.id)).toMatchObject({ status: 'done', outcomeAt: AT + 180_000, replies: [{ text: 'Added an example to the next draft.' }] })
        expect(byId.get(failed.id)).toMatchObject({ status: 'failed', outcomeAt: AT + 360_000, replies: [] })
        expect(byId.get(open.id)).toMatchObject({ status: 'open', outcomeAt: null, replies: [{ text: 'Hours, I think.' }] })
      }
      // The author's list of waiting notes is unchanged by it: they were collected.
      expect(((await (await s.owner('/notes')).json()) as { notes: unknown[] }).notes).toEqual([])
    })

    test('on a private share no other reader can obtain the outcome or the reply by any request', async () => {
      const { svc, make, first: s } = await share(await module())
      const a = secret()
      const b = secret()
      const aNote = note({ name: 'Annabel', text: 'only Annabel asked this' })
      const keyOf = await collected(s, [[a, aNote], [b, note({ name: 'Bob' })]])
      expect((await send(s, [{ key: keyOf(aNote.id), outcome: 'done', at: AT, replies: [{ id: replyId(1), text: 'A private answer for Annabel', at: AT }] }])).status).toBe(200)
      const other = await make()
      const leaks: Response[] = []
      leaks.push(await s.mine(b))
      // B sends A's note id as B's own: stored apart, and it carries none of A's outcome or reply.
      leaks.push(await s.post(b, { ...note({ name: 'Bob' }), id: aNote.id }))
      leaks.push(await s.mine(b))
      for (const forged of ['', 'x', a.slice(0, -1), `${a}x`]) leaks.push(await s.mine(forged))
      leaks.push(await other.mine(a))
      const paths = [`/s/${s.shareId}`, `/s/${s.shareId}/notes`, `/s/${s.shareId}/notes/mine`, `/s/${s.shareId}/notes/outcomes`, `/shares/${s.shareId}/notes`, `/shares/${s.shareId}/notes/outcomes`, `/shares/${s.shareId}`]
      for (const path of paths) {
        for (const method of ['GET', 'HEAD', 'POST', 'PUT']) {
          leaks.push(await svc.call(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${b}` }, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({ reader: b, outcomes: [] }) }))
        }
      }
      for (const response of leaks) {
        const text = await response.text()
        expect(text).not.toContain('A private answer')
        expect(text).not.toContain('"status":"done"')
      }
      for (const n of (await mine(s, b)).notes) expect(n).toMatchObject({ status: 'open', outcomeAt: null, replies: [] })
      // A still sees A's own.
      expect((await mine(s, a)).notes[0]).toMatchObject({ status: 'done', replies: [{ text: 'A private answer for Annabel' }] })
    })

    test('a reply sent twice is kept once; a decision taken back opens the note again; a note not collected waits; an unknown note is unknown', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const n = note()
      const keyOf = await collected(s, [[marta, n]])
      const item = { key: keyOf(n.id), outcome: 'done', at: AT, replies: [{ id: replyId(1), text: 'Thank you.', at: AT }] }
      for (let i = 0; i < 3; i += 1) expect((await (await send(s, [item])).json())).toMatchObject({ recorded: [keyOf(n.id)] })
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM note_replies').get()).toEqual({ n: 1 })
      // The same id with other words changes nothing.
      await send(s, [{ ...item, replies: [{ id: replyId(1), text: 'Something else.', at: AT + 1 }] }])
      expect((await mine(s, marta)).notes[0].replies).toEqual([{ id: replyId(1), text: 'Thank you.', at: AT }])
      // Reopened in the app: the note is open again; its reply stays.
      await send(s, [{ key: keyOf(n.id), outcome: null }])
      expect((await mine(s, marta)).notes[0]).toMatchObject({ status: 'open', outcomeAt: null, replies: [{ text: 'Thank you.' }] })
      // Not collected yet: nothing recorded.
      const later = note({ text: 'A later note' })
      expect((await s.post(marta, later)).status).toBe(201)
      const waitingKey = ((await (await s.owner('/notes')).json()) as { notes: { key: string }[] }).notes[0].key
      const unknownKey = `${'0'.repeat(24)}.nothing00`
      expect(await (await send(s, [{ key: waitingKey, outcome: 'done', at: AT, replies: [{ id: replyId(2), text: 'Too soon', at: AT }] }, { key: unknownKey, outcome: 'done', at: AT }])).json())
        .toEqual({ recorded: [], waiting: [waitingKey], unknown: [unknownKey], full: [], replies: [] })
      expect((await mine(s, marta)).notes.find((x) => x.id === later.id)).toMatchObject({ status: 'open', replies: [] })
    })

    test('a reply is plain text within its limit: markup is kept as text, controls removed; a bad body is refused and changes nothing', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const n = note()
      const keyOf = await collected(s, [[marta, n]])
      const markup = '<img src=x onerror=alert(1)><script>alert(2)</script> **bold**‮\u0000'
      expect((await send(s, [{ key: keyOf(n.id), outcome: 'done', at: AT, replies: [{ id: replyId(1), text: markup, at: AT }] }])).status).toBe(200)
      expect((await mine(s, marta)).notes[0].replies[0].text).toBe('<img src=x onerror=alert(1)><script>alert(2)</script> **bold**')
      const bad: unknown[][] = [
        [{ key: keyOf(n.id), outcome: 'merged', at: AT }],
        [{ key: keyOf(n.id), outcome: 'done' }],
        [{ key: 'not a key', outcome: 'done', at: AT }],
        [{ key: keyOf(n.id), outcome: null, replies: [{ id: replyId(2), text: 'x'.repeat(OUTCOME_LIMITS.replyChars + 1), at: AT }] }],
        [{ key: keyOf(n.id), outcome: null, replies: [{ id: replyId(2), text: '   ', at: AT }] }],
        [{ key: keyOf(n.id), outcome: null, replies: [{ id: 'short', text: 'ok', at: AT }] }],
        [{ key: keyOf(n.id), outcome: null }, { key: keyOf(n.id), outcome: 'done', at: AT }],
        Array.from({ length: OUTCOME_LIMITS.perRequest + 1 }, (_, i) => ({ key: `${'0'.repeat(24)}.nothing${String(i).padStart(2, '0')}`, outcome: null })),
      ]
      for (const outcomes of bad) {
        const refused = await send(s, outcomes)
        expect(refused.status).toBe(400)
        expect((await refused.json()).error.code).toBe('invalid_outcome')
      }
      const notJson = await s.owner('/notes/outcomes', { method: 'POST', body: '{' })
      expect(notJson.status).toBe(400)
      const huge = await s.owner('/notes/outcomes', { method: 'POST', body: JSON.stringify({ outcomes: [], pad: 'x'.repeat(OUTCOME_LIMITS.requestBytes) }) })
      expect(huge.status).toBe(413)
      expect((await mine(s, marta)).notes[0]).toMatchObject({ status: 'done', replies: [{ id: replyId(1) }] })
    })

    test('a note keeps at most its replies\' limit; the rest are listed as full and the outcome is still recorded', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const n = note()
      const keyOf = await collected(s, [[marta, n]])
      const replies = Array.from({ length: OUTCOME_LIMITS.repliesPerNote }, (_, i) => ({ id: replyId(i), text: `Reply ${i}`, at: AT + i }))
      expect(await (await send(s, [{ key: keyOf(n.id), outcome: null, replies }])).json()).toMatchObject({ recorded: [keyOf(n.id)], full: [], replies: [{ key: keyOf(n.id), kept: replies.map((r) => r.id), already: [], full: [] }] })
      // A held reply sent again is answered `already`; a new one past the limit is refused by id, never kept.
      expect(await (await send(s, [{ key: keyOf(n.id), outcome: 'done', at: AT, replies: [replies[0], { id: replyId(99), text: 'One too many', at: AT + 99 }] }])).json())
        .toEqual({ recorded: [keyOf(n.id)], waiting: [], unknown: [], full: [keyOf(n.id)], replies: [{ key: keyOf(n.id), kept: [], already: [replies[0].id], full: [replyId(99)] }] })
      const shown = (await mine(s, marta)).notes[0]
      expect(shown.status).toBe('done')
      expect(shown.replies.map((r) => r.text)).toEqual(replies.map((r) => r.text))
    })

    test('clearing a handled note deletes its replies with it', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const n = note()
      const keyOf = await collected(s, [[marta, n]])
      await send(s, [{ key: keyOf(n.id), outcome: 'done', at: AT, replies: [{ id: replyId(1), text: 'Thanks', at: AT }] }])
      expect(await (await s.owner('/notes/clear', { method: 'POST', body: JSON.stringify({ keys: [keyOf(n.id)] }) })).json()).toMatchObject({ cleared: [keyOf(n.id)] })
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM note_replies').get()).toEqual({ n: 0 })
      expect((await mine(s, marta)).notes).toEqual([])
    })

    test('a share whose notes were kept by an earlier build takes outcomes: its notes start open', async () => {
      const { svc, first: s } = await share(await module())
      const marta = secret()
      const n = note()
      const keyOf = await collected(s, [[marta, n]])
      // Storage as build 5 left it: no outcome columns, no replies table. The runtime evicts the object.
      const db = s.state().db
      db.exec('DROP TABLE note_replies')
      db.exec('ALTER TABLE notes DROP COLUMN outcome')
      db.exec('ALTER TABLE notes DROP COLUMN outcome_at')
      svc.shares.evict(s.shareId)
      expect((await mine(s, marta)).notes[0]).toMatchObject({ status: 'open', outcomeAt: null, replies: [] })
      expect(await (await send(s, [{ key: keyOf(n.id), outcome: 'done', at: AT, replies: [{ id: replyId(1), text: 'Done now', at: AT }] }])).json()).toMatchObject({ recorded: [keyOf(n.id)] })
      expect((await mine(s, marta)).notes[0]).toMatchObject({ status: 'done', replies: [{ text: 'Done now' }] })
    })
  })
}
