// The editor's write of one document and what its answer means (src/renderer/src/app/write-buffer.ts, App's
// writePath), driven with the real unsaved registry, the real baselines and a main that compares bytes as
// main does (shared/save-basis.ts). Review round 1: Sol M1/M2/S5/S8, Muse M1/S4.
import { describe, expect, it } from 'bun:test'
import { EditorBaselines, textForSave } from '../../src/shared/line-endings'
import { basisAllows, type SaveBasis } from '../../src/shared/save-basis'
import { externalContentReconcileAction, noticeAfterRefusal, refusalMayReload, type ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { writeBuffer, type WriteAnswer, type WriteBufferPorts } from '../../src/renderer/src/app/write-buffer'

const P = 'note.md'

/** One open document: its buffer, its baseline, its notice, and a main that holds the file. */
function harness(start: { disk: string | null; buffer: string; baseline?: string }) {
  const registry = createUnsavedRegistry()
  const baselines = new EditorBaselines()
  if (start.baseline !== undefined) baselines.set(P, start.baseline)
  const h = {
    disk: start.disk,
    buffer: start.buffer as string | null,
    notice: undefined as ExternalDiskNotice | undefined,
    registry,
    baselines,
    bases: [] as SaveBasis[],
    outside: [] as string[],
    flashes: [] as string[],
    dirty: false,
    /** Another program's write between main's commit and its readback, when set. */
    betweenWriteAndReadback: null as (() => void) | null,
    /** Something that happens while the save is on its way to main (in flight), when set. */
    inFlight: null as (() => void) | null,
    throwOnSave: false,
    /** As App's handler: a refusal raises (or keeps) the notice; a clean buffer would take the disk. */
    reconcileCalls: 0,
    ports: null as unknown as WriteBufferPorts,
  }
  const save = async (_path: string, doc: string, basis: SaveBasis): Promise<WriteAnswer> => {
    h.bases.push(basis)
    const during = h.inFlight
    h.inFlight = null
    during?.()
    if (h.throwOnSave) {
      h.throwOnSave = false
      h.disk = textForSave(doc, h.disk) // written, and then the readback failed: unknown to the renderer
      throw new Error('saved but not read back')
    }
    const next = textForSave(doc, h.disk)
    if (h.disk !== null && next === h.disk) return { content: h.disk, written: h.disk }
    if (!basisAllows(basis, h.disk)) return { refused: 'disk-changed', diskText: h.disk, message: 'changed on disk' }
    h.disk = next
    h.betweenWriteAndReadback?.()
    h.betweenWriteAndReadback = null
    return { content: h.disk as string, written: next }
  }
  h.ports = {
    notice: () => h.notice,
    buffer: () => h.buffer,
    baseline: (p) => baselines.get(p),
    baselineDisk: (p) => baselines.diskText(p),
    setBaseline: (p, text) => { baselines.set(p, text) },
    registry,
    save,
    setDirty: (p, dirty, text) => {
      h.dirty = dirty
      if (dirty) registry.typed(p, text)
      else registry.matchesDisk(p, text)
    },
    setDirtyDot: (_p, dirty) => { h.dirty = dirty },
    slow: () => undefined,
    refusedByNotice: (_p, message) => { h.flashes.push(message) },
    refusedByMain: (_p, message) => { h.flashes.push(message) },
    diskChanged: (p, diskText, buffer, answering) => {
      // App's noteDiskChangedUnderBuffer: a clean buffer (known baseline) is reconciled; otherwise the notice.
      if (refusalMayReload({ baseline: baselines.get(p), buffer, diskUnknown: registry.diskIsUnknown(p), answering })) {
        h.reconcileCalls += 1
        return
      }
      const notice = noticeAfterRefusal(h.notice, diskText, answering)
      h.notice = notice
    },
    saved: () => undefined,
    outsideAfterWrite: (_p, diskText) => {
      h.outside.push(diskText)
      h.notice = { kind: 'changed', dirty: true, diskText }
    },
    unknown: () => undefined,
  }
  return h
}

const write = (h: ReturnType<typeof harness>, answered?: ExternalDiskNotice): Promise<boolean> => writeBuffer(h.ports, P, answered)

describe('the baseline after a save is what was written, never what a later read returned (Sol M1, Muse M1)', () => {
  it('another program writes between the commit and the readback: the writer is asked, and the next save cannot overwrite it', async () => {
    const h = harness({ disk: 'A\n', buffer: 'B\n', baseline: 'A\n' })
    h.registry.typed(P, 'B\n')
    h.betweenWriteAndReadback = () => { h.disk = 'C\n' }
    expect(await write(h)).toBe(false) // not a confirmed save: the writer's text is not on disk now
    expect(h.baselines.diskText(P)).toBe('B\n')
    expect(h.outside).toEqual(['C\n'])
    expect(h.notice).toEqual({ kind: 'changed', dirty: true, diskText: 'C\n' })
    expect(h.registry.textOf(P)).toBe('B\n') // the text stays held: a close cannot pass
    expect(h.registry.diskIsUnknown(P)).toBe(true)
    // The next automatic save: refused by the notice in the renderer…
    expect(await write(h)).toBe(false)
    expect(h.disk).toBe('C\n')
    // …and, were the notice gone, by main: the basis is B, the disk holds C.
    h.notice = undefined
    expect(await write(h)).toBe(false)
    expect(h.bases.at(-1)).toEqual({ kind: 'disk', text: 'B\n' })
    expect(h.disk).toBe('C\n')
  })

  it('the no-write path: a readback that differs from the bytes found is an outside change too', async () => {
    const h = harness({ disk: 'A\n', buffer: 'A\n', baseline: 'A\n' })
    const save = h.ports.save
    h.ports.save = async (p, doc, basis) => {
      const answer = await save(p, doc, basis)
      return 'written' in answer ? { ...answer, content: 'C\n' } : answer
    }
    expect(await write(h)).toBe(false)
    expect(h.baselines.diskText(P)).toBe('A\n')
    expect(h.notice?.diskText).toBe('C\n')
  })

  it('a readback equal to what was written: saved, clean, the baseline is the bytes written (the file\'s own line endings)', async () => {
    const h = harness({ disk: 'A\r\n', buffer: 'B\n', baseline: 'A\r\n' })
    h.registry.typed(P, 'B\n')
    expect(await write(h)).toBe(true)
    expect(h.disk).toBe('B\r\n')
    expect(h.baselines.diskText(P)).toBe('B\r\n')
    expect(h.registry.clean()).toBe(true)
    expect(h.dirty).toBe(false)
  })
})

describe('a write of unknown outcome: the buffer is not clean for any automatic reload (Sol M2)', () => {
  it('A → B, the save of B commits but is not read back, undo to A, a refused save does not reload B over A', async () => {
    const h = harness({ disk: 'A\n', buffer: 'B\n', baseline: 'A\n' })
    h.registry.typed(P, 'B\n')
    h.throwOnSave = true
    expect(await write(h)).toBe(false)
    expect(h.disk).toBe('B\n')
    expect(h.registry.diskIsUnknown(P)).toBe(true)
    // Undo back to A, which equals the stale baseline.
    h.buffer = 'A\n'
    h.ports.setDirty(P, false, 'A\n')
    expect(h.registry.textOf(P)).toBe('A\n') // not believed clean: the disk is unknown
    // Saving A is refused by main (disk holds B). The refusal raises the notice; it does not reconcile.
    expect(await write(h)).toBe(false)
    expect(h.reconcileCalls).toBe(0)
    expect(h.notice).toEqual({ kind: 'changed', dirty: true, diskText: 'B\n' })
    expect(h.buffer).toBe('A\n')
    // The watcher's own rule agrees: asked, never replaced.
    expect(externalContentReconcileAction({ buffer: 'A\n', baseline: h.baselines.get(P), baselineDisk: h.baselines.diskText(P), disk: 'B\n', diskUnknown: h.registry.diskIsUnknown(P) })).toBe('conflict')
    // Keep mine against exactly that notice writes A.
    expect(await write(h, h.notice)).toBe(true)
    expect(h.disk).toBe('A\n')
    expect(h.registry.diskIsUnknown(P)).toBe(false)
  })
})

describe('main\'s refusal is never retried (Sol S8, Muse S4; document-owner plan, parcel 2a)', () => {
  it('refused because an accept moved the baseline while the save was in flight: the banner, no second write', async () => {
    const h = harness({ disk: 'A\n', buffer: 'A\nmore\n', baseline: 'A\n' })
    h.registry.typed(P, 'A\nmore\n')
    // Main applies an accepted suggestion while the save is in flight; the app rebases buffer and baseline.
    h.inFlight = () => { h.disk = 'S\n'; h.baselines.set(P, 'S\n'); h.buffer = 'S\nmore\n' }
    expect(await write(h)).toBe(false)
    expect(h.bases).toEqual([{ kind: 'disk', text: 'A\n' }])
    expect(h.disk).toBe('S\n')
    expect(h.notice).toEqual({ kind: 'changed', dirty: true, diskText: 'S\n' })
    expect(h.registry.textOf(P)).toBe('A\nmore\n') // the text the refused write carried stays held
  })

  it('a version that is not the app\'s own is not retried', async () => {
    const h = harness({ disk: 'A\n', buffer: 'B\n', baseline: 'A\n' })
    h.registry.typed(P, 'B\n')
    h.inFlight = () => { h.disk = 'X\n' }
    expect(await write(h)).toBe(false)
    expect(h.bases).toHaveLength(1)
    expect(h.notice?.diskText).toBe('X\n')
  })

  it('a refusal for the version the standing notice already shows keeps that notice: a queued Keep mine on it still writes (Muse S2)', async () => {
    const h = harness({ disk: 'A\n', buffer: 'B\n', baseline: 'A\n' })
    h.registry.typed(P, 'B\n')
    const n: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'X\n' }
    // The autosave passed the renderer's check before the watcher raised N; main then refuses it.
    h.inFlight = () => { h.disk = 'X\n'; h.notice = n }
    expect(await write(h)).toBe(false)
    expect(h.notice).toBe(n)
    expect(await write(h, n)).toBe(true) // Keep mine, queued behind the autosave
    expect(h.disk).toBe('B\n')
  })
})

