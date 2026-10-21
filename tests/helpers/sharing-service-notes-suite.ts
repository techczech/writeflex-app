// Readers' notes on the sharing service, end to end through the entry Worker with in-memory Durable
// Objects: posting, de-duplication by note id, a reader's own notes, private isolation, limits per
// reader, per share and for the whole service, hostile input, comments off, link off, and the
// author's collect route.
// Run from the handler suite, so it runs against the sources and against the built bundle.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { generateShareId } from '../../sharing-service/share-id.ts'
import { NOTE_LIMITS } from '../../sharing-service/reader-notes.ts'
import { REFUSALS_COUNTED_PER_MINUTE } from '../../sharing-service/shared-piece.ts'
import { ADMIN_KEY, ORIGIN, fakeService, type ServiceModule } from './sharing-service-runtime.ts'

const SAVED_AT = Date.UTC(2026, 9, 14, 8, 12)
const TEXT = 'Most reading lists are written as if the reader will finish them. They are long, they are ordered by when the author found each item.'

export const secret = () => randomBytes(32).toString('base64url')
export const noteId = () => randomBytes(12).toString('base64url')

function pieceBody(revision: number, extra: Record<string, unknown> = {}) {
  return {
    revision, savedAt: SAVED_AT, timeZone: 'Europe/London', sharedBy: 'Ada', comments: true, kind: 'piece',
    title: 'What a reading list is for', parts: [{ html: `<p class="wf-paragraph">${TEXT}</p>` }], images: [], ...extra,
  }
}

export function note(extra: Record<string, unknown> = {}) {
  return {
    id: noteId(), kind: 'note', name: 'Marta', text: 'Is this the question you use?',
    anchor: { quote: 'they are ordered', before: 'They are long,', after: 'by when', block: 'n:0', start: 81, end: 97 },
    writtenAt: Date.UTC(2026, 9, 14, 9, 0), revision: 1, ...extra,
  }
}

async function snapshot(response: Response) {
  const headers = [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b))
  return { status: response.status, headers, body: [...new Uint8Array(await response.arrayBuffer())] }
}

export async function share(module: ServiceModule, body: Record<string, unknown> | null = pieceBody(1)) {
  const svc = fakeService(module)
  const make = async (published: Record<string, unknown> | null = body) => {
    const made = await svc.call('/shares', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}` } })
    const { shareId, ownerToken } = await made.json() as { shareId: string; ownerToken: string }
    const owner = (path: string, init: RequestInit = {}, token = ownerToken) => svc.call(`/shares/${shareId}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } })
    const publish = (b: unknown) => owner('/page', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
    if (published) expect((await publish(published)).status).toBe(200)
    const post = (reader: string, n: unknown, headers: Record<string, string> = {}) => svc.call(`/s/${shareId}/notes`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers }, body: JSON.stringify({ reader, note: n }),
    })
    const mine = (reader: string, headers: Record<string, string> = {}) => svc.call(`/s/${shareId}/notes/mine`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ reader }),
    })
    return { shareId, ownerToken, owner, publish, post, mine, state: () => svc.shares.states.get(shareId)! }
  }
  return { svc, make, first: await make() }
}

