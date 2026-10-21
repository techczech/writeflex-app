// Publishing follows the piece when the command line moves it or sends it to the Trash (sharing
// ticket 04; orchestrator ruling round 1, R-F; Fable ruling after Sol round 3, rules 1 to 6). Collection
// closed in WriteFlex: the command line, under its owner lock, leaves one signal per link in the app's
// application data (the link, where it was and its generation), which the app applies per link in
// generation order and only to the link where it was made. Collection open: the app carries the command
// out and tells its publisher in the same turn, before the save signal. Interleavings are made step by
// step (a command line "suspended" is one whose steps the test runs later). Fake Trash, fake app data,
// no network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, renameSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyFollowSignal, FOLLOW_SIGNALS_FOLDER, leaveFollowSignal, readSignal, signalName, takeAtStart, takeFollowSignals, watchFollowSignals,
  type FollowSignal, type SignalReport,
} from '../../src/main/sharing-follow-signals'
import type { ShareSignal } from '../../src/main/sharing-publisher'
import { writeFixture, type WriteFixture } from '../helpers/cli-write-fixture'
import { openAsApp, plantRequest, replyTo } from '../helpers/request-app'
import { buildShipped, removeShipped } from '../helpers/sharing-world.ts'
import { publishWorld } from '../helpers/sharing-publish-world.ts'

let fx: WriteFixture
beforeEach(async () => { fx = await writeFixture() })
afterEach(() => fx.dispose())
beforeAll(buildShipped)
afterAll(removeShipped)

const SHARE_ID = ['Ab12', 'Cd34', 'Ef56', 'Gh78'].join('')
/** A link on `path` in the app's settings, as settings.json keeps it (never a token: those are in the Keychain). */
async function sharedInSettings(path: string, kind: 'piece' | 'folio' = 'piece', appData = fx.appData, generation = 0): Promise<void> {
  await mkdir(appData, { recursive: true })
  await writeFile(join(appData, 'settings.json'), JSON.stringify({ sharingLinks: [{ shareId: SHARE_ID, kind, root: fx.root, path, on: true, name: 'Marta', comments: true, madeAt: 1, revision: 1, generation }] }))
}
const folderIn = (appData = fx.appData): string => join(appData, FOLLOW_SIGNALS_FOLDER)
const signalFiles = async (appData = fx.appData): Promise<string[]> => {
  if (!existsSync(folderIn(appData))) return []
  return (await readdir(folderIn(appData))).filter((name) => name.endsWith('.json')).sort()
}
/** The signals waiting, each link's in generation order. */
const signalsIn = async (appData = fx.appData): Promise<FollowSignal[]> =>
  (await Promise.all((await signalFiles(appData)).map(async (name) => readSignal(await readFile(join(folderIn(appData), name), 'utf8'))!)))
    .sort((a, b) => a.shareId.localeCompare(b.shareId) || a.generation - b.generation)
/** A signal as a command line leaves it, under the file name it would use (`nonce`: its order among two for one generation). */
async function leave(signal: ShareSignal, nonce?: string): Promise<string> {
  await mkdir(folderIn(), { recursive: true })
  const name = signalName(signal, nonce)
  await writeFile(join(folderIn(), name), JSON.stringify({ version: 3, ...signal }))
  return name
}