describe('Keep mine is carried out against the notice whatever the dirty dot says (Sol S5)', () => {
  it('undo cleared the dot; Keep mine still writes the buffer over the version the banner showed', async () => {
    const h = harness({ disk: 'C\n', buffer: 'A\n', baseline: 'A\n' })
    const n: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'C\n' }
    h.notice = n
    expect(await write(h, n)).toBe(true)
    expect(h.bases).toEqual([{ kind: 'keep-mine', text: 'C\n' }])
    expect(h.disk).toBe('A\n')
  })

  it('a format-only change after the banner is a newer version: Keep mine is refused and the banner says again', async () => {
    const h = harness({ disk: 'C\r\n', buffer: 'B\n', baseline: 'A\n' })
    h.registry.typed(P, 'B\n')
    const n: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: 'C\n' }
    h.notice = n
    expect(await write(h, n)).toBe(false)
    expect(h.disk).toBe('C\r\n')
    expect(h.notice).toEqual({ kind: 'changed', dirty: true, diskText: 'C\r\n', again: true })
  })

  it('a removed file is recreated only by Keep mine (basis `new`)', async () => {
    const h = harness({ disk: null, buffer: 'B\n', baseline: 'A\n' })
    const n: ExternalDiskNotice = { kind: 'removed', dirty: true, diskText: null }
    h.notice = n
    expect(await write(h)).toBe(false)
    expect(h.disk).toBeNull()
    expect(await write(h, n)).toBe(true)
    expect(h.bases.at(-1)).toEqual({ kind: 'new' })
    expect(h.disk).toBe('B\n')
  })
})

describe('a save says whether it changed the disk (a no-op flush is not the writer\'s save: Undo turn stays armed)', () => {
  it('the buffer already on disk: saved, unchanged; typed text written: saved, changed', async () => {
    const h = harness({ disk: 'A\n', buffer: 'A\n', baseline: 'A\n' })
    const reports: boolean[] = []
    h.ports = { ...h.ports, saved: (_p, changed) => { reports.push(changed) } }
    expect(await write(h)).toBe(true)
    h.buffer = 'A\nmore\n'
    expect(await write(h)).toBe(true)
    expect(reports).toEqual([false, true])
  })
})