export function runSharingServiceNotesSuite(label: string, module: () => Promise<ServiceModule>) {
  afterEach(() => setSystemTime())

  describe(`${label}: a reader's notes`, () => {
    test('a note is kept once, however often it is sent, and its reader gets it back', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const n = note()
      const sent = await s.post(marta, n)
      expect(sent.status).toBe(201)
      const body = await sent.json() as { note: Record<string, unknown>; already: boolean }
      expect(body.already).toBe(false)
      expect(body.note).toMatchObject({ id: n.id, kind: 'note', name: 'Marta', text: n.text, anchor: n.anchor, writtenAt: n.writtenAt, status: 'open' })
      for (let i = 0; i < 3; i += 1) {
        const again = await s.post(marta, { ...n, text: 'a different text under the same id' })
        expect(again.status).toBe(200)
        expect(await again.json()).toMatchObject({ already: true, note: { id: n.id, text: n.text } })
      }
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 })
      const mine = await (await s.mine(marta)).json() as { notes: { id: string }[] }
      expect(mine.notes.map((x) => x.id)).toEqual([n.id])
      // The service keeps a digest of the reader's secret, never the secret.
      expect(JSON.stringify(s.state().db.query('SELECT * FROM notes').all())).not.toContain(marta)
    })

    // Build 8: the words readers see changed to Comments; routes, stored names and shapes did not.
    test('a record written by the previous build (7) still loads: same row, same answers, same routes', async () => {
      const { svc, first: s } = await share(await module())
      const marta = secret()
      const seed = note()
      expect((await s.post(marta, seed)).status).toBe(201)
      const readerKey = (s.state().db.query('SELECT reader_key FROM notes').get() as { reader_key: string }).reader_key
      // A row exactly as build 7 stored it: kind 'note', an outcome, a reply, collected by the author.
      s.state().db.query('INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, block, start_at, end_at, written_at, revision, received_at, collected_at, outcome, outcome_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(readerKey, 'build7-record-0001', 'note', 'Marta', 'Written under build 7.', 'they are ordered', 'They are long,', 'by when', 'n:0', 81, 97, 1_784_000_000_000, 1, 1_784_000_100_000, 1_784_000_200_000, 'accepted', 1_784_000_300_000)
      const seq = (s.state().db.query("SELECT seq FROM notes WHERE id = 'build7-record-0001'").get() as { seq: number }).seq
      s.state().db.query('INSERT INTO note_replies (note_seq, id, text, at, received_at) VALUES (?, ?, ?, ?, ?)').run(seq, 'build7-reply-0001', 'Thanks, taken.', 1_784_000_400_000, 1_784_000_400_000)
      const mine = await (await s.mine(marta)).json() as { notes: Record<string, unknown>[] }
      expect(mine.notes.map((x) => x.id)).toEqual([seed.id, 'build7-record-0001'])
      expect(mine.notes[1]).toMatchObject({
        id: 'build7-record-0001', kind: 'note', name: 'Marta', text: 'Written under build 7.', status: 'accepted',
        anchor: { quote: 'they are ordered', before: 'They are long,', after: 'by when', block: 'n:0', start: 81, end: 97 },
        replies: [{ id: 'build7-reply-0001', text: 'Thanks, taken.', at: 1_784_000_400_000 }],
      })
      // The author's routes are the same ones; the stored kind is still 'note'.
      const waiting = await (await s.owner('/notes')).json() as { notes: { id: string; kind: string }[] }
      expect(waiting.notes.map((x) => [x.id, x.kind])).toEqual([[seed.id, 'note']])
      // The page link still serves, and its column says Comments.
      const page = await (await svc.call(`/s/${s.shareId}`)).text()
      expect(page).toContain('aria-label="Comments"')
      expect(page).not.toContain('aria-label="Notes"')
    })

    test('a proposed edit carries the reader\'s wording for the quoted words', async () => {
      const { first: s } = await share(await module())
      const edit = note({ kind: 'edit', text: 'they are often ordered' })
      expect((await s.post(secret(), edit)).status).toBe(201)
      for (const bad of [note({ kind: 'edit', text: 'they  are ordered' }), note({ kind: 'question' })]) {
        const refused = await s.post(secret(), bad)
        expect(refused.status).toBe(400)
        expect((await refused.json()).error.code).toBe('invalid_note')
      }
      // A cut: the words replaced by nothing.
      expect((await s.post(secret(), note({ kind: 'edit', text: '' }))).status).toBe(201)
    })
  })

  describe(`${label}: private notes`, () => {
    test('reader B obtains none of reader A\'s notes or name by any request', async () => {
      const { svc, make, first: s } = await share(await module())
      const a = secret()
      const b = secret()
      const aNote = note({ name: 'Annabel Secretname', text: 'only Annabel wrote this sentence' })
      expect((await s.post(a, aNote)).status).toBe(201)
      expect((await s.post(b, note({ name: 'Bob' }))).status).toBe(201)
      const other = await make()
      const leaks: Response[] = []
      // B's own list, B posting A's note id (stored as B's own, separately), B asking with a
      // malformed or empty secret, B using A's id under another share, every method on every path.
      leaks.push(await s.mine(b))
      leaks.push(await s.post(b, { ...note({ name: 'Bob' }), id: aNote.id }))
      leaks.push(await s.mine(b))
      for (const forged of ['', 'x', a.slice(0, -1), `${a}x`, a.toUpperCase().replace(/[^A-Z]/g, 'A').slice(0, 43)]) leaks.push(await s.mine(forged))
      leaks.push(await other.mine(a))
      const paths = [`/s/${s.shareId}/notes`, `/s/${s.shareId}/notes/mine`, `/s/${s.shareId}/notes/all`, `/s/${s.shareId}/notes/${aNote.id}`, `/shares/${s.shareId}/notes`, `/shares/${s.shareId}`, `/shares/${s.shareId}/notes/collected`]
      for (const path of paths) {
        for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
          leaks.push(await svc.call(path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${b}` }, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify({ reader: b, keys: [] }) }))
        }
      }
      for (const response of leaks) {
        const text = await response.text()
        expect(text).not.toContain('Annabel')
        expect(text).not.toContain('only Annabel wrote')
      }
      const bNotes = await (await s.mine(b)).json() as { notes: { name: string }[] }
      expect(bNotes.notes.map((x) => x.name)).toEqual(['Bob', 'Bob'])
      // A still has exactly A's own note.
      expect(((await (await s.mine(a)).json()) as { notes: { text: string }[] }).notes.map((x) => x.text)).toEqual(['only Annabel wrote this sentence'])
    })

    test('every answer reader B gets is the same whether or not reader A has written, but for a shared limit reached', async () => {
      // Paired states: the same requests from B against a share where A has written and one where
      // nobody has. Only the documented residual may differ: a share's own limit, once reached,
      // refuses B too. Even then B is told the same words as for
      // B's own limit, and is never given a note, a name or a count.
      const B = secret()
      const other = secret()
      const ids = Array.from({ length: NOTE_LIMITS.readerPerHour + 2 }, noteId)
      const fromB = { 'cf-connecting-ip': '198.51.100.20' }
      const world = async (filled: 'nobody' | 'reader A' | 'share full') => {
        setSystemTime(new Date(Date.UTC(2026, 9, 15, 9, 30)))
        const { first: s } = await share(await module())
        if (filled === 'reader A') {
          const A = secret()
          for (let i = 0; i < 3; i += 1) expect((await s.post(A, note({ name: 'Annabel Secretname', text: `A's note ${i}` }), { 'cf-connecting-ip': '203.0.113.5' })).status).toBe(201)
        }
        if (filled === 'share full') {
          const fill = s.state().db.query(`INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, received_at) VALUES (?, ?, 'note', 'Annabel', 'x', 'x', '', '', ?)`)
          for (let i = 0; i < NOTE_LIMITS.sharePerHour; i += 1) fill.run(`${i}`.padStart(64, 'a'), `filled-${i}`, Date.now())
        }
        const answers = []
        const first = note({ id: ids[0] })
        answers.push(await snapshot(await s.post(B, first, fromB)))
        answers.push(await snapshot(await s.post(B, { ...first, text: 'again' }, fromB)))
        answers.push(await snapshot(await s.mine(B)))
        answers.push(await snapshot(await s.mine(other)))
        answers.push(await snapshot(await s.post(B, note({ id: ids[1], name: '' }), fromB)))
        for (const id of ids.slice(1)) answers.push(await snapshot(await s.post(B, note({ id }), fromB)))
        answers.push(await snapshot(await s.mine(B)))
        return answers
      }
      const nobody = await world('nobody')
      expect(await world('reader A')).toEqual(nobody)
      // The documented residual: with the share's hour full, B's first note is refused too. The
      // refusal is the very answer B gets at B's own limit, and B's list is empty, not A's.
      const full = await world('share full')
      const ownLimit = nobody[nobody.length - 2]
      expect(ownLimit.status).toBe(429)
      expect(full[0]).toEqual(ownLimit)
      expect(new TextDecoder().decode(new Uint8Array(full[2].body))).toBe('{"notes":[]}')
      for (const answer of full) expect(new TextDecoder().decode(new Uint8Array(answer.body))).not.toContain('Annabel')
    })

    test('no reader route acts on GET: an <img> in the author\'s text cannot send or read a note', async () => {
      const { svc, first: s } = await share(await module())
      const marta = secret()
      const linkOff = await snapshot(await svc.call(`/s/${generateShareId()}`))
      for (const path of [`/s/${s.shareId}/notes`, `/s/${s.shareId}/notes/mine`, `/s/${s.shareId}/notes?reader=${marta}`]) {
        expect(await snapshot(await svc.call(path))).toEqual(linkOff)
      }
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 })
    })

    test('a request a page on another site could send gets the "turned off" page and changes nothing', async () => {
      const { svc, first: s } = await share(await module())
      const linkOffPost = await snapshot(await svc.call(`/s/${generateShareId()}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: secret(), note: note() }) }))
      const marta = secret()
      const cases: Record<string, string>[] = [
        { 'content-type': 'text/plain' },                                         // a form or a no-cors fetch
        { 'content-type': 'application/x-www-form-urlencoded' },
        { 'content-type': 'application/json', origin: 'https://elsewhere.example' },
        { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      ]
      for (const headers of cases) {
        const response = await svc.call(`/s/${s.shareId}/notes`, { method: 'POST', headers, body: JSON.stringify({ reader: marta, note: note() }) })
        expect(await snapshot(response)).toEqual(linkOffPost)
      }
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 0 })
    })
  })

  describe(`${label}: hostile input`, () => {
    test('names, notes and quotes are plain text within their limits; markup is kept as text, never run', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const markup = note({ name: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>\n<b>bold</b> & "quotes"' })
      expect((await s.post(marta, markup)).status).toBe(201)
      const stored = await (await s.mine(marta)).json() as { notes: { name: string; text: string }[] }
      expect(stored.notes[0]).toMatchObject({ name: '<img src=x onerror=alert(1)>', text: '<script>alert(1)</script>\n<b>bold</b> & "quotes"' })
      const bad = [
        note({ name: 'Marta\nSmith' }), note({ name: 'Marta‮atraM' }), note({ name: '' }), note({ name: 'x'.repeat(61) }),
        note({ text: '' }), note({ text: 'x'.repeat(4001) }), note({ text: '   ' }), note({ id: 'short' }), note({ id: '../../etc/passwd' }),
        note({ anchor: { quote: '' } }), note({ anchor: { quote: 'x'.repeat(1001) } }), note({ anchor: { quote: 'a', block: '"><script>' } }),
        note({ anchor: { quote: 'a', start: -1 } }), note({ anchor: { quote: 'a', start: 5, end: 2 } }), note({ writtenAt: 'yesterday' }), note({ name: 42 }),
        // Offsets that cover more or fewer characters than the quote describe another range.
        note({ anchor: { quote: 'they are ordered', start: 81, end: 1081 } }), note({ anchor: { quote: 'they are ordered', start: 81, end: 90 } }),
      ]
      for (const n of bad) {
        const response = await s.post(marta, n)
        expect(response.status).toBe(400)
        expect((await response.json()).error.code).toBe('invalid_note')
      }
      for (const reader of ['', 'short', 'x'.repeat(43) + '!', null]) expect((await s.post(reader as string, note())).status).toBe(400)
      // Controls and bidi characters are taken out of note text; line breaks stay.
      const cleaned = note({ text: 'line one\r\nline‮ two\u0007' })
      await s.post(marta, cleaned)
      const after = await (await s.mine(marta)).json() as { notes: { id: string; text: string }[] }
      expect(after.notes.find((x) => x.id === cleaned.id)!.text).toBe('line one\nline two')
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 2 })
    })

    test('a body over the size limit is refused unread, and so is one that is not JSON', async () => {
      const { svc, first: s } = await share(await module())
      const big = await s.post(secret(), note({ text: 'x'.repeat(NOTE_LIMITS.requestBytes) }))
      expect(big.status).toBe(413)
      expect((await big.json()).error.code).toBe('body_too_large')
      const notJson = await svc.call(`/s/${s.shareId}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reader":' })
      expect(notJson.status).toBe(400)
      expect(svc.shares.received.filter((r) => r.path.startsWith('/notes'))).toEqual([])
    })
  })

  describe(`${label}: limits`, () => {
    test('a flood from one reader is refused after the hourly limit, told plainly, and counted', async () => {
      const { first: s } = await share(await module())
      const flooder = secret()
      for (let i = 0; i < NOTE_LIMITS.readerPerHour; i += 1) expect((await s.post(flooder, note())).status).toBe(201)
      const refused = await s.post(flooder, note())
      expect(refused.status).toBe(429)
      expect(await refused.json()).toEqual({ error: { code: 'notes_refused', message: 'The author is not receiving more comments on this link for now.' } })
      // Another reader is not held back by one reader's flood.
      expect((await s.post(secret(), note())).status).toBe(201)
      const waiting = await (await s.owner('/notes')).json() as { refused: { total: number; byReason: Record<string, number> } }
      expect(waiting.refused).toMatchObject({ total: 1, byReason: { reader_rate: 1 } })
      // An hour later the reader may write again.
      setSystemTime(new Date(Date.now() + 3_600_001))
      expect((await s.post(flooder, note())).status).toBe(201)
    })

    test('a flood across readers is refused at the share\'s limit, with the same words, and counted', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 5)))
      const { first: s } = await share(await module())
      let accepted = 0
      let refusedBody: unknown = null
      for (let reader = 0; reader < 8; reader += 1) {
        const who = secret()
        // Each reader on a network of their own, so the share's limit is the one reached.
        for (let i = 0; i < NOTE_LIMITS.readerPerHour; i += 1) {
          const response = await s.post(who, note(), { 'cf-connecting-ip': `198.51.100.${reader + 1}` })
          if (response.status === 201) accepted += 1
          else { expect(response.status).toBe(429); refusedBody = await response.json() }
        }
      }
      expect(accepted).toBe(NOTE_LIMITS.sharePerHour)
      expect(refusedBody).toEqual({ error: { code: 'notes_refused', message: 'The author is not receiving more comments on this link for now.' } })
      const state = await (await s.owner('')).json() as { refused: { total: number; byReason: Record<string, number>; more: string[] }; notes: { waiting: number } }
      // 40 refused in one minute: 30 counted one by one, and the owner told there were more.
      expect(8 * NOTE_LIMITS.readerPerHour - NOTE_LIMITS.sharePerHour).toBeGreaterThan(REFUSALS_COUNTED_PER_MINUTE)
      expect(state.refused.byReason.share_rate).toBe(REFUSALS_COUNTED_PER_MINUTE)
      expect(state.refused.more).toEqual(['share_rate'])
      expect(state.notes.waiting).toBe(NOTE_LIMITS.sharePerHour)
    })

    test('a reader\'s notes waiting to be collected are limited; collecting makes room', async () => {
      const { first: s } = await share(await module())
      const reader = secret()
      let now = Date.now()
      for (let i = 0; i < NOTE_LIMITS.readerWaiting; i += 1) {
        if (i % NOTE_LIMITS.readerPerHour === 0) { now += 3_600_001; setSystemTime(new Date(now)) }
        expect((await s.post(reader, note())).status).toBe(201)
      }
      setSystemTime(new Date(now += 3_600_001))
      expect((await s.post(reader, note())).status).toBe(429)
      const waiting = await (await s.owner('/notes')).json() as { notes: { key: string }[]; refused: { byReason: Record<string, number> } }
      expect(waiting.refused.byReason.reader_waiting).toBe(1)
      expect((await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: waiting.notes.slice(0, 10).map((n) => n.key) }) })).status).toBe(200)
      expect((await s.post(reader, note())).status).toBe(201)
    })

    test('the whole service refuses notes past its hourly limit, across shares, and the share counts it', async () => {
      const mod = await module()
      const { svc, make, first: s } = await share(mod)
      // Fill the service's hour, as if other shares had used it.
      await s.post(secret(), note())
      const registry = [...svc.registry.states.values()][0]
      registry.db.query('UPDATE note_budget SET granted = ?').run(NOTE_LIMITS.servicePerHour)
      const other = await make()
      for (const target of [s, other]) {
        const refused = await target.post(secret(), note())
        expect(refused.status).toBe(429)
        expect((await refused.json()).error.code).toBe('notes_refused')
        expect(((await (await target.owner('/notes')).json()) as { refused: { byReason: Record<string, number> } }).refused.byReason.service_rate).toBe(1)
      }
      // A share's own limit refuses without spending the service's hour.
      const before = registry.db.query('SELECT SUM(granted) + SUM(refused) AS n FROM note_budget').get()
      const off = await share(mod, pieceBody(1, { comments: false }))
      await off.first.post(secret(), note())
      expect(registry.db.query('SELECT SUM(granted) + SUM(refused) AS n FROM note_budget').get()).toEqual(before)
    })
  })

  describe(`${label}: comments off, link off`, () => {
    test('with comments off a note is refused and counted, and the page has no notes column', async () => {
      const { svc, first: s } = await share(await module(), pieceBody(1, { comments: false }))
      const refused = await s.post(secret(), note())
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: { code: 'comments_off', message: 'Comments are off for this link.' } })
      expect(((await (await s.owner('')).json()) as { comments: boolean; refused: { byReason: Record<string, number> } })).toMatchObject({ comments: false, refused: { byReason: { comments_off: 1 } } })
      const html = await (await svc.call(`/s/${s.shareId}`)).text()
      expect(html).toContain('Comments are off for this link.')
      expect(html).not.toContain('<aside class="notes-col"')
      // Turning comments on is a publish.
      expect((await s.publish(pieceBody(2, { comments: true }))).status).toBe(200)
      expect((await s.post(secret(), note())).status).toBe(201)
      expect(await (await svc.call(`/s/${s.shareId}`)).text()).toContain('<aside class="notes-col" aria-label="Comments"></aside>')
    })

    test('a link that is off, never published or never made answers note requests with the "turned off" page', async () => {
      const mod = await module()
      const { svc, make, first: s } = await share(mod)
      const reader = secret()
      expect((await s.post(reader, note())).status).toBe(201)
      expect((await s.owner('/off', { method: 'POST' })).status).toBe(200)
      const unpublished = await make(null)
      const unknown = generateShareId()
      const body = JSON.stringify({ reader, note: note() })
      const headers = { 'content-type': 'application/json' }
      const answers = []
      for (const id of [s.shareId, unknown, unpublished.shareId]) {
        answers.push(await snapshot(await svc.call(`/s/${id}/notes`, { method: 'POST', headers, body })))
        answers.push(await snapshot(await svc.call(`/s/${id}/notes/mine`, { method: 'POST', headers, body: JSON.stringify({ reader }) })))
      }
      for (const answer of answers.slice(1)) expect(answer).toEqual(answers[0])
      expect(answers[0].status).toBe(404)
      // Notes are kept while the link is off, and the author can still collect them.
      const waiting = await (await s.owner('/notes')).json() as { notes: unknown[] }
      expect(waiting.notes).toHaveLength(1)
      await s.owner('/on', { method: 'POST' })
      await s.publish(pieceBody(2))
      expect(((await (await s.mine(reader)).json()) as { notes: unknown[] }).notes).toHaveLength(1)
    })

    test('a share made but never published takes no notes', async () => {
      const mod = await module()
      const svc = fakeService(mod)
      const made = await (await svc.call('/shares', { method: 'POST', headers: { authorization: `Bearer ${ADMIN_KEY}` } })).json() as { shareId: string }
      const response = await svc.call(`/s/${made.shareId}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: secret(), note: note() }) })
      expect(response.status).toBe(404)
      expect(await response.text()).toContain('This link has been turned off')
    })
  })

  describe(`${label}: the service's room is spent only on notes kept`, () => {
    const granted = (svc: ReturnType<typeof fakeService>) => {
      const registry = [...svc.registry.states.values()][0]
      return (registry.db.query('SELECT COALESCE(SUM(granted), 0) AS n FROM note_budget').get() as { n: number }).n
    }
    /** Make the service's answer wait for `until`, as a call to another object takes time on Cloudflare. */
    const budgetWaits = (svc: ReturnType<typeof fakeService>, until: () => Promise<void>) => {
      const real = svc.registry.get.bind(svc.registry)
      svc.registry.get = (id: unknown) => {
        const stub = real(id)
        return { fetch: async (request: Request) => { if (new URL(request.url).pathname === '/internal/note-budget') await until(); return stub.fetch(request) } }
      }
    }

    test('many copies of one note sent at once keep one note and spend one grant', async () => {
      const { svc, first: s } = await share(await module())
      const reader = secret()
      const n = note()
      const copies = NOTE_LIMITS.servicePerHour + 100
      budgetWaits(svc, () => Bun.sleep(20))
      const answers = await Promise.all(Array.from({ length: copies }, () => s.post(reader, n)))
      const statuses = answers.map((r) => r.status)
      expect(statuses.filter((x) => x === 201)).toHaveLength(1)
      expect(statuses.filter((x) => x === 200)).toHaveLength(copies - 1)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 })
      expect(granted(svc)).toBe(1)
      // The service still has room for everyone else.
      expect((await s.post(secret(), note())).status).toBe(201)
    })

    test('notes sent at once past a share\'s limit: only those kept spend a grant', async () => {
      const { svc, first: s } = await share(await module())
      const now = Date.now()
      const fill = s.state().db.query(`INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, received_at) VALUES (?, ?, 'note', 'x', 'x', 'x', '', '', ?)`)
      for (let i = 0; i < NOTE_LIMITS.sharePerHour - 1; i += 1) fill.run(`${i}`.padStart(64, '0'), `filled-${i}`, now)
      budgetWaits(svc, () => Bun.sleep(20))
      const answers = await Promise.all(Array.from({ length: 50 }, (_, i) => s.post(secret(), note(), { 'cf-connecting-ip': `192.0.2.${i + 1}` })))
      expect(answers.filter((r) => r.status === 201)).toHaveLength(1)
      expect(answers.filter((r) => r.status === 429)).toHaveLength(49)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: NOTE_LIMITS.sharePerHour })
      expect(granted(svc)).toBe(1)
    })

    test('a note not kept after its grant (the link turned off meanwhile) gives the grant back', async () => {
      const { svc, first: s } = await share(await module())
      expect((await s.post(secret(), note())).status).toBe(201)
      expect(granted(svc)).toBe(1)
      // Hold the service's answer until the link is off.
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      budgetWaits(svc, () => gate)
      const pending = s.post(secret(), note())
      await Bun.sleep(30)
      expect((await s.owner('/off', { method: 'POST' })).status).toBe(200)
      release()
      expect((await pending).status).toBe(404)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 })
      expect(granted(svc)).toBe(1)
    })
  })

  describe(`${label}: the service's answer, its pause and the network window`, () => {
    /** Answer the share's budget requests with `answer`; the call number counts from 0. */
    const budgetAnswers = (svc: ReturnType<typeof fakeService>, answer: (call: number, real: () => Promise<Response>) => Promise<Response>) => {
      const real = svc.registry.get.bind(svc.registry)
      let calls = 0
      svc.registry.get = (id: unknown) => {
        const stub = real(id)
        return { fetch: async (request: Request) => new URL(request.url).pathname === '/internal/note-budget' ? answer(calls++, () => stub.fetch(request)) : stub.fetch(request) }
      }
    }

    test('a registry that cannot answer is not a "no": no pause, no refusal counted, the page sends again', async () => {
      const { svc, first: s } = await share(await module())
      budgetAnswers(svc, async (call, real) => (call === 0 ? new Response('down', { status: 500 }) : real()))
      const failed = await s.post(secret(), note())
      expect(failed.status).toBe(503)
      expect((await failed.json()).error.code).toBe('notes_unavailable')
      // The very next note is taken: one registry failure holds back nobody.
      expect((await s.post(secret(), note())).status).toBe(201)
      expect(((await (await s.owner('/notes')).json()) as { refused: { total: number } }).refused.total).toBe(0)
    })

    test('the pause a "no room" answer starts ends as soon as the service grants room again', async () => {
      const { svc, first: s } = await share(await module())
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      budgetAnswers(svc, async (call, real) => {
        if (call === 0) { await gate; return real() }
        if (call === 1) return Response.json({ granted: false })
        return real()
      })
      const earlier = s.post(secret(), note())
      await Bun.sleep(30)
      // The service says it has no room: the share pauses.
      expect((await s.post(secret(), note())).status).toBe(429)
      // The note asked first is granted room: the pause ends there.
      release()
      expect((await earlier).status).toBe(201)
      expect((await s.post(secret(), note())).status).toBe(201)
    })

    test('a note kept after its window has gone is counted in the window of now, never under a deleted key', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 59, 59)))
      const { svc, first: s } = await share(await module())
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      budgetAnswers(svc, async (_call, real) => { await gate; return real() })
      const pending = s.post(secret(), note(), { 'cf-connecting-ip': '203.0.113.99' })
      await Bun.sleep(30)
      // Two clock hours turn while the service is asked; the alarm deletes the 10:00 hour's key.
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 12, 0, 1)))
      await svc.shares.alarm(s.shareId)
      const hour = (h: number) => Date.UTC(2026, 9, 15, h) / 3_600_000
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM network_key WHERE hour = ?').get(hour(10))).toEqual({ n: 0 })
      release()
      expect((await pending).status).toBe(201)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM network_key WHERE hour < ?').get(hour(12))).toEqual({ n: 0 })
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM network_minute WHERE hour < ?').get(hour(12))).toEqual({ n: 0 })
      expect(s.state().db.query('SELECT hour, notes FROM network_minute').all()).toEqual([{ hour: hour(12), notes: 1 }])
      // And the alarm that deletes the new key is set.
      expect(s.state().alarmAt).toBe(Date.UTC(2026, 9, 15, 14, 0))
    })
  })

  describe(`${label}: limits per network`, () => {
    const dump = (state: { db: { query: (q: string) => { all: () => unknown[] } } }) => {
      const tables = state.db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      return JSON.stringify(tables.map(({ name }) => state.db.query(`SELECT * FROM "${name}"`).all()))
    }

    test('new secrets from one network do not reset its limits; another network is not held back; nothing keeps the address', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 5)))
      const { svc, first: s } = await share(await module())
      const ip = '203.0.113.77'
      const from = { 'cf-connecting-ip': ip }
      const readers = Array.from({ length: NOTE_LIMITS.networkNewReadersPerHour }, secret)
      for (const reader of readers) expect((await s.post(reader, note(), from)).status).toBe(201)
      // One more new reader from that network, by a fresh secret: refused, in the same words.
      const fresh = await s.post(secret(), note(), from)
      expect(fresh.status).toBe(429)
      expect(await fresh.json()).toEqual({ error: { code: 'notes_refused', message: 'The author is not receiving more comments on this link for now.' } })
      // Readers already known may go on, up to the network's notes in the hour.
      let kept = NOTE_LIMITS.networkNewReadersPerHour
      for (let i = 0; kept < NOTE_LIMITS.networkPerHour; i += 1) {
        expect((await s.post(readers[i % readers.length], note(), from)).status).toBe(201)
        kept += 1
      }
      expect((await s.post(readers[0], note(), from)).status).toBe(429)
      // A reader on another network is not held back.
      expect((await s.post(secret(), note(), { 'cf-connecting-ip': '198.51.100.9' })).status).toBe(201)
      const state = await (await s.owner('')).json() as { refused: { byReason: Record<string, number> } }
      expect(state.refused.byReason).toMatchObject({ network_readers: 1, network_rate: 1 })
      // The address is kept nowhere, in any form the service was given it in.
      const stored = dump(s.state())
      for (const form of [ip, '203.0.113', '198.51.100.9']) expect(stored).not.toContain(form)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM network_key').get()).toEqual({ n: 1 })
      // The limit is a sliding hour: when the clock hour ends the network is still held back...
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 11, 0, 1)))
      expect((await s.post(secret(), note(), from)).status).toBe(429)
      // ...until an hour has passed since its notes (counted by the minute).
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 11, 6, 1)))
      expect((await s.post(secret(), note(), from)).status).toBe(201)
      // A key and its counts are deleted when the hour after theirs ends: at most two hours.
      const keyOf10 = Date.UTC(2026, 9, 15, 10) / 3_600_000
      expect(s.state().alarmAt).toBe(Date.UTC(2026, 9, 15, 12, 0))
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 12, 0, 1)))
      await svc.shares.alarm(s.shareId)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM network_key WHERE hour <= ?').get(keyOf10)).toEqual({ n: 0 })
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM network_minute WHERE hour <= ?').get(keyOf10)).toEqual({ n: 0 })
      // The 11:00 hour's key goes when 12:00's hour ends.
      expect(s.state().alarmAt).toBe(Date.UTC(2026, 9, 15, 13, 0))
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 13, 0, 1)))
      await svc.shares.alarm(s.shareId)
      expect(s.state().db.query('SELECT (SELECT COUNT(*) FROM network_key) + (SELECT COUNT(*) FROM network_minute) AS n').get()).toEqual({ n: 0 })
      expect((await s.post(secret(), note(), from)).status).toBe(201)
    })

    test('the network limit is a sliding hour: a burst either side of the clock hour cannot fill a share', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 59, 59)))
      const { first: s } = await share(await module())
      const from = { 'cf-connecting-ip': '203.0.113.88' }
      // 120 notes at 10:59:59, from four readers on one address.
      const early = Array.from({ length: NOTE_LIMITS.networkPerHour / NOTE_LIMITS.readerPerHour }, secret)
      for (const reader of early) for (let i = 0; i < NOTE_LIMITS.readerPerHour; i += 1) expect((await s.post(reader, note(), from)).status).toBe(201)
      // 80 more at 11:00:01, from fresh readers on the same address: refused, so the share is not full.
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 11, 0, 1)))
      let kept = 0
      for (let r = 0; r < 3; r += 1) {
        const reader = secret()
        for (let i = 0; i < 30 && r * 30 + i < 80; i += 1) if ((await s.post(reader, note(), from)).status === 201) kept += 1
      }
      expect(kept).toBe(0)
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: NOTE_LIMITS.networkPerHour })
      // Readers on other networks still have the rest of the share's hour.
      expect((await s.post(secret(), note(), { 'cf-connecting-ip': '198.51.100.30' })).status).toBe(201)
    })

    test('a class of 30 behind one address sends four notes each, across the clock hour', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 58)))
      const { first: s } = await share(await module())
      const from = { 'cf-connecting-ip': '192.0.2.200' }
      const pupils = Array.from({ length: 30 }, secret)
      for (let round = 0; round < 4; round += 1) {
        if (round === 2) setSystemTime(new Date(Date.UTC(2026, 9, 15, 11, 1)))
        for (const pupil of pupils) expect((await s.post(pupil, note(), from)).status).toBe(201)
      }
      expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 120 })
      expect((await s.post(pupils[0], note(), from)).status).toBe(429)
    })
  })

  describe(`${label}: refusals are counted in storage`, () => {
    const counted = async (s: { owner: (path: string) => Promise<Response> }) =>
      ((await (await s.owner('/notes')).json()) as { refused: { total: number; byReason: Record<string, number>; more: string[] } }).refused

    test('every refusal is written as it happens: an object rebuilt from storage loses none', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 5)))
      const { svc, first: s } = await share(await module())
      const flooder = secret()
      for (let i = 0; i < NOTE_LIMITS.readerPerHour; i += 1) expect((await s.post(flooder, note())).status).toBe(201)
      for (let i = 0; i < 11; i += 1) expect((await s.post(flooder, note())).status).toBe(429)
      // The runtime evicts the object; the alarm runs on a new one over the same storage.
      svc.shares.evict(s.shareId)
      await svc.shares.alarm(s.shareId)
      expect(await counted(s)).toMatchObject({ total: 11, byReason: { reader_rate: 11 }, more: [] })
    })

    test('a flood past the ceiling writes a bounded number of rows a minute, and "more than" survives the object', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 10, 5)))
      const { svc, first: s } = await share(await module())
      const flooder = secret()
      for (let i = 0; i < NOTE_LIMITS.readerPerHour; i += 1) expect((await s.post(flooder, note())).status).toBe(201)
      const changes = () => (s.state().db.query('SELECT total_changes() AS n').get() as { n: number }).n
      const before = changes()
      for (let i = 0; i < 300; i += 1) expect((await s.post(flooder, note())).status).toBe(429)
      // One write per counted refusal, one for the mark, none after.
      expect(changes() - before).toBe(REFUSALS_COUNTED_PER_MINUTE + 1)
      svc.shares.evict(s.shareId)
      await svc.shares.alarm(s.shareId)
      expect(await counted(s)).toMatchObject({ total: REFUSALS_COUNTED_PER_MINUTE, byReason: { reader_rate: REFUSALS_COUNTED_PER_MINUTE }, more: ['reader_rate'] })
      // The next minute counts one by one again; the mark stays.
      setSystemTime(new Date(Date.now() + 60_000))
      expect((await s.post(flooder, note())).status).toBe(429)
      expect(await counted(s)).toMatchObject({ total: REFUSALS_COUNTED_PER_MINUTE + 1, more: ['reader_rate'] })
    })
  })

  describe(`${label}: the author collects notes`, () => {
    test('needs the share\'s owner token; lists notes not collected; marking them collected twice changes nothing', async () => {
      const { make, first: s } = await share(await module())
      const other = await make()
      for (const token of ['', 'wrong', other.ownerToken]) {
        for (const [path, method] of [['/notes', 'GET'], ['/notes/collected', 'POST']] as const) {
          const refused = await s.owner(path, { method, body: method === 'POST' ? JSON.stringify({ keys: [] }) : undefined }, token)
          expect(refused.status).toBe(401)
          expect((await refused.json()).error.code).toBe('owner_auth_required')
        }
      }
      const marta = secret()
      const jonas = secret()
      const first = note({ name: 'Marta' })
      const second = note({ name: 'Jonas', kind: 'edit', text: 'they are often ordered' })
      await s.post(marta, first)
      await s.post(jonas, second)
      const waiting = await (await s.owner('/notes')).json() as { notes: { key: string; readerId: string; id: string; name: string; kind: string; revision: number; collectedAt: null }[]; more: boolean }
      expect(waiting.more).toBe(false)
      expect(waiting.notes.map((n) => [n.name, n.kind, n.id, n.revision, n.collectedAt])).toEqual([['Marta', 'note', first.id, 1, null], ['Jonas', 'edit', second.id, 1, null]])
      expect(waiting.notes[0].readerId).not.toBe(waiting.notes[1].readerId)
      expect(waiting.notes[0].key).toBe(`${waiting.notes[0].readerId}.${first.id}`)
      expect(JSON.stringify(waiting)).not.toContain(marta)
      const keys = waiting.notes.map((n) => n.key)
      const marked = await (await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: [...keys, 'nobody.nothing00'] }) })).json()
      expect(marked).toEqual({ collected: keys, already: [], unknown: ['nobody.nothing00'] })
      expect(await (await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys }) })).json()).toEqual({ collected: [], already: keys, unknown: [] })
      expect(((await (await s.owner('/notes')).json()) as { notes: unknown[] }).notes).toEqual([])
      // The reader still sees a collected note on the page.
      expect(((await (await s.mine(marta)).json()) as { notes: { id: string }[] }).notes.map((n) => n.id)).toEqual([first.id])
      const bad = await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: 'all' }) })
      expect(bad.status).toBe(400)
      // GET on the collected route is no route at all.
      expect((await s.owner('/notes/collected')).status).toBe(404)
    })
  })

  describe(`${label}: the Limits panel`, () => {
    const fillHour = (s: { state: () => { db: { query: (sql: string) => { run: (...args: unknown[]) => unknown } } } }, count: number, collected: number | null = null) => {
      const fill = s.state().db.query(`INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, received_at, collected_at) VALUES (?, ?, 'note', 'Annabel', 'x', 'x', '', '', ?, ?)`)
      for (let i = 0; i < count; i += 1) fill.run(`${i}`.padStart(64, 'b'), `filled-${i}`, Date.now(), collected)
    }

    test('clear and raise need the share\'s owner token, and GET on them is no route', async () => {
      const { make, first: s } = await share(await module())
      const other = await make()
      for (const token of ['', 'wrong', other.ownerToken]) {
        for (const [path, body] of [['/notes/clear', JSON.stringify({ keys: [] })], ['/notes/raise', undefined]] as const) {
          const refused = await s.owner(path, { method: 'POST', body }, token)
          expect(refused.status).toBe(401)
          expect((await refused.json()).error.code).toBe('owner_auth_required')
        }
      }
      expect((await s.owner('/notes/clear')).status).toBe(404)
      expect((await s.owner('/notes/raise')).status).toBe(404)
      expect(s.state().db.query('SELECT note_factor FROM share').get()).toEqual({ note_factor: 1 })
    })

    test('Clear handled notes deletes only notes already collected; a note not collected yet is never deleted', async () => {
      const { first: s } = await share(await module())
      const marta = secret()
      const kept = note({ name: 'Marta' })
      const handled = note({ name: 'Marta', text: 'handled already' })
      await s.post(marta, kept)
      await s.post(marta, handled)
      const waiting = await (await s.owner('/notes')).json() as { notes: { key: string; id: string }[] }
      const keyOf = (id: string) => waiting.notes.find((n) => n.id === id)!.key
      await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: [keyOf(handled.id)] }) })
      const cleared = await (await s.owner('/notes/clear', { method: 'POST', body: JSON.stringify({ keys: [keyOf(handled.id), keyOf(kept.id), 'nobody.nothing00'] }) })).json()
      expect(cleared).toEqual({ cleared: [keyOf(handled.id)], waiting: [keyOf(kept.id)], unknown: ['nobody.nothing00'] })
      expect(s.state().db.query('SELECT id FROM notes').all()).toEqual([{ id: kept.id }])
      // The reader no longer sees the cleared note; the one not collected stays.
      expect(((await (await s.mine(marta)).json()) as { notes: { id: string }[] }).notes.map((n) => n.id)).toEqual([kept.id])
      // Twice changes nothing more.
      expect(await (await s.owner('/notes/clear', { method: 'POST', body: JSON.stringify({ keys: [keyOf(handled.id)] }) })).json()).toEqual({ cleared: [], waiting: [], unknown: [keyOf(handled.id)] })
      expect((await s.owner('/notes/clear', { method: 'POST', body: JSON.stringify({ keys: 'all' }) })).status).toBe(400)
    })

    test('clearing handled notes makes room under the share\'s limit', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 11, 5)))
      const { first: s } = await share(await module())
      fillHour(s, NOTE_LIMITS.sharePerHour, Date.now())
      expect((await s.post(secret(), note())).status).toBe(429)
      const keys = (s.state().db.query('SELECT reader_key, id FROM notes LIMIT 5').all() as { reader_key: string; id: string }[]).map((row) => `${row.reader_key.slice(0, 24)}.${row.id}`)
      expect(((await (await s.owner('/notes/clear', { method: 'POST', body: JSON.stringify({ keys }) })).json()) as { cleared: string[] }).cleared).toHaveLength(5)
      expect((await s.post(secret(), note())).status).toBe(201)
    })

    test('Raise the limit for this link doubles the share\'s own limits up to the most, and no other limit', async () => {
      setSystemTime(new Date(Date.UTC(2026, 9, 15, 12, 5)))
      const { first: s } = await share(await module())
      const before = await (await s.owner('/notes')).json() as { limits: Record<string, number> }
      expect(before.limits).toEqual({ factor: 1, most: NOTE_LIMITS.shareRaiseMost, perHour: NOTE_LIMITS.sharePerHour, waiting: NOTE_LIMITS.shareWaiting, total: NOTE_LIMITS.shareTotal })
      fillHour(s, NOTE_LIMITS.sharePerHour)
      expect((await s.post(secret(), note())).status).toBe(429)
      const raised = await s.owner('/notes/raise', { method: 'POST' })
      expect(raised.status).toBe(200)
      expect((await raised.json() as { limits: Record<string, number> }).limits).toEqual({ factor: 2, most: NOTE_LIMITS.shareRaiseMost, perHour: 2 * NOTE_LIMITS.sharePerHour, waiting: 2 * NOTE_LIMITS.shareWaiting, total: 2 * NOTE_LIMITS.shareTotal })
      expect((await s.post(secret(), note())).status).toBe(201)
      // One reader's limit does not move.
      const flooder = secret()
      let accepted = 0
      for (let i = 0; i < NOTE_LIMITS.readerPerHour + 3; i += 1) if ((await s.post(flooder, note(), { 'cf-connecting-ip': '198.51.100.77' })).status === 201) accepted += 1
      expect(accepted).toBe(NOTE_LIMITS.readerPerHour)
      expect(((await (await s.owner('/notes/raise', { method: 'POST' })).json()) as { limits: { factor: number } }).limits.factor).toBe(4)
      const most = await s.owner('/notes/raise', { method: 'POST' })
      expect(most.status).toBe(409)
      expect(((await most.json()) as { error: { code: string } }).error.code).toBe('limit_at_most')
      expect(((await (await s.owner('')).json()) as { limits: { factor: number } }).limits.factor).toBe(4)
    })
  })
}
