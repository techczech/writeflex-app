// The publisher (src/main/sharing-publisher.ts; sharing ticket 03): save → publish, and nothing for a
// piece with no link that is on; several links each with their own settings; turning off closes the
// page for readers; a failed publish keeps the last good time and offers Retry; a new copy is published
// in one step, and the record changes only when the service holds it (adviser ruling, round 3). Against the real sharing service in memory, behind the
// stand-in Cloudflare (tests/helpers/sharing-publish-world.ts). No network.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { buildShipped, removeShipped, TOKEN } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import type { RenderedPiece } from '../../src/main/sharing-render.ts'
import type { ShareRecord } from '../../src/main/sharing-publisher.ts'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'

import {fakeBearer} from '../helpers/fake-auth'

beforeAll(buildShipped)
afterAll(removeShipped)

const PIECE = '---\ntitle: What a reading list is for\nstatus: drafting\nprivateCanary: FRONTMATTER_SECRET\n---\n\n# What a reading list is for\n\nA reading list is a promise.\n\nSee [[Choosing the first text]].\n'
const OTHER = '# Choosing the first text\n\nOTHER_PIECE_WORDS are only in this file.\n'
const files = { 'Teaching notes/What a reading list is for.md': PIECE, 'Teaching notes/Choosing the first text.md': OTHER }
const PATH = 'Teaching notes/What a reading list is for.md'
const OTHER_PATH = 'Teaching notes/Choosing the first text.md'

describe('publishing follows saves', () => {
  test('nothing leaves the Mac for a piece with no link, or for a save of another piece', async () => {
    const w = await publishWorld({ files })
    w.publisher.saved(w.root, [PATH, OTHER_PATH])
    await w.publisher.idle()
    expect(w.serviceCalls()).toEqual([])
    expect(w.publisher.view(w.root, PATH).mark).toEqual({ kind: 'share' })

    const made = await w.publisher.make(w.root, PATH, { name: 'Marta', comments: true })
    expect(made.ok).toBe(true)
    const before = w.serviceCalls().length
    w.publisher.saved(w.root, [OTHER_PATH])
    await w.publisher.idle()
    expect(w.serviceCalls().length).toBe(before)
  })

  test('make a link: published at once with comments on; each save publishes the new copy; the reader page shows it', async () => {
    const w = await publishWorld({ files })
    const made = await w.publisher.make(w.root, PATH, { name: '  Marta  ', comments: true })
    expect(made.ok).toBe(true)
    const link = made.view.links[0]
    expect(link).toMatchObject({ name: 'Marta', comments: true, on: true, notes: 'private', problem: null })
    expect(link.address).toBe(`https://writeflex-sharing.example.workers.dev/s/${link.shareId}`)
    expect(link.publishedAt).not.toBeNull()
    expect(made.view.mark).toEqual({ kind: 'shared' })
    const first = w.publishes()
    expect(first).toHaveLength(1)
    expect(first[0].body).toMatchObject({ revision: 1, comments: true, kind: 'piece', title: 'What a reading list is for', timeZone: 'Europe/London' })
    expect(first[0].body.chips).toEqual([{ label: 'Status', value: 'drafting' }])
    let page = await w.readerPage(link.shareId)
    expect(page.status).toBe(200)
    expect(page.text).toContain('A reading list is a promise.')

    w.write(PATH, PIECE.replace('A reading list is a promise.', 'A reading list is a contract.'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publishes()).toHaveLength(2)
    expect(w.publishes()[1].body.revision).toBe(2)
    page = await w.readerPage(link.shareId)
    expect(page.text).toContain('A reading list is a contract.')
    expect(page.text).not.toContain('A reading list is a promise.')
  })

  test('comments off: the publish says so (false), and turning them on publishes true', async () => {
    const w = await publishWorld({ files })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: false })
    expect(made.ok).toBe(true)
    expect(w.publishes()[0].body.comments).toBe(false)
    expect((await w.readerPage(made.ok ? made.shareId! : '')).text).toContain('Comments are off for this link.')
    await w.publisher.setComments(made.ok ? made.shareId : '', true)
    expect(w.publishes().at(-1)!.body.comments).toBe(true)
  })

  test('saves that arrive together publish once; a burst while publishing gives one more publish', async () => {
    const w = await publishWorld({ files })
    await w.publisher.make(w.root, PATH, { name: null, comments: true })
    for (let i = 0; i < 5; i += 1) w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publishes()).toHaveLength(2)
  })

  test('sharing one piece shares no other piece: a linked piece is never published, and its words are not in the copy', async () => {
    const w = await publishWorld({ files })
    await w.publisher.make(w.root, PATH, { name: null, comments: true })
    w.publisher.saved(w.root, [OTHER_PATH])
    await w.publisher.idle()
    const wire = w.fake.wire('service')
    expect(wire).not.toContain('OTHER_PIECE_WORDS')
    expect(w.publishes()).toHaveLength(1)
    expect(w.publishes()[0].body.parts[0].html).toContain('Choosing the first text')
    expect(w.publishes()[0].body.parts[0].html).not.toContain('<a ')
  })

  test('several links on one piece, each with its own name and settings; a save publishes to every link that is on', async () => {
    const w = await publishWorld({ files })
    const a = await w.publisher.make(w.root, PATH, { name: 'Workshop group', comments: true })
    const b = await w.publisher.make(w.root, PATH, { name: '', comments: false })
    expect(a.ok && b.ok).toBe(true)
    const view = w.publisher.view(w.root, PATH)
    expect(view.links.map((link) => [link.name, link.comments])).toEqual([['Workshop group', true], [null, false]])
    expect(new Set(view.links.map((link) => link.shareId)).size).toBe(2)
    await w.publisher.rename(view.links[1].shareId, 'Seminar 3')
    expect(w.publisher.view(w.root, PATH).links[1].name).toBe('Seminar 3')
    const before = w.publishes().length
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    const after = w.publishes().slice(before)
    expect(after.map((entry) => entry.shareId).sort()).toEqual(view.links.map((link) => link.shareId).sort())
    expect(after.find((entry) => entry.shareId === view.links[0].shareId)!.body.comments).toBe(true)
    expect(after.find((entry) => entry.shareId === view.links[1].shareId)!.body.comments).toBe(false)
  })
})

