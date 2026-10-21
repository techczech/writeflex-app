// Publishing follows the piece through changes made outside WriteFlex (sharing ticket 04;
// sharing-outside-changes.ts O1-O6; orchestrator ruling round 1, R-A to R-C). The real publisher against
// the real sharing service in memory (tests/helpers/sharing-publish-world.ts); the watcher's batches are
// told by hand, in the order the app tells them (the follower first, then the save signal), and the
// settle window runs on a fake clock. A share is on a file (device and inode), never on its bytes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'
import { createOutsideChangeFollower, type Timers } from '../../src/main/sharing-outside-changes.ts'
import { presenceOf, type Presence } from '../../src/main/sharing-piece-identity.ts'
import type { ShareRecord } from '../../src/main/sharing-publisher.ts'

beforeAll(buildShipped)
afterAll(removeShipped)

const PIECE = '# What a reading list is for\n\nA reading list is a promise.\n'
const PATH = 'Teaching notes/What a reading list is for.md'
const SETTLE = 2_000

/** A fake clock: timers run only when the case moves time on. */
function fakeClock() {
  let at = 1_000_000
  let timers: Array<{ due: number; run: () => void; id: number }> = []
  let ids = 0
  const api: Timers = {
    set: (run, ms) => { ids += 1; timers.push({ due: at + ms, run, id: ids }); return ids },
    clear: (timer) => { timers = timers.filter((entry) => entry.id !== timer) },
  }
  return {
    now: () => at,
    timers: api,
    advance(ms: number): void {
      at += ms
      const due = timers.filter((entry) => entry.due <= at)
      timers = timers.filter((entry) => entry.due > at)
      for (const entry of due) entry.run()
    },
  }
}

type Options = { files?: Record<string, string>; kind?: 'piece' | 'folio'; at?: string; presence?: (root: string, path: string) => Presence }

async function outsideWorld(options: Options = {}) {
  const files = options.files ?? { [PATH]: PIECE, 'Teaching notes/Other.md': '# Other\n\nOther words.\n' }
  const at = options.at ?? PATH
  const presence = options.presence ?? presenceOf
  // The app's `exists` is existsSync, which an unmounted drive answers false: here, what `presence` says.
  const w = await publishWorld({ files, ports: { retryMs: [3_600_000], exists: (root, path) => presence(root, path).state === 'there', presence } })
  const made = await w.publisher.make(w.root, at, { name: 'Marta', comments: true }, options.kind ?? 'piece')
  expect(made.ok).toBe(true)
  const shareId = made.ok ? made.shareId! : ''
  const clock = fakeClock()
  const told = { moved: [] as string[], notFound: [] as string[], offered: [] as string[] }
  const follower = createOutsideChangeFollower({
    followed: () => w.publisher.followed(),
    moved: (root, from, to) => { told.moved.push(`${from} > ${to}`); return w.publisher.moved(root, from, to) },
    notFound: (root, path, why) => { told.notFound.push(`${path} ${why}`); w.publisher.notFound(root, path, why) },
    found: (root, path, id) => w.publisher.found(root, path, id),
    offer: (root, path, to) => { told.offered.push(`${path} > ${to}`); w.publisher.offer(root, path, to) },
    saved: (root, paths) => w.publisher.saved(root, paths),
    presence,
    now: clock.now,
    timers: clock.timers,
    settleMs: SETTLE,
  })
  /** One watcher batch, as ipc.ts tells it: the follower, then the save signal. */
  const batch = async (...paths: string[]): Promise<void> => {
    const followed = follower.changed(w.root, paths)
    w.publisher.saved(w.root, paths)
    await followed
    await follower.idle()
    await w.publisher.idle()
  }
  const settle = async (ms = SETTLE + 1): Promise<void> => {
    clock.advance(ms)
    await follower.idle()
    await w.publisher.idle()
  }
  const record = (): ShareRecord => w.publisher.records().find((entry) => entry.shareId === shareId)!
  const pages = () => w.publishes().filter((entry) => entry.shareId === shareId)
  const offCalls = () => w.serviceCalls().filter((entry) => entry.url.endsWith('/off') || entry.method === 'DELETE')
  const move = (from: string, to: string): void => { mkdirSync(dirname(join(w.root, to)), { recursive: true }); renameSync(join(w.root, from), join(w.root, to)) }
  return { w, shareId, record, pages, batch, settle, told, move, follower, offCalls }
}

