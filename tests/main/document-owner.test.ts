// The document owner (src/renderer/src/app/document-owner.ts; docs/plans/saving-over-an-outside-change/
// document-owner-plan.md, parcel 1), driven with fake ports, the real unsaved registry and a main that
// compares bytes as main does. Each test names the guard it proves.
import { describe, expect, it } from 'bun:test'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows, type SaveBasis } from '../../src/shared/save-basis'
import type { ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { createDocumentOwner } from '../../src/renderer/src/app/document-owner'
import type { WriteAnswer } from '../../src/renderer/src/app/write-buffer'

const P = 'note.md'
const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function harness(start = 'B\n') {
  const registry = createUnsavedRegistry()
  const h = {
    disk: start as string | null,
    buffer: start as string | null,
    notices: new Map<string, ExternalDiskNotice>(),
    /** Every text main was asked to write, in order. */
    writes: [] as string[],
    bases: [] as SaveBasis[],
    /** What happens while a write is on its way to main (before main answers). */
    during: null as (() => Promise<void> | void) | null,
    /** Main's answer, when the test dictates it. */
    answer: null as ((doc: string, basis: SaveBasis) => WriteAnswer) | null,
    readOnly: [] as Array<{ paths: string[]; readOnly: boolean; noticeMicrotaskPending: boolean }>,
    forgotten: false,
    diskChanged: [] as Array<string | null>,
    outside: [] as string[],
    registry,
    // The detach probe (test 3): every read of the notice (the final check reads it) schedules a microtask;
    // whether the latest one has run when the editor is made read-only says whether a turn passed between.
    noticeReads: 0,
    noticeMicrotasksRun: 0,
  }
  const owner = createDocumentOwner({
    buffer: () => h.buffer,
    notice: (path) => {
      const read = ++h.noticeReads
      queueMicrotask(() => { h.noticeMicrotasksRun = Math.max(h.noticeMicrotasksRun, read) })
      return h.notices.get(path)
    },
    registry,
    write: async (_path, doc, basis) => {
      h.writes.push(doc)
      h.bases.push(basis)
      const during = h.during
      h.during = null
      await during?.()
      if (h.answer) return h.answer(doc, basis)
      const next = textForSave(doc, h.disk)
      if (h.disk !== null && next === h.disk) return { content: h.disk, written: h.disk }
      if (!basisAllows(basis, h.disk)) return { refused: 'disk-changed', diskText: h.disk, message: 'changed on disk' }
      h.disk = next
      return { content: next, written: next }
    },
    setReadOnly: (paths, readOnly) => {
      h.readOnly.push({ paths: [...paths], readOnly, noticeMicrotaskPending: h.noticeMicrotasksRun < h.noticeReads })
    },
    forgetBuffer: () => { h.forgotten = true; h.buffer = null },
    replaceBuffer: (_path, diskText) => { h.buffer = diskText },
    dirtyChanged: () => {},
    report: {
      slow: () => {},
      refusedByNotice: () => {},
      refusedByMain: () => {},
      diskChanged: (_path, diskText) => { h.diskChanged.push(diskText) },
      saved: () => {},
      outsideAfterWrite: (_path, diskText) => { h.outside.push(diskText) },
      unknown: () => {},
    },
  })
  owner.activated(P, start, () => h.buffer as string)
  const type = (text: string): void => { h.buffer = text; owner.edited(P, text) }
  return { h, owner, type }
}

describe('the owner holds the queue while a route acts', () => {
  it('1. a save asked for during withFlushed does not run until the action resolves', async () => {
    const { h, owner, type } = harness()
    type('B\nTyped before the route.\n')
    let writesDuringAction: string[] = []
    let autosave: Promise<boolean> | null = null
    const outcome = await owner.withFlushed([P], async () => {
      type('B\nTyped before the route.\nAnd during it.\n') // not detached: this route lets typing in
      autosave = owner.save(P) // the 700 ms autosave fires while the route awaits main
      await tick(30)
      writesDuringAction = [...h.writes]
      return 'done'
    })
    expect(outcome.status).toBe('acted')
    expect(outcome.status === 'acted' && outcome.moved).toEqual([P])
    expect(writesDuringAction).toEqual(['B\nTyped before the route.\n']) // the flush only
    await autosave
    expect(h.writes).toEqual(['B\nTyped before the route.\n', 'B\nTyped before the route.\nAnd during it.\n'])
    expect(owner.isSaved(P)).toBe(true)
  })

  it('a watcher change during a route is applied only after the route, and only if the buffer is saved', async () => {
    const { h, owner } = harness()
    let appliedDuring: string | null = null
    let applying: ReturnType<typeof owner.applyOutside> | null = null
    await owner.withFlushed([P], async () => {
      h.disk = 'Outside.\n'
      applying = owner.applyOutside(P, async () => h.disk as string)
      await tick(30)
      appliedDuring = h.buffer
    })
    expect(appliedDuring).toBe('B\n')
    expect(await applying!).toEqual({ kind: 'replaced', diskText: 'Outside.\n' })
    expect(h.buffer).toBe('Outside.\n')
  })

  it('an autosave queued behind a tab close never writes after the forget', async () => {
    const { h, owner, type } = harness()
    type('B\nTyped.\n')
    let late: Promise<boolean> | null = null
    const outcome = await owner.withFlushed([P], async () => {
      late = owner.save(P)
      await tick(10)
      return owner.forgetIfSaved(P)
    }, { detach: true })
    expect(outcome).toMatchObject({ status: 'acted', result: true })
    expect(await late!).toBe(true)
    expect(h.writes).toEqual(['B\nTyped.\n'])
    expect(h.registry.clean()).toBe(true)
  })
})

describe('saved-ness is the generation, never text equality', () => {
  it('2. typing after the snapshot makes forgetIfSaved refuse, even when it is undone back to the snapshot\'s text', async () => {
    const { h, owner, type } = harness()
    const outcome = await owner.withFlushed([P], () => {
      type('C\n') // typed during the action, then undone back to B
      type('B\n')
      return owner.forgetIfSaved(P)
    })
    expect(outcome).toMatchObject({ status: 'acted', result: false, moved: [P] })
    expect(h.forgotten).toBe(false)
    // Unchanged since the snapshot: forgotten.
    const second = await owner.withFlushed([P], () => owner.forgetIfSaved(P))
    expect(second).toMatchObject({ status: 'acted', result: true })
    expect(h.forgotten).toBe(true)
  })
})

describe('a write is saved as the text it carried, not the buffer after it (Sol M4)', () => {
  it('typing that arrives while the close\'s write is on its way to main is written before the buffer is forgotten', async () => {
    const { h, owner, type } = harness()
    type('B\nBefore the close.\n')
    h.during = () => { type('B\nBefore the close.\nAnd while it saved.\n') }
    const close = await owner.withFlushed([P], () => owner.forgetIfSaved(P), { detach: true })
    expect(close).toMatchObject({ status: 'acted', result: true })
    expect(h.writes).toEqual(['B\nBefore the close.\n', 'B\nBefore the close.\nAnd while it saved.\n'])
    expect(h.disk).toBe('B\nBefore the close.\nAnd while it saved.\n')
  })
})

describe('a write confirms the generation it read', () => {
  it('typing during the write leaves savedGen at the generation of the text that was written', async () => {
    const { h, owner, type } = harness()
    type('B\nWritten.\n')
    const carried = owner.generationsOf(P)!.gen
    h.during = () => { type('B\nWritten.\nTyped during the write.\n') }
    expect(await owner.save(P)).toBe(true)
    expect(owner.generationsOf(P)).toEqual({ gen: carried + 1, savedGen: carried })
    expect(owner.isSaved(P)).toBe(false)
  })
})

describe('detach', () => {
  it('3. the editor is made read-only in the same turn as the final flush check', async () => {
    const { h, owner, type } = harness()
    type('B\nTyped.\n')
    const outcome = await owner.withFlushed([P], () => owner.forgetIfSaved(P), { detach: true })
    expect(outcome).toMatchObject({ status: 'acted', result: true })
    expect(h.readOnly[0]).toEqual({ paths: [P], readOnly: true, noticeMicrotaskPending: true })
  })

  it('a route that does not forget makes the editor editable again (refusal: the trash failed)', async () => {
    const { h, owner } = harness()
    await owner.withFlushed([P], async () => { await tick(1); throw new Error('trash refused') }, { detach: true }).catch(() => undefined)
    expect(h.readOnly.map((call) => call.readOnly)).toEqual([true, false])
    expect(owner.isReadOnly(P)).toBe(false)
  })
})

describe('the receipt is the baseline (Muse r3 M1)', () => {
  it('4. a readback that is not what was written: disk unknown, the registry holds the text, not saved, a close flush asks', async () => {
    const { h, owner, type } = harness('S0\n')
    type('S\n')
    h.answer = (doc) => { h.disk = 'X\n'; return { content: 'X\n', written: doc } } // another program, before the readback
    expect(await owner.save(P)).toBe(false)
    h.answer = null
    expect(owner.baselineDiskOf(P)).toBe('S\n')
    expect(h.outside).toEqual(['X\n'])
    expect(h.registry.textOf(P)).toBe('S\n')
    expect(owner.isSaved(P)).toBe(false)
    // A close: the flush writes, main finds X where the buffer was based on S, and the close is refused.
    let forgot = false
    const close = await owner.withFlushed([P], () => { forgot = owner.forgetIfSaved(P) }, { detach: true })
    expect(close).toEqual({ status: 'refused', path: P })
    expect(forgot).toBe(false)
    expect(h.forgotten).toBe(false)
    expect(h.disk).toBe('X\n')
  })

  it('the writer\'s Reload takes the disk version and the document is known again (review S6)', async () => {
    const { h, owner, type } = harness('S0\n')
    type('S\n')
    h.answer = (doc) => { h.disk = 'X\n'; return { content: 'X\n', written: doc } }
    expect(await owner.save(P)).toBe(false)
    h.answer = null
    expect(await owner.reload(P, async () => h.disk as string)).toEqual({ ok: true, diskText: 'X\n' })
    expect(h.buffer).toBe('X\n')
    // The owner's own mark is cleared (the registry's mark of unknown outcome stays: accepted residual).
    h.registry.beginWrite(P, 'X\n').succeeded()
    expect(owner.isSaved(P)).toBe(true)
  })

  it('Reload never discards a keystroke made after it was pressed: the buffer is kept, unsaved (final review round 1, finding 3)', async () => {
    const { h, owner, type } = harness('S\n')
    h.disk = 'X\n'
    let answer!: (text: string) => void
    const reloading = owner.reload(P, () => new Promise<string>((resolve) => { answer = resolve }))
    await tick()
    // The read is pending; the writer types.
    type('S and typing after Reload\n')
    answer(h.disk as string)
    expect(await reloading).toEqual({ ok: false, reason: 'typed' })
    expect(h.buffer).toBe('S and typing after Reload\n')
    expect(owner.isSaved(P)).toBe(false)
    expect(h.registry.textOf(P)).toBe('S and typing after Reload\n')
    expect(owner.baselineDiskOf(P)).toBe('S\n')
    // Typing before the press is the writer's to give up: a Reload pressed after it takes the disk.
    expect(await owner.reload(P, async () => h.disk as string)).toEqual({ ok: true, diskText: 'X\n' })
    expect(h.buffer).toBe('X\n')
  })

  it('text the registry holds for a parcel-2 route (a redo of unknown outcome) is written before a close forgets the buffer', async () => {
    const { h, owner } = harness()
    // The redo put its text in the buffer silently and its write threw: the registry holds the text, the
    // owner's own record saw no change.
    h.buffer = 'B\nRedone.\n'
    h.registry.beginWrite(P, 'B\nRedone.\n').unknown()
    const close = await owner.withFlushed([P], () => owner.forgetIfSaved(P), { detach: true })
    expect(close).toMatchObject({ status: 'acted', result: true })
    expect(h.writes).toEqual(['B\nRedone.\n'])
    expect(h.disk).toBe('B\nRedone.\n')
  })

  it('an accept that main wrote, read back as another version, keeps the text held (mainWriteUnknown)', () => {
    const { h, owner } = harness('S\n')
    expect(owner.isSaved(P)).toBe(true) // the buffer is what main wrote
    owner.mainWriteUnknown(P, 'S\n')
    expect(h.registry.textOf(P)).toBe('S\n')
    expect(h.registry.diskIsUnknown(P)).toBe(true)
    expect(owner.isSaved(P)).toBe(false)
  })
})

describe('refusal', () => {
  it('5. disk-changed: the notice is raised with the disk text, savedGen is unchanged, no retry', async () => {
    const { h, owner, type } = harness()
    type('B\nMine.\n')
    const before = owner.generationsOf(P)
    h.disk = 'Outside.\n'
    expect(await owner.save(P)).toBe(false)
    expect(owner.generationsOf(P)).toEqual(before) // savedGen unchanged by a refused write
    expect(before!.savedGen).not.toBe(before!.gen)
    expect(h.diskChanged).toEqual(['Outside.\n'])
    expect(h.writes).toEqual(['B\nMine.\n'])
    expect(owner.isSaved(P)).toBe(false)
    expect(owner.baselineDiskOf(P)).toBe('B\n')
    expect(h.registry.textOf(P)).toBe('B\nMine.\n')
  })

  it('a refused flush is a refusal of the route, and its action does not run', async () => {
    const { h, owner, type } = harness()
    type('B\nMine.\n')
    h.disk = 'Outside.\n'
    let ran = false
    expect(await owner.withFlushed([P], () => { ran = true })).toEqual({ status: 'refused', path: P })
    expect(ran).toBe(false)
  })

  it('a checkpoint that throws (a removed file, Sol r3 S1) is a refusal, not a throw', async () => {
    const { owner } = harness()
    const outcome = await owner.withFlushed([P], () => owner.forgetIfSaved(P), {
      detach: true,
      afterSave: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    })
    expect(outcome).toEqual({ status: 'refused', path: P })
  })
})
