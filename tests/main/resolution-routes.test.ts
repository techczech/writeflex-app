// The resolutions of a change that make main write an open document, as routes of the document owner
// (src/renderer/src/app/resolution-routes.ts, document-owner.ts `replaceFromMain` and `inQueue`;
// docs/plans/saving-over-an-outside-change/document-owner-plan.md, parcel 2a), and the other main writes
// (goal, restore, clear) at the owner's seam. The owner and the unsaved registry are the real ones; the
// editor and main are variables here, main comparing bases as main does. Each queue test names its guard.
// (Ported from main-wrote-document.test.ts, whose module folded into the owner.)
import { describe, expect, it } from 'bun:test'
import { acceptThroughOwner, replayAcceptRedo, type AcceptRedoPorts } from '../../src/renderer/src/app/resolution-routes'
import { createDocumentOwner, type MainWriteAnswer, type OutsideOutcome } from '../../src/renderer/src/app/document-owner'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import type { FileReadResult } from '../../src/preload'
import { basisAllows, type SaveBasis } from '../../src/shared/save-basis'
import type { WriteAnswer } from '../../src/renderer/src/app/write-buffer'
import { reconcileReplace } from '../../src/renderer/src/editor/reconcile'

const P = 'draft.md'
const ID = 'change-1'
const DRAFT = 'The opening sentence is sprawling.\n'
const ACCEPTED = 'The opening sentence sprawls.\n'
const tick = (ms = 10): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const file = (content: string): FileReadResult => ({ content, file: { path: P, name: P } } as unknown as FileReadResult)
/** Main wrote `content` and read the file back as `content` (or as `readBack`, another program's write). */
const wrote = (content: string, readBack = content): MainWriteAnswer => ({ content: readBack, written: content })

/** A window on one document. `buffer: null` is a tab that is not resident; `mounted: false` an app
 *  unmounted by an error. The start buffer is put there without a report (as the editor's redo of a
 *  resolution may be). */
function window_(start: { disk: string; buffer: string | null; baseline: string; status?: string }) {
  const registry = createUnsavedRegistry()
  const w = {
    registry,
    disk: start.disk,
    status: start.status ?? 'pending',
    buffer: start.baseline as string | null,
    mounted: true,
    /** Every call main received, in order. */
    calls: [] as string[],
    flashes: [] as string[],
    bases: [] as SaveBasis[],
    banners: [] as Array<{ diskText: string | null; buffer: string }>,
    /** What the owner's read after a refusal decided (App raises the notice from a conflict or removal). */
    refusals: [] as OutsideOutcome[],
    /** Outside changes raised: a readback that is not what main wrote. */
    outside: [] as string[],
    /** A file:save from the owner waits for this when set (a held save). */
    holdSave: null as Promise<void> | null,
    /** What main does with the redo's put-back; replaced per test. */
    saveFile: async (content: string, basis?: SaveBasis): Promise<(FileReadResult & { written: string }) | { refused: 'empty-write'; message: string } | { refused: 'disk-changed'; path: string; diskText: string | null; message: string }> => {
      // As main does: the write is made only over the version the basis names, then read back.
      if (basis && !basisAllows(basis, w.disk)) return { refused: 'disk-changed', path: P, diskText: w.disk, message: 'changed on disk' }
      w.disk = content
      w.betweenWriteAndReadback?.()
      return { ...file(w.disk), written: content }
    },
    /** Another program's write between main's commit and its readback, when set. */
    betweenWriteAndReadback: null as (() => void) | null,
    resolveAccept: async (): Promise<{ applied: boolean; file?: FileReadResult; written?: string; message?: string; changedOnDisk?: { path: string; diskText: string | null } }> => {
      w.disk = ACCEPTED
      w.status = 'accepted'
      return { applied: true, file: file(ACCEPTED), written: ACCEPTED }
    },
    release: null as (() => void) | null,
    gated: false,
    edit: (_text: string): void => {},
    owner: null as unknown as ReturnType<typeof createDocumentOwner>,
    ports: null as unknown as AcceptRedoPorts,
  }
  const owner = createDocumentOwner({
    buffer: () => (w.mounted ? w.buffer : undefined),
    notice: () => undefined,
    registry,
    write: async (_path, doc, basis): Promise<WriteAnswer> => {
      w.calls.push(`save:${doc}`)
      if (w.holdSave) await w.holdSave
      if (doc === w.disk) return { content: w.disk, written: w.disk }
      if (!basisAllows(basis, w.disk)) return { refused: 'disk-changed', diskText: w.disk, message: 'changed on disk' }
      w.disk = doc
      return { content: doc, written: doc }
    },
    setReadOnly: () => {},
    forgetBuffer: () => { w.buffer = null },
    replaceBuffer: (_path, diskText) => { w.buffer = diskText },
    dirtyChanged: () => {},
    report: {
      slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {},
      diskChanged: (_path, diskText, buffer) => { w.banners.push({ diskText, buffer }) },
      saved: () => {},
      outsideAfterWrite: (_path, diskText) => { w.outside.push(diskText) },
      unknown: () => {},
    },
  })
  owner.activated(P, start.baseline, () => start.baseline)
  w.buffer = start.buffer
  w.owner = owner
  w.edit = (text: string) => { w.buffer = text; owner.edited(P, text) }
  w.ports = {
    owner,
    bufferOf: () => (w.mounted ? w.buffer : null),
    heldText: (path) => registry.textOf(path),
    hold: (path) => registry.hold(path),
    diskChanged: (_path, diskText, buffer) => { w.banners.push({ diskText, buffer }) },
    changedOnDisk: async (path, options) => { w.refusals.push(await owner.refusedOnDisk(path, async () => w.disk, options)) },
    editorPresent: () => w.mounted,
    api: {
      saveFile: async (_path: string, content: string, basis: SaveBasis) => { w.calls.push('saveFile'); w.bases.push(basis); return w.saveFile(content, basis) },
      resolveChange: async (_id: string, action: 'accept' | 'reject') => { w.calls.push(`resolve:${action}`); return w.resolveAccept() },
    } as never,
    flash: (message) => { w.flashes.push(message) },
    gate: async () => { if (w.gated) await new Promise<void>((resolve) => { w.release = resolve }) },
  }
  return w
}
const redo = (w: ReturnType<typeof window_>, options: { restore: boolean } = { restore: true }): Promise<boolean> =>
  replayAcceptRedo(w.ports, { id: ID, path: P, ...(options.restore ? { beforeContent: DRAFT } : {}) })
