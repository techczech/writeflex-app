// The autosave's quiet save and non-resetting deadline (src/renderer/src/app/autosave-scheduler.ts) and the
// owner's edit/save receipts (save-receipts.ts), driven on a fake clock with the real document owner, the
// real unsaved registry, a main that compares bytes as main does, and a fake backup client recording every
// receipt (_TASK-LOG/2026-10-24-vault-backup-autosave.md). Each test names the obligation it proves.
import { describe, expect, it } from 'bun:test'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows, type SaveBasis } from '../../src/shared/save-basis'
import { mayWriteUnderDiskNotice, type ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import type { WriteAnswer } from '../../src/renderer/src/app/write-buffer'
import { AUTOSAVE_DEADLINE_LEAD_MS, AUTOSAVE_DEADLINE_MS, AUTOSAVE_RETRY_MS, createAutosaveScheduler, type AutosaveClock } from '../../src/renderer/src/app/autosave-scheduler'
import { fanOutReceipts, type EditReceipt, type SaveCompletionReceipt, type SaveOutcome, type SaveReceiptPort, type SaveStartReceipt } from '../../src/renderer/src/app/save-receipts'

/** Real macrotask turns: the owner's queue and the fake main's promises settle between fake-clock steps. */
const turns = async (n = 4): Promise<void> => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

/** `t` is elapsed time, on which the timers run. With `wall`, the clock also has a wall time that a test
 *  can move (`jumpWall`) and an `elapsed` port; without it, `now` is the only reading and never jumps. */
function fakeClock(wall = false) {
  let t = 1_000_000
  let wallOffset = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: AutosaveClock & { advance(ms: number): Promise<void>; readonly t: number; jumpWall(ms: number): void } = {
    get t() { return t },
    now: () => t + wallOffset,
    ...(wall ? { elapsed: () => t } : {}),
    jumpWall(ms) {
      if (!wall) throw new Error('this clock has no separate wall time')
      wallOffset += ms
    },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id },
    clearTimeout: (handle) => { timers.delete(handle as number) },
    /** Move time on by `ms`, running every timer due on the way at its own time, settling between. */
    async advance(ms) {
      const end = t + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry
        if (!next) break
        timers.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn()
        await turns()
      }
      t = end
      await turns()
    },
  }
  return clock
}

/** A fake backup client: every receipt, in order. */
function fakeBackupClient() {
  const events: Array<{ kind: 'edit'; r: EditReceipt } | { kind: 'start'; r: SaveStartReceipt } | { kind: 'done'; r: SaveCompletionReceipt }> = []
  const port: SaveReceiptPort = {
    edited: (r) => events.push({ kind: 'edit', r }),
    saveStarted: (r) => events.push({ kind: 'start', r }),
    saveCompleted: (r) => events.push({ kind: 'done', r }),
  }
  return {
    port,
    events,
    edits: (path: string) => events.flatMap((e) => (e.kind === 'edit' && e.r.path === path ? [e.r] : [])),
    completions: (path: string) => events.flatMap((e) => (e.kind === 'done' && e.r.path === path ? [e.r] : [])),
    flushed: (path: string) => events.flatMap((e) => (e.kind === 'done' && e.r.path === path && e.r.outcome === 'flushed' ? [e.r] : [])),
  }
}

