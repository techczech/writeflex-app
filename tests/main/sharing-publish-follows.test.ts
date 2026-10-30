import { cleanUpScratch } from '../helpers/scratch-dirs'
// Publishing follows the piece (sharing ticket 04; spec section 5 rule 5; section 6.1 rows "Shared, you
// offline or app closed" to "App restarted", "Very large piece", "Piece with images"; test matrix row
// Publish). One case per row, against the real sharing service in memory behind the stand-in Cloudflare
// (tests/helpers/sharing-publish-world.ts): no network, and offline is the world's own switch.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import { renderPieceForSharing, type RenderedPiece } from '../../src/main/sharing-render.ts'
import { followMove, endedByTrash } from '../../src/main/sharing-follow.ts'
import type { ShareRecord } from '../../src/main/sharing-publisher.ts'
import { SHARE_LIMITS } from '../../sharing-service/share-protocol.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const PIECE = '# What a reading list is for\n\nA reading list is a promise.\n'
const PATH = 'Teaching notes/What a reading list is for.md'
const files = { [PATH]: PIECE, 'Teaching notes/Other.md': '# Other\n\nOther words.\n' }
/** Retries never fire by themselves unless a case asks: reconnecting is driven by the case. */
const NO_TIMER = { retryMs: [3_600_000] }

async function shared(options: Parameters<typeof publishWorld>[0] = {}) {
  const w = await publishWorld({ files, ...options, ports: { ...NO_TIMER, ...options.ports } })
  const made = await w.publisher.make(w.root, PATH, { name: 'Marta', comments: true })
  expect(made.ok).toBe(true)
  const shareId = made.ok ? made.shareId! : ''
  const record = (): ShareRecord => (w.saved() as ShareRecord[]).find((entry) => entry.shareId === shareId)!
  const pages = () => w.publishes().filter((entry) => entry.shareId === shareId)
  const base = w.setup.serviceAccess()!.base
  return { w, shareId, record, pages, base }
}

describe('rename and move: the share follows', () => {
  test('rename: the record takes the new path, the save publishes once to the same address, and nothing reads the old path', async () => {
    const { w, shareId, record, pages } = await shared()
    const address = w.publisher.view(w.root, PATH).links[0].address
    const to = 'Teaching notes/Reading lists.md'
    renameSync(join(w.root, PATH), join(w.root, to))
    w.publisher.moved(w.root, PATH, to)
    w.publisher.saved(w.root, [PATH, to])
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: to, on: true, problem: null, ended: null })
    expect(pages()).toHaveLength(2)
    expect(w.publisher.view(w.root, to).links[0]).toMatchObject({ shareId, address, on: true })
    expect(w.publisher.view(w.root, PATH).links).toEqual([])
  })

  test('move: a folder renamed carries the piece link, and a Folio link with its part keys and parts', async () => {
    const r = { root: '/w', kind: 'piece' as const, path: 'A/B/p.md', partKeys: {}, parts: [] }
    expect(followMove(r, '/w', 'A', 'C')?.path).toBe('C/B/p.md')
    expect(followMove(r, '/w', 'A/B/p.md', 'D/p.md')?.path).toBe('D/p.md')
    expect(followMove(r, '/w', 'AB', 'C')).toBeNull()
    expect(followMove(r, '/other', 'A', 'C')).toBeNull()
    const folio = { root: '/w', kind: 'folio' as const, path: 'F', partKeys: { 'F/one.md': 'aaaaaa', 'F/two.md': 'bbbbbb' }, parts: [{ path: 'F/one.md', title: 'One', missing: false }] }
    expect(followMove(folio, '/w', 'F/one.md', 'F/first.md')).toMatchObject({ path: 'F', partKeys: { 'F/first.md': 'aaaaaa', 'F/two.md': 'bbbbbb' }, parts: [{ path: 'F/first.md' }] })
    expect(followMove(folio, '/w', 'F', 'G')).toMatchObject({ path: 'G', partKeys: { 'G/one.md': 'aaaaaa', 'G/two.md': 'bbbbbb' }, parts: [{ path: 'G/one.md' }] })

    const { w, shareId, record } = await shared()
    renameSync(join(w.root, 'Teaching notes'), join(w.root, 'Seminars'))
    w.publisher.moved(w.root, 'Teaching notes', 'Seminars')
    w.publisher.saved(w.root, ['Teaching notes', 'Seminars'])
    await w.publisher.idle()
    expect(record()).toMatchObject({ shareId, path: 'Seminars/What a reading list is for.md', on: true, ended: null })
  })
})