const since = (w: ReturnType<typeof window_>): number => w.owner.generationsOf(P)?.gen ?? 0
const integrate = (w: ReturnType<typeof window_>, answer: MainWriteAnswer, lastKnown?: string) =>
  w.owner.replaceFromMain(P, answer, { since: since(w), mode: 'integrated', ...(lastKnown !== undefined ? { lastKnown } : {}) })

describe('main wrote an open document and the editor took it as an edit: the receipt is the baseline, the buffer is reported against it', () => {
  it('the buffer equals the returned file: baseline moved, clean', () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: DRAFT })
    integrate(w, wrote(ACCEPTED))
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.registry.clean()).toBe(true)
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('the buffer differs from the returned file: it is an entry with the buffer text', () => {
    const w = window_({ disk: ACCEPTED, buffer: `${ACCEPTED}More.\n`, baseline: DRAFT })
    integrate(w, wrote(ACCEPTED))
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}More.\n`)
  })

  it('an entry held for text that is now on disk goes; line endings and BOM are not a difference', () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(ACCEPTED)
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
    integrate(w, wrote(`﻿${ACCEPTED.replace(/\n/g, '\r\n')}`))
    expect(w.registry.clean()).toBe(true)
  })

  it('hole C: after it, undoing back to the pre-accept text is unsaved, where the old baseline called it clean', () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: DRAFT })
    integrate(w, wrote(ACCEPTED))
    w.edit(DRAFT) // undo of the accept
    expect(w.registry.textOf(P)).toBe(DRAFT)
    expect(w.owner.isSaved(P)).toBe(false)
  })

  it('typed while main wrote: never counted as saved, even when the text came back to what main wrote', () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: DRAFT })
    const before = since(w)
    w.edit(`${ACCEPTED}x`)
    w.edit(ACCEPTED)
    w.owner.replaceFromMain(P, wrote(ACCEPTED), { since: before, mode: 'integrated' })
    expect(w.owner.isDirty(P)).toBe(false) // the dot: the text is what is on disk
    expect(w.owner.isSaved(P)).toBe(false) // the gen moved: a write confirms it
  })

  it('no buffer to read: the returned file clears nothing the registry holds', () => {
    const w = window_({ disk: ACCEPTED, buffer: null, baseline: DRAFT })
    w.registry.typed(P, 'typed before the tab went')
    integrate(w, wrote(ACCEPTED))
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.registry.textOf(P)).toBe('typed before the tab went')
  })

  it('no buffer to read, a last known text that is not what is on disk, nothing held: it is kept', () => {
    const w = window_({ disk: ACCEPTED, buffer: null, baseline: DRAFT })
    integrate(w, wrote(ACCEPTED), `${ACCEPTED}More.\n`)
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}More.\n`)
    const same = window_({ disk: ACCEPTED, buffer: null, baseline: DRAFT })
    integrate(same, wrote(ACCEPTED), ACCEPTED)
    expect(same.registry.clean()).toBe(true)
  })
})

describe('the baseline is what main wrote, never the readback (Muse M2, round 2; Muse r3 M1)', () => {
  const OTHER = 'Another program wrote this.\n'
  it('a readback that differs from what main wrote: the baseline is what was written, the banner is raised, and the disk is unknown', () => {
    const w = window_({ disk: OTHER, buffer: ACCEPTED, baseline: DRAFT })
    expect(integrate(w, wrote(ACCEPTED, OTHER))).toEqual({ kind: 'outside', diskText: OTHER })
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.outside).toEqual([OTHER])
    expect(w.registry.textOf(P)).toBe(ACCEPTED) // held: its text is not what is on disk now
    expect(w.owner.isSaved(P)).toBe(false)
  })
  it('main wrote nothing in the call: the baseline stays, and a readback that is not it is an outside change', () => {
    const w = window_({ disk: OTHER, buffer: DRAFT, baseline: DRAFT })
    integrate(w, { content: OTHER })
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT)
    expect(w.outside).toEqual([OTHER])
  })
  it('main wrote nothing and the file is the baseline: nothing is raised', () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    integrate(w, { content: DRAFT })
    expect(w.outside).toEqual([])
    expect(w.registry.clean()).toBe(true)
  })
  it('redo: another program writes between the accept and its readback; the redone buffer is not based on that version', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(ACCEPTED)
    w.resolveAccept = async () => { w.disk = OTHER; w.status = 'accepted'; return { applied: true, file: file(OTHER), written: ACCEPTED } }
    expect(await redo(w)).toBe(true)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.outside).toEqual([OTHER])
  })
  it('redo: the accept writes nothing; the baseline is the text the redo put back, not a later readback', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(ACCEPTED)
    w.resolveAccept = async () => { w.disk = OTHER; return { applied: true, file: file(OTHER) } }
    expect(await redo(w)).toBe(true)
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT)
    expect(w.outside).toEqual([OTHER])
  })
})