/** Several open documents, the owner, the scheduler wired as App wires them, and a main holding files. */
function harness(paths: string[] = ['a.md'], opts: { wall?: boolean } = {}) {
  const clock = fakeClock(opts.wall)
  const client = fakeBackupClient()
  const registry = createUnsavedRegistry()
  const disk = new Map<string, string | null>(paths.map((p) => [p, 'start\n']))
  const buffers = new Map<string, string | null>(paths.map((p) => [p, 'start\n']))
  const h = {
    disk,
    buffers,
    notices: new Map<string, ExternalDiskNotice>(),
    writes: [] as Array<{ path: string; doc: string; at: number }>,
    /** Main's answer, when the test dictates it (once per write, then normal again). */
    answer: null as ((path: string, doc: string, basis: SaveBasis) => WriteAnswer) | null,
    /** Main throws for this write (once). */
    throwOnce: false,
    /** Hold the next write on its way to main until released. */
    hold: null as Promise<void> | null,
    /** The app's editor is gone (unmounted by an error). */
    noEditor: false,
    flashes: [] as string[],
  }
  const owner = createDocumentOwner({
    buffer: (p) => (h.noEditor ? undefined : h.buffers.get(p) ?? null),
    notice: (p) => h.notices.get(p),
    registry,
    write: async (path, doc, basis) => {
      h.writes.push({ path, doc, at: clock.now() })
      const hold = h.hold
      h.hold = null
      if (hold) await hold
      if (h.throwOnce) { h.throwOnce = false; throw new Error('simulated failure') }
      const answer = h.answer
      h.answer = null
      if (answer) return answer(path, doc, basis)
      const was = h.disk.get(path) ?? null
      const next = textForSave(doc, was)
      if (was !== null && next === was) return { content: was, written: was }
      if (!basisAllows(basis, was)) return { refused: 'disk-changed', diskText: was, message: 'changed on disk' }
      h.disk.set(path, next)
      return { content: next, written: next }
    },
    setReadOnly: () => {},
    forgetBuffer: (p) => { h.buffers.set(p, null) },
    renameBuffer: (from, to) => { h.buffers.set(to, h.buffers.get(from) ?? null); h.buffers.delete(from) },
    replaceBuffer: (p, text) => { h.buffers.set(p, text) },
    dirtyChanged: () => {},
    report: {
      slow: () => {},
      refusedByNotice: (_p, m) => { h.flashes.push(m) },
      refusedByMain: (_p, m) => { h.flashes.push(m) },
      diskChanged: () => {},
      saved: () => {},
      outsideAfterWrite: () => {},
      unknown: () => {},
    },
    receipts: fanOutReceipts(() => [scheduler.receipts, client.port]),
    now: () => clock.now(),
  })
  // As App: the autosave writes nothing under an unanswered notice, and asks the owner what is saved.
  const scheduler = createAutosaveScheduler({
    clock,
    flush: (path) => (mayWriteUnderDiskNotice(h.notices.get(path)) ? owner.save(path) : Promise.resolve(false)),
    isSaved: (path) => owner.isSaved(path),
  })
  for (const p of paths) owner.activated(p, 'start\n', () => h.buffers.get(p) as string)
  /** The writer types in `path` (App's handleDocChanged: the owner counts it, the autosave is asked). */
  const type = (path: string, text: string): void => {
    h.buffers.set(path, text)
    owner.edited(path, text)
    scheduler.request(path)
  }
  return { h, clock, client, owner, scheduler, type, registry }
}

const BUDGET = AUTOSAVE_DEADLINE_MS - AUTOSAVE_DEADLINE_LEAD_MS

describe('the quiet save is as before', () => {
  it('writes 700 ms after the last keystroke, and typing re-arms it', async () => {
    const { h, clock, type } = harness()
    type('a.md', 'one\n')
    await clock.advance(500)
    type('a.md', 'one two\n')
    await clock.advance(699)
    expect(h.writes).toEqual([])
    await clock.advance(1)
    expect(h.writes.map((w) => w.doc)).toEqual(['one two\n'])
    expect(h.disk.get('a.md')).toBe('one two\n')
  })
})