describe('turning a link off and on', () => {
  test('off: the service drops the copy, open pages get the link-off page; saves publish nothing; on: same address, published again', async () => {
    const w = await publishWorld({ files })
    const made = await w.publisher.make(w.root, PATH, { name: 'Marta', comments: true })
    const shareId = made.ok ? made.shareId! : ''
    expect((await w.readerPage(shareId)).status).toBe(200)
    const off = await w.publisher.turnOff(shareId)
    expect(off?.ok).toBe(true)
    expect(off!.view.links[0].on).toBe(false)
    expect(off!.view.mark).toEqual({ kind: 'share' })
    const closed = await w.readerPage(shareId)
    expect(closed.status).toBe(404)
    expect(closed.text).toContain('This link has been turned off')
    const before = w.publishes().length
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publishes().length).toBe(before)

    const on = await w.publisher.turnOn(shareId)
    expect(on?.ok).toBe(true)
    expect(on!.view.links[0]).toMatchObject({ on: true, shareId, problem: null })
    expect(on!.view.links[0].address).toBe(made.view.links[0].address)
    expect((await w.readerPage(shareId)).status).toBe(200)
  })
})

describe('when publishing fails', () => {
  test('the link stays on, the last good time is kept, the mark says Not published, Retry publishes', async () => {
    const w = await publishWorld({ files })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const shareId = made.ok ? made.shareId! : ''
    const good = w.publisher.view(w.root, PATH).links[0].publishedAt
    w.fake.failOnce('PUT', /\/page$/, 'network')
    w.write(PATH, PIECE.replace('promise', 'pact'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    let view = w.publisher.view(w.root, PATH)
    expect(view.links[0]).toMatchObject({ on: true, publishedAt: good })
    expect(view.links[0].problem).toMatchObject({ kind: 'offline', reason: 'WriteFlex cannot reach your sharing service.' })
    expect(view.mark).toEqual({ kind: 'not-published' })
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a promise.')

    const retried = await w.publisher.retry(shareId)
    view = retried!.view
    expect(view.links[0].problem).toBeNull()
    expect(view.mark).toEqual({ kind: 'shared' })
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a pact.')
  })

  test('a piece that cannot be read says so and publishes nothing', async () => {
    const w = await publishWorld({ files })
    await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const before = w.publishes().length
    const { rmSync } = await import('node:fs')
    rmSync(`${w.root}/${PATH}`)
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publishes().length).toBe(before)
    expect(w.publisher.view(w.root, PATH).links[0].problem?.kind).toBe('unreadable')
  })

  test('a link whose record cannot be saved is not made: nothing is published, the link is taken down, the writer is told', async () => {
    for (const how of ['fail', 'drop'] as const) {
      const w = await publishWorld({ files })
      w.recordWrites[how] = true
      const result = await w.publisher.make(w.root, PATH, { name: 'Marta', comments: true })
      expect(result.ok).toBe(false)
      expect(!result.ok && result.problem.reason).toBe('WriteFlex could not save the link on this Mac, so the link was not made and nothing was published.')
      expect(w.publishes()).toEqual([])
      expect(w.serviceCalls().some((entry) => entry.url.endsWith('/images') || /\/images\//.test(entry.url))).toBe(false)
      const created = w.serviceCalls().find((entry) => entry.method === 'POST' && entry.url.endsWith('/shares'))
      expect(created).toBeDefined()
      expect(w.serviceCalls().some((entry) => entry.method === 'POST' && entry.url.endsWith('/off'))).toBe(true)
      expect(result.view.links).toEqual([])
      expect(w.publisher.records()).toEqual([])
      // No owner key is left for a link nobody can see.
      expect(Object.keys(JSON.parse(w.secrets.store.read('sharing-links') ?? '{"tokens":{}}').tokens)).toEqual([])
    }
  })

  test('sharing not set up: Make a link says so and nothing is sent', async () => {
    const w = await publishWorld({ files })
    const access = w.setup.serviceAccess
    w.setup.serviceAccess = () => null
    const result = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    w.setup.serviceAccess = access
    expect(result.ok).toBe(false)
    expect(w.serviceCalls()).toEqual([])
  })
})

describe('keys', () => {
  test('the owner token is kept in the Keychain slot only; on the wire only in the Authorization header; the Cloudflare token never reaches the service', async () => {
    const w = await publishWorld({ files })
    const made = await w.publisher.make(w.root, PATH, { name: 'Marta', comments: true })
    expect(made.ok).toBe(true)
    const tokens = JSON.parse(w.secrets.store.read('sharing-links')!) as { tokens: Record<string, string> }
    const owner = tokens.tokens[made.ok ? made.shareId! : '']
    expect(owner.length).toBeGreaterThan(16)
    expect(JSON.stringify(w.saved())).not.toContain(owner)
    expect(JSON.stringify(made)).not.toContain(owner)
    const admin = w.setup.serviceAccess()!.key
    for (const request of w.serviceCalls()) {
      const { authorization, ...rest } = request.headers
      expect(`${request.url}\n${JSON.stringify(rest)}\n${request.body}`).not.toContain(owner)
      expect(`${request.url}\n${JSON.stringify(rest)}\n${request.body}`).not.toContain(admin)
      if (request.url.endsWith('/shares')) expect(authorization).toBe(fakeBearer(admin))
      else expect(authorization).toBe(fakeBearer(owner))
    }
    expect(w.fake.wire('service')).not.toContain(TOKEN)
  })
})

// ── The image cap (ticket 01 review hazard) ─────────────────────────────────────────────────────

function picture(seed: string): { name: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(`picture ${seed}`)
  return { name: `${createHash('sha256').update(bytes).digest('hex')}.png`, bytes }
}
/** A stand-in rendering: `count` pictures from `set`, each shown as an img. */
function stubRender(state: { set: string; count: number }) {
  return async (_root: string, _path: string, imagePath: string): Promise<RenderedPiece> => {
    const pictures = Array.from({ length: state.count }, (_unused, index) => picture(`${state.set}-${index}`))
    const html = (available: ReadonlySet<string> | null) => pictures.map((p) => (available && !available.has(p.name) ? `<p>alt ${p.name}</p>` : `<p><img src="${imagePath}${p.name}" alt=""></p>`)).join('')
    return { title: 'Pictures', chips: [], headings: [], savedAt: 1_791_965_520_000, pictures, html: html(null), htmlWith: (available) => html(available), refusedPictures: 0 }
  }
}

describe('the image cap', () => {
  test('replacing 300 pictures with 300 different ones publishes once: no page in between, and the reader page names all 300', async () => {
    const state = { set: 'a', count: 300 }
    const w = await publishWorld({ files, render: stubRender(state) })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    expect(made.ok && made.view.links[0].problem).toBeNull()
    const shareId = made.ok ? made.shareId! : ''
    state.set = 'b'
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publisher.view(w.root, PATH).links[0]).toMatchObject({ on: true, problem: null })
    const pages = w.publishes().slice(1)
    expect(pages).toHaveLength(1)
    const names = Array.from({ length: 300 }, (_unused, index) => picture(`b-${index}`).name)
    expect(pages[0].body.images).toEqual(names)
    expect(w.serviceCalls().some((entry) => entry.url.endsWith('/off') || entry.url.endsWith('/images/staged'))).toBe(false)
    expect(await heldAtService(w, shareId)).toMatchObject({ status: 'on', images: 300, staged: 0 })
    const page = await w.readerPage(shareId)
    for (const name of names) expect(page.text).toContain(`/s/${shareId}/images/${name}`)
    expect(page.text).not.toContain('alt ')
  })

  test('a piece whose own pictures are over the cap is refused with the figure, nothing is sent, the link stays on', async () => {
    const state = { set: 'a', count: 3 }
    const w = await publishWorld({ files, render: stubRender(state) })
    await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const before = w.serviceCalls().length
    state.count = SHARE_LIMITS.shareImages + 1
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.serviceCalls().length).toBe(before)
    const link = w.publisher.view(w.root, PATH).links[0]
    expect(link.on).toBe(true)
    expect(link.problem).toMatchObject({ kind: 'too-big', reason: 'This piece has 501 pictures; a link holds at most 500.' })
  })

  test('500 pictures left waiting by an abandoned run: they are cleared once, and the publish goes through', async () => {
    const state = { set: 'a', count: 10 }
    const w = await publishWorld({ files, render: stubRender(state) })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const shareId = made.ok ? made.shareId! : ''
    await stageOrphans(w, shareId, 500)
    expect(await heldAtService(w, shareId)).toMatchObject({ images: 510, staged: 500 })
    state.set = 'c'
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publisher.view(w.root, PATH).links[0]).toMatchObject({ on: true, problem: null })
    expect(w.serviceCalls().filter((entry) => entry.method === 'DELETE' && entry.url.endsWith('/images/staged'))).toHaveLength(1)
    expect(w.publishes().slice(1)).toHaveLength(1)
    expect(w.publishes().at(-1)!.body.images).toEqual(Array.from({ length: 10 }, (_unused, index) => picture(`c-${index}`).name))
    expect(await heldAtService(w, shareId)).toMatchObject({ images: 10, staged: 0 })
  })
})

