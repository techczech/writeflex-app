import { describe, expect, test } from 'bun:test'
import { checkedNote } from '../../src/main/sharing-reader-notes'
import * as service from '../../sharing-service/index.ts'
import { readerKeyOf, NOTE_LIMITS } from '../../sharing-service/reader-notes.ts'
import { share, note as makeNote, secret } from '../helpers/sharing-service-notes-suite'
import type { ServiceModule } from '../helpers/sharing-service-runtime'

const note = (over: Record<string, unknown> = {}) => makeNote({ visibility: 'open', ...over })

async function setup(mode: 'private' | 'open' = 'open') {
  const world = await share(service as unknown as ServiceModule)
  const s = world.first
  const settings = (notes: string, token?: string) => s.owner('/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes }) }, token)
  const visible = (reader: string) => world.svc.call(`/s/${s.shareId}/notes/visible`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader }) })
  expect((await settings(mode)).status).toBe(200)
  return { ...world, s, settings, visible }
}

describe('open comments through the authenticated Worker paths', () => {
  test('open comments, outcomes and author replies are visible; reader replies are collected on the original thread', async () => {
    const { s, visible } = await setup()
    const a = secret(), b = secret()
    const posted = await (await s.post(a, note({ name: 'Marta' }))).json() as any
    const viewed = await (await visible(b)).json() as any
    expect(viewed.notes).toHaveLength(1)
    expect(viewed.notes[0]).toMatchObject({ name: 'Marta', mine: false, threadId: posted.note.threadId })
    expect(JSON.stringify(viewed)).not.toMatch(/reader_key|readerId/)
    const waiting = await (await s.owner('/notes')).json() as any
    const key = waiting.notes[0].key
    await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: [key] }) })
    await s.owner('/notes/outcomes', { method: 'POST', body: JSON.stringify({ outcomes: [{ key, outcome: 'accepted', at: Date.now(), replies: [{ id: 'owner-reply-01', text: 'Thanks', at: Date.now(), visibility: 'open' }] }] }) })
    expect((await (await visible(b)).json() as any).notes[0]).toMatchObject({ status: 'accepted', replies: [{ text: 'Thanks' }] })
    expect((await s.post(b, note({ name: 'Jonas', text: 'I agree', replyTo: posted.note.threadId }))).status).toBe(201)
    const incoming = await (await s.owner('/notes')).json() as any
    expect(incoming.notes).toHaveLength(1)
    expect(incoming.notes[0]).toMatchObject({ name: 'Jonas', replyTo: { key, name: 'Marta' }, anchor: posted.note.anchor })
    expect((await (await s.mine(b)).json() as any).notes).toHaveLength(1)
    await s.owner('/notes/clear', { method: 'POST', body: JSON.stringify({ keys: [key] }) })
    expect((await (await s.owner('/notes')).json() as any).notes[0].replyTo).toMatchObject({ key, name: 'Marta', text: posted.note.text })
  })

  test('private eras never become public; switching back closes reads and every reply probe immediately', async () => {
    const { s, settings, visible, svc } = await setup('private')
    const a = secret(), b = secret()
    const hidden = await (await s.post(a, note({ name: 'Private Marta', text: 'Private wording' }))).json() as any
    expect((await settings('open')).status).toBe(200)
    expect((await (await visible(b)).json() as any).notes).toEqual([])
    const publicNote = await (await s.post(a, note({ name: 'Open Marta' }))).json() as any
    const target = publicNote.note.threadId
    expect((await s.post(b, note({ name: 'Jonas', replyTo: target }))).status).toBe(201)
    expect((await settings('private')).status).toBe(200)
    const privateView = await (await visible(b)).json() as any
    expect(privateView.notes).toHaveLength(1)
    expect(JSON.stringify(privateView)).not.toMatch(/Marta|Private wording/)
    for (const replyTo of [target, hidden.note.threadId ?? 'a'.repeat(32), 'f'.repeat(32)]) {
      const refused = await s.post(b, note({ replyTo }))
      expect(refused.status).toBe(403)
      expect(await refused.json()).toMatchObject({ error: { code: 'reply_unavailable' } })
    }
    expect((await s.post(b, note({ id: publicNote.note.id, replyTo: target }))).status).toBe(403)
    expect((await (await s.mine(b)).json() as any).notes).toHaveLength(1)
    expect((await svc.call(`/s/${s.shareId}/notes/visible`, { method: 'GET' })).status).toBe(404)
    expect((await settings('open', 'wrong-owner')).status).toBe(401)
  })

  test('replies share comment input and reader budgets and cannot target private or foreign comments', async () => {
    const { s, settings, visible, make } = await setup('private')
    const a = secret(), b = secret()
    const hidden = await (await s.post(a, note())).json() as any
    s.state().db.query('UPDATE notes SET public_id = ? WHERE id = ?').run('a'.repeat(32), hidden.note.id)
    await settings('open')
    const publicNote = await (await s.post(a, note())).json() as any
    const target = publicNote.note.threadId
    for (const replyTo of [hidden.note.threadId ?? 'a'.repeat(32), 'f'.repeat(32)]) expect((await s.post(b, note({ replyTo }))).status).toBe(403)
    expect((await s.post(b, note({ replyTo: target, text: 'x'.repeat(4001) }))).status).toBe(400)
    expect((await s.post(b, note({ replyTo: target, name: 'bad\nname' }))).status).toBe(400)
    const other = await make()
    expect((await other.owner('/settings', { method: 'POST', body: JSON.stringify({ notes: 'open' }) })).status).toBe(200)
    expect((await other.post(b, note({ replyTo: target }))).status).toBe(403)
    for (let i = 0; i < NOTE_LIMITS.readerPerHour; i++) expect((await s.post(b, note({ replyTo: target }))).status).toBe(201)
    expect((await s.post(b, note({ replyTo: target }))).status).toBe(429)
    expect((await (await visible(a)).json() as any).notes).toHaveLength(NOTE_LIMITS.readerPerHour + 2)
  })
})

