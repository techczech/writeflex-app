// A document main wrote while it is open, and the redo of an undone accept
// (src/renderer/src/app/main-wrote-document.ts; review round 3, finding 1 of
// docs/plans/quit-does-not-stall/quit-and-window-close-spec.md). The module and the unsaved registry
// are the real ones; the ports are wired as App.tsx wires them, over a buffer, a baseline and a main
// that are variables here.
import { describe, expect, it } from 'bun:test'
import { mainWroteDocument, replayAcceptRedo, type AcceptRedoPorts } from '../../src/renderer/src/app/main-wrote-document'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import { isTextChange } from '../../src/shared/line-endings'
import type { FileReadResult } from '../../src/preload'

const P = 'draft.md'
const ID = 'change-1'
const DRAFT = 'The opening sentence is sprawling.\n'
const ACCEPTED = 'The opening sentence sprawls.\n'

const file = (content: string): FileReadResult => ({ content, file: { path: P, name: P } } as unknown as FileReadResult)

/** A window on one document. `buffer: null` is a tab that is not resident; `mounted: false` an app
 *  unmounted by an error. */
function window_(start: { disk: string; buffer: string | null; baseline: string; status?: string }) {
  const registry = createUnsavedRegistry()
  const w = {
    registry,
    disk: start.disk,
    status: start.status ?? 'pending',
    buffer: start.buffer,
    baseline: start.baseline,
    mounted: true,
    calls: [] as string[],
    flashes: [] as string[],
    /** What main does with each call; replaced per test. */
    saveFile: async (content: string): Promise<FileReadResult | { refused: 'empty-write'; message: string }> => { w.disk = content; return file(content) },
    resolveAccept: async (): Promise<{ applied: boolean; file?: FileReadResult; message?: string }> => {
      w.disk = ACCEPTED
      w.status = 'accepted'
      return { applied: true, file: file(ACCEPTED) }
    },
    release: null as (() => void) | null,
    gated: false,
    /** The editor's own report of a change to the buffer (App's setDirty against the baseline). */
    edit(text: string) {
      w.buffer = text
      if (isTextChange(w.baseline, text)) registry.typed(P, text)
      else registry.matchesDisk(P, text)
    },
    ports: null as unknown as AcceptRedoPorts,
  }
  w.ports = {
    setBaseline: (_path, content) => { w.baseline = content },
    bufferOf: () => (w.mounted ? w.buffer : null),
    setDirty: (path, dirty, text) => { if (dirty) registry.typed(path, text); else registry.matchesDisk(path, text) },
    heldText: (path) => registry.textOf(path),
    keep: (path, text) => registry.typed(path, text),
    hold: (path) => registry.hold(path),
    unknown: (path, text) => registry.beginWrite(path, text).unknown(),
    editorPresent: () => w.mounted,
    api: {
      saveFile: async (_path: string, content: string) => { w.calls.push('saveFile'); return w.saveFile(content) },
      resolveChange: async (_id: string, action: 'accept' | 'reject') => { w.calls.push(`resolve:${action}`); return w.resolveAccept() },
    } as never,
    flash: (message) => { w.flashes.push(message) },
    gate: async () => { if (w.gated) await new Promise<void>((resolve) => { w.release = resolve }) },
  }
  return w
}
const redo = (w: ReturnType<typeof window_>, options: { restore: boolean } = { restore: true }): Promise<boolean> =>
  replayAcceptRedo(w.ports, { id: ID, path: P, ...(options.restore ? { beforeContent: DRAFT } : {}) })