describe('the deadline is anchored at the oldest unflushed edit and never postponed by typing', () => {
  it('continuous typing on one path is on disk within 60 s of each oldest unflushed edit', async () => {
    const { h, clock, client, scheduler, type } = harness()
    const t0 = clock.t
    let text = ''
    // A keystroke every 100 ms for three minutes: the quiet save never fires.
    for (let i = 0; i < 1800; i += 1) {
      text += 'x'
      type('a.md', `${text}\n`)
      const oldest = scheduler.oldestUnflushedAt('a.md')
      if (oldest !== undefined) expect(clock.t - oldest).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
      await clock.advance(100)
    }
    const flushed = client.flushed('a.md')
    expect(flushed.length).toBeGreaterThanOrEqual(3)
    expect(flushed[0]!.at - t0).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
    expect(flushed[0]!.at - t0).toBe(BUDGET) // fired at 50 s, finished at once on this main
    // Every flushed save covered edits no older than 60 s at its completion.
    const edits = client.edits('a.md')
    let coveredUpTo = 0
    for (const done of flushed) {
      const oldestCovered = edits.find((e) => e.gen > coveredUpTo)!
      expect(done.at - oldestCovered.at).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
      coveredUpTo = done.gen!
    }
    expect(h.writes.length).toBe(flushed.length)
  })

  it('several paths typed continuously in turn: none starves, each meets its own deadline', async () => {
    const paths = ['a.md', 'b.md', 'c.md']
    const { clock, client, scheduler, type } = harness(paths)
    const texts = new Map(paths.map((p) => [p, '']))
    for (let i = 0; i < 2400; i += 1) {
      const p = paths[i % paths.length]!
      texts.set(p, `${texts.get(p)}y`)
      type(p, `${texts.get(p)}\n`)
      for (const q of paths) {
        const oldest = scheduler.oldestUnflushedAt(q)
        if (oldest !== undefined) expect(clock.t - oldest).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
      }
      await clock.advance(50) // each path is typed every 150 ms: no quiet save fires
    }
    for (const p of paths) {
      const flushed = client.flushed(p)
      expect(flushed.length).toBeGreaterThanOrEqual(2)
      const edits = client.edits(p)
      let coveredUpTo = 0
      for (const done of flushed) {
        const oldestCovered = edits.find((e) => e.gen > coveredUpTo)!
        expect(done.at - oldestCovered.at).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
        coveredUpTo = done.gen!
      }
    }
  })

  it('edit, save start and save completion are separate receipts with their own times', async () => {
    const { h, clock, client, type } = harness()
    let release!: () => void
    h.hold = new Promise<void>((resolve) => { release = resolve })
    type('a.md', 'one\n')
    const editAt = clock.t
    await clock.advance(700)
    const startAt = clock.t
    await clock.advance(1500) // main takes 1.5 s
    release()
    await turns()
    const [edit] = client.edits('a.md')
    const start = client.events.find((e) => e.kind === 'start')!.r as SaveStartReceipt
    const [done] = client.completions('a.md')
    expect(edit).toMatchObject({ gen: 1, at: editAt })
    expect(start).toMatchObject({ gen: 1, at: startAt, epoch: edit!.epoch })
    expect(done).toMatchObject({ gen: 1, startedAt: startAt, at: startAt + 1500, outcome: 'flushed', changed: true })
  })
})

describe('a save acknowledges only the generation it captured', () => {
  it('an old save finishing after newer typing flushes the old gen; the newer edit stays owed with its own age', async () => {
    const { h, clock, client, scheduler, owner, type } = harness()
    let release!: () => void
    h.hold = new Promise<void>((resolve) => { release = resolve })
    type('a.md', 'old\n')
    await clock.advance(700) // the quiet save reads 'old' (gen 1) and goes out
    expect(h.writes.map((w) => w.doc)).toEqual(['old\n'])
    await clock.advance(100)
    type('a.md', 'old new\n') // gen 2, while gen 1's write is out
    const newerAt = clock.t
    release()
    await turns()
    const [done] = client.flushed('a.md')
    expect(done!.gen).toBe(1)
    expect(h.disk.get('a.md')).toBe('old\n')
    expect(owner.isSaved('a.md')).toBe(false)
    expect(scheduler.oldestUnflushedAt('a.md')).toBe(newerAt)
    await clock.advance(700)
    expect(h.disk.get('a.md')).toBe('old new\n')
    expect(client.flushed('a.md').map((r) => r.gen)).toEqual([1, 2])
    expect(scheduler.oldestUnflushedAt('a.md')).toBeUndefined()
  })
})