test('a privacy switch during a reply budget request refuses it and refunds its place', async () => {
  const { s, settings, svc } = await setup()
  const root = await (await s.post(secret(), note())).json() as any
  let release!: () => void, started!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const waiting = new Promise<void>((r) => { started = r })
  const real = svc.registry.get.bind(svc.registry)
  svc.registry.get = (id: unknown) => {
    const stub = real(id)
    return { fetch: async (request: Request) => {
      if (new URL(request.url).pathname === '/internal/note-budget') { started(); await gate }
      return stub.fetch(request)
    } }
  }
  const reply = s.post(secret(), note({ replyTo: root.note.threadId }))
  try {
    await waiting
    expect((await settings('private')).status).toBe(200)
  } finally { release() }
  expect((await reply).status).toBe(403)
  expect(s.state().db.query('SELECT COUNT(*) AS n FROM notes').get()).toEqual({ n: 1 })
  const registry = [...svc.registry.states.values()][0]
  expect(registry.db.query('SELECT SUM(granted) AS n FROM note_budget').get()).toEqual({ n: 1 })
})

test('legacy storage migrates to private without changing owner credentials or the published revision', async () => {
  const { svc, first: s } = await share(service as unknown as ServiceModule)
  const reader = secret()
  const existing = note()
  await s.post(reader, existing)
  const db = s.state().db
  db.exec('DROP INDEX notes_public_id')
  db.exec('DROP INDEX notes_visible')
  for (const column of ['visibility', 'public_id', 'parent_id', 'parent_context']) db.exec(`ALTER TABLE notes DROP COLUMN ${column}`)
  db.exec('ALTER TABLE share DROP COLUMN comments_mode')
  db.query("INSERT INTO note_replies (note_seq, id, text, at, received_at) VALUES (1, 'legacy-reply', 'Private legacy reply', 1, 1)").run()
  db.exec('ALTER TABLE note_replies DROP COLUMN visibility')
  svc.shares.evict(s.shareId)
  const before = await (await s.owner('')).json() as any
  expect(before.commentsMode).toBe('private')
  expect(before.revision).toBe(1)
  expect((await (await s.mine(reader)).json() as any).notes[0]).toMatchObject({ id: existing.id, replies: [{ text: 'Private legacy reply' }] })
  expect(db.query('SELECT visibility FROM note_replies').get()).toEqual({ visibility: 'private' })
  expect((await s.owner('/settings', { method: 'POST', body: JSON.stringify({ notes: 'open' }) })).status).toBe(200)
  const other = await svc.call(`/s/${s.shareId}/notes/visible`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reader: secret() }) })
  expect((await other.json() as any).notes).toEqual([])
})