describe('main wrote an open document: the returned file is the baseline, the buffer is reported against it', () => {
  it('the buffer equals the returned file: baseline moved, clean', () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: DRAFT })
    mainWroteDocument(w.ports, file(ACCEPTED))
    expect(w.baseline).toBe(ACCEPTED)
    expect(w.registry.clean()).toBe(true)
  })

  it('the buffer differs from the returned file: it is an entry with the buffer text', () => {
    const w = window_({ disk: ACCEPTED, buffer: `${ACCEPTED}More.\n`, baseline: DRAFT })
    mainWroteDocument(w.ports, file(ACCEPTED))
    expect(w.baseline).toBe(ACCEPTED)
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}More.\n`)
  })

  it('an entry held for text that is now on disk goes; line endings and BOM are not a difference', () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(ACCEPTED)
    expect(w.registry.textOf(P)).toBe(ACCEPTED)
    mainWroteDocument(w.ports, file(`﻿${ACCEPTED.replace(/\n/g, '\r\n')}`))
    expect(w.registry.clean()).toBe(true)
  })

  it('hole C: after it, undoing back to the pre-accept text is unsaved, where the old baseline called it clean', () => {
    const w = window_({ disk: ACCEPTED, buffer: ACCEPTED, baseline: DRAFT })
    mainWroteDocument(w.ports, file(ACCEPTED))
    w.edit(DRAFT) // undo of the accept
    expect(w.registry.textOf(P)).toBe(DRAFT)
    expect(w.registry.clean()).toBe(false)
  })

  it('no buffer to read: the returned file clears nothing the registry holds', () => {
    const w = window_({ disk: ACCEPTED, buffer: null, baseline: DRAFT })
    w.registry.typed(P, 'typed before the tab went')
    mainWroteDocument(w.ports, file(ACCEPTED))
    expect(w.baseline).toBe(ACCEPTED)
    expect(w.registry.textOf(P)).toBe('typed before the tab went')
  })

  it('no buffer to read, a last known text that is not what is on disk, nothing held: it is kept', () => {
    const w = window_({ disk: ACCEPTED, buffer: null, baseline: DRAFT })
    mainWroteDocument(w.ports, file(ACCEPTED), `${ACCEPTED}More.\n`)
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}More.\n`)
    const same = window_({ disk: ACCEPTED, buffer: null, baseline: DRAFT })
    mainWroteDocument(same.ports, file(ACCEPTED), ACCEPTED)
    expect(same.registry.clean()).toBe(true)
  })
})

describe('redo of an undone accept: sent at once, under a hold', () => {
  /** After accept, undo and a save of the undone text; then the editor redoes. */
  const redone = () => {
    const w = window_({ disk: DRAFT, buffer: DRAFT, baseline: DRAFT })
    w.edit(ACCEPTED)
    return w
  }

  it('calls main at once, and a close waits for the calls: the document is pending and not settled until they return', async () => {
    // Redo before the undone text was saved: the buffer equals the baseline again, so nothing but the
    // hold stands for the document while the calls are in flight.
    const w = window_({ disk: ACCEPTED, buffer: DRAFT, baseline: ACCEPTED, status: 'pending' })
    w.edit(ACCEPTED)
    expect(w.registry.clean()).toBe(true)
    w.gated = true
    const done = redo(w)
    expect(w.registry.clean()).toBe(false)
    expect(w.registry.pending()).toEqual([P])
    expect(w.registry.textOf(P)).toBeUndefined()
    let settled = false
    void w.registry.settled(P).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    w.release!()
    expect(await done).toBe(true)
    expect(w.calls).toEqual(['saveFile', 'resolve:accept'])
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(w.registry.clean()).toBe(true)
  })

  it('success: the file main returns is the baseline and the redone buffer is clean', async () => {
    const w = redone()
    expect(await redo(w)).toBe(true)
    expect([w.disk, w.buffer, w.baseline, w.status]).toEqual([ACCEPTED, ACCEPTED, ACCEPTED, 'accepted'])
    expect(w.registry.clean()).toBe(true)
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
    w.edit(`${ACCEPTED}More.\n`)
    w.release!()
    await done
    expect(w.registry.textOf(P)).toBe(`${ACCEPTED}More.\n`)
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

  it('the app is unmounted during the calls: main is still called, and the text the registry holds stays', async () => {
    const w = redone()
    w.gated = true
    const done = redo(w)
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
    w.buffer = null
    w.registry.discard(P)
    w.release!()
    expect(await done).toBe(false)
    expect(w.registry.clean()).toBe(true)
  })
})