describe('Trash: the share ends and its copy is removed', () => {
  test('Trash ends it: the copy and its pictures go, saves publish nothing; restored, the page offers Turn on at the same address', async () => {
    const pictured = (root: string, path: string, imagePath: string): Promise<RenderedPiece> => renderPieceForSharing(root, path, imagePath).then((piece) => ({ ...piece, pictures: [picture('one')], html: `${piece.html}<img src="${imagePath}${picture('one').name}">` }))
    const { w, shareId, record, pages, base } = await shared({ render: pictured, ports: { exists: (root, path) => Bun.file(join(root, path)).size > 0 } })
    const image = `${base}/s/${shareId}/images/${picture('one').name}`
    expect((await w.fake.serviceFetch(image)).status).toBe(200)
    const address = w.publisher.view(w.root, PATH).links[0].address

    rmSync(join(w.root, PATH))
    await w.publisher.trashed(w.root, [PATH])
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(record()).toMatchObject({ on: false, ended: { removed: true }, images: [] })
    expect((await w.readerPage(shareId)).status).toBe(404)
    expect((await w.fake.serviceFetch(image)).status).toBe(404)
    expect(pages()).toHaveLength(1)
    expect(w.publisher.view(w.root, PATH).links[0].ended).toEqual({ removed: true, back: false })

    w.write(PATH, PIECE)
    expect(w.publisher.view(w.root, PATH).links[0].ended).toEqual({ removed: true, back: true })
    const on = await w.publisher.turnOn(shareId)
    expect(on?.ok && on.view.links[0]).toMatchObject({ on: true, address, problem: null, ended: null })
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a promise.')
  })

  test('a folder sent to the Trash ends the shares in it; a share elsewhere is untouched', () => {
    expect(endedByTrash({ root: '/w', path: 'A/p.md' }, '/w', ['A'])).toBe(true)
    expect(endedByTrash({ root: '/w', path: 'AB/p.md' }, '/w', ['A'])).toBe(false)
    expect(endedByTrash({ root: '/w', path: 'F' }, '/w', ['F'])).toBe(true)
    expect(endedByTrash({ root: '/w', path: '' }, '/w', ['F'])).toBe(false)
  })

  test('Trash while offline: the removal is owed through a restart and goes once the service answers', async () => {
    const { w, shareId, record } = await shared()
    w.net.offline = true
    rmSync(join(w.root, PATH))
    await w.publisher.trashed(w.root, [PATH])
    expect(record()).toMatchObject({ on: true, ended: { removed: false } })
    expect(w.publisher.view(w.root, PATH).links[0]).toMatchObject({ queued: false, ended: { removed: false } })
    // Ended: never published again, whatever saves say.
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()

    const again = w.restart().publisher
    w.net.offline = false
    again.resume()
    await again.idle()
    expect(record()).toMatchObject({ on: false, ended: { removed: true } })
    expect((await w.readerPage(shareId)).status).toBe(404)
    expect(w.serviceCalls().filter((entry) => entry.url.endsWith('/off'))).toHaveLength(1)
  })
})

describe('change made outside WriteFlex', () => {
  test('published on the next detected change, as a save', async () => {
    const { w, shareId, pages } = await shared()
    w.write(PATH, PIECE.replace('promise', 'pact'))
    // The Workspace watcher's paths reach the same signal as a save.
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(pages()).toHaveLength(2)
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a pact.')
  })
})