describe('renamed or moved outside WriteFlex: the link follows the same file', () => {
  test('a rename the watcher reports in one batch: same address, published at the new path, nothing read or ended at the old one', async () => {
    const { w, shareId, record, pages, batch, settle, told, move } = await outsideWorld()
    const address = w.publisher.view(w.root, PATH).links[0].address
    const to = 'Teaching notes/Reading lists.md'
    move(PATH, to)
    await batch(PATH, to)
    expect(record()).toMatchObject({ path: to, on: true, problem: null, ended: null, lost: null, generation: 1 })
    expect(pages()).toHaveLength(2)
    expect(w.publisher.view(w.root, to).links[0]).toMatchObject({ shareId, address })
    await settle()
    expect(told).toEqual({ moved: [`${PATH} > ${to}`], notFound: [], offered: [] })
    expect((await w.readerPage(shareId)).text).toContain('A reading list is a promise.')
  })

  test('the vanishing and the new path in two batches within the window: the same file follows', async () => {
    const { w, record, batch, settle, told, move } = await outsideWorld()
    const to = 'Archive/What a reading list is for.md'
    move(PATH, to)
    await batch(PATH)
    // Held: not found yet, not published, while the window is open.
    expect(record()).toMatchObject({ path: PATH, on: true, ended: null, lost: null })
    await settle(SETTLE / 2)
    await batch('Archive', to)
    expect(record()).toMatchObject({ path: to, on: true, ended: null, lost: null })
    await settle()
    expect(told.notFound).toEqual([])
    expect(w.publisher.view(w.root, to).links).toHaveLength(1)
  })

  test('a folder renamed outside carries a piece link and a Folio link with its parts', async () => {
    const DIR = 'Teaching notes'
    const files = {
      [`${DIR}/_report-structure.json`]: JSON.stringify({ files: [{ path: 'One.md' }, { path: 'Two.md' }] }),
      [`${DIR}/One.md`]: '# One\n\nONE_WORDS\n',
      [`${DIR}/Two.md`]: '# Two\n\nTWO_WORDS\n',
    }
    const { w, record, batch, settle, told, move } = await outsideWorld({ files, kind: 'folio', at: DIR })
    const piece = await w.publisher.make(w.root, `${DIR}/One.md`, { name: 'One alone', comments: false })
    expect(piece.ok).toBe(true)
    move(DIR, 'Seminars')
    await batch(DIR, 'Seminars')
    await settle()
    expect(told.notFound).toEqual([])
    expect(record()).toMatchObject({ path: 'Seminars', on: true, ended: null, problem: null, lost: null })
    expect(record().parts.map((part) => part.path)).toEqual(['Seminars/One.md', 'Seminars/Two.md'])
    expect(w.publisher.records().find((entry) => entry.kind === 'piece')).toMatchObject({ path: 'Seminars/One.md', on: true, ended: null, lost: null })
  })
})

describe('the same bytes in another file are not the piece (R-A)', () => {
  test('deleted, and a different file with equal bytes made elsewhere: nothing follows; not found, the copy kept', async () => {
    const { w, shareId, record, batch, settle, told, offCalls } = await outsideWorld()
    const other = 'Elsewhere/Same words.md'
    mkdirSync(join(w.root, 'Elsewhere'))
    writeFileSync(join(w.root, other), PIECE)
    rmSync(join(w.root, PATH))
    await batch(PATH, 'Elsewhere', other)
    await settle()
    expect(told).toEqual({ moved: [], notFound: [`${PATH} gone`], offered: [] })
    expect(record()).toMatchObject({ path: PATH, on: true, ended: null, lost: { why: 'gone', candidate: null } })
    expect(w.publisher.view(w.root, other).links).toEqual([])
    expect((await w.readerPage(shareId)).status).toBe(200)
    expect(offCalls()).toEqual([])
    // A save of the other file publishes nothing to this link.
    writeFileSync(join(w.root, other), `${PIECE}\nPrivate.\n`)
    await batch(other)
    expect((await w.readerPage(shareId)).text).not.toContain('Private.')
  })

  test('copied, then the original deleted (a new file, a new inode): not a move; not found, the copy kept', async () => {
    const { w, shareId, record, batch, settle, told, offCalls } = await outsideWorld()
    const to = 'Kept/Reading.md'
    mkdirSync(join(w.root, 'Kept'))
    copyFileSync(join(w.root, PATH), join(w.root, to))
    await batch('Kept', to)
    await settle(SETTLE / 2)
    rmSync(join(w.root, PATH))
    await batch(PATH)
    await settle()
    expect(told.moved).toEqual([])
    expect(record()).toMatchObject({ path: PATH, on: true, lost: { why: 'gone' } })
    expect((await w.readerPage(shareId)).status).toBe(200)
    expect(offCalls()).toEqual([])
  })

  test('moved to another volume (a new device, so a new file): not followed; not found, the copy kept', async () => {
    const to = 'Teaching notes/On the other drive.md'
    // The same inode number on another device is another file.
    const presence = (root: string, path: string): Presence => {
      const there = presenceOf(root, path)
      return path === to && there.state === 'there' ? { ...there, id: `9999999:${there.id.split(':')[1]}` } : there
    }
    const { w, shareId, record, batch, settle, told, move, offCalls } = await outsideWorld({ presence })
    move(PATH, to)
    await batch(PATH, to)
    await settle()
    expect(told.moved).toEqual([])
    expect(record()).toMatchObject({ path: PATH, on: true, ended: null, lost: { why: 'gone', candidate: null } })
    expect(w.publisher.view(w.root, PATH).links[0]).toMatchObject({ on: true, lost: { why: 'gone', candidate: null } })
    expect((await w.readerPage(shareId)).status).toBe(200)
    expect(offCalls()).toEqual([])
  })
})