describe('the command line with the Collection closed in WriteFlex leaves a signal per link (rule 1)', () => {
  test('move of a shared piece: one file named for the link and its generation, naming the Collection, where it was and the move; never a token or document text', async () => {
    await sharedInSettings('talks/york.md')
    const run = await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])
    expect(run.json.ok).toBe(true)
    expect(await signalsIn()).toEqual([{ root: fx.root, shareId: SHARE_ID, from: 'talks/york.md', generation: 0, move: { from: 'talks/york.md', to: 'talks/york-2026.md' } }])
    const names = await signalFiles()
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(new RegExp(`^${SHARE_ID}\\.0000000000\\.[0-9a-f]{16}\\.json$`))
    const text = await readFile(join(folderIn(), names[0]), 'utf8')
    expect(text).not.toContain('York talk')
    expect(text).not.toMatch(/token|seq/i)
    // No counter, no lock, nothing else beside the signals.
    expect(await readdir(folderIn())).toEqual(names)
  })

  test('move-folder, undo and trash: each signal names where the one before left the link and its next generation; the beta app is told only of its own links', async () => {
    await sharedInSettings('talks/york.md')
    await sharedInSettings('notes.md', 'piece', fx.otherAppData)
    expect((await fx.cli(['move-folder', 'talks', 'events'])).json.ok).toBe(true)
    expect((await fx.cli(['undo'])).json.ok).toBe(true)
    expect((await fx.cli(['trash', 'talks'])).json.ok).toBe(true)
    expect(await signalsIn()).toEqual([
      { root: fx.root, shareId: SHARE_ID, from: 'talks/york.md', generation: 0, move: { from: 'talks', to: 'events' } },
      { root: fx.root, shareId: SHARE_ID, from: 'events/york.md', generation: 1, move: { from: 'events', to: 'talks' } },
      { root: fx.root, shareId: SHARE_ID, from: 'talks/york.md', generation: 2, trashed: true },
    ])
    expect(await signalsIn(fx.otherAppData)).toEqual([])
    expect((await fx.cli(['trash', 'notes.md'])).json.ok).toBe(true)
    expect(await signalsIn(fx.otherAppData)).toEqual([{ root: fx.root, shareId: SHARE_ID, from: 'notes.md', generation: 0, trashed: true }])
  })

  test('a move or Trash that touches no link leaves nothing in application data', async () => {
    await sharedInSettings('notes.md')
    expect((await fx.cli(['move', 'talks/york.md', 'talks/york-2026.md'])).json.ok).toBe(true)
    expect((await fx.cli(['trash', 'talks/intro.md'])).json.ok).toBe(true)
    expect(await signalFiles()).toEqual([])
  })

  test('rule 2: the links as the signals waiting leave them, in generation order, chaining only consecutive generations', async () => {
    await sharedInSettings('talks/york.md')
    // Waiting, listed out of order by name: gen 1 (b to c) and gen 0 (york to b); a gen 3 that does not chain.
    await leave({ root: fx.root, shareId: SHARE_ID, from: 'talks/b.md', generation: 1, move: { from: 'talks/b.md', to: 'talks/c.md' } }, '0000000000000000')
    await leave({ root: fx.root, shareId: SHARE_ID, from: 'talks/york.md', generation: 0, move: { from: 'talks/york.md', to: 'talks/b.md' } }, 'ffffffffffffffff')
    await leave({ root: fx.root, shareId: SHARE_ID, from: 'talks/z.md', generation: 3, move: { from: 'talks/z.md', to: 'talks/y.md' } })
    expect(await leaveFollowSignal([join(fx.appData, 'settings.json')], { root: fx.root, moved: [], trashed: ['talks/c.md'] })).toBeNull()
    expect((await signalsIn()).filter((signal) => 'trashed' in signal)).toEqual([{ root: fx.root, shareId: SHARE_ID, from: 'talks/c.md', generation: 2, trashed: true }])
  })
})