// ── Adviser ruling round 3, B: the record changes only when the service holds the new copy ─────

/** Pictures `old-0..keep-1` kept from the last copy, plus `count` new ones from `set`; each shown as an img. */
function mixedRender(state: { keep: number; set: string; count: number }) {
  return async (_root: string, _path: string, imagePath: string): Promise<RenderedPiece> => {
    const pictures = [
      ...Array.from({ length: state.keep }, (_unused, index) => picture(`old-${index}`)),
      ...Array.from({ length: state.count }, (_unused, index) => picture(`${state.set}-${index}`)),
    ]
    const html = (available: ReadonlySet<string> | null) => `<p>${state.set}</p>` + pictures.map((p) => (available && !available.has(p.name) ? `<p>alt ${p.name}</p>` : `<p><img src="${imagePath}${p.name}" alt=""></p>`)).join('')
    return { title: 'Pictures', chips: [], headings: [], savedAt: 1_791_965_520_000, pictures, html: html(null), htmlWith: (available) => html(available), refusedPictures: 0 }
  }
}
type World = Awaited<ReturnType<typeof publishWorld>>
const ownerOf = (w: World, shareId: string): string => JSON.parse(w.secrets.store.read('sharing-links')!).tokens[shareId] as string
async function heldAtService(w: World, shareId: string) {
  return (await w.fake.serviceFetch(`${w.setup.serviceAccess()!.base}/shares/${shareId}`, { headers: { authorization: fakeBearer(ownerOf(w, shareId)) } })).json() as Promise<{ status: string; images: number; staged: number; revision: number }>
}
/** `count` pictures sent to the service and never published: what a run that stopped leaves there. */
async function stageOrphans(w: World, shareId: string, count: number): Promise<void> {
  const base = w.setup.serviceAccess()!.base
  for (let index = 0; index < count; index += 1) {
    const p = picture(`orphan-${index}`)
    const answer = await w.fake.serviceFetch(`${base}/shares/${shareId}/images/${p.name}`, { method: 'PUT', headers: { authorization: fakeBearer(ownerOf(w, shareId)) }, body: p.bytes as Uint8Array<ArrayBuffer> })
    expect(answer.status).toBe(200)
  }
}
/** The link's record as settings.json holds it (what the app reads after a restart). */
function savedRecord(w: World, shareId: string): ShareRecord {
  return structuredClone((w.saved() as ShareRecord[]).find((entry) => entry.shareId === shareId)!)
}