test('visible reads keep all own comments and only the newest 200 others, with bounded author replies', async () => {
  const { s, visible } = await setup()
  const reader = secret()
  const own = await readerKeyOf(s.shareId, reader)
  const db = s.state().db
  const insert = db.query("INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, received_at, visibility, public_id) VALUES (?, ?, 'note', 'Reader', ?, 'words', '', '', 1, ?, ?)")
  for (let i = 0; i < 201; i++) {
    insert.run('f'.repeat(64), `other-${i}`, `Other ${i}`, 'open', i.toString(16).padStart(32, '0'))
    const seq = (db.query('SELECT last_insert_rowid() AS seq').get() as any).seq
    db.query("INSERT INTO note_replies (note_seq, id, text, at, received_at, visibility) VALUES (?, 'reply-001', ?, 1, 1, 'open')").run(seq, `Reply ${i}`)
  }
  // Every own comment remains, regardless of age or visibility, up to the existing reader cap.
  for (let i = 0; i < NOTE_LIMITS.readerTotal; i++) insert.run(own, `mine-${i}`, `Own ${i}`, 'private', null)
  // Cloudflare Durable Object SQL accepts at most 100 bound parameters per query.
  const sql = s.state().storage.sql
  const exec = sql.exec.bind(sql)
  sql.exec = (query, ...bindings) => {
    expect(bindings.length).toBeLessThanOrEqual(100)
    return exec(query, ...bindings)
  }
  const body = await (await visible(reader)).json() as any
  expect(body.more).toBe(true)
  expect(body.notes).toHaveLength(NOTE_LIMITS.readerTotal + 200)
  expect(body.notes.filter((n: any) => n.mine)).toHaveLength(NOTE_LIMITS.readerTotal)
  expect(body.notes.filter((n: any) => !n.mine).map((n: any) => n.text)).toEqual(Array.from({ length: 200 }, (_, i) => `Other ${i + 1}`))
  expect(body.notes.filter((n: any) => !n.mine).flatMap((n: any) => n.replies.map((r: any) => r.text))).toEqual(Array.from({ length: 200 }, (_, i) => `Reply ${i + 1}`))
  db.query("DELETE FROM notes WHERE id = 'other-0'").run()
  expect((await (await visible(reader)).json() as any).more).toBe(false)
})

test('only explicit reader consent on an open link writes an open comment or reply', async () => {
  const { s, settings, visible } = await setup()
  const author = secret(), other = secret()
  const root = await (await s.post(author, note())).json() as any
  for (const visibility of [undefined, 'private', 'invalid']) {
    for (const replyTo of [undefined, root.note.threadId]) {
      const sent = await s.post(author, note({ visibility, replyTo }))
      expect(sent.status).toBe(201)
      expect((await sent.json() as any).note.visibility).toBe('private')
    }
  }
  expect((await (await visible(other)).json() as any).notes).toHaveLength(1)
  await settings('private')
  expect((await (await s.post(author, note())).json() as any).note.visibility).toBe('private')
})

test('private author replies stay private after reopening, including resends', async () => {
  const { s, settings, visible } = await setup()
  const author = secret(), other = secret()
  await s.post(author, note())
  const key = (await (await s.owner('/notes')).json() as any).notes[0].key
  await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: [key] }) })
  const reply = { id: 'private-reply', text: 'For you alone', at: Date.now() }
  const send = (replies: any[]) => s.owner('/notes/outcomes', { method: 'POST', body: JSON.stringify({ outcomes: [{ key, outcome: null, at: Date.now(), replies }] }) })
  await settings('private')
  expect((await send([reply])).status).toBe(200)
  await settings('open')
  await send([reply, { id: 'public-reply', text: 'For everyone', at: Date.now(), visibility: 'open' }])
  expect((await (await visible(other)).json() as any).notes[0].replies.map((r: any) => r.text)).toEqual(['For everyone'])
  expect((await (await s.mine(author)).json() as any).notes[0].replies.map((r: any) => r.text)).toEqual(['For you alone', 'For everyone'])
})

test('other readers can still see and reply to proposed edits on open links', async () => {
  const { s, visible } = await setup()
  const edit = await (await s.post(secret(), note({ kind: 'edit', text: 'Suggested wording' }))).json() as any
  const other = secret()
  expect((await (await visible(other)).json() as any).notes[0]).toMatchObject({ kind: 'edit', text: 'Suggested wording' })
  expect((await s.post(other, note({ replyTo: edit.note.threadId }))).status).toBe(201)
})