describe('redo of an undone accept: in the document\'s queue, under a hold', () => {
  /** After accept, undo and a save of the undone text; then the editor redoes. */
  const redone = () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(ACCEPTED)
    return w
  }

  it('the hold stands from the turn it is asked for, and a close waits for the calls: the document is pending and not settled until they return', async () => {
    // Redo before the undone text was saved: the buffer equals the baseline again, so nothing but the
    // hold stands for the document while the calls are in flight.
    const w = window_({ disk: ACCEPTED, buffer: DRAFT, baseline: ACCEPTED, status: 'pending' })
    w.edit(ACCEPTED)
    expect(w.registry.textOf(P)).toBeUndefined()
    w.gated = true
    const done = redo(w)
    expect(w.registry.pending()).toEqual([P])
    expect(w.registry.textOf(P)).toBeUndefined()
    let settled = false
    void w.registry.settled(P).then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    w.release!()
    expect(await done).toBe(true)
    expect(w.calls).toEqual(['saveFile', 'resolve:accept'])
    await tick()
    expect(settled).toBe(true)
    expect(w.registry.clean()).toBe(true)
  })

  it('success: the file main returns is the baseline and the redone buffer is clean', async () => {
    const w = redone()
    expect(await redo(w)).toBe(true)
    expect([w.disk, w.buffer, w.owner.baselineDiskOf(P), w.status]).toEqual([ACCEPTED, ACCEPTED, ACCEPTED, 'accepted'])
    expect(w.registry.clean()).toBe(true)
    expect(w.owner.isSaved(P)).toBe(true)
    expect(w.flashes).toEqual([])
  })

  it('success, then undo: the undone text is unsaved (the baseline followed the redo)', async () => {
    const w = redone()
    await redo(w)
    w.edit(DRAFT)
    expect(w.registry.textOf(P)).toBe(DRAFT)
  })

  it('typing during the calls: the buffer as it is when they return is what is reported', async () => {
    const w = redone()
    w.gated = true
    const done = redo(w)
    await tick()
    w.edit(`${ACCEPTED}More.\n`)
    w.release!()
    await done
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}More.\n`)
    expect(w.owner.isSaved(P)).toBe(false)
  })

  it('the first write carries the buffer\'s baseline as its basis', async () => {
    const w = redone()
    await redo(w)
    expect(w.bases).toEqual([{ kind: 'disk', text: DRAFT }])
  })

  it('the disk changed under the buffer: nothing written, the redo not applied, the banner raised over the buffer', async () => {
    const w = redone()
    const outside = 'Another program rewrote this.\n'
    w.disk = outside
    expect(await redo(w)).toBe(false)
    expect(w.disk).toBe(outside) // the outside version stays
    expect(w.calls).toEqual(['saveFile']) // main never asked to apply: the change stays resolvable
    expect(w.status).toBe('pending')
    expect(w.banners).toEqual([{ diskText: outside, buffer: ACCEPTED }])
    expect(w.registry.textOf(P)).toBe(ACCEPTED) // the redone text is still unsaved, not lost
  })

  it('another program writes between the put-back and its readback: the redo is not applied over it, the banner is raised, and the baseline is the text put back (Muse S3)', async () => {
    const w = redone()
    const outside = 'Written by another program just after the put-back.\n'
    w.betweenWriteAndReadback = () => { w.disk = outside }
    expect(await redo(w)).toBe(false)
    expect(w.calls).toEqual(['saveFile']) // main never asked to apply the change over that version
    expect(w.status).toBe('pending')
    expect(w.disk).toBe(outside)
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT) // what was written, never what the readback returned
    expect(w.banners).toEqual([{ diskText: outside, buffer: ACCEPTED }])
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
  })

  it('a refused or raced redo holds the redone buffer even when the editor reported no change for it', async () => {
    for (const race of ['refused', 'readback'] as const) {
      const w = window_({ disk: DRAFT, buffer: ACCEPTED, baseline: DRAFT }) // the redo's edit: no report
      expect(w.registry.textOf(P)).toBeUndefined()
      const outside = `Another program (${race}).\n`
      if (race === 'refused') w.disk = outside
      else w.betweenWriteAndReadback = () => { w.disk = outside }
      expect(await redo(w)).toBe(false)
      expect(w.disk).toBe(outside)
      expect(w.registry.textOf(P)).toBe(ACCEPTED) // a close cannot pass the redone text by
    }
  })

  it('the first write is refused: said, nothing marked, main not asked to apply', async () => {
    const w = redone()
    w.saveFile = async () => ({ refused: 'empty-write', message: 'Refused.' })
    expect(await redo(w)).toBe(false)
    expect(w.calls).toEqual(['saveFile'])
    expect(w.flashes).toEqual(['Refused.'])
    expect(w.registry.pending()).toEqual([P]) // the redone text, as before the redo; no hold left
    w.edit(DRAFT) // undo back to the saved text is clean: the disk is known
    expect(w.registry.clean()).toBe(true)
  })

  it('a call throws: the disk is unknown, the current buffer is held, and equalling the old baseline does not clear it', async () => {
    const w = redone()
    w.resolveAccept = async () => { throw new Error('EACCES') }
    expect(await redo(w)).toBe(false)
    expect(w.flashes).toEqual(['Could not save draft.md.'])
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
    w.edit(DRAFT)
    expect(w.registry.textOf(P)).toBe(DRAFT) // still held: only a save that is read back clears it
    w.registry.beginWrite(P, DRAFT).succeeded()
    expect(w.registry.clean()).toBe(true)
  })

  it('a throw when nothing was held (the buffer equalled the baseline): the redone text becomes an entry', async () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED })
    w.resolveAccept = async () => { throw new Error('no') }
    expect(await redo(w)).toBe(false)
    expect(w.disk).toBe(DRAFT) // the pre-accept text was put back
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
  })

  it('main declines after the pre-accept text was put back: unknown, and its message is said', async () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED })
    w.resolveAccept = async () => ({ applied: false, message: 'The original text is not there.' })
    expect(await redo(w)).toBe(false)
    expect(w.flashes).toEqual(['The original text is not there.'])
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
  })

  it('main declines and nothing was put back: said, nothing marked', async () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED })
    w.resolveAccept = async () => ({ applied: false })
    expect(await redo(w, { restore: false })).toBe(false)
    expect(w.calls).toEqual(['resolve:accept'])
    expect(w.flashes).toEqual(['Could not replay that suggestion resolution.'])
    expect(w.registry.clean()).toBe(true)
  })

  it('applied and not read back: applied, and the disk is unknown', async () => {
    const w = redone()
    w.resolveAccept = async () => { w.status = 'accepted'; return { applied: true } }
    expect(await redo(w)).toBe(true)
    w.edit(DRAFT)
    w.edit(ACCEPTED)
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
  })

  it('applied with a receipt and not read back: the receipt is the baseline, the disk is unknown, and a save is checked against the receipt (as an accept, review F4)', async () => {
    // Guard: the redo's no-readback branch through the owner's replaceFromMain. Marking the disk unknown
    // alone leaves the baseline on the pre-accept text: the next save carries a basis the disk no longer
    // holds, and main refuses it.
    const w = redone()
    w.resolveAccept = async () => { w.disk = ACCEPTED; w.status = 'accepted'; return { applied: true, written: ACCEPTED } }
    expect(await redo(w)).toBe(true)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.registry.diskIsUnknown(P)).toBe(true)
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
    expect(w.owner.isSaved(P)).toBe(false)
    w.edit(DRAFT) // Undo: the old text is not cleared against a baseline nothing confirmed
    expect(w.registry.clean()).toBe(false)
    expect(await w.owner.save(P)).toBe(true)
    expect(w.disk).toBe(DRAFT)
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('the app is unmounted during the calls: main is still called, and the text the registry holds stays', async () => {
    const w = redone()
    w.gated = true
    const done = redo(w)
    await tick()
    w.mounted = false
    w.release!()
    expect(await done).toBe(true)
    expect(w.calls).toEqual(['saveFile', 'resolve:accept'])
    expect([w.disk, w.status]).toEqual([ACCEPTED, 'accepted'])
    expect(w.registry.textOf(P)).toBe(ACCEPTED) // not cleared on the strength of a returned file
    expect(w.registry.pending()).toEqual([P])
    await w.registry.settled(P) // no hold left: the page's own save can write it and close
  })

  it('unmounted during the calls with nothing held, and a call throws: the text read at the start is held', async () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED })
    w.gated = true
    w.resolveAccept = async () => { throw new Error('no') }
    const done = redo(w)
    await tick()
    w.mounted = false
    w.release!()
    expect(await done).toBe(false)
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
  })

  it('the tab is closed during the calls and a call throws: no entry comes back for it', async () => {
    const w = redone()
    w.gated = true
    w.resolveAccept = async () => { throw new Error('no') }
    const done = redo(w)
    await tick()
    w.buffer = null
    w.registry.discard(P)
    w.release!()
    expect(await done).toBe(false)
    expect(w.registry.clean()).toBe(true)
  })
})

describe('a main write and a save of the same document never interleave (parcel 2a)', () => {
  it('redo then undo under a held save: main receives the save, the redo and the undo in the order asked for, and the disk ends on the undone text', async () => {
    // Guard: inQueue's place in the queue. Run the redo at once instead (document-owner.ts, `inQueue`
    // calling `op` directly) and the put-back meets the held save's basis race, the undo reaches main
    // before the redo, and the change ends accepted.
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    let releaseSave!: () => void
    w.holdSave = new Promise<void>((resolve) => { releaseSave = resolve })
    const save = w.owner.save(P) // ⌘S of the undone text, held
    await tick()
    w.edit(ACCEPTED) // the editor's redo
    const redoing = redo(w)
    w.edit(DRAFT) // the editor's undo, whose resolution goes to main in the same queue
    const undoing = w.owner.inQueue(P, async () => { w.calls.push('status:pending'); w.status = 'pending' })
    await tick()
    expect(w.calls).toEqual([`save:${DRAFT}`]) // nothing has passed the held save
    w.holdSave = null
    releaseSave()
    expect(await save).toBe(true)
    expect(await redoing).toBe(true)
    await undoing
    expect(w.calls).toEqual([`save:${DRAFT}`, 'saveFile', 'resolve:accept', 'status:pending'])
    expect(w.status).toBe('pending')
    // The undone buffer is unsaved over the redo's receipt: the autosave the undo armed writes it.
    expect(w.owner.isSaved(P)).toBe(false)
    expect(await w.owner.save(P)).toBe(true)
    expect(w.disk).toBe(DRAFT)
    expect(w.owner.isSaved(P)).toBe(true)
    expect(w.banners).toEqual([])
  })

  it('an accept asked for during a held save never writes over the typing: it waits, then applies to the saved text', async () => {
    // Guard: withFlushed's wait for the queue. Without it main applies the change to the old file while
    // the save is in flight, and the save is refused over the accept: a banner over the writer's typing.
    const w = window_({ disk: 'A\n', buffer: 'A\n', baseline: 'A\n' })
    w.edit('A\nmore\n')
    let releaseSave!: () => void
    w.holdSave = new Promise<void>((resolve) => { releaseSave = resolve })
    const save = w.owner.save(P)
    await tick()
    const accepting = acceptThroughOwner({
      owner: w.owner,
      bufferOf: () => w.buffer,
      recordInEditor: (_path, _id, resolved) => { w.buffer = resolved ?? w.buffer; return true },
      askAbout: () => {},
      refusalReason: () => undefined,
    }, P, ID, async () => {
      w.calls.push('resolve:accept')
      const next = (w.disk ?? '').replace('A', 'S')
      w.disk = next
      return { applied: true, file: file(next), written: next }
    })
    await tick()
    expect(w.calls).toEqual(['save:A\nmore\n'])
    w.holdSave = null
    releaseSave()
    expect(await save).toBe(true)
    const accepted = await accepting
    expect(accepted.status).toBe('acted')
    expect(w.calls).toEqual(['save:A\nmore\n', 'resolve:accept'])
    expect(w.disk).toBe('S\nmore\n')
    expect(w.buffer).toBe('S\nmore\n')
    expect(w.banners).toEqual([])
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('an accept whose buffer cannot be saved first asks main nothing', async () => {
    const w = window_({ disk: 'A\n', buffer: 'A\n', baseline: 'A\n' })
    w.edit('A\nmore\n')
    w.disk = 'Another program.\n'
    const accepted = await acceptThroughOwner({
      owner: w.owner, bufferOf: () => w.buffer, recordInEditor: () => true, askAbout: () => {}, refusalReason: () => 'A.md changed on disk.',
    }, P, ID, async () => { w.calls.push('resolve:accept'); return { applied: true } })
    expect(accepted).toEqual({ status: 'not-saved', message: 'Nothing was applied. A.md changed on disk.' })
    expect(w.calls).toEqual(['save:A\nmore\n'])
  })
})

describe('goal, restore and clear take main\'s text only from their receipt, and never over typing (parcel 2a)', () => {
  it('restore: the buffer takes the text the restore wrote, never a readback that differs; that readback is asked about', async () => {
    // Guard: `replaceBuffer(path, answer.written)` in replaceFromMain. Given the readback instead, the
    // buffer would hold the other program's text as if it were the restored version.
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const OTHER = 'Another program wrote this after the restore.\n'
    const outcome = await w.owner.withFlushed([P], async (snapshots) =>
      w.owner.replaceFromMain(P, { written: ACCEPTED, content: OTHER }, { since: snapshots.get(P)!.gen, mode: 'replace' }))
    expect(outcome).toMatchObject({ status: 'acted', result: { kind: 'outside', diskText: OTHER } })
    expect(w.buffer).toBe(ACCEPTED)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.outside).toEqual([OTHER])
    expect(w.owner.isSaved(P)).toBe(false)
  })

  it('restore or goal, nothing typed: the buffer is the receipt, saved', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const outcome = await w.owner.withFlushed([P], async (snapshots) =>
      w.owner.replaceFromMain(P, wrote(ACCEPTED), { since: snapshots.get(P)!.gen, mode: 'replace' }))
    expect(outcome).toMatchObject({ status: 'acted', result: { kind: 'clean' } })
    expect([w.buffer, w.owner.baselineDiskOf(P)]).toEqual([ACCEPTED, ACCEPTED])
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('Clear while typing: the typing is kept, still based on the version it was typed over, and the cleared file is asked about', async () => {
    // Guard: the `moved` branch of replaceFromMain. Without it the buffer takes the empty file and the
    // typing is gone.
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const outcome = await w.owner.withFlushed([P], async (snapshots) => {
      w.edit(`${DRAFT}Typed while the confirmation was up.\n`)
      w.disk = ''
      return w.owner.replaceFromMain(P, wrote(''), { since: snapshots.get(P)!.gen, mode: 'replace', discardLocal: true })
    })
    expect(outcome).toMatchObject({ status: 'acted', result: { kind: 'moved', diskText: '' } })
    expect(w.buffer).toBe(`${DRAFT}Typed while the confirmation was up.\n`)
    expect(w.registry.textOf(P)).toBe(`${DRAFT}Typed while the confirmation was up.\n`)
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT)
  })
})

// ── Fix round on parcel 2a (independent review, F1–F4) ────────────────────────────────────────────
/**
 * The accept route over a window: the editor takes main's text as EditorPane's recordSuggestionResolution
 * does, by the smallest replacement from the text it holds NOW to the text given (`reconcileReplace`, the
 * same function, with no writer track changes), its change report suppressed. `live: false` is a tab that
 * is not the live one (or a historical view): the editor does not take it.
 */
function acceptIn(w: ReturnType<typeof window_>, options: { live?: boolean } = {}) {
  const asked: string[] = []
  const ports = {
    owner: w.owner,
    bufferOf: () => w.buffer,
    recordInEditor: (_path: string, _id: string, resolved: string | undefined): boolean => {
      if (options.live === false) return false
      if (resolved !== undefined && w.buffer !== null) {
        const spec = reconcileReplace([], w.buffer, resolved)
        if (spec) w.buffer = w.buffer.slice(0, spec.from) + spec.insert + w.buffer.slice(spec.to)
      }
      return true
    },
    askAbout: (_path: string, diskText: string) => { asked.push(diskText) },
    refusalReason: () => undefined,
  }
  return { asked, accept: (resolve: () => Promise<{ applied: boolean; file?: FileReadResult; written?: string }>) => acceptThroughOwner(ports, P, ID, resolve) }
}

describe('F1: text typed while main applies an accept is never rewritten', () => {
  it('typing apart from the change: the change goes onto the typing, the typing stays, unsaved over the receipt', async () => {
    // Guard: the `typedSince` branch of acceptThroughOwner. Without it the editor is reconciled to main's
    // text wholesale, the typing is gone and the registry is cleared because the buffer equals the receipt.
    const TYPED = `${DRAFT}A sentence typed while the accept ran.\n`
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const route = acceptIn(w)
    const accepted = await route.accept(async () => {
      await tick()
      w.edit(TYPED) // the writer types during main's apply
      w.disk = ACCEPTED // main applied the change to the flushed text
      return { applied: true, file: file(ACCEPTED), written: ACCEPTED }
    })
    expect(accepted).toMatchObject({ status: 'acted', recorded: true })
    expect(w.buffer).toBe(`${ACCEPTED}A sentence typed while the accept ran.\n`)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}A sentence typed while the accept ran.\n`)
    expect(w.owner.isSaved(P)).toBe(false)
    expect(route.asked).toEqual([])
  })

  it('typing inside the changed range: the buffer keeps the typing on the old baseline, and main\'s version is asked about', async () => {
    // Guard: the same branch. Without it the buffer becomes main's text and "badly" is lost.
    const TYPED = 'The opening sentence is sprawling badly.\n'
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const route = acceptIn(w)
    const accepted = await route.accept(async () => {
      await tick()
      w.edit(TYPED)
      w.disk = ACCEPTED
      return { applied: true, file: file(ACCEPTED), written: ACCEPTED }
    })
    expect(accepted).toMatchObject({ status: 'acted', recorded: false })
    expect(w.buffer).toBe(TYPED)
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT) // still based on what it was typed over: a save is refused
    expect(w.registry.textOf(P)).toBe(TYPED)
    expect(route.asked).toEqual([ACCEPTED])
    expect(await w.owner.save(P)).toBe(false)
    expect(w.disk).toBe(ACCEPTED)
  })
})