describe('the app takes the signals (rules 3 and 6)', () => {
  const SECOND = ['Zz99', 'Yy88', 'Xx77'].join('')
  const put = async (name: string, body: string): Promise<void> => {
    await mkdir(folderIn(), { recursive: true })
    await writeFile(join(folderIn(), name), body)
  }

  test('not a signal (not JSON, a path that climbs out, a relative root, a name that is not its body, the old numbered kind): removed unapplied and reported; other files left alone', async () => {
    const ok = { version: 3, root: fx.root, shareId: SHARE_ID, from: 'a.md', generation: 0, trashed: true }
    await put(signalName({ shareId: SHARE_ID, generation: 0 }), 'not json')
    await put(signalName({ shareId: SHARE_ID, generation: 1 }), JSON.stringify({ ...ok, generation: 1, trashed: undefined, move: { from: '../outside.md', to: 'x.md' } }))
    await put(signalName({ shareId: SHARE_ID, generation: 2 }), JSON.stringify({ ...ok, generation: 2, root: 'relative' }))
    await put(signalName({ shareId: SHARE_ID, generation: 4 }), JSON.stringify({ ...ok, generation: 3 }))
    await put(signalName({ shareId: SECOND, generation: 0 }), JSON.stringify(ok))
    await put('0000000000000001.json', JSON.stringify({ ...ok, version: 2, seq: 1 }))
    await writeFile(join(folderIn(), 'notes.txt'), 'left alone')
    const told: FollowSignal[] = []
    const reports: SignalReport[] = []
    expect(await takeFollowSignals(fx.appData, (signal) => { told.push(signal); return 'applied' }, { report: (entry) => reports.push(entry) })).toBe(0)
    expect(told).toEqual([])
    expect(reports).toEqual(Array.from({ length: 5 }, () => ({ why: 'not-a-signal', generation: null })))
    // The old numbered file is not this kind's: left, as any other file is.
    expect((await readdir(folderIn())).sort()).toEqual(['0000000000000001.json', 'notes.txt'])
  })

  test('rule 6: two files for one link and generation: the first in name order applies, the second is stale', async () => {
    const w = await publishWorld({ files: { 'a.md': '# A\n' }, ports: { retryMs: [3_600_000] } })
    const made = await w.publisher.make(w.root, 'a.md', { name: 'Marta', comments: true })
    const shareId = made.ok ? made.shareId! : ''
    renameSync(join(w.root, 'a.md'), join(w.root, 'b.md'))
    await leave({ root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } }, '0000000000000000')
    await leave({ root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'c.md' } }, 'ffffffffffffffff')
    const reports: SignalReport[] = []
    expect(await takeFollowSignals(fx.appData, (signal) => applyFollowSignal(w.publisher, signal), { report: (entry) => reports.push(entry) })).toBe(1)
    await w.publisher.idle()
    expect(w.publisher.records()[0]).toMatchObject({ path: 'b.md', generation: 1 })
    expect(reports).toEqual([{ why: 'stale', generation: 0 }])
    expect(await signalFiles()).toEqual([])
    // The first in name order is for another place: stale; the second, for this generation too, is stale with it.
    await leave({ root: w.root, shareId, from: 'z.md', generation: 1, move: { from: 'z.md', to: 'c.md' } }, '0000000000000000')
    await leave({ root: w.root, shareId, from: 'b.md', generation: 1, move: { from: 'b.md', to: 'c.md' } }, 'ffffffffffffffff')
    expect(await takeFollowSignals(fx.appData, (signal) => applyFollowSignal(w.publisher, signal), { report: (entry) => reports.push(entry) })).toBe(0)
    expect(w.publisher.records()[0]).toMatchObject({ path: 'b.md', generation: 1 })
    expect(reports).toEqual([{ why: 'stale', generation: 0 }, { why: 'stale', generation: 1 }, { why: 'stale', generation: 1 }])
    expect(await signalFiles()).toEqual([])
  })
})