describe('nothing but a confirmed write is a flush', () => {
  const failures: Array<[string, (h: ReturnType<typeof harness>['h']) => void, SaveOutcome]> = [
    ['main refuses it', (h) => { h.answer = () => ({ refused: true, message: 'Refused an empty save.' }) }, 'refused-by-main'],
    ['the write throws', (h) => { h.throwOnce = true }, 'unknown'],
    ['the readback differs', (h) => { h.answer = (_p, doc) => ({ written: doc, content: 'someone else\n' }) }, 'readback-mismatch'],
    ['the disk changed under it', (h) => { h.disk.set('a.md', 'outside\n') }, 'disk-changed'],
  ]
  for (const [name, arrange, outcome] of failures) {
    it(`${name}: no flushed receipt, the oldest age stays through the retry`, async () => {
      const { h, clock, client, scheduler, type } = harness()
      type('a.md', 'mine\n')
      const editAt = clock.t
      arrange(h)
      await clock.advance(700)
      expect(client.completions('a.md').map((r) => r.outcome)).toEqual([outcome])
      expect(client.flushed('a.md')).toEqual([])
      expect(scheduler.oldestUnflushedAt('a.md')).toBe(editAt)
      // A failure keeps it owed, and the next attempt is the deadline (or the retry floor), not sooner.
      const writesBefore = h.writes.length
      await clock.advance(BUDGET - 700 - 1)
      expect(h.writes.length).toBe(writesBefore)
      arrange(h) // fails again
      await clock.advance(1)
      // Only a write that threw is sent again unasked; a refusal, a changed disk or a differing readback
      // waits for new typing (a refused empty save makes a rescue copy each time).
      expect(h.writes.length).toBe(outcome === 'unknown' ? writesBefore + 1 : writesBefore)
      expect(client.flushed('a.md')).toEqual([])
      expect(scheduler.oldestUnflushedAt('a.md')).toBe(editAt) // retained age after the failed retry
      expect(scheduler.deadlineOf('a.md')).toBe(clock.t + AUTOSAVE_RETRY_MS)
      // New typing sends it again, and the age is still the first edit's.
      if (outcome !== 'unknown') {
        type('a.md', 'mine again\n')
        await clock.advance(700)
        expect(h.writes.length).toBe(writesBefore + 1)
        expect(client.flushed('a.md')).toEqual([])
        expect(scheduler.oldestUnflushedAt('a.md')).toBe(editAt)
      }
    })
  }

  it('under an unanswered disk notice: the deadline writes nothing, grants no overwrite, and the age stays', async () => {
    const { h, clock, client, scheduler, type } = harness()
    type('a.md', 'mine\n')
    const editAt = clock.t
    h.notices.set('a.md', { path: 'a.md', diskText: 'theirs\n' } as unknown as ExternalDiskNotice)
    await clock.advance(AUTOSAVE_DEADLINE_MS * 3)
    expect(h.writes).toEqual([])
    expect(client.flushed('a.md')).toEqual([])
    expect(scheduler.oldestUnflushedAt('a.md')).toBe(editAt)
    expect(h.disk.get('a.md')).toBe('start\n')
  })

  it('an explicit save refused by the notice issues a refusal receipt with no gen', async () => {
    const { h, client, owner, type } = harness()
    type('a.md', 'mine\n')
    h.notices.set('a.md', { path: 'a.md', diskText: 'theirs\n' } as unknown as ExternalDiskNotice)
    expect(await owner.save('a.md')).toBe(false)
    const [done] = client.completions('a.md')
    expect(done!.outcome).toBe('refused-by-notice')
    expect(done!.gen).toBeUndefined()
  })

  it('a save not let run, and one with no editor, are not flushes', async () => {
    const { h, client, owner, type } = harness()
    type('a.md', 'mine\n')
    expect(await owner.save('a.md', undefined, async () => false)).toBe(false)
    h.noEditor = true
    expect(await owner.save('a.md')).toBe(true) // unsaved-text.ts answers for the text; nothing written
    expect(client.completions('a.md').map((r) => r.outcome)).toEqual(['not-allowed', 'no-editor'])
    expect(client.completions('a.md').every((r) => r.gen === undefined)).toBe(true)
    expect(client.flushed('a.md')).toEqual([])
    expect(h.writes).toEqual([])
  })
})