describe('F2: resolutions reach main in the order pressed', () => {
  it('Accept then Discard under a held save: main receives the save, the accept, then the reject; the Discard is refused as already applied', async () => {
    // Guard: `inOrder: true` on the accept's withFlushed. Without it the accept waits for the queue to
    // empty while the Discard takes the place after the save: the reject reaches main first.
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(`${DRAFT}More.\n`)
    let releaseSave!: () => void
    w.holdSave = new Promise<void>((resolve) => { releaseSave = resolve })
    const save = w.owner.save(P)
    await tick()
    const accepting = acceptIn(w).accept(async () => {
      w.calls.push('resolve:accept')
      if (w.status === 'rejected') return { applied: false }
      w.status = 'accepted'
      return { applied: true, file: file(w.disk), written: w.disk }
    })
    // A reject runs in the document's queue (App.tsx inDocumentQueue) and never writes; main refuses it
    // for an applied change (agent.ts resolveChangeWriting).
    const discarding = w.owner.inQueue(P, async () => {
      w.calls.push('resolve:reject')
      if (w.status !== 'accepted') w.status = 'rejected'
    })
    await tick()
    expect(w.calls).toEqual([`save:${DRAFT}More.\n`])
    w.holdSave = null
    releaseSave()
    await save
    await accepting
    await discarding
    expect(w.calls).toEqual([`save:${DRAFT}More.\n`, 'resolve:accept', 'resolve:reject'])
    expect(w.status).toBe('accepted')
  })
})