describe('interleavings (Fable ruling after Sol round 3)', () => {
  const PIECE = '# York\n\nThe York talk.\n'
  async function app(files: Record<string, string> = { 'a.md': PIECE }) {
    const w = await publishWorld({ files, ports: { retryMs: [3_600_000] } })
    const ids: string[] = []
    for (const path of Object.keys(files)) {
      const made = await w.publisher.make(w.root, path, { name: 'Marta', comments: true })
      ids.push(made.ok ? made.shareId! : '')
    }
    const record = (shareId = ids[0]) => w.publisher.records().find((entry) => entry.shareId === shareId)!
    const act = (signal: FollowSignal) => applyFollowSignal(w.publisher, signal)
    const reports: SignalReport[] = []
    const take = () => takeFollowSignals(fx.appData, act, { report: (entry) => reports.push(entry) })
    /** The app's settings.json as the command line reads it. */
    const settingsFile = async (): Promise<string> => {
      await writeFile(join(fx.appData, 'settings.json'), JSON.stringify({ sharingLinks: w.saved() }))
      return join(fx.appData, 'settings.json')
    }
    return { w, ids, record, act, take, reports, settingsFile }
  }

  test("Sol's suspended producer: S1's gen 1 is held until A's gen 0 lands; S2 is taken meanwhile", async () => {
    const { w, ids: [s1, s2], record, take, reports } = await app({ 'a.md': PIECE, 'b.md': PIECE })
    // A moved a.md to x.md, then (one undo, two moves) x.md to y.md: it is suspended before its first signal lands; its second did.
    renameSync(join(w.root, 'a.md'), join(w.root, 'y.md'))
    renameSync(join(w.root, 'b.md'), join(w.root, 'c.md'))
    await leave({ root: w.root, shareId: s1, from: 'x.md', generation: 1, move: { from: 'x.md', to: 'y.md' } })
    await leave({ root: w.root, shareId: s2, from: 'b.md', generation: 0, move: { from: 'b.md', to: 'c.md' } })
    expect(await take()).toBe(1)
    expect(record(s1)).toMatchObject({ path: 'a.md', generation: 0 })
    expect(record(s2)).toMatchObject({ path: 'c.md', generation: 1 })
    expect((await signalsIn()).map((signal) => [signal.shareId, signal.generation])).toEqual([[s1, 1]])
    expect(reports).toEqual([])
    // A resumes: its gen 0 lands. Both of S1's are taken, in order.
    await leave({ root: w.root, shareId: s1, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'x.md' } })
    expect(await take()).toBe(2)
    await w.publisher.idle()
    expect(record(s1)).toMatchObject({ path: 'y.md', generation: 2, lost: null })
    expect(await signalFiles()).toEqual([])
  })

  test('A suspended after its rename, B trashes the file, then A signals: the link moves, nothing is removed, the look says not found', async () => {
    const { w, record, take, settingsFile } = await app()
    const shareId = record().shareId
    // A: moves a.md to b.md (committed), then is suspended before its signal.
    renameSync(join(w.root, 'a.md'), join(w.root, 'b.md'))
    // B (after taking A's owner lock over): sends b.md to the Trash. The link is at a.md as far as B can tell: no signal.
    rmSync(join(w.root, 'b.md'))
    expect(await leaveFollowSignal([await settingsFile()], { root: w.root, moved: [], trashed: ['b.md'] })).toBeNull()
    expect(await signalFiles()).toEqual([])
    // A resumes and leaves its signal.
    expect(await leaveFollowSignal([await settingsFile()], { root: w.root, moved: [{ from: 'a.md', to: 'b.md' }], trashed: [] })).toBeNull()
    expect(await signalsIn()).toEqual([{ root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } }])
    const before = w.serviceCalls().length
    expect(await take()).toBe(1)
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: 'b.md', generation: 1, ended: null, on: true })
    await w.publisher.resume()
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: 'b.md', ended: null, on: true, lost: { why: 'gone' } })
    // Nothing removed: no turn-off, no delete, and readers still get the copy.
    expect(w.serviceCalls().slice(before).filter((entry) => entry.method === 'DELETE' || entry.url.includes('/off'))).toEqual([])
    expect((await w.readerPage(shareId)).status).toBe(200)
  })

  test('move then Trash chain: both applied in order; Trash then a late move: the move is stale, the link stays ended', async () => {
    const first = await app()
    renameSync(join(first.w.root, 'a.md'), join(first.w.root, 'b.md'))
    await leave({ root: first.w.root, shareId: first.ids[0], from: 'b.md', generation: 1, trashed: true })
    await leave({ root: first.w.root, shareId: first.ids[0], from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } })
    expect(await first.take()).toBe(2)
    await first.w.publisher.idle()
    expect(first.record()).toMatchObject({ path: 'b.md', generation: 1, ended: { removed: true }, on: false })
    expect(await signalFiles()).toEqual([])

    const second = await app()
    await leave({ root: second.w.root, shareId: second.ids[0], from: 'a.md', generation: 0, trashed: true })
    expect(await second.take()).toBe(1)
    await second.w.publisher.idle()
    await leave({ root: second.w.root, shareId: second.ids[0], from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } })
    expect(await second.take()).toBe(0)
    expect(second.record()).toMatchObject({ path: 'a.md', generation: 0, ended: { removed: true } })
    expect(second.reports).toEqual([{ why: 'stale', generation: 0 }])
    expect(await signalFiles()).toEqual([])
  })

  test('undo chain: the move and its undo applied in order; replays of both are stale and removed', async () => {
    const { w, ids: [shareId], record, take, reports } = await app()
    const move: ShareSignal = { root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } }
    const undo: ShareSignal = { root: w.root, shareId, from: 'b.md', generation: 1, move: { from: 'b.md', to: 'a.md' } }
    await leave(undo)
    await leave(move)
    expect(await take()).toBe(2)
    expect(record()).toMatchObject({ path: 'a.md', generation: 2 })
    await leave(move)
    await leave(undo)
    expect(await take()).toBe(0)
    expect(record()).toMatchObject({ path: 'a.md', generation: 2 })
    expect(reports).toEqual([{ why: 'stale', generation: 0 }, { why: 'stale', generation: 1 }])
    expect(await signalFiles()).toEqual([])
  })

  test("a folder move with one share's change not saved: only that share's signals are kept; the other share is taken", async () => {
    const { w, ids: [s1, s2], record, settingsFile } = await app({ 'talks/a.md': PIECE, 'talks/b.md': PIECE })
    renameSync(join(w.root, 'talks'), join(w.root, 'events'))
    expect(await leaveFollowSignal([await settingsFile()], { root: w.root, moved: [{ from: 'talks', to: 'events' }], trashed: [] })).toBeNull()
    renameSync(join(w.root, 'events'), join(w.root, 'notes'))
    expect(await leaveFollowSignal([await settingsFile()], { root: w.root, moved: [{ from: 'events', to: 'notes' }], trashed: [] })).toBeNull()
    expect(await signalFiles()).toHaveLength(4)
    // settings.json cannot be written while S1's change is saved.
    const act = (signal: FollowSignal) => { w.recordWrites.fail = signal.shareId === s1; try { return applyFollowSignal(w.publisher, signal) } finally { w.recordWrites.fail = false } }
    expect(await takeFollowSignals(fx.appData, act)).toBe(2)
    expect(record(s1)).toMatchObject({ path: 'talks/a.md', generation: 0 })
    expect(record(s2)).toMatchObject({ path: 'notes/b.md', generation: 2 })
    expect((await signalsIn()).map((signal) => [signal.shareId, signal.generation])).toEqual([[s1, 0], [s1, 1]])
    // Saved at the next look: S1 follows too.
    expect(await takeFollowSignals(fx.appData, (signal) => applyFollowSignal(w.publisher, signal))).toBe(2)
    await w.publisher.idle()
    expect(record(s1)).toMatchObject({ path: 'notes/a.md', generation: 2 })
  })

  test('the file cannot be removed after its change was saved: the next look finds it stale and applies nothing twice', async () => {
    const { w, ids: [shareId], record, take, reports } = await app()
    renameSync(join(w.root, 'a.md'), join(w.root, 'b.md'))
    await leave({ root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } })
    chmodSync(folderIn(), 0o555)
    try { expect(await take()).toBe(1) } finally { chmodSync(folderIn(), 0o755) }
    expect(record()).toMatchObject({ path: 'b.md', generation: 1 })
    expect(await signalFiles()).toHaveLength(1)
    expect(await take()).toBe(0)
    expect(record()).toMatchObject({ path: 'b.md', generation: 1 })
    expect(reports).toEqual([{ why: 'stale', generation: 0 }])
    expect(await signalFiles()).toEqual([])
  })

  test('at start, a gen 2 with no gen 1 is held through the first take and the look, then removed and reported', async () => {
    const { w, ids: [shareId], record, act } = await app()
    renameSync(join(w.root, 'a.md'), join(w.root, 'b.md'))
    await leave({ root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } })
    await leave({ root: w.root, shareId, from: 'c.md', generation: 2, move: { from: 'c.md', to: 'd.md' } })
    const steps: string[] = []
    const signals = watchFollowSignals(fx.appData, act, { report: (entry) => steps.push(`${entry.why} ${entry.generation}`) })
    try {
      await takeAtStart(signals, async () => {
        steps.push(`look (waiting: ${(await signalsIn()).map((signal) => signal.generation).join()})`)
        await w.publisher.resume()
      })
    } finally { signals.dispose() }
    expect(steps).toEqual(['look (waiting: 2)', 'held-dropped 2'])
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: 'b.md', generation: 1, lost: null, ended: null })
    expect(await signalFiles()).toEqual([])
  })

  test('restored and turned on: a new generation, so a signal made before the restore is stale', async () => {
    const { w, ids: [shareId], record, take, reports } = await app()
    expect(await w.publisher.trashed(w.root, ['a.md'])).toBe(true)
    expect(record()).toMatchObject({ ended: { removed: true } })
    expect((await w.publisher.turnOn(shareId))?.ok).toBe(true)
    expect(record()).toMatchObject({ on: true, ended: null, generation: 1, path: 'a.md' })
    await leave({ root: w.root, shareId, from: 'a.md', generation: 0, move: { from: 'a.md', to: 'b.md' } })
    expect(await take()).toBe(0)
    expect(record()).toMatchObject({ path: 'a.md', generation: 1 })
    expect(reports).toEqual([{ why: 'stale', generation: 0 }])
  })
})

