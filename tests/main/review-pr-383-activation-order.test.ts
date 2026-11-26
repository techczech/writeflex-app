import { describe, expect, it } from 'bun:test'
import { createDocumentOwner, type OutsideOutcome } from '../../src/renderer/src/app/document-owner'
import { createUnsavedRegistry } from '../../src/renderer/src/app/unsaved-registry'
import type { ExternalDiskNotice } from '../../src/renderer/src/editor/reconcile'
import type { EditorReadResult } from '../../src/shared/editor-read'
import { textForSave } from '../../src/shared/line-endings'
import { basisAllows } from '../../src/shared/save-basis'

const PATH = 'folder/note.md'
const START = 'Original.\n'
const MINE = 'Original and my new paragraph.\n'
const OUTSIDE = 'Another writer changed the file.\n'
const MORE = 'An additional unsaved paragraph.\n'

function harness() {
  const registry = createUnsavedRegistry()
  const buffers = new Map([[PATH, START]])
  const disk = new Map([[PATH, START]])
  const notices = new Map<string, ExternalDiskNotice>()
  const checks: Promise<OutsideOutcome>[] = []
  let beforeCommit: (() => Promise<void>) | undefined
  let afterReadback: (() => Promise<void>) | undefined
  const owner = createDocumentOwner({
    buffer: (path) => buffers.get(path) ?? null,
    notice: (path) => notices.get(path),
    registry,
    write: async (path, doc, basis) => {
      await beforeCommit?.()
      const current = disk.get(path) ?? null
      if (!basisAllows(basis, current)) return { refused: 'disk-changed', diskText: current, message: 'changed on disk' }
      const next = textForSave(doc, current)
      disk.set(path, next)
      // Capture the readback before holding the IPC answer.
      await afterReadback?.()
      return { content: next, written: next }
    },
    setReadOnly: () => {},
    forgetBuffer: (path) => { buffers.delete(path) },
    renameBuffer: (from, to) => { buffers.set(to, buffers.get(from)!) },
    replaceBuffer: (path, text) => { buffers.set(path, text) },
    dirtyChanged: () => {},
    report: {
      slow: () => {}, refusedByNotice: () => {}, refusedByMain: () => {}, diskChanged: () => {},
      saved: () => {}, outsideAfterWrite: () => {}, unknown: () => {},
    },
  })
  const read = async (path = PATH): Promise<EditorReadResult> => {
    const content = disk.get(path)
    return content === undefined ? { kind: 'missing' } : { kind: 'read', content }
  }
  const show = (path: string, text: string): string => {
    if (!buffers.has(path)) buffers.set(path, text)
    return buffers.get(path)!
  }
  const reconcile = (path: string): void => { checks.push(owner.applyOutside(path, () => read(path))) }
  const activate = (text: string, path = PATH) =>
    owner.activated(path, text, () => show(path, text), () => reconcile(path))
  const type = (text: string): void => {
    buffers.set(PATH, text)
    owner.edited(PATH, text)
  }
  const pauseWrite = (stage: 'commit' | 'answer') => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const gate = () => { reached.resolve(); return release.promise }
    if (stage === 'commit') beforeCommit = gate
    else afterReadback = gate
    return { reached: reached.promise, release: () => release.resolve() }
  }
  activate(START)
  return { owner, registry, buffers, disk, notices, checks, read, show, reconcile, activate, type, pauseWrite }
}