describe('S2: an accept applied with no receipt never puts the readback into the editor', () => {
  it('two queued Applies: the first writes B, another program writes C, the second (already applied, no receipt) leaves the buffer on B and asks about C', async () => {
    // Guard: the `written === undefined` branch of acceptThroughOwner. Without it the readback C is taken
    // into the editor as the accept's text: the buffer becomes C and nothing asks.
    // Main now answers the second Apply with `applied: false` (already applied); this branch is kept for the
    // protocol (an applied accept with no receipt), not for main's current behaviour.
    const B = ACCEPTED
    const C = 'Another program wrote this between the two Applies.\n'
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const route = acceptIn(w)
    const first = route.accept(async () => {
      w.calls.push('resolve:accept')
      w.disk = B
      w.status = 'accepted'
      return { applied: true, file: file(B), written: B }
    })
    const second = route.accept(async () => {
      w.calls.push('resolve:accept')
      w.disk = C // another program, after the first Apply's readback
      return { applied: true, file: file(C) } // already applied: main wrote nothing
    })
    expect(await first).toMatchObject({ status: 'acted', recorded: true })
    expect(await second).toMatchObject({ status: 'acted', recorded: false })
    expect(w.calls).toEqual(['resolve:accept', 'resolve:accept'])
    expect(w.buffer).toBe(B)
    expect(w.owner.baselineDiskOf(P)).toBe(B)
    expect(w.outside).toEqual([C])
    expect(w.registry.diskIsUnknown(P)).toBe(true)
  })

  it('applied with no receipt over typing: the typing is kept and the readback is asked about', async () => {
    const C = 'Another program wrote this.\n'
    const TYPED = `${ACCEPTED}Typed.\n`
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED, status: 'accepted' })
    const route = acceptIn(w)
    const accepted = await route.accept(async () => {
      await tick()
      w.edit(TYPED)
      w.disk = C
      return { applied: true, file: file(C) }
    })
    expect(accepted).toMatchObject({ status: 'acted', recorded: false })
    expect(w.buffer).toBe(TYPED)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(route.asked).toEqual([C])
  })

  it('applied with no receipt over typing, and a readback that is not the baseline: besides the banner, the document is not saved and its disk is unknown (review P2)', async () => {
    // Guard: the `mainWriteUnknown` call in replaceFromMain's `replace`-and-moved branch for a readback
    // that is not what main wrote (or the baseline). Without it the registry trusts a baseline the disk no
    // longer holds.
    const C = 'Another program wrote this.\n'
    const TYPED = `${ACCEPTED}Typed.\n`
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED, status: 'accepted' })
    const route = acceptIn(w)
    await route.accept(async () => {
      await tick()
      w.edit(TYPED)
      w.disk = C
      return { applied: true, file: file(C) }
    })
    expect(route.asked).toEqual([C])
    expect(w.owner.isSaved(P)).toBe(false)
    expect(w.registry.diskIsUnknown(P)).toBe(true)
    expect(w.registry.textOf(P)).toBe(TYPED)
  })

  it('applied with no receipt over typing, and the readback is the baseline: the disk is not marked unknown', async () => {
    const TYPED = `${ACCEPTED}Typed.\n`
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED, status: 'accepted' })
    const route = acceptIn(w)
    await route.accept(async () => {
      await tick()
      w.edit(TYPED)
      return { applied: true, file: file(ACCEPTED) }
    })
    expect(w.registry.diskIsUnknown(P)).toBe(false)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.buffer).toBe(TYPED)
  })

  it('applied with no receipt and the disk as it was: nothing changes', async () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: ACCEPTED, status: 'accepted' })
    const route = acceptIn(w)
    const accepted = await route.accept(async () => ({ applied: true, file: file(ACCEPTED) }))
    expect(accepted).toMatchObject({ status: 'acted', recorded: false })
    expect([w.buffer, w.owner.baselineDiskOf(P)]).toEqual([ACCEPTED, ACCEPTED])
    expect(w.outside).toEqual([])
    expect(route.asked).toEqual([])
    expect(w.owner.isSaved(P)).toBe(true)
  })
})