describe('the publisher applies a signal only to its link where it was made (rule 3)', () => {
  const PIECE = '# York\n\nThe York talk.\n'
  async function app() {
    const w = await publishWorld({ files: { 'a.md': PIECE }, ports: { retryMs: [3_600_000] } })
    const made = await w.publisher.make(w.root, 'a.md', { name: 'Marta', comments: true })
    const shareId = made.ok ? made.shareId! : ''
    const record = () => w.publisher.records().find((entry) => entry.shareId === shareId)!
    const at = (from: string, generation: number, rest: { move: { from: string; to: string } } | { trashed: true }): ShareSignal => ({ root: w.root, shareId, from, generation, ...rest })
    return { w, shareId, record, at }
  }

  test('a move then the next: applied in order, the link ends at the last place', async () => {
    const { w, record, at } = await app()
    renameSync(join(w.root, 'a.md'), join(w.root, 'b.md'))
    renameSync(join(w.root, 'b.md'), join(w.root, 'c.md'))
    expect(applyFollowSignal(w.publisher, at('a.md', 0, { move: { from: 'a.md', to: 'b.md' } }))).toBe('applied')
    expect(applyFollowSignal(w.publisher, at('b.md', 1, { move: { from: 'b.md', to: 'c.md' } }))).toBe('applied')
    await w.publisher.idle()
    expect(record()).toMatchObject({ path: 'c.md', generation: 2, lost: null })
  })

  test('replayed after the move was undone in WriteFlex: stale, the link stays where it is', async () => {
    const { w, record, at } = await app()
    const move = at('a.md', 0, { move: { from: 'a.md', to: 'b.md' } })
    renameSync(join(w.root, 'a.md'), join(w.root, 'b.md'))
    expect(applyFollowSignal(w.publisher, move)).toBe('applied')
    renameSync(join(w.root, 'b.md'), join(w.root, 'a.md'))
    expect(w.publisher.moved(w.root, 'b.md', 'a.md')).toBe(true)
    expect(record()).toMatchObject({ path: 'a.md', generation: 2 })
    expect(applyFollowSignal(w.publisher, move)).toBe('stale')
    expect(record()).toMatchObject({ path: 'a.md', generation: 2 })
  })

  test('a later generation: held; the same generation for another place, another link: stale; a Trash at the right place ends the link', async () => {
    const { w, record, at } = await app()
    expect(applyFollowSignal(w.publisher, at('a.md', 5, { move: { from: 'a.md', to: 'b.md' } }))).toBe('held')
    expect(applyFollowSignal(w.publisher, at('z.md', 0, { move: { from: 'z.md', to: 'b.md' } }))).toBe('stale')
    expect(applyFollowSignal(w.publisher, { ...at('a.md', 0, { move: { from: 'a.md', to: 'b.md' } }), shareId: 'Zz99Yy88Xx77' })).toBe('stale')
    expect(record()).toMatchObject({ path: 'a.md', generation: 0, ended: null })
    expect(applyFollowSignal(w.publisher, at('a.md', 0, { trashed: true }))).toBe('applied')
    await w.publisher.idle()
    expect(record()).toMatchObject({ ended: { removed: true }, on: false })
    expect(applyFollowSignal(w.publisher, at('a.md', 1, { move: { from: 'a.md', to: 'b.md' } }))).toBe('stale')
  })

  test('a move whose record cannot be saved: failed (the signal is kept), the link stays where it was and says so', async () => {
    const { w, record, at } = await app()
    w.recordWrites.fail = true
    expect(applyFollowSignal(w.publisher, at('a.md', 0, { move: { from: 'a.md', to: 'b.md' } }))).toBe('failed')
    expect(record()).toMatchObject({ path: 'a.md', generation: 0 })
    expect(w.publisher.view(w.root, 'a.md').links[0].problem).toMatchObject({ kind: 'not-saved' })
  })
})