describe('a publish that stops part-way', () => {
  test('every picture upload failing: the reader page is unchanged, the record changes only in its problem, the view keeps the last time and offers Retry', async () => {
    const state = { keep: 1, set: 'a', count: 3 }
    const w = await publishWorld({ files, render: mixedRender(state) })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const shareId = made.ok ? made.shareId! : ''
    const before = savedRecord(w, shareId)
    const page = (await w.readerPage(shareId)).text
    const real = w.fake.sharingService!
    let refused = 0
    w.fake.sharingService = async (request) => {
      if (request.method === 'PUT' && /\/images\//.test(new URL(request.url).pathname)) { refused += 1; throw new TypeError('fetch failed') }
      return real(request)
    }
    state.set = 'b'
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(refused).toBeGreaterThan(0)
    expect((await w.readerPage(shareId)).text).toBe(page)
    expect(await heldAtService(w, shareId)).toMatchObject({ revision: before.revision, images: 4 })
    const after = savedRecord(w, shareId)
    expect(after.problem).toMatchObject({ kind: 'offline', reason: 'WriteFlex cannot reach your sharing service.' })
    // Ticket 04 (R12): the save that did not go out is kept on record (queuedAt), nothing else changes.
    expect(after).toEqual({ ...before, problem: after.problem, queuedAt: after.queuedAt })
    expect(after.queuedAt).not.toBeNull()
    const view = w.publisher.view(w.root, PATH)
    expect(view.links[0]).toMatchObject({ on: true, publishedAt: before.publishedAt, publishedSavedAt: before.publishedSavedAt })
    expect(view.links[0].problem).not.toBeNull()
    expect(view.mark).toEqual({ kind: 'not-published' })

    w.fake.sharingService = real
    const retried = await w.publisher.retry(shareId)
    expect(retried!.view.links[0].problem).toBeNull()
    expect(savedRecord(w, shareId)).toMatchObject({ revision: before.revision + 1, problem: null })
    expect((await w.readerPage(shareId)).text).toContain('<p>b</p>')
  })

  test('a restart after the pictures went and the page did not: the last copy\'s time and the problem; Retry publishes in one step', async () => {
    const state = { keep: 1, set: 'a', count: 3 }
    const w = await publishWorld({ files, render: mixedRender(state) })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const shareId = made.ok ? made.shareId! : ''
    const before = savedRecord(w, shareId)
    state.set = 'b'
    w.fake.failOnce('PUT', /\/page$/, 'network')
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    // Every new picture is waiting at the service; readers still have the last copy.
    expect(await heldAtService(w, shareId)).toMatchObject({ revision: before.revision, staged: 3 })
    expect((await w.readerPage(shareId)).text).toContain('<p>a</p>')

    // The app starts again: a new publisher over the same settings.json and Keychain.
    const again = w.newPublisher()
    const link = again.view(w.root, PATH).links[0]
    expect(link).toMatchObject({ on: true, publishedAt: before.publishedAt })
    expect(link.problem).toMatchObject({ kind: 'offline' })
    expect(savedRecord(w, shareId)).toEqual({ ...before, problem: savedRecord(w, shareId).problem, queuedAt: savedRecord(w, shareId).queuedAt })
    expect(savedRecord(w, shareId).queuedAt).not.toBeNull()

    const pagesBefore = w.publishes().length
    const retried = await again.retry(shareId)
    expect(retried!.view.links[0].problem).toBeNull()
    expect(w.publishes().length - pagesBefore).toBe(1)
    const after = savedRecord(w, shareId)
    expect(after).toMatchObject({ revision: before.revision + 1, problem: null, images: [picture('old-0').name, ...[0, 1, 2].map((index) => picture(`b-${index}`).name)] })
    expect(await heldAtService(w, shareId)).toMatchObject({ revision: after.revision, images: 4, staged: 0 })
    expect((await w.readerPage(shareId)).text).toContain('<p>b</p>')
  })

  test('a request dropped at any point, before the service acts or after: the record is the last one plus its problem, or the new one, never a mix', async () => {
    const wanted = [picture('old-0').name, picture('b-0').name, picture('b-1').name]
    /** The new copy in full: its text, and every picture shown, none as its description. */
    const newCopy = (page: string): boolean => page.includes('<p>b</p>') && !page.includes('alt ') && wanted.every((name) => page.includes(`/images/${name}"`))
    let swept = 0
    for (const mode of ['before', 'after'] as const) {
      for (let at = 0; ; at += 1) {
        const state = { keep: 1, set: 'a', count: 2 }
        const w = await publishWorld({ files, render: mixedRender(state) })
        const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
        const shareId = made.ok ? made.shareId! : ''
        // Pictures an abandoned run left waiting, so the publish also clears them (DELETE staged).
        await stageOrphans(w, shareId, 500)
        const before = savedRecord(w, shareId)
        const lastPage = (await w.readerPage(shareId)).text
        state.set = 'b'
        Object.assign(w.fault, { count: 0, mode, at })
        w.publisher.saved(w.root, [PATH])
        await w.publisher.idle()
        const requests = w.fault.count
        w.fault.at = null
        const after = savedRecord(w, shareId)
        const page = (await w.readerPage(shareId)).text
        const where = `${mode} request ${at}`
        if (after.problem === null) {
          // Ticket 04 (R-D): the record also names what this copy is, so a start publishes only a change.
          expect({ where, after }).toMatchObject({ where, after: { ...before, publishedAt: after.publishedAt, publishedHash: after.publishedHash, revision: (await heldAtService(w, shareId)).revision, images: wanted, problem: null, note: null } })
          expect({ where, hash: after.publishedHash !== before.publishedHash && /^[0-9a-f]{64}$/.test(after.publishedHash ?? '') }).toEqual({ where, hash: true })
          expect(after.publishedAt!).toBeGreaterThanOrEqual(before.publishedAt!)
          expect({ where, complete: newCopy(page) }).toEqual({ where, complete: true })
        } else {
          expect({ where, after }).toEqual({ where, after: { ...before, problem: after.problem, queuedAt: after.queuedAt } })
          expect({ where, kept: after.queuedAt !== null }).toEqual({ where, kept: true })
          // Readers have a complete copy: the last one, or (the page's answer lost) the new one.
          expect({ where, complete: page === lastPage || newCopy(page) }).toEqual({ where, complete: true })
        }
        // Retry always ends on the new copy, with the record naming what the service holds.
        await w.publisher.retry(shareId)
        const healed = savedRecord(w, shareId)
        expect({ where, problem: healed.problem, images: healed.images }).toEqual({ where, problem: null, images: wanted })
        expect(healed.revision).toBe((await heldAtService(w, shareId)).revision)
        swept += 1
        if (at >= requests) {
          // The fault was never reached: every request of the publish has been dropped once.
          expect(after.problem).toBeNull()
          // A picture refused as full, DELETE staged, the two new pictures, the page.
          expect(requests).toBe(5)
          break
        }
      }
    }
    expect(swept).toBe(12)
  }, 60_000)
})

describe('pictures the service says it is missing', () => {
  test('are no longer counted as held, and are sent again', async () => {
    const state = { set: 'a', count: 3 }
    const w = await publishWorld({ files, render: stubRender(state) })
    const made = await w.publisher.make(w.root, PATH, { name: null, comments: true })
    const shareId = made.ok ? made.shareId! : ''
    // Another Mac publishes a copy without pictures: the service drops them; this Mac's record still names them.
    const owner = JSON.parse(w.secrets.store.read('sharing-links')!).tokens[shareId] as string
    const base = w.setup.serviceAccess()!.base
    const { revision } = await heldAtService(w, shareId)
    const other = { revision: revision + 1, savedAt: 1_791_965_520_000, timeZone: 'Europe/London', lang: 'en', comments: true, kind: 'piece', title: 'Elsewhere', chips: [], parts: [{ title: 'Elsewhere', html: '<p>elsewhere</p>', headings: [] }], images: [] }
    expect((await w.fake.serviceFetch(`${base}/shares/${shareId}/page`, { method: 'PUT', headers: { authorization: fakeBearer(owner), 'content-type': 'application/json' }, body: JSON.stringify(other) })).status).toBe(200)
    expect(await heldAtService(w, shareId)).toMatchObject({ images: 0 })
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(w.publisher.view(w.root, PATH).links[0].problem).toBeNull()
    expect(await heldAtService(w, shareId)).toMatchObject({ images: 3 })
    expect((await w.readerPage(shareId)).text).not.toContain('elsewhere')
  })
})