describe('PR 383: activation spanning a document operation', () => {
  it('does not replace the saved buffer with a read from before Keep mine committed', async () => {
    const h = harness()
    h.type(MINE)
    h.disk.set(PATH, OUTSIDE)
    const notice: ExternalDiskNotice = { kind: 'changed', dirty: true, diskText: OUTSIDE }
    h.notices.set(PATH, notice)
    const held = h.pauseWrite('commit')
    const saving = h.owner.keepMine(PATH, notice)
    await held.reached
    const activationRead = h.disk.get(PATH)!
    held.release()
    expect(await saving).toBe(true)
    // disk-notices.ts clears the answered notice after the save.
    h.notices.delete(PATH)
    await h.owner.settled(PATH)
    const action = h.activate(activationRead)
    expect({
      action,
      buffer: h.buffers.get(PATH),
      baseline: h.owner.baselineDiskOf(PATH),
      dirty: h.owner.isDirty(PATH),
    }).toEqual({ action: 'kept', buffer: MINE, baseline: MINE, dirty: false })
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'none' }])
  })

  it('does not replace the buffer with a read from before a held main write settled', async () => {
    const h = harness()
    const entered = Promise.withResolvers<void>()
    const commit = Promise.withResolvers<void>()
    const writing = h.owner.withFlushed([PATH], async (snapshots) => {
      entered.resolve()
      await commit.promise
      h.disk.set(PATH, MINE)
      return h.owner.replaceFromMain(PATH, { content: MINE, written: MINE }, {
        since: snapshots.get(PATH)!.gen,
        mode: 'replace',
      })
    })
    await entered.promise
    const activationRead = h.disk.get(PATH)!
    commit.resolve()
    expect(await writing).toMatchObject({ status: 'acted', result: { kind: 'clean' } })
    await h.owner.settled(PATH)
    const action = h.activate(activationRead)
    expect({
      action,
      buffer: h.buffers.get(PATH),
      baseline: h.owner.baselineDiskOf(PATH),
      dirty: h.owner.isDirty(PATH),
    }).toEqual({ action: 'kept', buffer: MINE, baseline: MINE, dirty: false })
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'none' }])
  })

  it('does not apply a delayed read after five confirmed autosaves', async () => {
    const h = harness()
    const activationRead = h.disk.get(PATH)!
    for (let i = 1; i <= 5; i++) {
      h.type(MINE.repeat(i))
      expect(await h.owner.save(PATH)).toBe(true)
    }
    await h.owner.settled(PATH)
    expect(h.activate(activationRead)).toBe('kept')
    expect(h.buffers.get(PATH)).toBe(MINE.repeat(5))
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'none' }])
  })

  it('detects another writer after readback while the save answer is pending, preserving later typing', async () => {
    const h = harness()
    h.type(MINE)
    const held = h.pauseWrite('answer')
    const saving = h.owner.save(PATH)
    await held.reached
    h.type(MINE + MORE)
    h.disk.set(PATH, OUTSIDE)
    expect(h.activate(OUTSIDE)).toBe('kept')
    expect(h.owner.baselineDiskOf(PATH)).toBe(START)
    held.release()
    expect(await saving).toBe(true)
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'conflict', diskText: OUTSIDE }])
    expect(h.owner.baselineDiskOf(PATH)).toBe(MINE)
    expect(h.registry.textOf(PATH)).toBe(MINE + MORE)
    expect(h.buffers.get(PATH)).toBe(MINE + MORE)
  })

  it('adopts an actual outside revert to superseded bytes on the queued reread', async () => {
    const h = harness()
    h.type(MINE)
    expect(await h.owner.save(PATH)).toBe(true)
    await h.owner.settled(PATH)
    h.disk.set(PATH, START)
    expect(h.activate(START)).toBe('kept')
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'replaced', diskText: START }])
    expect(h.buffers.get(PATH)).toBe(START)
    expect(h.owner.baselineDiskOf(PATH)).toBe(START)
  })

  it('accepts an authoritative Retry read that matches superseded bytes', async () => {
    const h = harness()
    h.type(MINE)
    expect(await h.owner.save(PATH)).toBe(true)
    await h.owner.settled(PATH)
    expect(h.owner.activatedHeld(PATH, MINE)).toBe(false)
    h.notices.set(PATH, { kind: 'unavailable', dirty: false, diskText: null })
    h.disk.set(PATH, START)
    // App runs Retry inQueue and does not give activated a recheck callback.
    const action = await h.owner.inQueue(PATH, async () => {
      const disk = h.disk.get(PATH)!
      return h.owner.activated(PATH, disk, () => h.show(PATH, disk))
    })
    expect(action).toBe('replaced')
    expect(h.buffers.get(PATH)).toBe(START)
    expect(h.owner.baselineDiskOf(PATH)).toBe(START)
  })

  it('converges after a newer activation while the first recheck is pending', async () => {
    const h = harness()
    h.type(MINE)
    expect(await h.owner.save(PATH)).toBe(true)
    await h.owner.settled(PATH)
    const started = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<EditorReadResult>()
    h.disk.set(PATH, START)
    let firstCheck: Promise<OutsideOutcome> | undefined
    expect(h.owner.activated(PATH, START, () => h.show(PATH, START), () => {
      firstCheck = h.owner.applyOutside(PATH, () => { started.resolve(); return reply.promise })
    })).toBe('kept')
    await started.promise
    h.disk.set(PATH, OUTSIDE)
    expect(h.activate(OUTSIDE)).toBe('kept')
    reply.resolve({ kind: 'read', content: START })
    expect(await firstCheck).toEqual({ kind: 'replaced', diskText: START })
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'replaced', diskText: OUTSIDE }])
    expect(h.buffers.get(PATH)).toBe(OUTSIDE)
  })

  it('keeps unsaved typing and its original basis when an idle activation sees a real outside change', () => {
    const h = harness()
    h.type(MINE)
    h.disk.set(PATH, OUTSIDE)
    expect(h.activate(OUTSIDE)).toBe('conflict')
    expect(h.buffers.get(PATH)).toBe(MINE)
    expect(h.owner.baselineDiskOf(PATH)).toBe(START)
    expect(h.registry.textOf(PATH)).toBe(MINE)
    expect(h.checks).toHaveLength(0)
  })

  it('skips a recheck if its record was dropped and replaced while its read was pending', async () => {
    const h = harness()
    h.type(MINE)
    expect(await h.owner.save(PATH)).toBe(true)
    await h.owner.settled(PATH)
    const started = Promise.withResolvers<void>()
    const reply = Promise.withResolvers<EditorReadResult>()
    let check: Promise<OutsideOutcome> | undefined
    h.owner.activated(PATH, START, () => h.show(PATH, START), () => {
      check = h.owner.applyOutside(PATH, () => { started.resolve(); return reply.promise })
    })
    await started.promise
    h.owner.drop(PATH)
    h.activate(OUTSIDE)
    reply.resolve({ kind: 'missing' })
    expect(await check).toEqual({ kind: 'skipped' })
    expect(h.buffers.get(PATH)).toBe(OUTSIDE)
  })

  it('retains the moved buffer and skips a recheck queued against its old folder path', async () => {
    const h = harness()
    const dest = 'renamed/note.md'
    await h.owner.withFlushed([PATH], async () => {
      h.disk.set(dest, h.disk.get(PATH)!)
      h.disk.delete(PATH)
      expect(h.owner.busyNow(PATH)).toBe(true)
      h.owner.activatedHeld(PATH, h.buffers.get(PATH)!)
      h.reconcile(PATH)
      expect(h.owner.moved(PATH, dest)).toBe('renamed')
    }, { scope: 'folder/', detach: true })
    expect(await Promise.all(h.checks)).toEqual([{ kind: 'skipped' }])
    expect(h.buffers.get(dest)).toBe(START)
    expect(h.activate(START, dest)).toBe('kept')
  })
})