describe('a change not saved: Turn off says so, Turn on and comments publish nothing (Sol round 3 P3, R-F)', () => {
  const PIECE = '# York\n\nThe York talk.\n'
  async function app() {
    const w = await publishWorld({ files: { 'a.md': PIECE }, ports: { retryMs: [3_600_000] } })
    const made = await w.publisher.make(w.root, 'a.md', { name: 'Marta', comments: true })
    const shareId = made.ok ? made.shareId! : ''
    await w.publisher.idle()
    return { w, shareId, record: () => w.publisher.records().find((entry) => entry.shareId === shareId)! }
  }

  test('Turn off that could not be saved: the link is off and says it was not saved', async () => {
    const { w, shareId } = await app()
    w.recordWrites.fail = true
    expect((await w.publisher.turnOff(shareId))?.ok).toBe(true)
    const link = w.publisher.view(w.root, 'a.md').links[0]
    expect(link.on).toBe(false)
    expect(link.problem).toMatchObject({ kind: 'not-saved' })
  })

  test('Turn on that could not be saved: the link stays off here, says so, and nothing is published', async () => {
    const { w, shareId, record } = await app()
    expect((await w.publisher.turnOff(shareId))?.ok).toBe(true)
    const pages = w.publishes().length
    w.recordWrites.fail = true
    const on = await w.publisher.turnOn(shareId)
    await w.publisher.idle()
    expect(on?.ok).toBe(false)
    expect(w.publishes()).toHaveLength(pages)
    expect(record()).toMatchObject({ on: false, generation: 0 })
    expect(w.publisher.view(w.root, 'a.md').links[0].problem).toMatchObject({ kind: 'not-saved' })
  })

  test('Turn on: the publish is on record before it is sent; not saved, nothing is sent', async () => {
    const { w, shareId } = await app()
    expect((await w.publisher.turnOff(shareId))?.ok).toBe(true)
    const pages = w.publishes().length
    // The turn-on itself is saved; the queue entry the publish needs is not.
    let writes = 0
    const write = w.recordWrites
    const realFail = Object.getOwnPropertyDescriptor(write, 'fail')!
    Object.defineProperty(write, 'fail', { configurable: true, get: () => { writes += 1; return writes > 1 } })
    try {
      expect((await w.publisher.turnOn(shareId))?.ok).toBe(true)
      await w.publisher.idle()
    } finally { Object.defineProperty(write, 'fail', realFail) }
    expect(w.publishes()).toHaveLength(pages)
    expect(w.publisher.view(w.root, 'a.md').links[0].problem).toMatchObject({ kind: 'not-saved' })
  })

  test('comments changed when nothing can be saved: nothing is published', async () => {
    const { w, shareId } = await app()
    const pages = w.publishes().length
    w.recordWrites.fail = true
    await w.publisher.setComments(shareId, false)
    await w.publisher.idle()
    expect(w.publishes()).toHaveLength(pages)
  })
})