describe('F3: an accept the editor did not take still sets the baseline only from its receipt', () => {
  it('another tab is live, main wrote B and another program C before the readback: B is the baseline, C is asked about, the disk is unknown', async () => {
    // Guard: the owner's replaceFromMain for an accept the editor did not take. Reconciling the readback
    // as a read of the disk instead (the route before this fix) makes C the clean baseline silently.
    const OTHER = 'Another program wrote this before the readback.\n'
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const accepted = await acceptIn(w, { live: false }).accept(async () => {
      w.disk = OTHER
      return { applied: true, file: file(OTHER), written: ACCEPTED }
    })
    expect(accepted).toMatchObject({ status: 'acted', recorded: false })
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.outside).toEqual([OTHER])
    expect(w.registry.diskIsUnknown(P)).toBe(true)
    expect(w.owner.isSaved(P)).toBe(false)
  })
})

describe('F4: an applied accept that was not read back leaves the disk unknown', () => {
  it('the receipt is the baseline, the buffer is held with the disk unknown, and an Undo back to the old text is not cleared', async () => {
    // Guard: the `!readBack` branch of replaceFromMain. Without it the accepted buffer counts as saved, the
    // registry is cleared and a close passes it by.
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const accepted = await acceptIn(w).accept(async () => {
      w.disk = ACCEPTED
      return { applied: true, written: ACCEPTED } // the read after the write failed
    })
    expect(accepted).toMatchObject({ status: 'acted', recorded: true })
    expect(w.buffer).toBe(ACCEPTED)
    expect(w.owner.baselineDiskOf(P)).toBe(ACCEPTED)
    expect(w.registry.diskIsUnknown(P)).toBe(true)
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
    expect(w.owner.isSaved(P)).toBe(false)
    w.edit(DRAFT) // Undo
    expect(w.registry.textOf(P)).toBe(DRAFT)
    expect(w.registry.clean()).toBe(false) // a close asks
    // The next save is checked against the receipt: it writes over B, the version main said it wrote.
    expect(await w.owner.save(P)).toBe(true)
    expect(w.disk).toBe(DRAFT)
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('no receipt and no readback: the baseline stays, the disk is unknown, and a save over the changed disk is refused', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    await acceptIn(w).accept(async () => {
      w.disk = ACCEPTED
      return { applied: true }
    })
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT)
    expect(w.registry.diskIsUnknown(P)).toBe(true)
    expect(w.owner.isSaved(P)).toBe(false)
    expect(await w.owner.save(P)).toBe(false) // basis DRAFT, disk ACCEPTED: main refuses
    expect(w.disk).toBe(ACCEPTED)
  })
})