describe('gone or unreadable outside WriteFlex: "Piece not found", nothing removed (R-B)', () => {
  test('gone past the settle window: not found; never ended, the copy and its address kept; saves publish nothing', async () => {
    const { w, shareId, record, pages, batch, settle, told, offCalls } = await outsideWorld()
    rmSync(join(w.root, PATH))
    await batch(PATH)
    await settle(SETTLE - 1)
    expect(record()).toMatchObject({ on: true, ended: null, lost: null })
    await settle(2)
    expect(told.notFound).toEqual([`${PATH} gone`])
    expect(record()).toMatchObject({ on: true, ended: null, lost: { why: 'gone' } })
    expect(w.publisher.view(w.root, PATH).links[0].lost).toEqual({ why: 'gone', candidate: null })
    expect(w.publisher.mark(w.root, PATH)).toEqual({ kind: 'not-published' })
    expect((await w.readerPage(shareId)).status).toBe(200)
    expect(offCalls()).toEqual([])
    expect(pages()).toHaveLength(1)
  })

  test('a drive or folder that cannot be read (unmounted, not synced): not found as unreadable; nothing removed; readable again, found', async () => {
    const state = { unmounted: false }
    const presence = (root: string, path: string): Presence => (state.unmounted ? { state: 'unreadable' } : presenceOf(root, path))
    const { w, shareId, record, batch, settle, told, offCalls } = await outsideWorld({ presence })
    state.unmounted = true
    await batch(PATH)
    await settle()
    expect(told.notFound).toEqual([`${PATH} unreadable`])
    expect(record()).toMatchObject({ on: true, ended: null, lost: { why: 'unreadable', candidate: null } })
    expect((await w.readerPage(shareId)).status).toBe(200)
    expect(offCalls()).toEqual([])
    state.unmounted = false
    await batch(PATH)
    expect(record()).toMatchObject({ on: true, ended: null, lost: null })
  })

  test('the same path again (an editor that deletes and writes a new file): an edit of the piece, published once as a save', async () => {
    const { w, shareId, record, pages, batch, settle, told } = await outsideWorld()
    const before = record().fileId
    rmSync(join(w.root, PATH))
    await batch(PATH)
    w.write(PATH, `${PIECE}\nAdded elsewhere.\n`)
    await batch(PATH)
    await settle()
    expect(told).toEqual({ moved: [], notFound: [], offered: [] })
    expect(record()).toMatchObject({ on: true, ended: null, lost: null, problem: null })
    expect(record().fileId).not.toBe(before)
    expect(pages()).toHaveLength(2)
    expect((await w.readerPage(shareId)).text).toContain('Added elsewhere.')
  })

  test('not found, then the same file seen at another place: offered as "Follow to", followed only when the writer chooses', async () => {
    const { w, shareId, record, pages, batch, settle, told } = await outsideWorld()
    const away = join(w.root, '..', `away-${shareId}.md`)
    renameSync(join(w.root, PATH), away)
    await batch(PATH)
    await settle()
    expect(record().lost).toMatchObject({ why: 'gone', candidate: null })
    // Moved back into the Workspace at another place, long after the window: the same file.
    const to = 'Archive/Reading.md'
    mkdirSync(join(w.root, 'Archive'))
    renameSync(away, join(w.root, to))
    await batch('Archive', to)
    expect(told.moved).toEqual([])
    expect(told.offered).toEqual([`${PATH} > ${to}`])
    expect(record()).toMatchObject({ path: PATH, lost: { candidate: to } })
    expect(w.publisher.view(w.root, PATH).links[0].lost).toEqual({ why: 'gone', candidate: to })
    const followed = await w.publisher.followTo(shareId)
    expect(followed?.ok).toBe(true)
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: to, on: true, lost: null })
    expect(pages()).toHaveLength(2)
  })

  test('"Follow to" a place that holds another file now: refused, the link stays not found', async () => {
    const { w, shareId, record, batch, settle } = await outsideWorld()
    const away = join(w.root, '..', `away2-${shareId}.md`)
    renameSync(join(w.root, PATH), away)
    await batch(PATH)
    await settle()
    const to = 'Back.md'
    renameSync(away, join(w.root, to))
    await batch(to)
    expect(record().lost?.candidate).toBe(to)
    rmSync(join(w.root, to))
    writeFileSync(join(w.root, to), PIECE)
    const followed = await w.publisher.followTo(shareId)
    expect(followed?.ok).toBe(false)
    expect(record()).toMatchObject({ path: PATH, lost: { why: 'gone', candidate: null } })
  })

  test('a Folio part deleted outside: the Folio is published again with the part "not available", and stays on', async () => {
    const DIR = 'Teaching notes'
    const files = {
      [`${DIR}/_report-structure.json`]: JSON.stringify({ files: [{ path: 'One.md' }, { path: 'Two.md' }] }),
      [`${DIR}/One.md`]: '# One\n\nONE_WORDS\n',
      [`${DIR}/Two.md`]: '# Two\n\nTWO_WORDS\n',
    }
    const { w, shareId, record, pages, batch, settle } = await outsideWorld({ files, kind: 'folio', at: DIR })
    rmSync(join(w.root, DIR, 'Two.md'))
    await batch(`${DIR}/Two.md`)
    await settle()
    expect(record()).toMatchObject({ on: true, ended: null, problem: null, lost: null })
    expect(pages().at(-1)!.body.parts.map((part) => [part.title, part.missing === true])).toEqual([['One', false], ['Two', true]])
    const page = await w.readerPage(shareId)
    expect(page.text).not.toContain('TWO_WORDS')
    expect(page.text).toContain('not available')
  })
})