describe('tab switches and cancelled timers never drop an obligation', () => {
  it('a cancelled quiet save leaves the deadline armed, and it writes', async () => {
    const { h, clock, client, scheduler, type } = harness()
    type('a.md', 'mine\n')
    const editAt = clock.t
    scheduler.cancel('a.md') // a route took the path and then wrote nothing (it gave up)
    await clock.advance(BUDGET - 1)
    expect(h.writes).toEqual([])
    await clock.advance(1)
    expect(h.writes.map((w) => w.doc)).toEqual(['mine\n'])
    expect(client.flushed('a.md')[0]!.at - editAt).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
  })

  it('a tab switch (or blur) writes every waiting path now; cancelling every quiet save keeps the debt', async () => {
    const { h, clock, owner, scheduler, type } = harness(['a.md', 'b.md'])
    type('a.md', 'a1\n')
    type('b.md', 'b1\n')
    scheduler.flushPending()
    await clock.advance(0)
    expect(h.writes.map((w) => w.path).sort()).toEqual(['a.md', 'b.md'])
    type('a.md', 'a2\n')
    scheduler.cancelQuiet() // the close's flush took over, and its write of a.md threw
    h.throwOnce = true
    expect(await owner.save('a.md')).toBe(false)
    await clock.advance(1000)
    expect(h.writes.length).toBe(3) // the quiet save was cancelled: only the close's write ran
    expect(scheduler.owed().map((o) => o.path)).toEqual(['a.md'])
    await clock.advance(BUDGET)
    expect(h.disk.get('a.md')).toBe('a2\n') // the deadline wrote it
    expect(scheduler.owed()).toEqual([])
  })

  it('a path settled without a save (Reload) drops its marks at the deadline without writing', async () => {
    const { h, clock, owner, scheduler, type } = harness()
    type('a.md', 'mine\n')
    scheduler.cancel('a.md')
    const reloaded = await owner.reload('a.md', async () => 'start\n')
    expect(reloaded.ok).toBe(true)
    await clock.advance(AUTOSAVE_DEADLINE_MS)
    expect(h.writes).toEqual([])
    expect(scheduler.owed()).toEqual([])
  })

  it('a rename carries what the buffer owes, with its age, to the new path', async () => {
    const { h, clock, owner, scheduler, type } = harness(['a.md'])
    type('a.md', 'mine\n')
    const editAt = clock.t
    scheduler.cancel('a.md')
    await owner.withFlushed(['a.md'], async () => {
      type('a.md', 'mine more\n') // typed while main moves the file
      h.disk.set('b.md', h.disk.get('a.md') ?? null)
      h.disk.delete('a.md')
      expect(owner.moved('a.md', 'b.md')).toBe('carried')
      scheduler.moved('a.md', 'b.md')
    })
    const owed = scheduler.owed()
    expect(owed.map((o) => o.path)).toEqual(['b.md'])
    expect(owed[0]!.since).toBeGreaterThanOrEqual(editAt)
    await clock.advance(700)
    expect(h.disk.get('b.md')).toBe('mine more\n')
    expect(scheduler.owed()).toEqual([])
  })
})