// Final review round 2, finding 2: main refused an accept because the file changed after main read it. The
// watcher may hold that change back (it ignores events for a while after a write of ours, such as the flush
// before the accept), so the refusal itself raises the notice: the owner reads the disk, marks it unknown,
// and answers a conflict (Reload or Keep mine) even over a saved buffer. No watcher event is simulated here.
describe('a refused accept asks the writer by itself, whatever the watcher delivers (final review round 2, finding 2)', () => {
  const OTHER = 'Another program wrote this while the change was applied.\n'
  const refused = (w: ReturnType<typeof window_>) => async () => {
    w.calls.push('resolve:accept')
    w.disk = OTHER
    return { applied: false, message: `${P} changed on disk while the change was being applied, so nothing was written.`, changedOnDisk: { path: P, diskText: OTHER } }
  }
  const acceptPorts = (w: ReturnType<typeof window_>) => ({
    owner: w.owner, bufferOf: () => w.buffer, recordInEditor: () => true, askAbout: () => {}, refusalReason: () => undefined,
    changedOnDisk: w.ports.changedOnDisk,
  })

  it('accept over a saved buffer: the notice is asked for, the buffer kept, and the document is not saved', async () => {
    // Guard: askAboutRefusal in acceptThroughOwner. Without it nothing is raised and the buffer stays
    // "saved" against a disk it does not match.
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    const accepted = await acceptThroughOwner(acceptPorts(w), P, ID, refused(w))
    expect(accepted).toMatchObject({ status: 'acted', result: { applied: false } })
    expect(w.refusals).toEqual([{ kind: 'conflict', diskText: OTHER }])
    expect(w.buffer).toBe(DRAFT)
    expect(w.owner.baselineDiskOf(P)).toBe(DRAFT)
    expect(w.owner.isSaved(P)).toBe(false)
  })

  it('accept over typing: asked about the same way, the typing kept', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(`${DRAFT}more\n`)
    await acceptThroughOwner(acceptPorts(w), P, ID, refused(w))
    expect(w.refusals).toEqual([{ kind: 'conflict', diskText: OTHER }])
    expect(w.buffer).toBe(`${DRAFT}more\n`)
    expect(w.owner.isSaved(P)).toBe(false)
  })

  it('the file gone by the time the owner reads it: removed', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    await acceptThroughOwner({ ...acceptPorts(w), changedOnDisk: async (path, options) => {
      w.refusals.push(await w.owner.refusedOnDisk(path, async () => { throw new Error('ENOENT') }, options))
    } }, P, ID, refused(w))
    expect(w.refusals).toEqual([{ kind: 'removed', dirty: false }])
    expect(w.owner.isSaved(P)).toBe(false)
  })

  it('the disk back on the buffer\'s version by the time the owner reads it: nothing to ask, still saved', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    await acceptThroughOwner(acceptPorts(w), P, ID, async () => ({ applied: false, changedOnDisk: { path: P, diskText: OTHER } }))
    expect(w.refusals).toEqual([{ kind: 'none' }])
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('a refusal for nothing changed on disk (any other refusal) asks nothing', async () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    await acceptThroughOwner(acceptPorts(w), P, ID, async () => ({ applied: false, message: 'That change is already applied, so nothing was written.' }))
    expect(w.refusals).toEqual([])
    expect(w.owner.isSaved(P)).toBe(true)
  })

  it('redo of an accept that main refuses for a changed file: the notice is asked for too', async () => {
    // Guard: askAboutRefusal in replayAcceptRedo.
    const w = window_({ disk: DRAFT, buffer: ACCEPTED, baseline: DRAFT })
    w.resolveAccept = refused(w)
    expect(await redo(w)).toBe(false)
    expect(w.refusals).toEqual([{ kind: 'conflict', diskText: OTHER }])
    expect(w.owner.isSaved(P)).toBe(false)
  })
})