describe('a freed inode is not the piece (Sol round 2 P1-1: device, inode and birth time)', () => {
  test('deleted, and an unrelated new file given the freed inode within the window: not followed, not offered; not found, the copy kept', async () => {
    const reused = 'Private/private.md'
    const state: { recorded: string | null } = { recorded: null }
    // The volume gives the new file the deleted piece's device and inode; its birth time is its own.
    const presence = (root: string, path: string): Presence => {
      const there = presenceOf(root, path)
      if (path !== reused || there.state !== 'there' || !state.recorded) return there
      const [dev, ino, birth] = state.recorded.split(':')
      return { ...there, id: birth === undefined ? `${dev}:${ino}` : `${dev}:${ino}:${BigInt(birth) + 1n}` }
    }
    const { w, shareId, record, pages, batch, settle, told, offCalls } = await outsideWorld({ presence })
    state.recorded = record().fileId
    rmSync(join(w.root, PATH))
    mkdirSync(join(w.root, 'Private'))
    writeFileSync(join(w.root, reused), '# Private\n\nNot for readers.\n')
    await batch(PATH, 'Private', reused)
    await settle()
    expect(told).toEqual({ moved: [], notFound: [`${PATH} gone`], offered: [] })
    expect(record()).toMatchObject({ path: PATH, on: true, ended: null, lost: { why: 'gone', candidate: null } })
    expect(w.publisher.view(w.root, reused).links).toEqual([])
    expect(pages()).toHaveLength(1)
    expect((await w.readerPage(shareId)).text).not.toContain('Not for readers.')
    expect(offCalls()).toEqual([])
  })

  test('a volume that keeps no birth time: a rename is not followed by itself; not found, offered as "Follow to", followed when the writer chooses', async () => {
    const presence = (root: string, path: string): Presence => {
      const there = presenceOf(root, path)
      return there.state === 'there' ? { ...there, id: `${there.id.split(':').slice(0, 2).join(':')}:0` } : there
    }
    const { w, shareId, record, pages, batch, settle, told } = await outsideWorld({ presence })
    const to = 'Teaching notes/Renamed.md'
    renameSync(join(w.root, PATH), join(w.root, to))
    await batch(PATH, to)
    await settle()
    expect(told.moved).toEqual([])
    expect(told.notFound).toEqual([`${PATH} gone`])
    expect(record()).toMatchObject({ path: PATH, on: true, lost: { why: 'gone', candidate: to } })
    expect(pages()).toHaveLength(1)
    const followed = await w.publisher.followTo(shareId)
    expect(followed?.ok).toBe(true)
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: to, on: true, lost: null })
    expect(pages()).toHaveLength(2)
  })

  test('a rename on a volume that keeps birth times is still followed by itself', async () => {
    const { record, batch, settle, told, move } = await outsideWorld()
    expect(record().fileId).toMatch(/^\d+:\d+:[1-9]\d*$/)
    const to = 'Teaching notes/Renamed again.md'
    move(PATH, to)
    await batch(PATH, to)
    await settle()
    expect(told.moved).toEqual([`${PATH} > ${to}`])
    expect(record()).toMatchObject({ path: to, lost: null })
  })
})