test('consent requires open at both checks around the service budget await', async () => {
  for (const initial of ['private', 'open'] as const) {
    const { s, settings, svc, visible } = await setup(initial)
    let release!: () => void, started!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const waiting = new Promise<void>((r) => { started = r })
    const real = svc.registry.get.bind(svc.registry)
    svc.registry.get = (id: unknown) => {
      const stub = real(id)
      return { fetch: async (request: Request) => {
        if (new URL(request.url).pathname === '/internal/note-budget') { started(); await gate }
        return stub.fetch(request)
      } }
    }
    const sending = s.post(secret(), note())
    try { await waiting; await settings(initial === 'private' ? 'open' : 'private') }
    finally { release() }
    expect((await (await sending).json() as any).note.visibility).toBe('private')
    await settings('open')
    expect((await (await visible(secret())).json() as any).notes).toEqual([])
  }
})

test('owner reply consent is fixed at writing, defaults private, and is narrowed at receipt', async () => {
  const { s, settings, visible } = await setup()
  const author = secret(), other = secret()
  await s.post(author, note())
  const key = (await (await s.owner('/notes')).json() as any).notes[0].key
  await s.owner('/notes/collected', { method: 'POST', body: JSON.stringify({ keys: [key] }) })
  const send = (replies: any[]) => s.owner('/notes/outcomes', { method: 'POST', body: JSON.stringify({ outcomes: [{ key, outcome: null, at: null, replies }] }) })
  const written = (id: string, visibility?: string) => ({ id, text: id, at: Date.now(), visibility })
  const delayed = written('written-private', 'private')
  await settings('private')
  await send([written('open-received-private', 'open')])
  await settings('open')
  await send([delayed, written('legacy-missing'), written('invalid-mode', 'invalid'), written('both-open', 'open')])
  // Retrying with broader consent cannot promote a reply already stored private.
  await send([{ ...delayed, visibility: 'open' }])
  expect((await (await visible(other)).json() as any).notes[0].replies.map((r: any) => r.text)).toEqual(['both-open'])
  expect((await (await s.mine(author)).json() as any).notes[0].replies).toHaveLength(5)
  // Every owner Mac retains the service's narrowed consent; reader views still expose only public replies.
  const retained = (await (await s.owner('/notes/state', { method: 'POST', body: JSON.stringify({ after: 0 }) })).json() as any).notes[0]
  expect(Object.fromEntries(retained.replies.map((r: any) => [r.id, r.visibility]))).toEqual({
    'open-received-private': 'private', 'written-private': 'private', 'legacy-missing': 'private', 'invalid-mode': 'private', 'both-open': 'open',
  })
  expect(checkedNote(retained)?.state?.replies).toEqual(retained.replies)

})

test('capped replies bring only their open roots into the visible set, with author replies and bounded bindings', async () => {
  const { s, visible, settings } = await setup()
  const db = s.state().db
  const root = await (await s.post(secret(), note({ text: 'Old root' }))).json() as any
  const unneeded = await (await s.post(secret(), note({ text: 'Old unrelated root' }))).json() as any
  const reply = await (await s.post(secret(), note({ text: 'Recent reply', replyTo: root.note.threadId }))).json() as any
  const rootSeq = (db.query('SELECT seq FROM notes WHERE public_id = ?').get(root.note.threadId) as any).seq
  db.query("INSERT INTO note_replies (note_seq, id, text, at, received_at, visibility) VALUES (?, 'root-answer', 'Author on root', 1, 1, 'open')").run(rootSeq)
  const insert = db.query("INSERT INTO notes (reader_key, id, kind, name, text, quote, before_text, after_text, received_at, visibility, public_id) VALUES (?, ?, 'note', 'Reader', 'Filler', 'words', '', '', 1, 'open', ?)")
  for (let i = 0; i < 199; i++) insert.run('f'.repeat(64), `filler-${i}`, i.toString(16).padStart(32, 'f'))
  const exec = s.state().storage.sql.exec.bind(s.state().storage.sql)
  s.state().storage.sql.exec = (query, ...bindings) => { expect(bindings.length).toBeLessThanOrEqual(100); return exec(query, ...bindings) }
  const reader = secret()
  const body = await (await visible(reader)).json() as any
  expect(body.more).toBe(true)
  expect(body.notes).toHaveLength(201)
  expect(body.notes.find((n: any) => n.threadId === root.note.threadId)).toMatchObject({ text: 'Old root', replies: [{ text: 'Author on root' }] })
  expect(body.notes.find((n: any) => n.threadId === reply.note.threadId).replyTo).toBe(root.note.threadId)
  expect(body.notes.some((n: any) => n.threadId === unneeded.note.threadId)).toBe(false)
  await settings('private')
  expect((await (await visible(reader)).json() as any).notes).toEqual([])
})