describe('offline or app closed: saves queue and publish in order on return', () => {
  test('offline saves are kept on this Mac, survive a restart, and go out once, the latest, when the service answers', async () => {
    const { w, shareId, record, pages } = await shared()
    w.net.offline = true
    w.write(PATH, PIECE.replace('promise', 'first save'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    w.write(PATH, PIECE.replace('promise', 'second save'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(record().queuedAt).not.toBeNull()
    expect(w.publisher.view(w.root, PATH).links[0]).toMatchObject({ queued: true, problem: { kind: 'offline' } })
    const before = record().revision

    const again = w.restart().publisher
    w.net.offline = false
    again.resume()
    await again.idle()
    expect(pages()).toHaveLength(2)
    expect(pages()[1].body.revision).toBe(before + 1)
    expect(record()).toMatchObject({ queuedAt: null, problem: null, revision: before + 1 })
    const page = (await w.readerPage(shareId)).text
    expect(page).toContain('A reading list is a second save.')
    expect(page).not.toContain('first save')
    // Nothing more goes out: resume again finds nothing queued.
    again.resume()
    await again.idle()
    expect(pages()).toHaveLength(2)
  })

  test('the service could not be reached: tried again after a pause, and at once when the Mac is back online', async () => {
    const { w, pages } = await shared({ ports: { retryMs: [20] } })
    w.net.offline = true
    w.write(PATH, PIECE.replace('promise', 'pact'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(pages()).toHaveLength(1)
    w.net.offline = false
    await new Promise((done) => setTimeout(done, 60))
    await w.publisher.idle()
    expect(pages()).toHaveLength(2)

    w.net.offline = true
    w.write(PATH, PIECE.replace('promise', 'vow'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    w.net.offline = false
    w.publisher.reconnected()
    await w.publisher.idle()
    expect(pages()).toHaveLength(3)
    expect(pages()[2].body.parts[0].html).toContain('vow')
  })
})

describe('a start looks at every share (ruling R-D)', () => {
  test('deleted while WriteFlex was closed: not found at the next start; the copy kept, nothing removed', async () => {
    const { w, shareId, record } = await shared()
    rmSync(join(w.root, PATH))
    const again = w.restart().publisher
    await again.resume()
    await again.idle()
    expect(record()).toMatchObject({ on: true, ended: null, lost: { why: 'gone', candidate: null } })
    expect(again.view(w.root, PATH).links[0]).toMatchObject({ on: true, lost: { why: 'gone', candidate: null } })
    expect((await w.readerPage(shareId)).status).toBe(200)
    expect(w.serviceCalls().filter((entry) => entry.url.endsWith('/off') || entry.method === 'DELETE')).toEqual([])
  })

  test('edited while WriteFlex was closed: published once at the next start; unchanged, nothing is sent', async () => {
    const { w, shareId, record, pages } = await shared()
    // Unchanged: a start sends nothing.
    let again = w.restart().publisher
    await again.resume()
    await again.idle()
    expect(pages()).toHaveLength(1)
    w.write(PATH, PIECE.replace('promise', 'changed while closed'))
    again = w.restart().publisher
    await again.resume()
    await again.idle()
    expect(pages()).toHaveLength(2)
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a changed while closed.')
    expect(record()).toMatchObject({ lost: null, problem: null, queuedAt: null })
    // Published once: the next start finds it the same.
    again = w.restart().publisher
    await again.resume()
    await again.idle()
    expect(pages()).toHaveLength(2)
  })

  test('moved while WriteFlex was closed: not found, with the same file offered as "Follow to"; never followed by itself', async () => {
    const { w, shareId, record, pages } = await shared()
    const to = 'Archive/Reading lists.md'
    mkdirSync(join(w.root, 'Archive'))
    renameSync(join(w.root, PATH), join(w.root, to))
    const again = w.restart().publisher
    await again.resume()
    await again.idle()
    expect(record()).toMatchObject({ path: PATH, on: true, lost: { why: 'gone', candidate: to } })
    expect(pages()).toHaveLength(1)
    const followed = await again.followTo(shareId)
    expect(followed?.ok).toBe(true)
    await again.idle()
    expect(record()).toMatchObject({ path: to, on: true, lost: null })
    expect(pages()).toHaveLength(2)
  })
})

describe('a record change that cannot be saved (ruling R-F)', () => {
  test('Trash, move and a save whose record cannot be written: the share stays as it was and the link says so', async () => {
    const { w, shareId, record, pages } = await shared()
    const before = { ...record() }
    w.recordWrites.fail = true
    // Trash: not ended, nothing removed, the problem shown.
    expect(await w.publisher.trashed(w.root, [PATH])).toBe(false)
    expect(w.publisher.records().find((entry) => entry.shareId === shareId)).toMatchObject({ ended: null, on: true, path: PATH })
    expect(w.serviceCalls().filter((entry) => entry.url.endsWith('/off'))).toEqual([])
    expect(w.publisher.view(w.root, PATH).links[0].problem).toMatchObject({ kind: 'not-saved' })
    // Move: not moved.
    expect(w.publisher.moved(w.root, PATH, 'Teaching notes/Elsewhere.md')).toBe(false)
    expect(w.publisher.records().find((entry) => entry.shareId === shareId)).toMatchObject({ path: PATH, generation: 0 })
    // A save: not queued, not published, said.
    w.write(PATH, PIECE.replace('promise', 'unsaved record'))
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(pages()).toHaveLength(1)
    expect(record()).toEqual(before)
    expect(w.publisher.view(w.root, PATH).links[0].problem).toMatchObject({ kind: 'not-saved' })
    // Saved again: the change goes through and the problem clears.
    w.recordWrites.fail = false
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(pages()).toHaveLength(2)
    expect(w.publisher.view(w.root, PATH).links[0].problem).toBeNull()
  })
})

describe('very large piece, piece with images', () => {
  test('a piece over the service limit is refused with the figure; readers keep the last complete copy', async () => {
    const state = { big: false }
    const render = async (root: string, path: string, imagePath: string): Promise<RenderedPiece> => {
      const piece = await renderPieceForSharing(root, path, imagePath)
      return state.big ? { ...piece, html: `<p>${'x'.repeat(SHARE_LIMITS.publishBodyBytes + 10)}</p>` } : piece
    }
    const { w, shareId, record, pages } = await shared({ render })
    const before = record().revision
    state.big = true
    w.publisher.saved(w.root, [PATH])
    await w.publisher.idle()
    expect(record().problem?.kind).toBe('too-big')
    expect(record().problem?.reason).toMatch(/ MB when published; a link holds at most 16 MB of text\.$/)
    expect(record().revision).toBe(before)
    expect(pages()).toHaveLength(1)
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a promise.')
  })

  test('pictures are published with the piece and removed with it (link off)', async () => {
    const pictured = (root: string, path: string, imagePath: string): Promise<RenderedPiece> => renderPieceForSharing(root, path, imagePath).then((piece) => ({ ...piece, pictures: [picture('two')], html: `${piece.html}<img src="${imagePath}${picture('two').name}">` }))
    const { w, shareId, base } = await shared({ render: pictured })
    const image = `${base}/s/${shareId}/images/${picture('two').name}`
    expect((await w.fake.serviceFetch(image)).status).toBe(200)
    await w.publisher.turnOff(shareId)
    expect((await w.fake.serviceFetch(image)).status).toBe(404)
  })
})

function picture(seed: string): { name: string; bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(`picture ${seed}`)
  return { name: `${createHash('sha256').update(bytes).digest('hex')}.png`, bytes }
}

describe('Sol round 2: a start publishes only what is on record; a walk never outvotes a recovery', () => {
  test('P2-2: edited while closed, and the queue cannot be saved at the start: nothing is sent, the link says not saved; saved later, published once', async () => {
    const { w, shareId, record, pages } = await shared()
    const before = { ...record() }
    w.write(PATH, PIECE.replace('promise', 'changed while closed'))
    const again = w.restart().publisher
    w.recordWrites.fail = true
    await again.resume()
    await again.idle()
    expect(pages()).toHaveLength(1)
    expect(record()).toEqual(before)
    expect(again.view(w.root, PATH).links[0].problem).toMatchObject({ kind: 'not-saved' })
    expect((await w.readerPage(shareId)).text).not.toContain('changed while closed')
    w.recordWrites.fail = false
    await again.resume()
    await again.idle()
    expect(pages()).toHaveLength(2)
    expect(record()).toMatchObject({ queuedAt: null, problem: null })
    expect(again.view(w.root, PATH).links[0].problem).toBeNull()
  })

  test('P2-2: Retry whose queue cannot be saved sends nothing and says not saved', async () => {
    const { w, shareId, pages } = await shared()
    w.write(PATH, PIECE.replace('promise', 'retried'))
    w.recordWrites.fail = true
    const result = await w.publisher.retry(shareId)
    await w.publisher.idle()
    expect(pages()).toHaveLength(1)
    expect(result?.view.links[0].problem).toMatchObject({ kind: 'not-saved' })
  })

  test('P2-2: a publish that went through but whose result cannot be saved: kept for this run, and the link says not saved', async () => {
    const { w, shareId, pages } = await shared()
    // A save on record (R16), then settings.json cannot be written before its publish runs.
    w.write(PATH, PIECE.replace('promise', 'saved before the disk filled'))
    w.publisher.saved(w.root, [PATH])
    w.recordWrites.fail = true
    await w.publisher.idle()
    expect(pages()).toHaveLength(2)
    expect(w.publisher.records().find((entry) => entry.shareId === shareId)!.revision).toBe(pages()[1].body.revision)
    expect(w.publisher.view(w.root, PATH).links[0].problem).toMatchObject({ kind: 'not-saved' })
  })

  test('P2-3: the file back at its path (found, then saved) while the start walked the Workspace: the stale "not found" is dropped', async () => {
    let release: () => void = () => {}
    let walking: () => void = () => {}
    const walked = new Promise<void>((done) => { walking = done })
    const scanIds = async () => { walking(); await new Promise<void>((done) => { release = done }); return new Map() }
    const { w, record, pages } = await shared({ ports: { scanIds } })
    const away = join(w.root, '..', `away-p23-${Date.now()}.md`)
    renameSync(join(w.root, PATH), away)
    const again = w.restart().publisher
    const resumed = again.resume()
    await walked
    renameSync(away, join(w.root, PATH))
    const id = record().fileId!
    again.found(w.root, PATH, id)
    w.write(PATH, PIECE.replace('promise', 'back again'))
    again.saved(w.root, [PATH])
    release()
    await resumed
    await again.idle()
    expect(record()).toMatchObject({ path: PATH, on: true, lost: null })
    expect(again.view(w.root, PATH).links[0].lost).toBeNull()
    expect(pages().at(-1)!.body.parts[0].html).toContain('back again')
  })

  test('P2-3: the file back at its path while the walk ran, with no watcher news: found, not "not found"', async () => {
    let release: () => void = () => {}
    let walking: () => void = () => {}
    const walked = new Promise<void>((done) => { walking = done })
    const scanIds = async () => { walking(); await new Promise<void>((done) => { release = done }); return new Map() }
    const { w, record } = await shared({ ports: { scanIds } })
    const away = join(w.root, '..', `away-p23b-${Date.now()}.md`)
    renameSync(join(w.root, PATH), away)
    const again = w.restart().publisher
    const resumed = again.resume()
    await walked
    renameSync(away, join(w.root, PATH))
    release()
    await resumed
    await again.idle()
    expect(record()).toMatchObject({ path: PATH, on: true, lost: null })
  })

  test('P3: one walk of a Workspace a pass, however many of its shares are missing', async () => {
    let walks = 0
    const scanIds = async () => { walks += 1; return new Map() }
    const { w, record } = await shared({ ports: { scanIds } })
    const other = await w.publisher.make(w.root, 'Teaching notes/Other.md', { name: 'Other', comments: false })
    expect(other.ok).toBe(true)
    rmSync(join(w.root, PATH))
    rmSync(join(w.root, 'Teaching notes/Other.md'))
    const again = w.restart().publisher
    await again.resume()
    await again.idle()
    expect(walks).toBe(1)
    expect(record().lost).toMatchObject({ why: 'gone' })
    expect(again.records().filter((entry) => entry.lost?.why === 'gone')).toHaveLength(2)
  })
})

// The shared tracker is cached across files; register this file's cleanup explicitly.
afterAll(cleanUpScratch)