describe('the Collection open in WriteFlex: the app carries the command out and tells its publisher', () => {
  test('a requested move and Trash are told inside the request, before the save signal; no signal is left', async () => {
    await sharedInSettings('talks/york.md')
    const order: string[] = []
    const app = await openAsApp(fx, {
      sharing: {
        moved: async (moves) => { order.push(`moved ${moves.map((move) => `${move.from}>${move.to}`).join()}`); return null },
        trashed: async (paths) => { order.push(`trashed ${paths.join()}`); return null },
      },
      onChanged: (paths) => { order.push(`changed ${paths.length > 0}`) },
    })
    try {
      const moved = await plantRequest(fx, 'move', { path: 'talks/york.md', to: 'talks/york-2026.md' })
      await app.executor.drain()
      expect((await replyTo(fx, moved)).outcome).toBe('applied')
      const trashed = await plantRequest(fx, 'trash', { path: 'talks/york-2026.md' })
      await app.executor.drain()
      expect((await replyTo(fx, trashed)).outcome).toBe('applied')
      expect(order).toEqual(['moved talks/york.md>talks/york-2026.md', 'changed true', 'trashed talks/york-2026.md', 'changed true'])
      expect(await signalFiles()).toEqual([])
    } finally {
      await app.close()
    }
  })
})