describe('the budget runs on elapsed time; moving the wall clock neither postpones nor hurries it', () => {
  /** Type into `path` every 100 ms for `ms`; the elapsed time of the first flush of a gen >= `gen`. */
  const typeFor = async (x: ReturnType<typeof harness>, ms: number, gen: number): Promise<number | undefined> => {
    let flushedAt: number | undefined
    for (let i = 0; i < ms / 100; i += 1) {
      x.type('a.md', `typing ${i}\n`)
      await x.clock.advance(100)
      if (flushedAt === undefined && x.client.flushed('a.md').some((r) => r.gen! >= gen)) flushedAt = x.clock.t
    }
    return flushedAt
  }

  for (const jump of [-120_000, 120_000]) {
    it(`wall clock moved ${jump < 0 ? 'back' : 'forward'} 120 s while a save is out: the newer edit is on disk within 60 s of it, and not early`, async () => {
      const x = harness(['a.md'], { wall: true })
      let release!: () => void
      try {
        x.h.hold = new Promise<void>((resolve) => { release = resolve })
        x.type('a.md', 'old\n')
        await x.clock.advance(700) // gen 1's quiet save goes out and is held
        await x.clock.advance(100)
        x.type('a.md', 'new\n') // gen 2, owed while gen 1 is out
        const newerT = x.clock.t
        const newerWall = x.clock.now()
        x.clock.jumpWall(jump)
        await x.clock.advance(100)
        release()
        await turns()
        expect(x.client.flushed('a.md').map((r) => r.gen)).toEqual([1])
        // The age reported is the receipt's wall time, as the receipts have it; the deadline is elapsed.
        expect(x.client.edits('a.md')[1]!.at).toBe(newerWall)
        expect(x.scheduler.oldestUnflushedAt('a.md')).toBe(newerWall)
        expect(x.scheduler.deadlineOf('a.md')).toBe(newerT + BUDGET)
        const flushedAt = await typeFor(x, 61_000, 2)
        expect(flushedAt).toBeDefined()
        expect(flushedAt! - newerT).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
        // Not hurried either: no write between gen 1's and the deadline's, and no burst of writes.
        expect(flushedAt! - newerT).toBeGreaterThanOrEqual(BUDGET)
        expect(x.h.writes).toHaveLength(2)
      } finally { release?.(); await turns(); x.scheduler.dispose() }
    })
  }

  it('wall clock moved back before any save: continuous typing still reaches the disk within 60 s', async () => {
    const x = harness(['a.md'], { wall: true })
    try {
      x.type('a.md', 'first\n')
      const firstT = x.clock.t
      x.clock.jumpWall(-120_000)
      const flushedAt = await typeFor(x, 61_000, 1)
      expect(flushedAt).toBeDefined()
      expect(flushedAt! - firstT).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
      expect(x.h.writes).toHaveLength(1)
    } finally { x.scheduler.dispose() }
  })

  it('a failed deadline write is retried retryMs of elapsed time later, though the wall clock moved back during it; the age stays', async () => {
    const x = harness(['a.md'], { wall: true })
    let release!: () => void
    try {
      x.h.throwOnce = true
      x.type('a.md', 'mine\n')
      const editT = x.clock.t
      const editWall = x.clock.now()
      await x.clock.advance(700) // the quiet save throws: unknown
      expect(x.client.completions('a.md').map((r) => r.outcome)).toEqual(['unknown'])
      // The deadline's write is held, the wall clock moves back while it is out, and then it throws.
      x.h.hold = new Promise<void>((resolve) => { release = resolve })
      x.h.throwOnce = true
      for (let i = 0; x.h.writes.length < 2 && i < 600; i += 1) {
        x.type('a.md', `mine ${i}\n`)
        await x.clock.advance(100)
      }
      expect(x.h.writes).toHaveLength(2)
      expect(x.clock.t - editT).toBeLessThanOrEqual(AUTOSAVE_DEADLINE_MS)
      x.clock.jumpWall(-120_000)
      release()
      await turns()
      const failedAt = x.clock.t
      expect(x.client.completions('a.md').map((r) => r.outcome)).toEqual(['unknown', 'unknown'])
      const flushedAt = await typeFor(x, AUTOSAVE_RETRY_MS + 1000, 1)
      expect(flushedAt).toBeDefined()
      expect(flushedAt! - failedAt).toBeLessThanOrEqual(AUTOSAVE_RETRY_MS + 100)
      expect(flushedAt! - failedAt).toBeGreaterThanOrEqual(AUTOSAVE_RETRY_MS - 100) // no busy retry
      expect(x.h.writes).toHaveLength(3)
      // Until that flush, the oldest age was the first edit's wall time.
      expect(x.client.edits('a.md')[0]!.at).toBe(editWall)
    } finally { release?.(); await turns(); x.scheduler.dispose() }
  })
})
